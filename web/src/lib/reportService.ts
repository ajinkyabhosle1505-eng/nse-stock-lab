/**
 * Serving + cron orchestration for the pre-market report.
 *
 * /api/report/latest:
 *   target session = today if today is a trading day and it's ≥ 06:00 IST,
 *   else the last trading day (brief §2.6 expected_session).
 *   Missing target on a trading day → self-generate under the job lease
 *   (so CoS at 08:53 IST always gets today's report even if cron was missed).
 *   Weekend/holiday → last stored report + `holiday` note (never generated
 *   for a closed day). stale/age_hours are computed at serve time, never stored.
 */
import { generateReport } from "./report";
import type { ReportV1 } from "./reportTypes";
import {
  getReport,
  latestReportDate,
  listReportDates,
  putReportOnce,
  storageMode,
  type StorageMode,
} from "./reportStore";
import {
  expectedReportSession,
  holidayName,
  isTradingDay,
  istParts,
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

function envelope(report: ReportV1, now: Date, storage: StorageMode, served: Record<string, unknown>) {
  const p = istParts(now);
  const expected = expectedReportSession(now);
  const closedToday = !isTradingDay(p.date);
  const wd = weekdayOf(p.date);
  return {
    report,
    stale: report.for_session < expected,
    age_hours: Math.round(((now.getTime() - Date.parse(report.generated_at)) / 3600000) * 10) / 10,
    expected_session: expected,
    ...(closedToday
      ? { holiday: { date: p.date, name: holidayName(p.date) || (wd === 0 || wd === 6 ? "Weekend" : "NSE closed") } }
      : {}),
    served_at: now.toISOString(),
    storage,
    ...(storage === "ephemeral"
      ? { storage_note: "No database configured — generated on demand and cached per instance + CDN; not a durable archive." }
      : {}),
    served,
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
      const run = await runPremarket({ source: "self_heal", now, forSession: target, finalizeIfPartial: true });
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
      body: { error: "no_report_available", note: note || "No report yet.", expected_session: expectedReportSession(now), storage, sebi_banner: SEBI_BANNER },
      headers: { ...CORS, "Cache-Control": "no-store" },
    };
  }
  const tag = `"${report.report_hash}"`;
  const cache = note ? "no-store" : "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";
  if (ifNoneMatch && ifNoneMatch === tag) return { status: 304, body: {}, headers: okHeaders(report, cache) };
  return {
    status: 200,
    body: envelope(report, now, storage, { source, requested_session: target, ...(note ? { note } : {}) }),
    headers: okHeaders(report, cache),
  };
}

export async function serveDate(date: string, now: Date = new Date()): Promise<Served> {
  const storage = storageMode();
  let report = await getReport(date);
  if (!report && date === targetSession(now) && date === istParts(now).date) {
    const run = await runPremarket({ source: "self_heal", now, forSession: date, finalizeIfPartial: true });
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
      : "public, s-maxage=300, stale-while-revalidate=3600";
  return { status: 200, body: { report, storage, sebi_banner: SEBI_BANNER }, headers: okHeaders(report, cache) };
}

export async function serveIndex(limit = 30): Promise<Served> {
  const dates = await listReportDates(Math.min(60, Math.max(1, limit)));
  const items = [];
  for (const d of dates) {
    const r = await getReport(d);
    if (r) items.push({ key: r.key, for_session: r.for_session, based_on_close: r.based_on_close, status: r.status, report_hash: r.report_hash });
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

/** Idempotent premarket job: finalize marks + score, then build/store report. */
export async function runPremarket(opts: {
  source: string;
  now?: Date;
  forSession?: string;
  finalizeIfPartial?: boolean;
}): Promise<PremarketResult> {
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

async function runPremarketInner(opts: { source: string; now: Date; forSession: string; finalizeIfPartial?: boolean }): Promise<PremarketResult> {
  const { now, forSession } = opts;
  const job = "premarket-report";
  if (!isTradingDay(forSession)) {
    await putJobRun({ job, session_date: forSession, status: "holiday_skip", attempts: 1, trigger_source: opts.source, started_at: now.toISOString(), finished_at: new Date().toISOString(), detail: { holiday: holidayName(forSession) || "weekend" } });
    return { ok: true, status: 200, action: "holiday_skip", for_session: forSession };
  }
  const prior = await getJobRun(job, forSession);
  const stored = await getReport(forSession);
  if (stored && prior?.status === "complete") {
    return { ok: true, status: 200, action: "noop", noop: true, for_session: forSession, report: stored };
  }
  const release = await acquireLease(job, forSession, 360);
  if (!release) return { ok: false, status: 409, action: "locked", locked: true, for_session: forSession };
  const started = new Date().toISOString();
  try {
    // 1) Finalize prior-session marks + score due forecast points (DB only)
    let markDetail: Record<string, unknown> | null = null;
    if (redisConfigured()) {
      try {
        markDetail = await finalizeMarksAndScore(now);
      } catch (e) {
        markDetail = { error: e instanceof Error ? e.message.slice(0, 160) : "mark_failed" };
      }
    }
    // 2) Report (write-once)
    let report = await getReport(forSession);
    let action = "exists";
    if (!report) {
      const prevDate = await latestReportDate();
      const prev = prevDate && prevDate < forSession ? await getReport(prevDate) : null;
      const gen = await generateReport({ for_session: forSession, prev });
      const store = gen.report.status === "complete" || opts.finalizeIfPartial || opts.source !== "vercel-cron";
      if (store) {
        const inserted = await putReportOnce(gen.report, gen.inputs);
        report = inserted ? gen.report : await getReport(forSession);
        action = inserted ? `stored_${gen.report.status}` : "exists";
      } else {
        await putJobRun({ job, session_date: forSession, status: "partial", attempts: (prior?.attempts || 0) + 1, trigger_source: opts.source, started_at: started, finished_at: new Date().toISOString(), detail: { unknowns: gen.report.unknowns.length, note: "partial not stored; GHA backup (finalize_if_partial=1) or /latest self-heal will store" } });
        return { ok: true, status: 202, action: "partial_not_stored", for_session: forSession, detail: { unknowns: gen.report.unknowns } };
      }
    }
    await putJobRun({ job, session_date: forSession, status: "complete", attempts: (prior?.attempts || 0) + 1, trigger_source: opts.source, started_at: started, finished_at: new Date().toISOString(), detail: { action, marks: markDetail, report_status: report?.status, report_hash: report?.report_hash } });
    return { ok: true, status: 200, action, for_session: forSession, report: report || undefined, detail: { marks: markDetail } };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "failed";
    await putJobRun({ job, session_date: forSession, status: "failed", attempts: (prior?.attempts || 0) + 1, trigger_source: opts.source, started_at: started, finished_at: new Date().toISOString(), error: msg }).catch(() => {});
    return { ok: false, status: 500, action: "failed", for_session: forSession, error: msg };
  } finally {
    await release();
  }
}
