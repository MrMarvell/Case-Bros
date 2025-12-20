// case-bros custom server (Express + Next.js + Steam OpenID)
// PRO build: sessions, steam login, api routes, giveaways winners, db seed, price cache refresh
const express = require('express');
const next = require('next');
const path = require('path');
const cookieSession = require('cookie-session');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;

const config = require('./lib/config');
const { db, nowIso } = require('./lib/db');

// Ensure schema exists
require('./scripts/init-db');

// Optional: run seeding if DB empty (safe)
try {
  const row = db.prepare('SELECT COUNT(1) as c FROM cases').get();
  if (!row || !row.c) {
    console.log('No cases found — running seed...');
    try {
      // Prefer your seed script if present
      const seed = require('./scripts/seed');
      if (typeof seed === 'function') seed();
      else if (seed && typeof seed.run === 'function') seed.run();
      else console.warn('Seed exists but is not a function. Skipping direct call.');
    } catch (e) {
      console.warn('Seed failed (app will still run):', e?.message || e);
    }
  }
} catch (e) {
  console.warn('Seed check failed:', e?.message || e);
}

const { upsertUserFromSteamProfile, publicUserView } = require('./lib/store');
const { startSchedulers, getBrokenCaseEvent, getBrosBoostEvent } = require('./lib/events');
const { getPool } = require('./lib/pool');
const { openCase } = require('./lib/openCase');
const { claimStreak } = require('./lib/streak');
const { listInventory, sellItem } = require('./lib/inventory');
const { getLeaderboard } = require('./lib/leaderboard');
const { listGiveaways, getGiveaway, enterGiveaway, pickWinner, listWinners } = require('./lib/giveaways');
const { parseUsdToCents, formatUsd } = require('./lib/money');
const { refreshMarketCacheIfNeeded, getMarketCacheStatus } = require('./lib/market');

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
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function isHttps(req) {
  // Render/Proxy friendly
  const xfProto = req.headers['x-forwarded-proto'];
  if (xfProto) return String(xfProto).split(',')[0].trim() === 'https';
  return req.secure === true;
}

function absoluteBaseUrl(req) {
  // Prefer config.BASE_URL if set, otherwise infer from request
  if (config.BASE_URL && String(config.BASE_URL).startsWith('http')) return config.BASE_URL;
  const proto = isHttps(req) ? 'https' : 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function normalizeUrl(u) {
  if (!u) return u;
  return String(u).replace(/\/+$/, '');
}

app
  .prepare()
  .then(() => {
    const server = express();

    // Trust proxies (Render / Cloudflare / etc)
    server.set('trust proxy', 1);

    // --- Static (public) ---
    server.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
    server.use('/images', express.static(path.join(__dirname, 'public', 'images')));

    // --- Sessions ---
    // We use cookie-session for simplicity; express-session as fallback for steam lib quirks if needed.
    // cookie-session is stateless; express-session is server-side. We'll keep both but only mount one.
    const useExpressSession = String(process.env.USE_EXPRESS_SESSION || '').toLowerCase() === 'true';

    if (useExpressSession) {
      server.use(
        session({
          name: 'casebros.sid',
          secret: config.SESSION_SECRET,
          resave: false,
          saveUninitialized: false,
          cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: !dev,
            maxAge: 30 * 24 * 60 * 60 * 1000,
          },
        })
      );
    } else {
      server.use(
        cookieSession({
          name: 'casebros',
          keys: [config.SESSION_SECRET],
          maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
          sameSite: 'lax',
          secure: !dev,
        })
      );
    }

    // --- Passport ---
    server.use(passport.initialize());
    server.use(passport.session());

    passport.serializeUser((user, done) => done(null, user.steam_id));
    passport.deserializeUser((steamId, done) => {
      try {
        const u = db.prepare('SELECT * FROM users WHERE steam_id=?').get(steamId);
        done(null, u ? publicUserView(u) : null);
      } catch (e) {
        done(e);
      }
    });

    if (!config.STEAM_API_KEY) {
      console.warn('⚠️  STEAM_API_KEY is empty. Steam login will not work until you set it in env.');
    }

    // IMPORTANT:
    // If you deploy a NEW Render service (new URL) but keep old BASE_URL,
    // Steam will redirect back to the old domain.
    // So: BASE_URL must match your current service URL.
    passport.use(
      new SteamStrategy(
        {
          returnURL: `${normalizeUrl(config.BASE_URL)}/auth/steam/return`,
          realm: normalizeUrl(config.BASE_URL),
          apiKey: config.STEAM_API_KEY || 'missing',
        },
        (identifier, profile, done) => {
          try {
            const u = upsertUserFromSteamProfile(profile);
            return done(null, publicUserView(u));
          } catch (e) {
            console.error('steam auth error', e);
            return done(e);
          }
        }
      )
    );

    server.use(express.json({ limit: '3mb' }));

    // --- Auth routes ---
    server.get('/auth/steam', (req, res, nextFn) => {
      // Ensure correct callback host if BASE_URL missing/mismatched
      // but do not override config — only helps during debugging.
      if (!config.BASE_URL) {
        console.warn('BASE_URL is empty. Steam login will likely misbehave.');
      }
      nextFn();
    });

    server.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));

    server.get(
      '/auth/steam/return',
      passport.authenticate('steam', { failureRedirect: '/' }),
      (req, res) => {
        res.redirect('/');
      }
    );

    server.get('/auth/logout', (req, res) => {
      req.logout(() => {
        res.redirect('/');
      });
    });

    // --- API: health ---
    server.get('/api/health', (req, res) => {
      res.json({
        ok: true,
        time: nowIso(),
        base_url: config.BASE_URL,
        port: config.PORT,
      });
    });

    // --- API: state (home) ---
    server.get('/api/state', async (req, res) => {
      const broken = getBrokenCaseEvent(new Date());
      const boost = getBrosBoostEvent(new Date());
      const pool = getPool();

      res.json({
        me: req.user || null,
        events: {
          broken_case: broken ? safeJsonParse(broken.payload_json, null) : null,
          bros_boost: boost ? safeJsonParse(boost.payload_json, null) : null,
          broken_window: broken ? { start_at: broken.start_at, end_at: broken.end_at } : null,
          boost_window: boost ? { start_at: boost.start_at, end_at: boost.end_at } : null,
        },
        pool,
        market: getMarketCacheStatus(),
      });
    });

    // --- API: cases list ---
    server.get('/api/cases', async (req, res) => {
      const rows = db.prepare('SELECT * FROM cases WHERE active=1 ORDER BY name ASC').all();
      const broken = getBrokenCaseEvent(new Date());
      const brokenPayload = broken ? safeJsonParse(broken.payload_json, null) : null;

      res.json(
        rows.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          image_url: c.image_url,
          case_price_usd: formatUsd(c.case_price_cents),
          key_price_usd: formatUsd(c.key_price_cents),
          is_broken: brokenPayload?.case_id === c.id,
        }))
      );
    });

    // --- API: single case detail ---
    server.get('/api/cases/:slug', async (req, res) => {
      const c = db.prepare('SELECT * FROM cases WHERE slug=? AND active=1').get(req.params.slug);
      if (!c) return res.status(404).json({ error: 'not_found' });

      const items = db
        .prepare(
          `
        SELECT ci.weight, i.id, i.name, i.rarity, i.image_url, i.price_cents
        FROM case_items ci JOIN items i ON i.id = ci.item_id
        WHERE ci.case_id=?
        ORDER BY i.price_cents ASC
      `
        )
        .all(c.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          rarity: r.rarity,
          image_url: r.image_url,
          price_usd: formatUsd(r.price_cents),
          weight: r.weight,
        }));

      let mastery = null;
      if (req.user) {
        const m = db.prepare('SELECT * FROM mastery WHERE user_id=? AND case_id=?').get(req.user.id, c.id);
        mastery = m || { xp: 0, level: 0 };
      }

      res.json({
        id: c.id,
        slug: c.slug,
        name: c.name,
        image_url: c.image_url,
        case_price_usd: formatUsd(c.case_price_cents),
        key_price_usd: formatUsd(c.key_price_cents),
        items,
        mastery,
      });
    });

    // --- API: open case (no client seed; server sim only) ---
    server.post('/api/open', requireAuth, async (req, res) => {
      const { slug } = req.body || {};
      if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'bad_slug' });

      const broken = getBrokenCaseEvent(new Date());
      const boost = getBrosBoostEvent(new Date());

      try {
        const result = openCase({
          userId: req.user.id,
          slug,
          brokenEvent: broken,
          boostEvent: boost,
        });

        // refresh me for client
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
        req.user.usd = formatUsd(u.usd_cents);
        req.user.streak_day = u.streak_day;

        res.json(result);
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });

    // --- API: streak claim ---
    server.post('/api/streak/claim', requireAuth, async (req, res) => {
      const boost = getBrosBoostEvent(new Date());
      try {
        const result = claimStreak(req.user.id, boost);

        const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
        req.user.usd = formatUsd(u.usd_cents);
        req.user.streak_day = u.streak_day;

        res.json(result);
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });

    // --- API: inventory ---
    server.get('/api/inventory', requireAuth, async (req, res) => {
      res.json({ items: listInventory(req.user.id) });
    });

    server.post('/api/inventory/sell', requireAuth, async (req, res) => {
      const { inventoryId } = req.body || {};
      try {
        const result = sellItem(req.user.id, inventoryId);

        const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
        req.user.usd = formatUsd(u.usd_cents);

        res.json(result);
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });

    // --- API: leaderboard ---
    server.get('/api/leaderboard', async (req, res) => {
      res.json({ rows: getLeaderboard(50) });
    });

    // --- API: giveaways ---
    server.get('/api/giveaways', async (req, res) => {
      const pool = getPool();
      res.json({ pool, giveaways: listGiveaways(req.user?.id, pool.tier) });
    });

    server.get('/api/giveaways/:id', async (req, res) => {
      const g = getGiveaway(req.params.id);
      if (!g) return res.status(404).json({ error: 'not_found' });

      const pool = getPool();
      let myEntries = 0;

      if (req.user) {
        const row = db
          .prepare('SELECT entries FROM giveaway_entries WHERE giveaway_id=? AND user_id=?')
          .get(g.id, req.user.id);
        myEntries = row ? row.entries : 0;
      }

      res.json({
        giveaway: { ...g, locked: pool.tier < g.tier_required },
        pool,
        my_entries: myEntries,
      });
    });

    server.post('/api/giveaways/:id/enter', requireAuth, async (req, res) => {
      const pool = getPool();
      const entries = req.body?.entries;

      try {
        const result = enterGiveaway(req.user.id, Number(req.params.id), entries, pool.tier);

        const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
        req.user.usd = formatUsd(u.usd_cents);

        res.json(result);
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });

    // --- Winners list ---
    server.get('/api/winners', async (req, res) => {
      res.json({ winners: listWinners(50) });
    });

    // --- Admin: create giveaway ---
    server.post('/api/admin/giveaways', requireAuth, requireAdmin, async (req, res) => {
      const { title, description, tier_required, prize_text, starts_at, ends_at } = req.body || {};
      if (!title || !prize_text || !starts_at || !ends_at)
        return res.status(400).json({ error: 'missing_fields' });

      db.prepare(
        `
        INSERT INTO giveaways(title,description,tier_required,prize_text,starts_at,ends_at,status,created_at)
        VALUES(?,?,?,?,?,?,?,?)
      `
      ).run(
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

    // --- Admin: pick a winner (manual trigger) ---
    server.post('/api/admin/giveaways/:id/pick-winner', requireAuth, requireAdmin, async (req, res) => {
      try {
        const out = pickWinner(Number(req.params.id));
        res.json({ ok: true, result: out });
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });

    // --- Admin: refresh price cache (manual trigger) ---
    server.post('/api/admin/market/refresh', requireAuth, requireAdmin, async (req, res) => {
      try {
        await refreshMarketCacheIfNeeded(true);
        res.json({ ok: true, market: getMarketCacheStatus() });
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });

    // --- Public: refresh price cache (safe) ---
    server.post('/api/refresh', async (req, res) => {
      // Safe refresh endpoint (rate-limited by internal cache logic)
      try {
        await refreshMarketCacheIfNeeded(false);
        res.json({ ok: true, market: getMarketCacheStatus() });
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });

    // --- Next.js handler ---
    server.all('*', (req, res) => handle(req, res));

    // Start schedulers (market refresh, giveaways, etc)
    try {
      startSchedulers();
    } catch (e) {
      console.warn('Schedulers failed to start:', e?.message || e);
    }

    server.listen(config.PORT, () => {
      console.log(`✅ case-bros running on ${config.BASE_URL} (port ${config.PORT})`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
