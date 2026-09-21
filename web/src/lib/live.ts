import { fetchYahooHistory, normalizeNseSymbol } from "./yahoo";
import { computeTech, unknownTech } from "./tech";
import { mergeVerdict, pickScore, sizePosition } from "./risk";
import { BUDGET_UNIVERSE, SEBI_BANNER } from "./universe";
import type { LookupResponse, Verdict } from "./types";

const FUNDA_NOTE =
  "MVP: no live funda scrape — fields marked UNKNOWN. Wire Screener/Moneycontrol later.";
const NEWS_NOTE =
  "MVP: no live news scrape — headlines UNKNOWN. Wire RSS/news API later.";

export async function runLookup(
  symbolRaw: string,
  opts: { budget_inr?: number; risk_pct?: number } = {}
): Promise<LookupResponse> {
  const { ticker, yahoo } = normalizeNseSymbol(symbolRaw);
  const hist = await fetchYahooHistory(yahoo);
  const tech = hist
    ? computeTech(ticker, hist)
    : unknownTech(ticker, yahoo);

  const verdict = mergeVerdict(tech, {
    budget_inr: opts.budget_inr ?? 10000,
    risk_pct: opts.risk_pct ?? 1,
  });

  const as_of = new Date().toISOString();

  return {
    ticker,
    yahoo_symbol: yahoo,
    as_of,
    sebi_banner: SEBI_BANNER,
    tech,
    funda: {
      ticker,
      fields: {},
      unknowns: [
        "pe",
        "roe",
        "debt_equity",
        "promoter_holding",
        "promoter_pledge_pct",
      ],
      note: FUNDA_NOTE,
    },
    news: {
      ticker,
      fields: {},
      unknowns: ["headlines", "catalysts", "sentiment"],
      note: NEWS_NOTE,
    },
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
 * Scan universe with live Yahoo tech+risk; return up to 10 buys
 * where shares>=1 and entry*shares <= budget_inr.
 * Prefer PSU/Infra/Banks/Energy when tape supports (via pickScore).
 */
export async function runBudgetPicks(
  budget_inr: number,
  risk_pct: number
): Promise<BudgetPicksResult> {
  const universe = [...BUDGET_UNIVERSE];
  const lookups = await mapPool(universe, 4, async (sym) => {
    try {
      return await runLookup(sym, { budget_inr, risk_pct });
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
  const picks = buys.slice(0, 10);

  return {
    budget_inr,
    risk_pct,
    risk_inr: budget_inr * (risk_pct / 100),
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    universe,
    picks,
    scanned: universe.length,
    note: "Live Yahoo tech + TS risk merge. Funda/news stubs. Prefer Banks/Energy/Infra when tape supports.",
  };
}
