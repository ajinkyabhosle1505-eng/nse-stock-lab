/**
 * Report snapshots — write-once per for_session.
 * Redis (Upstash):  report:<date> (ReportV1 JSON, SET NX)
 *                   report:inputs:<date> (inputs JSON, SET NX)
 *                   report:index (ZSET score=YYYYMMDD)
 * No Redis → per-instance memory ("ephemeral"), responses cached at the CDN.
 * There is no overwrite path: immutable like the brief's reports table trigger.
 */
import { getRedis, parseJson } from "./redis";
import type { ReportV1 } from "./reportTypes";
import type { ReportInputs } from "./report";

export type StorageMode = "redis" | "ephemeral";

const mem = globalThis as typeof globalThis & {
  __reports?: Map<string, ReportV1>;
  __reportInputs?: Map<string, ReportInputs>;
};
const reports = () => (mem.__reports ||= new Map());
const inputsMem = () => (mem.__reportInputs ||= new Map());

export function storageMode(): StorageMode {
  return getRedis() ? "redis" : "ephemeral";
}

export async function getReport(date: string): Promise<ReportV1 | null> {
  const r = getRedis();
  if (!r) return reports().get(date) || null;
  return parseJson<ReportV1>(await r.get(`report:${date}`));
}

export async function getReportInputs(date: string): Promise<ReportInputs | null> {
  const r = getRedis();
  if (!r) return inputsMem().get(date) || null;
  return parseJson<ReportInputs>(await r.get(`report:inputs:${date}`));
}

/** Insert once. Returns false if a report for that session already exists. */
export async function putReportOnce(report: ReportV1, inputs: ReportInputs): Promise<boolean> {
  const date = report.for_session;
  const r = getRedis();
  if (!r) {
    if (reports().has(date)) return false;
    reports().set(date, report);
    inputsMem().set(date, inputs);
    for (const k of [...reports().keys()].sort().slice(0, -10)) {
      reports().delete(k);
      inputsMem().delete(k);
    }
    return true;
  }
  const ok = await r.set(`report:${date}`, JSON.stringify(report), { nx: true });
  if (ok !== "OK") return false;
  await r.set(`report:inputs:${date}`, JSON.stringify(inputs), { nx: true });
  await r.zadd("report:index", { score: Number(date.replace(/-/g, "")), member: date });
  return true;
}

export async function listReportDates(limit = 30): Promise<string[]> {
  const r = getRedis();
  if (!r) return [...reports().keys()].sort().reverse().slice(0, limit);
  const res = await r.zrange("report:index", 0, limit - 1, { rev: true });
  return (res as unknown[]).map(String);
}

/** Latest stored for_session ≤ date (or overall latest when date omitted). */
export async function latestReportDate(onOrBefore?: string): Promise<string | null> {
  const dates = await listReportDates(60);
  return dates.find((d) => !onOrBefore || d <= onOrBefore) || null;
}
