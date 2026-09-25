import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/** Canonical JSON: sorted object keys, no whitespace. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`)
    .join(",")}}`;
}

export function sha256hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hmacHex(key: string, s: string): string {
  return createHmac("sha256", key).update(s).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
