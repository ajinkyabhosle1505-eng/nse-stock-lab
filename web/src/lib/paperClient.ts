"use client";
/**
 * Browser helpers for server paper mode (Upstash configured) with a
 * localStorage fallback when the deployment has no database.
 */
import { readPaperForecasts } from "./paperStore";

export const MIGRATED_KEY = "nse-stock-lab-migrated-v1";
export const PENDING_RECOVERY_KEY = "nse-stock-lab-pending-recovery-v1";

export interface MeResponse {
  storage: "redis" | "none";
  server_paper: boolean;
  device?: { user_id: string; device_id: string; recovery_code_issued: boolean } | null;
  recovery_available: boolean;
}

export async function getMe(): Promise<MeResponse> {
  try {
    const r = await fetch("/api/identity/me", { cache: "no-store" });
    if (!r.ok) return { storage: "none", server_paper: false, recovery_available: false };
    return (await r.json()) as MeResponse;
  } catch {
    return { storage: "none", server_paper: false, recovery_available: false };
  }
}

/** Get-or-create the device cookie. A brand-new recovery code is parked locally until the user confirms they saved it. */
export async function ensureDevice(): Promise<{ ok: boolean; created?: boolean; recovery_code?: string | null }> {
  const r = await fetch("/api/identity/device", { method: "POST", cache: "no-store" });
  if (!r.ok) return { ok: false };
  const j = (await r.json()) as { created?: boolean; recovery_code?: string | null };
  if (j.created && j.recovery_code) {
    try {
      localStorage.setItem(PENDING_RECOVERY_KEY, j.recovery_code);
    } catch {
      /* ignore */
    }
  }
  return { ok: true, created: j.created, recovery_code: j.recovery_code ?? null };
}

export function readMigrated(): Set<string> {
  try {
    const raw = localStorage.getItem(MIGRATED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeMigrated(s: Set<string>) {
  try {
    localStorage.setItem(MIGRATED_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

/** One-time upload of localStorage trades (batches of 50, idempotency key mig:<id>). */
export async function migrateLocal(): Promise<{ sent: number; created: number; existing: number; rejected: number }> {
  const done = readMigrated();
  const todo = readPaperForecasts().filter((p) => p?.id && !done.has(p.id));
  const out = { sent: 0, created: 0, existing: 0, rejected: 0 };
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const r = await fetch("/api/paper/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: batch }),
      cache: "no-store",
    });
    if (!r.ok) break;
    const j = (await r.json()) as { results?: { local_id: string; status: string }[] };
    for (const res of j.results || []) {
      out.sent++;
      if (res.status === "created") out.created++;
      else if (res.status === "exists") out.existing++;
      else out.rejected++;
      if (res.status !== "rejected") done.add(res.local_id);
    }
    writeMigrated(done);
  }
  return out;
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2, 12)}`;
}
