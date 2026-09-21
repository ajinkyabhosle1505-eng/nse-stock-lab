# NSE Stock Lab (Next.js PWA)

Mobile-first **Next.js (App Router) + TypeScript + Tailwind** progressive web app for paper / research stock ideas.

> **Not SEBI-registered advice. Paper / research only.**

## Screens

| Route | Purpose |
|-------|---------|
| `/budget` | ₹ budget input + chips (5k / 10k / 25k / 50k), default `10000`, persisted in `localStorage` |
| `/lookup` | Live ticker lookup (Yahoo `SYMBOL.NS`) → tech + risk verdict + plan fields |
| `/ideas` | Verdict cards from `public/data/verdicts.json` (plan fields derived for fixtures) |
| `/ideas/[ticker]` | Detail: verdict + tech / funda / news lanes |
| `/ideas/[ticker]?live=1` | Same detail, but live Yahoo tech + TS risk merge |
| `/budget-picks` | Budget + risk% → scan ~22 NSE names → top 10 buys that fit sizing |
| `/report` | Daily report from `public/data/daily_report.json` |
| `/paper` | Paper ledger fills; unrealized shows **UNKNOWN** when unmarked |

Sticky SEBI banner on every screen. Bottom nav: Budget · Lookup · Ideas · Picks · Report · Paper.

## Live APIs

Prices come **only** from Yahoo (`query1` chart API for `SYMBOL.NS`). Missing values are marked **UNKNOWN** — never invented.

### `GET /api/lookup?symbol=PNB`

Normalizes to `PNB.NS`, returns:

- **tech**: live Yahoo chart → `cmp`, `atr_14`, `support_levels`, `resistance_levels`, `structure`, `breakout_state`, `trigger_level`, `rsi_14`, `price_vs_dma`, DMAs
- **funda**: desk scrape `funda/scrape_one.py` → Screener PE/ROE/D-E + `funda_quality` (gaps → `unknowns[]`)
- **news**: desk scrape `news/scrape_one.py` → Google News RSS headline/summary/`confirmation_status`/`why_for_verdict`/`catalyst_expiry`
- **verdict**: `mergeVerdict(tech, {budget, risk_pct, funda, news})` — gates rumored-only + funda fail; folds `why_for_verdict`; horizon from `catalyst_expiry`

Optional: `budget_inr`, `risk_pct` (default 10000 / 1). Never invents numbers/filings.

### `POST /api/budget-picks`

Body: `{ "budget_inr": 10000, "risk_pct": 1 }`

Universe (~22): SBIN, BANKBARODA, PNB, CANBK, HDFCBANK, ONGC, NTPC, POWERGRID, COALINDIA, IOC, BPCL, IRFC, RECLTD, PFC, NMDC, VEDL, TATAPOWER, ITC, WIPRO, RELIANCE, YESBANK, IDEA.

Returns up to **10 buys** where `shares >= 1` and `entry * shares <= budget_inr`.

**Sizing:** `risk_inr = budget * risk_pct/100`; `per_share = entry − sl`; `shares = floor(risk_inr / per_share)`; no buy if `per_share <= 0`, `shares < 1`, or notional &gt; budget.

**Bias:** breakout or HH_HL (not breakdown); prefer Banks / Energy / Infra; avoid pennies YESBANK/IDEA unless exceptional; below all DMAs + LH_LL → hold/avoid.

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
