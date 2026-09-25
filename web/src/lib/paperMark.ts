/**
 * Shared paper-forecast marking (used by /api/paper/mark-forecasts, lazy mark on
 * /paper load, and the daily mark cron). Yahoo daily closes only — never invents.
 */

import { istDateString, markForecastPoints, type MarkBar } from "./forecast";
import { lastFinalSession } from "./marketCalendar";
import { fetchYahooDailyBars } from "./yahoo";
import type { ForecastBundle, PaperForecastPosition } from "./types";

export type BarCache = Map<string, MarkBar[] | null>;

export function isDue(pos: PaperForecastPosition, today: string): boolean {
  const f = pos.forecast;
  if (!f || f.status === "skipped") return false;
  return f.points.some(
    (p) => (p.status === "pending" || p.status === "error") && p.targetDate <= today
  );
}

function rangeFor(fillIso: string, today: string): "3mo" | "6mo" | "1y" {
  const a = Date.parse(`${fillIso}T00:00:00+05:30`);
  const b = Date.parse(`${today}T00:00:00+05:30`);
  const days = Math.round((b - a) / 86400000);
  if (days <= 80) return "3mo";
  if (days <= 170) return "6mo";
  return "1y";
}

export interface MarkRunResult {
  positions: PaperForecastPosition[];
  changedIds: string[];
  symbolsFetched: number;
  yahooErrors: string[];
}

/** Mark all due points; returns new position objects (inputs untouched). */
export async function markPositions(
  input: PaperForecastPosition[],
  opts: { now?: Date; cache?: BarCache } = {}
): Promise<MarkRunResult> {
  const now = opts.now || new Date();
  const today = istDateString(now);
  const finalThrough = lastFinalSession(now);
  const cache: BarCache = opts.cache || new Map();
  const yahooErrors: string[] = [];
  let symbolsFetched = 0;

  // Earliest fill per symbol → one fetch per symbol covering all its fills
  const needBySymbol = new Map<string, string>();
  for (const pos of input) {
    if (!isDue(pos, today)) continue;
    const sym = pos.yahoo_symbol || `${pos.ticker}.NS`;
    const fill = istDateString(new Date(pos.forecast!.createdAt || pos.boughtAt));
    const cur = needBySymbol.get(sym);
    if (!cur || fill < cur) needBySymbol.set(sym, fill);
  }
  const symbols = [...needBySymbol.keys()].filter((s) => !cache.has(s));
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, symbols.length) }, async () => {
      while (i < symbols.length) {
        const sym = symbols[i++];
        let bars: MarkBar[] | null = null;
        try {
          bars = await fetchYahooDailyBars(sym, rangeFor(needBySymbol.get(sym)!, today));
        } catch {
          bars = null;
        }
        symbolsFetched++;
        if (!bars?.length) yahooErrors.push(sym);
        cache.set(sym, bars?.length ? bars : null);
      }
    })
  );

  const changedIds: string[] = [];
  const positions = input.map((pos) => {
    if (!isDue(pos, today)) return pos;
    const sym = pos.yahoo_symbol || `${pos.ticker}.NS`;
    const bars = cache.get(sym);
    let forecast: ForecastBundle;
    if (!bars) {
      forecast = {
        ...pos.forecast!,
        points: pos.forecast!.points.map((p) =>
          (p.status === "pending" || p.status === "error") && p.targetDate <= today
            ? { ...p, status: "error" as const, actualClose: null, actualSessionDate: null }
            : p
        ),
      };
    } else {
      forecast = markForecastPoints(pos.forecast!, bars, today, { finalThrough });
    }
    changedIds.push(pos.id);
    return { ...pos, forecast };
  });

  return { positions, changedIds, symbolsFetched, yahooErrors };
}
