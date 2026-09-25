import { NextRequest, NextResponse } from "next/server";
import { CORS, serveLatest } from "@/lib/reportService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** GET /api/report/latest — brief §2.6 envelope; self-generates today's report if missing. */
export async function GET(req: NextRequest) {
  const s = await serveLatest(new Date(), req.headers.get("if-none-match"));
  if (s.status === 304) return new NextResponse(null, { status: 304, headers: s.headers });
  return NextResponse.json(s.body, { status: s.status, headers: s.headers });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}
