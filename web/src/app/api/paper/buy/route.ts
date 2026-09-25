import { NextRequest, NextResponse } from "next/server";
import { buildForecastBundle } from "@/lib/forecast";
import { redisConfigured } from "@/lib/redis";
import { SEBI_BANNER } from "@/lib/universe";
import { normalizeNseSymbol } from "@/lib/yahoo";
import type { PaperForecastPosition } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST paper buy — compute atr_piecewise_T1_T2_v1 forecast once.
 * Body: { ticker, entry, sl?, targets?, qty, budget_inr, checkDays, atr_14?, structure?, breakout_state?, sector? }
 * No-DB fallback only (stateless). With Upstash configured this returns 410.
 */
export async function POST(req: NextRequest) {
  if (redisConfigured()) {
    return NextResponse.json(
      { error: "gone", use: "POST /api/paper/positions (server-frozen entry + idempotency_key)", sebi_banner: SEBI_BANNER },
      { status: 410 }
    );
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", sebi_banner: SEBI_BANNER },
      { status: 400 }
    );
  }

  const tickerRaw = String(body.ticker || "").trim();
  if (!tickerRaw) {
    return NextResponse.json(
      { error: "ticker required", sebi_banner: SEBI_BANNER },
      { status: 400 }
    );
  }
  const { ticker, yahoo } = normalizeNseSymbol(tickerRaw);
  const entry = Number(body.entry);
  const qty = Math.max(1, Math.floor(Number(body.qty) || 1));
  const budget_inr = Number(body.budget_inr) || entry * qty;
  const sl = body.sl != null ? Number(body.sl) : null;
  const targets = Array.isArray(body.targets)
    ? (body.targets as unknown[]).map(Number).filter((n) => Number.isFinite(n))
    : [];
  const checkDays = Array.isArray(body.checkDays)
    ? (body.checkDays as unknown[]).map(Number)
    : [7, 14, 30];
  const atr_14 = body.atr_14 != null ? Number(body.atr_14) : null;
  const structure =
    typeof body.structure === "string" ? body.structure : undefined;
  const breakout_state =
    typeof body.breakout_state === "string" ? body.breakout_state : undefined;
  const sector =
    typeof body.sector === "string" ? body.sector : null;

  if (!Number.isFinite(entry) || entry <= 0) {
    return NextResponse.json(
      { error: "entry required", sebi_banner: SEBI_BANNER },
      { status: 400 }
    );
  }

  const boughtAt = new Date().toISOString();
  const forecast = buildForecastBundle({
    action: "buy",
    entry,
    sl,
    targets,
    atr_14,
    checkDays,
    filledAt: boughtAt,
    structure,
    breakout_state,
  });

  const pos: PaperForecastPosition = {
    id: `pf_${ticker}_${Date.now()}`,
    ticker,
    yahoo_symbol: yahoo,
    entry,
    sl: sl != null && Number.isFinite(sl) ? sl : null,
    targets,
    qty,
    budget_inr,
    size_inr: Math.round(entry * qty * 100) / 100,
    boughtAt,
    sector,
    checkDays: forecast?.checkDays || checkDays.map(Number).filter((d) => d >= 1),
    atr_14: atr_14 != null && Number.isFinite(atr_14) ? atr_14 : null,
    structure,
    breakout_state,
    sebi_banner: SEBI_BANNER,
    forecast,
  };

  return NextResponse.json({
    ok: true,
    sebi_banner: SEBI_BANNER,
    note: "No database configured — computed statelessly; the browser (localStorage) is the store.",
    position: pos,
  });
}
