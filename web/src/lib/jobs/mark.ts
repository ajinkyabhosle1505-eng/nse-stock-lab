/**
 * Mark + score jobs (brief §3.5, Redis edition).
 *  - runProvisionalMarks (eod-mark cron, 16:30–17:29 IST): today's settled bar
 *    → mark:<sym>:<today> state=provisional. Display only; NEVER scores.
 *  - finalizeMarksAndScore (premarket cron / lazy ?mark=1): bars for sessions
 *    ≤ lastFinalSession (fetched on a later IST day) → final marks; due points
 *    scored from FINAL closes only; touch events from final bars after the fill.
 * Split guard: any >15% close-to-close gap or adjclose/close ratio jump between
 * fill and scoring session → status split_flag (excluded from stats).
 */
import { mustRedis, parseJson } from "../redis";
import { addCalendarDays, markForecastPoints, type MarkBar } from "../forecast";
import { istDate, isTradingDay, lastFinalSession, shiftDate } from "../marketCalendar";
import { fetchYahooChartX, type DailyBarX } from "../yahoo";
import { mapPool } from "../live";
import {
  appendTouch,
  putActualOnce,
  writeMark,
  type ServerActual,
  type ServerForecast,
  type ServerPosition,
} from "../paperServer";
import type { ForecastBundle } from "../types";
import { emptyScoreSummary } from "../forecast";

function rangeFor(fromIso: string, today: string): "1mo" | "3mo" | "6mo" | "1y" {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
  if (days <= 25) return "1mo";
  if (days <= 80) return "3mo";
  if (days <= 170) return "6mo";
  return "1y";
}

function flagSessions(bars: DailyBarX[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1], b = bars[i];
    if (a.close > 0 && Math.abs(b.close - a.close) / a.close > 0.15) out.add(b.date);
    if (a.adjclose && b.adjclose && a.close > 0 && b.close > 0) {
      const ra = a.adjclose / a.close, rb = b.adjclose / b.close;
      if (ra > 0 && Math.abs(rb - ra) / ra > 0.02) out.add(b.date);
    }
  }
  return out;
}

async function loadPositions(ids: string[]) {
  if (!ids.length) return [];
  const r = mustRedis();
  const raw = (await r.mget<(string | null)[]>(...ids.flatMap((id) => [`pos:${id}`, `fc:${id}`]))) as (string | null)[];
  return ids
    .map((id, i) => ({ id, pos: parseJson<ServerPosition>(raw[2 * i]), fc: parseJson<ServerForecast>(raw[2 * i + 1]) }))
    .filter((x): x is { id: string; pos: ServerPosition; fc: ServerForecast | null } => !!x.pos);
}

export async function runProvisionalMarks(now: Date = new Date()) {
  const r = mustRedis();
  const today = istDate(now);
  if (!isTradingDay(today)) return { skipped: "holiday" };
  const open = ((await r.smembers("pos:open")) as unknown[]).map(String);
  const dueToday = ((await r.zrange("due", 0, Number(today.replace(/-/g, "")), { byScore: true })) as unknown[]).map(String);
  const ids = [...new Set([...open, ...dueToday.map((m) => m.split(":")[0])])];
  const rows = await loadPositions(ids);
  const syms = [...new Set(rows.map((x) => x.pos.yahoo_symbol))];
  let written = 0;
  const errors: string[] = [];
  let notSettled = 0;
  await mapPool(syms, 3, async (sym) => {
    const res = await fetchYahooChartX(sym, "5d", { minBars: 1 });
    if (!res.ok) return void errors.push(`${sym}:${res.error}`);
    const bar = res.bars.find((b) => b.date === today);
    if (!bar) return void notSettled++; // dropped until regular.end + 30m
    const out = await writeMark({ symbol: sym, session_date: today, open: bar.open, high: bar.high, low: bar.low, close: bar.close, adjclose: bar.adjclose, volume: bar.volume, state: "provisional", flags: [], fetched_at: res.fetched_at, finalized_at: null });
    if (out !== "kept_final") written++;
  });
  return { session_date: today, symbols: syms.length, provisional_written: written, not_settled_yet: notSettled, yahoo_errors: errors };
}

/**
 * Final marks for sessions ≤ lastFinalSession(now) and scoring of due points.
 * onlyIds: restrict to these positions (lazy per-user finalize).
 */
export async function finalizeMarksAndScore(now: Date = new Date(), onlyIds?: string[]) {
  const r = mustRedis();
  const today = istDate(now);
  const S = lastFinalSession(now);
  const Snum = Number(S.replace(/-/g, ""));
  const dueMembers = ((await r.zrange("due", 0, Snum, { byScore: true })) as unknown[]).map(String);
  const open = ((await r.smembers("pos:open")) as unknown[]).map(String);
  let ids = [...new Set([...dueMembers.map((m) => m.split(":")[0]), ...open])];
  if (onlyIds) {
    const allow = new Set(onlyIds);
    ids = ids.filter((id) => allow.has(id));
  }
  const rows = await loadPositions(ids);
  const bySym = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySym.get(row.pos.yahoo_symbol) || [];
    list.push(row);
    bySym.set(row.pos.yahoo_symbol, list);
  }
  const dueSet = new Set(dueMembers);
  let finalMarks = 0, revised = 0, scored = 0, sparse = 0, split = 0, touches = 0;
  const errors: string[] = [];

  await mapPool([...bySym.keys()], 3, async (sym) => {
    const list = bySym.get(sym)!;
    const earliest = list.map((x) => x.pos.fill_session_date).sort()[0];
    const res = await fetchYahooChartX(sym, rangeFor(shiftDate(earliest, -7), today), { minBars: 1 });
    if (!res.ok) return void errors.push(`${sym}:${res.error}`);
    const bars = res.bars.filter((b) => b.date <= S);
    const flags = flagSessions(bars);

    // Final marks for sessions this symbol's positions care about (≥ earliest fill)
    for (const b of bars) {
      if (b.date < earliest) continue;
      const out = await writeMark({ symbol: sym, session_date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, adjclose: b.adjclose, volume: b.volume, state: "final", flags: flags.has(b.date) ? ["split_suspect"] : [], fetched_at: res.fetched_at, finalized_at: new Date().toISOString() });
      if (out === "written") finalMarks++;
      if (out === "revised") { finalMarks++; revised++; }
    }

    const markBars: MarkBar[] = bars.map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
    for (const { id, pos, fc } of list) {
      // Touch events (open positions only; never auto-close)
      const closed = await r.exists(`ev:${id}:close`);
      if (!closed && pos.sl != null) {
        const after = bars.filter((b) => b.date > pos.fill_session_date);
        const t1 = pos.targets[0], t2 = pos.targets[1] ?? pos.targets[0];
        const firstSl = after.find((b) => b.low <= pos.sl!);
        const firstT1 = t1 != null ? after.find((b) => b.high >= t1) : undefined;
        const firstT2 = t2 != null ? after.find((b) => b.high >= t2) : undefined;
        const at = new Date().toISOString();
        if (firstSl && (await appendTouch(id, { type: "touch_sl", session_date: firstSl.date, price: pos.sl, at }))) touches++;
        if (firstT1 && (await appendTouch(id, { type: "touch_t1", session_date: firstT1.date, price: t1, at }))) touches++;
        if (firstT2 && (await appendTouch(id, { type: "touch_t2", session_date: firstT2.date, price: t2, at }))) touches++;
      }
      if (!fc || fc.status !== "ok") continue;
      const duePts = fc.points.filter((p) => dueSet.has(`${id}:${p.dayOffset}`));
      if (!duePts.length) continue;
      const bundle: ForecastBundle = {
        method: "atr_piecewise_T1_T2_v1",
        status: "ok",
        createdAt: fc.created_at,
        params: fc.params,
        checkDays: fc.checkDays,
        points: fc.points.map((p) => ({ ...p, actualClose: null, actualSessionDate: null, ape_pct: null, within_1atr: null, within_2pct: null, within_0_5r: null, direction_ok: null, status: "pending", tradingDayIndex: null })),
        scoreSummary: emptyScoreSummary(),
      };
      // Fill date for the scorer = fill_session_date (targets = fill + dayOffset)
      const marked = markForecastPoints(bundle, markBars, today, { finalThrough: S });
      for (const p of marked.points) {
        if (!dueSet.has(`${id}:${p.dayOffset}`)) continue;
        if (p.status === "pending") continue;
        let status: ServerActual["status"] = p.status === "sparse" ? "sparse" : "scored";
        if (status === "scored") {
          const splitHit = p.corporate_action_suspect || [...flags].some((d) => d > pos.fill_session_date && d <= (p.actualSessionDate || ""));
          if (splitHit) status = "split_flag";
        }
        const actual: ServerActual = {
          status,
          actual_session_date: p.actualSessionDate,
          actual_close: p.actualClose,
          ape_pct: p.ape_pct,
          within_1atr: p.within_1atr,
          within_2pct: p.within_2pct,
          within_0_5r: p.within_0_5r,
          direction_ok: p.direction_ok,
          trading_day_index: p.tradingDayIndex ?? null,
          mark_state: "final",
          scored_at: new Date().toISOString(),
        };
        if (await putActualOnce(id, p.dayOffset, actual)) {
          if (status === "scored") scored++;
          else if (status === "sparse") sparse++;
          else split++;
        }
      }
    }
  });

  if (!onlyIds) await r.set("score:global:updated_at", new Date().toISOString());
  return { final_through: S, symbols: bySym.size, final_marks: finalMarks, revised, scored, sparse, split_flag: split, touches, yahoo_errors: errors, window_rule: `scored on first final close in [target, target+3d]`, target_rule: `target = fill session date + dayOffset (calendar)`, sample_target: rows[0]?.fc?.points[0] ? addCalendarDays(rows[0].pos.fill_session_date, rows[0].fc.points[0].dayOffset) : null };
}
