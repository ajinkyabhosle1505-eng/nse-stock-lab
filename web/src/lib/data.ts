import { readFile } from "fs/promises";
import path from "path";
import type { LaneFile, LedgerFile, Verdict, VerdictsFile } from "./types";

const dataDir = path.join(process.cwd(), "public", "data");

async function loadJson<T>(name: string): Promise<T> {
  const raw = await readFile(path.join(dataDir, name), "utf8");
  return JSON.parse(raw) as T;
}

export async function getVerdicts(): Promise<VerdictsFile> {
  return loadJson<VerdictsFile>("verdicts.json");
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
  return file.verdicts.find((v) => v.ticker.toUpperCase() === t);
}
