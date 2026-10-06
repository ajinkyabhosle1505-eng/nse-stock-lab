import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cronAuth";
import { acquireLease, getJobRun, putJobRun } from "@/lib/jobs/lock";
import { runProvisionalMarks } from "@/lib/jobs/mark";
import { runPremarket } from "@/lib/reportService";
import { holidayName, isTradingDay, istDate, istParts } from "@/lib/marketCalendar";
import { redisConfigured } from "@/lib/redis";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron `0 11 * * 1-5` (16:30–17:29 IST) + GHA backup (18:07 IST).
 * PROVISIONAL marks only (display). No scoring — final marks/scores happen in
 * the next morning's premarket run.
 * report_v3.1: afterwards, if today's report is still PARTIAL (missing based_on_close
 * bars), retry it once (re-fetch → store v<n+1> only if complete / fewer missing bars).
 * Never builds a first version, never touches a complete report, never scores.
 */
async function retryPartialReport(today: string, source: string, t0: number) {
  const left = 300_000 - (Date.now() - t0);
  if (left < 200_000) return { action: "skipped_no_time", left_ms: left };
  const res = await runPremarket({ source: `eod-mark:${source}`, forSession: today, upgradeOnly: true, deadlineMs: Math.min(150_000, left - 60_000) });
  return { action: res.action, report_status: res.report?.status ?? null, report_version: res.report?.version ?? (res.report ? 1 : null), ...(res.error ? { error: res.error } : {}) };
}

async function handle(req: NextRequest) {
  const auth = checkCronAuth(req.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.error, sebi_banner: SEBI_BANNER }, { status: auth.status });
  const job = "eod-mark";
  const t0 = Date.now();
  const now = new Date();
  const today = istDate(now);
  const source = req.nextUrl.searchParams.get("source") || "vercel-cron";
  const base = { job, session_date: today, now_ist: istParts(now).iso, source, sebi_banner: SEBI_BANNER };
  if (!isTradingDay(today)) {
    await putJobRun({ job, session_date: today, status: "holiday_skip", attempts: 1, trigger_source: source, started_at: now.toISOString(), finished_at: now.toISOString(), detail: { holiday: holidayName(today) || "weekend" } });
    return NextResponse.json({ ...base, ok: true, action: "holiday_skip" });
  }
  if (!redisConfigured()) {
    return NextResponse.json({ ...base, ok: true, action: "skipped_no_db", note: "No UPSTASH_REDIS_REST_* env — nothing server-side to mark (paper trades live in the browser)." });
  }
  const prior = await getJobRun(job, today);
  if (prior?.status === "complete") {
    const report_retry = await retryPartialReport(today, source, t0).catch((e) => ({ action: "failed", error: e instanceof Error ? e.message.slice(0, 160) : "failed" }));
    return NextResponse.json({ ...base, ok: true, action: "noop", prior, report_retry });
  }
  const release = await acquireLease(job, today, 300);
  if (!release) return NextResponse.json({ ...base, ok: false, locked: true }, { status: 409 });
  const started = new Date().toISOString();
  try {
    const detail = await runProvisionalMarks(now);
    const status = "not_settled_yet" in detail && detail.not_settled_yet ? "partial" : "complete";
    await putJobRun({ job, session_date: today, status, attempts: (prior?.attempts || 0) + 1, trigger_source: source, started_at: started, finished_at: new Date().toISOString(), detail });
    await release();
    const report_retry = await retryPartialReport(today, source, t0).catch((e) => ({ action: "failed", error: e instanceof Error ? e.message.slice(0, 160) : "failed" }));
    return NextResponse.json({ ...base, ok: true, action: status, detail, report_retry, note: "Provisional marks only; FINAL marks + scoring run in the next pre-market job." });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "failed";
    await putJobRun({ job, session_date: today, status: "failed", attempts: (prior?.attempts || 0) + 1, trigger_source: source, started_at: started, finished_at: new Date().toISOString(), error: msg });
    return NextResponse.json({ ...base, ok: false, error: msg }, { status: 500 });
  } finally {
    await release();
  }
}

export const GET = handle;
export const POST = handle;
