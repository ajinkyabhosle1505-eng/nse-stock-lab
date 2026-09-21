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
import { BUDGET_UNIVERSE, SEBI_BANNER, sectorOf } from "./universe";
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
  empty_code?: "cant_buy_even_one_share" | "risk_too_tight" | "no_buy_setups";
  reasons?: string[];
  warnings?: string[];
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
  const warnings: string[] = [];
  let sawBuySetup = false;
  let sawAffordableCmp = false;

  for (const lu of lookups) {
    if (!lu) continue;
    const cmp = Number((lu.tech as { fields?: { cmp?: number } })?.fields?.cmp);
    if (Number.isFinite(cmp) && cmp > 0 && cmp <= budget_inr) sawAffordableCmp = true;
    const v = lu.verdict;
    if (v.action === "buy") sawBuySetup = true;
    if (v.action !== "buy") continue;
    if (v.entry == null || v.sl == null) continue;
    const sized = sizePosition({
      budget_inr,
      risk_pct,
      entry: v.entry,
      sl: v.sl,
    });
    if (!sized.ok) {
      if (sized.reason === "cant_buy_even_one_share") {
        /* tracked via sawAffordableCmp */
      } else if (sized.reason === "shares<1" || sized.reason === "afford_one_share") {
      }
      continue;
    }
    if (sized.shares < 1) continue;
    if (v.entry * sized.shares > budget_inr) continue;
    if (sized.reason === "afford_one_share") {
      warnings.push(
        `${v.ticker}: classic ${risk_pct}% risk could not fund a share, so we sized 1+ shares to fit ₹${budget_inr}. Money at risk may exceed ${risk_pct}% of budget.`
      );
    }
    const sector =
      (typeof (lu.funda as { fields?: { sector?: string } })?.fields?.sector === "string"
        ? (lu.funda as { fields?: { sector?: string } }).fields?.sector
        : null) ||
      (v as Verdict & { sector?: string }).sector ||
      sectorOf(v.ticker);
    buys.push({
      ...v,
      shares: sized.shares,
      size_inr: sized.size_inr,
      buy_trigger: v.buy_trigger ?? v.entry,
      sell_targets: v.sell_targets?.length ? v.sell_targets : v.targets,
      stop_invalidation: v.stop_invalidation ?? v.sl,
      time_horizon: v.time_horizon ?? "2–6 weeks (swing)",
      sizing_mode: sized.reason === "afford_one_share" ? "afford_one_share" : "risk_pct",
      sector,
    } as Verdict);
  }

  buys.sort((a, b) => pickScore(b) - pickScore(a));

  // P0b: max 2 picks per sector
  const sectorCount = new Map<string, number>();
  const capped: Verdict[] = [];
  for (const p of buys) {
    const sector = (p as Verdict & { sector?: string }).sector || "Unknown";
    const n = sectorCount.get(sector) || 0;
    if (n >= 2) continue;
    sectorCount.set(sector, n + 1);
    capped.push(p);
    if (capped.length >= 10) break;
  }

  let empty_code: BudgetPicksResult["empty_code"];
  const reasons: string[] = [];
  if (capped.length === 0) {
    if (!sawAffordableCmp) {
      empty_code = "cant_buy_even_one_share";
      reasons.push(
        `₹${budget_inr} cannot buy even 1 share of any name we scanned (cheapest CMPs are above your budget).`
      );
    } else if (!sawBuySetup) {
      empty_code = "no_buy_setups";
      reasons.push("No buy setups in the scanned book right now (tape/funda gates).");
    } else {
      empty_code = "risk_too_tight";
      reasons.push(
        `Some names fit the budget, but ${risk_pct}% risk sizing and/or gates left 0 paper buys. Try a larger budget or the afford-one-share path on a higher amount.`
      );
    }
    if (budget_inr <= 500) {
      reasons.push(
        `Plain talk: with only ₹${budget_inr}, most NSE stocks cost more than one share. This is a paper desk — raise the budget chip or pick a cheaper name on Lookup.`
      );
    }
  }

  return {
    budget_inr,
    risk_pct,
    risk_inr: budget_inr * (risk_pct / 100),
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    universe,
    picks: capped,
    scanned: universe.length,
    note: "Live Yahoo tech + HTTP funda + TS mergeVerdict (news skipped for speed). Vercel-safe. Max 2 picks/sector.",
    empty_code,
    reasons: reasons.length ? reasons : undefined,
    warnings: warnings.length ? warnings : undefined,
  };
}
