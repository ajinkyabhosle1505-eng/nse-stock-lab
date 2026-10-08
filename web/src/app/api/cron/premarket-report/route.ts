import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cronAuth";
import { runPremarket } from "@/lib/reportService";
import { istParts } from "@/lib/marketCalendar";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron `0 1 * * 1-5` (06:30–07:29 IST) + GitHub Actions backup (07:47 IST).
 * Bearer CRON_SECRET. Idempotent: holiday_skip on NSE holidays, noop once today's
 * report is COMPLETE, 409 if another run holds the lease. Also FINAL marks + scoring
 * (once per day).
 * report_v3.1: the first run always stores v1 (complete or partial). If the stored
 * report is partial, a later call the same IST day (e.g. the 07:47 GHA backup)
 * re-fetches and stores v<n+1> when it is complete or has fewer missing bars.
 * finalize_if_partial=1 is accepted for compatibility (partials are always stored now).
 */
async function handle(req: NextRequest) {
  const auth = checkCronAuth(req.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.error, sebi_banner: SEBI_BANNER }, { status: auth.status });
  const sp = req.nextUrl.searchParams;
  const source = sp.get("source") === "gha" ? "gha" : req.headers.get("user-agent")?.includes("vercel-cron") ? "vercel-cron" : sp.get("source") || "manual";
  const res = await runPremarket({ source, finalizeIfPartial: sp.get("finalize_if_partial") === "1" || source !== "vercel-cron" });
  const r = res.report;
  return NextResponse.json(
    {
      ok: res.ok,
      action: res.action,
      for_session: res.for_session,
      now_ist: istParts().iso,
      source,
      ...(res.locked ? { locked: true } : {}),
      ...(res.noop ? { noop: true } : {}),
      ...(res.error ? { error: res.error } : {}),
      report: r
        ? { key: r.key, version: r.version ?? 1, status: r.status, based_on_close: r.based_on_close, report_hash: r.report_hash, inputs_hash: r.inputs_hash, top10: r.sections.top10_under_1000.items.length, other_buys: r.sections.other_buys_1000_plus?.items.length ?? null, breakout_watch: r.sections.breakout_watch?.items.length ?? null, unknowns: r.unknowns.length, missing_bars: r.incomplete?.missing_bars.map((m) => m.symbol) ?? null, data_fills: r.data_fills?.map((f) => `${f.symbol}:${f.close_source}`) ?? null }
        : null,
      detail: res.detail ?? null,
      sebi_banner: SEBI_BANNER,
    },
    { status: res.status, headers: { "Cache-Control": "no-store" } }
  );
}

export const GET = handle;
export const POST = handle;
