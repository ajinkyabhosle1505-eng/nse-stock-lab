# Paper forecast method v2 (`atr_piecewise_T1_T2_v2`): R:R-floor levels
**Date:** 2026-10-05 IST · **For:** Stock Research (review) · **From:** Stock Lab eng · approved by CoS
Research / paper only. Not SEBI-registered advice.

## Why
Under `risk_v2` every buy had T1 = entry + 2×ATR and SL = entry − 2.4×ATR, so T1 R:R was
2/2.4 = **0.83R on every setup**. Example: BPCL, 28 Sep: risk 15.94, gain to T1 13.28.

## What changed in the levels (`risk_v3`, report method `report_v3|risk_v3|atr_piecewise_T1_T2_v2`)
Shared code: `web/src/lib/risk.ts` `deriveLevels(tech, "rr_floor_v3")`, used by the report, `/lookup`,
`/budget-picks` and the server paper buy.
- SL is now a structure stop: nearest swing low below the close minus 0.25×ATR14, clamped to 1.0–2.4×ATR
  (2.0×ATR if there is no swing low; support × 0.995 if ATR is missing). R = entry − SL. Legacy v1/v2 reports keep the 2.4×ATR stop.
- T1 = at least entry + 1.0R. T2 = at least entry + 1.8R (rounded up to the paisa, so R:R never drops below the floor).
- Real overhead resistance = swing-high pivots above the close (all of the 1y history, no range fallback),
  plus the highest high of the prior 20 and 50 sessions (latest bar excluded).
  - T1 moves out to the nearest resistance in [1R, 1.8R) if one exists.
  - T2 moves out to the nearest resistance in [1.8R, 3R] if one exists.
- Resistance **below entry + 1R** caps the setup: it is never labelled buy. It becomes `hold`, with the reason
  "Resistance at ₹X (swing high) caps upside below 1R (0.2R to it)" and flag `rr_below_1r`. Its `targets[0]`
  is that resistance, so `r_r` stays honest (below 1).
- `r_r` = T1 R:R. New verdict fields: `rr_t1`, `rr_t2`, `risk_per_share`, `rr_plain`, `t1_basis`, `t2_basis`, `resistance_cap`.

## Paper scenario method
- The formula is **unchanged** from the 2026-09-22 brief (piecewise toward T1 then T2, d_T1 = round(0.45·d_max),
  0.7 scale for soft setups, never below entry). Only the T1/T2/SL it reads have changed.
- New server paper forecasts (`POST /api/paper/positions`) and browser forecasts store
  `method_version = "atr_piecewise_T1_T2_v2"`. The method id is part of `bundle_hash`.
- Existing forecasts keep `atr_piecewise_T1_T2_v1`. They are write-once (`fc:<id>`, SET NX) and nothing rewrites them.
  Migrated browser trades keep the method id they were created with (unknown → v1).
- The report deep dive labels its scenario path v1 (stored v1/v2 reports) or v2 (v3 reports).

## Scoring is per method, never pooled
`scoreViews()` (`/api/paper/scores`, `/api/paper/portfolio`) now returns:
- `method`: the current method (v2). `verified` and `unverified_pre_sync` cover **this method only**.
- `by_method.atr_piecewise_T1_T2_v1` and `by_method.atr_piecewise_T1_T2_v2`, each with `verified` and
  `unverified_pre_sync`.
The `/paper` headline therefore starts again at n = 0 for v2. v1 history is still there, under `by_method`.

## Effect on the 2026-10-05 report (local rebuild, based on the 2026-10-01 close, no Redis writes)
**Final (structure stop):** 3 buys, 2 in the Top 10 (T1 R:R 1.31 and 1.14); 50 names capped by resistance under 1R.

First pass, with the 2.4×ATR stop (kept for the record):
- risk_v2: 10 buys (5 in the Top 10), T1 R:R 0.83 on all of them.
- risk_v3: 1 buy (CANBK: risk ₹5.76, ₹6.78 to T1 (1.2R, swing high), ₹14.8 to T2 (2.6R, 50-day high)).
  9 buys were downgraded to hold because a swing high sits 0.03R–0.54R above the close
  (BHEL, COALINDIA, DIVISLAB, DRREDDY, HDFCBANK, HEROMOTOCO, HINDALCO, KOTAKBANK, SBILIFE).
- Across the 22 uncapped names, T1 R:R runs 1.00–1.77 (16 distinct values) and T2 R:R runs 1.80–2.73.
  54 of 76 names have resistance within 1R. With a 2.4×ATR stop, 1R is a wide move.

## For Stock Research to decide
1. **Resistance just above the close.** Many caps are tiny (DRREDDY 0.03R, BHEL 0.05R). Should a level within
   about 0.25R count as a breakout trigger ("buy on a close above ₹X") rather than a cap?
2. **Stop width.** Shipped: a structure stop (swing low − 0.25×ATR, 1.0–2.4×ATR). It raised buys from 1 to 3. Review the clamp.
3. **Scenario path scale.** v2 targets are further out than v1 (≥1R vs 0.83R). The 0.7/1.0 scale and d_T1 are
   unchanged. Should they be re-fit once v2 has n ≥ 20 scored points?
