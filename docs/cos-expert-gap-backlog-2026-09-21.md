# Stock Lab — Expert Gap Memo for Chief of Staff
**Date:** 2026-09-21 (IST) · **Product:** NSE Stock Lab PWA (`web/`, live https://nse-stock-lab.vercel.app)  
**Ask:** What peers give experts that Lab lacks — and how to build it in *this* stack (beyond greenlit P0/P1).  
**Method:** Light verify of Lab (`web/README.md`, `universe.ts`, `risk.ts`, `live.ts`, `funda.ts`, `news.ts`, `paper/`) + peer inventory (Screener.in, Tickertape, Trendlyne, Groww, Zerodha Kite/ecosystem, TradingView, ChartInk, Moneycontrol). **No code shipped.**

---

## A) Already greenlit — reference only (do not re-argue)

| Tier | Scope |
|------|--------|
| **P0** | Micro-budget sizing fix (₹100 empty due to 1% risk) + debias (`PREFERRED` Banks/Energy/Infra +15 in `pickScore`, fixtures PNB/COALINDIA) |
| **P1a** | Plain-English CTA on cards (buy / wait / skip) — jargon-heavy `VerdictCard` today |
| **P1b** | Charts (Lab has **zero** chart UI libs in `web/package.json`; Yahoo chart API used only for OHLC→tech) |

Ship P0 → P1a → P1b in that order; backlog below assumes they land.

---

## Peer pillar snapshot (what experts use)

| Pillar | Peers | Lab today | Gap |
|--------|-------|-----------|-----|
| **Universe & screener** | Screener.in query builder (PE/ROE/ROCE/custom); Tickertape 200+ filters + prebuilt screens; Trendlyne 1k–3.5k params; ChartInk technical scans; Groww funda + intraday screener; TradingView stock screener | Hardcoded ~22 names in `web/src/lib/universe.ts`; `/budget-picks` scans that list only; no PE/ROE/mcap/price filters in UI | **Critical** |
| **Multi-TF charts + overlays** | TradingView Supercharts (MTF, 400+ indicators); Groww Charts (RSI/MACD/MA/VWAP/Supertrend); Zerodha Kite (TV-powered); ChartInk chart widgets | Numbers only (`cmp`, ATR, DMA, RSI, S/R) via `yahoo.ts`→`tech.ts`; no candle UI | **Critical** (P1b) |
| **Fundamentals + peer compare** | Screener peer table + 10y statements; Tickertape scorecards; Trendlyne DVM/SWOT; Moneycontrol compare | Live PE/ROE/D-E + quality gate (`funda.ts`); no peer table, no history, no sector ranks | **High** |
| **News / catalysts w/ dates** | Screener announcements/filings; Moneycontrol alerts; Trendlyne newsfeed; Tickertape corporate actions | RSS headlines + `pubDate`, rumored gate, `catalyst_expiry` (`news.ts`) — good honesty, thin calendar UI | **Medium** |
| **Risk: size, R:R, heat, sector caps** | Broker risk (margin); portfolio diversify scores (Tickertape); paper rules (TV) | `sizePosition` + per-trade R:R in `risk.ts`; **no** portfolio heat, sector % caps, max open risk | **High** for budget paper |
| **Plain-language CTA** | Groww colour-coded technicals; Tickertape scores; Trendlyne Buy/Sell/Hold analyst layer | `action` buy/hold/avoid + jargon metrics on `VerdictCard` | **High** (P1a) |
| **Watchlists & alerts** | Screener screen alerts; Tickertape/Trendlyne price+SMA+earnings alerts; Moneycontrol My Alerts; ChartInk scan alerts; TV alerts | None (no watchlist route, no push/email) | **High** |
| **Paper realism** | TradingView paper (fills, commissions, multi-account); Zerodha Console P&L | Static ledger JSON (`paper/`, `/paper`); fills list; unrealized often **UNKNOWN**; no mark-to-market loop, no equity curve | **High** |
| **Data freshness / sources / UNKNOWN** | Peers often hide gaps; Lab is more honest | Yahoo + Screener HTTP; `unknowns[]`, UNKNOWN marks — **strength** | **Partial** (show stamps more loudly) |
| **Mobile PWA UX** | Groww/Tickertape/Trendlyne native apps; bottom sheets, one-thumb flows | PWA + `BottomNav` + SEBI banner — solid scaffold; cards dense; no offline cache strategy documented | **Medium** |

**Lab strengths to keep:** UNKNOWN honesty, SEBI banner (`SebiBanner.tsx`), risk-based share sizing, live merge in `live.ts`, Vercel-safe HTTP funda/news (no Python on edge).

---

## B) NEW expert gaps — ranked BUILD backlog for CoS

> Rank = value for Ajinkya’s **budget paper NSE PWA** × feasibility in Next.js + existing Yahoo/Screener lanes. Effort: **S** ≤2d · **M** ~3–7d · **L** >1–2w.

### 1. Budget-aware screener (expand universe + filters)
- **Why:** Experts never hunt ideas inside 22 hardcoded names. Screener/Tickertape/ChartInk start from *filters*. ₹ budget + `price ≤ budget` is Lab’s differentiator peers lack.
- **How:** Expand `BUDGET_UNIVERSE` (or load Nifty 100/200 JSON in `public/data/`); add `/api/screen` that reuses `runLookup`/`fetchLiveFunda` with filters: `pe_ttm`, `roe_pct`, `market_cap_bucket`, `sector`, `cmp ≤ budget_inr`, optional `funda_quality≠fail`. Cap concurrency (e.g. 5) for Vercel. UI: `/screen` or upgrade `/budget-picks` with filter chips.
- **Effort:** M · **Depends:** after **P0** (else micro-budget still empty) · soft after P1a for readable results
- **Sniff-test:** Filter `Banks · PE<15 · price≤budget` returns ≥3 names outside the old 22; empty states explain UNKNOWN/rate-limit, never invent PE.

### 2. Portfolio heat + sector caps (risk layer)
- **Why:** Single-name `sizePosition` is necessary but insufficient; experts cap **portfolio heat** (sum risk ₹ / budget) and **sector %**. Tickertape diversification / red flags are the peer analogue.
- **How:** Extend `risk.ts`: `portfolioHeat(openFills, budget)` + `sectorExposure`; gate new buys in `mergeVerdict` / paper “Add fill” when heat > e.g. 6% or sector > 40%. Surface on `/paper` and pick cards (`risk_flags`).
- **Effort:** S–M · **Depends:** P0 (correct size) · pairs with #5 paper
- **Sniff-test:** With 3 Bank buys open, 4th Bank pick shows “sector cap” hold; heat meter visible on `/paper`.

### 3. Fundamentals table + mini peer strip
- **Why:** Screener peer compare is table-stakes before size. Lab already scrapes PE/ROE/D-E — unused for compare.
- **How:** On `/ideas/[ticker]`, table: PE, ROE, D/E, mcap bucket, quality, sources/ts. Peer strip = same `sectorOf` names from universe (or top-N by mcap) via parallel `fetchLiveFunda`. No 10y statements yet.
- **Effort:** M · **Depends:** none hard; nicer after universe expand (#1)
- **Sniff-test:** PNB detail shows PE/ROE vs SBIN/BANKBARODA side-by-side; missing field = UNKNOWN not “0”.

### 4. Watchlist + local alerts (PWA)
- **Why:** Screener/Trendlyne/Moneycontrol/TV all close the loop with alerts; without them Ajinkya re-polls `/lookup`.
- **How v1:** `localStorage` watchlist + `/watch`; client poll (or SW) vs last CMP from `/api/lookup`; notify on: price cross buy_trigger/SL, funda_quality flip, rumored→confirmed. Optional later: email via Resend.
- **Effort:** M · **Depends:** after P1a (alert copy in plain English)
- **Sniff-test:** Star a pick → leave app → price crosses trigger → browser notification with “Wait/Buy?” CTA; works Add-to-Home-Screen.

### 5. Paper trading realism (marks, fills, P&L curve)
- **Why:** TV paper + Console P&L teach discipline; Lab ledger is a static dump (`paper/ledger_*.json`, `/paper`).
- **How:** Client or API “Mark now” → Yahoo CMP → fill unrealized; optional slippage/charges fields; equity series in `localStorage` or `public/data`; simple SVG equity curve (no heavy lib) after P1b patterns. “Paper buy from verdict” button writes fill using `sizePosition`.
- **Effort:** M · **Depends:** P0 sizing; chart curve after P1b optional
- **Sniff-test:** Mark open fills → Unrealized leaves UNKNOWN; one closed fill updates realized; curve shows ≥2 points after two marks.

### 6. Catalyst timeline UI (news with dates)
- **Why:** Experts skim dated catalysts; Lab has `pubDate` / `catalyst_expiry` but cards don’t timeline them (Moneycontrol/Trendlyne pattern).
- **How:** Sort `news` items by `pubDate` on detail; badge Confirmed/Rumored; show expiry → already folded into `time_horizon` in `mergeVerdict`.
- **Effort:** S · **Depends:** P1a copy polish helpful
- **Sniff-test:** Detail page shows 3 headlines with dates; rumored never alone drives Buy.

### 7. Data freshness strip (honesty UX)
- **Why:** Peers hide staleness; Lab’s UNKNOWN is a moat — make it visible.
- **How:** Footer chip on lookup/picks: `Yahoo · Screener · RSS` + ISO ts from lanes; banner when `unknowns.length>0`.
- **Effort:** S · **Depends:** none
- **Sniff-test:** Kill Screener path → PE shows UNKNOWN + “Screener unavailable”, verdict still runs on Yahoo tech.

### 8. Mobile PWA density pass
- **Why:** Groww wins on one-thumb clarity; Lab cards pack Entry/SL/Targets/Buy trigger/Stop invalidation redundantly (`VerdictCard` + `plan.ts`).
- **How:** After P1a, collapse to: **Do X · Why (1 line) · Risk ₹ · Shares**; secondary accordion for levels. Safe-area / larger tap targets on `BottomNav`.
- **Effort:** S · **Depends:** **P1a**
- **Sniff-test:** Thumb-reach all nav; idea card ≤ viewport fold on 390px width.

### 9. Multi-timeframe tech summary (beyond P1b chart)
- **Why:** TV/Groww/ChartInk experts check D vs W alignment; Lab `computeTech` is single daily series.
- **How:** After P1b, Yahoo `interval=1wk` (and optional 1h) → structure/DMA alignment badge “Daily↑ Weekly↑”. Overlays: DMA20/50/200, ATR band already computed — draw on chart.
- **Effort:** M · **Depends:** **P1b**
- **Sniff-test:** Toggle D/W; badge matches visible MAs; no fabricated intraday if Yahoo fails.

### 10. Saved screen presets (power-user)
- **Why:** Screener “save query + alert” and Tickertape prebuilt screens are how experts reuse edge.
- **How:** Persist filter JSON in `localStorage`; 3 presets: “Budget PSU”, “Quality PE&lt;20”, “Breakout only”. Hook to #4 alerts later.
- **Effort:** S · **Depends:** #1 screener
- **Sniff-test:** Reload app → preset restored; run returns deterministic sort key.

---

## Suggested sequencing (after / around greenlit)

```
P0 micro-budget + debias
 → #2 heat/sector caps (S) + #7 freshness strip (S)
 → P1a plain English → #8 PWA density
 → P1b charts → #9 MTF overlays
 → #1 budget screener (M) → #3 peer strip → #10 presets
 → #4 watchlist/alerts + #5 paper marks (parallel)
 → #6 catalyst timeline (anytime S)
```

---

## C) Out of scope / SEBI-risk / don’t build yet

| Do **not** build yet | Why |
|----------------------|-----|
| Live brokerage / order routing / “invest now” | SEBI advice + execution risk; Lab is paper/research only |
| Analyst target / Buy-Sell-Hold consensus as Lab’s own advice | Trendlyne/Tickertape cite registered analysts; mimicking without registration = advice risk — keep Lab actions as **paper plan**, not recommendation |
| Options, F&O, margin, leverage paper | Out of budget-equity mandate; complexity spike |
| Full Screener-class 10y statements / Excel export / custom ratios | Data+ToS burden; use link-out to Screener.in instead |
| Real-time WS ticks / ChartInk-class 15m scanners | Yahoo poll latency OK for swing; cost/ToS |
| Pushing “guaranteed” tips, tips marketplace, copy-trading | SEBI + trust |
| Softening UNKNOWN / inventing PE/ROE/fills | Violates product honesty contract |
| Re-arguing sector +15 bias without P0 debias | Already greenlit — implement, don’t rethink in this memo |

**Disclaimer posture (keep):** `SEBI_BANNER` on every screen; never auto-upgrade rumored news to Buy (`mergeVerdict` gate).

---

## One-line CoS ask

**Approve backlog items #1–#5 as P2** (screener, portfolio heat, peer strip, watch/alerts, paper marks), schedule **#6–#8 as polish**, **#9–#10 after P1b**, and explicitly **park Section C**. Greenlit P0/P1 stay first.

*— Stock Research, read-only · 2026-09-21 IST*
