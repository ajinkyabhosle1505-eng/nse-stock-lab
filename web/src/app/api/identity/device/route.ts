import { NextRequest } from "next/server";
import { j, noDb } from "@/lib/apiHelpers";
import { redisConfigured } from "@/lib/redis";
import { DEVICE_COOKIE, cookieOptions, cookieValue, createUserAndDevice, getDevice, ipHash, rateLimit, recoveryConfigured } from "@/lib/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/identity/device — get-or-create the anonymous device (HttpOnly cookie).
 * New user → recovery code returned ONCE (only if RECOVERY_PEPPER is set).
 */
export async function POST(req: NextRequest) {
  if (!redisConfigured()) return noDb();
  const existing = await getDevice(req);
  if (existing) {
    return j({ user_id: existing.userId, device_id: existing.deviceId, created: false, recovery_code_issued: existing.recoveryIssued, recovery_available: recoveryConfigured() });
  }
  if (!(await rateLimit(`dev:${ipHash(req)}`, 20, 3600))) return j({ error: "rate_limited" }, 429);
  const made = await createUserAndDevice(req.headers.get("user-agent"));
  const res = j({
    user_id: made.userId,
    device_id: made.deviceId,
    created: true,
    recovery_code: made.recoveryCode,
    recovery_available: recoveryConfigured(),
    note: made.recoveryCode
      ? "Save this recovery code now — it is shown once and is the only way to restore these paper trades on another device."
      : "Recovery codes are not enabled on this deployment yet (RECOVERY_PEPPER unset). Trades stay tied to this browser.",
  }, 201);
  res.cookies.set(DEVICE_COOKIE, cookieValue(made.deviceId, made.secret), cookieOptions());
  return res;
}
