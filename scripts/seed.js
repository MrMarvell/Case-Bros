/*
  Seed database with REAL CS2 cases + items (images + rarities)

  Data source:
  - ByMykel CSGO-API (crates.json + skins.json)
    https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json

  Notes:
  - We do NOT bake prices into the seed. Prices are pulled from Steam Community Market on demand
    and cached in the market_cache table (see lib/market.js).
  - This keeps prices always current and avoids shipping huge static price tables.
*/

const { db } = require('../lib/db');
const { getCrates, getSkins } = require('../lib/csgoApi');

const KEY_PRICE_CENTS = 249; // Steam key is $2.49 USD (before tax). Simulation uses cents.

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeRarity(rarity) {
  const n = String(rarity?.name || '').toLowerCase();
  if (n.includes('mil-spec')) return 'Mil-Spec';
  if (n.includes('restricted')) return 'Restricted';
  if (n.includes('classified')) return 'Classified';
  if (n.includes('covert')) return 'Covert';
  if (n.includes('extraordinary') || n.includes('rare special')) return 'Extraordinary';
  if (n.includes('industrial')) return 'Industrial';
  if (n.includes('consumer')) return 'Consumer';
  return rarity?.name || 'Unknown';
}

// Standard CS case odds (approx, but widely used)
// Mil-Spec 79.92%, Restricted 15.98%, Classified 3.2%, Covert 0.64%, Rare Special 0.26%
const ODDS = {
  'Mil-Spec': 0.7992,
  'Restricted': 0.1598,
  'Classified': 0.032,
  'Covert': 0.0064,
  'Extraordinary': 0.0026
};

function buildWeightsByRarity(items) {
  const byRarity = new Map();
  for (const it of items) {
    const r = it._rarity;
    if (!byRarity.has(r)) byRarity.set(r, []);
    byRarity.get(r).push(it);
  }

  const SCALE = 1_000_000; // integer weights
  const weights = new Map();

  // Determine which odds to apply for this crate
  const raritiesPresent = [...byRarity.keys()];
  const oddsPresent = raritiesPresent
    .map((r) => ({ r, p: ODDS[r] }))
    .filter((x) => Number.isFinite(x.p) && x.p > 0);

  const totalOdds = oddsPresent.reduce((s, x) => s + x.p, 0);

  for (const { r, p } of oddsPresent) {
    const list = byRarity.get(r) || [];
    if (!list.length) continue;
    const tierP = p / totalOdds;
    const perItem = Math.max(1, Math.floor((tierP / list.length) * SCALE));
    for (const it of list) weights.set(it.id, perItem);
  }

  // Any unknown rarity gets a tiny weight so it can still drop (rare)
  for (const r of raritiesPresent) {
    if (ODDS[r]) continue;
    const list = byRarity.get(r) || [];
    for (const it of list) weights.set(it.id, 1);
  }

  return weights;
}

// Offline-safe fallback seed.
//
// Why this exists:
// - Render Free has no shell, so we auto-seed at boot.
// - If the external dataset fetch fails (network/DNS/rate-limit),
//   the UI would otherwise show *no cases*.
//
// This fallback keeps the app usable. If/when the external dataset
// becomes reachable, you can delete the SQLite file to trigger a full
// reseed from the upstream dataset.
const FALLBACK_SEED = {
  cases: [
    {
      name: 'Demo Case Alpha',
      items: [
        { name: 'Glock-18 | Blue Lines', weapon: 'Glock-18', skin: 'Blue Lines', rarity: 'Consumer Grade', market_hash_name_base: 'Glock-18 | Blue Lines' },
        { name: 'P250 | Sand Drift', weapon: 'P250', skin: 'Sand Drift', rarity: 'Consumer Grade', market_hash_name_base: 'P250 | Sand Drift' },
        { name: 'MP9 | Metro', weapon: 'MP9', skin: 'Metro', rarity: 'Industrial Grade', market_hash_name_base: 'MP9 | Metro' },
        { name: 'XM1014 | Circuit', weapon: 'XM1014', skin: 'Circuit', rarity: 'Industrial Grade', market_hash_name_base: 'XM1014 | Circuit' },
        { name: 'M4A1-S | Night Wire', weapon: 'M4A1-S', skin: 'Night Wire', rarity: 'Mil-Spec Grade', market_hash_name_base: 'M4A1-S | Night Wire' },
        { name: 'AK-47 | Ember', weapon: 'AK-47', skin: 'Ember', rarity: 'Mil-Spec Grade', market_hash_name_base: 'AK-47 | Ember' },
        { name: 'USP-S | Aurora', weapon: 'USP-S', skin: 'Aurora', rarity: 'Restricted', market_hash_name_base: 'USP-S | Aurora' },
        { name: 'AWP | Arc Light', weapon: 'AWP', skin: 'Arc Light', rarity: 'Classified', market_hash_name_base: 'AWP | Arc Light' },
        { name: '★ Knife | Demo Edge', weapon: 'Knife', skin: 'Demo Edge', rarity: 'Covert', market_hash_name_base: '★ Knife | Demo Edge' },
      ],
    },
    {
      name: 'Demo Case Beta',
      items: [
        { name: 'Tec-9 | Copper', weapon: 'Tec-9', skin: 'Copper', rarity: 'Consumer Grade', market_hash_name_base: 'Tec-9 | Copper' },
        { name: 'Nova | Shards', weapon: 'Nova', skin: 'Shards', rarity: 'Consumer Grade', market_hash_name_base: 'Nova | Shards' },
        { name: 'MAC-10 | Fade Grid', weapon: 'MAC-10', skin: 'Fade Grid', rarity: 'Industrial Grade', market_hash_name_base: 'MAC-10 | Fade Grid' },
        { name: 'FAMAS | Lockstep', weapon: 'FAMAS', skin: 'Lockstep', rarity: 'Mil-Spec Grade', market_hash_name_base: 'FAMAS | Lockstep' },
        { name: 'SSG 08 | Glacier', weapon: 'SSG 08', skin: 'Glacier', rarity: 'Mil-Spec Grade', market_hash_name_base: 'SSG 08 | Glacier' },
        { name: 'Desert Eagle | Prism', weapon: 'Desert Eagle', skin: 'Prism', rarity: 'Restricted', market_hash_name_base: 'Desert Eagle | Prism' },
        { name: 'AK-47 | Crimson Draft', weapon: 'AK-47', skin: 'Crimson Draft', rarity: 'Classified', market_hash_name_base: 'AK-47 | Crimson Draft' },
        { name: '★ Gloves | Demo Weave', weapon: 'Gloves', skin: 'Demo Weave', rarity: 'Covert', market_hash_name_base: '★ Gloves | Demo Weave' },
      ],
    },
  ],
};

function seedFallback() {
  const existing = db.prepare('SELECT COUNT(1) AS c FROM cases').get().c;
  if (existing > 0) return;

  const insertCase = db.prepare(
    `INSERT INTO cases (slug, name, image_url, active, case_price_cents, key_price_cents, created_at)
     VALUES (@slug, @name, @image_url, 1, @case_price_cents, @key_price_cents, @created_at)`
  );
  const insertItem = db.prepare(
    `INSERT INTO items (name, weapon, skin, rarity, image_url, market_hash_name_base, created_at)
     VALUES (@name, @weapon, @skin, @rarity, @image_url, @market_hash_name_base, @created_at)`
  );
  const insertCaseItem = db.prepare(
    `INSERT INTO case_items (case_id, item_id, weight)
     VALUES (@case_id, @item_id, @weight)`
  );

  const createdAt = nowIso();

  const tx = db.transaction(() => {
    for (const c of FALLBACK_SEED.cases) {
      const slug = slugify(c.name);
      const res = insertCase.run({
        slug,
        name: c.name,
        image_url: null,
        case_price_cents: 100,
        key_price_cents: 250,
        created_at: createdAt,
      });
      const caseId = res.lastInsertRowid;
      const weights = buildWeightsByRarity(c.items);
      for (const it of c.items) {
        const ir = insertItem.run({
          name: it.name,
          weapon: it.weapon,
          skin: it.skin,
          rarity: it.rarity,
          image_url: null,
          market_hash_name_base: it.market_hash_name_base || it.name,
          created_at: createdAt,
        });
        insertCaseItem.run({
          case_id: caseId,
          item_id: ir.lastInsertRowid,
          weight: weights[it.name] ?? 1,
        });
      }
    }
  });
  tx();
  console.warn('[seed] Used FALLBACK_SEED (external dataset unavailable).');
}

async function seed() {
  // If DB already has cases, do nothing
  const existing = db.prepare('SELECT COUNT(1) AS n FROM cases').get();
  if (existing?.n > 0) {
    console.log('✅ Seed skipped (cases already exist).');
    return;
  }

  console.log('🌱 Seeding CS2 cases/items from ByMykel CSGO-API...');

  let crates = [];
  try {
    crates = await getCrates();
  } catch (e) {
    console.error('❌ Failed to fetch crates.json. Using fallback seed instead.', e?.message || e);
    seedFallback();
    return;
  }

  // Optional wear metadata: map name -> {min_float,max_float}
  const wearMeta = new Map();
  try {
    const skins = await getSkins();
    for (const s of skins || []) {
      if (!s?.name) continue;
      if (Number.isFinite(s.min_float) && Number.isFinite(s.max_float)) {
        wearMeta.set(String(s.name).trim(), { min: s.min_float, max: s.max_float });
      }
    }
  } catch (e) {
    console.warn('⚠️  Could not fetch skins.json for float ranges. Continuing without wear ranges.');
  }

  // Keep only actual weapon cases
  const cases = (crates || []).filter((c) => {
    const type = String(c?.type || '').toLowerCase();
    return type === 'case' || type.includes('weapon case') || type.endsWith('case');
  });

  if (!cases.length) {
    console.error('❌ No cases found in crates.json. Using fallback seed instead.');
    seedFallback();
    return;
  }

  const insertCase = db.prepare(`
    INSERT INTO cases (slug, name, image_url, case_price_cents, key_price_cents, active, market_hash_name)
    VALUES (@slug, @name, @image_url, @case_price_cents, @key_price_cents, 1, @market_hash_name)
    ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name,
      image_url=excluded.image_url,
      key_price_cents=excluded.key_price_cents,
      active=1,
      market_hash_name=COALESCE(excluded.market_hash_name, cases.market_hash_name)
  `);

  const insertItem = db.prepare(`
    INSERT INTO items (name, rarity, image_url, price_cents, market_hash_name_base, min_float, max_float)
    VALUES (@name, @rarity, @image_url, @price_cents, @market_hash_name_base, @min_float, @max_float)
    ON CONFLICT(name, rarity) DO UPDATE SET
      image_url=COALESCE(excluded.image_url, items.image_url),
      market_hash_name_base=COALESCE(excluded.market_hash_name_base, items.market_hash_name_base),
      min_float=COALESCE(excluded.min_float, items.min_float),
      max_float=COALESCE(excluded.max_float, items.max_float)
  `);

  const getCaseId = db.prepare('SELECT id FROM cases WHERE slug=?').get;
  const getItemId = db.prepare('SELECT id FROM items WHERE name=? AND rarity=?').get;

  const clearCaseItems = db.prepare('DELETE FROM case_items WHERE case_id=?');
  const insertCaseItem = db.prepare(`
    INSERT INTO case_items (case_id, item_id, weight)
    VALUES (?, ?, ?)
    ON CONFLICT(case_id, item_id) DO UPDATE SET weight=excluded.weight
  `);

  const tx = db.transaction((caseRows) => {
    for (const c of caseRows) {
      const slug = slugify(c.name) || slugify(c.id) || c.id;
      const marketHashName = c.market_hash_name || c.name;

      insertCase.run({
        slug,
        name: c.name,
        image_url: c.image,
        case_price_cents: 0,
        key_price_cents: KEY_PRICE_CENTS,
        market_hash_name: marketHashName
      });

      const caseId = getCaseId(slug).id;
      clearCaseItems.run(caseId);

      // Build unified item list (regular + rare)
      const allItems = [];
      for (const it of c.contains || []) allItems.push({ ...it, __pool: 'regular' });
      for (const it of c.contains_rare || []) allItems.push({ ...it, __pool: 'rare' });

      // Upsert items and collect IDs
      for (const it of allItems) {
        const rarity = normalizeRarity(it.rarity);
        const meta = wearMeta.get(String(it.name).trim());

        insertItem.run({
          name: it.name,
          rarity,
          image_url: it.image,
          price_cents: 0,
          market_hash_name_base: it.market_hash_name_base || it.name,
          min_float: meta?.min ?? null,
          max_float: meta?.max ?? null
        });
      }

      // Re-resolve item ids + compute weights per rarity for THIS case
      const resolved = [];
      for (const it of allItems) {
        const rarity = normalizeRarity(it.rarity);
        const row = getItemId(it.name, rarity);
        if (!row?.id) continue;
        resolved.push({ id: row.id, _rarity: rarity });
      }

      const weights = buildWeightsByRarity(resolved);
      for (const r of resolved) {
        insertCaseItem.run(caseId, r.id, weights.get(r.id) || 1);
      }
    }
  });

  tx(cases);

  console.log(`✅ Seed complete: ${cases.length} cases imported.`);
}

module.exports = seed;

// Allow running manually: node scripts/seed.js
if (require.main === module) {
  seed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
