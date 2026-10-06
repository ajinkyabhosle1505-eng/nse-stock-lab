/**
 * Report snapshots — write-once per (for_session, version).
 * Redis (Upstash):  report:<date>                 version 1 (ReportV1 JSON, SET NX)
 *                   report:inputs:<date>          inputs of version 1 (SET NX)
 *                   report:<date>:v<n>            version n ≥ 2 (report_v3.1 upgrade of a PARTIAL report, SET NX)
 *                   report:inputs:<date>:<inputs_hash>  inputs of version n ≥ 2, content-addressed (SET NX)
 *                   report:versions:<date>        ZSET member "v<n>" score n (append-only index of upgrades)
 *                   report:index                  ZSET score=YYYYMMDD
 * No key is ever rewritten or deleted. A COMPLETE version can never be superseded:
 * putReportUpgrade refuses unless the newest stored version is partial.
 * No Redis → per-instance memory ("ephemeral"), responses cached at the CDN.
 */
import { getRedis, parseJson } from "./redis";
import type { ReportV1 } from "./reportTypes";
import type { ReportInputs } from "./report";

export type StorageMode = "redis" | "ephemeral";
export const MAX_REPORT_VERSIONS = 6;

const mem = globalThis as typeof globalThis & {
  __reports?: Map<string, ReportV1[]>; // index 0 = v1
  __reportInputs?: Map<string, ReportInputs[]>;
};
const reports = () => (mem.__reports ||= new Map());
const inputsMem = () => (mem.__reportInputs ||= new Map());

const repKey = (date: string, v: number) => (v > 1 ? `report:${date}:v${v}` : `report:${date}`);
const inpKey = (date: string, v: number, inputsHash: string) => (v > 1 ? `report:inputs:${date}:${inputsHash}` : `report:inputs:${date}`);

export function storageMode(): StorageMode {
  return getRedis() ? "redis" : "ephemeral";
}

/** Highest stored version number for a session (0 = none). */
export async function latestVersion(date: string): Promise<number> {
  const r = getRedis();
  if (!r) return reports().get(date)?.length || 0;
  const res = (await r.zrange(`report:versions:${date}`, 0, 0, { rev: true })) as unknown[];
  let top = res.length ? Number(String(res[0]).replace(/^v/, "")) : 0;
  if (top < 2) top = (await r.exists(`report:${date}`)) ? 1 : 0;
  if (!top) return 0;
  // self-repair: a version written just before a crash, whose index ZADD never ran
  while (top < MAX_REPORT_VERSIONS && (await r.exists(repKey(date, top + 1)))) {
    top++;
    await r.zadd(`report:versions:${date}`, { score: top, member: `v${top}` });
  }
  return top;
}

/** Newest version of the report for a session (what /latest and /report/<date> serve). */
export async function getReport(date: string): Promise<ReportV1 | null> {
  const r = getRedis();
  if (!r) {
    const a = reports().get(date);
    return a?.length ? a[a.length - 1] : null;
  }
  const v = await latestVersion(date);
  return v ? getReportVersion(date, v) : null;
}

export async function getReportVersion(date: string, version: number): Promise<ReportV1 | null> {
  const r = getRedis();
  if (!r) return reports().get(date)?.[version - 1] || null;
  return parseJson<ReportV1>(await r.get(repKey(date, version)));
}

/** Inputs of a version (default: newest). */
export async function getReportInputs(date: string, version?: number): Promise<ReportInputs | null> {
  const v = version ?? (await latestVersion(date));
  if (!v) return null;
  const r = getRedis();
  if (!r) return inputsMem().get(date)?.[v - 1] || null;
  if (v === 1) return parseJson<ReportInputs>(await r.get(inpKey(date, 1, "")));
  const rep = await getReportVersion(date, v);
  return rep ? parseJson<ReportInputs>(await r.get(inpKey(date, v, rep.inputs_hash))) : null;
}

/** Audit list of every stored version (oldest first). */
export async function listReportVersions(date: string): Promise<{ version: number; key: string; status: string; report_hash: string; inputs_hash: string; generated_at: string; method_version: string; missing: number | null }[]> {
  const n = await latestVersion(date);
  const out = [];
  for (let v = 1; v <= n; v++) {
    const rep = await getReportVersion(date, v);
    if (rep) out.push({ version: v, key: repKey(date, v), status: rep.status, report_hash: rep.report_hash, inputs_hash: rep.inputs_hash, generated_at: rep.generated_at, method_version: rep.method_version, missing: rep.incomplete ? rep.incomplete.missing_bars.length : rep.status === "complete" ? 0 : null });
  }
  return out;
}

/** Insert version 1 once. Returns false if a report for that session already exists. */
export async function putReportOnce(report: ReportV1, inputs: ReportInputs): Promise<boolean> {
  const date = report.for_session;
  const r = getRedis();
  if (!r) {
    if (reports().has(date)) return false;
    reports().set(date, [report]);
    inputsMem().set(date, [inputs]);
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

export type UpgradeResult =
  | { ok: true; version: number }
  | { ok: false; reason: "no_base" | "base_complete" | "version_mismatch" | "max_versions" | "exists" };

/**
 * Store version `report.version` (≥ 2) of a session — only when the newest stored
 * version is `expectVersion` AND partial. Never touches earlier keys (append-only).
 */
export async function putReportUpgrade(report: ReportV1, inputs: ReportInputs, expectVersion: number): Promise<UpgradeResult> {
  const date = report.for_session;
  const v = report.version ?? 0;
  if (v !== expectVersion + 1 || v < 2) return { ok: false, reason: "version_mismatch" };
  if (v > MAX_REPORT_VERSIONS) return { ok: false, reason: "max_versions" };
  const cur = await latestVersion(date);
  if (!cur) return { ok: false, reason: "no_base" };
  if (cur !== expectVersion) return { ok: false, reason: "version_mismatch" };
  const base = await getReportVersion(date, cur);
  if (!base) return { ok: false, reason: "no_base" };
  if (base.status === "complete") return { ok: false, reason: "base_complete" };
  const r = getRedis();
  if (!r) {
    const a = reports().get(date)!;
    if (a.length !== cur) return { ok: false, reason: "exists" };
    a.push(report);
    (inputsMem().get(date) || inputsMem().set(date, []).get(date)!).push(inputs);
    return { ok: true, version: v };
  }
  // Inputs first (content-addressed by inputs_hash, NX), then the report (NX), then the version
  // index — a crash in between leaves at most an orphan inputs key, never a report without inputs.
  await r.set(inpKey(date, v, report.inputs_hash), JSON.stringify(inputs), { nx: true });
  const ok = await r.set(repKey(date, v), JSON.stringify(report), { nx: true });
  if (ok !== "OK") return { ok: false, reason: "exists" };
  await r.zadd(`report:versions:${date}`, { score: v, member: `v${v}` });
  return { ok: true, version: v };
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
