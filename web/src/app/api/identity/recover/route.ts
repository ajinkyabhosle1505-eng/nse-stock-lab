import { NextRequest } from "next/server";
import { j, noDb, readJson } from "@/lib/apiHelpers";
import { redisConfigured } from "@/lib/redis";
import { DEVICE_COOKIE, cookieOptions, cookieValue, ipHash, normalizeCode, rateLimit, recoverWithCode, recoveryConfigured } from "@/lib/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/identity/recover {code} — attach this browser to the code's user. 5/hr per IP hash. */
export async function POST(req: NextRequest) {
  if (!redisConfigured()) return noDb();
  if (!recoveryConfigured()) return j({ error: "recovery_not_configured" }, 503);
  if (!(await rateLimit(`recover:${ipHash(req)}`, 5, 3600))) return j({ error: "rate_limited", retry_after_s: 3600 }, 429);
  const body = await readJson<{ code?: string }>(req);
  const code = normalizeCode(String(body?.code || ""));
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(code)) return j({ error: "bad_code_format", hint: "XXXX-XXXX-XXXX" }, 400);
  const out = await recoverWithCode(code, req.headers.get("user-agent"));
  if (!out) return j({ error: "invalid_code" }, 401);
  const res = j({ user_id: out.userId, device_id: out.deviceId, recovered: true });
  res.cookies.set(DEVICE_COOKIE, cookieValue(out.deviceId, out.secret), cookieOptions());
  return res;
}
