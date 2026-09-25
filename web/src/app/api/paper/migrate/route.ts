import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { j, readJson, requireDevice } from "@/lib/apiHelpers";
import { rateLimit } from "@/lib/identity";
import { addCalendarDays, buildForecastBundle } from "@/lib/forecast";
import { istDate, tradingDayOnOrBefore } from "@/lib/marketCalendar";
import { bundleHash, forecastInputHash, freezePosition, type ServerForecast, type ServerPosition } from "@/lib/paperServer";
import { normalizeNseSymbol } from "@/lib/yahoo";
import type { PaperForecastPosition } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const METHOD = "atr_piecewise_T1_T2_v1";

/**
 * POST /api/paper/migrate {items: PaperForecastPosition[] (≤50)}
 * One-time import of localStorage trades. Idempotency key mig:<local id>.
 * Stored as provenance client_migrated / client_created → badge
 * "Pre-sync · unverified", EXCLUDED from headline accuracy. Client-side
 * actuals are ignored; the server re-scores from its own final marks.
 */
export async function POST(req: NextRequest) {
  const dev = await requireDevice(req);
  if (!("userId" in dev)) return dev;
  if (!(await rateLimit(`migrate:${dev.userId}`, 20, 86400))) return j({ error: "rate_limited" }, 429);
  const body = await readJson<{ items?: PaperForecastPosition[] }>(req);
  const items = Array.isArray(body?.items) ? body!.items : null;
  if (!items) return j({ error: "items[] required" }, 400);
  if (items.length > 50) return j({ error: "max 50 items per batch" }, 400);
  const results: { local_id: string; status: "created" | "exists" | "rejected"; id?: string; reason?: string }[] = [];
  for (const it of items) {
    const localId = String(it?.id || "").slice(0, 64);
    try {
      const entry = Number(it.entry);
      const boughtAt = new Date(String(it.boughtAt || ""));
      if (!localId || !it.ticker || !(entry > 0) || Number.isNaN(boughtAt.getTime())) throw new Error("missing id/ticker/entry/boughtAt");
      if (boughtAt.getTime() > Date.now() + 5 * 60_000) throw new Error("boughtAt in the future");
      const { ticker, yahoo } = normalizeNseSymbol(String(it.ticker));
      const clientFillDate = istDate(boughtAt);
      const fill_session_date = tradingDayOnOrBefore(clientFillDate);
      const now = new Date().toISOString();
      const id = `pp_${randomUUID()}`;
      const sl = it.sl != null && Number.isFinite(Number(it.sl)) ? Number(it.sl) : null;
      const targets = (Array.isArray(it.targets) ? it.targets : []).map(Number).filter((n) => Number.isFinite(n));
      const pos: ServerPosition = {
        id,
        user_id: dev.userId,
        idempotency_key: `mig:${localId}`,
        ticker,
        yahoo_symbol: yahoo,
        side: "long",
        qty: Math.max(1, Math.floor(Number(it.qty) || 1)),
        entry_price: entry,
        sl,
        targets,
        atr_14: it.atr_14 != null && Number(it.atr_14) > 0 ? Number(it.atr_14) : null,
        budget_inr: Number(it.budget_inr) || entry,
        sector: it.sector ?? null,
        filled_at: now,
        fill_session_date,
        fill_basis: "client_migrated",
        client_filled_at: boughtAt.toISOString(),
        client_entry: entry,
        verdict_snapshot: null,
        provenance: "client_migrated",
        created_at: now,
      };
      let fc: ServerForecast | null = null;
      const cf = it.forecast;
      if (cf && cf.status !== "skipped" && Array.isArray(cf.points) && cf.points.length) {
        // Targets re-derived on the calendar from the client fill date (same rule as server buys)
        const points = cf.points
          .map((p) => ({ dayOffset: Math.round(Number(p.dayOffset)), predictedClose: Number(p.predictedClose) }))
          .filter((p) => p.dayOffset >= 1 && p.dayOffset <= 90 && p.predictedClose > 0)
          .map((p) => ({ ...p, targetDate: addCalendarDays(clientFillDate, p.dayOffset) }));
        const recomputed = buildForecastBundle({ action: "buy", entry, sl, targets, atr_14: cf.params?.atr_14, checkDays: points.map((p) => p.dayOffset), filledAt: boughtAt, structure: cf.params?.structure, breakout_state: cf.params?.breakout_state });
        const client_consistent = !!recomputed && recomputed.status !== "skipped" && recomputed.points.length === points.length && recomputed.points.every((p, i) => Math.abs(p.predictedClose - points[i].predictedClose) <= 0.01);
        const base = { method_version: METHOD, params: cf.params, checkDays: points.map((p) => p.dayOffset), points };
        fc = { position_id: id, user_id: dev.userId, yahoo_symbol: yahoo, ...base, status: "ok", skip_reason: null, input_hash: forecastInputHash({ migrated_from: localId, params: cf.params, points }), bundle_hash: bundleHash(base), provenance: "client_created", client_consistent, created_at: now };
      }
      const out = await freezePosition(pos, fc);
      results.push({ local_id: localId, status: out.created ? "created" : "exists", id: out.id });
    } catch (e) {
      results.push({ local_id: localId, status: "rejected", reason: e instanceof Error ? e.message.slice(0, 120) : "invalid" });
    }
  }
  return j({ ok: true, results, note: "Migrated trades are labelled 'Pre-sync · unverified' and excluded from headline accuracy." });
}
