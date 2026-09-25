/**
 * Ops diagnostic (read-only, no Redis): build the report locally for a session
 * and explain every symbol — UNKNOWN reason, or why it is / isn't in Top 10.
 *   npx tsx --tsconfig tsconfig.json scripts/report-diagnose.ts 2026-09-25 [out.json]
 *   npx tsx --tsconfig tsconfig.json scripts/report-diagnose.ts --inputs saved.json   (offline, pure rebuild)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { generateReport, buildSections, verdictFor, type ReportInputs } from "../src/lib/report";

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
    else if (v.action !== "buy") why = `${v.action}: ${(v.reasons || []).filter((r) => /Funda|News|Penny|size/i.test(r)).slice(0, 2).join(" | ") || v.reasons?.[0] || ""}`;
    else if (cmp >= 1000) why = "buy but cmp>=1000";
    else if (cmp < 50) why = "buy but cmp<50";
    else why = `buy but cut (sector cap ${s.sector})`;
    const fq = s.funda ? String(s.funda.fields.funda_quality) : "not_fetched";
    console.log(`  ${t.padEnd(12)} ${String(cmp).padStart(9)} ${s.sector.padEnd(9)} funda=${fq.padEnd(11)} ${why}`);
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
