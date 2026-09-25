/**
 * Server-side paper trades on Upstash Redis (brief Part 2, mapped to KV).
 *
 * Tamper-proofing: every frozen record is written ONCE with SET NX and there is
 * no code path that rewrites it.
 *   idem:<uid>:<key>        → position id (SET NX; idempotent buys/migrations)
 *   pos:<id>                → ServerPosition (SET NX, frozen)
 *   fc:<id>                 → ServerForecast (SET NX, frozen: params, points,
 *                             input_hash, bundle_hash, provenance)
 *   act:<id>:<dayOffset>    → ServerActual (SET NX — scores live apart from the
 *                             frozen forecast)
 *   ev:<id>:<type>          → append-only events (close, touch_sl/t1/t2), SET NX
 *   user:<uid>:pos (ZSET), pos:all (SET), pos:open (SET), due (ZSET pid:d →
 *   yyyymmdd of target date) are derived indexes.
 *   mark:<sym>:<date>       → MarkRow; provisional may be replaced by final once;
 *                             a final mark is never rewritten.
 *   mark:last:<sym>         → pointer to latest mark (derived).
 */
import { mustRedis, parseJson } from "./redis";
import { canonicalJSON, sha256hex } from "./hash";
import { addCalendarDays, computeScoreSummary, emptyScoreSummary } from "./forecast";
import type { ForecastBundle, ForecastPoint, PaperForecastPosition } from "./types";
import { SEBI_BANNER } from "./universe";

export type Provenance = "server_frozen" | "client_created";
export type FillBasis = "ltp_intraday" | "last_close" | "client_migrated";

export interface ServerPosition {
  id: string;
  user_id: string;
  idempotency_key: string;
  ticker: string;
  yahoo_symbol: string;
  side: "long";
  qty: number;
  entry_price: number;
  sl: number | null;
  targets: number[];
  atr_14: number | null;
  budget_inr: number;
  sector: string | null;
  filled_at: string;
  fill_session_date: string;
  fill_basis: FillBasis;
  client_filled_at: string | null;
  client_entry: number | null;
  verdict_snapshot: {
    action: string;
    confidence_1_10: number | null;
    reasons: string[];
    risk_flags: string[];
  } | null;
  provenance: "server" | "client_migrated";
  created_at: string;
}

export interface ServerForecast {
  position_id: string;
  user_id: string;
  yahoo_symbol: string;
  method_version: string;
  status: "ok" | "skipped";
  skip_reason: string | null;
  params: ForecastBundle["params"];
  checkDays: number[];
  points: { dayOffset: number; targetDate: string; predictedClose: number }[];
  input_hash: string;
  bundle_hash: string;
  provenance: Provenance;
  client_consistent: boolean | null;
  created_at: string;
}

export interface ServerActual {
  status: "scored" | "sparse" | "split_flag";
  actual_session_date: string | null;
  actual_close: number | null;
  ape_pct: number | null;
  within_1atr: boolean | null;
  within_2pct: boolean | null;
  within_0_5r: boolean | null;
  direction_ok: boolean | null;
  trading_day_index: number | null;
  mark_state: "final";
  scored_at: string;
}

export interface ServerEvent {
  type: "close" | "touch_sl" | "touch_t1" | "touch_t2";
  session_date: string;
  price: number | null;
  basis?: string;
  at: string;
}

export interface MarkRow {
  symbol: string;
  session_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjclose: number | null;
  volume: number;
  state: "provisional" | "final";
  flags: string[];
  fetched_at: string;
  finalized_at: string | null;
}

export const EVENT_TYPES = ["close", "touch_sl", "touch_t1", "touch_t2"] as const;
const yyyymmdd = (d: string) => Number(d.replace(/-/g, ""));

export function forecastInputHash(input: Record<string, unknown>): string {
  return sha256hex(canonicalJSON(input));
}

export function bundleHash(f: Pick<ServerForecast, "method_version" | "params" | "points" | "checkDays">): string {
  return sha256hex(canonicalJSON({ method_version: f.method_version, params: f.params, checkDays: f.checkDays, points: f.points }));
}

export async function getIdem(userId: string, key: string): Promise<string | null> {
  const v = await mustRedis().get(`idem:${userId}:${key}`);
  return typeof v === "string" ? v : null;
}

/**
 * Freeze a new position (+ forecast) once. Returns {created:false, id} if the
 * idempotency key was already used (caller returns the existing row).
 */
export async function freezePosition(pos: ServerPosition, fc: ServerForecast | null): Promise<{ created: boolean; id: string }> {
  const r = mustRedis();
  const idemKey = `idem:${pos.user_id}:${pos.idempotency_key}`;
  const claimed = await r.set(idemKey, pos.id, { nx: true });
  if (claimed !== "OK") {
    const existing = await r.get(idemKey);
    return { created: false, id: String(existing) };
  }
  const tx = r.multi();
  tx.set(`pos:${pos.id}`, JSON.stringify(pos), { nx: true });
  if (fc) tx.set(`fc:${pos.id}`, JSON.stringify(fc), { nx: true });
  tx.zadd(`user:${pos.user_id}:pos`, { score: Date.parse(pos.created_at), member: pos.id });
  tx.sadd("pos:all", pos.id);
  tx.sadd("pos:open", pos.id);
  if (fc && fc.status === "ok") {
    for (const p of fc.points) tx.zadd("due", { score: yyyymmdd(p.targetDate), member: `${pos.id}:${p.dayOffset}` });
  }
  tx.rpush(
    "audit",
    JSON.stringify({ at: new Date().toISOString(), actor: `user:${pos.user_id}`, user_id: pos.user_id, action: pos.provenance === "server" ? "position.create" : "position.migrate", entity: "position", entity_id: pos.id, hash: fc?.bundle_hash ?? null, detail: { input_hash: fc?.input_hash ?? null } })
  );
  await tx.exec();
  return { created: true, id: pos.id };
}

export async function getPosition(id: string): Promise<ServerPosition | null> {
  return parseJson<ServerPosition>(await mustRedis().get(`pos:${id}`));
}

/** Append-only close event (SET NX). Returns the stored event (existing if already closed). */
export async function appendClose(pos: ServerPosition, ev: ServerEvent): Promise<{ created: boolean; event: ServerEvent }> {
  const r = mustRedis();
  const ok = await r.set(`ev:${pos.id}:close`, JSON.stringify(ev), { nx: true });
  if (ok !== "OK") {
    return { created: false, event: parseJson<ServerEvent>(await r.get(`ev:${pos.id}:close`))! };
  }
  await r.srem("pos:open", pos.id);
  await r.rpush("audit", JSON.stringify({ at: ev.at, actor: `user:${pos.user_id}`, user_id: pos.user_id, action: "position.close", entity: "position", entity_id: pos.id, detail: ev }));
  return { created: true, event: ev };
}

export async function appendTouch(posId: string, ev: ServerEvent): Promise<boolean> {
  return (await mustRedis().set(`ev:${posId}:${ev.type}`, JSON.stringify(ev), { nx: true })) === "OK";
}

export async function putActualOnce(posId: string, dayOffset: number, a: ServerActual): Promise<boolean> {
  const r = mustRedis();
  const ok = (await r.set(`act:${posId}:${dayOffset}`, JSON.stringify(a), { nx: true })) === "OK";
  await r.zrem("due", `${posId}:${dayOffset}`);
  return ok;
}

/** Provisional → final exactly once; a final mark is never rewritten. */
export async function writeMark(m: MarkRow): Promise<"written" | "kept_final" | "revised"> {
  const r = mustRedis();
  const key = `mark:${m.symbol}:${m.session_date}`;
  const prev = parseJson<MarkRow>(await r.get(key));
  if (prev?.state === "final") return "kept_final";
  await r.set(key, JSON.stringify(m), { ex: 400 * 86400 });
  const last = parseJson<{ session_date: string }>(await r.get(`mark:last:${m.symbol}`));
  if (!last || last.session_date <= m.session_date) {
    await r.set(`mark:last:${m.symbol}`, JSON.stringify({ session_date: m.session_date, close: m.close, state: m.state, fetched_at: m.fetched_at }));
  }
  if (prev && prev.state === "provisional" && m.state === "final" && prev.close > 0 && Math.abs(m.close - prev.close) / prev.close > 0.001) {
    await r.rpush("audit", JSON.stringify({ at: new Date().toISOString(), actor: "job:mark", user_id: null, action: "mark.revised", entity: "mark", entity_id: key, detail: { provisional: prev.close, final: m.close } }));
    return "revised";
  }
  return "written";
}

export interface PositionView extends PaperForecastPosition {
  server: {
    provenance: ServerPosition["provenance"];
    forecast_provenance: Provenance | null;
    verified: boolean;
    badge: string | null;
    fill_basis: FillBasis;
    fill_session_date: string;
    filled_at: string;
    input_hash: string | null;
    bundle_hash: string | null;
    client_consistent: boolean | null;
    verdict_snapshot: ServerPosition["verdict_snapshot"];
    events: ServerEvent[];
    closed: ServerEvent | null;
    last_mark: { session_date: string; close: number; state: string } | null;
    pnl: { value: number; basis: "close_event" | "provisional_mark" | "final_mark"; as_of: string } | null;
  };
}

/** Load a batch of positions with forecast, actuals, events, last mark. */
export async function loadViews(ids: string[]): Promise<PositionView[]> {
  if (!ids.length) return [];
  const r = mustRedis();
  const raw = (await r.mget<(string | null)[]>(...ids.flatMap((id) => [`pos:${id}`, `fc:${id}`]))) as (string | null)[];
  const pairs = ids.map((id, i) => ({ id, pos: parseJson<ServerPosition>(raw[2 * i]), fc: parseJson<ServerForecast>(raw[2 * i + 1]) }));
  const keys: string[] = [];
  for (const p of pairs) {
    for (const t of EVENT_TYPES) keys.push(`ev:${p.id}:${t}`);
    for (const pt of p.fc?.points || []) keys.push(`act:${p.id}:${pt.dayOffset}`);
  }
  const syms = [...new Set(pairs.map((p) => p.pos?.yahoo_symbol).filter(Boolean) as string[])];
  const vals = keys.length ? ((await r.mget<(string | null)[]>(...keys)) as (string | null)[]) : [];
  const marks = syms.length ? ((await r.mget<(string | null)[]>(...syms.map((s) => `mark:last:${s}`))) as (string | null)[]) : [];
  const kv = new Map(keys.map((k, i) => [k, vals[i]]));
  const lastMark = new Map(syms.map((s, i) => [s, parseJson<{ session_date: string; close: number; state: string }>(marks[i])]));
  const out: PositionView[] = [];
  for (const { id, pos, fc } of pairs) {
    if (!pos) continue;
    const events = EVENT_TYPES.map((t) => parseJson<ServerEvent>(kv.get(`ev:${id}:${t}`))).filter(Boolean) as ServerEvent[];
    const closed = events.find((e) => e.type === "close") || null;
    const points: ForecastPoint[] = (fc?.points || []).map((pt) => {
      const a = parseJson<ServerActual>(kv.get(`act:${id}:${pt.dayOffset}`));
      return {
        dayOffset: pt.dayOffset,
        predictedClose: pt.predictedClose,
        targetDate: pt.targetDate,
        actualClose: a?.actual_close ?? null,
        actualSessionDate: a?.actual_session_date ?? null,
        ape_pct: a?.ape_pct ?? null,
        within_1atr: a?.within_1atr ?? null,
        within_2pct: a?.within_2pct ?? null,
        within_0_5r: a?.within_0_5r ?? null,
        direction_ok: a?.direction_ok ?? null,
        status: a ? (a.status === "sparse" ? "sparse" : "scored") : "pending",
        tradingDayIndex: a?.trading_day_index ?? null,
        corporate_action_suspect: a?.status === "split_flag" || undefined,
      };
    });
    const touch = (t: string) => (events.some((e) => e.type === t) ? true : null);
    const forecast: ForecastBundle | null = fc
      ? {
          method: "atr_piecewise_T1_T2_v1",
          status: fc.status,
          skip_reason: fc.skip_reason || undefined,
          createdAt: fc.created_at,
          params: fc.params,
          checkDays: fc.checkDays,
          points,
          scoreSummary: fc.status === "ok" ? computeScoreSummary(points, { touched_t1: touch("touch_t1"), touched_t2: touch("touch_t2"), touched_sl: touch("touch_sl") }) : emptyScoreSummary(),
        }
      : null;
    const lm = lastMark.get(pos.yahoo_symbol) || null;
    const pnl = closed?.price != null
      ? { value: round2((closed.price - pos.entry_price) * pos.qty), basis: "close_event" as const, as_of: closed.session_date }
      : lm && lm.session_date >= pos.fill_session_date
        ? { value: round2((lm.close - pos.entry_price) * pos.qty), basis: lm.state === "final" ? ("final_mark" as const) : ("provisional_mark" as const), as_of: lm.session_date }
        : null;
    const verified = pos.provenance === "server" && fc?.provenance !== "client_created";
    out.push({
      id,
      ticker: pos.ticker,
      yahoo_symbol: pos.yahoo_symbol,
      entry: pos.entry_price,
      sl: pos.sl,
      targets: pos.targets,
      qty: pos.qty,
      budget_inr: pos.budget_inr,
      size_inr: round2(pos.entry_price * pos.qty),
      boughtAt: pos.client_filled_at || pos.filled_at,
      sector: pos.sector,
      checkDays: fc?.checkDays || [],
      atr_14: pos.atr_14,
      structure: fc?.params.structure,
      breakout_state: fc?.params.breakout_state,
      sebi_banner: SEBI_BANNER,
      forecast,
      server: {
        provenance: pos.provenance,
        forecast_provenance: fc?.provenance ?? null,
        verified,
        badge: verified ? null : "Pre-sync · unverified",
        fill_basis: pos.fill_basis,
        fill_session_date: pos.fill_session_date,
        filled_at: pos.filled_at,
        input_hash: fc?.input_hash ?? null,
        bundle_hash: fc?.bundle_hash ?? null,
        client_consistent: fc?.client_consistent ?? null,
        verdict_snapshot: pos.verdict_snapshot,
        events,
        closed,
        last_mark: lm,
        pnl,
      },
    });
  }
  return out;
}

export async function userPositionIds(userId: string, limit = 200): Promise<string[]> {
  const res = await mustRedis().zrange(`user:${userId}:pos`, 0, limit - 1, { rev: true });
  return (res as unknown[]).map(String);
}

/** Headline stats: verified (server_frozen) only; unverified reported separately. */
export function scoreViews(views: PositionView[]) {
  const pts = (verified: boolean) =>
    views.filter((v) => v.server.verified === verified && v.forecast?.status === "ok").flatMap((v) => v.forecast!.points);
  const summarize = (points: ForecastPoint[]) => {
    const s = computeScoreSummary(points);
    return {
      ...s,
      n_pending: points.filter((p) => p.status === "pending").length,
      n_sparse: points.filter((p) => p.status === "sparse").length,
      n_split_excluded: points.filter((p) => p.corporate_action_suspect).length,
      lastMarkedAt: undefined,
    };
  };
  return {
    verified: summarize(pts(true)),
    unverified_pre_sync: summarize(pts(false)),
    note: "Headline stats use server-frozen forecasts scored on FINAL closes only. Pre-sync (migrated) trades and >15% jumps (possible splits) are excluded. Small samples are noisy; this measures a research method, not a promise.",
  };
}

export function targetDatesFor(fillSessionDate: string, checkDays: number[]) {
  return checkDays.map((d) => ({ dayOffset: d, targetDate: addCalendarDays(fillSessionDate, d) }));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
