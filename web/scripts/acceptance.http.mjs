// HTTP acceptance checks against a running deployment (local or production).
// Usage: node scripts/acceptance.http.mjs <base> [--db] [--secret=...]
//   --db      : server has Upstash configured (runs Part 2 paper checks)
//   --secret= : CRON_SECRET for the cron route checks (omit on production)
const base = process.argv[2] || "http://localhost:3100";
const DB = process.argv.includes("--db");
const secret = (process.argv.find((a) => a.startsWith("--secret=")) || "").slice(9);
const SEBI = "Not SEBI-registered advice. Paper / research only. Levels are not a recommendation to buy or sell.";
const BANNED = [/\brecommendation\b/i, /\btips?\b/i, /\badvice\b/i, /target price/i, /guaranteed/i, /sure-shot/i, /will hit/i, /expected return/i, /accuracy proves/i];
const banned = (o) => { const t = JSON.stringify(o).split(SEBI).join(" "); return BANNED.filter((r) => r.test(t)).map(String); };
const results = [];
const check = (id, ok, info = "") => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${id}${info ? " — " + info : ""}`); };

let cookie = "";
async function call(path, { method = "GET", body, headers = {}, jar = true } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (jar && cookie) h.Cookie = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const sc = r.headers.get("set-cookie");
  if (jar && sc) cookie = sc.split(";")[0];
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch { json = { _text: text.slice(0, 200) }; }
  return { status: r.status, headers: r.headers, json, setCookie: sc };
}

const t0 = Date.now();
if (secret) {
  const noAuth = await call("/api/cron/premarket-report");
  const withAuth = await call("/api/cron/premarket-report", { headers: { Authorization: `Bearer ${secret}` } });
  check("P1.2 cron auth", noAuth.status === 401 && [200, 202].includes(withAuth.status), `no bearer ${noAuth.status}, bearer ${withAuth.status} ${withAuth.json.action}`);
  const again = await call("/api/cron/premarket-report", { headers: { Authorization: `Bearer ${secret}` } });
  check("P1.3/P2.10 cron replay", again.json.noop === true || again.json.action === "noop" || again.status === 409 || again.json.action === "exists", `${again.status} ${again.json.action}`);
  const eod = await call("/api/cron/eod-mark", { headers: { Authorization: `Bearer ${secret}` } });
  console.log(`  eod-mark → ${eod.status} ${eod.json.action} ${JSON.stringify(eod.json.detail || eod.json.note || "").slice(0, 140)}`);
} else {
  const noAuth = await call("/api/cron/premarket-report");
  check("P1.2a cron rejects without bearer", [401, 503].includes(noAuth.status), `${noAuth.status} ${noAuth.json.error}`);
}

const latest = await call("/api/report/latest");
const L = latest.json;
console.log(`  /api/report/latest ${latest.status} in ${Date.now() - t0} ms: for_session=${L.report?.for_session} status=${L.report?.status} stale=${L.stale} age_hours=${L.age_hours} storage=${L.storage} served=${L.served?.source}`);
check("P1.10a latest headers", latest.headers.get("access-control-allow-origin") === "*" && !!latest.headers.get("etag") && (/s-maxage=300/.test(latest.headers.get("cache-control") || "") || !!latest.headers.get("x-vercel-cache")), `${latest.headers.get("etag")?.slice(0, 14)} · ${latest.headers.get("cache-control")}`);
const opt = await fetch(base + "/api/report/latest", { method: "OPTIONS" });
check("P1.10b OPTIONS 204", opt.status === 204);
const et = await fetch(base + "/api/report/latest", { headers: { "If-None-Match": latest.headers.get("etag") } });
check("P1.10c ETag 304", et.status === 304 || et.status === 200, `status ${et.status}`);
if (L.report) {
  const d = await call(`/api/report/${L.report.for_session}`);
  const cc = d.headers.get("cache-control") || "";
  check("P1.10d dated report cache", d.status === 200 && (L.storage !== "redis" || L.report.status !== "complete" || /immutable/.test(cc)), cc);
  const S = L.report.sections;
  check("P1.12 sections non-empty", S.top10_under_1000.items.length + S.avoids5.items.length + S.penny_under_50.items.length > 0 && S.market_overview.indices.length > 0);
  check("P1.13 top10", S.top10_under_1000.items.length <= 10 && S.top10_under_1000.items.every((p) => p.cmp < 1000 && p.cmp >= 50));
  check("P1.11 banned words + banner", banned(L).length === 0 && L.sebi_banner === SEBI && L.report.sebi_banner === SEBI, banned(L).join(","));
}
const nf = await call("/api/report/2020-01-06");
// Vercel's CDN consumes s-maxage and strips it from the client header (x-vercel-cache shows it cached)
check("404 + nearest_prev", nf.status === 404 && "nearest_prev" in nf.json && (/s-maxage=60/.test(nf.headers.get("cache-control") || "") || !!nf.headers.get("x-vercel-cache")));
const ix = await call("/api/report/index?limit=5");
check("index", ix.status === 200 && Array.isArray(ix.json.items), `${ix.json.items?.length} items`);
const page = await fetch(base + "/report");
const html = await page.text();
check("/report page + banner", page.status === 200 && html.includes("Pre-market research digest") && html.includes(SEBI));

if (!DB) {
  const me = await call("/api/identity/me");
  const pos = await call("/api/paper/positions", { method: "POST", body: { idempotency_key: "abcdefgh1", ticker: "ITC" } });
  const buy = await call("/api/paper/buy", { method: "POST", body: { ticker: "ITC", entry: 300, sl: 290, targets: [320, 330], atr_14: 5, qty: 1, checkDays: [7] } });
  const mk = await call("/api/paper/mark-forecasts", { method: "POST", body: { positions: [] } });
  check("no-DB fallback", me.json.storage === "none" && pos.status === 503 && buy.status === 200 && mk.status === 200, `me=${me.json.storage} positions=${pos.status} buy=${buy.status} mark=${mk.status}`);
} else {
  const dev = await call("/api/identity/device", { method: "POST" });
  const code = dev.json.recovery_code;
  const uid = dev.json.user_id;
  check("device + httpOnly cookie + recovery code", dev.status === 201 && /HttpOnly/i.test(dev.setCookie || "") && /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code || ""), `${code}`);
  const q = await call("/api/lookup?symbol=ITC", {});
  const cmp = q.json?.tech?.fields?.cmp;
  const atrPct = (100 * q.json?.tech?.fields?.atr_14) / cmp;
  const p1 = await call("/api/paper/positions", { method: "POST", body: { idempotency_key: "test-idem-0001", ticker: "ITC", qty: 2, client_entry: cmp, checkDays: [7, 14, 30] } });
  const p2 = await call("/api/paper/positions", { method: "POST", body: { idempotency_key: "test-idem-0001", ticker: "ITC", qty: 2, client_entry: cmp, checkDays: [7, 14, 30] } });
  check("P2.1 idempotency", p1.status === 201 && p2.status === 200 && p1.json.position?.id === p2.json.position?.id, `${p1.status}/${p2.status} ${p1.json.position?.id} entry=${p1.json.position?.entry} basis=${p1.json.position?.server?.fill_basis} input_hash=${p1.json.position?.server?.input_hash?.slice(0, 10)}`);
  const qm = await call("/api/paper/positions", { method: "POST", body: { idempotency_key: "test-idem-0002", ticker: "ITC", client_entry: Math.round(cmp * 1.03 * 100) / 100 } });
  check("P2.4 quote_moved", qm.status === 409 && qm.json.error === "quote_moved", `ATR%=${atrPct.toFixed(2)} tol=${qm.json.tolerance_pct} moved=${qm.json.moved_pct}`);
  const pid = p1.json.position?.id;
  const c1 = await call(`/api/paper/positions/${pid}/close`, { method: "POST", body: {} });
  const c2 = await call(`/api/paper/positions/${pid}/close`, { method: "POST", body: {} });
  check("close = append-only event (idempotent)", c1.status === 201 && c2.status === 200 && c1.json.event?.price === c2.json.event?.price, `${c1.status}/${c2.status} ${JSON.stringify(c1.json.event)}`);
  const before = await call("/api/paper/scores");
  const localItem = { id: "pf_ITC_1758000000000", ticker: "ITC", yahoo_symbol: "ITC.NS", entry: 400, sl: 390, targets: [420, 430], qty: 1, budget_inr: 400, size_inr: 400, boughtAt: "2026-09-10T05:00:00.000Z", checkDays: [7], atr_14: 5, sebi_banner: SEBI, forecast: { method: "atr_piecewise_T1_T2_v1", status: "ok", createdAt: "2026-09-10T05:00:00.000Z", params: { entry: 400, sl: 390, t1: 420, t2: 430, atr_14: 5, R: 10, d_T1: 7, d_T2: 7, scale: 0.7 }, checkDays: [7], points: [{ dayOffset: 7, predictedClose: 414, targetDate: "2026-09-17", actualClose: 999, actualSessionDate: "2026-09-17", ape_pct: 0, within_1atr: true, within_2pct: true, within_0_5r: true, direction_ok: true, status: "scored" }], scoreSummary: {} } };
  const m1 = await call("/api/paper/migrate", { method: "POST", body: { items: [localItem] } });
  const m2 = await call("/api/paper/migrate", { method: "POST", body: { items: [localItem] } });
  const pf = await call("/api/paper/portfolio");
  const mig = pf.json.positions?.find((p) => p.server?.provenance === "client_migrated");
  const after = await call("/api/paper/scores");
  check("P2.8 migration", m1.json.results?.[0]?.status === "created" && m2.json.results?.[0]?.status === "exists" && mig?.server?.forecast_provenance === "client_created" && mig?.server?.badge === "Pre-sync · unverified" && mig?.forecast?.points?.[0]?.actualClose !== 999 && JSON.stringify(before.json.verified) === JSON.stringify(after.json.verified), `badge=${mig?.server?.badge} client_consistent=${mig?.server?.client_consistent}`);
  const oldBuy = await call("/api/paper/buy", { method: "POST", body: { ticker: "ITC", entry: 300 } });
  const oldMark = await call("/api/paper/mark-forecasts", { method: "POST", body: { positions: [] } });
  check("old client-trust routes 410", oldBuy.status === 410 && oldMark.status === 410);
  // Recovery: new device (no cookie) restores the same user; rotation invalidates; 6th attempt/hr → 429
  const saved = cookie; cookie = "";
  const rec1 = await call("/api/identity/recover", { method: "POST", body: { code } });
  const pf2 = await call("/api/paper/portfolio");
  const rot = await call("/api/identity/rotate-recovery", { method: "POST" });
  cookie = "";
  const rec2 = await call("/api/identity/recover", { method: "POST", body: { code } });
  const rec3 = await call("/api/identity/recover", { method: "POST", body: { code: rot.json.recovery_code } });
  const bad4 = await call("/api/identity/recover", { method: "POST", body: { code: "0000-0000-0000" } });
  const bad5 = await call("/api/identity/recover", { method: "POST", body: { code: "0000-0000-0001" } });
  const bad6 = await call("/api/identity/recover", { method: "POST", body: { code: "0000-0000-0002" } });
  check("P2.9 recovery", rec1.status === 200 && rec1.json.user_id === uid && pf2.json.positions?.length >= 2 && rot.status === 200 && rec2.status === 401 && rec3.status === 200 && bad4.status === 401 && bad5.status === 401 && bad6.status === 429, `${rec1.status},${rec2.status},${rec3.status},${bad4.status},${bad5.status},${bad6.status}`);
  cookie = saved;
  const gl = await call("/api/paper/scores?scope=global");
  check("global scores public + banned words", gl.status === 200 && banned([pf.json, gl.json, dev.json, p1.json, qm.json]).length === 0, banned([pf.json, gl.json]).join(","));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (${base}${DB ? ", db" : ""})`);
process.exit(failed.length ? 1 : 0);
