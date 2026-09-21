# NSE Stock Lab (Next.js PWA)

Mobile-first **Next.js (App Router) + TypeScript + Tailwind** progressive web app for paper / research stock ideas.

> **Not SEBI-registered advice. Paper / research only.**

## Screens

| Route | Purpose |
|-------|---------|
| `/budget` | ₹ budget input + chips (100 / 500 / 1k / 5k / 10k / 25k / 50k), default `10000`, persisted in `localStorage` |
| `/lookup` | Live ticker lookup (Yahoo `SYMBOL.NS`, placeholder e.g. INFY) → tech + risk verdict + plan fields |
| `/ideas` | Verdict cards from `public/data/verdicts.json` (plan fields derived for fixtures) |
| `/ideas/[ticker]` | Detail: verdict + tech / funda / news lanes |
| `/ideas/[ticker]?live=1` | Same detail, but live Yahoo tech + TS risk merge |
| `/budget-picks` | Budget + risk% → scan ~22 NSE names → top 10 buys that fit sizing |
| `/screen` | Budget-aware screener (~50 Nifty50-ish) with sector / PE / ROE / volume filters → links to Lookup |
| `/report` | Daily report from `public/data/daily_report.json` |
| `/paper` | Paper ledger fills; unrealized shows **UNKNOWN** when unmarked |

Sticky SEBI banner on every screen. Bottom nav: Budget · Lookup · Screen · Ideas · Picks · Report · Paper.

## Live APIs

Prices come **only** from Yahoo (`query1` chart API for `SYMBOL.NS`). Missing values are marked **UNKNOWN** — never invented.

### `GET /api/lookup?symbol=INFY`

Normalizes to `INFY.NS`, returns:

- **tech**: live Yahoo chart → `cmp`, `atr_14`, `support_levels`, `resistance_levels`, `structure`, `breakout_state`, `trigger_level`, `rsi_14`, `price_vs_dma`, DMAs
- **funda**: desk scrape `funda/scrape_one.py` → Screener PE/ROE/D-E + `funda_quality` (gaps → `unknowns[]`)
- **news**: desk scrape `news/scrape_one.py` → Google News RSS headline/summary/`confirmation_status`/`why_for_verdict`/`catalyst_expiry`
- **verdict**: `mergeVerdict(tech, {budget, risk_pct, funda, news})` — gates rumored-only + funda fail; folds `why_for_verdict`; horizon from `catalyst_expiry`

Optional: `budget_inr`, `risk_pct` (default 10000 / 1). Never invents numbers/filings.

### `POST /api/screen`

Body: `{ "budget_inr": 10000, "sectors?": ["Banks"], "pe_max?", "roe_min?", "min_volume_vs_avg?", "risk_pct?" }`

Universe (~50 liquid NSE): see `src/lib/screenUniverse.ts`. Yahoo CMP + volume via tech helpers; funda via `fetchLiveFunda`. Filters `cmp<=budget` when known. Returns `results` + `fits` with `ticker, cmp, sector, pe_ttm, roe_pct, volume_vs_avg_20d, afford_shares, fits_budget, unknowns, sources`. Concurrency 4. Never invents prices.

Also `GET /api/screen?budget_inr=10000` for curl smoke.

### `POST /api/budget-picks`

Body: `{ "budget_inr": 10000, "risk_pct": 1 }`

Universe (~23, multi-sector): SBIN, HDFCBANK, ICICIBANK, AXISBANK, PNB, ONGC, NTPC, COALINDIA, RELIANCE, INFY, TCS, WIPRO, SUNPHARMA, CIPLA, TATAMOTORS, MARUTI, ITC, HINDUNILVR, TATASTEEL, NMDC, LT, IRFC, BHARTIARTL.

Returns up to **10 buys** where `shares >= 1` and `entry * shares <= budget_inr`.

**Sizing (P0a):** `risk_inr = budget * risk_pct/100`; `per_share = entry − sl`; `shares = floor(risk_inr / per_share)`. Micro-budgets ≤ ₹2500: if risk sizing yields 0 but 1 share fits, take 1 share (`micro_floor_1share`). No buy if `per_share <= 0` or notional &gt; budget.

**Bias (P0b):** breakout, HH_HL, or soft constructive (not LH_LL, mixed/above DMAs, RSI 48–62). **No preferred-sector score bonus.** Below all DMAs + LH_LL → hold/avoid.

**P1:** plain-language reason lines + plan ladder / 30d sparkline on idea detail.

Also available as `GET /api/budget-picks?budget_inr=10000&risk_pct=1` for curl smoke tests.

## Quick start

```bash
cd /workspace/stock-lab/web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (dev binds `0.0.0.0:3000`).

### Smoke checks

```bash
npm run build
curl -s "http://localhost:3000/api/lookup?symbol=PNB" | head
curl -s -X POST http://localhost:3000/api/budget-picks \
  -H 'content-type: application/json' \
  -d '{"budget_inr":10000,"risk_pct":1}' | head
curl -s -X POST http://localhost:3000/api/screen \
  -H 'content-type: application/json' \
  -d '{"budget_inr":10000}' | head
```

### Production build

```bash
npm run build
npm start
```

## PWA — Add to Home Screen

1. Deploy or open the site over **HTTPS** (or `localhost`).
2. **iOS Safari**: Share → **Add to Home Screen**.
3. **Android Chrome**: Menu → **Install app** / **Add to Home screen**.

Manifest: `public/manifest.webmanifest`  
Service worker: `public/sw.js` (caches static assets + `/data/*.json`)  
Icons: `public/icon-192.png`, `public/icon-512.png`, `public/icon.svg`, `public/apple-touch-icon.png`

## Fixture data

Copied into `public/data/`:

| App path | Source |
|----------|--------|
| `verdicts.json` | `risk/verdicts_multi-2026-09-21.json` |
| `daily_report.json` | `daily_report/out/multi_2026-09-21_report.json` |
| `ledger.json` | `paper/ledger_multi-2026-09-21.json` |
| `tech.json` | `tech/lane_results_multi-2026-09-21.json` |
| `funda.json` | `funda/lane_results_multi-2026-09-21.json` |
| `news.json` | `news/lane_results_multi-2026-09-21.json` |

Static fixture verdicts get plan fields derived on read: `buy_trigger ← entry`, `sell_targets ← targets`, `stop_invalidation ← sl`.

## Deploy to Vercel (shareable friend URL)

1. Push this `web/` folder (or the monorepo with Root Directory = `web`) to GitHub/GitLab.
2. In [Vercel](https://vercel.com/new): **Import** the repo.
3. Set **Root Directory** to `web` (if the repo is `stock-lab`).
4. Framework preset: **Next.js**. Build: `npm run build`. Output: default.
5. Deploy → copy the `*.vercel.app` URL and share it.
6. Friends can open the URL and **Add to Home Screen** for an app-like experience.

CLI alternative:

```bash
cd /workspace/stock-lab/web
npx vercel
```

## Notes

- This app is **Next.js only** — do not wire Streamlit into this package.
- Live prices: Yahoo Finance chart API only (`query1` / `SYMBOL.NS`).
- Budget is device-local; paper marks are not live — unrealized P&L stays `UNKNOWN` until a mark feed exists.
- Funda/news: spawned desk Python scrapers (`funda/scrape_one.py`, `news/scrape_one.py`, ~20s timeout); gaps → unknowns[]; never invent numbers.
