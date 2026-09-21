/**
 * Live lookup / budget-picks orchestrator.
 * Tech: in-process Yahoo + computeTech.
 * Funda/News: pure HTTP (Yahoo + Screener/RSS) — Vercel-safe, no Python child_process.
 * Risk: mergeVerdict(tech, { budget_inr, risk_pct, funda, news }).
 */

import { fetchYahooHistory, normalizeNseSymbol } from "./yahoo";
import { computeTech, unknownTech } from "./tech";
import { fetchLiveFunda, unknownFunda } from "./funda";
import { fetchLiveNews, unknownNews } from "./news";
import {
  mergeVerdict,
  pickScore,
  sizePosition,
  type LaneStub,
} from "./risk";
import { BUDGET_UNIVERSE, SEBI_BANNER } from "./universe";
import type { LookupResponse, Verdict } from "./types";

export interface LookupOpts {
  budget_inr?: number;
  risk_pct?: number;
  /** Fetch live funda (default true). */
  funda?: boolean;
  /** Fetch live news (default true for single lookup). */
  news?: boolean;
}

function toStub(
  lane: {
    ticker: string;
    fields: Record<string, unknown>;
    unknowns: string[];
    sources: string[];
    note?: string;
  }
): LaneStub {
  return {
    ticker: lane.ticker,
    fields: lane.fields || {},
    unknowns: lane.unknowns || [],
    sources: lane.sources || [],
    note: lane.note,
  };
}

function laneToResponse(
  lane: LaneStub,
  ticker: string
): LookupResponse["funda"] {
  return {
    ticker: lane.ticker || ticker,
    fields: lane.fields || {},
    unknowns: lane.unknowns || [],
    note:
      lane.note ||
      (lane.sources?.length
        ? `sources: ${lane.sources.join(" · ")}`
        : "live HTTP"),
    sources: lane.sources,
  };
}

export async function runLookup(
  symbolRaw: string,
  opts: LookupOpts = {}
): Promise<LookupResponse> {
  const { ticker, yahoo } = normalizeNseSymbol(symbolRaw);
  const hist = await fetchYahooHistory(yahoo);
  const tech = hist ? computeTech(ticker, hist) : unknownTech(ticker, yahoo);

  const wantFunda = opts.funda !== false;
  const wantNews = opts.news !== false;

  const [fundaLane, newsLane] = await Promise.all([
    wantFunda
      ? fetchLiveFunda(ticker, yahoo)
      : Promise.resolve(
          unknownFunda(ticker, "Funda fetch skipped")
        ),
    wantNews
      ? fetchLiveNews(ticker, yahoo)
      : Promise.resolve(
          unknownNews(ticker, "News fetch skipped")
        ),
  ]);

  const funda = toStub(fundaLane);
  const news = toStub(newsLane);

  const verdict = mergeVerdict(tech, {
    budget_inr: opts.budget_inr ?? 10000,
    risk_pct: opts.risk_pct ?? 1,
    funda,
    news,
  });

  return {
    ticker,
    yahoo_symbol: yahoo,
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    tech,
    funda: laneToResponse(funda, ticker),
    news: laneToResponse(news, ticker),
    verdict,
  };
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

export interface BudgetPicksResult {
  budget_inr: number;
  risk_pct: number;
  risk_inr: number;
  as_of: string;
  sebi_banner: string;
  universe: string[];
  picks: Verdict[];
  scanned: number;
  note: string;
}

/**
 * Scan universe with live Yahoo tech + HTTP funda + risk.
 * News skipped for speed.
 */
export async function runBudgetPicks(
  budget_inr: number,
  risk_pct: number
): Promise<BudgetPicksResult> {
  const universe = [...BUDGET_UNIVERSE];
  const lookups = await mapPool(universe, 3, async (sym) => {
    try {
      return await runLookup(sym, {
        budget_inr,
        risk_pct,
        funda: true,
        news: false,
      });
    } catch {
      return null;
    }
  });

  const buys: Verdict[] = [];
  for (const lu of lookups) {
    if (!lu) continue;
    const v = lu.verdict;
    if (v.action !== "buy") continue;
    if (v.entry == null || v.sl == null) continue;
    const sized = sizePosition({
      budget_inr,
      risk_pct,
      entry: v.entry,
      sl: v.sl,
    });
    if (!sized.ok) continue;
    if (sized.shares < 1) continue;
    if (v.entry * sized.shares > budget_inr) continue;
    buys.push({
      ...v,
      shares: sized.shares,
      size_inr: sized.size_inr,
      buy_trigger: v.buy_trigger ?? v.entry,
      sell_targets: v.sell_targets?.length ? v.sell_targets : v.targets,
      stop_invalidation: v.stop_invalidation ?? v.sl,
      time_horizon: v.time_horizon ?? "2–6 weeks (swing)",
    });
  }

  buys.sort((a, b) => pickScore(b) - pickScore(a));

  return {
    budget_inr,
    risk_pct,
    risk_inr: budget_inr * (risk_pct / 100),
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    universe,
    picks: buys.slice(0, 10),
    scanned: universe.length,
    note: "Live Yahoo tech + HTTP funda (Screener/Yahoo) + TS mergeVerdict (news skipped for speed). Vercel-safe.",
  };
}
