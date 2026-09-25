import { NextRequest, NextResponse } from "next/server";
import { SEBI_BANNER } from "./universe";
import { redisConfigured } from "./redis";
import { getDevice, type DeviceAuth } from "./identity";

export function j(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json({ ...body, sebi_banner: SEBI_BANNER }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function noDb() {
  return j({ error: "db_not_configured", storage: "none", note: "Server paper trading needs UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN. Browser (localStorage) mode stays active." }, 503);
}

/** Resolve the device cookie or return an error response. */
export async function requireDevice(req: NextRequest): Promise<DeviceAuth | NextResponse> {
  if (!redisConfigured()) return noDb();
  const dev = await getDevice(req);
  if (!dev) return j({ error: "no_device", hint: "POST /api/identity/device first" }, 401);
  return dev;
}

export async function readJson<T = Record<string, unknown>>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
