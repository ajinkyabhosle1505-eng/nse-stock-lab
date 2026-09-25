/** Live funda lane: Yahoo quoteSummary first, optional Screener scrape. Never invent numbers. */

import { fetchYahooQuoteSummary } from "./yahoo";
import type { LaneResult } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const KEY_FIELDS = ["pe_ttm", "roe_pct", "debt_equity"] as const;

export type FundaQuality = "pass" | "watch" | "fail";

export interface FundaLane extends LaneResult {
  ticker: string;
  fields: Record<string, unknown>;
  unknowns: string[];
  sources: string[];
  note: string;
  ts: string;
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function marketCapBucket(marketCapInr: number | null): string | null {
  if (marketCapInr == null || !(marketCapInr > 0)) return null;
  // INR: large >= ₹20,000 Cr, mid >= ₹5,000 Cr
  const cr = marketCapInr / 1e7;
  if (cr >= 20000) return "large";
  if (cr >= 5000) return "mid";
  return "small";
}

/** Yahoo ROE is typically a decimal (0.15); Screener is already %. */
export function normalizeRoePct(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (Math.abs(v) <= 1.5) return round(v * 100, 2);
  return round(v, 2);
}

/**
 * Yahoo debtToEquity is often TotalDebt/Equity*100 (fmt ends with %).
 * Screener uses ratio (0.12). Normalize to ratio.
 */
export function normalizeDebtEquity(
  v: number | null,
  fmt?: string | null
): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (fmt && String(fmt).includes("%")) return round(v / 100, 4);
  // Heuristic: values >> 5 are usually percent form
  if (v > 5 && v < 200) return round(v / 100, 4);
  return round(v, 4);
}

function parseNumberLoose(raw: string): number | null {
  const s = raw.replace(/,/g, "").replace(/%/g, "").trim();
  if (!s || s === "-" || s.toLowerCase() === "nan") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface ScreenerStats {
  pe: number | null;
  roe: number | null;
  debtEquity: number | null;
  source: string;
}

async function fetchScreenerStats(ticker: string): Promise<ScreenerStats | null> {
  const cons = await fetchScreenerPage(ticker, true);
  // Some companies (e.g. IRFC) have no consolidated statements → blank ratios; try standalone.
  if (cons && (cons.pe != null || cons.roe != null)) return cons;
  const standalone = await fetchScreenerPage(ticker, false);
  return standalone && (standalone.pe != null || standalone.roe != null) ? standalone : cons || standalone;
}

async function fetchScreenerPage(ticker: string, consolidated: boolean): Promise<ScreenerStats | null> {
  const url = `https://www.screener.in/company/${encodeURIComponent(
    ticker
  )}/${consolidated ? "consolidated/" : ""}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (html.length < 1000) return null;

    const pick = (label: string): number | null => {
      const re = new RegExp(
        `class="name">\\s*${label}\\s*</span>\\s*<span[^>]*>\\s*(?:₹\\s*)?(?:<span class="number">)?([^<]+)`,
        "i"
      );
      const m = html.match(re);
      return m ? parseNumberLoose(m[1]) : null;
    };

    let debt = pick("Debt to equity");
    if (debt == null) {
      const m = html.match(/Debt to equity[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
      if (m) debt = parseNumberLoose(m[1]);
    }

    return {
      pe: pick("Stock P/E"),
      roe: pick("ROE"),
      debtEquity: debt,
      source: url,
    };
  } catch {
    return null;
  }
}

export function computeFundaQuality(fields: Record<string, unknown>): {
  funda_quality: FundaQuality;
  red_flags: string[];
} {
  const pe = typeof fields.pe_ttm === "number" ? fields.pe_ttm : null;
  const roe = typeof fields.roe_pct === "number" ? fields.roe_pct : null;
  const de =
    typeof fields.debt_equity === "number" ? fields.debt_equity : null;
  const sector = String(fields.sector || "").toLowerCase();
  const isBank = sector.includes("bank") || sector.includes("financial");

  const red_flags: string[] = Array.isArray(fields.red_flags)
    ? [...(fields.red_flags as string[])]
    : [];

  const knownKeyCount = [pe, roe, de].filter((x) => x != null).length;
  const heavyUnknowns = knownKeyCount === 0;

  let distress = false;
  if (pe != null && pe < 0) {
    distress = true;
    red_flags.push("Negative trailing PE (loss-making)");
  }
  if (roe != null && roe < 0) {
    distress = true;
    red_flags.push(`Negative ROE ${roe}%`);
  }
  if (de != null && !isBank && de >= 3) {
    distress = true;
    red_flags.push(`High debt/equity ${de}`);
  }

  if (heavyUnknowns || distress) {
    if (heavyUnknowns) red_flags.push("Heavy unknowns on PE/ROE/D-E");
    return { funda_quality: "fail", red_flags: [...new Set(red_flags)] };
  }

  let watch = false;
  if (pe != null && (pe > 45 || (pe > 0 && pe < 3))) watch = true;
  if (roe != null && roe < 8) watch = true;
  if (de != null && !isBank && de > 1.5) watch = true;
  if (knownKeyCount === 1) watch = true;
  if (red_flags.length >= 2) watch = true;

  if (watch) {
    return { funda_quality: "watch", red_flags: [...new Set(red_flags)] };
  }
  return { funda_quality: "pass", red_flags: [...new Set(red_flags)] };
}

export interface FundaOpts {
  /** Try Screener HTML when Yahoo gaps remain (default true). */
  screener?: boolean;
  /** Try Yahoo quoteSummary (crumb/cookie) first (default true). Cron jobs pass false (brief §2.9). */
  yahoo?: boolean;
}

export async function fetchLiveFunda(
  ticker: string,
  yahooSymbol: string,
  opts: FundaOpts = {}
): Promise<FundaLane> {
  const useScreener = opts.screener !== false;
  const fields: Record<string, unknown> = {};
  const unknowns: string[] = [];
  const sources: string[] = [];
  const notes: string[] = [];

  const y = opts.yahoo === false ? null : await fetchYahooQuoteSummary(yahooSymbol);
  if (y) {
    sources.push(y.source);
    if (y.trailingPE != null) fields.pe_ttm = round(y.trailingPE, 2);
    if (y.returnOnEquity != null) {
      const roe = normalizeRoePct(y.returnOnEquity);
      if (roe != null) fields.roe_pct = roe;
    }
    if (y.debtToEquity != null) {
      const de = normalizeDebtEquity(y.debtToEquity, y.debtToEquityFmt);
      if (de != null) fields.debt_equity = de;
    }
    if (y.profitMargins != null) {
      fields.profit_margins = round(y.profitMargins, 4);
      const pm = y.profitMargins;
      if (pm >= 0.2) fields.margin_hint = "healthy";
      else if (pm >= 0.08) fields.margin_hint = "moderate";
      else if (pm >= 0) fields.margin_hint = "thin";
      else fields.margin_hint = "negative";
    }
    if (y.marketCap != null) {
      fields.market_cap = y.marketCap;
      const bucket = marketCapBucket(y.marketCap);
      if (bucket) fields.market_cap_bucket = bucket;
    }
    if (y.priceToBook != null) fields.pb = round(y.priceToBook, 2);
    if (y.sector) fields.sector = y.sector;
    else if (y.industry) fields.sector = y.industry;
    notes.push("Yahoo quoteSummary");
  } else {
    notes.push(opts.yahoo === false ? "Yahoo quoteSummary skipped (cron)" : "Yahoo quoteSummary unavailable");
  }

  const needScreener =
    useScreener &&
    (fields.pe_ttm == null ||
      fields.roe_pct == null ||
      fields.debt_equity == null);

  if (needScreener) {
    const scr = await fetchScreenerStats(ticker);
    if (scr) {
      sources.push(scr.source);
      if (fields.pe_ttm == null && scr.pe != null) fields.pe_ttm = scr.pe;
      if (fields.roe_pct == null && scr.roe != null) fields.roe_pct = scr.roe;
      if (fields.debt_equity == null && scr.debtEquity != null) {
        fields.debt_equity = scr.debtEquity;
      }
      notes.push("Screener HTML best-effort");
    } else {
      notes.push("Screener blocked/fail — gaps left unknown");
    }
  }

  for (const k of KEY_FIELDS) {
    if (fields[k] == null) unknowns.push(k);
  }
  for (const k of [
    "promoter_holding_pct",
    "promoter_pledge_pct",
    "interest_coverage",
  ]) {
    if (fields[k] == null) unknowns.push(k);
  }

  const { funda_quality, red_flags } = computeFundaQuality(fields);
  fields.funda_quality = funda_quality;
  if (red_flags.length) fields.red_flags = red_flags;

  return {
    ticker,
    fields,
    unknowns,
    sources,
    note: notes.join("; "),
    ts: new Date().toISOString(),
  };
}

export function unknownFunda(ticker: string, note: string): FundaLane {
  return {
    ticker,
    fields: { funda_quality: "fail", red_flags: ["No live funda"] },
    unknowns: [
      "pe_ttm",
      "roe_pct",
      "debt_equity",
      "promoter_holding_pct",
      "promoter_pledge_pct",
    ],
    sources: [],
    note,
    ts: new Date().toISOString(),
  };
}
