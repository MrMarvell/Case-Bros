// case-bros custom server (Express + Next.js + Steam OpenID)
const express = require('express');
const next = require('next');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;

const config = require('./lib/config');
const { db, nowIso } = require('./lib/db');
require('./scripts/init-db'); // ensure schema
const { seed } = require('./scripts/seed');

// DB seeding runs asynchronously inside app.prepare() below.

const { upsertUserFromSteamProfile, publicUserView } = require('./lib/store');
const { startSchedulers, getBrokenCaseEvent, getBrosBoostEvent } = require('./lib/events');
const { getPool } = require('./lib/pool');
const { openCase } = require('./lib/openCase');
const { claimStreak } = require('./lib/streak');
const { listInventory, sellItem } = require('./lib/inventory');
const { getLeaderboard } = require('./lib/leaderboard');
const { listGiveaways, getGiveaway, enterGiveaway, listWinners } = require('./lib/giveaways');
const { parseGemsToCents } = require('./lib/economy');
const { getMarketInfo, mapWithConcurrency } = require('./lib/market');
const { defaultWearName, marketHashWithWear } = require('./lib/wear');
const { getBonusStateForUser, claimBonus } = require('./lib/bonus');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

function requireAuth(req, res, nextFn) {
  if (!req.user) return res.status(401).json({ error: 'not_logged_in' });
  return nextFn();
}

function requireAdmin(req, res, nextFn) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'forbidden' });
  return nextFn();
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function upsertCaseWithItems(payload) {
  // payload: {slug,name,casePrice,keyPrice,imageUrl,marketHashName,items:[{name,rarity,price,weight,imageUrl,marketHashNameBase}]}
  const c = db.prepare(`
    INSERT INTO cases(slug,name,image_url,case_price_cents,key_price_cents,active,market_hash_name)
    VALUES(?,?,?,?,?,1,?)
    ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name,
      image_url=excluded.image_url,
      case_price_cents=excluded.case_price_cents,
      key_price_cents=excluded.key_price_cents,
      market_hash_name=excluded.market_hash_name,
      active=1
  `);
  c.run(
    payload.slug,
    payload.name,
    payload.imageUrl || null,
    parseGemsToCents(payload.casePrice),
    parseGemsToCents(payload.keyPrice),
    payload.marketHashName || payload.market_hash_name || payload.name,
  );
  const row = db.prepare('SELECT * FROM cases WHERE slug=?').get(payload.slug);

  for (const it of (payload.items || [])) {
    const existing = db.prepare('SELECT * FROM items WHERE name=? AND rarity=?').get(it.name, it.rarity);
    let itemRow = existing;

    const baseHash = it.marketHashNameBase || it.market_hash_name_base || it.name;

    if (!existing) {
      const info = db.prepare('INSERT INTO items(name,rarity,image_url,price_cents,market_hash_name_base) VALUES(?,?,?,?,?)')
        .run(it.name, it.rarity, it.imageUrl || null, parseGemsToCents(it.price), baseHash);
      itemRow = db.prepare('SELECT * FROM items WHERE id=?').get(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE items SET image_url=?, price_cents=?, market_hash_name_base=? WHERE id=?')
        .run(it.imageUrl || existing.image_url, parseGemsToCents(it.price), baseHash, existing.id);
    }

    db.prepare(`
      INSERT INTO case_items(case_id,item_id,weight)
      VALUES(?,?,?)
      ON CONFLICT(case_id,item_id) DO UPDATE SET weight=excluded.weight
    `).run(row.id, itemRow.id, Math.max(1, Math.floor(Number(it.weight) || 1)));
  }

  return row;
}

app.prepare().then(async () => {
  const server = express();

  // Auto-seed catalog on first boot so the UI is never empty.
  try {
    const count = db.prepare('SELECT COUNT(1) AS n FROM cases').get().n;
    if (!count || Number(count) === 0) {
      console.log('📦 Seeding initial cases/items...');
      await seed();
      console.log('✅ Seed complete');
    }
  } catch (e) {
    console.warn('⚠️  Seed failed (app will still run):', e?.message || e);
  }


  // Seed DB on first run (pulls CS2 crates/skins from the public ByMykel API).
  try {
    const seed = require('./scripts/seed');
    if (typeof seed === 'function') await seed();
  } catch (e) {
    console.warn('⚠️  Seed failed (continuing):', e?.message || e);
  }

  // IMPORTANT on Render (proxy/https)
  server.set('trust proxy', 1);

  // ✅ Passport needs express-session (not cookie-session)
  server.use(session({
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: !dev, // secure cookies in production
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }));

  server.use(passport.initialize());
  server.use(passport.session());

  passport.serializeUser((user, done) => done(null, user.steam_id));
  passport.deserializeUser((steamId, done) => {
    const u = db.prepare('SELECT * FROM users WHERE steam_id=?').get(steamId);
    done(null, u ? publicUserView(u) : null);
  });

  if (!config.STEAM_API_KEY) {
    console.warn('⚠️  STEAM_API_KEY is empty. Steam login will not work until you set it in env.');
  }

  passport.use(new SteamStrategy({
    returnURL: `${config.BASE_URL}/auth/steam/return`,
    realm: config.BASE_URL,
    apiKey: config.STEAM_API_KEY || 'missing',
  }, (identifier, profile, done) => {
    try {
      const u = upsertUserFromSteamProfile(profile);
      return done(null, publicUserView(u));
    } catch (e) {
      console.error('steam auth error', e);
      return done(e);
    }
  }));

  server.use(express.json({ limit: '2mb' }));

  // ---------------------------------------------------------------------------
  // Offline-safe SVG placeholders
  // ---------------------------------------------------------------------------
  // Render free tier has no shell; if an external data/image source is
  // temporarily unreachable, the UI can look "empty". These endpoints
  // generate nice-looking placeholder images on the fly so the app
  // always has images for cases/items.

  const escapeXml = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  }[c]));

  const hueFrom = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  };

  const rarityHue = (rarity) => {
    const r = String(rarity || '').toLowerCase();
    if (r.includes('consumer')) return 120;
    if (r.includes('industrial')) return 190;
    if (r.includes('mil')) return 220;
    if (r.includes('restricted')) return 280;
    if (r.includes('classified')) return 310;
    if (r.includes('covert')) return 350;
    if (r.includes('extra') || r.includes('gold') || r.includes('rare')) return 45;
    return 200;
  };

  function renderCaseSvg({ name, slug }) {
    const hue = hueFrom(slug || name || 'case');
    const title = escapeXml(name || 'Case');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 40%, 12%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 40) % 360}, 55%, 8%)"/>
    </linearGradient>
    <linearGradient id="case" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="hsl(${hue}, 55%, 22%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 25) % 360}, 55%, 14%)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="640" height="480" rx="28" fill="url(#bg)"/>
  <rect x="120" y="110" width="400" height="250" rx="18" fill="url(#case)" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
  <rect x="150" y="140" width="340" height="140" rx="14" fill="rgba(0,0,0,0.25)" stroke="rgba(255,255,255,0.10)"/>
  <g fill="rgba(255,255,255,0.18)">
    <circle cx="140" cy="130" r="6"/><circle cx="500" cy="130" r="6"/><circle cx="140" cy="350" r="6"/><circle cx="500" cy="350" r="6"/>
  </g>
  <text x="320" y="225" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="22" fill="rgba(255,255,255,0.92)">${title}</text>
  <text x="320" y="255" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="12" fill="rgba(255,255,255,0.55)">case-bros placeholder</text>
</svg>`;
  }

  function renderItemSvg({ name, rarity, wear, id }) {
    const hue = (rarity ? rarityHue(rarity) : hueFrom(String(id || name || 'item')));
    const title = escapeXml(name || `Item #${id || ''}`.trim());
    const wearLabel = escapeXml(wear || '');
    const rLabel = escapeXml(rarity || '');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 40%, 10%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 25) % 360}, 55%, 7%)"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="hsla(${hue}, 85%, 60%, 0.22)"/>
      <stop offset="100%" stop-color="hsla(${(hue + 20) % 360}, 85%, 55%, 0.06)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="640" height="480" rx="28" fill="url(#bg)"/>
  <rect x="70" y="90" width="500" height="300" rx="18" fill="url(#glow)" stroke="rgba(255,255,255,0.12)"/>
  <!-- simple "weapon" silhouette -->
  <g fill="rgba(255,255,255,0.16)">
    <rect x="170" y="210" width="240" height="34" rx="10"/>
    <rect x="410" y="220" width="120" height="14" rx="7"/>
    <rect x="150" y="202" width="34" height="50" rx="10"/>
    <rect x="240" y="240" width="38" height="70" rx="12" transform="rotate(18 240 240)"/>
  </g>
  <text x="320" y="395" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="18" fill="rgba(255,255,255,0.92)">${title}</text>
  <text x="320" y="420" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="12" fill="rgba(255,255,255,0.55)">${rLabel}${wearLabel ? ` · ${wearLabel}` : ''}</text>
</svg>`;
  }

  server.get('/img/case/:slug.svg', (req, res) => {
    const slug = req.params.slug;
    const row = db.prepare('SELECT name, slug FROM cases WHERE slug = ?').get(slug);
    const svg = renderCaseSvg({ name: row?.name || slug, slug: row?.slug || slug });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).send(svg);
  });

  server.get('/img/item/:id.svg', (req, res) => {
    const id = Number(req.params.id);
    const wear = req.query.wear ? String(req.query.wear) : '';
    const row = db.prepare('SELECT id, name, rarity FROM items WHERE id = ?').get(id);
    const svg = renderItemSvg({
      id,
      name: row?.name || `Item #${id}`,
      rarity: row?.rarity || 'Unknown',
      wear,
    });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).send(svg);
  });

  // Auth routes
  server.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));
  server.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/');
  });
  server.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
  });

  // API
  server.get('/api/state', (req, res) => {
    const broken = getBrokenCaseEvent(new Date());
    const boost = getBrosBoostEvent(new Date());
    const pool = getPool();
    const bonus = req.user ? getBonusStateForUser(req.user.id) : null;
    res.json({
      me: req.user || null,
      bonus,
      events: {
        broken_case: broken ? safeJsonParse(broken.payload_json, null) : null,
        bros_boost: boost ? safeJsonParse(boost.payload_json, null) : null,
        broken_window: broken ? { start_at: broken.start_at, end_at: broken.end_at } : null,
        boost_window: boost ? { start_at: boost.start_at, end_at: boost.end_at } : null,
      },
      pool,
    });
  });

  server.get('/api/cases', async (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM cases WHERE active=1 ORDER BY name ASC').all();
      const broken = getBrokenCaseEvent(new Date());
      const brokenPayload = broken ? safeJsonParse(broken.payload_json, null) : null;

      // mastery summaries
      let masteryByCase = {};
      if (req.user) {
        const m = db.prepare('SELECT case_id, xp, level FROM mastery WHERE user_id=?').all(req.user.id);
        masteryByCase = Object.fromEntries(m.map(r => [r.case_id, { xp: r.xp, level: r.level }]));
      }

      const enriched = await mapWithConcurrency(rows, 4, async (c) => {
        const hash = c.market_hash_name || c.name;
        const info = await getMarketInfo(hash, { behavior: 'swr' });
        const casePriceCents = info?.price_cents ?? c.case_price_cents;
        const img = info?.icon_url || c.image_url || `/img/case/${c.slug}.svg`;
        return {
          id: c.id,
          slug: c.slug,
          name: c.name,
          image_url: img,
          case_price_gems: (casePriceCents / 100).toFixed(2),
          key_price_gems: (c.key_price_cents / 100).toFixed(2),
          is_broken: brokenPayload?.case_id === c.id,
          mastery: masteryByCase[c.id] || null,
        };
      });

      res.json(enriched);
    } catch (e) {
      console.error('api/cases error', e);
      res.status(500).json({ error: 'server_error' });
    }
  });

  server.get('/api/cases/:slug', async (req, res) => {
    const c = db.prepare('SELECT * FROM cases WHERE slug=? AND active=1').get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'not_found' });
    try {
      const caseHash = c.market_hash_name || c.name;
      const caseInfo = await getMarketInfo(caseHash);
      const casePriceCents = caseInfo?.price_cents ?? c.case_price_cents;
      const caseImg = caseInfo?.icon_url || c.image_url || `/img/case/${c.slug}.svg`;

      const defaultWear = defaultWearName();
      const raw = db.prepare(`
        SELECT ci.weight, i.id, i.name, i.rarity, i.image_url, i.price_cents, i.market_hash_name_base
        FROM case_items ci JOIN items i ON i.id = ci.item_id
        WHERE ci.case_id=?
        ORDER BY i.price_cents ASC
      `).all(c.id);

      const items = await mapWithConcurrency(raw, 5, async (r) => {
        const base = r.market_hash_name_base || r.name;
        const marketName = marketHashWithWear(base, defaultWear);
        const info = await getMarketInfo(marketName);
        const priceCents = info?.price_cents ?? r.price_cents;
        const img = info?.icon_url || r.image_url || `/img/item/${r.id}.svg?wear=${encodeURIComponent(defaultWear)}`;
        return {
          id: r.id,
          name: r.name,
          rarity: r.rarity,
          image_url: img,
          price_gems: (priceCents / 100).toFixed(2),
          weight: r.weight,
        };
      });

      let mastery = null;
      if (req.user) {
        const m = db.prepare('SELECT * FROM mastery WHERE user_id=? AND case_id=?').get(req.user.id, c.id);
        mastery = m || { xp: 0, level: 0 };
      }

      res.json({
        id: c.id,
        slug: c.slug,
        name: c.name,
        image_url: caseImg,
        case_price_gems: (casePriceCents / 100).toFixed(2),
        key_price_gems: (c.key_price_cents / 100).toFixed(2),
        items,
        mastery,
      });
    } catch (e) {
      console.error('api/cases/:slug error', e);
      res.status(500).json({ error: 'server_error' });
    }
  });

  server.post('/api/open', requireAuth, async (req, res) => {
    const { slug } = req.body || {};
    if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'bad_slug' });
    const broken = getBrokenCaseEvent(new Date());
    const boost = getBrosBoostEvent(new Date());
    try {
      const result = await openCase({ userId: req.user.id, slug, brokenEvent: broken, boostEvent: boost });
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      req.user.streak_day = u.streak_day;
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  server.post('/api/streak/claim', requireAuth, (req, res) => {
    const boost = getBrosBoostEvent(new Date());
    try {
      const result = claimStreak(req.user.id, boost);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      req.user.streak_day = u.streak_day;
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  server.get('/api/inventory', requireAuth, (req, res) => {
    res.json({ items: listInventory(req.user.id) });
  });

  server.post('/api/inventory/sell', requireAuth, (req, res) => {
    const { inventoryId } = req.body || {};
    try {
      const result = sellItem(req.user.id, inventoryId);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  server.get('/api/leaderboard', (req, res) => {
    res.json({ rows: getLeaderboard(50) });
  });

  server.get('/api/giveaways', (req, res) => {
    const pool = getPool();
    res.json({ pool, giveaways: listGiveaways(req.user?.id, pool.tier) });
  });

  // Recent giveaway winners
  server.get('/api/winners', (req, res) => {
    res.json({ winners: listWinners(50) });
  });

  server.get('/api/giveaways/:id', (req, res) => {
    const g = getGiveaway(req.params.id);
    if (!g) return res.status(404).json({ error: 'not_found' });
    const pool = getPool();
    let myEntries = 0;
    if (req.user) {
      const row = db.prepare('SELECT entries FROM giveaway_entries WHERE giveaway_id=? AND user_id=?')
        .get(g.id, req.user.id);
      myEntries = row ? row.entries : 0;
    }
    res.json({
      giveaway: { ...g, locked: pool.tier < g.tier_required },
      pool,
      my_entries: myEntries,
    });
  });

  server.post('/api/giveaways/:id/enter', requireAuth, (req, res) => {
    const pool = getPool();
    const entries = req.body?.entries;
    try {
      const result = enterGiveaway(req.user.id, Number(req.params.id), entries, pool.tier);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // Bonus faucet
  server.get('/api/bonus/state', requireAuth, (req, res) => {
    res.json(getBonusStateForUser(req.user.id));
  });

  server.post('/api/bonus/claim', requireAuth, (req, res) => {
    try {
      const result = claimBonus(req.user.id);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // Admin
  server.post('/api/admin/import', requireAuth, requireAdmin, (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'bad_payload' });

    const cases = payload.cases;
    if (!Array.isArray(cases) || cases.length === 0) return res.status(400).json({ error: 'missing_cases' });

    const inserted = [];
    const errors = [];

    for (const c of cases) {
      try {
        if (!c.slug || !c.name || !c.casePrice || !c.keyPrice) throw new Error('missing_fields');
        inserted.push(upsertCaseWithItems(c));
      } catch (e) {
        errors.push({ slug: c?.slug, error: String(e.message || e) });
      }
    }

    res.json({ ok: true, inserted: inserted.length, errors });
  });

  server.post('/api/admin/giveaways', requireAuth, requireAdmin, (req, res) => {
    const { title, description, tier_required, prize_text, starts_at, ends_at } = req.body || {};
    if (!title || !prize_text || !starts_at || !ends_at) return res.status(400).json({ error: 'missing_fields' });

    db.prepare(`
      INSERT INTO giveaways(title,description,tier_required,prize_text,starts_at,ends_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      title,
      description || '',
      Math.max(0, Math.floor(Number(tier_required) || 0)),
      prize_text,
      starts_at,
      ends_at,
      'active',
      nowIso()
    );

    res.json({ ok: true });
  });

  // Next.js handler
  server.all('*', (req, res) => handle(req, res));

  // start schedulers
  startSchedulers();

  // Warm up a small batch of market prices/images on boot (non-blocking).
  (async () => {
    try {
      const caseRows = db.prepare('SELECT name, market_hash_name FROM cases WHERE active=1').all();
      const marketCaseNames = caseRows.map(c => c.market_hash_name || c.name).slice(0, config.MARKET_WARMUP_BATCH);
      await mapWithConcurrency(marketCaseNames, 4, async (n) => { await getMarketInfo(n); return true; });

      const itemRows = db.prepare('SELECT market_hash_name_base, name FROM items').all();
      const defWear = defaultWearName();
      const marketItemNames = itemRows
        .map(i => marketHashWithWear(i.market_hash_name_base || i.name, defWear))
        .slice(0, config.MARKET_WARMUP_BATCH);
      await mapWithConcurrency(marketItemNames, 4, async (n) => { await getMarketInfo(n); return true; });

      console.log('✅ Market cache warm-up complete.');
    } catch (e) {
      console.warn('market warm-up skipped:', e?.message || e);
    }
  })();

  // ✅ Render provides process.env.PORT automatically
  const port = config.PORT || process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`✅ case-bros running on ${config.BASE_URL} (port ${port})`);
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
