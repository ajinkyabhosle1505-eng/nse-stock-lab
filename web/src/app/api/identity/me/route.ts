import { NextRequest } from "next/server";
import { j } from "@/lib/apiHelpers";
import { redisConfigured } from "@/lib/redis";
import { getDevice, recoveryConfigured } from "@/lib/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/identity/me — which mode is active for this browser. */
export async function GET(req: NextRequest) {
  if (!redisConfigured()) return j({ storage: "none", server_paper: false, recovery_available: false });
  const dev = await getDevice(req);
  return j({
    storage: "redis",
    server_paper: true,
    device: dev ? { user_id: dev.userId, device_id: dev.deviceId, recovery_code_issued: dev.recoveryIssued } : null,
    recovery_available: recoveryConfigured(),
  });
}
