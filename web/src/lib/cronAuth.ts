import { timingSafeEqual } from "crypto";

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when the CRON_SECRET
 * env var is set on the project. Fail closed when it is not configured.
 */
export function checkCronAuth(authHeader: string | null):
  | { ok: true }
  | { ok: false; status: number; error: string } {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return { ok: false, status: 503, error: "cron_secret_not_configured" };
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(authHeader || "");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}
