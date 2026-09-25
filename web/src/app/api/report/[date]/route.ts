import { NextRequest, NextResponse } from "next/server";
import { CORS, serveDate } from "@/lib/reportService";
import { isValidIsoDate } from "@/lib/marketCalendar";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** GET /api/report/YYYY-MM-DD — immutable snapshot for that session (404 + nearest_prev). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ date: string }> }) {
  const { date } = await ctx.params;
  if (!isValidIsoDate(date)) {
    return NextResponse.json({ error: "bad_date", hint: "YYYY-MM-DD", sebi_banner: SEBI_BANNER }, { status: 400, headers: CORS });
  }
  const s = await serveDate(date);
  return NextResponse.json(s.body, { status: s.status, headers: s.headers });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}
