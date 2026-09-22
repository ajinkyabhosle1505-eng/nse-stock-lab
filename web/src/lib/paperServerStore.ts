import type { PaperForecastPosition } from "./types";

const g = globalThis as typeof globalThis & {
  __nsePaperForecasts?: PaperForecastPosition[];
};

export function serverList(): PaperForecastPosition[] {
  if (!g.__nsePaperForecasts) g.__nsePaperForecasts = [];
  return g.__nsePaperForecasts;
}

export function serverUpsert(pos: PaperForecastPosition): void {
  const list = serverList();
  const i = list.findIndex((p) => p.id === pos.id);
  if (i >= 0) list[i] = pos;
  else list.unshift(pos);
}

export function serverReplaceAll(list: PaperForecastPosition[]): void {
  g.__nsePaperForecasts = list;
}
