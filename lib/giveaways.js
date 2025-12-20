const { db, nowIso } = require('./db');
const { formatGems } = require('./economy');

const ENTRY_COST_CENTS = 100; // 1.00 gem per entry by default

function weightedPick(rows) {
  // rows: [{user_id, entries, steam_id, display_name, avatar_url}]
  const total = rows.reduce((s, r) => s + (r.entries || 0), 0);
  if (total <= 0) return null;
  // crypto for better randomness than Math.random
  const { randomInt } = require('crypto');
  let roll = randomInt(0, total);
  for (const r of rows) {
    roll -= (r.entries || 0);
    if (roll < 0) return r;
  }
  return null;
}

function listGiveaways(userId, poolTier) {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT g.*,
      (SELECT COALESCE(SUM(entries),0) FROM giveaway_entries ge WHERE ge.giveaway_id=g.id) as total_entries
    FROM giveaways g
    WHERE g.status='active'
    ORDER BY g.ends_at ASC
  `).all();

  const my = userId ? db.prepare('SELECT * FROM giveaway_entries WHERE user_id=?').all(userId) : [];
  const myMap = new Map(my.map(r => [r.giveaway_id, r.entries]));

  return rows.map(g => ({
    id: g.id,
    title: g.title,
    description: g.description,
    tier_required: g.tier_required,
    prize_text: g.prize_text,
    starts_at: g.starts_at,
    ends_at: g.ends_at,
    is_live: g.starts_at <= now && g.ends_at > now,
    total_entries: g.total_entries,
    my_entries: userId ? (myMap.get(g.id) || 0) : 0,
    locked: poolTier < g.tier_required,
    entry_cost_gems: formatGems(ENTRY_COST_CENTS),
  }));
}

function getGiveaway(id) {
  const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
  if (!g) return null;
  const total = db.prepare('SELECT COALESCE(SUM(entries),0) as n FROM giveaway_entries WHERE giveaway_id=?').get(id).n;
  return { ...g, total_entries: total };
}

function enterGiveaway(userId, giveawayId, entries, poolTier) {
  entries = Math.floor(Number(entries));
  if (!Number.isFinite(entries) || entries <= 0) throw new Error('bad_entries');

  const g = getGiveaway(giveawayId);
  if (!g) throw new Error('not_found');

  const now = new Date().toISOString();
  if (!(g.starts_at <= now && g.ends_at > now && g.status === 'active')) throw new Error('not_live');
  if (poolTier < g.tier_required) throw new Error('locked');

  const cost = entries * ENTRY_COST_CENTS;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (u.gems_cents < cost) throw new Error('not_enough_gems');

  const newBal = u.gems_cents - cost;
  db.prepare('UPDATE users SET gems_cents=? WHERE id=?').run(newBal, userId);

  db.prepare(`
    INSERT INTO giveaway_entries(giveaway_id,user_id,entries,created_at)
    VALUES(?,?,?,?)
    ON CONFLICT(giveaway_id,user_id) DO UPDATE SET entries=entries+excluded.entries
  `).run(giveawayId, userId, entries, nowIso());

  db.prepare('INSERT INTO ledger(user_id,type,amount_cents,meta_json,created_at) VALUES(?,?,?,?,?)')
    .run(userId, 'giveaway_enter', -cost, JSON.stringify({ giveawayId, entries }), nowIso());

  return { cost_gems: formatGems(cost), balance_gems: formatGems(newBal) };
}

module.exports = {
  ENTRY_COST_CENTS,
  listGiveaways,
  getGiveaway,
  enterGiveaway,
  closeEndedGiveaways,
  listWinners,
};

function closeEndedGiveaways() {
  // Find giveaways that ended but are still marked active.
  const now = new Date().toISOString();
  const ended = db.prepare(`
    SELECT * FROM giveaways
    WHERE status='active' AND ends_at <= ?
    ORDER BY ends_at ASC
  `).all(now);

  for (const g of ended) {
    // Skip if already has a winner record (idempotent)
    const existing = db.prepare('SELECT 1 FROM giveaway_winners WHERE giveaway_id=?').get(g.id);
    if (existing) {
      db.prepare("UPDATE giveaways SET status='ended' WHERE id=?").run(g.id);
      continue;
    }

    const entries = db.prepare(`
      SELECT ge.user_id, ge.entries, u.steam_id, u.display_name, u.avatar_url
      FROM giveaway_entries ge
      JOIN users u ON u.id = ge.user_id
      WHERE ge.giveaway_id=? AND ge.entries > 0
    `).all(g.id);

    const winner = weightedPick(entries);
    if (winner) {
      db.prepare(`
        INSERT INTO giveaway_winners(
          giveaway_id, user_id, steam_id, display_name, avatar_url, entries, prize_text, picked_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        g.id,
        winner.user_id,
        winner.steam_id,
        winner.display_name,
        winner.avatar_url,
        winner.entries,
        g.prize_text,
        nowIso(),
      );
    }

    db.prepare("UPDATE giveaways SET status='ended' WHERE id=?").run(g.id);
  }

  return ended.length;
}

function listWinners(limit = 50) {
  limit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  return db.prepare(`
    SELECT w.*, g.title as giveaway_title
    FROM giveaway_winners w
    LEFT JOIN giveaways g ON g.id = w.giveaway_id
    ORDER BY w.picked_at DESC
    LIMIT ?
  `).all(limit);
}
