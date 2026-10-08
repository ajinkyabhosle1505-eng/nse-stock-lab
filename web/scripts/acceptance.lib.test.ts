/**
 * Library-level acceptance tests (brief §2.10 / §3.10).
 * Run: node scripts/mock-upstash.mjs 8079 &   (mock Redis, local only)
 *      UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 UPSTASH_REDIS_REST_TOKEN=dev \
 *      npx tsx --tsconfig tsconfig.json scripts/acceptance.lib.test.ts
 * Uses live Yahoo/screener for the generation tests (never invents data).
 */
import { expectedReportSession, isTradingDay, prevTradingDay } from "../src/lib/marketCalendar";
import { generateReport, verifyReport, reportUniverse, verdictFor, assembleReport, buildSections, METHOD_VERSION, BREAKOUT_WATCH_MAX, type ReportInputs, type SymbolInput } from "../src/lib/report";
import { mergeVerdict } from "../src/lib/risk";
import type { TechLane } from "../src/lib/types";
import { getReport, getReportInputs, getReportVersion, listReportVersions, putReportOnce, putReportUpgrade, listReportDates } from "../src/lib/reportStore";
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
    verifyReport(asV2, JSON.parse(JSON.stringify(gen.inputs)), null).ok && v2Picks.every((p) => !("rr_plain" in p)) && !("rr_capped" in asV2.sections.top10_under_1000) && rep.method_version === METHOD_VERSION && METHOD_VERSION.startsWith("report_v3.2|"),
    `v2 picks=${v2Picks.length} r_r=${[...new Set(v2Picks.map((p) => p.r_r))].join("/")}`
  );

  // #8e stored report_v3 (pre-3.1) reports still verify, and carry none of the v3.1 fields
  const asV3 = assembleReport(gen.inputs, null, { lanes: rep.lanes, unknowns: rep.unknowns, partial: rep.status === "partial", generated_at: rep.generated_at, elapsed_ms: rep.timing.elapsed_ms, scan_deadline_ms: rep.timing.scan_deadline_ms, method_version: "report_v3|risk_v3|atr_piecewise_T1_T2_v2", version: 3 });
  check(
    "P1.8e v3 report re-verifies with v3 rules (no v3.1 fields)",
    verifyReport(asV3, JSON.parse(JSON.stringify(gen.inputs)), null).ok && !("version" in asV3) && !("incomplete" in asV3) && asV3.key === "report:2026-09-25" && asV3.sections.market_overview.indices.every((i) => !("as_of_label" in i)) && rep.version === 1 && "incomplete" in rep,
    `v3 key ${asV3.key} · v3.1 version ${rep.version} status ${rep.status} missing ${rep.incomplete?.missing_bars.length ?? 0}`
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

  // #8f stored report_v3.1 reports still verify, and carry none of the v3.2 sections (absent, not faked)
  const asV31 = assembleReport(gen.inputs, null, { lanes: rep.lanes, unknowns: rep.unknowns, partial: rep.status === "partial", generated_at: rep.generated_at, elapsed_ms: rep.timing.elapsed_ms, scan_deadline_ms: rep.timing.scan_deadline_ms, method_version: "report_v3.1|risk_v3|atr_piecewise_T1_T2_v2", version: 1 });
  const s31 = asV31.sections;
  check(
    "P1.8f v3.1 report re-verifies with v3.1 rules (no v3.2 sections)",
    verifyReport(asV31, JSON.parse(JSON.stringify(gen.inputs)), null).ok && !("other_buys_1000_plus" in s31) && !("breakout_watch" in s31) && !("other_buys" in s31.final_summary) && s31.deep_dive_top3.items.every((d) => !("source" in d)) && "other_buys_1000_plus" in rep.sections && "breakout_watch" in rep.sections,
    `v3.1 deep ${s31.deep_dive_top3.items.length} · v3.2 other buys ${rep.sections.other_buys_1000_plus?.items.length} · watch ${rep.sections.breakout_watch?.items.length}`
  );

  // #18 report_v3.2 coverage on synthetic inputs (no live data needed, fully deterministic):
  // a ₹1000+ buy lands in Other buys AND the deep dive; the back-fill never duplicates;
  // breakout-watch items are never buy-labelled and each trigger is above the close.
  const synthSym = (ticker: string, cmp: number, sector: string, res: number[] = []): SymbolInput => {
    const k = cmp / 100;
    const t = synth(res.map((x) => Math.round(x * k * 100) / 100));
    const f = { ...t.fields, cmp, atr_14: 2 * k, support_levels: [95 * k], dma_20: 97 * k, dma_50: 95 * k, dma_200: 90 * k };
    return { ticker, yahoo_symbol: `${ticker}.NS`, sector, bar: { date: "2026-10-07", open: cmp, high: cmp, low: cmp, close: cmp, adjclose: null, volume: 1 }, tech: f as SymbolInput["tech"], funda: { fields: pass.fields, sources: ["synthetic"], note: "synthetic" }, news: null };
  };
  const synthInputs = (syms: SymbolInput[]): ReportInputs => ({
    for_session: "2026-10-08", based_on_close: "2026-10-07", universe: syms.map((x) => x.ticker).sort(),
    symbols: Object.fromEntries(syms.map((x) => [x.ticker, x])), indices: [], global_cues: [], headlines: [], headlines_as_of: "2026-10-08T00:00:00.000Z",
  });
  const noBelow = synthInputs([synthSym("BIGA", 1726.1, "Finance"), synthSym("CAPA", 440, "Banks", [102]), synthSym("CAPB", 1242.5, "Banks", [101, 103]), synthSym("CAPC", 234.55, "Banks", [104])]);
  const mixed = synthInputs([synthSym("MIDA", 200, "Auto"), synthSym("BIGA", 1500, "Finance"), synthSym("BIGB", 2500, "Finance"), synthSym("BIGC", 3500, "Finance"), synthSym("BIGD", 1800, "IT")]);
  const meta0 = { lanes: rep.lanes, unknowns: [], partial: false, generated_at: "2026-10-08T01:30:00.000Z", elapsed_ms: 1, scan_deadline_ms: 1 };
  const rNo = assembleReport(noBelow, null, meta0);
  const rMix = assembleReport(mixed, null, meta0);
  const sNo = rNo.sections;
  const sMix = rMix.sections;
  const ob1 = sNo.other_buys_1000_plus!;
  const big = ob1.items.find((p) => p.ticker === "BIGA");
  check(
    "P4.1 ₹1000+ buy → Other buys + deep dive (Top 10 empty, not padded)",
    sNo.top10_under_1000.items.length === 0 && !!big && big.action === "buy" && big.cmp >= 1000 && (big.rr_t1 ?? 0) >= 1 && (big.rr_t2 ?? 0) >= 1.8 && typeof big.rr_plain === "string" && big.reasons_plain.length > 0 &&
      sNo.deep_dive_top3.items.length === 1 && sNo.deep_dive_top3.items[0].ticker === "BIGA" && sNo.deep_dive_top3.items[0].source === "other_buys" && /Other buys/.test(sNo.deep_dive_top3.items[0].source_label || "") &&
      /BIGA/.test(sNo.final_summary.headline) && /Other buys/.test(sNo.final_summary.headline),
    `${big?.ticker} entry ${big?.entry} SL ${big?.sl} T1 ${big?.t1} T2 ${big?.t2} · ${big?.rr_plain} · deep ${sNo.deep_dive_top3.items.map((d) => `${d.ticker} (${d.source_label})`).join(", ")}`
  );
  const dMix = sMix.deep_dive_top3.items.map((d) => d.ticker);
  const obMix = sMix.other_buys_1000_plus!;
  const noDup = (xs: string[]) => new Set(xs).size === xs.length;
  check(
    "P4.2 deep-dive back-fill: Top 10 first, then by ranking; never duplicates; ≤2/sector in Other buys",
    dMix.length === 3 && noDup(dMix) && dMix[0] === "MIDA" && sMix.deep_dive_top3.items[0].source === "top10" && sMix.deep_dive_top3.items.slice(1).every((d) => d.source !== "top10") &&
      noDup(sNo.deep_dive_top3.items.map((d) => d.ticker)) && noDup(rep.sections.deep_dive_top3.items.map((d) => d.ticker)) && rep.sections.deep_dive_top3.items.length <= 3 &&
      obMix.items.filter((p) => p.sector === "Finance").length === 2 && obMix.sector_capped.length === 1 && obMix.n_eligible === 4 && obMix.items.length === 3,
    `deep ${sMix.deep_dive_top3.items.map((d) => `${d.ticker}:${d.source}`).join(", ")} · other ${obMix.items.map((p) => p.ticker).join(",")} capped ${obMix.sector_capped.join(",")} · live deep ${rep.sections.deep_dive_top3.items.map((d) => `${d.ticker}:${d.source}`).join(",") || "none"}`
  );
  // Penny buys (< ₹50) never back-fill the deep dive; they stay in the penny section.
  // pennies need an exceptional tape (breakout above DMAs, RSI 55–70) to be buy-rated at all
  const pennySym = (t: string, cmp: number, sec: string): SymbolInput => {
    const x = synthSym(t, cmp, sec);
    return { ...x, tech: { ...x.tech!, breakout_state: "breakout" } as SymbolInput["tech"] };
  };
  const pennyIn = synthInputs([pennySym("PENA", 40, "Banks"), pennySym("PENB", 30, "Energy"), synthSym("BIGA", 1726.1, "Finance")]);
  const sPen = assembleReport(pennyIn, null, meta0).sections;
  const pennyBuys = ["PENA", "PENB"].filter((t) => verdictFor(pennyIn.symbols[t])?.action === "buy");
  const deepAllOk = (items: { cmp: number }[]) => items.every((d) => d.cmp >= 50);
  check(
    "P4.2b penny buys never back-fill the deep dive (still in the penny section)",
    pennyBuys.length === 2 && sPen.top10_under_1000.items.length === 0 && sPen.deep_dive_top3.items.map((d) => d.ticker).join(",") === "BIGA" &&
      ["PENA", "PENB"].every((t) => sPen.penny_under_50.items.some((p) => p.ticker === t && p.action === "buy")) &&
      deepAllOk(sPen.deep_dive_top3.items) && deepAllOk(sNo.deep_dive_top3.items) && deepAllOk(sMix.deep_dive_top3.items) && deepAllOk(rep.sections.deep_dive_top3.items),
    `penny buys ${pennyBuys.join(",")} · deep ${sPen.deep_dive_top3.items.map((d) => `${d.ticker}@${d.cmp}:${d.source}`).join(",")} · live deep ${rep.sections.deep_dive_top3.items.map((d) => `${d.ticker}@${d.cmp}`).join(",") || "none"}`
  );
  const bwAll = [...(sNo.breakout_watch?.items || []), ...(rep.sections.breakout_watch?.items || [])];
  const buyish = new Set([...sNo.top10_under_1000.items, ...ob1.items, ...sNo.deep_dive_top3.items].map((p) => p.ticker));
  const bwOk =
    (sNo.breakout_watch?.items.length || 0) === 3 &&
    bwAll.every((w) => !("action" in w) && /not a buy, no paper buy/.test(w.label) && w.trigger > w.cmp && /^Watch for a daily close above ₹/.test(w.trigger_text) && !(w.if_breakout && w.if_breakout.entry !== w.trigger)) &&
    sNo.breakout_watch!.items.every((w) => !buyish.has(w.ticker) && verdictFor(noBelow.symbols[w.ticker])?.action !== "buy") &&
    sNo.breakout_watch!.items.every((w, i, a) => i === 0 || a[i - 1].distance_r <= w.distance_r) &&
    (rep.sections.breakout_watch?.items.length || 0) <= BREAKOUT_WATCH_MAX && /not buys/i.test(sNo.breakout_watch!.label) && /max \d+ shown/.test(sNo.breakout_watch!.rule);
  check("P4.3 Watch for breakout: never buy-labelled, trigger > close, ranked by distance, capped", bwOk, sNo.breakout_watch!.items.map((w) => `${w.ticker} ${w.trigger_text} ${w.distance_r}R${w.if_breakout ? ` → ${w.if_breakout.rr_plain}` : ""}`).join(" | "));
  const reNo = assembleReport(JSON.parse(JSON.stringify(noBelow)), null, meta0);
  const bwPhrase = { a: "Watch for breakout", b: sNo.breakout_watch!.label, c: sNo.breakout_watch!.rule, d: "watch for breakout" };
  check(
    "P4.4 banned words + banner (v3.2 sections) · deterministic",
    bannedHits(rNo).length === 0 && bannedHits(rMix).length === 0 && bannedHits(bwPhrase).length === 0 && bannedHits(rep).length === 0 && rNo.sebi_banner === SEBI_BANNER &&
      reNo.report_hash === rNo.report_hash && verifyReport(rNo, JSON.parse(JSON.stringify(noBelow)), null).ok &&
      JSON.stringify(buildSections(noBelow, null).sections.breakout_watch) === JSON.stringify(sNo.breakout_watch),
    [...bannedHits(rNo), ...bannedHits(rMix), ...bannedHits(bwPhrase)].join(",") || `hash ${rNo.report_hash.slice(0, 12)}`
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
  // allowUpgrade:false — this checks replay idempotency; the partial→upgrade path is tested in P3.*
  const a1 = await runPremarket({ source: "test", now: ist("2026-09-25T06:45:00"), forSession, allowUpgrade: false });
  const a2 = await runPremarket({ source: "test", now: ist("2026-09-25T06:46:00"), forSession, allowUpgrade: false });
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


  // ---- report_v3.1: data gaps (P3.*) — small universe, mocked Yahoo holes + mocked official files ----
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}`, { method: "POST", headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }, body: JSON.stringify(["FLUSHALL"]) });
  {
    const D = "2026-09-25";
    const BOC = "2026-09-24";
    const U31 = ["BEL", "COALINDIA", "ITC", "KOTAKBANK", "NTPC", "SBIN"];
    const istD = (ts: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(ts * 1000));
    const captured: Record<string, { o: number; h: number; l: number; c: number; v: number; prev: number }> = {};
    const mode: { nullSyms: Set<string>; bhav: "403" | "serve" } = { nullSyms: new Set(), bhav: "403" };
    const bhavHits: string[] = [];
    const real = globalThis.fetch;
    const fullCsv = () => {
      const row = (sym: string, date: string, prevMul = 1) => {
        const k = captured[`${sym}.NS`];
        return `${sym}, EQ, ${date}, ${(k.prev * prevMul).toFixed(2)}, ${k.o}, ${k.h}, ${k.l}, ${k.c}, ${k.c}, ${k.c}, ${k.v}, 1, 1, 1, 50`;
      };
      const lines = ["SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER"];
      if (captured["KOTAKBANK.NS"]) lines.push(row("KOTAKBANK", "24-Sep-2026")); // good row → fill
      if (captured["NTPC.NS"]) lines.push(row("NTPC", "23-Sep-2026")); // wrong date → never used
      if (captured["ITC.NS"]) lines.push(row("ITC", "24-Sep-2026", 1.1)); // prev close ≠ Yahoo → corporate-action guard
      return lines.join("\n");
    };
    const idxCsv = () => {
      const k = captured["^NSEI"];
      return `Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\nNifty 50,24-09-2026,${k.o},${k.h},${k.l},${k.c},${(k.c - k.prev).toFixed(2)},0.1,1,1,1,1,1`;
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (/nsearchives\.nseindia\.com|bseindia\.com/.test(u)) {
        bhavHits.push(u);
        if (mode.bhav === "403") return new Response("Forbidden", { status: 403 });
        if (/sec_bhavdata_full_24092026\.csv$/.test(u)) return new Response(fullCsv(), { status: 200 });
        if (/ind_close_all_24092026\.csv$/.test(u) && captured["^NSEI"]) return new Response(idxCsv(), { status: 200 });
        return new Response("Not Found", { status: 404 });
      }
      const m = u.match(/\/v8\/finance\/chart\/([^?]+)/);
      const sym = m ? decodeURIComponent(m[1]) : "";
      if (m && mode.nullSyms.has(sym)) {
        const res = await real(input as RequestInfo, init);
        const j = await res.json();
        const r0 = j?.chart?.result?.[0];
        const q = r0?.indicators?.quote?.[0];
        const i = (r0?.timestamp || []).findIndex((t: number) => istD(t) === BOC);
        if (q && i > 0) {
          captured[sym] = { o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0, prev: q.close[i - 1] };
          for (const f of ["open", "high", "low", "close", "volume"]) if (q[f]) q[f][i] = null; // Yahoo's "null row"
        }
        return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
      }
      return real(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      // P3.1 partial (Yahoo null rows for 2 stocks + Nifty, official files blocked) → upgrade to complete
      mode.nullSyms = new Set(["KOTAKBANK.NS", "NTPC.NS", "^NSEI"]);
      mode.bhav = "403";
      const p1 = await runPremarket({ source: "test", now: ist(`${D}T06:40:00`), forSession: D, universe: U31 });
      const r1 = p1.report!;
      const miss1 = r1.incomplete?.missing_bars.map((x) => x.symbol) || [];
      const names1 = [...r1.sections.top10_under_1000.items, ...r1.sections.avoids5.items].map((x) => x.ticker);
      const inp1 = await getReportInputs(D, 1);
      const ok1 = p1.action === "stored_partial" && r1.status === "partial" && r1.version === 1 && ["KOTAKBANK", "NTPC", "^NSEI"].every((t) => miss1.includes(t)) && !names1.includes("KOTAKBANK") && !names1.includes("NTPC") && !!inp1 && verifyReport(r1, inp1, null).ok && r1.unknowns.some((u) => u.ticker === "KOTAKBANK" && /yahoo_null_bar.*bhavcopy: nse_full:http_403/.test(u.reason));
      // P3.3 stale index label (Yahoo's last Nifty bar is 23 Sep)
      const nifty = r1.sections.market_overview.indices.find((x) => x.symbol === "^NSEI")!;
      const ok3 = nifty.stale === true && /^Index data as of \d{1,2} Sep \(Yahoo had no 24 Sep bar\)$/.test(nifty.as_of_label || "") && nifty.bar_date! < BOC && /Not 24 Sep numbers: Nifty 50 as of/.test(r1.sections.market_overview.data_as_of_note || "") && !/Nifty 50 closed at/.test(r1.sections.final_summary.headline) && /not a 24 Sep number/.test(r1.sections.final_summary.headline) && r1.sections.market_overview.indices.filter((x) => x.symbol !== "^NSEI").every((x) => x.bar_date !== BOC || !x.stale);
      check("P3.3 stale index label (as of + not presented as current)", ok3, `${nifty.as_of_label} · ${r1.sections.final_summary.headline.slice(0, 90)}`);
      // same-window retry, data still missing → no new version
      const p2 = await runPremarket({ source: "gha", now: ist(`${D}T07:50:00`), forSession: D, universe: U31 });
      const nv2 = (await listReportVersions(D)).length;
      // Yahoo recovers → v2 complete, v1 kept
      mode.nullSyms = new Set();
      const p3 = await runPremarket({ source: "gha", now: ist(`${D}T07:52:00`), forSession: D, universe: U31 });
      const latest = await getReport(D);
      const v1 = await getReportVersion(D, 1);
      const inV1 = await getReportInputs(D, 1);
      const inV2 = await getReportInputs(D, 2);
      const vers = await listReportVersions(D);
      const served = (await serveLatest(ist(`${D}T08:53:00`))).body as { report: ReportV1; report_version: number; versions: unknown[] };
      const ok1b = p2.action === "upgrade_no_improvement" && nv2 === 1 && p3.action === "upgraded_v2_complete" && latest?.version === 2 && latest.status === "complete" && latest.key === `report:${D}:v2` &&
        latest.supersedes?.version === 1 && latest.supersedes.report_hash === r1.report_hash && v1?.report_hash === r1.report_hash && !!inV1 && !!inV2 && verifyReport(v1!, inV1!, null).ok && verifyReport(latest, inV2!, null).ok &&
        latest.inputs_hash !== r1.inputs_hash && vers.map((v) => `${v.version}:${v.status}`).join(",") === "1:partial,2:complete" && served.report.version === 2 && served.report_version === 2 && served.versions.length === 2 &&
        latest.sections.market_overview.indices.every((x) => x.bar_date === BOC && !x.stale) && !latest.incomplete;
      check("P3.1 partial report → upgrade to complete (v1 kept, both verify, /latest serves v2)", ok1 && ok1b, `${p1.action} [${miss1.join(",")}] → ${p2.action} → ${p3.action}; versions ${vers.map((v) => `${v.version}:${v.status}:${v.inputs_hash.slice(0, 8)}`).join(" ")}`);
      // P3.2 a complete report is never overwritten / superseded
      mode.nullSyms = new Set(["KOTAKBANK.NS"]);
      const p4 = await runPremarket({ source: "gha", now: ist(`${D}T08:10:00`), forSession: D, universe: U31 });
      const forged = { ...latest!, version: 3, key: `report:${D}:v3`, status: "complete" as const, report_hash: "f".repeat(64) };
      const up = await putReportUpgrade(forged, inV2!, 2);
      const once = await putReportOnce({ ...r1, report_hash: "e".repeat(64) }, inV1!);
      const eod = await runPremarket({ source: "eod-mark:test", now: ist(`${D}T16:40:00`), forSession: D, upgradeOnly: true, universe: U31 });
      const after = await getReport(D);
      check(
        "P3.2 no overwrite of a complete report",
        p4.noop === true && !up.ok && up.reason === "base_complete" && !once && eod.noop === true && after?.report_hash === latest!.report_hash && (await listReportVersions(D)).length === 2 && (await getReportVersion(D, 1))?.report_hash === r1.report_hash,
        `${p4.action} · upgrade ${up.ok ? "ok" : up.reason} · putOnce ${once} · eod ${eod.action}`
      );

      // P3.4 official-file fill (mocked bhavcopy + index close): exact date only, prev-close guard
      mode.nullSyms = new Set(["KOTAKBANK.NS", "NTPC.NS", "ITC.NS", "^NSEI"]);
      mode.bhav = "serve";
      bhavHits.length = 0;
      const g = await generateReport({ for_session: D, prev: null, universe: U31 });
      const kb = g.inputs.symbols.KOTAKBANK;
      const nt = g.report.unknowns.find((u) => u.ticker === "NTPC");
      const it = g.report.unknowns.find((u) => u.ticker === "ITC");
      const ni = g.report.sections.market_overview.indices.find((x) => x.symbol === "^NSEI")!;
      const k = captured["KOTAKBANK.NS"];
      const fills = (g.report.data_fills || []).map((f) => `${f.symbol}:${f.close_source}`).sort();
      const miss = g.report.incomplete?.missing_bars.map((x) => x.symbol) || [];
      const ok4 = kb.bar?.close_source === "nse_bhavcopy" && kb.bar.date === BOC && kb.bar.close === Math.round(k.c * 100) / 100 && kb.tech != null &&
        !g.report.unknowns.some((u) => u.ticker === "KOTAKBANK" && u.lane === "tech") &&
        g.inputs.symbols.NTPC.bar == null && /date_mismatch\(2026-09-23\)/.test(nt?.reason || "") &&
        g.inputs.symbols.ITC.bar == null && /prev_close .* ≠ Yahoo/.test(it?.reason || "") &&
        ni.close_source === "nse_index_close" && ni.bar_date === BOC && ni.stale === false && /^NSE official index close for 24 Sep \(Yahoo had no 24 Sep bar\)$/.test(ni.as_of_label || "") &&
        JSON.stringify(fills) === JSON.stringify(["KOTAKBANK:nse_bhavcopy", "^NSEI:nse_index_close"]) && (g.report.close_sources?.nse_bhavcopy ?? 0) === 1 &&
        miss.includes("NTPC") && miss.includes("ITC") && !miss.includes("KOTAKBANK") && !miss.includes("^NSEI") && g.report.status === "partial" &&
        verifyReport(g.report, JSON.parse(JSON.stringify(g.inputs)), null).ok && bhavHits.some((h) => /sec_bhavdata_full_24092026/.test(h)) && bhavHits.every((h) => /24092026|20260924/.test(h));
      check("P3.4 bhavcopy fill (mocked): exact-date official close, tagged, guards hold", ok4, `fills ${fills.join(",")} · NTPC ${nt?.reason.split("; ")[1] || "-"} · ITC ${(it?.reason.split("; ")[1] || "-").slice(0, 60)} · missing ${miss.join(",")}`);
    } finally {
      globalThis.fetch = real;
    }
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
