/** P2.1 — budget-aware screener over SCREEN_UNIVERSE. Never invent prices. */

import { fetchYahooHistory, normalizeNseSymbol } from "./yahoo";
import { computeTech, numOrNull, unknownTech } from "./tech";
import { fetchLiveFunda } from "./funda";
import { SCREEN_UNIVERSE, screenSectorOf } from "./screenUniverse";
import { SEBI_BANNER } from "./universe";

export interface ScreenFilters {
  budget_inr: number;
  sectors?: string[];
  pe_max?: number;
  roe_min?: number;
  min_volume_vs_avg?: number;
  risk_pct?: number;
}

export interface ScreenRow {
  ticker: string;
  cmp: number | "UNKNOWN";
  sector: string;
  pe_ttm: number | "UNKNOWN";
  roe_pct: number | "UNKNOWN";
  volume_vs_avg_20d: number | "UNKNOWN";
  afford_shares: number | null;
  fits_budget: boolean;
  unknowns: string[];
  sources: string[];
}

export interface ScreenResult {
  budget_inr: number;
  risk_pct: number;
  as_of: string;
  sebi_banner: string;
  universe: string[];
  scanned: number;
  filters: {
    sectors?: string[];
    pe_max?: number;
    roe_min?: number;
    min_volume_vs_avg?: number;
  };
  results: ScreenRow[];
  fits: ScreenRow[];
  note: string;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function asNumOrUnknown(v: unknown): number | "UNKNOWN" {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return "UNKNOWN";
}

async function screenOne(
  sym: string,
  budget_inr: number
): Promise<ScreenRow> {
  const { ticker, yahoo } = normalizeNseSymbol(sym);
  const unknowns: string[] = [];
  const sources: string[] = [];

  let cmp: number | "UNKNOWN" = "UNKNOWN";
  let volume_vs_avg_20d: number | "UNKNOWN" = "UNKNOWN";

  try {
    const hist = await fetchYahooHistory(yahoo);
    if (hist) {
      const tech = computeTech(ticker, hist);
      sources.push(...(tech.sources || []));
      const c = numOrNull(tech.fields.cmp);
      cmp = c != null ? c : "UNKNOWN";
      const vol = numOrNull(tech.fields.volume_vs_avg_20d);
      volume_vs_avg_20d = vol != null ? vol : "UNKNOWN";
      if (cmp === "UNKNOWN") unknowns.push("cmp");
      if (volume_vs_avg_20d === "UNKNOWN") unknowns.push("volume_vs_avg_20d");
      if (tech.unknowns?.length) {
        for (const u of tech.unknowns) {
          if (!unknowns.includes(u)) unknowns.push(u);
        }
      }
    } else {
      const stub = unknownTech(ticker, yahoo);
      unknowns.push("cmp", "volume_vs_avg_20d");
      void stub;
    }
  } catch {
    unknowns.push("cmp", "volume_vs_avg_20d");
  }

  let pe_ttm: number | "UNKNOWN" = "UNKNOWN";
  let roe_pct: number | "UNKNOWN" = "UNKNOWN";
  let sector = screenSectorOf(ticker);

  try {
    const funda = await fetchLiveFunda(ticker, yahoo);
    sources.push(...(funda.sources || []));
    pe_ttm = asNumOrUnknown(funda.fields.pe_ttm);
    roe_pct = asNumOrUnknown(funda.fields.roe_pct);
    if (typeof funda.fields.sector === "string" && funda.fields.sector) {
      // Prefer our screen sector labels for filtering consistency
      sector = screenSectorOf(ticker);
    }
    if (pe_ttm === "UNKNOWN") unknowns.push("pe_ttm");
    if (roe_pct === "UNKNOWN") unknowns.push("roe_pct");
    for (const u of funda.unknowns || []) {
      if (!unknowns.includes(u)) unknowns.push(u);
    }
  } catch {
    if (!unknowns.includes("pe_ttm")) unknowns.push("pe_ttm");
    if (!unknowns.includes("roe_pct")) unknowns.push("roe_pct");
  }

  let afford_shares: number | null = null;
  let fits_budget = false;
  if (typeof cmp === "number" && cmp > 0) {
    afford_shares = Math.floor(budget_inr / cmp);
    fits_budget = cmp <= budget_inr && afford_shares >= 1;
  } else {
    if (!unknowns.includes("cmp")) unknowns.push("cmp");
  }

  return {
    ticker,
    cmp,
    sector,
    pe_ttm,
    roe_pct,
    volume_vs_avg_20d,
    afford_shares,
    fits_budget,
    unknowns: [...new Set(unknowns)],
    sources: [...new Set(sources)],
  };
}

export async function runScreen(filters: ScreenFilters): Promise<ScreenResult> {
  const budget_inr = filters.budget_inr;
  const risk_pct =
    filters.risk_pct != null && Number.isFinite(filters.risk_pct) && filters.risk_pct > 0
      ? filters.risk_pct
      : 1;

  const sectorSet =
    filters.sectors && filters.sectors.length
      ? new Set(filters.sectors.map((s) => s.trim()).filter(Boolean))
      : null;

  const universe = [...SCREEN_UNIVERSE];
  const rows = await mapPool(universe, 4, (sym) => screenOne(sym, budget_inr));

  const results: ScreenRow[] = [];
  for (const row of rows) {
    if (sectorSet && !sectorSet.has(row.sector)) continue;

    // Optional PE / ROE / volume filters — only apply when the field is known
    if (
      filters.pe_max != null &&
      Number.isFinite(filters.pe_max) &&
      typeof row.pe_ttm === "number" &&
      row.pe_ttm > filters.pe_max
    ) {
      continue;
    }
    if (
      filters.roe_min != null &&
      Number.isFinite(filters.roe_min) &&
      typeof row.roe_pct === "number" &&
      row.roe_pct < filters.roe_min
    ) {
      continue;
    }
    if (
      filters.min_volume_vs_avg != null &&
      Number.isFinite(filters.min_volume_vs_avg) &&
      typeof row.volume_vs_avg_20d === "number" &&
      row.volume_vs_avg_20d < filters.min_volume_vs_avg
    ) {
      continue;
    }

    // Filter cmp<=budget when known
    if (typeof row.cmp === "number") {
      if (row.cmp > budget_inr) continue;
    }

    results.push(row);
  }

  // Prefer known CMPs that fit; unknowns last
  results.sort((a, b) => {
    const ac = typeof a.cmp === "number" ? a.cmp : Number.POSITIVE_INFINITY;
    const bc = typeof b.cmp === "number" ? b.cmp : Number.POSITIVE_INFINITY;
    return ac - bc;
  });

  const fits = results.filter((r) => r.fits_budget);

  return {
    budget_inr,
    risk_pct,
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    universe,
    scanned: universe.length,
    filters: {
      sectors: filters.sectors,
      pe_max: filters.pe_max,
      roe_min: filters.roe_min,
      min_volume_vs_avg: filters.min_volume_vs_avg,
    },
    results,
    fits,
    note: "Live Yahoo CMP/volume + HTTP funda. Never invents prices. Concurrency 4.",
  };
}
