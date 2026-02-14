# Case-Bros (Render-ready starter)

A **CS2-style case opening simulator** built as a single Render Web Service:

- **Next.js** UI (animation + pages)
- **Express** custom server (Steam login + JSON API)
- **Passport-Steam (OpenID)** authentication
- **Postgres** for persistence (recommended)
- **Market cache** with TTL (default: 3 hours)
- **No real-money gambling** (gems are an internal points balance)

> Not affiliated with Valve or Steam. This project is intended as a **simulator** / community web app.

---

## 1) Local setup

### Prereqs
- Node.js 18+
- Postgres running locally (or any hosted Postgres)

### Install
```bash
npm install
cp .env.example .env
```

### Configure `.env`
Required:
- `BASE_URL=http://localhost:3000`
- `STEAM_API_KEY=...`
- `SESSION_SECRET=...`
- `DATABASE_URL=postgres://...`

Optional:
- `ADMIN_STEAM_IDS=comma,separated,steamids`
- `MARKET_MODE=steam` (or `mock`)

### Migrate + seed
```bash
npm run db:migrate
npm run db:seed
```

### Run
```bash
npm run dev
```

Open: `http://localhost:3000`

---

## 2) Steam login notes (important)

### How it works
- User clicks **Sign in with Steam**
- Steam redirects back to: `BASE_URL/auth/steam/return`
- Server creates a **session cookie** and loads the user by `steam_id`

### The two critical gotchas
1. **`BASE_URL` must match your deployed domain** exactly (including `https`)  
   If it’s wrong, Steam redirects you to the wrong place.

2. **Trust proxy is required on Render / Cloudflare**  
   This repo already sets:
   ```js
   app.set('trust proxy', 1);
   ```
   so secure cookies work behind a reverse proxy.

---

## 3) Deployment on Render

### Option A — Render Blueprint (recommended)
This repo includes `render.yaml`.

1. Push this project to GitHub
2. In Render: **New → Blueprint**
3. Select the repo, deploy
4. Set env vars in Render:
   - `BASE_URL` → your real Render URL
   - `STEAM_API_KEY` → your Steam Web API key
   - `ADMIN_STEAM_IDS` → your SteamID64 (optional)

### Option B — Manual
Create:
- 1× Render **Web Service**
- 1× Render **Postgres** database

Set env vars:
- `DATABASE_URL` (use “Internal Database URL”)
- `BASE_URL=https://your-service.onrender.com`
- `STEAM_API_KEY=...`
- `SESSION_SECRET=...`

Build command:
```bash
npm install && npm run db:migrate && npm run db:seed && npm run build
```

Start command:
```bash
npm start
```

---

## 4) What’s implemented (MVP)

### Core
- `/auth/steam` + `/auth/steam/return` Steam login
- `/api/open` server-side drop selection (weighted) + wear/float
- `/api/inventory` inventory list + sell endpoint
- `/api/leaderboard` top 50 by gems
- `/api/giveaways` + enter endpoint
- `/api/admin/*` admin-only endpoints
- `/api/placeholder.svg` placeholder images (so UI never blanks)

### Wear bands
- Factory New: 0.00–0.07
- Minimal Wear: 0.07–0.15
- Field-Tested: 0.15–0.38
- Well-Worn: 0.38–0.45
- Battle-Scarred: 0.45–1.00

### Pattern index
- Stored for special items (gold drops): `0–999`

### Market cache
- Cached in `market_cache` table
- TTL default: `3 hours`
- If stale → refresh in background, return cached immediately
- If missing → refresh now so user sees a price
- If Steam request fails → deterministic mock price (so the app still works)

---

## 5) Next steps you can add

- Mastery levels / XP and badges
- Case purchase shop / daily missions
- “Total value opened” stats table
- Better giveaway scheduling + auto-pick winner job
- Replace placeholders with your own rendered images (recommended to avoid Valve assets)

Enjoy!
