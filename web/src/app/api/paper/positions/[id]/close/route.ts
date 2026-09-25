import { NextRequest } from "next/server";
import { j, readJson, requireDevice } from "@/lib/apiHelpers";
import { appendClose, getPosition, loadViews } from "@/lib/paperServer";
import { fetchYahooChartX } from "@/lib/yahoo";
import { istDate, isTradingDay, prevTradingDay, sessionPhase, tradingDayOnOrBefore } from "@/lib/marketCalendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/** POST /api/paper/positions/:id/close — append-only close event at a server price. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const dev = await requireDevice(req);
  if (!("userId" in dev)) return dev;
  const { id } = await ctx.params;
  const pos = await getPosition(id);
  if (!pos || pos.user_id !== dev.userId) return j({ error: "not_found" }, 404);
  await readJson(req);
  const res = await fetchYahooChartX(pos.yahoo_symbol, "5d", { minBars: 1 });
  const now = new Date();
  const phase = sessionPhase(now);
  const today = istDate(now);
  let price: number | null = null;
  let session_date: string;
  let basis: string;
  if (phase === "open") {
    price = res.regularMarketPrice;
    session_date = today;
    basis = "ltp_intraday";
  } else {
    const last = res.bars.at(-1);
    price = last?.close ?? null;
    session_date = last?.date || (isTradingDay(today) ? prevTradingDay(today) : tradingDayOnOrBefore(today));
    basis = "last_close";
  }
  if (price == null || !(price > 0)) return j({ error: "quote_unavailable", yahoo: res.error || null }, 502);
  const out = await appendClose(pos, { type: "close", session_date, price: Math.round(price * 100) / 100, basis, at: now.toISOString() });
  const [view] = await loadViews([id]);
  return j({ ok: true, created: out.created, event: out.event, position: view }, out.created ? 201 : 200);
}
