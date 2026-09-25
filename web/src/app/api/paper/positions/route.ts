import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { j, readJson, requireDevice } from "@/lib/apiHelpers";
import { rateLimit } from "@/lib/identity";
import { runLookup } from "@/lib/live";
import { buildForecastBundle } from "@/lib/forecast";
import { istDate, isTradingDay, prevTradingDay, sessionPhase, tradingDayOnOrBefore } from "@/lib/marketCalendar";
import {
  bundleHash,
  forecastInputHash,
  freezePosition,
  getIdem,
  loadViews,
  type ServerForecast,
  type ServerPosition,
} from "@/lib/paperServer";
import { sectorOf } from "@/lib/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const METHOD = "atr_piecewise_T1_T2_v1";

/**
 * POST /api/paper/positions — server-frozen paper buy.
 * Body {idempotency_key, ticker, qty?, budget_inr?, client_entry?, checkDays?}
 * The SERVER sets entry from a fresh Yahoo quote (client price is only a check):
 * 409 quote_moved if |client_entry − server| / server > max(1%, ½·ATR%).
 * 201 new · 200 idempotent repeat (existing row).
 */
export async function POST(req: NextRequest) {
  const dev = await requireDevice(req);
  if (!("userId" in dev)) return dev;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return j({ error: "invalid_json" }, 400);
  const idem = String(body.idempotency_key || "").trim();
  if (!/^[A-Za-z0-9:_\-.]{8,80}$/.test(idem) || idem.startsWith("mig:")) return j({ error: "idempotency_key required (8–80 chars; mig: prefix reserved)" }, 400);
  const tickerRaw = String(body.ticker || "").trim();
  if (!tickerRaw) return j({ error: "ticker required" }, 400);

  const existingId = await getIdem(dev.userId, idem);
  if (existingId) {
    const [view] = await loadViews([existingId]);
    return j({ ok: true, idempotent_repeat: true, position: view || null }, 200);
  }
  if (!(await rateLimit(`buy:m:${dev.userId}`, 10, 60)) || !(await rateLimit(`buy:d:${dev.userId}`, 30, 86400))) {
    return j({ error: "rate_limited", limits: "10/min, 30/day" }, 429);
  }

  const budget = Number(body.budget_inr) > 0 ? Number(body.budget_inr) : 10000;
  const look = await runLookup(tickerRaw, { budget_inr: budget, risk_pct: 1, funda: true, news: true });
  const f = look.tech.fields;
  const cmp = typeof f.cmp === "number" && f.cmp > 0 ? f.cmp : null;
  if (cmp == null) return j({ error: "quote_unavailable", ticker: look.ticker, note: "No fresh Yahoo quote — nothing was filled (never invented)." }, 502);
  const atr = typeof f.atr_14 === "number" && f.atr_14 > 0 ? f.atr_14 : null;

  const clientEntry = body.client_entry != null ? Number(body.client_entry) : null;
  const atrPct = atr ? (100 * atr) / cmp : 0;
  const tolPct = Math.max(1, 0.5 * atrPct);
  if (clientEntry != null && Number.isFinite(clientEntry) && clientEntry > 0) {
    const movedPct = (Math.abs(clientEntry - cmp) / cmp) * 100;
    if (movedPct > tolPct) {
      return j({ error: "quote_moved", server_price: cmp, client_entry: clientEntry, moved_pct: Math.round(movedPct * 100) / 100, tolerance_pct: Math.round(tolPct * 100) / 100, note: "Price moved since you loaded the page. Re-confirm at the server price." }, 409);
    }
  }

  const now = new Date();
  const phase = sessionPhase(now);
  const today = istDate(now);
  const fill_basis = phase === "open" ? "ltp_intraday" : "last_close";
  const fill_session_date = phase === "open" || phase === "post_close" ? today : isTradingDay(today) ? prevTradingDay(today) : tradingDayOnOrBefore(today);

  const v = look.verdict;
  let qty = Math.floor(Number(body.qty) || 0);
  if (!(qty >= 1)) qty = v.shares && v.shares > 0 ? v.shares : Math.max(1, Math.floor(budget / cmp));
  qty = Math.min(qty, 100000);

  const checkDays = [...new Set((Array.isArray(body.checkDays) ? body.checkDays : [7, 14, 30]).map((d) => Math.round(Number(d))).filter((d) => d >= 1 && d <= 90))].sort((a, b) => a - b).slice(0, 10);
  const structure = String(f.structure || "");
  const breakout_state = String(f.breakout_state || "");
  const bundle = buildForecastBundle({
    action: v.action,
    entry: cmp,
    sl: v.sl,
    targets: v.targets,
    atr_14: atr,
    checkDays,
    filledAt: `${fill_session_date}T12:00:00+05:30`,
    structure,
    breakout_state,
  });

  const id = `pp_${randomUUID()}`;
  const created_at = now.toISOString();
  const pos: ServerPosition = {
    id,
    user_id: dev.userId,
    idempotency_key: idem,
    ticker: look.ticker,
    yahoo_symbol: look.yahoo_symbol,
    side: "long",
    qty,
    entry_price: cmp,
    sl: v.sl,
    targets: v.targets || [],
    atr_14: atr,
    budget_inr: budget,
    sector: v.sector ?? sectorOf(look.ticker) ?? null,
    filled_at: created_at,
    fill_session_date,
    fill_basis,
    client_filled_at: null,
    client_entry: clientEntry,
    verdict_snapshot: { action: v.action, confidence_1_10: v.confidence_1_10 ?? null, reasons: (v.reasons || []).slice(0, 3), risk_flags: v.risk_flags || [] },
    provenance: "server",
    created_at,
  };
  let fc: ServerForecast | null = null;
  if (bundle) {
    const points = bundle.points.map((p) => ({ dayOffset: p.dayOffset, targetDate: p.targetDate, predictedClose: p.predictedClose }));
    const input_hash = forecastInputHash({ ticker: pos.ticker, yahoo: pos.yahoo_symbol, entry: cmp, sl: v.sl, targets: v.targets, atr_14: atr, checkDays, structure, breakout_state, fill_session_date, fill_basis, method: METHOD, quote_source: look.tech.sources });
    const base = { method_version: METHOD, params: bundle.params, checkDays: bundle.checkDays, points };
    fc = {
      position_id: id,
      user_id: dev.userId,
      yahoo_symbol: pos.yahoo_symbol,
      ...base,
      status: bundle.status === "skipped" ? "skipped" : "ok",
      skip_reason: bundle.skip_reason || null,
      input_hash,
      bundle_hash: bundleHash(base),
      provenance: "server_frozen",
      client_consistent: null,
      created_at,
    };
  }
  const out = await freezePosition(pos, fc);
  const [view] = await loadViews([out.id]);
  return j({ ok: true, created: out.created, position: view, price_basis: fill_basis === "ltp_intraday" ? "Filled at the live (delayed) Yahoo price during the session." : `Filled at the last settled close (${fill_session_date}).` }, out.created ? 201 : 200);
}
