# NSE Stock Lab (Next.js PWA)

Mobile-first **Next.js (App Router) + TypeScript + Tailwind** progressive web app for paper / research stock ideas.

> **Not SEBI-registered advice. Paper / research only.**

## Screens

| Route | Purpose |
|-------|---------|
| `/budget` | ₹ budget input + chips (5k / 10k / 25k / 50k), default `10000`, persisted in `localStorage` |
| `/ideas` | Verdict cards from `public/data/verdicts.json` |
| `/ideas/[ticker]` | Detail: verdict + tech / funda / news lanes |
| `/report` | Daily report from `public/data/daily_report.json` |
| `/paper` | Paper ledger fills; unrealized shows **UNKNOWN** when unmarked |

Sticky SEBI banner on every screen. Bottom nav on mobile.

## Quick start

```bash
cd /workspace/stock-lab/web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (dev binds `0.0.0.0:3000`).

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
- Budget is device-local; paper marks are not live — unrealized P&L stays `UNKNOWN` until a mark feed exists.
