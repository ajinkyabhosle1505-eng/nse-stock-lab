import { NextRequest, NextResponse } from "next/server";
import { markForecastPoints, istDateString } from "@/lib/forecast";
import { serverList, serverUpsert } from "@/lib/paperServerStore";
import { SEBI_BANNER } from "@/lib/universe";
import { fetchYahooDailyBars } from "@/lib/yahoo";
import type { ForecastBundle, PaperForecastPosition } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/paper/mark-forecasts
 * Body: { positions?: PaperForecastPosition[] } — if omitted, marks in-memory store.
 * For each due pending point, Yahoo daily close on/after targetDate (±3d).
 * Never invents CMP — sparse/error on failure.
 */
export async function POST(req: NextRequest) {
  let body: { positions?: PaperForecastPosition[] } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const input =
    Array.isArray(body.positions) && body.positions.length
      ? body.positions
      : serverList();

  if (!input.length) {
    return NextResponse.json({
      ok: true,
      sebi_banner: SEBI_BANNER,
      positions: [],
      note: "No positions to mark",
    });
  }

  const today = istDateString();
  const out: PaperForecastPosition[] = [];

  for (const pos of input) {
    if (!pos.forecast || pos.forecast.status === "skipped") {
      out.push(pos);
      continue;
    }
    const due = pos.forecast.points.some(
      (p) => p.status === "pending" && p.targetDate <= today
    );
    if (!due) {
      out.push(pos);
      continue;
    }

    let bars: Awaited<ReturnType<typeof fetchYahooDailyBars>> = null;
    try {
      bars = await fetchYahooDailyBars(pos.yahoo_symbol || `${pos.ticker}.NS`, "3mo");
    } catch {
      bars = null;
    }

    let forecast: ForecastBundle = pos.forecast;
    if (!bars || !bars.length) {
      // Mark due points as error — never invent
      forecast = {
        ...pos.forecast,
        points: pos.forecast.points.map((p) =>
          p.status === "pending" && p.targetDate <= today
            ? {
                ...p,
                status: "error" as const,
                actualClose: null,
                actualSessionDate: null,
              }
            : p
        ),
      };
    } else {
      forecast = markForecastPoints(pos.forecast, bars, today);
    }

    const next = { ...pos, forecast };
    serverUpsert(next);
    out.push(next);
  }

  return NextResponse.json({
    ok: true,
    sebi_banner: SEBI_BANNER,
    as_of: new Date().toISOString(),
    note: "Marked with Yahoo daily closes only. UNKNOWN/sparse when missing — never invented.",
    positions: out,
  });
}
