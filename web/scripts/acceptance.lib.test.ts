/**
 * Library-level acceptance tests (brief §2.10 / §3.10).
 * Run: node scripts/mock-upstash.mjs 8079 &   (mock Redis, local only)
 *      UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 UPSTASH_REDIS_REST_TOKEN=dev \
 *      npx tsx --tsconfig tsconfig.json scripts/acceptance.lib.test.ts
 * Uses live Yahoo/screener for the generation tests (never invents data).
 */
import { expectedReportSession, isTradingDay, prevTradingDay } from "../src/lib/marketCalendar";
import { generateReport, verifyReport, reportUniverse, verdictFor, assembleReport, METHOD_VERSION } from "../src/lib/report";
import { mergeVerdict } from "../src/lib/risk";
import type { TechLane } from "../src/lib/types";
import { getReport, getReportInputs, putReportOnce, listReportDates } from "../src/lib/reportStore";
import { reportSessions, runPremarket, serveLatest } from "../src/lib/reportService";
import { acquireLease, getJobRun } from "../src/lib/jobs/lock";
import { markForecastPoints, buildForecastBundle, computeScoreSummary } from "../src/lib/forecast";
import { putActualOnce, writeMark, freezePosition, loadViews, scoreViews, type ServerPosition, type ServerForecast } from "../src/lib/paperServer";
import { finalizeMarksAndScore, runProvisionalMarks } from "../src/lib/jobs/mark";
import { mustRedis } from "../src/lib/redis";
import { SEBI_BANNER } from "../src/lib/universe";
import type { ReportV1 } from "../src/lib/reportTypes";

const results: { id: string; ok: boolean; info?: string }[] = [];
function check(id: string, ok: boolean, info?: string) {
  results.push({ id, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${info ? ` — ${info}` : ""}`);
}
const ist = (s: string) => new Date(`${s}+05:30`);

export const BANNED = [/\brecommendation\b/i, /\btips?\b/i, /\badvice\b/i, /target price/i, /guaranteed/i, /sure-shot/i, /will hit/i, /expected return/i, /accuracy proves/i];
export function bannedHits(obj: unknown): string[] {
  const text = JSON.stringify(obj).split(SEBI_BANNER).join(" ");
  return BANNED.filter((re) => re.test(text)).map((re) => String(re));
}

async function main() {
  const r = mustRedis();
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}`, { method: "POST", headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }, body: JSON.stringify(["FLUSHALL"]) });

  // §2.10 #1 calendar
  check("P1.1 calendar", !isTradingDay("2026-10-02") && !isTradingDay("2026-09-26") && prevTradingDay("2026-10-05") === "2026-10-01" && expectedReportSession(ist("2026-10-02T10:00:00")) === "2026-10-01");

  // Generate a real report for today's session (based on prior close)
  const forSession = "2026-09-25";
  const t0 = Date.now();
  const gen = await generateReport({ for_session: forSession, prev: null });
  const rep = gen.report;
  console.log(`  generated ${rep.key} status=${rep.status} in ${Date.now() - t0} ms, unknowns=${rep.unknowns.length}`);

  // #5 freshness
  const bars = Object.values(gen.inputs.symbols).map((s) => s.bar?.date).filter(Boolean) as string[];
  const idx = gen.inputs.indices.map((i) => i.bar_date).filter(Boolean) as string[];
  check("P1.5 freshness", [...bars, ...idx].every((d) => d <= rep.based_on_close) && ![...bars, ...idx].includes(forSession), `based_on_close=${rep.based_on_close}, ${bars.length} symbol bars`);

  // #8 determinism
  const v = verifyReport(rep, JSON.parse(JSON.stringify(gen.inputs)), null);
  check("P1.8 determinism", v.ok, v.recomputed_hash.slice(0, 12));

  // #11 banned words (report JSON; the SEBI banner string itself is whitelisted)
  const hits = bannedHits(rep);
  check("P1.11 banned words + banner", hits.length === 0 && rep.sebi_banner === SEBI_BANNER, hits.join(","));

  // #13 top10 constraints
  const t10 = rep.sections.top10_under_1000.items;
  const sectorCounts: Record<string, number> = {};
  t10.forEach((p) => (sectorCounts[p.sector || "?"] = (sectorCounts[p.sector || "?"] || 0) + 1));
  check("P1.13 top10 constraints", t10.length <= 10 && t10.every((p) => p.cmp < 1000 && p.cmp >= 50) && Object.values(sectorCounts).every((n) => n <= 2), `${t10.length} items`);
  const unknownTickers = new Set(rep.unknowns.filter((u) => u.lane === "tech").map((u) => u.ticker));
  const inSections = [...t10.map((p) => p.ticker), ...rep.sections.avoids5.items.map((a) => a.ticker), ...rep.sections.penny_under_50.items.map((p) => p.ticker)];
  check("P1.12a sections non-empty & no UNKNOWN names ranked", inSections.length > 0 && !inSections.some((t) => unknownTickers.has(t)), `top10=${t10.length} avoids=${rep.sections.avoids5.items.length} penny=${rep.sections.penny_under_50.items.length}`);

  // #14 funda UNKNOWN honesty (report_v2): a Screener data gap never becomes "fail"/avoid by itself,
  // is flagged funda_unknown, shown as UNKNOWN in the deep dive, and never estimated.
  const gapFunda = { fields: { funda_quality: "fail", red_flags: ["Heavy unknowns on PE/ROE/D-E"] }, sources: [], note: "Screener unavailable (screener_429) — gaps left unknown" };
  const buyRow = Object.values(gen.inputs.symbols).find((s) => s.tech && verdictFor(s)?.action === "buy");
  let gapOk = true;
  let gapInfo = "no buy row today (vacuous)";
  if (buyRow) {
    const g = { ...buyRow, funda: gapFunda };
    const vNow = verdictFor(g)!;
    const v1 = verdictFor(g, "report_v1|risk_v1|atr_piecewise_T1_T2_v1")!;
    gapOk = vNow.action === "buy" && !!vNow.risk_flags?.includes("funda_unknown") && !vNow.risk_flags?.includes("funda_quality=fail") && v1.action !== "buy";
    gapInfo = `${buyRow.ticker}: v3=${vNow.action}/conf${vNow.confidence_1_10} v1=${v1.action}`;
  }
  const deepOk = rep.sections.deep_dive_top3.items.every((d) => !d.risk_flags.includes("funda_unknown") || d.funda.funda_quality === "UNKNOWN");
  const noFailPicks = t10.every((p) => !p.risk_flags.includes("funda_quality=fail"));
  check("P1.14 funda gap → UNKNOWN (not avoid), flagged, never estimated", gapOk && deepOk && noFailPicks, gapInfo);

  // #8c stored v1 reports still verify under v1 rules
  const asV1 = assembleReport(gen.inputs, null, { lanes: rep.lanes, unknowns: rep.unknowns, partial: rep.status === "partial", generated_at: rep.generated_at, elapsed_ms: rep.timing.elapsed_ms, scan_deadline_ms: rep.timing.scan_deadline_ms, method_version: "report_v1|risk_v1|atr_piecewise_T1_T2_v1" });
  check("P1.8c v1 report re-verifies with v1 rules", verifyReport(asV1, JSON.parse(JSON.stringify(gen.inputs)), null).ok && asV1.method_version.startsWith("report_v1|"));

  // #8d stored v2 reports (legacy ATR levels, T1≈0.83R) still verify under v2 rules
  const V2 = "report_v2|risk_v2|atr_piecewise_T1_T2_v1";
  const asV2 = assembleReport(gen.inputs, null, { lanes: rep.lanes, unknowns: rep.unknowns, partial: rep.status === "partial", generated_at: rep.generated_at, elapsed_ms: rep.timing.elapsed_ms, scan_deadline_ms: rep.timing.scan_deadline_ms, method_version: V2 });
  const v2Picks = asV2.sections.top10_under_1000.items;
  check(
    "P1.8d v2 report re-verifies with v2 rules (legacy levels, no v3 fields)",
    verifyReport(asV2, JSON.parse(JSON.stringify(gen.inputs)), null).ok && v2Picks.every((p) => !("rr_plain" in p)) && !("rr_capped" in asV2.sections.top10_under_1000) && rep.method_version === METHOD_VERSION && METHOD_VERSION.startsWith("report_v3|"),
    `v2 picks=${v2Picks.length} r_r=${[...new Set(v2Picks.map((p) => p.r_r))].join("/")}`
  );

  // #15 R:R floor (risk_v3) on every live symbol: no buy with T1 < 1R or T2 < 1.8R;
  // real resistance under entry + 1R → never a buy; r_r = T1 R:R.
  const rrBad: string[] = [];
  let nBuy = 0;
  let nCapped = 0;
  for (const s of Object.values(gen.inputs.symbols)) {
    if (!s.tech) continue;
    const v = verdictFor(s);
    if (!v || v.insufficient_data || v.entry == null || v.sl == null) continue;
    const R = v.entry - v.sl;
    if (v.action === "buy") {
      nBuy++;
      if (!(v.targets[0] >= v.entry + R - 1e-6 && v.targets[1] >= v.entry + 1.8 * R - 1e-6 && (v.rr_t1 ?? 0) >= 1 && (v.rr_t2 ?? 0) >= 1.8 && v.r_r === v.rr_t1 && v.resistance_cap == null)) rrBad.push(`${s.ticker}:buy ${v.r_r}/${v.rr_t2}`);
    }
    if (v.resistance_cap) {
      nCapped++;
      if (v.action === "buy" || !(v.resistance_cap.price < v.entry + R)) rrBad.push(`${s.ticker}:cap`);
    }
  }
  const picksOk = t10.every((p) => (p.rr_t1 ?? 0) >= 1 && (p.rr_t2 ?? 0) >= 1.8 && typeof p.rr_plain === "string" && /to T1 \(\d\.\dR\)/.test(p.rr_plain!));
  check("P1.15 R:R floor: buys T1 ≥ 1R, T2 ≥ 1.8R; resistance < 1R never a buy", rrBad.length === 0 && picksOk, `buys=${nBuy} capped=${nCapped} T1 R:R in top10=${[...new Set(t10.map((p) => p.rr_t1))].join("/") || "—"}${rrBad.length ? " BAD " + rrBad.slice(0, 5).join(",") : ""}`);

  // #15b synthetic tape: same stop, three resistance layouts
  const synth = (res: number[], h20: number | "UNKNOWN" = "UNKNOWN"): TechLane => ({
    ticker: "SYNTH", yahoo_symbol: "SYNTH.NS", unknowns: [], sources: [], ts: "",
    fields: { cmp: 100, atr_14: 2, support_levels: [95], resistance_levels: res, resistance_swing: res, high_20d: h20, high_50d: "UNKNOWN", structure: "HH_HL", breakout_state: "none", rsi_14: 58, price_vs_dma: "above", dma_20: 97, dma_50: 95, dma_200: 90, timeframe: "1D" },
  });
  const pass = { fields: { funda_quality: "pass", pe_ttm: 15, roe_pct: 18, debt_equity: 0.2 } };
  const free = mergeVerdict(synth([]), { funda: pass }); // R = 4.8 → T1 104.8, T2 108.64
  const atRes = mergeVerdict(synth([106.5, 112]), { funda: pass }); // swing 106.5 in [1R,1.8R) → T1; 112 ≤ 3R → T2
  const capped = mergeVerdict(synth([102]), { funda: pass }); // 102 < 104.8 → caps
  const capped20 = mergeVerdict(synth([], 103), { funda: pass }); // prior 20-day high caps
  const legacy = mergeVerdict(synth([102]), { funda: pass, levels: "atr_v2" });
  check(
    "P1.15b R:R floor synthetic (floor / resistance target / cap → hold)",
    free.action === "buy" && free.targets[0] === 104.8 && free.targets[1] === 108.64 && free.r_r === 1 && free.rr_t2 === 1.8 &&
      atRes.action === "buy" && atRes.targets[0] === 106.5 && atRes.targets[1] === 112 && atRes.t1_basis === "swing high" &&
      capped.action === "hold" && /^Resistance at ₹102 \(swing high\) caps upside below 1R/.test(capped.reasons![0]) && capped.r_r! < 1 && capped.shares == null &&
      capped20.action === "hold" && capped20.resistance_cap?.source === "20-day high" &&
      legacy.action === "buy" && legacy.r_r === 0.83,
    `${free.rr_plain} | ${atRes.rr_plain} | ${capped.reasons![0]}`
  );

  // #16 paper method v2: new forecasts carry the v2 id; scores never pool v1 and v2
  const bNew = buildForecastBundle({ action: "buy", entry: 100, sl: 95.2, targets: [104.8, 108.64], atr_14: 2, checkDays: [7] })!;
  const mkView = (method: "atr_piecewise_T1_T2_v1" | "atr_piecewise_T1_T2_v2", ape: number) => ({
    server: { verified: true },
    forecast: { method, status: "ok", points: [{ dayOffset: 7, predictedClose: 100, targetDate: "2026-09-10", actualClose: 100, actualSessionDate: "2026-09-10", ape_pct: ape, within_1atr: true, within_2pct: true, within_0_5r: true, direction_ok: true, status: "scored" }] },
  });
  const sv = scoreViews([mkView("atr_piecewise_T1_T2_v1", 4), mkView("atr_piecewise_T1_T2_v2", 1)] as unknown as Parameters<typeof scoreViews>[0]);
  check(
    "P2.13 forecast method v2 + scores grouped by method",
    bNew.method === "atr_piecewise_T1_T2_v2" && sv.method === "atr_piecewise_T1_T2_v2" && sv.verified.n_scored === 1 && sv.verified.mape_pct === 1 && sv.by_method.atr_piecewise_T1_T2_v1.verified.mape_pct === 4 && sv.by_method.atr_piecewise_T1_T2_v1.verified.n_scored === 1,
    `v1 MAPE ${sv.by_method.atr_piecewise_T1_T2_v1.verified.mape_pct} · v2 MAPE ${sv.verified.mape_pct}`
  );

  // Store + P2.2 immutability (SET NX: second insert refused, content unchanged)
  check("store report", await putReportOnce(rep, gen.inputs));
  const tampered = { ...rep, sections: { ...rep.sections, top10_under_1000: { items: [], n_eligible: 0 } } } as ReportV1;
  const second = await putReportOnce(tampered, gen.inputs);
  const after = await getReport(forSession);
  check("P2.2a report write-once", !second && after?.report_hash === rep.report_hash);
  const storedInputs = await getReportInputs(forSession);
  check("P1.8b determinism from STORED inputs", !!storedInputs && verifyReport(after!, storedInputs!, null).ok);

  // #3 idempotency / #10 cron replay: runPremarket twice → exists/noop, one report
  const a1 = await runPremarket({ source: "test", now: ist("2026-09-25T06:45:00"), forSession });
  const a2 = await runPremarket({ source: "test", now: ist("2026-09-25T06:46:00"), forSession });
  const lease = await acquireLease("premarket-report", "2026-09-26x", 60);
  const lease2 = await acquireLease("premarket-report", "2026-09-26x", 60);
  check("P1.3 idempotency (noop + lock)", a1.action === "exists" && a2.noop === true && !!lease && lease2 === null && (await listReportDates()).filter((d) => d === forSession).length === 1, `${a1.action} → ${a2.action}`);
  await lease?.();

  // #4 holiday: 2026-10-02 06:45 IST
  const oct1 = { ...rep, key: "report:2026-10-01", for_session: "2026-10-01", based_on_close: "2026-09-30", generated_at: "2026-10-01T01:10:00.000Z" } as ReportV1;
  await putReportOnce(oct1, gen.inputs);
  const hol = await runPremarket({ source: "test", now: ist("2026-10-02T06:45:00"), forSession: "2026-10-02" });
  const jr = await getJobRun("premarket-report", "2026-10-02");
  const hl = await serveLatest(ist("2026-10-02T06:50:00"));
  const hb = hl.body as { report: ReportV1; holiday?: { name: string }; stale: boolean };
  check("P1.4 holiday", hol.action === "holiday_skip" && jr?.status === "holiday_skip" && !(await getReport("2026-10-02")) && hb.report.for_session === "2026-10-01" && hb.holiday?.name === "Mahatma Gandhi Jayanti" && hb.stale === false, `${hb.holiday?.name}`);

  // #17 expected_session (fix 2026-10-05): weekend, Monday before the cron, Monday after the cron
  type Env = { report: ReportV1; stale: boolean; expected_session: string; due_session: string; served: { requested_session: string } };
  check("P1.17a holiday 10-02 → expected next session", (hb as unknown as Env).expected_session === "2026-10-05", (hb as unknown as Env).expected_session);
  const wk = (await serveLatest(ist("2026-10-03T10:00:00"))).body as unknown as Env;
  check("P1.17b weekend (Sat 10-03)", wk.expected_session === "2026-10-05" && wk.report.for_session === "2026-10-01" && wk.stale === false, `expected=${wk.expected_session} for=${wk.report.for_session} stale=${wk.stale}`);
  const monPre = (await serveLatest(ist("2026-10-05T05:30:00"))).body as unknown as Env;
  check("P1.17c Monday before the cron (05:30)", monPre.expected_session === "2026-10-05" && monPre.report.for_session === "2026-10-01" && monPre.stale === false, `expected=${monPre.expected_session} for=${monPre.report.for_session} stale=${monPre.stale}`);
  const oct5 = { ...rep, key: "report:2026-10-05", for_session: "2026-10-05", based_on_close: "2026-10-01", generated_at: "2026-10-05T01:30:00.000Z" } as ReportV1;
  await putReportOnce(oct5, gen.inputs);
  const monPost = (await serveLatest(ist("2026-10-05T08:53:00"))).body as unknown as Env;
  check("P1.17d Monday after the cron (08:53)", monPost.expected_session === "2026-10-05" && monPost.report.for_session === "2026-10-05" && monPost.served.requested_session === "2026-10-05" && monPost.stale === false, `expected=${monPost.expected_session} for=${monPost.report.for_session} stale=${monPost.stale}`);
  check("P1.17e reportSessions table", JSON.stringify([reportSessions(ist("2026-09-28T08:53:00")), reportSessions(ist("2026-09-27T12:00:00")), reportSessions(ist("2026-09-28T05:59:00"))]) === JSON.stringify([{ expected: "2026-09-28", due: "2026-09-28" }, { expected: "2026-09-28", due: "2026-09-25" }, { expected: "2026-09-28", due: "2026-09-25" }]));

  // #9 stale: latest 2026-09-24, clock 2026-09-25 09:30 IST, today's generation in progress (lease held)
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}`, { method: "POST", headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }, body: JSON.stringify(["FLUSHALL"]) });
  const sep24 = { ...rep, key: "report:2026-09-24", for_session: "2026-09-24", based_on_close: "2026-09-23", generated_at: "2026-09-24T01:10:00.000Z" } as ReportV1;
  await putReportOnce(sep24, gen.inputs);
  const held = await acquireLease("premarket-report", "2026-09-25", 60);
  const st = await serveLatest(ist("2026-09-25T09:30:00"));
  const sb = st.body as { report: ReportV1; stale: boolean; age_hours: number; served: { source: string }; expected_session: string };
  check("P1.9 stale", sb.stale === true && sb.age_hours > 0 && sb.report.for_session === "2026-09-24" && sb.expected_session === "2026-09-25", `age_hours=${sb.age_hours} served=${sb.served?.source} expected=${sb.expected_session}`);
  await held?.();

  // #6 partial path: 10 symbols → 429 (last 10 in the sorted universe so the breaker's first-20 window isn't hit)
  const uni = reportUniverse();
  const fail = new Set(uni.slice(-10).map((t) => `${t}.NS`));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    const m = u.match(/\/v8\/finance\/chart\/([^?]+)/);
    if (m && fail.has(decodeURIComponent(m[1]))) return new Response("Too Many Requests", { status: 429 });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const gp = await generateReport({ for_session: forSession, prev: null });
  globalThis.fetch = realFetch;
  const failedT = [...fail].map((s) => s.replace(".NS", ""));
  const unk = new Set(gp.report.unknowns.filter((u) => u.reason === "yahoo_429").map((u) => u.ticker));
  const secNames = [...gp.report.sections.top10_under_1000.items.map((p) => p.ticker), ...gp.report.sections.deep_dive_top3.items.map((p) => p.ticker), ...gp.report.sections.avoids5.items.map((p) => p.ticker), ...gp.report.sections.penny_under_50.items.map((p) => p.ticker)];
  check("P1.6 partial path", gp.report.status === "partial" && failedT.every((t) => unk.has(t)) && !secNames.some((t) => failedT.includes(t)), `unknown(429)=${unk.size}`);

  // ---- Part 2 (lib level) ----
  // #6 holiday roll + sparse (calendar targets)
  const b = buildForecastBundle({ action: "buy", entry: 100, sl: 95, targets: [110, 118], atr_14: 2.5, checkDays: [2], filledAt: "2026-09-30T12:00:00+05:30" })!;
  const rolled = markForecastPoints(b, [
    { date: "2026-09-30", open: 100, high: 101, low: 99, close: 100 },
    { date: "2026-10-01", open: 100, high: 101, low: 99, close: 101 },
    { date: "2026-10-05", open: 101, high: 104, low: 100, close: 103 },
  ], "2026-10-06", { finalThrough: "2026-10-05" });
  const sparse = markForecastPoints(b, [{ date: "2026-09-30", open: 100, high: 101, low: 99, close: 100 }], "2026-10-09", { finalThrough: "2026-10-08" });
  check("P2.6 holiday roll + sparse", b.points[0].targetDate === "2026-10-02" && rolled.points[0].actualSessionDate === "2026-10-05" && rolled.points[0].status === "scored" && sparse.points[0].status === "sparse");

  // #7 split: synthetic 50% gap → excluded from n
  const sp = markForecastPoints(buildForecastBundle({ action: "buy", entry: 100, sl: 95, targets: [110, 118], atr_14: 2.5, checkDays: [3], filledAt: "2026-09-21T12:00:00+05:30" })!, [
    { date: "2026-09-21", open: 100, high: 101, low: 99, close: 100 },
    { date: "2026-09-22", open: 50, high: 51, low: 49, close: 50 },
    { date: "2026-09-24", open: 50, high: 51, low: 49, close: 51 },
  ], "2026-09-28", { finalThrough: "2026-09-25" });
  check("P2.7 split flag excluded", sp.points[0].corporate_action_suspect === true && computeScoreSummary(sp.points).n_scored === 0);

  // #2 immutability on paper keys: actuals + final marks write-once
  const act = { status: "scored" as const, actual_session_date: "2026-09-24", actual_close: 10, ape_pct: 1, within_1atr: true, within_2pct: true, within_0_5r: true, direction_ok: true, trading_day_index: 3, mark_state: "final" as const, scored_at: new Date().toISOString() };
  const w1 = await putActualOnce("pp_test", 7, act);
  const w2 = await putActualOnce("pp_test", 7, { ...act, actual_close: 999 });
  const stored = JSON.parse(String(await r.get("act:pp_test:7")));
  const mk = { symbol: "TEST.NS", session_date: "2026-09-24", open: 1, high: 1, low: 1, close: 10, adjclose: 10, volume: 1, flags: [], fetched_at: "", finalized_at: "" };
  await writeMark({ ...mk, state: "final" });
  const kept = await writeMark({ ...mk, close: 11, state: "provisional" });
  check("P2.2b actuals + final marks immutable", w1 && !w2 && stored.actual_close === 10 && kept === "kept_final");

  // #3 + #5: provisional run never scores; intraday (now 12:xx IST) writes no mark for today
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const pos: ServerPosition = { id: "pp_itc_test", user_id: "u_test", idempotency_key: "test-key-1", ticker: "ITC", yahoo_symbol: "ITC.NS", side: "long", qty: 1, entry_price: 300, sl: 290, targets: [320, 330], atr_14: 5, budget_inr: 300, sector: "FMCG", filled_at: "2026-09-10T06:00:00Z", fill_session_date: "2026-09-10", fill_basis: "last_close", client_filled_at: null, client_entry: null, verdict_snapshot: null, provenance: "server", created_at: "2026-09-10T06:00:00Z" };
  const fc: ServerForecast = { position_id: pos.id, user_id: "u_test", yahoo_symbol: "ITC.NS", method_version: "atr_piecewise_T1_T2_v1", status: "ok", skip_reason: null, params: { entry: 300, sl: 290, t1: 320, t2: 330, atr_14: 5, R: 10, d_T1: 5, d_T2: 14, scale: 0.7 }, checkDays: [5, 14, 30], points: [{ dayOffset: 5, targetDate: "2026-09-15", predictedClose: 305 }, { dayOffset: 14, targetDate: "2026-09-24", predictedClose: 314 }, { dayOffset: 30, targetDate: "2026-10-10", predictedClose: 321 }], input_hash: "x", bundle_hash: "y", provenance: "server_frozen", client_consistent: null, created_at: pos.created_at };
  await freezePosition(pos, fc);
  const prov = await runProvisionalMarks(new Date());
  const actsAfterProv = (await r.keys("act:pp_itc_test:*")) as string[];
  const todayMark = await r.get(`mark:ITC.NS:${today}`);
  check("P2.5 intraday not marked / P2.3 provisional never scores", actsAfterProv.length === 0 && todayMark == null, JSON.stringify(prov).slice(0, 120));
  const fin1 = await finalizeMarksAndScore(new Date());
  const views1 = await loadViews([pos.id]);
  const fin2 = await finalizeMarksAndScore(new Date());
  const views2 = await loadViews([pos.id]);
  const sts = views1[0].forecast!.points.map((p) => `${p.dayOffset}:${p.status}@${p.actualSessionDate}`).join(" ");
  check("P2.10 replay: no duplicate actuals, same score_summary", fin2.scored === 0 && JSON.stringify(scoreViews(views1)) === JSON.stringify(scoreViews(views2)), `run1 scored=${fin1.scored} sparse=${fin1.sparse}; run2 scored=${fin2.scored}; ${sts}`);
  check("P2.12 score rebuild identical", JSON.stringify(scoreViews(await loadViews([pos.id]))) === JSON.stringify(scoreViews(views2)));

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
