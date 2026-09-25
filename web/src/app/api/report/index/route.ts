import { NextRequest, NextResponse } from "next/server";
import { CORS, serveIndex } from "@/lib/reportService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/report/index?limit=30 — stored report keys, newest first. */
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") || 30) || 30;
  const s = await serveIndex(limit);
  return NextResponse.json(s.body, { status: s.status, headers: s.headers });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}
