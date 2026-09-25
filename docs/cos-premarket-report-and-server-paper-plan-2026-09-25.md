# Pre-market daily report + server-side paper portfolio: implementable brief (Stock Lab)
**Date:** 2026-09-25 IST · **For:** Stock Lab eng (via CoS) · **From:** Stock Research
**Scope:** (1) Automated pre-market daily report on Vercel Hobby (free tier only). (2) Server-side paper portfolio and forecast-accuracy tracking that replaces localStorage as the source of truth.
**Posture:** Paper trading and research only. Not SEBI-registered advice. Reuse `SEBI_BANNER` (`web/src/lib/universe.ts:126`) everywhere.
**Status:** Research and writing only. No app code was changed, committed, or pushed. Repo HEAD read: `c13b282` (matches `origin/main`).

Legend: **VERIFIED** means checked against the cited URL on 2026-09-25. **UNVERIFIED** means we could not confirm it; do not build on it without checking.

---

## 0) Inventory of the current code (what exists today)

### 0.1 Daily report is static, and the live page is broken
| Item | Path | Finding |
|---|---|---|
| Route | `web/src/app/report/page.tsx` | Server component. Calls `getDailyReport()` and reads **keyed** sections: `sections["1_market_overview"]`, `["2_top10_under_1000"].items`, `["3_deep_dive_top3"].items`, `["4_five_avoids"].items`, `["5_penny_under_50"]`, `["6_final_summary"]`. |
| Loader | `web/src/lib/data.ts` → `getDailyReport()` | `readFile(public/data/daily_report.json)`. It is a static fixture and no live call is made. |
| Fixture | `web/public/data/daily_report.json` | `report_id: "multi-2026-09-21-p0p1_report"`, `as_of: "2026-09-21"`. `sections` is an **array** of `{id,title,body,tickers}` with ids `overview, top_under_1000, deep_dive, avoids, paper, summary`. |
| Generator | `daily_report/mapper.py` (Python, offline) | `map_daily_report(pack)` maps a DeskJob pack to the 6 sections. Top 10 = buys with cmp<1000, sorted by conf. Not wired to Vercel. |
| Other fixtures | `web/public/data/verdicts.json` (`as_of 2026-09-21`, `generated_at 2026-09-21T17:53:59.324Z`, `report_hints.section2..6`), `tech.json`, `funda.json`, `news.json`, `ledger.json` | All from the 2026-09-21 desk run. |
| **Live bug (VERIFIED)** | https://nse-stock-lab.vercel.app/report fetched 2026-09-25 11:54 IST | The page shows "No items" in every section and "—" in the summary. The page expects keyed sections but the fixture holds an array, so the lookup misses. Section 2 below replaces both with one schema (`stock-lab.report.v1`). |
| Offline cache | `web/public/sw.js` | Network-first for `/data/*.json` and precached pages. `/api/*` is not cached. |

### 0.2 Live lanes (reused by the report job)
| File | Key facts |
|---|---|
| `web/src/lib/live.ts` | `runLookup(sym, {budget_inr, risk_pct, funda, news})`: awaits `fetchYahooHistory(yahoo)` (1y, 1d), then runs `fetchLiveFunda` and `fetchLiveNews` in parallel, then `mergeVerdict`. `runBudgetPicks`: scans `BUDGET_UNIVERSE` through `mapPool(…, 3, …)` with news off. Uses `diversifiedPickScore` (−18 for `MEGA_PSU_DEMOTE`) and `diversifyPicks` (max 1 per sector if budget ≤ ₹5000, otherwise 2; limit 10). |
| `web/src/lib/yahoo.ts` | `fetchYahooHistory(symbol, "1y", "1d")` calls `query1.finance.yahoo.com/v8/finance/chart/…`. It drops null OHLC bars, **returns null if fewer than 30 bars**, and **ignores `indicators.adjclose`**. `fetchYahooHistoryRelaxed(minBars=1)` and `fetchYahooDailyBars(symbol, "3mo")` map bars to `{date: IST YYYY-MM-DD, o,h,l,c}`. `fetchYahooQuoteSummary` uses crumb/cookie (`ensureCrumb`, 30-min TTL). |
| `web/src/lib/tech.ts` | `computeTech(ticker, hist)`: `cmp = regularMarketPrice ?? last close`. It computes DMA20/50/200, Wilder RSI14, ATR14, structure, breakout, `closes_30d`, and `price_bucket` (`penny_under_50` / `under_1000` / `over_1000`). `unknownTech()` handles failures. |
| `web/src/lib/risk.ts` | `deriveLevels` (line 101): `entry=cmp`, `sl=entry−2.4×ATR` (fallback: min support × 0.995), `T1=entry+2×ATR`, `T2=entry+3.5×ATR`. `mergeVerdict` (line 363) applies the gates: rumored strong news → hold-lean, confirmed bearish news → hold/avoid, `funda_quality=fail` → avoid unless tape is exceptional. With no CMP it returns `action:"avoid", insufficient_data:true, cmp:"UNKNOWN"`. `pickScore` (line 491): conf×10, +100 buy, −40 penny, +5×r_r, +5 under ₹1000, ±funda, −20 rumored. |
| `web/src/lib/funda.ts` | Scrapes `https://www.screener.in/company/<T>/consolidated/` (8s timeout) for P/E, ROE, D/E, then runs `computeFundaQuality`. |
| `web/src/lib/news.ts` | Yahoo RSS `finance.yahoo.com/rss/headline?s=` and Google News RSS (8s timeout). |
| `web/src/lib/screen.ts` / `screenUniverse.ts` | `runScreen` uses `mapPool(…, 4, …)` over `SCREEN_UNIVERSE` (52 names). |
| `web/src/lib/universe.ts` | `BUDGET_UNIVERSE` (33 names), `SECTOR`, `MEGA_PSU_DEMOTE`, `PENNY_WATCH = {YESBANK, IDEA}`, `SEBI_BANNER`. The union with the screen universe is **59 unique symbols**. |
| Universe hygiene (VERIFIED 2026-09-25) | `TATAMOTORS.NS` returns Yahoo `"No data found, symbol may be delisted"`, while `TMPV.NS` returns data. That explains why fixtures list TATAMOTORS as "avoid: No live CMP". Fix the universe list (no invented mapping; confirm the successor symbols) and bump `universe_version`. |
| API routes | `web/src/app/api/{lookup,budget-picks,screen}/route.ts` have `maxDuration = 60`, `runtime = "nodejs"`. |

### 0.3 Paper trading and forecasts today (exact keys and shapes for migration)
| Key / store | Where | Shape |
|---|---|---|
| `localStorage["nse-stock-lab-paper-forecasts-v1"]` | `PAPER_FORECASTS_KEY` in `web/src/lib/forecast.ts`; read/write in `web/src/lib/paperStore.ts` | `PaperForecastPosition[]` (newest first; `upsertPaperForecast` unshifts) |
| `localStorage["stock-lab.budget_inr"]` | `BUDGET_KEY` in `web/src/lib/budget.ts` | number as string (default 10000) |
| Server "store" | `web/src/lib/paperServerStore.ts` | `globalThis.__nsePaperForecasts` is **in-memory, per instance, and lost on cold start**. |
| Buy | `web/src/components/PaperBuyButton.tsx` → `buildForecastBundle` on the **client**, then `upsertPaperForecast(pos)`, then fire-and-forget `POST /api/paper/buy` (the server also builds a bundle, in memory only). The comment says "localStorage is source of truth". | |
| Mark | `web/src/app/paper/page.tsx` `scoreDue()` → `POST /api/paper/mark-forecasts {positions}` → the server fetches `fetchYahooDailyBars(…,"3mo")` and runs `markForecastPoints` → the client writes the result back to localStorage. **The server trusts client-sent bundles (entry, predictedClose, createdAt).** | |
| Default check days | `DEFAULT_CHECK_DAY_CHIPS = [7, 14, 30]` | |

`PaperForecastPosition` (`web/src/lib/types.ts`):
```ts
{ id: string /* "pf_<TICKER>_<Date.now()>" */, ticker, yahoo_symbol, entry: number, sl: number|null,
  targets: number[], qty, budget_inr, size_inr, boughtAt: string /* client ISO */, sector?,
  checkDays: number[], atr_14?, structure?, breakout_state?, sebi_banner, forecast: ForecastBundle|null }
```
`ForecastBundle` is `{method:"atr_piecewise_T1_T2_v1", status?:"ok"|"skipped", skip_reason?, createdAt, params:{entry,sl,t1,t2,atr_14,R,d_T1,d_T2,scale,structure?,breakout_state?}, checkDays, points: ForecastPoint[], scoreSummary}`.
`ForecastPoint` is `{dayOffset, predictedClose, targetDate, actualClose, actualSessionDate, ape_pct, within_1atr, within_2pct, within_0_5r, direction_ok, status:"pending"|"scored"|"sparse"|"error", tradingDayIndex?, corporate_action_suspect?}`.
`Fill` / `LedgerFile` (`types.ts`) describe the fixture ledger only. `web/public/data/ledger.json` has `schema: "stock-lab.paper_ledger.v0"`, 3 fills (PNB, COALINDIA, ITC), `unrealizedPnl: "UNKNOWN"`, `mark: null`. The paper page shows it as an optional "Fixture ledger".

### 0.4 Infra today
- No `vercel.json` (at the repo root or in `web/`), no crons, and no `.github/workflows`.
- `web/package.json` depends only on `next 15.5.25`, `react 19.1.0`. There is **no DB client or env dependency**.
- The GitHub repo is **public** (VERIFIED via GitHub API). This matters for the GitHub Actions schedule caveats below.

### 0.5 Bugs to fix while porting the forecast code to the server (found in `forecast.ts` / mark route)
1. **Intraday partial bar gets scored as a close.** VERIFIED on 2026-09-25 at 11:54 IST: Yahoo v8 `interval=1d` already returns a bar for **today** whose close equals the live `regularMarketPrice` (RELIANCE: 1221.6). If a user taps "Score due" during market hours on a target date, `markForecastPoints` stores the LTP as `actualClose`. Fix: drop the bar whose `date == today IST` unless `now ≥ meta.currentTradingPeriod.regular.end + 30 min`. That field exists and read 15:30 IST in the probe.
2. **Touch flags include bars from before the fill.** `touched_t1/t2/sl` loop over all 3 months of bars. They must only use bars with `date > fill_session_date` and `≤ max scored actualSessionDate`.
3. **`tradingDayIndex` is the index into the 3mo array**, not the count of bars after the fill. Compute it as the number of bars with `fill_date < date ≤ actualSessionDate`.

---

## 1) Peer patterns to copy (brief, cited)

| Platform | What they do (cited) | Pattern we copy |
|---|---|---|
| **Zerodha Console** | P&L is computed **after exchange settlement, overnight, by segment** (F&O ~9 PM, equity ~1 AM), then synced to Console. Kite shows live FIFO P&L while Console shows settled M2M, and both reconcile in total. Sources: https://inthemoneybyzerodha.substack.com/p/what-happens-after-the-market-closes · staff reply "updated at midnight or between two and three in the morning… check the following morning": https://zerodha.com/z-connect/taxation-for-traders/zerodha-tax-reports · https://support.zerodha.com/category/console/reports/profit-and-loss-report/articles/kite-pnl-console-ledger | Two tiers: an **EOD provisional mark** (evening) and a **final mark** (next morning). Accuracy stats use **final only**. State the P&L method in the UI. |
| **Zerodha Kite alerts** | Alerts fire on recorded **ticks**, so a missed tick means no trigger. Source: https://support.zerodha.com/category/trading-and-markets/alerts-and-nudges/kite-alerts/articles/alert-not-triggered | We only have daily bars, so say "evaluated on daily close" and never imply intraday precision. |
| **Tickertape** | Separate **Pre-Market / Live-Market / Post-Market** updates (https://www.tickertape.in/blog/introducing-alerts-your-personalized-gateway-to-informed-investing/). The MMI page shows a relative freshness label, "Updated 1 day ago" (https://www.tickertape.in/market-mood-index). | Name the report by session phase ("Pre-market, based on close of …") and always show a relative age. |
| **Groww Digest** | A dated daily digest written after the close, with explicit qualifiers such as "Most European markets traded in red (as of 6 pm IST)" (https://digest.groww.in/p/govt-cuts-edible-oil-import-duty). | Timestamp every fact that is not an NSE close, such as global cues or news, with "as of HH:MM IST". |
| **TradingView Paper Trading** | P&L formula is published: long = `(Bid − Avg Fill) × Qty`, and last chart price does not affect it (https://www.tradingview.com/support/solutions/43000719857-how-is-position-profit-and-loss-in-paper-trading-calculated/). Reset **deletes history, orders, positions** (https://www.tradingview.com/support/solutions/43000480903-how-to-change-the-account-currency-in-paper-trading/). Only working orders can be modified. Filled history is not editable (third-party guide, https://www.techbloat.com/how-to-demo-trade-on-tradingview.html, so treat as UNVERIFIED-official). | Publish our fill and mark formula. **No edit of fills or forecasts.** "Reset" creates a **new portfolio** and never deletes history. |
| **smallcase** | Returns come from an index value computed on **end-of-day closing prices**. Rebalances use the day's OHLC average to reduce execution bias. **No transaction costs. No backtest mixed into live returns.** CA-verified. Source: https://www.smallcase.com/meta/return-calculation/ | EOD close marks, costs disclosed as excluded, and **verified (server-frozen) stats kept separate from unverified (client-created) ones**, the same way smallcase keeps backtest apart from live. |
| **Screener.in** | Save a query, then "Set alert". Screener "tracks new results for your screen and sends you a summary for new results" (https://www.screener.in/guides/creating-screens/). Alert emails carry a quarter indicator (https://www.screener.in/docs/changelog/emails-quarter-indicator/). Premium lists 75 screen alerts (https://www.screener.in/premium/). | The report includes a **"what changed since yesterday"** diff (entrants and exits in the Top 10 and Avoids). Future saved-screen alerts should be a diff of EOD runs, labelled with the data date. |

---

## 2) Part 1: Automated pre-market daily report

### 2.1 When to generate (decision)
- **Build from the prior session's EOD close. Publish between 06:30 and 07:29 IST, before the 09:00 pre-open.** Label it `Based on close of <Thu 24 Sep 2026> · For session <Fri 25 Sep 2026>`.
- Why:
  1. Yahoo v8 daily bars for the current day are **partial during the session** (VERIFIED, §0.5). By 06:30 IST the prior day's bar is settled.
  2. Free Yahoo exposes no reliable NSE pre-open or indicative data. The probe showed `hasPrePostMarketData: false` and `currentTradingPeriod.pre.start == pre.end` (a zero-length pre period) for RELIANCE.NS. Pre-open prices are therefore **not used and labelled as not used**.
  3. US closes (^GSPC, ^IXIC, both VERIFIED available on Yahoo) are final by 06:30 IST, so global cues are complete.
  4. Overnight news (RSS) gets included.
- NSE session times (pre-open 09:00–09:15, normal 09:15–15:30 IST) are taken from the task brief. They are **not re-verified**, because nseindia.com returned 403 to our fetcher.

### 2.2 Vercel Hobby limits (VERIFIED) and the scheduler decision
| Limit | Value | Source |
|---|---|---|
| Cron jobs per project | **100** (all plans) | https://vercel.com/docs/cron-jobs/usage-and-pricing |
| Minimum interval on Hobby | **Once per day**. Expressions that would run more often **fail deployment**. | same |
| Timing precision on Hobby | **Per hour (±59 min)**. `0 1 * * *` fires anywhere from 01:00:00 to 01:59:59. | same + https://vercel.com/docs/cron-jobs/manage-cron-jobs |
| Cron timezone | **Always UTC** | https://vercel.com/docs/cron-jobs |
| Cron auth | `CRON_SECRET` env is sent as `Authorization: Bearer <secret>`. User-Agent is `vercel-cron/1.0`. | https://vercel.com/docs/cron-jobs/manage-cron-jobs , https://vercel.com/docs/cron-jobs |
| Retries | **None** on failure. Delivery is best effort; runs can be **missed or duplicated**, so jobs must be idempotent. No redirects are followed. | https://vercel.com/docs/cron-jobs/manage-cron-jobs |
| Function max duration on Hobby (Fluid compute) | **300 s default and max** | https://vercel.com/docs/functions/limitations , https://vercel.com/docs/functions/configuring-functions/duration |
| Fluid compute default | "Enabled by default for new projects". Legacy non-Fluid Hobby (projects before 2025-04-23 without Fluid) is **10 s default / 60 s max**. | https://vercel.com/docs/functions/limitations , https://vercel.com/docs/limits |
| Hobby usage included | Active CPU **4 CPU-hrs**, Function Invocations **1,000,000**, Fast Origin Transfer 10 GB, Edge Requests 1M. Exceeding a limit pauses the feature for 30 days. **Hobby is non-commercial, personal use only.** | https://vercel.com/docs/plans/hobby |
| Runtime logs on Hobby | **1 hour** retention, so job history must be persisted to the DB (`job_runs`). | https://vercel.com/docs/limits |

**Decision:** use **two Vercel Cron jobs**. Hobby allows 100 per project, each once a day, so there is no need to merge mark and report into one job. Add **GitHub Actions `schedule` as a backup trigger** that calls the same protected endpoints. The endpoints no-op if the run is already complete.
- Why GitHub Actions for the backup and not cron-job.org: Actions is free for public repos on standard runners (VERIFIED https://docs.github.com/en/billing/concepts/product-billing/github-actions). It lives in the repo and is versioned. The secret is stored as a repo secret. The caveats are VERIFIED at https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows: schedules can be **delayed at high load, especially at the top of the hour, and jobs may be dropped**; **in a public repo, scheduled workflows auto-disable after 60 days without repo activity**; the minimum interval is 5 minutes. cron-job.org's limits were not researched, so they are UNVERIFIED.

`web/vercel.json` goes in `web/` because the Next app root is `web/`. That the Vercel Root Directory is `web` is UNVERIFIED; confirm it in the dashboard.
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/cron/premarket-report", "schedule": "0 1 * * 1-5" },
    { "path": "/api/cron/eod-mark",         "schedule": "0 11 * * 1-5" }
  ]
}
```
| Job | UTC cron | Fires (IST) | Does |
|---|---|---|---|
| `premarket-report` | `0 1 * * 1-5` | **06:30–07:29 IST** Mon–Fri | Finalize marks for the last session, score due forecast points, build and store `report:<for_session>` |
| `eod-mark` | `0 11 * * 1-5` | **16:30–17:29 IST** Mon–Fri | Provisional EOD marks for open positions and due points (evening P&L). No scoring. |
| GHA backup (report) | `17 2 * * 1-5` | 07:47 IST (plus GitHub delay) | Same endpoint with `?source=gha&finalize_if_partial=1` |
| GHA backup (mark) | `37 12 * * 1-5` | 18:07 IST | Same endpoint with `?source=gha` |

`.github/workflows/cron-backup.yml` (the secret is read from GitHub repo secrets at runtime):
```yaml
name: cron-backup
on:
  schedule:
    - cron: "17 2 * * 1-5"    # 07:47 IST
    - cron: "37 12 * * 1-5"   # 18:07 IST
  workflow_dispatch:
    inputs: { job: { type: choice, options: [premarket-report, eod-mark], default: premarket-report } }
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: |
          JOB="${{ inputs.job }}"
          if [ -z "$JOB" ]; then
            if [ "${{ github.event.schedule }}" = "37 12 * * 1-5" ]; then JOB=eod-mark; else JOB=premarket-report; fi
          fi
          curl -fsS -m 295 -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            "https://nse-stock-lab.vercel.app/api/cron/$JOB?source=gha&finalize_if_partial=1"
```

### 2.3 Fitting the scan inside 300 s (and inside 60 s if Fluid is off)
- Universe = `BUDGET_UNIVERSE ∪ SCREEN_UNIVERSE` = **59 symbols**. Add the index symbols `^NSEI, ^BSESN, ^NSEBANK, ^INDIAVIX, ^GSPC, ^IXIC`, all VERIFIED to return data on Yahoo v8.
- Measured from our box (not from Vercel iad1, so the Vercel number is UNVERIFIED): Yahoo chart 1y ≈ **0.26–0.30 s**, screener.in page ≈ **2.2 s**.
- **Pass 1** (all 59): Yahoo chart plus funda, with `news:false`. **Pass 2**: news only for the ≤ 20 shortlisted names (Top 10 candidates, avoid candidates, pennies). Estimated wall time at concurrency 5 is about 59 × ~3 s / 5 ≈ **36 s**, plus about 8 s for news, plus about 2 s for indices and DB, so **~50 s**. That gives more than 5× headroom under 300 s but is **near the 60 s legacy cap**. First check in Vercel → Settings → Functions that Fluid compute is ON. If it is not, the chunking below makes the job correct anyway.
- Controls (put them in `web/src/lib/jobs/runner.ts`):
  - `mapPool(concurrency = 5)`; the existing `mapPool` lives in `live.ts`, so export it and reuse it.
  - Jitter: `await sleep(100 + rand(0..300) ms)` before each outbound request.
  - Retry on network error, 429, or 5xx: 2 retries with backoff 1 s then 3 s, each plus 0–500 ms jitter. **No retry on 404** (for example TATAMOTORS). Record `UNKNOWN: yahoo_404`.
  - Circuit breaker: if ≥ 6 of the first 20 Yahoo calls fail with 429, stop the scan and mark the run `partial`.
  - Deadline: `export const maxDuration = 300`. Keep an internal `deadline = start + 240 s` and stop scheduling new symbols at `start + 210 s` (or at `start + 45 s` if `process.env.FLUID_OFF === "1"`).
  - **Chunk and resume:** store per-symbol results and a cursor in `job_runs.cursor` (jsonb). A later call (the GHA backup, or a manual `?resume=1`) resumes from the cursor. When all symbols are done, insert the `reports` row with `status='complete'`. If `finalize_if_partial=1` and symbols are still missing, insert with `status='partial'` and list the missing symbols in `unknowns`. **Never fill them in.**
  - **Fallback:** if there is no report for today, `/api/report/latest` serves the last `complete|partial` report with `stale:true` (§2.6).
- Lock: `job_runs` lease row (see DDL in §3.3). A duplicate cron delivery hits the lease and returns `409 {locked:true}`. A completed run returns `200 {noop:true}`.
  ```sql
  insert into job_runs(job, session_date, status, lease_until) values ($1, $2, 'running', now() + interval '6 minutes')
  on conflict (job, session_date) do update
     set lease_until = excluded.lease_until, attempts = job_runs.attempts + 1, status = 'running'
   where job_runs.status not in ('complete','holiday_skip') and job_runs.lease_until < now()
  returning *;   -- 0 rows => complete (noop) or another run holds the lease (409)
  ```

### 2.4 Report content rules (deterministic, from existing functions)
Inputs are `runLookup(sym, {budget_inr: 10000, risk_pct: 1})` results from pass 1 and pass 2. Everything below is a pure function of those results.
| Section (v1 key) | Rule |
|---|---|
| `market_overview` | Prior close and % change for ^NSEI, ^BSESN, ^NSEBANK, ^INDIAVIX (from `chartPreviousClose` and the last settled bar). Breadth of **our universe**: count above DMA50, count with `structure=HH_HL`, and buy/hold/avoid counts. Global cues: ^GSPC and ^IXIC last close with "as of <US close date>". GIFT Nifty and FII/DII flows are `UNKNOWN (no free source wired)`. **Never estimate them.** |
| `top10_under_1000` | `action==="buy" && typeof cmp==="number" && cmp<1000 && !insufficient_data`, sorted by `diversifiedPickScore` and passed through `diversifyPicks(buys, 10000, 10)`. If fewer than 10 qualify, show N and add `note: "Only N names passed gates today"`. **Never pad.** |
| `deep_dive_top3` | The first 3 of the Top 10. Include tech (cmp, atr_14, rsi_14, dma20/50/200, structure, breakout_state, volume_vs_avg_20d), funda (pe, roe, d/e, funda_quality, source URL), news (headline, confirmation_status, pubDate, link), levels (entry, sl, T1, T2, r_r, R), `plain_why`, `risk_flags`, and a **paper scenario path preview** from `buildForecastBundle({checkDays:[7,14,30]})` labelled "Paper scenario path (ATR)". |
| `avoids5` | `action==="avoid" && !insufficient_data`, ordered by severity: `funda_quality=fail` > `news_bear_confirmed` > `breakdown` > below all DMAs + `LH_LL`. Keep 5. **Symbols with missing data are listed in `unknowns`, not as avoids.** A data failure is not a thesis. |
| `penny_under_50` | `cmp < 50`, any action. Always show the warning text (§2.8). Pennies never appear in the Top 10 (`pickScore −40` already applies). |
| `final_summary` | Counts (scanned, ok, unknown, buy, hold, avoid), the 3 deep-dive tickers, `changes_vs_prev` = `{top10_in:[], top10_out:[], avoids_in:[], avoids_out:[]}` against the previous stored report (the Screener pattern), and the SEBI banner. |

### 2.5 Snapshot for reproducibility (storage: Neon Postgres, same DB as Part 2)
- The key is `report:YYYY-MM-DD`, where the date is **`for_session`** (the session the report is published for). `based_on_close` is stored alongside it.
- Stored immutably in `reports` (DDL in §3.3). An insert-only trigger blocks later changes. It holds:
  - `body jsonb`: the `ReportV1` object below.
  - `inputs jsonb`: per symbol, the last settled bar, the computed `TechFields` (minus `closes_30d`), funda fields, and news items (title, pubDate, link, source). About 1 KB per symbol, so ~60 KB per day and **~15 MB per year**. That fits Neon's free 0.5 GB. `mergeVerdict` is a pure function of `tech`, `funda`, `news`, `budget` and `risk`, so any report can be recomputed from `inputs`. Raw 1-year bars are **not** stored because of size, so `computeTech` itself cannot be replayed. This is documented.
  - `inputs_hash = sha256(canonicalJSON({universe_sorted, inputs, budget_inr, risk_pct, method_version}))`. Canonical JSON means sorted keys and no whitespace, hashed with `node:crypto`.
  - `report_hash = sha256(canonicalJSON(body without report_hash))`. It doubles as the ETag.
  - `universe_version = "u" + N + "-" + sha256(sorted symbols).slice(0,12)`, for example `u59-…`.
  - `method_version = "report_v1|risk_v1|atr_piecewise_T1_T2_v1"`.
  - `lanes`: per lane, `{source, first_fetch_at, last_fetch_at, ok, failed}`.
  - `unknowns`: `[{ticker, lane, reason}]`.
- Why not Vercel Blob: the Hobby Blob free tier is 1 GB storage, 10,000 simple ops, and **2,000 advanced ops (put/list) per month**. Exceeding it means **no Blob access for 30 days** (VERIFIED https://vercel.com/docs/vercel-blob/usage-and-pricing). It would work (~22 puts per month), but it is a second store, gives no SQL for "changes vs previous", and adds a 30-day lockout risk. Keep one store.

`ReportV1` (`web/src/lib/reportTypes.ts`):
```ts
export interface ReportV1 {
  schema: "stock-lab.report.v1";
  key: string;                    // "report:2026-09-25"
  for_session: string;            // "2026-09-25" (IST trading day)
  based_on_close: string;         // "2026-09-24"
  label: string;                  // "Based on close of Thu 24 Sep 2026 · For session Fri 25 Sep 2026"
  generated_at: string;           // ISO UTC, server clock
  status: "complete" | "partial";
  method_version: string; universe_version: string;
  inputs_hash: string; report_hash: string;
  budget_inr: number; risk_pct: number;
  sebi_banner: string;            // === SEBI_BANNER
  data_notes: string[];           // e.g. "Prices are NSE closes via Yahoo; pre-open/indicative prices not used"
  calendar: { source: string; holiday_file: string; unverified?: boolean };
  lanes: Record<"tech"|"funda"|"news"|"index", { source: string; first_fetch_at: string; last_fetch_at: string; ok: number; failed: number }>;
  unknowns: { ticker: string; lane: "tech"|"funda"|"news"|"index"; reason: string }[];
  sections: {
    market_overview: {
      indices: { symbol: string; name: string; close: number|"UNKNOWN"; prev_close: number|"UNKNOWN"; chg_pct: number|"UNKNOWN"; bar_date: string|null }[];
      breadth: { scanned: number; above_dma50: number; hh_hl: number; buy: number; hold: number; avoid: number; unknown: number };
      global_cues: { symbol: string; close: number|"UNKNOWN"; chg_pct: number|"UNKNOWN"; as_of: string }[];
      not_available: string[];    // ["GIFT Nifty","FII/DII flows"]
    };
    top10_under_1000: { items: ReportPick[]; n_eligible: number; note?: string };
    deep_dive_top3:   { items: (ReportPick & { tech: object; funda: object; news: object; scenario_path: { dayOffset: number; predictedClose: number }[] })[] };
    avoids5:          { items: { ticker: string; sector: string|null; cmp: number; reason: string; flags: string[] }[] };
    penny_under_50:   { items: { ticker: string; cmp: number; action: string; note: string }[]; warning: string };
    final_summary:    { counts: Record<string, number>; top3: string[]; changes_vs_prev: { prev_key: string|null; top10_in: string[]; top10_out: string[]; avoids_in: string[]; avoids_out: string[] }; headline: string };
  };
}
export interface ReportPick {
  rank: number; ticker: string; sector: string|null; cmp: number; action: "buy";
  confidence_1_10: number; entry: number; sl: number; t1: number; t2: number|null; r_r: number|null;
  shares: number; size_inr: number; sizing_mode: string; plain_why: string; risk_flags: string[];
}
```
Update `web/src/app/report/page.tsx` to fetch `/api/report/latest` and render `ReportV1`. Fall back to the fixture only through an adapter that maps the array-shaped `daily_report.json`, which fixes the live bug.

### 2.6 Public endpoints
| Route | Response | Headers |
|---|---|---|
| `GET /api/report/latest` | `{ report: ReportV1, stale: boolean, age_hours: number, expected_session: string, holiday?: {date, name}, served_at: string }` | `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=3600` · `ETag: "<report_hash>"` · CORS |
| `GET /api/report/[date]` (`date` = for_session) | `{ report: ReportV1 }` with 200, or `{error:"not_found", nearest_prev: "YYYY-MM-DD"|null}` with 404 | 200 complete: `public, max-age=3600, s-maxage=31536000, immutable`. 200 partial: `s-maxage=300, stale-while-revalidate=3600`. 404: `s-maxage=60` |
| `GET /api/report/index?limit=30` | `{ items: [{key, for_session, based_on_close, status, report_hash}] }` | `s-maxage=300, stale-while-revalidate=3600` |
| `OPTIONS /api/report/*` | 204 | CORS |
- CORS: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, If-None-Match`. The data is public, read-only, and uses no cookies.
- Vercel consumes `s-maxage` and `stale-while-revalidate` at the CDN and strips them before the client sees them (VERIFIED https://vercel.com/docs/caching/cache-control-headers). A new report is visible within ≤ 5 minutes. That is acceptable because the next consumer need is 09:00 IST.
- **Stale rule** (computed at serve time and **never stored** in the immutable body):
  `expected_session = latest trading day D such that now_IST ≥ D 09:00 IST`.
  `stale = report.for_session < expected_session`.
  `age_hours = round1((now − generated_at) / 3600 s)`.
  On a holiday or weekend, `expected_session` is the last trading day, so the report is not stale, and the response adds `holiday: {date, name}`.
- Service worker (`web/public/sw.js`): add `/api/report/latest` as network-first with a cached fallback. When offline, show a banner: "Offline, showing cached report for <for_session>".

### 2.7 NSE holiday calendar
- NSE's JSON endpoint `https://www.nseindia.com/api/holiday-master?type=trading` returned **403 Access Denied (Akamai)** from our box. So did the `nsearchives` PDF. Treat NSE as **bot-blocked**. It is UNVERIFIED whether Vercel IPs are also blocked, but assume they are.
- **Decision:** check in `web/src/data/nse-holidays-2026.json`, and add `web/src/lib/marketCalendar.ts` with `isTradingDay`, `prevTradingDay`, `nextTradingDay`, `expectedReportSession(now)`, plus weekend logic (Sat/Sun closed). Special sessions such as Muhurat are **excluded** from `based_on_close` and marks. If a year file is missing (for example 2027 before NSE publishes it in December), treat weekdays as trading days, set `calendar.unverified: true` in the report, and log a warning.
- On a holiday: `premarket-report` skips generation and writes `job_runs.status='holiday_skip'` and an audit row. `/api/report/latest` keeps serving the last report with the holiday note. `eod-mark` exits with `holiday_skip`.

`web/src/data/nse-holidays-2026.json` (dates VERIFIED from NSE circular NSE/CMTR/71775, Ref 172/2025, dated 2025-12-12, via the broker-hosted copy https://www.bajajbroking.in/content/dam/bfsl/bajaj-broking-pdf/NSE_Trading_Holiday_2026.pdf; the original is https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf, which returned 403 to us but has the same content in the search index):
```json
{
  "year": 2026,
  "segment": "CM",
  "source": {
    "circular": "NSE/CMTR/71775 (Circular Ref 172/2025) dated 2025-12-12",
    "url": "https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf",
    "verified_copy": "https://www.bajajbroking.in/content/dam/bfsl/bajaj-broking-pdf/NSE_Trading_Holiday_2026.pdf",
    "verified_on": "2026-09-25"
  },
  "holidays": [
    { "date": "2026-01-15", "name": "Municipal Corporation Election, Maharashtra", "note": "Added by NSE partial-modification circular (Jan 2026); reported by News18 2026-01-12; official circular not fetched" },
    { "date": "2026-01-26", "name": "Republic Day" },
    { "date": "2026-03-03", "name": "Holi" },
    { "date": "2026-03-26", "name": "Shri Ram Navami" },
    { "date": "2026-03-31", "name": "Shri Mahavir Jayanti" },
    { "date": "2026-04-03", "name": "Good Friday" },
    { "date": "2026-04-14", "name": "Dr. Baba Saheb Ambedkar Jayanti" },
    { "date": "2026-05-01", "name": "Maharashtra Day" },
    { "date": "2026-05-28", "name": "Bakri Id" },
    { "date": "2026-06-26", "name": "Muharram" },
    { "date": "2026-09-14", "name": "Ganesh Chaturthi" },
    { "date": "2026-10-02", "name": "Mahatma Gandhi Jayanti" },
    { "date": "2026-10-20", "name": "Dussehra" },
    { "date": "2026-11-10", "name": "Diwali-Balipratipada" },
    { "date": "2026-11-24", "name": "Prakash Gurpurb Sri Guru Nanak Dev" },
    { "date": "2026-12-25", "name": "Christmas" }
  ],
  "weekend_holidays": [
    { "date": "2026-02-15", "name": "Mahashivratri" },
    { "date": "2026-03-21", "name": "Id-Ul-Fitr (Ramadan Eid)" },
    { "date": "2026-08-15", "name": "Independence Day" },
    { "date": "2026-11-08", "name": "Diwali Laxmi Pujan" }
  ],
  "special_sessions": [
    { "date": "2026-11-08", "name": "Muhurat Trading", "timings": "TODO: NSE to notify via circular", "use_for_marks": false }
  ]
}
```
Source for the 2026-01-15 addition: https://www.news18.com/business/markets/stock-market-holiday-2026-nse-bse-closed-on-january-15-for-maharashtra-civic-polls-9825837.html
Upcoming holidays that affect the jobs: **2026-10-02 (Fri), 2026-10-20 (Tue), 2026-11-10 (Tue), 2026-11-24 (Tue), 2026-12-25 (Fri)**.

### 2.8 Stale-data labels and SEBI wording
- Header on `/report`, always: `Pre-market research digest · Based on close of {based_on_close:ddd DD MMM YYYY} (NSE, via Yahoo) · Generated {generated_at → HH:MM IST}`. The second line is `SEBI_BANNER`.
- `stale:true` → amber bar: `This is the {for_session} report ({age_hours} h old). Today's report has not been generated yet. Prices are older than the last session.`
- `status:"partial"` → `Partial: {n} of {N} symbols could not be fetched and are listed as UNKNOWN. Nothing was estimated.`
- Holiday → `NSE closed today ({name}). Showing the last report.`
- Pre-open line: `Pre-open / indicative prices are not used. Levels are from the prior close.`
- Penny warning: `Under ₹50: low price, often low liquidity and high volatility. Shown for awareness, not ranked.`
- Section titles: "Top 10 paper setups under ₹1000", "Deep dive: top 3 paper setups", "5 names our gates skip", "Under ₹50 (awareness only)".
- Banned words anywhere in the report or API: recommendation, tip, advice, target price, guaranteed, sure-shot, "will hit", expected return, "accuracy proves". Use: "ATR level T1/T2", "paper setup", "research", "scenario path". Add a unit test that greps the rendered JSON strings for the banned list.

### 2.9 Yahoo usage guidance (the rate limits are undocumented)
- No official quota exists, so all of the following is empirical practice, not a limit.
- Make one chart call per symbol per job and reuse it: the tech lane (1y) and the marks lane share the response. Within a run, cache it in a `Map<yahoo_symbol, Response>`. Across runs, the `marks` table is the per-symbol, per-day cache: skip re-fetching symbols whose `(symbol, session_date)` is already `final`.
- Throttling, retries and the breaker: see §2.3 (concurrency 5, 100–400 ms jitter, 2 retries on 429/5xx, stop on a 429 burst).
- `quoteSummary` needs crumb/cookie (`ensureCrumb`). The report does not need it, because funda comes from screener.in, so avoid it in the cron.
- For marks, parse `indicators.adjclose`, which was VERIFIED present in the v8 response, and store it next to raw `close`. Scoring stays on raw close in v1, as the 2026-09-22 brief decided, but add the flag `adj_ratio_jump` if `adjclose/close` changes by more than 2% between consecutive bars. That is a split or dividend signal that is independent of the >15% gap rule.
- On failure, record `UNKNOWN` with a reason (`yahoo_404`, `yahoo_429`, `timeout`, `short_history`). **Never invent or carry forward a price as if it were today's.**

### 2.10 Acceptance tests (Part 1)
1. `marketCalendar`: `isTradingDay("2026-10-02") === false`, `isTradingDay("2026-09-26") === false` (Saturday), `prevTradingDay("2026-10-05") === "2026-10-01"`, and `expectedReportSession(2026-10-02 10:00 IST) === "2026-10-01"`.
2. Cron auth: a request without the bearer header gets 401. With it, the response is 200 or 202.
3. Idempotency: two back-to-back calls produce one `reports` row. The second returns `{noop:true}` (complete) or `409 {locked:true}` (running).
4. Holiday: calling `premarket-report` with the clock at 2026-10-02 06:45 IST inserts no report and writes `job_runs.status='holiday_skip'`. `/api/report/latest` returns the 2026-10-01 report with `holiday.name="Mahatma Gandhi Jayanti"` and `stale:false`.
5. Freshness: every `inputs` bar date ≤ `based_on_close`, and there is no bar dated `for_session`.
6. The partial path: mock Yahoo so 10 symbols fail with 429. The result is `status:"partial"`, the 10 symbols are in `unknowns`, and none of them appear in any section.
7. Deadline: mock 5 s per symbol. The run stops scheduling at 210 s, saves the cursor, and returns 202. A resume call completes the run.
8. Determinism: recompute from stored `inputs` and get the same `report_hash`.
9. Stale: with the latest report at `for_session=2026-09-24` and the clock at 2026-09-25 09:30 IST, the response has `stale:true` and `age_hours > 0`.
10. Headers: `/api/report/latest` returns `Access-Control-Allow-Origin: *` and an ETag. `/api/report/2026-09-25` (complete) is served with `immutable`.
11. Banned-words test passes, and `SEBI_BANNER` is present in the JSON and the page.
12. `/report` renders non-empty sections. This is a regression check for the live "No items" bug.
13. `top10_under_1000.items.length ≤ 10`, every item has `cmp < 1000`, and no penny appears in the Top 10.

---

## 3) Part 2: Server-side paper portfolio plus accuracy tracking

### 3.1 Free DB choice: **Neon Postgres** (VERIFIED tiers)
| Option | Free tier (VERIFIED) | Verdict |
|---|---|---|
| **Neon** (https://neon.com/pricing, https://neon.com/docs/introduction/plans.md) | Permanent free plan with no card. **0.5 GB storage per project**, **100 CU-hours per project per month** ("enough to run a 0.25 CU compute… 400 hours/month"), **5 GB egress**, 10 branches, 6-hour history window. **Scale-to-zero after 5 min, which cannot be disabled on Free.** It "reactivates … within a few hundred milliseconds" (https://neon.com/docs/introduction/scale-to-zero). Running out of CU-hours or egress suspends compute until the next period. Going over 0.5 GB blocks writes, and no data is deleted. Vercel Postgres **no longer exists**: it moved to Neon in Dec 2024, and new projects use the Marketplace (https://vercel.com/docs/postgres). A Neon native integration is available (https://neon.com/docs/guides/vercel-overview). | **Pick.** Relational, SQL for scoring, triggers for immutability, native Vercel integration, and an HTTP driver built for serverless. Cold start is a few hundred ms, with no multi-day pause. |
| Supabase (https://supabase.com/pricing) | Free: 500 MB DB, 5 GB egress, 2 active projects, and **"Free projects are paused after 1 week of inactivity"**. | Workable, and the daily cron would keep it active, but a missed week (GHA disabled plus Vercel issues) pauses the DB and breaks the report. No advantage over Neon for this use. |
| Upstash Redis (https://upstash.com/pricing/redis) | Free: **256 MB, 500K commands per month**, 10 GB bandwidth, 1 database. | Key-value only, with no SQL joins or triggers. Scoring rollups would be hand-coded. Reject as the primary store. |

Client: **`@neondatabase/serverless`** (https://neon.com/docs/serverless/serverless-driver). Use `neon(DATABASE_URL)` over HTTP for one-shot queries and `sql.transaction([...])` for atomic multi-statement writes (for example position + forecast + points + audit). v1.0+ requires **Node ≥ 19**; which Node version the Vercel project runs is UNVERIFIED, so check it (20 or 22 is fine). **Raw SQL, no ORM, in v1.** Migrations are plain files `web/db/migrations/0001_init.sql` applied with the Neon SQL editor or `psql`. The exact env var names the integration injects are UNVERIFIED; normalize to `DATABASE_URL` in `web/src/lib/db.ts`. Add drizzle later only if the schema churns.

Capacity check: at about 60 KB per report per day (~15 MB/yr), plus marks at 59 symbols × ~250 sessions × ~100 B (~1.5 MB/yr), plus a few thousand positions and points, storage is far below 0.5 GB for years. The CDN caches `/api/report/*` (`s-maxage`), so most reads never reach Neon. That protects the 100 CU-hours and 5 GB egress.

### 3.2 Identity without full login
| Option | Pros | Cons | v1? |
|---|---|---|---|
| Anonymous device id: UUID in localStorage plus an httpOnly cookie holding a secret | Zero friction and no PII | Lost if storage is cleared, and single device | **Yes** |
| Recovery / share code (human-readable) | Restore on another device without PII | The user must save it. Needs brute-force limits. | **Yes** (issued with the device) |
| Magic link (email) | Real account and multi-device | Needs an email provider and stores PII. Resend Free is **3,000 emails/mo, 100/day** (VERIFIED https://resend.com/pricing); its domain-verification requirement is UNVERIFIED. | Later (v2) |

v1 flow:
1. First load, when localStorage `nse-stock-lab-device-v1` is missing: `POST /api/identity/device`. The server creates a `users` row and a `devices` row, generates `device_secret` (32 random bytes, base64url) and stores `sha256(secret)`. It sets the cookie `sl_dev=<device_id>.<secret>` with `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000` (400 days; the browser cookie-lifetime cap is UNVERIFIED). It returns `{device_id, recovery_code}` **once**.
2. The client stores `{device_id, created_at, recovery_ack:false}` in `nse-stock-lab-device-v1`. **The secret never goes to JS.** The UI shows the recovery code with "Save this to restore your paper portfolio on another device".
3. Recovery code: 12 Crockford-base32 chars (60 bits), shown as `K7QF-9MZ2-XH4D`. Store `HMAC-SHA256(RECOVERY_PEPPER, normalize(code))`, where normalize means uppercase, strip dashes, and map O→0 and I/L→1. `POST /api/identity/recover {code}` attaches a new device to the same user and sets the cookie. Rate limit: **5 per hour per ip_hash** and 50 per hour globally. `POST /api/identity/rotate-recovery` issues a new code and invalidates the old one.
4. Per-request auth, `getDevice(req)` in `web/src/lib/identity.ts`: parse the cookie, look up the device, `timingSafeEqual(sha256(secret), secret_hash)`, and require `revoked_at IS NULL`. The result is `user_id`.

### 3.3 SQL DDL: `web/db/migrations/0001_init.sql`
```sql
create extension if not exists pgcrypto;            -- gen_random_uuid(), digest()

create table users (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  recovery_hmac    text unique,                     -- HMAC(RECOVERY_PEPPER, code); null after purge
  recovery_rotated_at timestamptz,
  email            text unique,                     -- v2 magic link only; null in v1
  deleted_at       timestamptz
);

create table devices (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  secret_hash      bytea not null,                  -- sha256(device_secret)
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  revoked_at       timestamptz,
  ua_family        text                             -- coarse ("Chrome/Android"); no full UA
);
create index devices_user_idx on devices(user_id);

create table portfolios (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  name             text not null default 'Paper',
  starting_cash_inr numeric(14,2) not null default 100000,
  created_at       timestamptz not null default now(),
  archived_at      timestamptz                      -- "reset" = archive + create new; never delete
);
create unique index portfolios_one_active on portfolios(user_id) where archived_at is null;

-- Paper fills. Immutable. Closing = position_events row.
create table positions (
  id               uuid primary key default gen_random_uuid(),
  portfolio_id     uuid not null references portfolios(id) on delete cascade,
  user_id          uuid not null references users(id) on delete cascade,
  idempotency_key  text not null,                   -- client UUID, or 'mig:<old pf_ id>'
  ticker           text not null,                   -- 'TMPV'
  yahoo_symbol     text not null,                   -- 'TMPV.NS'
  side             text not null default 'long' check (side in ('long')),
  qty              integer not null check (qty > 0),
  entry_price      numeric(12,4) not null check (entry_price > 0),
  sl               numeric(12,4), t1 numeric(12,4), t2 numeric(12,4),
  filled_at        timestamptz not null default now(), -- SERVER clock
  fill_session_date date not null,                   -- IST trading day of the fill price
  fill_basis       text not null check (fill_basis in ('ltp_intraday','last_close','client_migrated')),
  provenance       text not null check (provenance in ('server','client_migrated')),
  client_filled_at timestamptz,                      -- informational only (migrated boughtAt)
  verdict_snapshot jsonb,                            -- mergeVerdict output at buy (server) / as sent (migrated)
  created_at       timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index positions_portfolio_idx on positions(portfolio_id);
create index positions_symbol_idx on positions(yahoo_symbol);

create table position_events (
  id               bigserial primary key,
  position_id      uuid not null references positions(id) on delete cascade,
  type             text not null check (type in ('close','touch_sl','touch_t1','touch_t2','note')),
  price            numeric(12,4),
  session_date     date,
  reason           text,                            -- 'user','sl_hit_manual', ...
  idempotency_key  text,
  created_at       timestamptz not null default now()
);
create unique index position_one_close on position_events(position_id) where type = 'close';
create unique index position_touch_once on position_events(position_id, type) where type like 'touch_%';
create unique index position_events_idem on position_events(position_id, idempotency_key) where idempotency_key is not null;

-- Forecast bundle frozen at buy (method atr_piecewise_T1_T2_v1 from the 2026-09-22 brief).
create table forecasts (
  id               uuid primary key default gen_random_uuid(),
  position_id      uuid not null unique references positions(id) on delete cascade,
  user_id          uuid not null references users(id) on delete cascade,
  yahoo_symbol     text not null,
  method_version   text not null,                   -- 'atr_piecewise_T1_T2_v1'
  params           jsonb not null,                  -- {entry, atr, atrPct, t1, t2, sl, t1Days, t2Days, checkDays, fillDate}
  bundle_hash      text not null,                   -- sha256(canonicalJSON({method_version, params, points}))
  provenance       text not null check (provenance in ('server_frozen','client_created')),
  client_consistent boolean,                        -- migrated: does recompute(params) == client points (±0.01)?
  created_at       timestamptz not null default now()  -- SERVER clock
);
create index forecasts_symbol_idx on forecasts(yahoo_symbol);

create table forecast_points (
  forecast_id      uuid not null references forecasts(id) on delete cascade,
  day_offset       integer not null check (day_offset > 0),   -- trading days after fill
  target_date      date not null,                   -- nextTradingDay^day_offset(fill_session_date) via marketCalendar
  predicted_close  numeric(12,4) not null,
  primary key (forecast_id, day_offset)
);
create index forecast_points_due_idx on forecast_points(target_date);

-- Actuals in a separate insert-only table ("pending" = no row). Keeps predicted rows strictly immutable.
create table forecast_actuals (
  forecast_id      uuid not null,
  day_offset       integer not null,
  status           text not null check (status in ('scored','sparse','split_flag','unknown')),
  actual_session_date date,                         -- may be > target_date (holiday roll, ≤ +3 cal days)
  actual_close     numeric(12,4),
  abs_pct_err      numeric(10,6),                   -- |actual - predicted| / actual
  hit_band         boolean,                         -- abs err ≤ max(1%, ATR%)
  hit_2pct         boolean,
  dir_correct      boolean,                         -- sign(predicted - entry) == sign(actual - entry); null if predicted==entry
  filled_at        timestamptz not null default now(),
  primary key (forecast_id, day_offset),
  foreign key (forecast_id, day_offset) references forecast_points(forecast_id, day_offset) on delete cascade
);

-- Daily close per symbol per session, shared by all users.
create table marks (
  yahoo_symbol     text not null,
  session_date     date not null,
  open numeric(12,4), high numeric(12,4), low numeric(12,4),
  close            numeric(12,4) not null,
  adjclose         numeric(12,4),
  volume           bigint,
  state            text not null check (state in ('provisional','final')),
  flags            text[] not null default '{}',    -- 'gap_gt_15pct','adj_ratio_jump'
  source           text not null default 'yahoo_v8_chart_1d',
  fetched_at       timestamptz not null default now(),
  finalized_at     timestamptz,
  primary key (yahoo_symbol, session_date)          -- idempotent upsert key
);
create index marks_session_idx on marks(session_date);

-- Derived; truncate + rebuild any time.
create table score_summary (
  scope            text not null,                   -- 'global' | 'user:<uuid>'
  method_version   text not null,
  bucket           text not null,                   -- 'all','le7','8to21','ge22'
  n                integer not null,
  mape_pct         numeric(10,4),
  hit_band_pct     numeric(10,4),
  hit_2pct_pct     numeric(10,4),
  directional_pct  numeric(10,4),
  n_sparse         integer not null default 0,
  n_split_flag     integer not null default 0,
  computed_at      timestamptz not null default now(),
  primary key (scope, method_version, bucket)
);

create table audit_log (
  id               bigserial primary key,
  at               timestamptz not null default now(),
  actor            text not null,                   -- 'device:<uuid>' | 'cron:premarket-report' | 'system'
  user_id          uuid,                            -- no FK: survives purge as null
  action           text not null,                   -- 'position.create','position.close','forecast.freeze','mark.revised','report.publish','user.purge',...
  entity           text, entity_id text,
  detail           jsonb,
  hash             text                             -- sha256 of entity payload where relevant
);
create index audit_user_idx on audit_log(user_id, at);

create table reports (
  key              text primary key,                -- 'report:2026-09-25'
  for_session      date not null unique,
  based_on_close   date not null,
  status           text not null check (status in ('complete','partial')),
  body             jsonb not null,                  -- ReportV1
  inputs           jsonb not null,
  inputs_hash      text not null,
  report_hash      text not null,
  universe_version text not null,
  method_version   text not null,
  lanes            jsonb not null,
  unknowns         jsonb not null default '[]',
  generated_at     timestamptz not null default now()
);

create table job_runs (
  job              text not null,                   -- 'premarket-report' | 'eod-mark'
  session_date     date not null,
  status           text not null check (status in ('running','partial','complete','failed','holiday_skip')),
  attempts         integer not null default 1,
  lease_until      timestamptz,
  cursor           jsonb,                           -- {done:[symbols], results_ref, phase}
  trigger_source   text,                            -- 'vercel-cron' | 'gha' | 'manual'
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  error            text,
  primary key (job, session_date)
);

create table rate_limits (
  bucket_key       text not null,                   -- 'buy:<user>' | 'recover:<ip_hash>' ...
  window_start     timestamptz not null,
  count            integer not null default 0,
  primary key (bucket_key, window_start)
);
```

`web/db/migrations/0002_immutability.sql`:
```sql
create or replace function reject_mutation() returns trigger language plpgsql as $$
begin
  if current_setting('app.allow_purge', true) = 'on' and tg_op = 'DELETE' then
    return old;                                     -- only purge_user() sets this, inside its txn
  end if;
  raise exception 'immutable table %: % not allowed', tg_table_name, tg_op;
end $$;

create trigger positions_immutable        before update or delete on positions        for each row execute function reject_mutation();
create trigger position_events_immutable  before update or delete on position_events  for each row execute function reject_mutation();
create trigger forecasts_immutable        before update or delete on forecasts        for each row execute function reject_mutation();
create trigger forecast_points_immutable  before update or delete on forecast_points  for each row execute function reject_mutation();
create trigger forecast_actuals_immutable before update or delete on forecast_actuals for each row execute function reject_mutation();
create trigger audit_log_immutable        before update or delete on audit_log        for each row execute function reject_mutation();
create trigger reports_immutable          before update or delete on reports          for each row execute function reject_mutation();

-- marks: provisional -> final exactly once; final rows frozen.
create or replace function marks_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'marks are append/finalize only'; end if;
  if old.state = 'final' then raise exception 'final mark %/% is immutable', old.yahoo_symbol, old.session_date; end if;
  return new;
end $$;
create trigger marks_guard_trg before update or delete on marks for each row execute function marks_guard();

-- Purge (user-initiated delete). Positions cascade to events/forecasts/points/actuals.
create or replace function purge_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('app.allow_purge', 'on', true);  -- txn-local
  delete from positions where user_id = p_user;
  delete from portfolios where user_id = p_user;
  delete from devices where user_id = p_user;
  delete from score_summary where scope = 'user:' || p_user::text;
  update users set recovery_hmac = null, email = null, deleted_at = now() where id = p_user;
  insert into audit_log(actor, user_id, action, entity, entity_id) values ('system', null, 'user.purge', 'user', p_user::text);
end $$;
```
Note: `on delete cascade` from positions fires the child triggers. The `app.allow_purge` GUC makes those deletes pass inside `purge_user` only. `audit_log` keeps no user_id for purged users, and old rows referencing the user stay as history. If full erasure is required, also null `audit_log.user_id` through a narrowly scoped exception; decide that in the privacy review.

**Immutability rules**
- Forecast rows and points are insert-only, and actuals are insert-once. `bundle_hash` is computed by the server at freeze time.
- `created_at` and `filled_at` come from the DB clock (`now()`), never from the client.
- Every row records `method_version`. A method change means a new version string, and old rows are never re-scored under the new method.
- Closing a position is a `position_events(type='close')` row. The partial unique index allows only one close.
- A portfolio "reset" archives the old portfolio and creates a new one.

### 3.4 Server-frozen buy: `POST /api/paper/positions`
Request: `{ idempotency_key, ticker, qty?, budget_inr?, client_entry?, checkDays?: number[] }`
1. Authenticate the device and apply the rate limit (buy: 10/min and 30/day per user).
2. `runLookup(ticker, {budget_inr, risk_pct})` on the **server**, with the partial-bar fix from §0.5 applied.
3. Price basis:
   - During session (09:15–15:30 IST on a trading day): entry = latest Yahoo price, `fill_basis='ltp_intraday'`, `fill_session_date` = today.
   - Otherwise: entry = last **settled** close, `fill_basis='last_close'`, `fill_session_date` = that session.
   - Scoring treats `fill_session_date` as day 0.
4. If `client_entry` is present and `|client_entry − server_entry| / server_entry > max(1%, 0.5 × ATR%)`, return **409 `{error:"quote_moved", server_entry}`**. The client re-confirms. The client price is never used.
5. Build the bundle on the server with `buildForecastBundle` (method `atr_piecewise_T1_T2_v1`, parameters and formulas exactly as in `docs/cos-paper-forecast-accuracy-brief-2026-09-22.md`; default checkDays `[1,3,5,7,10,14,21,30,45,60]` capped at the brief's max). Compute `target_date` for each point from `marketCalendar.nextTradingDay` applied `day_offset` times from `fill_session_date`. This replaces the old index into the 3-month array.
6. In one `sql.transaction`: insert the position (on idempotency-key conflict, return the existing row with 200), the forecast (`provenance='server_frozen'`), the points, and an `audit_log` row `position.create` with `hash = bundle_hash`.
7. Response: `201 {position, forecast:{id, bundle_hash, points}}`.

### 3.5 Daily mark job (the `eod-mark` provisional pass and the finalize step inside `premarket-report`)
Timing: when Yahoo finalizes an NSE daily bar is **UNVERIFIED**. We saw today's bar present and moving during market hours, meaning the partial bar is VERIFIED. The design therefore does not rely on 16:00 IST:
- **16:30–17:29 IST `eod-mark`**: writes `state='provisional'` marks only if `now ≥ meta.currentTradingPeriod.regular.end + 30 min`. That is intended for evening P&L display, labelled "Provisional close".
- **06:30–07:29 IST next day, inside `premarket-report`**: re-fetches and writes `state='final'` for the prior session. **Only final marks are used for scoring.** If the final close differs from the provisional close by more than 0.1%, write audit `mark.revised` with both values.

Algorithm (`web/src/lib/jobs/mark.ts`):
```
S = session to mark (prevTradingDay for finalize; today for provisional); skip if !isTradingDay(S)
symbols = distinct yahoo_symbol from positions p
            where not exists(close event for p)            -- open positions
          ∪ distinct f.yahoo_symbol from forecast_points fp join forecasts f
            where fp.target_date <= S and no forecast_actuals row   -- due points
          ∪ report universe (finalize run only; shared fetch)
range = '3mo', or '1y' if any due point target_date < S - 80 days
for each symbol (pool 5, jitter, retry — §2.3), ONE fetch:
   bars = settled bars only (drop bar dated today if session not ended+30m)
   upsert marks for every bar in range where session_date <= S:
     insert ... on conflict (yahoo_symbol, session_date) do update
       set close=excluded.close, ..., state=excluded.state, finalized_at=...
       where marks.state = 'provisional'           -- final rows untouched (trigger backs this)
   flags: gap_gt_15pct if |close_t/close_{t-1} - 1| > 0.15 ; adj_ratio_jump if (adjclose/close) moves > 2% day-over-day
   on failure: audit 'mark.unknown' {symbol, reason}; no mark row
score (finalize only), for each due point with no actuals row:
   m = first FINAL mark for symbol with session_date in [target_date, target_date + 3 calendar days]
   if m is null and S >= target_date + 3 days  -> insert actual status='sparse' (no values)
   elif m is null                              -> leave pending
   elif any mark between fill_session_date and m.session_date has gap_gt_15pct or adj_ratio_jump
                                               -> insert status='split_flag' with actual_close (excluded from stats)
   else insert status='scored':
        abs_pct_err = |A - P| / A ; hit_band = abs_pct_err <= max(0.01, atrPct) ; hit_2pct = abs_pct_err <= 0.02
        dir_correct = sign(P - entry) = sign(A - entry)   (null if P = entry)
   insert ... on conflict (forecast_id, day_offset) do nothing     -- idempotent
touch events (finalize): for open positions, using FINAL marks with session_date > fill_session_date only
   (fixes the pre-fill touch bug), low <= sl -> touch_sl ; high >= t1 -> touch_t1 ; high >= t2 -> touch_t2
   insert position_events on conflict do nothing. Never auto-close (user decides; UI shows "SL touched on <date>").
recompute score_summary (§3.6); job_runs.status='complete'
```

### 3.6 Scoring SQL (verified rows only)
```sql
begin;
delete from score_summary;               -- derived table; not immutable
insert into score_summary(scope, method_version, bucket, n, mape_pct, hit_band_pct, hit_2pct_pct, directional_pct, n_sparse, n_split_flag)
select coalesce(s.scope,'global'), s.method_version, coalesce(s.bucket,'all'),
       count(*) filter (where s.status='scored'),
       round(100*avg(s.abs_pct_err) filter (where s.status='scored'), 4),
       round(100*avg(s.hit_band::int) filter (where s.status='scored'), 4),
       round(100*avg(s.hit_2pct::int) filter (where s.status='scored'), 4),
       round(100*avg(s.dir_correct::int) filter (where s.status='scored' and s.dir_correct is not null), 4),
       count(*) filter (where s.status='sparse'),
       count(*) filter (where s.status='split_flag')
from (
  select 'global'::text as scope, f.method_version, a.*,
         case when a.day_offset <= 7 then 'le7' when a.day_offset <= 21 then '8to21' else 'ge22' end as bucket
  from forecast_actuals a join forecasts f on f.id = a.forecast_id
  where f.provenance = 'server_frozen'
) s
group by s.method_version, rollup(s.bucket), s.scope;
commit;
```
Per-user scope: use the same query with `'user:' || f.user_id` as scope, grouped by `user_id`. Client-created forecasts get a **separate** scope `global_unverified`, shown only when the user expands it and never mixed into the headline numbers. Buckets and metric definitions are unchanged from the 2026-09-22 brief (MAPE, hit within max(1%, ATR%), hit within 2%, directional; buckets le7 / 8to21 / ge22).

### 3.7 Migration from localStorage
Current keys (from §0.3): `nse-stock-lab-paper-forecasts-v1` holds `PaperForecastPosition[]`, and `stock-lab.budget_inr` holds a number string.
1. On app load, if `nse-stock-lab-device-v1` is absent, create the device (§3.2). Then, if `nse-stock-lab-paper-forecasts-v1` has entries and `nse-stock-lab-migrated-v1` is absent, call `POST /api/paper/migrate` in batches of ≤ 50:
   `{ items: [{ idempotency_key: "mig:" + p.id, ticker, qty, entry: p.forecast.entry ?? p.entry, boughtAt: p.boughtAt, forecast: p.forecast }] }`
2. For each item, the server:
   - Validates the shape. It rejects items with a non-positive price or qty, or `boughtAt` in the future (> now + 5 min).
   - Inserts `positions(provenance='client_migrated', fill_basis='client_migrated', client_filled_at=boughtAt, filled_at=now(), fill_session_date = the trading day ≤ boughtAt in IST)`.
   - Inserts `forecasts(provenance='client_created', client_consistent = (recompute(params) matches points within ±0.01))`.
   - Inserts points using the client's `predictedClose` (unverified). **Any client `actualClose` values are ignored**; actuals always come from `marks`.
   - Writes audit `position.migrate`.
   - Idempotency: `unique(user_id, idempotency_key)`, so re-posting after a crash is safe.
3. Response: `{imported, duplicates, rejected:[{key, reason}]}`. The client sets `nse-stock-lab-migrated-v1 = {at, imported, server_user_id}` and keeps the old key for 30 days as a read-only backup, then deletes it.
4. UI: migrated forecasts show the badge **"Pre-sync · unverified"** with the tooltip "Created on this device before server tracking; not frozen server-side; excluded from accuracy stats." Headline accuracy uses `server_frozen` only.
5. Offline buys after migration: queue them in `nse-stock-lab-outbox-v1` as `[{idempotency_key, ticker, qty, client_entry, queued_at}]` and flush on `online`. The server re-prices (§3.4), so a queued buy can return `quote_moved` and the user must confirm.
6. Deprecate `web/src/lib/paperServerStore.ts` (in-memory) and `POST /api/paper/mark-forecasts` (which trusts client bundles). They return `410 Gone {use:"/api/paper/scores"}` after migration ships.

### 3.8 API routes (all under `web/src/app/api/`)
| Route | Method | Auth | Purpose |
|---|---|---|---|
| `identity/device` | POST | none (IP rate-limited, 10/hr per ip_hash) | Create user and device, set cookie, return recovery code once |
| `identity/recover` | POST | none (5/hr per ip_hash) | Recovery code → new device cookie |
| `identity/rotate-recovery` | POST | device | New recovery code |
| `identity/me` | GET / DELETE | device | Info / **purge** (calls `purge_user`, clears cookie) |
| `paper/portfolio` | GET | device | Active portfolio, open and closed positions, latest marks, unrealized P&L (labelled provisional or final plus the mark date) |
| `paper/positions` | POST | device | Server-frozen buy (§3.4) |
| `paper/positions/[id]/close` | POST | device | `{idempotency_key}`. Close event at the latest price, using the same price basis rules as buy |
| `paper/forecasts/[id]` | GET | device | Bundle, points, actuals, provenance badge |
| `paper/scores` | GET | device (user scope) or public (`?scope=global`) | `score_summary` rows. Global uses `s-maxage=300, stale-while-revalidate=3600` |
| `paper/migrate` | POST | device (3/day) | §3.7 |
| `cron/premarket-report` | GET | `Bearer CRON_SECRET` | Finalize marks, score, build report (§2) |
| `cron/eod-mark` | GET | `Bearer CRON_SECRET` | Provisional marks |
| `report/latest`, `report/[date]`, `report/index` | GET | public | §2.6 |

All cron and DB routes set `export const runtime = "nodejs"` and `export const maxDuration = 300`, which Hobby allows under Fluid compute.

**Env vars** (Vercel project settings, all environments; never committed):
- `DATABASE_URL`: pooled Neon URL. The integration injects it, but the exact names it injects are UNVERIFIED, so map them in `db.ts`.
- `DATABASE_URL_UNPOOLED`: for migrations. The name is UNVERIFIED.
- `CRON_SECRET`: ≥ 32 random chars. Mirror it into the GitHub repo secret `CRON_SECRET`.
- `RECOVERY_PEPPER`: 32 bytes.
- `IP_HASH_SALT`: rotate monthly.
- `FLUID_OFF`: optional, `"1"` if the project turns out to be on legacy 60 s functions.
- v2: `RESEND_API_KEY`, `EMAIL_FROM`.

**Rate limiting per device**: fixed windows in the `rate_limits` table (`insert … on conflict do update set count = count + 1 returning count`). Limits: buy 10/min and 30/day, close 30/day, migrate 3/day, reads 120/min per device. Prune rows older than 2 days inside `eod-mark`. This avoids adding Upstash.

**Privacy**
- No names, emails, or phone numbers in v1.
- IPs are stored only as `sha256(IP_HASH_SALT || ip)` in `rate_limits` keys, pruned after 2 days.
- `ua_family` is coarse.
- The purge endpoint deletes positions, forecasts, devices and the recovery hash.
- Add a `/privacy` page stating what is stored, where (Neon, US region by default; confirm the region at project creation), and how to delete it.
- The public repo must never contain secrets. `.env*` is already ignored; verify in `.gitignore`.
- Aggregate global accuracy is public and per-user data is private.

### 3.9 Effort and ship order
| # | Item | Files | Size |
|---|---|---|---|
| 0 | Hotfixes that don't need a DB: `/report` adapter for the array-shaped fixture; drop the partial intraday bar in `yahoo.ts`; touch flags from post-fill bars only; calendar-based `target_date` | `web/src/lib/data.ts`, `web/src/app/report/page.tsx`, `web/src/lib/yahoo.ts`, forecast marking code | S |
| 1 | `marketCalendar.ts` plus `nse-holidays-2026.json` and tests | `web/src/lib/marketCalendar.ts`, `web/src/data/` | S |
| 2 | Neon via the Vercel Marketplace, `db.ts`, migrations 0001 and 0002 | `web/db/migrations/*`, `web/src/lib/db.ts`, `web/package.json` (+`@neondatabase/serverless`) | M |
| 3 | Report job, `reports` storage, `/api/report/*`, `/report` switched to the API | `web/src/lib/jobs/report.ts`, `web/src/app/api/report/**` | M |
| 4 | `web/vercel.json` crons plus `.github/workflows/cron-backup.yml`, `job_runs` leases | as named | S |
| 5 | Identity (device, cookie, recovery) | `web/src/lib/identity.ts`, `api/identity/**` | M |
| 6 | Server-frozen buy, close, portfolio | `api/paper/**` | M |
| 7 | Mark job, actuals, score_summary, scores UI | `web/src/lib/jobs/mark.ts` | M |
| 8 | localStorage migration, outbox, badges; retire the old routes | client paper components | S–M |
| 9 | Purge, `/privacy`, rate-limit pruning | | S |
| 10 | (v2) Magic link via Resend | | M |
Total: **L**. Steps 0–4 deliver the automated report. Steps 5–9 deliver server paper trading.

### 3.10 Acceptance tests (Part 2)
1. Idempotency: posting the same `idempotency_key` to `/api/paper/positions` twice gives one row. The second call returns 200 with the same id.
2. Triggers: `update forecasts …`, `delete from forecast_points …`, `update forecast_actuals …`, and `update reports …` all raise `immutable table`. Updating a `final` mark raises.
3. Scoring uses only `final` marks. A provisional mark never creates a `forecast_actuals` row.
4. `quote_moved`: `client_entry` 3% off the server price, with ATR% at 2%, returns 409.
5. Intraday not scored: a mark job run at 14:00 IST writes no row for today's session.
6. Holiday roll: a point with target 2026-10-02 is scored with the 2026-10-05 mark (≤ +3 calendar days). A point whose symbol has no final mark within +3 days is written as `sparse`.
7. Split: a synthetic 50% gap sets `gap_gt_15pct`, the affected points become `split_flag`, and they are excluded from `score_summary.n`.
8. Migration: re-posting a batch gives `duplicates = N`. Migrated forecasts have `provenance='client_created'`, client `actualClose` values are ignored, and headline stats are unchanged.
9. Recovery: the code restores the portfolio on a new device. The sixth attempt within an hour from the same ip_hash returns 429. A rotated code invalidates the old one.
10. Cron replay: running `premarket-report` twice for the same session gives one report, no duplicate actuals, and the same `score_summary`.
11. Purge: `DELETE /api/identity/me` removes the positions, forecasts and devices. The trigger does not block it. `audit_log` has `user.purge`.
12. Score rebuild: truncate and recompute `score_summary`, and the values are identical.

---

## 4) Facts NOT verified (treat as assumptions)
- **When Yahoo finalizes the NSE daily bar.** We verified only that a partial bar exists intraday. The design sidesteps this: scoring uses marks finalized at 06:30 IST the next day, and 16:30 IST marks are provisional.
- **Yahoo rate limits**: undocumented, with no official quota. The concurrency and backoff numbers are practice, not limits.
- **Latency from Vercel (iad1) to Yahoo and screener.in.** The ~50 s scan estimate is based on box measurements.
- **Whether Fluid compute is ON for this project.** It is the default for new projects, but not confirmed in the dashboard. If it is off, the Hobby cap is 60 s and `FLUID_OFF=1` plus chunking applies.
- **The Vercel Root Directory** (assumed `web/`) **and the project's Node version** (≥ 19 is needed for `@neondatabase/serverless` 1.x).
- **The env var names the Vercel ↔ Neon integration injects** (`DATABASE_URL` / `DATABASE_URL_UNPOOLED`), and Neon's default region.
- **Neon minimum compute size on Free**: the pricing page's "0.25 CU … 400 hours" example is verified, but the exact minimum is not.
- **Whether nseindia.com blocks Vercel IPs.** It blocked our box with a 403 from Akamai.
- **The official NSE circular for the 2026-01-15 holiday.** It is sourced from News18 quoting NSE. The main 2026 list is verified through a broker-hosted copy of the NSE circular, not a direct nseindia.com fetch.
- **NSE pre-open and normal session timings** (09:00–09:15 and 09:15–15:30 IST), taken from the task brief.
- **Muhurat trading 2026-11-08 timings**: not yet notified.
- **TradingView wording** that paper-trading history is "immutable": the pattern in §1 is paraphrased and not an exact official quote.
- **Resend domain verification requirements** for the free tier (only the 3,000/mo and 100/day limits are verified), and the **cron-job.org** free limits (not researched).
- **The 400-day browser cookie cap** (Chrome behaviour, not re-verified).
- **The TATAMOTORS successor tickers** after the demerger: `TATAMOTORS.NS` returns 404 "may be delisted" on Yahoo, `TMPV.NS` works, and the CV entity's ticker was not checked. Update `universe.ts` separately.

*Paper trading and research only. Not investment advice. Not SEBI-registered.*

---

## 5) Note on concurrent work, observed at 11:56–11:59 IST on 2026-09-25 while this brief was being written
§0 was inventoried at about 11:50 IST, when the repo had no `vercel.json`, no crons, and no DB code. While this brief was being written, **uncommitted changes appeared in the working tree from another agent or session**. This brief's author made none of them:
- `web/vercel.json` with crons `/api/cron/daily` at `30 1 * * *` and `/api/cron/mark` at `30 11 * * *` (07:00–07:59 IST and 17:00–17:59 IST, **every day including weekends**)
- `web/src/lib/kv.ts`: an Upstash Redis REST client
- New untracked files: `paperDb.ts`, `reportStore.ts`, `reportService.ts`, `report.ts`, `nseCalendar.ts`, `deviceId.ts`, `cronAuth.ts`, `paperMark.ts`, `paperApi.ts`, `api/cron/`, `api/report/`, `api/paper/positions/`, `api/paper/import/`, `web/scripts/`
- Edits to `report/page.tsx`, `paper/page.tsx`, `api/paper/buy`, `api/paper/mark-forecasts`, `PaperBuyButton.tsx`, `forecast.ts`, `news.ts`

**This brief's decisions differ from that work in a few places. Reconcile before merging:**
1. The DB is **Neon Postgres** here and Upstash KV there. KV has no triggers for immutability and no SQL for scoring, and its free tier is 500K commands per month.
2. Here the crons are weekdays only (`1-5`), there they run daily. Whichever wins, `marketCalendar` must skip weekends and holidays inside the handler.
3. Cron route names differ.
Nothing in this section was reviewed in depth.
