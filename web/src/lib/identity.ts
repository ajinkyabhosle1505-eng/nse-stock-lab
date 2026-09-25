/**
 * Anonymous identity (brief §3.2, stored in Upstash Redis instead of Postgres).
 *   dev:<device_id>   {user_id, secret_hash, created_at, revoked_at, ua_family}
 *   user:<user_id>    {created_at, recovery_hmac, recovery_rotated_at}
 *   recovery:<hmac>   user_id
 * Cookie sl_dev=<device_id>.<secret> (HttpOnly; Secure; SameSite=Lax; 400 days).
 * The secret never reaches JS; only sha256(secret) is stored.
 * Recovery code: 12 Crockford base32 chars (60 bits) shown as XXXX-XXXX-XXXX,
 * stored as HMAC-SHA256(RECOVERY_PEPPER, normalized code).
 */
import { randomBytes, randomUUID } from "crypto";
import type { NextRequest } from "next/server";
import { getRedis, mustRedis, parseJson } from "./redis";
import { hmacHex, randomToken, safeEqualHex, sha256hex } from "./hash";

export const DEVICE_COOKIE = "sl_dev";
export const COOKIE_MAX_AGE = 34_560_000; // 400 days

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface DeviceRow {
  user_id: string;
  secret_hash: string;
  created_at: string;
  revoked_at: string | null;
  ua_family: string | null;
}
export interface UserRow {
  created_at: string;
  recovery_hmac: string | null;
  recovery_rotated_at: string | null;
}

export function recoveryConfigured(): boolean {
  return !!process.env.RECOVERY_PEPPER?.trim();
}

export function newRecoveryCode(): string {
  const bytes = randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += CROCKFORD[bytes[i] & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function recoveryHmac(code: string): string {
  const pepper = process.env.RECOVERY_PEPPER?.trim();
  if (!pepper) throw new Error("recovery_pepper_not_configured");
  return hmacHex(pepper, normalizeCode(code));
}

function uaFamily(ua: string | null): string | null {
  if (!ua) return null;
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Other";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Other";
  return `${b}/${os}`;
}

export function cookieValue(deviceId: string, secret: string): string {
  return `${deviceId}.${secret}`;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}

async function createDeviceFor(userId: string, ua: string | null) {
  const r = mustRedis();
  const deviceId = randomUUID();
  const secret = randomToken(32);
  const row: DeviceRow = {
    user_id: userId,
    secret_hash: sha256hex(secret),
    created_at: new Date().toISOString(),
    revoked_at: null,
    ua_family: uaFamily(ua),
  };
  const ok = await r.set(`dev:${deviceId}`, JSON.stringify(row), { nx: true });
  if (ok !== "OK") throw new Error("device_collision");
  await r.sadd(`user:${userId}:devices`, deviceId);
  return { deviceId, secret };
}

/** New user + device. Recovery code issued only when RECOVERY_PEPPER is set. */
export async function createUserAndDevice(ua: string | null) {
  const r = mustRedis();
  const userId = randomUUID();
  let code: string | null = null;
  let hmac: string | null = null;
  if (recoveryConfigured()) {
    code = newRecoveryCode();
    hmac = recoveryHmac(code);
  }
  const user: UserRow = { created_at: new Date().toISOString(), recovery_hmac: hmac, recovery_rotated_at: null };
  await r.set(`user:${userId}`, JSON.stringify(user), { nx: true });
  if (hmac) await r.set(`recovery:${hmac}`, userId, { nx: true });
  const dev = await createDeviceFor(userId, ua);
  await audit(`device:${dev.deviceId}`, userId, "device.create", "user", userId);
  return { userId, ...dev, recoveryCode: code };
}

export async function recoverWithCode(code: string, ua: string | null) {
  const r = mustRedis();
  const userId = await r.get(`recovery:${recoveryHmac(code)}`);
  if (typeof userId !== "string" || !userId) return null;
  const dev = await createDeviceFor(userId, ua);
  await audit(`device:${dev.deviceId}`, userId, "device.recover", "user", userId);
  return { userId, ...dev };
}

export async function rotateRecovery(userId: string): Promise<string> {
  const r = mustRedis();
  const user = parseJson<UserRow>(await r.get(`user:${userId}`));
  if (!user) throw new Error("user_not_found");
  const code = newRecoveryCode();
  const hmac = recoveryHmac(code);
  if (user.recovery_hmac) await r.del(`recovery:${user.recovery_hmac}`);
  await r.set(`recovery:${hmac}`, userId);
  const next: UserRow = { ...user, recovery_hmac: hmac, recovery_rotated_at: new Date().toISOString() };
  await r.set(`user:${userId}`, JSON.stringify(next));
  await audit("system", userId, "recovery.rotate", "user", userId);
  return code;
}

export interface DeviceAuth {
  deviceId: string;
  userId: string;
  recoveryIssued: boolean;
}

/** Parse + verify the device cookie. Null if missing/invalid/revoked or no DB. */
export async function getDevice(req: NextRequest): Promise<DeviceAuth | null> {
  const r = getRedis();
  if (!r) return null;
  const raw = req.cookies.get(DEVICE_COOKIE)?.value || "";
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const deviceId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(deviceId) || secret.length < 20) return null;
  const row = parseJson<DeviceRow>(await r.get(`dev:${deviceId}`));
  if (!row || row.revoked_at) return null;
  if (!safeEqualHex(sha256hex(secret), row.secret_hash)) return null;
  const user = parseJson<UserRow>(await r.get(`user:${row.user_id}`));
  return { deviceId, userId: row.user_id, recoveryIssued: !!user?.recovery_hmac };
}

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

export function ipHash(req: NextRequest): string {
  return sha256hex(`${process.env.IP_HASH_SALT || "nse-stock-lab"}|${clientIp(req)}`).slice(0, 32);
}

/** Fixed-window rate limit (INCR + EXPIRE). Returns true if allowed. */
export async function rateLimit(bucket: string, limit: number, windowSec: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  const w = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${windowSec}:${w}`;
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, windowSec + 60);
  return n <= limit;
}

/** Append-only audit trail (Redis list, newest last; capped at 50k). */
export async function audit(actor: string, userId: string | null, action: string, entity: string, entityId: string, detail?: unknown, hash?: string) {
  const r = getRedis();
  if (!r) return;
  await r.rpush("audit", JSON.stringify({ at: new Date().toISOString(), actor, user_id: userId, action, entity, entity_id: entityId, detail: detail ?? null, hash: hash ?? null }));
  await r.ltrim("audit", -50000, -1);
}
