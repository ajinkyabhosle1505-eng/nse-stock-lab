import { NextRequest } from "next/server";
import { j, noDb, requireDevice } from "@/lib/apiHelpers";
import { loadViews, scoreViews, userPositionIds } from "@/lib/paperServer";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/paper/scores — this device's scores; ?scope=global = all server-frozen forecasts (public). */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("scope") === "global") {
    const r = getRedis();
    if (!r) return noDb();
    const ids = ((await r.smembers("pos:all")) as unknown[]).map(String).slice(0, 2000);
    const views = await loadViews(ids);
    const s = scoreViews(views);
    return j({ scope: "global", positions: views.length, verified: s.verified, note: s.note, updated_at: await r.get("score:global:updated_at") }, 200, { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" });
  }
  const dev = await requireDevice(req);
  if (!("userId" in dev)) return dev;
  const views = await loadViews(await userPositionIds(dev.userId));
  return j({ scope: "user", ...scoreViews(views) });
}
