/**
 * Ops diagnostic (read-only, no Redis): build the report locally for a session
 * and explain every symbol — UNKNOWN reason, or why it is / isn't in Top 10.
 *   npx tsx --tsconfig tsconfig.json scripts/report-diagnose.ts 2026-09-25 [out.json]
 *   npx tsx --tsconfig tsconfig.json scripts/report-diagnose.ts --inputs saved.json   (offline, pure rebuild)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { generateReport, buildSections, verdictFor, METHOD_VERSION, type ReportInputs } from "../src/lib/report";

const LEGACY = "report_v2|risk_v2|atr_piecewise_T1_T2_v1";

/** risk_v3 R:R effect on the same inputs: legacy (v2) vs current (v3) levels. */
function rrCompare(inputs: ReportInputs) {
  const old = buildSections(inputs, null, LEGACY).sections;
  const now = buildSections(inputs, null, METHOD_VERSION).sections;
  const spread = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    return v.length ? `min ${v[0]} · median ${v[Math.floor(v.length / 2)]} · max ${v[v.length - 1]} (${new Set(v).size} distinct)` : "—";
  };
  console.log(`\nR:R effect (same inputs, based_on_close ${inputs.based_on_close})`);
  console.log(`  ${LEGACY}: buys ${old.final_summary.counts.buy} · Top 10 ${old.top10_under_1000.items.length} · T1 R:R ${spread(old.top10_under_1000.items.map((p) => p.r_r))}`);
  console.log(`  ${METHOD_VERSION}: buys ${now.final_summary.counts.buy} · Top 10 ${now.top10_under_1000.items.length}`);
  console.log(`    T1 R:R ${spread(now.top10_under_1000.items.map((p) => p.rr_t1))}`);
  console.log(`    T2 R:R ${spread(now.top10_under_1000.items.map((p) => p.rr_t2))}`);
  for (const p of now.top10_under_1000.items) console.log(`    ${p.rank}. ${p.ticker.padEnd(11)} ${p.rr_plain} · T1 ${p.t1_basis} · T2 ${p.t2_basis}${p.funda_status !== "verified" ? " · funda UNKNOWN" : ""}`);
  const wasBuy = new Set<string>();
  for (const t of inputs.universe) {
    const s = inputs.symbols[t];
    if (s?.tech && verdictFor(s, LEGACY)?.action === "buy") wasBuy.add(t);
  }
  const down = inputs.universe.filter((t) => wasBuy.has(t) && verdictFor(inputs.symbols[t])?.action !== "buy");
  console.log(`  Downgraded buy → non-buy under v3 (${down.length}, all prices):`);
  for (const t of down) {
    const v = verdictFor(inputs.symbols[t])!;
    console.log(`    ${t.padEnd(11)} ${String(v.cmp).padStart(9)} → ${v.action}: ${v.reasons?.[0]}`);
  }
  const added = inputs.universe.filter((t) => !wasBuy.has(t) && inputs.symbols[t]?.tech && verdictFor(inputs.symbols[t])?.action === "buy");
  if (added.length) console.log(`  New buys under v3: ${added.join(", ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  let inputs: ReportInputs;
  let unknowns: { ticker: string; lane: string; reason: string }[] = [];
  let top10: string[] = [];
  if (args[0] === "--inputs") {
    inputs = JSON.parse(readFileSync(args[1], "utf8"));
    const { sections, unknownsFromData } = buildSections(inputs, null);
    top10 = sections.top10_under_1000.items.map((p) => p.ticker);
    unknowns = unknownsFromData;
  } else {
    const forSession = args[0] || "2026-09-25";
    const t0 = Date.now();
    const gen = await generateReport({ for_session: forSession, prev: null });
    inputs = gen.inputs;
    unknowns = gen.report.unknowns;
    top10 = gen.report.sections.top10_under_1000.items.map((p) => p.ticker);
    console.log(`generated ${gen.report.key} based_on_close=${gen.report.based_on_close} status=${gen.report.status} in ${Date.now() - t0} ms`);
    console.log("lanes", JSON.stringify(gen.report.lanes));
    if (args[1]) writeFileSync(args[1], JSON.stringify({ report: gen.report, inputs }, null, 1));
  }
  rrCompare(inputs);
  const byReason = new Map<string, string[]>();
  for (const u of unknowns) {
    const k = `${u.lane}: ${u.reason.replace(/\(last .*\)/, "").trim()}`;
    byReason.set(k, [...(byReason.get(k) || []), u.ticker]);
  }
  console.log(`\nUNKNOWN entries: ${unknowns.length} (distinct symbols ${new Set(unknowns.map((u) => u.ticker)).size})`);
  for (const [k, v] of byReason) console.log(`  ${v.length.toString().padStart(3)}  ${k}: ${v.join(", ")}`);
  console.log(`\nTop 10 (${top10.length}): ${top10.join(", ")}`);
  console.log("\nPer symbol:");
  for (const t of inputs.universe) {
    const s = inputs.symbols[t];
    if (!s?.tech) { console.log(`  ${t.padEnd(12)} NO_TECH`); continue; }
    const v = verdictFor(s)!;
    const cmp = typeof v.cmp === "number" ? v.cmp : NaN;
    let why = "";
    if (top10.includes(t)) why = "IN TOP10";
    else if (v.action !== "buy") why = `${v.action}: ${(v.reasons || []).filter((r) => /Resistance|Funda|News|Penny|size/i.test(r)).slice(0, 2).join(" | ") || v.reasons?.[0] || ""}`;
    else if (cmp >= 1000) why = "buy but cmp>=1000";
    else if (cmp < 50) why = "buy but cmp<50";
    else why = `buy but cut (sector cap ${s.sector})`;
    const fq = s.funda ? String(s.funda.fields.funda_quality) : "not_fetched";
    console.log(`  ${t.padEnd(12)} ${String(cmp).padStart(9)} ${s.sector.padEnd(9)} funda=${fq.padEnd(11)} ${why}`);
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
