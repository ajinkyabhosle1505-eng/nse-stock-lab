import { readFile } from "fs/promises";
import path from "path";
import { enrichPlanFields, enrichVerdicts } from "./plan";
import type { LaneFile, LedgerFile, Verdict, VerdictsFile } from "./types";

const dataDir = path.join(process.cwd(), "public", "data");

async function loadJson<T>(name: string): Promise<T> {
  const raw = await readFile(path.join(dataDir, name), "utf8");
  return JSON.parse(raw) as T;
}

export async function getVerdicts(): Promise<VerdictsFile> {
  const file = await loadJson<VerdictsFile>("verdicts.json");
  return { ...file, verdicts: enrichVerdicts(file.verdicts || []) };
}

export async function getLedger(): Promise<LedgerFile> {
  return loadJson<LedgerFile>("ledger.json");
}

export async function getDailyReport(): Promise<Record<string, unknown>> {
  return loadJson<Record<string, unknown>>("daily_report.json");
}

export async function getLanes(): Promise<{
  tech: LaneFile;
  funda: LaneFile;
  news: LaneFile;
}> {
  const [tech, funda, news] = await Promise.all([
    loadJson<LaneFile>("tech.json"),
    loadJson<LaneFile>("funda.json"),
    loadJson<LaneFile>("news.json"),
  ]);
  return { tech, funda, news };
}

export function indexByTicker(
  lane: LaneFile
): Record<string, LaneFile["results"][number]> {
  const out: Record<string, LaneFile["results"][number]> = {};
  for (const r of lane.results || []) {
    out[r.ticker.toUpperCase()] = r;
  }
  return out;
}

export function findVerdict(
  file: VerdictsFile,
  ticker: string
): Verdict | undefined {
  const t = ticker.toUpperCase();
  const v = file.verdicts.find((x) => x.ticker.toUpperCase() === t);
  return v ? enrichPlanFields(v) : undefined;
}

type Obj = Record<string, unknown>;

/**
 * Adapter: the desk fixture `daily_report.json` stores `sections` as an ARRAY of
 * `{id,title,body,tickers}` (ids overview, top_under_1000, deep_dive, avoids,
 * paper, summary) while the /report page reads KEYED sections
 * ("1_market_overview" … "6_final_summary"). The mismatch rendered "No items"
 * everywhere. Keyed input passes through unchanged. Values come only from the
 * fixture + the same-run verdicts file — nothing is invented.
 */
export function normalizeDailyReport(raw: Obj, verdicts?: VerdictsFile | null): Obj {
  const sections = raw.sections;
  if (!Array.isArray(sections)) return raw;
  const byId = new Map<string, Obj>();
  for (const s of sections as Obj[]) byId.set(String(s.id), s);
  const vIndex = new Map<string, Verdict>();
  for (const v of verdicts?.verdicts || []) vIndex.set(v.ticker.toUpperCase(), v);
  const tickers = (s?: Obj) => (Array.isArray(s?.tickers) ? (s!.tickers as unknown[]).map(String) : []);
  const lines = (s?: Obj) =>
    String(s?.body || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const pick = (t: string): Obj => {
    const v = vIndex.get(t.toUpperCase());
    return {
      ticker: t,
      action: v?.action ?? null,
      confidence_1_10: v?.confidence_1_10 ?? null,
      entry: v?.entry ?? null,
      sl: v?.sl ?? null,
      targets: v?.targets ?? [],
      size_inr: v?.size_inr ?? null,
    };
  };
  const overview = byId.get("overview");
  const top = byId.get("top_under_1000");
  const deep = byId.get("deep_dive");
  const avoids = byId.get("avoids");
  const paper = byId.get("paper");
  const summary = byId.get("summary");
  return {
    ...raw,
    sections_shape: "array_adapted",
    sections: {
      "1_market_overview": { indices_note: overview?.body ?? null },
      "2_top10_under_1000": { items: tickers(top).map(pick) },
      "3_deep_dive_top3": {
        items: tickers(deep).map((t) => {
          const v = vIndex.get(t.toUpperCase());
          const line = lines(deep).find((l) => l.toUpperCase().startsWith(`${t.toUpperCase()} `));
          return { ticker: t, verdict: { ...pick(t), reasons: v?.reasons?.length ? v.reasons : line ? [line] : [] } };
        }),
      },
      "4_five_avoids": {
        items: lines(avoids).map((l) => {
          const i = l.indexOf(":");
          return i > 0
            ? { ticker: l.slice(0, i).trim(), kind: "avoid", note: l.slice(i + 1).trim() }
            : { ticker: "—", kind: "avoid", note: l };
        }),
      },
      "5_penny_under_50": { items: [], note: "Not covered by this desk fixture." },
      "6_final_summary": {
        headline: summary?.body ?? null,
        paper_fills: paper ? lines(paper).join(" · ") : null,
      },
    },
  };
}
