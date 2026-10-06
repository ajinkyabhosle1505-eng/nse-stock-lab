import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cronAuth";
import { runPremarket } from "@/lib/reportService";
import { istParts } from "@/lib/marketCalendar";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Second pre-market pass (report_v3.1). Vercel Cron `15 2 * * 1-5` → 07:45–08:44 IST
 * (Hobby: once a day, fires anywhere inside the hour). Bearer CRON_SECRET.
 *   today's report is partial  → re-fetch + rebuild; store v<n+1> if complete / fewer missing bars
 *   today's report is complete → noop (a complete report is never superseded)
 *   no report yet (first cron missed) → builds + stores v1, like the main cron
 * Same job lease as /api/cron/premarket-report, so the two never run concurrently.
 */
async function handle(req: NextRequest) {
  const auth = checkCronAuth(req.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.error, sebi_banner: SEBI_BANNER }, { status: auth.status });
  const source = req.nextUrl.searchParams.get("source") || (req.headers.get("user-agent")?.includes("vercel-cron") ? "vercel-cron-retry" : "manual-retry");
  const res = await runPremarket({ source, allowUpgrade: true });
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
        ? { key: r.key, version: r.version ?? 1, status: r.status, based_on_close: r.based_on_close, report_hash: r.report_hash, inputs_hash: r.inputs_hash, missing_bars: r.incomplete?.missing_bars.map((m) => m.symbol) ?? null, data_fills: r.data_fills?.map((f) => `${f.symbol}:${f.close_source}`) ?? null }
        : null,
      detail: res.detail ?? null,
      sebi_banner: SEBI_BANNER,
    },
    { status: res.status, headers: { "Cache-Control": "no-store" } }
  );
}

export const GET = handle;
export const POST = handle;
