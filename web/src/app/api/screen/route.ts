import { NextRequest, NextResponse } from "next/server";
import { runScreen } from "@/lib/screen";
import { SEBI_BANNER } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  budget_inr?: number;
  sectors?: string[];
  pe_max?: number;
  roe_min?: number;
  min_volume_vs_avg?: number;
  risk_pct?: number;
};

function parseBody(raw: Body) {
  const budget_inr =
    raw.budget_inr != null && Number.isFinite(Number(raw.budget_inr))
      ? Number(raw.budget_inr)
      : 10000;
  const risk_pct =
    raw.risk_pct != null && Number.isFinite(Number(raw.risk_pct))
      ? Number(raw.risk_pct)
      : 1;
  const sectors = Array.isArray(raw.sectors)
    ? raw.sectors.map(String).filter(Boolean)
    : undefined;
  const pe_max =
    raw.pe_max != null && Number.isFinite(Number(raw.pe_max))
      ? Number(raw.pe_max)
      : undefined;
  const roe_min =
    raw.roe_min != null && Number.isFinite(Number(raw.roe_min))
      ? Number(raw.roe_min)
      : undefined;
  const min_volume_vs_avg =
    raw.min_volume_vs_avg != null &&
    Number.isFinite(Number(raw.min_volume_vs_avg))
      ? Number(raw.min_volume_vs_avg)
      : undefined;
  return { budget_inr, risk_pct, sectors, pe_max, roe_min, min_volume_vs_avg };
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const parsed = parseBody(body);
  if (!(parsed.budget_inr > 0)) {
    return NextResponse.json(
      { error: "budget_inr must be > 0", sebi_banner: SEBI_BANNER },
      { status: 400 }
    );
  }

  try {
    const result = await runScreen(parsed);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "screen_failed";
    return NextResponse.json(
      { error: msg, sebi_banner: SEBI_BANNER, results: [], fits: [] },
      { status: 502 }
    );
  }
}

/** GET smoke: /api/screen?budget_inr=10000 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sectorsRaw = sp.get("sectors");
  const parsed = parseBody({
    budget_inr: Number(sp.get("budget_inr") || 10000),
    risk_pct: Number(sp.get("risk_pct") || 1),
    sectors: sectorsRaw
      ? sectorsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    pe_max: sp.get("pe_max") != null ? Number(sp.get("pe_max")) : undefined,
    roe_min: sp.get("roe_min") != null ? Number(sp.get("roe_min")) : undefined,
    min_volume_vs_avg:
      sp.get("min_volume_vs_avg") != null
        ? Number(sp.get("min_volume_vs_avg"))
        : undefined,
  });
  try {
    const result = await runScreen({
      ...parsed,
      budget_inr:
        Number.isFinite(parsed.budget_inr) && parsed.budget_inr > 0
          ? parsed.budget_inr
          : 10000,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "screen_failed";
    return NextResponse.json(
      { error: msg, sebi_banner: SEBI_BANNER, results: [], fits: [] },
      { status: 502 }
    );
  }
}
