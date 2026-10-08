# Ops: pre-market report + server paper trading (v1, Upstash Redis)

Research / paper only. Not SEBI-registered advice.

## Env vars (Vercel → Project nse-stock-lab → Settings → Environment Variables, Production + Preview)
| Name | Required | Value / how to get it |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | for DB mode | Upstash console → Redis database → REST API → `UPSTASH_REDIS_REST_URL` (or Vercel Marketplace → Upstash → connect; it injects `KV_REST_API_URL`, which the app also accepts) |
| `UPSTASH_REDIS_REST_TOKEN` | for DB mode | same page, `UPSTASH_REDIS_REST_TOKEN` (the read-write token, not the read-only one) |
| `CRON_SECRET` | yes (crons) | `openssl rand -hex 32`. Vercel Cron sends it as `Authorization: Bearer …`. Without it the cron routes return 503. |
| `RECOVERY_PEPPER` | for recovery codes | `openssl rand -hex 32`. Never change it after launch (old codes stop working). Without it devices still work, but no code is issued. |
| `IP_HASH_SALT` | optional | `openssl rand -hex 16`. Salts the IP hash used for rate limits. |
| `FLUID_OFF` | optional | Set to `1` only if Fluid compute is OFF (60 s cap): the scan stops scheduling at 45 s instead of 210 s. |

GitHub repo secret (for the backup workflow): `CRON_SECRET` with the same value
(repo → Settings → Secrets and variables → Actions → New repository secret).

After adding env vars, redeploy (Deployments → … → Redeploy) so functions pick them up.

## Crons (web/vercel.json, UTC; Hobby fires anywhere inside the hour)
| Route | UTC | IST window | Does |
|---|---|---|---|
| `/api/cron/premarket-report` | `0 1 * * 1-5` | 06:30–07:29 | FINAL marks for the last session + scoring, then build/store `report:<today>` (based on the previous close) |
| `/api/cron/eod-mark` | `0 11 * * 1-5` | 16:30–17:29 | PROVISIONAL marks only (evening P&L), never scores |
| `/api/cron/premarket-retry` (v3.1) | `15 2 * * 1-5` | 07:45–08:44 | second pass: if today's report is **partial**, re-fetch + store an upgraded version; noop if complete; builds v1 if the first cron was missed |
| GHA backup | `17 2 * * 1-5` / `37 12 * * 1-5` | 07:47 / 18:07 (+GitHub delay — observed 6–7 h late, e.g. 14:39 IST on 5 Oct) | same endpoints, `?source=gha&finalize_if_partial=1`; the premarket call now also upgrades a partial report |

NSE holidays (`web/src/data/nse-holidays-2026.json`) → `holiday_skip`. Double runs are blocked by a
Redis lease `job:lock:<job>:<date>` (SET NX EX 360) and completed runs are recorded at `job:run:<job>:<date>`.

The GitHub Actions workflow is at `docs/ops/cron-backup.yml`: the push token lacked the `workflow`
scope, so copy it to `.github/workflows/cron-backup.yml` via the GitHub web UI (Add file → Create new file).

## Tamper-proofing (Redis)
- `pos:<id>`, `fc:<id>` (forecast + points + input_hash + bundle_hash), `report:<date>`, `act:<id>:<d>`,
  `ev:<id>:<type>` are written once with SET NX. No code path rewrites them.
- Report versions (report_v3.1): `report:<date>` is version 1. Upgrades of a PARTIAL report go to
  `report:<date>:v<n>` + `report:inputs:<date>:<inputs_hash>` (SET NX) and `report:versions:<date>` (ZSET, append-only).
  A complete version is never superseded. See "2026-10-06: report_v3.1" below.
- Closing a position appends `ev:<id>:close` (SET NX). Touches (SL/T1/T2) are `ev:<id>:touch_*` from FINAL bars after the fill.
- The server sets the entry itself (fresh Yahoo quote). If the client's price differs by more than max(1%, ½·ATR%), the response is 409 `quote_moved`.
- Scores come from FINAL closes only (fetched on a later IST day). Gaps over 15% or adjclose-ratio jumps → `split_flag`, which is excluded.
- Migrated localStorage trades → `provenance=client_migrated/client_created`, badge "Pre-sync · unverified", excluded from headline stats.

## No-DB fallback
Without `UPSTASH_*`: `/api/report/latest` generates on demand (cached per instance + CDN, labelled `storage:"ephemeral"`),
`/paper` stays in browser mode (localStorage), `/api/paper/buy` + `/api/paper/mark-forecasts` work statelessly,
and `/api/paper/positions` etc. return 503 `db_not_configured`. With DB configured, the old routes return 410.

## Tests
```
cd web
node scripts/mock-upstash.mjs 8079 &            # local mock of the Upstash REST API
UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 UPSTASH_REDIS_REST_TOKEN=dev npx tsx --tsconfig tsconfig.json scripts/acceptance.lib.test.ts
node scripts/acceptance.http.mjs http://localhost:3101 --db --secret=testsecret   # server started with the mock env
node scripts/acceptance.http.mjs https://nse-stock-lab.vercel.app                 # production (read-only checks; DB mode → "no-DB fallback" is replaced by a 410/401 check)
```

## Diagnosing a thin report (UNKNOWNs / short Top 10)
```
cd web
npx tsx --tsconfig tsconfig.json scripts/report-diagnose.ts 2026-09-25 /tmp/rep.json   # live build, no Redis writes
npx tsx --tsconfig tsconfig.json scripts/report-diagnose.ts --inputs saved-inputs.json  # offline, pure rebuild
```
Prints UNKNOWN counts by lane/reason and, per symbol, why it is or isn't in the Top 10
(action + gate, price band, or sector cap).

Findings 2026-09-25 (report_v1: 6 in Top 10, 29 UNKNOWN):
- **Screener 429** (21 names): screener.in's nginx limit lets ~20 quick requests through, then
  answers 429 "Too many requests" (no Retry-After). Fixed in `funda.ts`: process-wide token bucket
  (burst 8, then 1 req / 1.15 s), 429 → bucket emptied + 6 s/12 s cool-down + retry (3 tries), no
  standalone-page retry after a 429. UNKNOWN reasons are now specific (`screener_429`, `screener_timeout`,
  `screener_blank_ratios`, …). Funda pass now takes ~55–60 s instead of ~21 s.
- **Funda gap forced "avoid"** (report_v1): Screener-blocked names got `funda_quality=fail`
  ("Heavy unknowns") and were turned into avoids. report_v2 (`fundaGap:"unknown"` in `mergeVerdict`)
  shows funda as UNKNOWN (flag `funda_unknown`), lets the tape decide, and caps confidence −1. Stored v1
  reports still re-verify with v1 rules (`fundaGapPolicy(method_version)`). /lookup and /budget-picks
  still use the legacy rule (default `fundaGap:"avoid"`).
- **Yahoo null bar** (8 names): Yahoo v8 returned the 2026-09-24 row with null OHLC for BAJAJ-AUTO,
  BAJAJFINSV, GAIL, GRASIM, IOB, JSWSTEEL, SBILIFE, ULTRACEMCO (query1 and query2, range 5d/1mo/1y, BSE too)
  while the 25-Sep session was live. That report was self-generated at 12:36 IST, not by the 06:30 cron.
  These stay UNKNOWN (`yahoo_null_bar`), never filled from the 23-Sep bar or intraday bars. The builder
  now tries query2 once when the based_on_close row is missing. NSE bhavcopy (official) returns 403 from
  cloud/box IPs, so it can't be used as a fallback.

## 2026-10-05: report_v3 | risk_v3 (R:R floor), funda UNKNOWN everywhere, expected_session fix
- **R:R floor** (`risk.ts deriveLevels(…, "rr_floor_v3")`): T1 ≥ entry + 1R, T2 ≥ entry + 1.8R (R = entry − SL, SL unchanged),
  moved out to a real resistance (swing high, prior 20/50-day high: new tech fields `resistance_swing`, `high_20d`, `high_50d`).
  Resistance below entry + 1R → `hold` with "Resistance at ₹X caps upside below 1R" (flag `rr_below_1r`). Verdict adds
  `rr_t1`, `rr_t2`, `rr_plain`, `t1_basis`, `t2_basis`, `resistance_cap`. Report picks (v3 only) add `rr_t1`, `rr_t2`, `rr_plain`,
  `funda_status`, and the Top 10 adds `rr_capped[]` (names held back and why). Stored v1/v2 reports re-verify with
  `levelPolicy(method_version) = "atr_v2"`.
- **Paper method** `atr_piecewise_T1_T2_v2` for new forecasts. v1 forecasts are untouched. Scores are per method
  (`by_method`). See `docs/paper-forecast-method-v2-rr-floor-2026-10-05.md`.
- **Funda gap = UNKNOWN on /lookup, /budget-picks and paper buy** (`fundaGap:"unknown"` is now the default): flag
  `funda_unknown`, confidence −1, `funda_unknown_label` "Fundamentals UNKNOWN (not verified)" + `funda_unknown_reasons`.
  Budget picks: tech pass first, then funda only for tape buys (shared Screener pacer), with a 40 s funda deadline
  (`BUDGET_FUNDA_BUDGET_MS`). Verified names are listed before UNKNOWN ones (`diversifyPicks(…, {verifiedFirst})`).
- **/api/report/latest** `expected_session` = the session the current report is for: today from 06:00 IST on a trading
  day, otherwise the next trading session. New `due_session` (latest session whose report must already exist).
  `stale = report.for_session < due_session`.
- Compare old and new levels on the same inputs: `scripts/report-diagnose.ts <session>` prints an "R:R effect" block.

## 2026-10-06: report_v3.1 — partial reports + upgrades, official-file fill, stale labels
Trigger: the 2026-10-06 report (based on the 5 Oct close) had no 5 Oct Yahoo bar for all 4 India indices
(last bar 1 Oct) and null 5 Oct rows for 15 stocks (KOTAKBANK, MARUTI, NTPC, BAJAJ-AUTO, …). It was stored
`complete` (report_v2 rules: data holes were not "partial"), Kotak dropped out of the Top 10 and the market
overview showed 1 Oct index numbers without saying so. That stored report stays as is (write-once, complete).

**Method** `report_v3.1|risk_v3|atr_piecewise_T1_T2_v2` — levels / gates unchanged from v3. Stored v1/v2/v3
reports re-verify with their own rules (no v3.1 fields are added to them; `dataGapRules(method)`).

**1. Partial = any missing based_on_close bar.** After the official-file fill, a stock or India index without a
bar for `based_on_close` (Yahoo null row, missing row, or fetch failure) makes the report `partial`, with
`incomplete.missing_bars[]` (symbol, kind stock/index, reason, last bar date) and `incomplete.note`. Permanent
holes (404, short history) stay UNKNOWN without making it partial.

**2. Versions / upgrades (write-once applies to COMPLETE reports).**
- The first run always stores v1 (`report:<date>`), complete or partial (the 06:30 cron no longer skips partials).
- A later run on the same IST day, when the newest version is partial: re-fetch everything, rebuild, and store
  `report:<date>:v<n+1>` only if it is complete or has fewer missing bars (else `upgrade_no_improvement`).
  Each version has its own inputs (`report:inputs:<date>:<inputs_hash>`), `inputs_hash`, `report_hash`,
  `version`, `supersedes {key, version, status, report_hash, inputs_hash, missing}` and `version_note`.
  Max 6 versions. `putReportUpgrade` refuses if the newest version is complete (`base_complete`).
- `/api/report/latest` and `/api/report/<date>` serve the newest version, plus `report_version` and `versions[]`
  (audit list). `/api/report/<date>?version=1` returns a specific stored version (immutable cache).
  Partial reports are served with a short CDN life (s-maxage=60) so an upgrade shows up quickly.
- `/latest` self-heal never upgrades (readers are never blocked on a rebuild); it only builds a missing v1.

**When the retry runs (IST, trading days):**
| Time | Who | Does |
|---|---|---|
| 06:30–07:29 | Vercel cron `/api/cron/premarket-report` | marks + scoring, build + store v1 (complete or partial) |
| 07:45–08:44 | Vercel cron `/api/cron/premarket-retry` (new, `15 2 * * 1-5`) | if partial → re-fetch, store v2 if better; noop if complete |
| 07:47 (+GitHub delay, often hours) | GHA `cron-backup.yml` → `/api/cron/premarket-report?source=gha…` | same upgrade logic (no workflow change needed) |
| 16:30–17:29 | Vercel cron `/api/cron/eod-mark` | provisional marks, then (if ≥ 200 s left) one upgrade try of today's report if still partial; never builds v1, never scores. Versions built after 09:15 say "(after the session opened)" in `version_note`. |
| 18:07 (+delay) | GHA eod backup | same as eod-mark (retry runs even when marks were already done) |

**3. Official-file fill (free, read-only, `src/lib/bhavcopy.ts`).** Only for a missing/null based_on_close bar,
only from the file for exactly that date, never intraday or a later date:
- stocks: NSE `sec_bhavdata_full_DDMMYYYY.csv` → NSE UDiFF `BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip` →
  BSE UDiFF `BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV`; tag `close_source: "nse_bhavcopy" | "bse_bhavcopy"` on the bar
  (inputs), the pick (`close_source`, `close_label`), `report.data_fills[]` and `report.close_sources` counts.
  Guards: Yahoo's last bar must be the previous trading day (no wider gap); the row's own date must equal
  based_on_close; OHLC consistent; the file's previous close must match Yahoo's last close within 1% (else
  "corporate action?" → not filled). NSE series EQ preferred (then BE/BZ).
- indices: NSE `ind_close_all_DDMMYYYY.csv` for Nifty 50, Nifty Bank, India VIX (`close_source: "nse_index_close"`,
  prev close = close − points change, checked against Yahoo's previous bar within 0.5%). Sensex has no NSE source.
- Fails soft: a 403 / timeout / missing row leaves the bar UNKNOWN; the UNKNOWN reason lists what was tried
  (e.g. `…; bhavcopy: nse_full:http_403, nse_udiff:http_403, bse_udiff:http_403`). `report.close_fallback.files[]`
  records every file fetched. Kill switch: env `BHAVCOPY_FALLBACK=0`.
- Reachability from the box on 2026-10-06 (browser UA + Referer; also without Referer): all **200** —
  NSE sec_bhavdata_full (5 Oct, 3,524 rows), NSE UDiFF zip (5 Oct and 1 Oct), NSE ind_close_all (5 Oct, 1 Oct),
  BSE UDiFF CSV (5 Oct). The files had the rows Yahoo lacked (KOTAKBANK 416.00, MARUTI 11532.00, NTPC 321.80,
  Nifty 50 22555.75 on 5 Oct). The earlier "403 from cloud IPs" note (2026-09-25) applied to other NSE endpoints.
  Not testable from Vercel directly: check `close_fallback.files[]` in the first stored v3.1 report that needed it.
- Live check 2026-10-06 09:08 IST (`report-diagnose.ts 2026-10-06`, no Redis writes): Yahoo still served null 5 Oct rows
  for the same 15 stocks; all 15 were filled from `sec_bhavdata_full_05102026.csv` (close_sources yahoo 61 / nse_bhavcopy 15),
  status complete. By then Yahoo had the 5 Oct index bars. Note: under risk_v3, KOTAKBANK (416) is a hold anyway
  (swing-high resistance 420.5 caps T1 at 0.5R), so it would not be in the Top 10 even with the bar.

**4. Stale labels.** v3.1 index rows older than based_on_close get `stale: true` and
`as_of_label: "Index data as of 1 Oct (Yahoo had no 5 Oct bar)"`, plus `market_overview.data_as_of_note`;
filled rows get `"NSE official index close for 5 Oct (Yahoo had no 5 Oct bar)"`. The headline says
"Nifty 50 data as of 1 Oct (…): last close X — not a 5 Oct number" instead of "closed at". The UI computes the
same label at render time for older stored reports. Stocks with an older bar are never ranked (UNKNOWN).

**Tests** (lib suite, mocked Yahoo null rows + mocked official files, small universe):
P3.1 partial → `upgrade_no_improvement` → `upgraded_v2_complete` (v1 kept, both verify from stored inputs, /latest serves v2);
P3.2 complete never overwritten (re-run noop, `putReportUpgrade` → `base_complete`, `putReportOnce` false, eod retry noop);
P3.3 stale index label + headline; P3.4 bhavcopy/index-close fill (exact date, tagged; wrong-date row and prev-close
mismatch rejected); P1.8e stored report_v3 still verifies. HTTP suite: P3.1a versions envelope, P3.1b partial lists
missing bars, P3.1c `?version=1`, P3.3a stale index rows labelled (v3.1 reports).

Ops check after a gap day: `GET /api/report/latest` → `report_version`, `versions[]`, `report.incomplete`,
`report.data_fills`, `report.close_fallback`. Manual retry (same day): `curl -H "Authorization: Bearer $CRON_SECRET"
https://nse-stock-lab.vercel.app/api/cron/premarket-retry`.

Shipped in `4b53971` (Vercel success). The stored 2026-10-06 report (report_v2, `complete`) stays as is — a
complete report is never superseded; on /report its 1 Oct index rows are now labelled at render time
("Index data as of 1 Oct (Yahoo had no 5 Oct bar)"). The first v3.1 report is the 2026-10-07 one.

## 2026-10-08: report_v3.2 — Other buys (₹1000+), deep-dive back-fill, Watch for breakout
Trigger: the 2026-10-08 report (based on the 7 Oct close, report_v3.1) had 1 buy (SBILIFE, ₹1726.1), so the
Top 10 under ₹1000 was empty, the deep dive was empty and the buy was never named. That stored report stays as is
(write-once); /report renders it without the new cards.

**Method** `report_v3.2|risk_v3|atr_piecewise_T1_T2_v2`. Gates / levels unchanged (risk_v3). New sections are added
only when `coverageRules(method_version)` (≥ 3.2); stored v1/v2/v3/v3.1 reports re-verify byte-for-byte with their
own shape (P1.8c–f) and the UI treats missing sections as absent (no card, nothing faked).

- **`sections.other_buys_1000_plus`** — every buy-rated name closing at ₹1000+: same gates and R:R floor as the
  Top 10, no price cap, max 2 per sector (`diversifyPicks`, verified funda first), never padded. Each item = a
  Top-10-shaped pick (entry, SL, T1, T2, `rr_t1`, `rr_t2`, `rr_plain`, confidence, sector, flags such as
  `funda_unknown`) + `reasons_plain[]` (top 3). Names over the sector cap are named in `sector_capped[]` + note.
  The news pass now also covers the top 6 ₹1000+ buys.
- **Deep dive back-fill** — Top 10 ranks 1–3 first; if fewer than 3, filled from the full buy set at any price
  (incl. under ₹50) by the existing ranking (verified funda first → `diversifiedPickScore` → listed Other-buys
  rank → ticker). No duplicates. Each item carries `source` (`top10` | `other_buys` | `buy_set`) and
  `source_label` ("from Other buys ₹1000+ (#1)", "from the full buy set (under ₹50)", …).
- **`sections.breakout_watch`** (always present in v3.2, may be empty with a note) — near-misses only: verdicts
  that would be buys except resistance under entry + 1R caps T1 (`rr_below_1r`, reason "Resistance at ₹X caps…"),
  close ₹50+. Trigger = the nearest swing high / 20- / 50-day high above the close that, once cleared by a daily
  close, leaves no resistance under 1R (`breakoutWatchFor` re-runs `deriveLevels(…, "rr_floor_v3")` with entry at
  each level; `levels_cleared[]` lists the ones passed). `if_breakout` = the same risk_v3 plan from the trigger
  (today's ATR, supports, resistance above) or `null` + `if_breakout_note` when it cannot be computed. Ranked by
  `distance_r` = (trigger − close) / R (R = entry − SL today; `distance_atr` shown too), then ticker; max 6
  (`BREAKOUT_WATCH_MAX`), `n_candidates` = all near-misses. Label: "watch only — not a buy, no paper buy"; items
  have no `action` field and never feed paper trading.
- **Final summary** headline names the Other buys, deep-dive sources and breakout triggers; `counts` add
  `top10`, `other_buys`, `deep_dive`, `breakout_watch`; `final_summary.other_buys[]`, `breakout_watch[]`.
- `/report` (`LiveReport.tsx`): new cards "Other buys (₹1000+)" and "Watch for breakout (not buys)", deep-dive
  source line. Cron route response adds `other_buys` / `breakout_watch` counts.
- `scripts/report-diagnose.ts` prints a "Coverage" block (Top 10, Other buys with levels, deep-dive sources,
  breakout watch with triggers, headline). `--inputs` accepts the `{report, inputs}` file it writes.

**Tests.** Lib: P1.8f stored v3.1 re-verifies, no v3.2 sections; P4.1 ₹1000+ buy → Other buys + deep dive
(synthetic, Top 10 empty); P4.2 back-fill order / no duplicates / 2 per sector; P4.3 breakout watch never
buy-labelled, trigger > close, ranked, capped; P4.4 banned words (incl. "watch for breakout") + banner +
determinism. HTTP: P4.0 pre-3.2 report has the new sections absent; P4.1h–P4.4h on v3.2 reports.
Banned list (`/\brecommendation\b/ /\btips?\b/ /\badvice\b/ /target price/ /guaranteed/ /sure-shot/ /will hit/
/expected return/ /accuracy proves/`) has nothing that matches "watch for breakout"; the new text avoids "will hit"
/ "target price".

**Local rebuild 2026-10-08** (`report-diagnose.ts 2026-10-08`, live fetch, no Redis; based on the 7 Oct close,
complete, 76/76 bars): 1 buy · Top 10 under ₹1000: 0 · Other buys ₹1000+: 1 — SBILIFE (Finance) close/entry
1726.1, SL 1687.6, T1 1774.4 (swing high), T2 1798.9 (swing high), R:R 1.25 / 1.89, "Risk ₹38.5 to stop, ₹48.3 to
T1 (1.3R), ₹72.8 to T2 (1.9R)", conf 5, funda=watch (verified), 2 sh ≈ ₹3,452 · Deep dive: 1 — SBILIFE (from Other
buys) · Watch for breakout: 6 of 8 near-misses — HEROMOTOCO > ₹5073.4 (0.59R), AXISBANK > ₹1258.9 (0.68R),
DRREDDY > ₹1222 (0.79R), KOTAKBANK > ₹453.2 (1.02R), BANKBARODA > ₹239.46 (1.13R), HDFCLIFE > ₹567.4 (1.49R);
not shown: ICICIBANK, BHARTIARTL.
