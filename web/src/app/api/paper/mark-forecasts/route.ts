import { NextRequest, NextResponse } from "next/server";
import { markPositions } from "@/lib/paperMark";
import { redisConfigured } from "@/lib/redis";
import { SEBI_BANNER } from "@/lib/universe";
import type { PaperForecastPosition } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/paper/mark-forecasts { positions } — no-DB fallback only.
 * Stateless: marks the browser's positions with FINAL Yahoo closes and returns
 * them. With Upstash configured the server never trusts client bundles → 410
 * (use GET /api/paper/portfolio?mark=1).
 */
export async function POST(req: NextRequest) {
  if (redisConfigured()) {
    return NextResponse.json(
      { error: "gone", use: "GET /api/paper/portfolio?mark=1", sebi_banner: SEBI_BANNER },
      { status: 410 }
    );
  }
  let body: { positions?: PaperForecastPosition[] } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const input = Array.isArray(body.positions) ? body.positions.slice(0, 200) : [];
  if (!input.length) {
    return NextResponse.json({ ok: true, sebi_banner: SEBI_BANNER, positions: [], note: "No positions to mark" });
  }
  const res = await markPositions(input);
  return NextResponse.json({
    ok: true,
    sebi_banner: SEBI_BANNER,
    positions: res.positions,
    changed: res.changedIds.length,
    yahoo_errors: res.yahooErrors,
    note: "Browser-mode marks (unverified). Final closes only; >15% jumps flagged and excluded.",
  });
}
