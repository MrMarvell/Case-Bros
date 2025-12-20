const https = require('https');

const DEFAULT_BASE = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'case-bros (cs2-sim)'
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}

function apiBase() {
  const b = process.env.CSGO_API_BASE?.trim();
  return b || DEFAULT_BASE;
}

function urlFor(path) {
  const base = apiBase().replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return `${base}/${p}`;
}

async function getCrates() {
  try {
    return await getJson(urlFor('crates.json'));
  } catch (e) {
    // If GitHub raw is blocked/unavailable on the host, fall back to a tiny starter set
    console.warn('[csgoApi] crates.json fetch failed, using fallback seed:', e.message);
    return {
      crates: [
        {
          id: 'dreams-nightmares-case',
          name: 'Dreams & Nightmares Case',
          description: 'Fallback seed (network unavailable).',
          rarity: 'Case',
          image: null,
          contains: [
            { name: 'AK-47 | Redline', rarity: 'Covert', image: null },
            { name: 'M4A1-S | Printstream', rarity: 'Covert', image: null },
            { name: 'Glock-18 | Vogue', rarity: 'Restricted', image: null },
          ],
          containsRare: [
            { name: '★ Karambit | Doppler', rarity: 'Extraordinary', image: null },
          ],
        },
        {
          id: 'kilowatt-case',
          name: 'Kilowatt Case',
          description: 'Fallback seed (network unavailable).',
          rarity: 'Case',
          image: null,
          contains: [
            { name: 'Desert Eagle | Printstream', rarity: 'Covert', image: null },
            { name: 'AWP | Chromatic Aberration', rarity: 'Covert', image: null },
            { name: 'AK-47 | Slate', rarity: 'Restricted', image: null },
          ],
          containsRare: [
            { name: '★ M9 Bayonet | Lore', rarity: 'Extraordinary', image: null },
          ],
        },
      ],
    };
  }
}

async function getSkins() {
  try {
    return await getJson(urlFor('skins.json'));
  } catch (e) {
    console.warn('[csgoApi] skins.json fetch failed, continuing without skins catalog:', e.message);
    return { skins: [] };
  }
}

module.exports = {
  apiBase,
  urlFor,
  getJson,
  getCrates,
  getSkins,
};
