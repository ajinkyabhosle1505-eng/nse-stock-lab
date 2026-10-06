import { NextRequest, NextResponse } from "next/server";
import { CORS, serveDate } from "@/lib/reportService";
import { isValidIsoDate } from "@/lib/marketCalendar";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** GET /api/report/YYYY-MM-DD[?version=n] — newest version for that session (404 + nearest_prev); ?version=n = that stored version (audit). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ date: string }> }) {
  const { date } = await ctx.params;
  if (!isValidIsoDate(date)) {
    return NextResponse.json({ error: "bad_date", hint: "YYYY-MM-DD", sebi_banner: SEBI_BANNER }, { status: 400, headers: CORS });
  }
  const vq = req.nextUrl.searchParams.get("version");
  const version = vq && /^[1-9]\d{0,1}$/.test(vq) ? Number(vq) : undefined;
  if (vq && version == null) return NextResponse.json({ error: "bad_version", hint: "?version=1..", sebi_banner: SEBI_BANNER }, { status: 400, headers: CORS });
  const s = await serveDate(date, new Date(), version);
  return NextResponse.json(s.body, { status: s.status, headers: s.headers });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}
