require('dotenv').config();

const express = require('express');
const next = require('next');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const cron = require('node-cron');

const { getPool } = require('./lib/db');
const { requireAuth, requireAdmin } = require('./lib/middleware');
const { weightedPick, randomFloat01, randomIntInclusive } = require('./lib/random');
const { wearFromFloat } = require('./lib/wear');
const { getPriceCents } = require('./lib/marketCache');
const { refreshStaleBatch } = require('./jobs/marketRefresh');

const dev = process.env.NODE_ENV !== 'production';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ADMIN_STEAM_IDS = new Set(
  (process.env.ADMIN_STEAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const pool = getPool();

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function centsToDisplay(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rarityColor(rarity) {
  const r = String(rarity || '').toLowerCase();
  if (r === 'mil-spec') return '#4b69ff';
  if (r === 'restricted') return '#8847ff';
  if (r === 'classified') return '#d32ce6';
  if (r === 'covert') return '#eb4b4b';
  if (r === 'gold') return '#caab05';
  return '#9aa3af';
}

function safeText(s, max = 48) {
  return String(s || '').replace(/[<>]/g, '').slice(0, max);
}

async function main() {
  const nextApp = next({ dev });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  const app = express();

  // Render/Cloudflare/etc. reverse proxy support
  app.set('trust proxy', 1);

  app.use(express.json());

  // Sessions (use Postgres-backed session store for persistence)
  app.use(
    session({
      store: new PgSession({ pool, tableName: 'session' }),
      secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
      resave: false,
      saveUninitialized: false,
      name: 'casebros.sid',
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: !dev, // IMPORTANT: secure cookies in production
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      }
    })
  );

  // Passport
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const res = await pool.query(
        `
        SELECT id, steam_id, display_name, avatar, gems_cents, streak_day, last_streak_claim_at, is_admin
        FROM users
        WHERE id = $1;
        `,
        [id]
      );
      done(null, res.rows[0] || null);
    } catch (err) {
      done(err);
    }
  });

  if (!process.env.STEAM_API_KEY) {
    console.warn('⚠ STEAM_API_KEY is missing. Steam login will fail until you set it.');
  }

  passport.use(
    new SteamStrategy(
      {
        returnURL: `${BASE_URL}/auth/steam/return`,
        realm: `${BASE_URL}/`,
        apiKey: process.env.STEAM_API_KEY || 'MISSING_KEY'
      },
      async (identifier, profile, done) => {
        try {
          const steamId = String(profile.id);
          const displayName = profile.displayName || 'Steam User';
          const avatar =
            (profile.photos && profile.photos[2] && profile.photos[2].value) ||
            (profile.photos && profile.photos[0] && profile.photos[0].value) ||
            null;

          const isAdmin = ADMIN_STEAM_IDS.has(steamId);
          const starting = Number(process.env.STARTING_GEMS_CENTS || 50000);

          const res = await pool.query(
            `
            INSERT INTO users (steam_id, display_name, avatar, gems_cents, is_admin)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (steam_id)
            DO UPDATE SET
              display_name = EXCLUDED.display_name,
              avatar = EXCLUDED.avatar,
              is_admin = EXCLUDED.is_admin,
              updated_at = NOW()
            RETURNING id, steam_id, display_name, avatar, gems_cents, streak_day, last_streak_claim_at, is_admin;
            `,
            [steamId, displayName, avatar, starting, isAdmin]
          );

          done(null, res.rows[0]);
        } catch (err) {
          done(err);
        }
      }
    )
  );

  app.use(passport.initialize());
  app.use(passport.session());

  // ---- Health check (Render) ----
  app.get('/healthz', (req, res) => res.status(200).send('ok'));

  // ---- Auth routes ----
  app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));

  app.get(
    '/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => res.redirect('/')
  );

  app.post('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      if (req.session) {
        req.session.destroy(() => res.json({ ok: true }));
      } else {
        res.json({ ok: true });
      }
    });
  });

  // Optional GET logout for quick demos
  app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      if (req.session) req.session.destroy(() => res.redirect('/'));
      else res.redirect('/');
    });
  });

  // ---- API ----

  app.get('/api/me', (req, res) => {
    res.json({
      user: req.user || null
    });
  });

  app.get(
    '/api/cases',
    asyncHandler(async (req, res) => {
      const rows = await pool.query(
        `
        SELECT id, slug, name, image_url, case_price_cents, key_price_cents, active
        FROM cases
        WHERE active = TRUE
        ORDER BY id ASC;
        `
      );
      res.json({ cases: rows.rows });
    })
  );

  app.get(
    '/api/cases/:slug',
    asyncHandler(async (req, res) => {
      const slug = req.params.slug;

      const cRes = await pool.query(
        `
        SELECT id, slug, name, image_url, case_price_cents, key_price_cents, active
        FROM cases
        WHERE slug = $1;
        `,
        [slug]
      );

      if (cRes.rowCount === 0) return res.status(404).json({ error: 'CASE_NOT_FOUND' });

      const c = cRes.rows[0];

      const iRes = await pool.query(
        `
        SELECT i.id, i.name, i.weapon, i.rarity, i.is_special, i.image_url, i.market_hash_base
        FROM items i
        JOIN case_items ci ON ci.item_id = i.id
        WHERE ci.case_id = $1
        ORDER BY i.is_special DESC, i.rarity ASC, i.name ASC;
        `,
        [c.id]
      );

      res.json({ case: c, items: iRes.rows });
    })
  );

  app.post(
    '/api/open',
    requireAuth,
    asyncHandler(async (req, res) => {
      const caseSlug = String(req.body.caseSlug || '').trim();
      if (!caseSlug) return res.status(400).json({ error: 'MISSING_CASE' });

      const cRes = await pool.query(
        `
        SELECT id, slug, name, image_url, case_price_cents, key_price_cents, active
        FROM cases
        WHERE slug = $1 AND active = TRUE;
        `,
        [caseSlug]
      );
      if (cRes.rowCount === 0) return res.status(404).json({ error: 'CASE_NOT_FOUND' });
      const c = cRes.rows[0];

      const dropsRes = await pool.query(
        `
        SELECT ci.weight, i.id, i.name, i.weapon, i.rarity, i.is_special, i.image_url, i.market_hash_base
        FROM case_items ci
        JOIN items i ON i.id = ci.item_id
        WHERE ci.case_id = $1;
        `,
        [c.id]
      );
      if (dropsRes.rowCount === 0) return res.status(400).json({ error: 'CASE_HAS_NO_ITEMS' });

      const picked = weightedPick(dropsRes.rows, 'weight');

      // Wear + float
      const floatValue = randomFloat01(); // 0..1
      const wear = wearFromFloat(floatValue);

      // Pattern for special items (knives/gloves)
      const patternIndex = picked.is_special ? randomIntInclusive(0, 999) : null;

      // Market hash name for price lookup
      const marketHashName = `${picked.market_hash_base} (${wear})`;
      const priceCents = await getPriceCents(pool, marketHashName);

      const openCost = Number(c.case_price_cents || 0) + Number(c.key_price_cents || 0);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const uRes = await client.query('SELECT gems_cents FROM users WHERE id = $1 FOR UPDATE;', [
          req.user.id
        ]);
        const balance = Number(uRes.rows[0]?.gems_cents || 0);

        if (balance < openCost) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'NOT_ENOUGH_GEMS', balance_cents: balance, cost_cents: openCost });
        }

        const newBalance = balance - openCost;

        await client.query('UPDATE users SET gems_cents = $1, updated_at = NOW() WHERE id = $2;', [
          newBalance,
          req.user.id
        ]);

        const invRes = await client.query(
          `
          INSERT INTO inventory (user_id, item_id, wear, float_value, pattern_index, price_cents_at_drop)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, created_at;
          `,
          [req.user.id, picked.id, wear, floatValue, patternIndex, priceCents]
        );

        await client.query('COMMIT');

        res.json({
          ok: true,
          balance_cents: newBalance,
          cost_cents: openCost,
          drop: {
            inventory_id: invRes.rows[0].id,
            created_at: invRes.rows[0].created_at,
            item: {
              id: picked.id,
              name: picked.name,
              weapon: picked.weapon,
              rarity: picked.rarity,
              is_special: picked.is_special,
              image_url: picked.image_url,
              market_hash_base: picked.market_hash_base
            },
            wear,
            float_value: floatValue,
            pattern_index: patternIndex,
            market_hash_name: marketHashName,
            price_cents: priceCents,
            price_display: centsToDisplay(priceCents)
          }
        });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    '/api/inventory',
    requireAuth,
    asyncHandler(async (req, res) => {
      const rows = await pool.query(
        `
        SELECT inv.id, inv.wear, inv.float_value, inv.pattern_index, inv.price_cents_at_drop, inv.created_at,
               i.name, i.weapon, i.rarity, i.is_special, i.image_url, i.market_hash_base
        FROM inventory inv
        JOIN items i ON i.id = inv.item_id
        WHERE inv.user_id = $1
        ORDER BY inv.created_at DESC
        LIMIT 200;
        `,
        [req.user.id]
      );

      res.json({ items: rows.rows });
    })
  );

  app.post(
    '/api/inventory/:id/sell',
    requireAuth,
    asyncHandler(async (req, res) => {
      const invId = Number(req.params.id);
      if (!Number.isFinite(invId)) return res.status(400).json({ error: 'BAD_ID' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const invRes = await client.query(
          `
          SELECT id, user_id, price_cents_at_drop
          FROM inventory
          WHERE id = $1
          FOR UPDATE;
          `,
          [invId]
        );

        if (invRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'INVENTORY_NOT_FOUND' });
        }

        const inv = invRes.rows[0];
        if (Number(inv.user_id) !== Number(req.user.id)) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'NOT_YOURS' });
        }

        const credit = Number(inv.price_cents_at_drop || 0);

        await client.query('DELETE FROM inventory WHERE id = $1;', [invId]);
        const uRes = await client.query(
          `
          UPDATE users
          SET gems_cents = gems_cents + $1, updated_at = NOW()
          WHERE id = $2
          RETURNING gems_cents;
          `,
          [credit, req.user.id]
        );

        await client.query('COMMIT');

        res.json({ ok: true, credit_cents: credit, balance_cents: Number(uRes.rows[0].gems_cents || 0) });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    '/api/leaderboard',
    asyncHandler(async (req, res) => {
      const rows = await pool.query(
        `
        SELECT display_name, avatar, gems_cents
        FROM users
        ORDER BY gems_cents DESC
        LIMIT 50;
        `
      );
      res.json({ leaderboard: rows.rows });
    })
  );

  app.post(
    '/api/streak/claim',
    requireAuth,
    asyncHandler(async (req, res) => {
      const baseBonus = Number(process.env.STREAK_BONUS_CENTS || 750);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const uRes = await client.query(
          `
          SELECT gems_cents, streak_day, last_streak_claim_at,
                 (last_streak_claim_at::date = CURRENT_DATE) AS claimed_today
          FROM users
          WHERE id = $1
          FOR UPDATE;
          `,
          [req.user.id]
        );

        const u = uRes.rows[0];
        if (u.claimed_today === true) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'ALREADY_CLAIMED_TODAY' });
        }

        const newStreak = Number(u.streak_day || 0) + 1;
        const multiplier = Math.min(newStreak, 7); // grows for first 7 days
        const reward = Math.max(0, Math.round(baseBonus * multiplier));

        const upd = await client.query(
          `
          UPDATE users
          SET streak_day = $1,
              last_streak_claim_at = NOW(),
              gems_cents = gems_cents + $2,
              updated_at = NOW()
          WHERE id = $3
          RETURNING gems_cents, streak_day, last_streak_claim_at;
          `,
          [newStreak, reward, req.user.id]
        );

        await client.query('COMMIT');
        res.json({
          ok: true,
          reward_cents: reward,
          user: upd.rows[0]
        });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    '/api/giveaways',
    asyncHandler(async (req, res) => {
      const rows = await pool.query(
        `
        SELECT id, title, prize_text, tier_required, starts_at, ends_at, status
        FROM giveaways
        ORDER BY starts_at DESC
        LIMIT 50;
        `
      );
      res.json({ giveaways: rows.rows });
    })
  );

  app.get(
    '/api/giveaways/:id',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' });

      const gRes = await pool.query(
        `
        SELECT id, title, prize_text, tier_required, starts_at, ends_at, status
        FROM giveaways
        WHERE id = $1;
        `,
        [id]
      );
      if (gRes.rowCount === 0) return res.status(404).json({ error: 'GIVEAWAY_NOT_FOUND' });
      const giveaway = gRes.rows[0];

      const totalRes = await pool.query(
        'SELECT COALESCE(SUM(entries), 0) AS total_entries FROM giveaway_entries WHERE giveaway_id = $1;',
        [id]
      );

      let myEntries = 0;
      if (req.user) {
        const myRes = await pool.query(
          'SELECT entries FROM giveaway_entries WHERE giveaway_id = $1 AND user_id = $2;',
          [id, req.user.id]
        );
        myEntries = Number(myRes.rows[0]?.entries || 0);
      }

      res.json({
        giveaway,
        total_entries: Number(totalRes.rows[0]?.total_entries || 0),
        my_entries: myEntries
      });
    })
  );

  app.post(
    '/api/giveaways/:id/enter',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const entries = Number(req.body.entries || 0);

      if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' });
      if (!Number.isFinite(entries) || entries <= 0 || entries > 10_000) {
        return res.status(400).json({ error: 'BAD_ENTRIES' });
      }

      const entryCost = Number(process.env.GIVEAWAY_ENTRY_COST_CENTS || 1000);
      const cost = entryCost * entries;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const gRes = await client.query('SELECT id, status, ends_at FROM giveaways WHERE id = $1 FOR UPDATE;', [id]);
        if (gRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'GIVEAWAY_NOT_FOUND' });
        }
        const g = gRes.rows[0];
        if (String(g.status) === 'ended') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'GIVEAWAY_ENDED' });
        }

        const uRes = await client.query('SELECT gems_cents FROM users WHERE id = $1 FOR UPDATE;', [req.user.id]);
        const balance = Number(uRes.rows[0]?.gems_cents || 0);

        if (balance < cost) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'NOT_ENOUGH_GEMS', balance_cents: balance, cost_cents: cost });
        }

        const newBalance = balance - cost;

        await client.query('UPDATE users SET gems_cents = $1, updated_at = NOW() WHERE id = $2;', [
          newBalance,
          req.user.id
        ]);

        await client.query(
          `
          INSERT INTO giveaway_entries (giveaway_id, user_id, entries)
          VALUES ($1, $2, $3)
          ON CONFLICT (giveaway_id, user_id)
          DO UPDATE SET entries = giveaway_entries.entries + EXCLUDED.entries;
          `,
          [id, req.user.id, entries]
        );

        const myRes = await client.query(
          'SELECT entries FROM giveaway_entries WHERE giveaway_id = $1 AND user_id = $2;',
          [id, req.user.id]
        );

        await client.query('COMMIT');

        res.json({
          ok: true,
          bought_entries: entries,
          cost_cents: cost,
          balance_cents: newBalance,
          my_entries: Number(myRes.rows[0]?.entries || 0)
        });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    '/api/winners',
    asyncHandler(async (req, res) => {
      const rows = await pool.query(
        `
        SELECT w.picked_at,
               u.display_name,
               u.avatar,
               g.title,
               g.prize_text
        FROM giveaway_winners w
        JOIN users u ON u.id = w.user_id
        JOIN giveaways g ON g.id = w.giveaway_id
        ORDER BY w.picked_at DESC
        LIMIT 50;
        `
      );

      res.json({ winners: rows.rows });
    })
  );

  // ---- Admin endpoints ----

  app.post(
    '/api/admin/giveaways',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { title, prize_text, tier_required, starts_at, ends_at } = req.body || {};
      if (!title || !prize_text || !starts_at || !ends_at) return res.status(400).json({ error: 'MISSING_FIELDS' });

      const row = await pool.query(
        `
        INSERT INTO giveaways (title, prize_text, tier_required, starts_at, ends_at, status)
        VALUES ($1, $2, $3, $4, $5, 'scheduled')
        RETURNING *;
        `,
        [String(title), String(prize_text), Number(tier_required || 0), new Date(starts_at), new Date(ends_at)]
      );

      res.json({ ok: true, giveaway: row.rows[0] });
    })
  );

  app.post(
    '/api/admin/giveaways/:id/pick-winner',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const giveawayId = Number(req.params.id);
      if (!Number.isFinite(giveawayId)) return res.status(400).json({ error: 'BAD_ID' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const gRes = await client.query('SELECT id, status FROM giveaways WHERE id = $1 FOR UPDATE;', [giveawayId]);
        if (gRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'GIVEAWAY_NOT_FOUND' });
        }

        const entriesRes = await client.query(
          'SELECT user_id, entries FROM giveaway_entries WHERE giveaway_id = $1 AND entries > 0;',
          [giveawayId]
        );
        if (entriesRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'NO_ENTRIES' });
        }

        const rows = entriesRes.rows.map((r) => ({ user_id: Number(r.user_id), weight: Number(r.entries) || 0 }));
        const picked = weightedPick(rows, 'weight');

        await client.query(
          `
          INSERT INTO giveaway_winners (giveaway_id, user_id, picked_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (giveaway_id)
          DO UPDATE SET user_id = EXCLUDED.user_id, picked_at = EXCLUDED.picked_at;
          `,
          [giveawayId, picked.user_id]
        );

        await client.query(`UPDATE giveaways SET status = 'ended', updated_at = NOW() WHERE id = $1;`, [giveawayId]);

        const winnerRes = await client.query(
          `
          SELECT w.picked_at, u.display_name, u.avatar
          FROM giveaway_winners w
          JOIN users u ON u.id = w.user_id
          WHERE w.giveaway_id = $1;
          `,
          [giveawayId]
        );

        await client.query('COMMIT');

        res.json({ ok: true, winner: winnerRes.rows[0] });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    })
  );

  // ---- Placeholder SVGs (no Valve assets) ----
  app.get('/api/placeholder.svg', (req, res) => {
    const name = safeText(req.query.name || 'Item');
    const rarity = safeText(req.query.rarity || 'Mil-Spec');
    const type = safeText(req.query.type || 'item');
    const color = rarityColor(rarity);

    const title = type === 'case' ? 'Case' : 'Skin';

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.90"/>
      <stop offset="1" stop-color="#111827" stop-opacity="1"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="384" rx="24" fill="url(#g)"/>
  <rect x="24" y="24" width="464" height="336" rx="18" fill="#0b1220" opacity="0.55"/>
  <text x="48" y="86" fill="#e5e7eb" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="22" font-weight="700">${title}</text>
  <text x="48" y="122" fill="#cbd5e1" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="18">${rarity}</text>
  <g opacity="0.9">
    <rect x="48" y="156" width="416" height="160" rx="18" fill="#0f172a" opacity="0.65"/>
    <text x="64" y="224" fill="#e5e7eb" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="26" font-weight="700">${name}</text>
    <text x="64" y="258" fill="#94a3b8" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="16">Placeholder art • replace with your own renders</text>
  </g>
</svg>`;

    res.setHeader('Content-Type', 'image/svg+xml');
    res.status(200).send(svg);
  });

  // ---- Background jobs (optional) ----
  if (!dev && String(process.env.ENABLE_JOBS || 'true').toLowerCase() === 'true') {
    // Every 30 minutes refresh a batch of stale cached prices.
    cron.schedule('*/30 * * * *', () => {
      refreshStaleBatch(pool).catch((e) => console.error('refreshStaleBatch failed:', e));
    });
    console.log('Jobs enabled: market cache refresh scheduled.');
  }

  // ---- Error handler (API) ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({
      error: 'INTERNAL',
      message: dev ? String(err.message || err) : 'Internal server error'
    });
  });

  // ---- Next.js pages ----
  app.all('*', (req, res) => handle(req, res));

  app.listen(PORT, () => {
    console.log(`Case-Bros listening on ${BASE_URL} (port ${PORT})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
