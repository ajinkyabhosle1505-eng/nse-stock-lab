/**
 * Serving + cron orchestration for the pre-market report.
 *
 * /api/report/latest:
 *   target session = today if today is a trading day and it's ≥ 06:00 IST,
 *   else the last trading day (the stored report to serve). The envelope's
 *   expected_session / stale come from reportSessions().
 *   Missing target on a trading day → self-generate under the job lease
 *   (so CoS at 08:53 IST always gets today's report even if cron was missed).
 *   Weekend/holiday → last stored report + `holiday` note (never generated
 *   for a closed day). stale/age_hours are computed at serve time, never stored.
 */
import { generateReport, missingCountOf } from "./report";
import type { ReportV1 } from "./reportTypes";
import {
  getReport,
  getReportVersion,
  latestReportDate,
  listReportDates,
  listReportVersions,
  MAX_REPORT_VERSIONS,
  putReportOnce,
  putReportUpgrade,
  storageMode,
  type StorageMode,
} from "./reportStore";
import {
  expectedReportSession,
  holidayName,
  isTradingDay,
  istParts,
  nextTradingDay,
  prevTradingDay,
  weekdayOf,
} from "./marketCalendar";
import { acquireLease, getJobRun, putJobRun } from "./jobs/lock";
import { finalizeMarksAndScore } from "./jobs/mark";
import { redisConfigured } from "./redis";
import { SEBI_BANNER } from "./universe";

export const SELF_GEN_AFTER_MIN = 6 * 60; // 06:00 IST: prior close is settled

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
};

export interface Served {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export function targetSession(now: Date = new Date()): string {
  const p = istParts(now);
  if (isTradingDay(p.date) && p.minutesOfDay >= SELF_GEN_AFTER_MIN) return p.date;
  return expectedReportSession(now);
}

/**
 * Sessions for the /latest envelope (fix 2026-10-05: on 28 Sep the wrapper said
 * expected_session 2026-09-25 while the report was for 2026-09-28, because it
 * used the 09:00 pre-open cut-off instead of the report cut-off).
 *   expected_session: the session the current report is for —
 *     trading day ≥ 06:00 IST (report time) → today;
 *     before 06:00, weekend or holiday → the next trading session.
 *   due_session: the newest session whose report must already exist —
 *     today after 06:00 on a trading day, else the previous trading day.
 *   stale = report.for_session < due_session (a weekend / pre-cron Friday report is
 *   not stale just because the next session's report cannot exist yet).
 */
export function reportSessions(now: Date = new Date()): { expected: string; due: string } {
  const p = istParts(now);
  if (isTradingDay(p.date) && p.minutesOfDay >= SELF_GEN_AFTER_MIN) return { expected: p.date, due: p.date };
  return { expected: isTradingDay(p.date) ? p.date : nextTradingDay(p.date), due: prevTradingDay(p.date) };
}

export type VersionInfo = Awaited<ReturnType<typeof listReportVersions>>;

function envelope(report: ReportV1, now: Date, storage: StorageMode, served: Record<string, unknown>, versions: VersionInfo) {
  const p = istParts(now);
  const { expected, due } = reportSessions(now);
  const closedToday = !isTradingDay(p.date);
  const wd = weekdayOf(p.date);
  return {
    report,
    stale: report.for_session < due,
    age_hours: Math.round(((now.getTime() - Date.parse(report.generated_at)) / 3600000) * 10) / 10,
    expected_session: expected,
    due_session: due,
    ...(closedToday
      ? { holiday: { date: p.date, name: holidayName(p.date) || (wd === 0 || wd === 6 ? "Weekend" : "NSE closed") } }
      : {}),
    served_at: now.toISOString(),
    storage,
    ...(storage === "ephemeral"
      ? { storage_note: "No database configured — generated on demand and cached per instance + CDN; not a durable archive." }
      : {}),
    served,
    // report_v3.1: every stored version of this session (oldest first); `report` is the newest
    report_version: report.version ?? 1,
    versions,
    ...(report.status === "partial"
      ? { partial_note: report.incomplete?.note || "Partial report: some symbols could not be fetched (see unknowns). Nothing was estimated." }
      : {}),
    sebi_banner: SEBI_BANNER,
  };
}

const okHeaders = (report: ReportV1, cache: string) => ({
  ...CORS,
  "Cache-Control": cache,
  ETag: `"${report.report_hash}"`,
});

export async function serveLatest(now: Date = new Date(), ifNoneMatch?: string | null): Promise<Served> {
  const storage = storageMode();
  const target = targetSession(now);
  const p = istParts(now);
  let report = await getReport(target);
  let source = "stored";
  let note: string | undefined;

  if (!report) {
    const canGenerate = target === p.date || storage === "ephemeral" || !(await latestReportDate());
    if (canGenerate) {
      const run = await runPremarket({ source: "self_heal", now, forSession: target, finalizeIfPartial: true, allowUpgrade: false });
      if (run.report) {
        report = run.report;
        source = storage === "ephemeral" ? "generated_on_demand" : "self_generated";
      } else if (run.locked) {
        note = "Today's report is being generated right now — retry in ~1 minute.";
      } else if (run.error) {
        note = `Generation failed: ${run.error}`;
      }
    }
  }
  if (!report) {
    const prevDate = await latestReportDate(target);
    if (prevDate) {
      report = await getReport(prevDate);
      source = "previous_report";
    }
  }
  if (!report) {
    return {
      status: note?.includes("being generated") ? 202 : 503,
      body: { error: "no_report_available", note: note || "No report yet.", expected_session: reportSessions(now).expected, storage, sebi_banner: SEBI_BANNER },
      headers: { ...CORS, "Cache-Control": "no-store" },
    };
  }
  const tag = `"${report.report_hash}"`;
  // a partial report may be upgraded within the hour → short CDN life so the newest version shows up
  const cache = note
    ? "no-store"
    : report.status === "partial"
      ? "public, max-age=30, s-maxage=60, stale-while-revalidate=120"
      : "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";
  if (ifNoneMatch && ifNoneMatch === tag) return { status: 304, body: {}, headers: okHeaders(report, cache) };
  const versions = await listReportVersions(report.for_session).catch(() => [] as VersionInfo);
  return {
    status: 200,
    body: envelope(report, now, storage, { source, requested_session: target, ...(note ? { note } : {}) }, versions),
    headers: okHeaders(report, cache),
  };
}

export async function serveDate(date: string, now: Date = new Date(), version?: number): Promise<Served> {
  const storage = storageMode();
  if (version != null) {
    const rv = await getReportVersion(date, version);
    if (!rv) {
      return { status: 404, body: { error: "version_not_found", report_date: date, version, versions: await listReportVersions(date), storage, sebi_banner: SEBI_BANNER }, headers: { ...CORS, "Cache-Control": "public, s-maxage=60" } };
    }
    // a stored version never changes
    return { status: 200, body: { report: rv, storage, versions: await listReportVersions(date), sebi_banner: SEBI_BANNER }, headers: okHeaders(rv, storage === "redis" ? "public, max-age=3600, s-maxage=31536000, immutable" : "public, s-maxage=300") };
  }
  let report = await getReport(date);
  if (!report && date === targetSession(now) && date === istParts(now).date) {
    const run = await runPremarket({ source: "self_heal", now, forSession: date, finalizeIfPartial: true, allowUpgrade: false });
    report = run.report || null;
  }
  if (!report) {
    return {
      status: 404,
      body: {
        error: "not_found",
        report_date: date,
        nearest_prev: await latestReportDate(date),
        storage,
        ...(storage === "ephemeral" ? { note: "No database configured — past reports are not archived." } : {}),
        sebi_banner: SEBI_BANNER,
      },
      headers: { ...CORS, "Cache-Control": "public, s-maxage=60" },
    };
  }
  const cache =
    report.status === "complete" && storage === "redis"
      ? "public, max-age=3600, s-maxage=31536000, immutable"
      : "public, max-age=30, s-maxage=60, stale-while-revalidate=120";
  const versions = await listReportVersions(date).catch(() => [] as VersionInfo);
  return { status: 200, body: { report, storage, report_version: report.version ?? 1, versions, sebi_banner: SEBI_BANNER }, headers: okHeaders(report, cache) };
}

export async function serveIndex(limit = 30): Promise<Served> {
  const dates = await listReportDates(Math.min(60, Math.max(1, limit)));
  const items = [];
  for (const d of dates) {
    const r = await getReport(d);
    if (r) items.push({ key: r.key, for_session: r.for_session, based_on_close: r.based_on_close, status: r.status, version: r.version ?? 1, report_hash: r.report_hash });
  }
  return {
    status: 200,
    body: { items, storage: storageMode(), sebi_banner: SEBI_BANNER },
    headers: { ...CORS, "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" },
  };
}

export interface PremarketResult {
  ok: boolean;
  status: number;
  action: string;
  for_session: string;
  report?: ReportV1;
  locked?: boolean;
  noop?: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

const inflight = globalThis as typeof globalThis & { __premarket?: Map<string, Promise<PremarketResult>> };

export interface PremarketOpts {
  source: string;
  now?: Date;
  forSession?: string;
  /** legacy flag (GHA sends finalize_if_partial=1). Partial reports are now always stored (versioned). */
  finalizeIfPartial?: boolean;
  /**
   * May this call re-fetch and store an upgraded version when the stored report is partial?
   * Cron / GHA / eod-mark: yes. /latest self-heal: no (never blocks a reader on a rebuild).
   */
  allowUpgrade?: boolean;
  /** eod-mark: only upgrade an existing partial; never build v1, never run marks/scoring. */
  upgradeOnly?: boolean;
  /** test hooks */
  universe?: string[];
  deadlineMs?: number;
}

/**
 * Idempotent premarket job: finalize marks + score, then build/store the report.
 *   no report yet        → build + store v1 (complete OR partial; partial lists missing bars)
 *   newest is complete   → noop (write-once: a complete version is never superseded)
 *   newest is partial    → (allowUpgrade, same IST day as for_session) re-fetch + rebuild;
 *                          store v<n+1> only if it is complete or has fewer missing bars;
 *                          earlier versions stay under their own keys.
 */
export async function runPremarket(opts: PremarketOpts): Promise<PremarketResult> {
  const now = opts.now || new Date();
  const forSession = opts.forSession || istParts(now).date;
  const m = (inflight.__premarket ||= new Map());
  const key = forSession;
  const existing = m.get(key);
  if (existing) return existing;
  const p = runPremarketInner({ ...opts, now, forSession }).finally(() => m.delete(key));
  m.set(key, p);
  return p;
}

async function runPremarketInner(opts: PremarketOpts & { now: Date; forSession: string }): Promise<PremarketResult> {
  const { now, forSession } = opts;
  const job = "premarket-report";
  if (!isTradingDay(forSession)) {
    if (opts.upgradeOnly) return { ok: true, status: 200, action: "holiday_skip", for_session: forSession };
    await putJobRun({ job, session_date: forSession, status: "holiday_skip", attempts: 1, trigger_source: opts.source, started_at: now.toISOString(), finished_at: new Date().toISOString(), detail: { holiday: holidayName(forSession) || "weekend" } });
    return { ok: true, status: 200, action: "holiday_skip", for_session: forSession };
  }
  const prior = await getJobRun(job, forSession);
  const stored = await getReport(forSession);
  const sameDay = istParts(now).date === forSession;
  const canUpgrade = !!stored && stored.status === "partial" && opts.allowUpgrade !== false && sameDay;
  if (stored && stored.status === "complete" && prior?.status === "complete") {
    return { ok: true, status: 200, action: "noop", noop: true, for_session: forSession, report: stored };
  }
  if (opts.upgradeOnly && !canUpgrade) {
    return { ok: true, status: 200, action: stored ? (stored.status === "complete" ? "noop_complete" : "no_upgrade") : "no_report", noop: true, for_session: forSession, report: stored || undefined };
  }
  if (stored && stored.status === "partial" && !canUpgrade && prior && prior.status !== "failed") {
    // e.g. /latest self-heal, or a later day: serve what is stored, never rebuild
    return { ok: true, status: 200, action: "exists_partial", noop: true, for_session: forSession, report: stored };
  }
  const nVersions = stored ? stored.version ?? 1 : 0;
  if (canUpgrade && nVersions >= MAX_REPORT_VERSIONS) {
    return { ok: true, status: 200, action: "max_versions", noop: true, for_session: forSession, report: stored! };
  }
  const release = await acquireLease(job, forSession, 360);
  if (!release) return { ok: false, status: 409, action: "locked", locked: true, for_session: forSession };
  const started = new Date().toISOString();
  const attempts = (prior?.attempts || 0) + 1;
  try {
    // 1) Finalize prior-session marks + score due forecast points (DB only). Once per day:
    //    an upgrade run skips it when the first run already finalized; eod-mark never scores.
    let markDetail: Record<string, unknown> | null = null;
    const priorMarks = (prior?.detail as { marks?: { error?: string } | null } | undefined)?.marks;
    const marksDone = !!priorMarks && !priorMarks.error;
    if (redisConfigured() && !opts.upgradeOnly && !marksDone) {
      try {
        markDetail = await finalizeMarksAndScore(now);
      } catch (e) {
        markDetail = { error: e instanceof Error ? e.message.slice(0, 160) : "mark_failed" };
      }
    }
    const marks = markDetail ?? (marksDone ? priorMarks! : null);
    // 2) Report
    let report = await getReport(forSession);
    let action = "exists";
    const detail: Record<string, unknown> = { marks };
    if (!report || (report.status === "partial" && canUpgrade)) {
      const base = report;
      const prevKeyDate = (await listReportDates(60)).find((d) => d < forSession) || null;
      const prev = prevKeyDate ? await getReport(prevKeyDate) : null;
      const baseVersion = base ? base.version ?? 1 : 0;
      const gen = await generateReport({
        for_session: forSession,
        prev,
        universe: opts.universe,
        deadlineMs: opts.deadlineMs,
        version: baseVersion + 1,
        supersedes: base
          ? { key: base.key, version: baseVersion, status: base.status, report_hash: base.report_hash, inputs_hash: base.inputs_hash, missing: missingCountOf(base) }
          : null,
      });
      if (!base) {
        const inserted = await putReportOnce(gen.report, gen.inputs);
        report = inserted ? gen.report : await getReport(forSession);
        action = inserted ? `stored_${gen.report.status}` : "exists";
      } else {
        const before = missingCountOf(base);
        const after = missingCountOf(gen.report);
        detail.upgrade = { from_version: baseVersion, missing_before: before, missing_after: after, candidate_status: gen.report.status };
        if (gen.report.status === "complete" || after < before) {
          const up = await putReportUpgrade(gen.report, gen.inputs, baseVersion);
          if (up.ok) {
            report = gen.report;
            action = `upgraded_v${up.version}_${gen.report.status}`;
          } else {
            report = await getReport(forSession);
            action = `upgrade_refused_${up.reason}`;
          }
        } else {
          action = "upgrade_no_improvement";
          detail.still_missing = gen.report.incomplete?.missing_bars.map((x) => x.symbol) ?? [];
        }
      }
    }
    if (!opts.upgradeOnly || action.startsWith("upgraded")) {
      await putJobRun({ job, session_date: forSession, status: report?.status === "complete" ? "complete" : "partial", attempts, trigger_source: opts.source, started_at: started, finished_at: new Date().toISOString(), detail: { action, ...detail, report_status: report?.status, report_version: report?.version ?? 1, report_hash: report?.report_hash, missing: report ? missingCountOf(report) : null } });
    }
    return { ok: true, status: 200, action, for_session: forSession, report: report || undefined, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "failed";
    if (!opts.upgradeOnly) await putJobRun({ job, session_date: forSession, status: "failed", attempts, trigger_source: opts.source, started_at: started, finished_at: new Date().toISOString(), error: msg }).catch(() => {});
    return { ok: false, status: 500, action: "failed", for_session: forSession, error: msg };
  } finally {
    await release();
  }
}
