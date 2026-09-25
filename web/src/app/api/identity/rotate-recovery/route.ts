import { NextRequest } from "next/server";
import { j, requireDevice } from "@/lib/apiHelpers";
import { rateLimit, recoveryConfigured, rotateRecovery } from "@/lib/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/identity/rotate-recovery — new code shown once; old code stops working. */
export async function POST(req: NextRequest) {
  const dev = await requireDevice(req);
  if (!("userId" in dev)) return dev;
  if (!recoveryConfigured()) return j({ error: "recovery_not_configured" }, 503);
  if (!(await rateLimit(`rotate:${dev.userId}`, 5, 86400))) return j({ error: "rate_limited" }, 429);
  const code = await rotateRecovery(dev.userId);
  return j({ recovery_code: code, note: "Old code no longer works. Save this one now — shown once." });
}
