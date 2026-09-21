import { NextRequest, NextResponse } from "next/server";
import { runBudgetPicks } from "@/lib/live";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { budget_inr?: number; risk_pct?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const budget_inr =
    body.budget_inr != null && Number.isFinite(Number(body.budget_inr))
      ? Number(body.budget_inr)
      : 10000;
  const risk_pct =
    body.risk_pct != null && Number.isFinite(Number(body.risk_pct))
      ? Number(body.risk_pct)
      : 1;

  if (!(budget_inr > 0)) {
    return NextResponse.json(
      { error: "budget_inr must be > 0", sebi_banner: SEBI_BANNER },
      { status: 400 }
    );
  }

  try {
    const result = await runBudgetPicks(budget_inr, risk_pct > 0 ? risk_pct : 1);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "budget_picks_failed";
    return NextResponse.json(
      { error: msg, sebi_banner: SEBI_BANNER, picks: [] },
      { status: 502 }
    );
  }
}

/** Allow GET for quick curl smoke: /api/budget-picks?budget_inr=10000&risk_pct=1 */
export async function GET(req: NextRequest) {
  const budget_inr = Number(req.nextUrl.searchParams.get("budget_inr") || 10000);
  const risk_pct = Number(req.nextUrl.searchParams.get("risk_pct") || 1);
  try {
    const result = await runBudgetPicks(
      Number.isFinite(budget_inr) && budget_inr > 0 ? budget_inr : 10000,
      Number.isFinite(risk_pct) && risk_pct > 0 ? risk_pct : 1
    );
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "budget_picks_failed";
    return NextResponse.json(
      { error: msg, sebi_banner: SEBI_BANNER, picks: [] },
      { status: 502 }
    );
  }
}
