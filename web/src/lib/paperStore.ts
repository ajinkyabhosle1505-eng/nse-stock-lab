/** Client localStorage helpers for paper forecast positions. */

import type { PaperForecastPosition } from "./types";
import { PAPER_FORECASTS_KEY } from "./forecast";
import { SEBI_BANNER } from "./universe";

export function readPaperForecasts(): PaperForecastPosition[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PAPER_FORECASTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PaperForecastPosition[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writePaperForecasts(list: PaperForecastPosition[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PAPER_FORECASTS_KEY, JSON.stringify(list));
}

export function upsertPaperForecast(pos: PaperForecastPosition): void {
  const list = readPaperForecasts();
  const i = list.findIndex((p) => p.id === pos.id);
  if (i >= 0) list[i] = pos;
  else list.unshift(pos);
  writePaperForecasts(list);
}

export function removePaperForecast(id: string): void {
  writePaperForecasts(readPaperForecasts().filter((p) => p.id !== id));
}

export { PAPER_FORECASTS_KEY, SEBI_BANNER };
