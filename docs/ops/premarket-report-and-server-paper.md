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
| GHA backup | `17 2 * * 1-5` / `37 12 * * 1-5` | 07:47 / 18:07 (+GitHub delay) | same endpoints, `?source=gha&finalize_if_partial=1` |

NSE holidays (`web/src/data/nse-holidays-2026.json`) → `holiday_skip`. Double runs are blocked by a
Redis lease `job:lock:<job>:<date>` (SET NX EX 360) and completed runs are recorded at `job:run:<job>:<date>`.

The GitHub Actions workflow is at `docs/ops/cron-backup.yml`: the push token lacked the `workflow`
scope, so copy it to `.github/workflows/cron-backup.yml` via the GitHub web UI (Add file → Create new file).

## Tamper-proofing (Redis)
- `pos:<id>`, `fc:<id>` (forecast + points + input_hash + bundle_hash), `report:<date>`, `act:<id>:<d>`,
  `ev:<id>:<type>` are written once with SET NX. No code path rewrites them.
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
node scripts/acceptance.http.mjs https://nse-stock-lab.vercel.app                 # production (read-only checks)
```
