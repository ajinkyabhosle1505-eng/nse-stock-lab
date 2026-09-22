# Paper forecast accuracy — implementable brief (Stock Lab)
**Date:** 2026-09-22 IST · **For:** Stock Lab eng (via CoS) · **From:** Stock Research  
**Scope:** Paper buy from desk → user picks check days → store predictedClose per day → later mark Yahoo CMP → score accuracy.  
**Same push context:** budget-picks bias fix, live Funda/News, charts — this feature is additive on paper fills.

Sources used: `web/src/lib/risk.ts` (`deriveLevels`, `mergeVerdict`, `sizePosition`), `tech.ts` (ATR/structure), `types.ts` (`Fill`, `Verdict`, `TechFields`), `yahoo.ts` (`fetchYahooHistory` interval=`1d`), `universe.ts` `SEBI_BANNER`.

---

## 0) Product rule (honesty)

Lab levels are **ATR scenario anchors**, not a crystal ball. Store a **named method** + **predictedClose** that is a deterministic function of entry/SL/T1/T2/ATR — never random walks, never funda PE→price, never “AI predicted ₹X.37”.

UI copy: **“Paper scenario path (ATR)”** not “price prediction” / “expected return” / “will hit”.

---

## 1) How to build the daily predicted path (honest formula)

### Inputs already on a buy verdict (`mergeVerdict` → `deriveLevels`)

| Field | Formula today |
|-------|----------------|
| `entry` | `cmp` |
| `sl` | `entry − 2.4×ATR14` (else support×0.995) |
| `T1` / `targets[0]` | `entry + 2×ATR` |
| `T2` / `targets[1]` | `entry + 3.5×ATR` |
| `atr` | `tech.fields.atr_14` |
| `R` | `entry − sl` (>0 or abort) |

Abort forecast if `action≠buy` or any of entry/sl/atr/T1 missing → do not invent; allow paper fill without forecast or with `forecast.status=skipped`.

### Day meaning

- User picks **calendar day offsets** from fill date: e.g. `{3,7,10,21,45}` (flexible array).
- Internally convert each offset to a **target calendar date** = `filledAt_date + dayOffset` (IST date, no time games).
- When scoring, mark with Yahoo **daily close on the first available session on/after that date** (skip weekends/NSE holidays). Store both `dayOffset` (user) and `tradingDayIndex` (count of Yahoo bars after fill bar) for analytics.

### Base path (v1 — ship today): piecewise linear in price toward T1 then T2

Let `d_max = max(selected dayOffsets)` (must be ≥1).  
Anchor horizons in **calendar days** (matches user UI):

- `d_T1 = clamp(round(0.45 * d_max), min(selected), d_max)`  
  (default: expect T1 ~ mid-path of the user’s longest check; if user only picks `{3,7}`, d_T1=3 or 7.)
- `d_T2 = d_max`

For each selected `d`:

```
if d <= d_T1:
  predictedClose = entry + (d / d_T1) * (T1 - entry)
else:
  predictedClose = T1 + ((d - d_T1) / (d_T2 - d_T1)) * (T2 - T1)
```

Round to **2 decimals** (same as `risk.round`).

### Tape dampener (optional, still honest)

From `tech.fields` at fill time (snapshot on fill — do not recompute later):

- `breakout_state=="breakout"` or `structure=="HH_HL"` → scale = 1.0  
- soft constructive (else buy) → scale = 0.7:  
  `predictedClose = entry + scale * (rawPredicted - entry)`  
- Never push predicted below `entry` on a buy path in v1 (bear case is SL invalidation, scored separately).

### What not to do

- Do **not** interpolate to SL as the “main” path for buys.  
- Do **not** use RSI/PE to move the path.  
- Do **not** emit per-day confidence bands that look like ±0.1% precision; if you show a band, use **±1×ATR** as a wide scenario sleeve, labeled UNKNOWN-friendly.

### Method id (store on fill)

`method: "atr_piecewise_T1_T2_v1"`  
`params: { d_T1, d_T2, scale, atr_14, entry, sl, t1, t2 }`

---

## 2) Accuracy metrics + default thresholds

Compute **only when** `actualClose` is non-null for that point. Always show **n** (sample count). No green “edge” badge until `n≥20` fills with ≥1 scored point each.

Per point `i` (and rollups by horizon bucket: `≤7` / `8–21` / `≥22` calendar days):

| Metric | Formula | UI default |
|--------|---------|------------|
| **APE** | `\|actual−pred\| / actual * 100` | show per point |
| **MAPE** | mean APE over scored points | headline by horizon |
| **Hit-within-X%** | `\|actual−pred\| / entry ≤ X/100` | **X = max(1.0, 100×ATR/entry)** i.e. ~1 ATR in % terms; also show fixed **2%** band |
| **Hit-within-0.5R** | `\|actual−pred\| ≤ 0.5 * R` | secondary |
| **Directional** | `sign(pred−entry) == sign(actual−entry)` (0 if either side 0) | % correct |
| **Level outcomes** (fill-level, not per day) | by check day / at close of max day: touched T1? T2? SL? (low≤level≤high that session or close cross) | binary flags |

**Sane thresholds (display only — do not auto-claim skill):**

- MAPE: no pass/fail; sort horizons by MAPE for curiosity.  
- Hit-within-1ATR%: “in band” if ≥ **35%** at ≤7d and ≥ **30%** at 8–21d **after n≥20** — below that, show neutral “noise / small sample”.  
- Directional: interesting only if ≥ **55%** with `n≥20`; else “insufficient”.  
- Never average across tickers with different ATR% without also showing per-ticker.

---

## 3) Data: Yahoo daily OHLC marks — gotchas

Use existing `fetchYahooHistory(yahooSymbol, range, "1d")` (`yahoo.ts`). Prefer **`bar.close`** for the session on/after target date; CMP/`regularMarketPrice` OK for “mark now” if same session, but **accuracy scoring must use daily close** for reproducibility.

| Gotcha | What to do |
|--------|------------|
| **Weekends / NSE holidays** | No bar → use **next** session close; store `actualSessionDate`; if none within **3 calendar days**, `actualClose=null`, status=`sparse` |
| **Splits / dividends** | Chart path currently uses **raw `close`**, not adjclose — multi-week MAPE can jump on split. v1: detect huge overnight gap (>15%) vs prior close and flag `corporate_action_suspect`; v1.1: parse `indicators.adjclose` if present and score on adj |
| **Sparse / nulls** | Yahoo builder already skips null OHLC; don’t invent |
| **`bars.length < 30` → null** | Full history helper rejects short series — for marks, either call chart with `range=1mo`/`3mo` and **relax** min bars for a dedicated `fetchYahooCloseOnOrAfter(date)`, or reuse last lookup bars |
| **Fill mid-session** | `filledAt` day = day 0; first check day 3 = calendar+3; don’t require intraday |
| **Rate limits / crumb** | Batch marks; cache per symbol-day; UNKNOWN on failure — never invent CMP |

---

## 4) What NOT to claim (SEBI / wording)

Reuse `SEBI_BANNER`:  
*"Not SEBI-registered advice. Paper / research only. Levels are not a recommendation to buy or sell."*

**Do not say:** predicted return, guaranteed target, “accuracy proves strategy works”, buy/sell recommendation, tip, advisory, SEBI research report.  
**Do say:** paper scenario path from ATR levels; scoreboard of how close Yahoo closes landed vs that scenario; research / learning only.

Rumored news must not alter predictedClose (gates stay on action only, already in `mergeVerdict`).

---

## 5) Minimal JSON schema

Extend paper fill (compatible with existing `Fill` in `types.ts`):

```ts
type ForecastPoint = {
  dayOffset: number;           // user-selected calendar days after fill date
  predictedClose: number;      // 2dp
  targetDate: string;          // ISO date IST YYYY-MM-DD
  actualClose: number | null;  // Yahoo daily close on/after targetDate
  actualSessionDate: string | null;
  ape_pct: number | null;      // |a-p|/a*100
  within_1atr: boolean | null;
  within_2pct: boolean | null;
  direction_ok: boolean | null;
  status: "pending" | "scored" | "sparse" | "error";
};

type ForecastBundle = {
  method: "atr_piecewise_T1_T2_v1";
  createdAt: string;           // ISO
  params: {
    entry: number;
    sl: number;
    t1: number;
    t2: number;
    atr_14: number;
    R: number;
    d_T1: number;
    d_T2: number;
    scale: number;             // 1.0 or 0.7
    structure?: string;
    breakout_state?: string;
  };
  checkDays: number[];         // e.g. [3,7,10,21,45]
  points: ForecastPoint[];
  scoreSummary: {
    n_scored: number;
    mape_pct: number | null;
    hit_within_1atr_pct: number | null;
    hit_within_2pct_pct: number | null;
    directional_pct: number | null;
    by_horizon: {
      bucket: "le7" | "8to21" | "ge22";
      n: number;
      mape_pct: number | null;
      hit_within_1atr_pct: number | null;
      directional_pct: number | null;
    }[];
    touched_t1: boolean | null;
    touched_t2: boolean | null;
    touched_sl: boolean | null;
    lastMarkedAt: string | null;
  };
};

// Paper position / fill (minimal add)
type PaperFillWithForecast = Fill & {
  yahoo_symbol: string;
  forecast?: ForecastBundle | null;
};
```

**API sketch (eng):**

1. `POST` paper buy from verdict → body `{ checkDays: number[] }` → compute `ForecastBundle` once, persist on fill.  
2. `POST /api/paper/mark-forecasts` (or client “Score due”) → for each pending point with `targetDate ≤ today`, Yahoo close → fill actuals → recompute `scoreSummary`.

**Sniff tests**

1. Buy RELIANCE-class name with ATR known, checkDays `[3,7,10]` → 3 points, `predictedClose` monotone toward T1, all between entry and T2.  
2. Mark before day 3 → points stay `pending`.  
3. Kill Yahoo → `actualClose=null`, `status=error|sparse`, no invented CMP.  
4. UI shows SEBI banner; nowhere says “recommendation”.

**Effort:** S–M (~1–2d) on top of existing paper fill + Yahoo chart lane.

— Stock Research · read-only · 2026-09-22 IST
