import { NextRequest } from "next/server";
import { j, requireDevice } from "@/lib/apiHelpers";
import { loadViews, scoreViews, userPositionIds } from "@/lib/paperServer";
import { finalizeMarksAndScore } from "@/lib/jobs/mark";
import { rateLimit } from "@/lib/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/paper/portfolio[?mark=1] — this device's server-frozen paper book. */
export async function GET(req: NextRequest) {
  const dev = await requireDevice(req);
  if (!("userId" in dev)) return dev;
  const ids = await userPositionIds(dev.userId);
  let mark: unknown = null;
  if (req.nextUrl.searchParams.get("mark") === "1" && ids.length && (await rateLimit(`lazymark:${dev.userId}`, 6, 3600))) {
    try {
      mark = await finalizeMarksAndScore(new Date(), ids);
    } catch (e) {
      mark = { error: e instanceof Error ? e.message.slice(0, 120) : "mark_failed" };
    }
  }
  const positions = await loadViews(ids);
  return j({
    storage: "redis",
    user_id: dev.userId,
    positions,
    scores: scoreViews(positions),
    lazy_mark: mark,
    marks_note: "P&L uses the latest mark: 'provisional' = same-evening close (can still change), 'final' = confirmed next morning. Scores use FINAL closes only.",
  });
}
