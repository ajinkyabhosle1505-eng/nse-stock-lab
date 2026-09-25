/**
 * Upstash Redis client (v1 store for reports + server paper trades).
 * Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *      (KV_REST_API_URL / KV_REST_API_TOKEN also accepted — the Vercel
 *       Marketplace Upstash integration injects those names).
 * Not configured → callers use their no-DB fallback. Never log the token.
 */
import { Redis } from "@upstash/redis";

let client: Redis | null | undefined;

function cfg(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export function redisConfigured(): boolean {
  return cfg() != null;
}

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const c = cfg();
  // automaticDeserialization off: we store canonical JSON strings ourselves.
  client = c ? new Redis({ url: c.url, token: c.token, automaticDeserialization: false }) : null;
  return client;
}

export function mustRedis(): Redis {
  const r = getRedis();
  if (!r) throw new Error("redis_not_configured");
  return r;
}

export function parseJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
