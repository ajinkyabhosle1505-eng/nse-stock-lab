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
import { plainReason } from "./plain";
import {
  BUDGET_UNIVERSE,
  SEBI_BANNER,
  TIGHT_SECTOR_BUDGET_INR,
  isMegaPsuDemote,
  sectorOf,
} from "./universe";
import type { LookupResponse, SkippedSample, Verdict } from "./types";

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
      : Promise.resolve(unknownFunda(ticker, "Funda fetch skipped")),
    wantNews
      ? fetchLiveNews(ticker, yahoo)
      : Promise.resolve(unknownNews(ticker, "News fetch skipped")),
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

export async function mapPool<T, R>(
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
  skipped_samples?: SkippedSample[];
}

/**
 * Soft-demote mega-PSU repeats so PNB/COALINDIA cannot own every top list.
 * Documented: −18 score for MEGA_PSU_DEMOTE names (still eligible).
 */
export function diversifiedPickScore(v: Verdict): number {
  let s = pickScore(v);
  if (isMegaPsuDemote(v.ticker)) s -= 18;
  return s;
}

/**
 * Sector-first round-robin by score with max picks/sector.
 * budget ≤ TIGHT_SECTOR_BUDGET_INR → max 1/sector; else max 2.
 */
export function diversifyPicks(
  buys: Verdict[],
  budget_inr: number,
  limit = 10
): Verdict[] {
  const maxPerSector = budget_inr <= TIGHT_SECTOR_BUDGET_INR ? 1 : 2;
  const bySector = new Map<string, Verdict[]>();
  for (const p of buys) {
    const sector = p.sector || sectorOf(p.ticker) || "Unknown";
    const list = bySector.get(sector) || [];
    list.push(p);
    bySector.set(sector, list);
  }
  for (const [, list] of bySector) {
    list.sort((a, b) => diversifiedPickScore(b) - diversifiedPickScore(a));
  }

  const capped: Verdict[] = [];
  const taken = new Map<string, number>();
  const queues = [...bySector.entries()].map(([sector, list]) => ({
    sector,
    list: [...list],
  }));
  // Prefer higher first-pick score when starting a round
  queues.sort(
    (a, b) =>
      diversifiedPickScore(b.list[0] || { confidence_1_10: 0 } as Verdict) -
      diversifiedPickScore(a.list[0] || { confidence_1_10: 0 } as Verdict)
  );

  let progressed = true;
  while (capped.length < limit && progressed) {
    progressed = false;
    for (const q of queues) {
      if (capped.length >= limit) break;
      const n = taken.get(q.sector) || 0;
      if (n >= maxPerSector) continue;
      while (q.list.length) {
        const next = q.list.shift()!;
        // already used? (shouldn't)
        if (capped.some((c) => c.ticker === next.ticker)) continue;
        capped.push(next);
        taken.set(q.sector, n + 1);
        progressed = true;
        break;
      }
    }
  }
  return capped;
}

function plainWhyBuy(v: Verdict): string {
  const raw = v.reasons?.[0] || v.risk_flags?.[0] || "Tape/funda gates favor paper long";
  return plainReason(String(raw));
}

function plainWhySkip(v: Verdict): string {
  if (v.action === "avoid") {
    return plainReason(v.avoids_note || v.reasons?.[0] || "Avoid — skip fresh paper long");
  }
  if (v.insufficient_data) {
    return "Price data missing from Yahoo — not invented";
  }
  const sizeFlag = v.risk_flags?.find((f) => f.startsWith("size_blocked:"));
  if (sizeFlag) {
    return plainReason(
      v.reasons?.find((r) => /size blocked/i.test(r)) ||
        `Tape favors long but size blocked (${sizeFlag.replace("size_blocked:", "")})`
    );
  }
  return plainReason(v.reasons?.[0] || `Action=${v.action} — no paper buy`);
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
  const nonBuys: Verdict[] = [];
  const warnings: string[] = [];
  let sawBuySetup = false;
  let sawAffordableCmp = false;

  for (const lu of lookups) {
    if (!lu) continue;
    const cmp = Number((lu.tech as { fields?: { cmp?: number } })?.fields?.cmp);
    if (Number.isFinite(cmp) && cmp > 0 && cmp <= budget_inr) sawAffordableCmp = true;
    const v = lu.verdict;
    if (v.action === "buy") sawBuySetup = true;

    if (v.action !== "buy") {
      nonBuys.push(v);
      continue;
    }
    if (v.entry == null || v.sl == null) {
      nonBuys.push(v);
      continue;
    }

    // Re-size so afford_one_share path is honored when ok
    const sized = sizePosition({
      budget_inr,
      risk_pct,
      entry: v.entry,
      sl: v.sl,
    });
    if (!sized.ok) {
      nonBuys.push({
        ...v,
        action: "hold",
        reasons: [
          ...(v.reasons || []),
          `Size blocked (${sized.reason})`,
        ],
        risk_flags: [...(v.risk_flags || []), `size_blocked:${sized.reason}`],
      });
      continue;
    }
    if (sized.shares < 1) {
      nonBuys.push(v);
      continue;
    }
    if (v.entry * sized.shares > budget_inr) {
      nonBuys.push({
        ...v,
        reasons: [...(v.reasons || []), "Notional exceeds budget after sizing"],
      });
      continue;
    }
    if (sized.reason === "afford_one_share") {
      warnings.push(
        `${v.ticker}: classic ${risk_pct}% risk could not fund a share, so we sized 1+ shares to fit ₹${budget_inr}. Money at risk may exceed ${risk_pct}% of budget.`
      );
    }
    const sector =
      (typeof (lu.funda as { fields?: { sector?: string } })?.fields?.sector ===
      "string"
        ? (lu.funda as { fields?: { sector?: string } }).fields?.sector
        : null) ||
      v.sector ||
      sectorOf(v.ticker);

    const techFields = lu.tech?.fields as {
      atr_14?: number | string;
      structure?: string;
      breakout_state?: string;
    } | undefined;
    const atrRaw = techFields?.atr_14;
    const atr_14 =
      typeof atrRaw === "number" && Number.isFinite(atrRaw) ? atrRaw : undefined;

    const pick: Verdict & {
      atr_14?: number;
      structure?: string;
      breakout_state?: string;
    } = {
      ...v,
      shares: sized.shares,
      size_inr: sized.size_inr,
      buy_trigger: v.buy_trigger ?? v.entry,
      sell_targets: v.sell_targets?.length ? v.sell_targets : v.targets,
      stop_invalidation: v.stop_invalidation ?? v.sl,
      time_horizon: v.time_horizon ?? "2–6 weeks (swing)",
      sizing_mode:
        sized.reason === "afford_one_share" ? "afford_one_share" : "risk_pct",
      sector,
      plain_why: plainWhyBuy(v),
      atr_14,
      structure:
        typeof techFields?.structure === "string"
          ? techFields.structure
          : undefined,
      breakout_state:
        typeof techFields?.breakout_state === "string"
          ? techFields.breakout_state
          : undefined,
    };
    buys.push(pick);
  }

  buys.sort((a, b) => diversifiedPickScore(b) - diversifiedPickScore(a));
  const capped = diversifyPicks(buys, budget_inr, 10);

  // Skipped samples for transparency (3–5), prefer affordable CMPs
  const skipped_samples: SkippedSample[] = nonBuys
    .slice()
    .sort((a, b) => {
      const ca = typeof a.cmp === "number" ? a.cmp : 1e12;
      const cb = typeof b.cmp === "number" ? b.cmp : 1e12;
      return ca - cb;
    })
    .slice(0, 5)
    .map((v) => ({
      ticker: v.ticker,
      action: String(v.action),
      sector: v.sector || sectorOf(v.ticker),
      cmp: typeof v.cmp === "number" ? v.cmp : null,
      plain_why_skip: plainWhySkip(v),
    }));

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
      reasons.push(
        "No buy setups in the scanned book right now (tape/funda gates)."
      );
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

  const maxPer =
    budget_inr <= TIGHT_SECTOR_BUDGET_INR ? "max 1/sector" : "max 2/sector";

  return {
    budget_inr,
    risk_pct,
    risk_inr: budget_inr * (risk_pct / 100),
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    universe,
    picks: capped,
    scanned: universe.length,
    note: `Live Yahoo tech + HTTP funda + TS mergeVerdict (news skipped). Sector round-robin (${maxPer}); soft-demote mega-PSU repeats (−18). Vercel-safe.`,
    empty_code,
    reasons: reasons.length ? reasons : undefined,
    warnings: warnings.length ? warnings : undefined,
    skipped_samples: skipped_samples.length ? skipped_samples : undefined,
  };
}
