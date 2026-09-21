import { NextRequest, NextResponse } from "next/server";
import { runLookup } from "@/lib/live";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const symbol =
    req.nextUrl.searchParams.get("symbol")?.trim() ||
    req.nextUrl.searchParams.get("ticker")?.trim();
  if (!symbol) {
    return NextResponse.json(
      {
        error: "Missing symbol",
        sebi_banner: SEBI_BANNER,
        hint: "GET /api/lookup?symbol=INFY",
      },
      { status: 400 }
    );
  }

  const budget_inr = Number(req.nextUrl.searchParams.get("budget_inr") || 10000);
  const risk_pct = Number(req.nextUrl.searchParams.get("risk_pct") || 1);

  try {
    const result = await runLookup(symbol, {
      budget_inr: Number.isFinite(budget_inr) && budget_inr > 0 ? budget_inr : 10000,
      risk_pct: Number.isFinite(risk_pct) && risk_pct > 0 ? risk_pct : 1,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "lookup_failed";
    return NextResponse.json(
      {
        ticker: symbol.toUpperCase(),
        error: msg,
        cmp: "UNKNOWN",
        sebi_banner: SEBI_BANNER,
        note: "Yahoo fetch failed — prices not invented",
      },
      { status: 502 }
    );
  }
}
