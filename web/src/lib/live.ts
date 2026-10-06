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
import type { LookupResponse, SkippedSample, TechLane, Verdict } from "./types";

export interface LookupOpts {
  budget_inr?: number;
  risk_pct?: number;
  /** Fetch live funda (default true). */
  funda?: boolean;
  /** Fetch live news (default true for single lookup). */
  news?: boolean;
  /** Epoch ms: don't wait for a Screener slot past this (budget-picks time box). */
  fundaDeadlineAt?: number;
  /** Reuse an already-computed tech lane (budget picks: tech pass first). */
  tech?: TechLane;
}

/**
 * Funda that failed to load (Screener 429/timeout/blank, Yahoo crumb failure,
 * deadline) is shown as UNKNOWN with the reasons — never estimated, never an
 * "avoid" by itself (same rule as report_v2+, commit c89cb3f).
 */
export function fundaUnknownReasons(lane: { note?: string; unknowns?: string[]; screener_error?: string; fields?: Record<string, unknown> }): string[] {
  const out: string[] = [];
  if (lane.screener_error) out.push(`Screener: ${lane.screener_error.replace(/^screener_/, "")}`);
  for (const part of String(lane.note || "").split(/;\s*/)) {
    if (/unavailable|skipped|failed|deadline/i.test(part) && !/^Screener unavailable/i.test(part)) out.push(part.trim());
  }
  const missing = (lane.unknowns || []).filter((k) => ["pe_ttm", "roe_pct", "debt_equity"].includes(k));
  if (missing.length) out.push(`Missing: ${missing.join(", ")}`);
  return [...new Set(out)].filter(Boolean);
}

export const FUNDA_UNKNOWN_LABEL = "Fundamentals UNKNOWN (not verified)";

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
  let tech = opts.tech;
  if (!tech) {
    const hist = await fetchYahooHistory(yahoo);
    tech = hist ? computeTech(ticker, hist) : unknownTech(ticker, yahoo);
  }

  const wantFunda = opts.funda !== false;
  const wantNews = opts.news !== false;

  const [fundaLane, newsLane] = await Promise.all([
    wantFunda
      ? fetchLiveFunda(ticker, yahoo, { deadlineAt: opts.fundaDeadlineAt }).catch(() => unknownFunda(ticker, "Funda fetch failed"))
      : Promise.resolve(unknownFunda(ticker, "Funda fetch skipped")),
    wantNews
      ? fetchLiveNews(ticker, yahoo)
      : Promise.resolve(unknownNews(ticker, "News fetch skipped")),
  ]);

  const funda = toStub(fundaLane);
  const news = toStub(newsLane);

  const merged = mergeVerdict(tech, {
    budget_inr: opts.budget_inr ?? 10000,
    risk_pct: opts.risk_pct ?? 1,
    funda,
    news,
    fundaGap: "unknown",
    levels: "rr_floor_v3",
  });
  const verdict: Verdict = merged.funda_unknown
    ? { ...merged, funda_unknown_label: FUNDA_UNKNOWN_LABEL, funda_unknown_reasons: fundaUnknownReasons(fundaLane) }
    : merged;

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
  limit = 10,
  opts: { verifiedFirst?: boolean } = {}
): Verdict[] {
  if (opts.verifiedFirst) {
    // Verified-funda names always rank above funda_unknown ones; sector caps are shared.
    const isUnk = (v: Verdict) => !!v.risk_flags?.includes("funda_unknown");
    const first = diversifyPicks(buys.filter((v) => !isUnk(v)), budget_inr, limit);
    const maxPer = budget_inr <= TIGHT_SECTOR_BUDGET_INR ? 1 : 2;
    const used = new Map<string, number>();
    for (const p of first) {
      const sec = p.sector || sectorOf(p.ticker) || "Unknown";
      used.set(sec, (used.get(sec) || 0) + 1);
    }
    const rest = diversifyPicks(
      buys.filter((v) => isUnk(v) && (used.get(v.sector || sectorOf(v.ticker) || "Unknown") || 0) < maxPer),
      budget_inr,
      limit
    );
    const out = [...first];
    for (const p of rest) {
      if (out.length >= limit) break;
      const sec = p.sector || sectorOf(p.ticker) || "Unknown";
      if ((used.get(sec) || 0) >= maxPer) continue;
      used.set(sec, (used.get(sec) || 0) + 1);
      out.push(p);
    }
    return out;
  }
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
  const t0 = Date.now();
  // Pass 1 — tech for every name (Yahoo chart only).
  const techs = await mapPool(universe, 5, async (sym) => {
    const { ticker, yahoo } = normalizeNseSymbol(sym);
    try {
      const hist = await fetchYahooHistory(yahoo);
      return hist ? computeTech(ticker, hist) : unknownTech(ticker, yahoo);
    } catch {
      return unknownTech(ticker, yahoo);
    }
  });
  // Pass 2 — funda only where the tape alone makes a paper buy (funda can only
  // keep or remove a buy, never create one). Shared Screener pacer in funda.ts;
  // the deadline keeps the route inside the 60 s serverless limit — names not
  // fetched in time are shown as Fundamentals UNKNOWN (not verified).
  const fundaDeadlineAt = t0 + (process.env.BUDGET_FUNDA_BUDGET_MS ? Number(process.env.BUDGET_FUNDA_BUDGET_MS) : 40_000);
  const tapeOnly = techs.map((tech) =>
    mergeVerdict(tech, { budget_inr, risk_pct, funda: null, news: null, fundaGap: "unknown", levels: "rr_floor_v3" })
  );
  const lookups = await mapPool(universe.map((_, i) => i), 3, async (i) => {
    const tech = techs[i];
    const tape = tapeOnly[i];
    if (tape.action !== "buy") {
      const { ticker, yahoo } = normalizeNseSymbol(universe[i]);
      const skipped = unknownFunda(ticker, "Funda not fetched — the tape alone rules out a paper buy");
      return {
        ticker,
        yahoo_symbol: yahoo,
        as_of: new Date().toISOString(),
        sebi_banner: SEBI_BANNER,
        tech,
        funda: laneToResponse(toStub(skipped), ticker),
        news: laneToResponse(toStub(unknownNews(ticker, "News fetch skipped")), ticker),
        verdict: { ...tape, funda_unknown_label: FUNDA_UNKNOWN_LABEL, funda_unknown_reasons: ["Not fetched — the tape alone rules out a paper buy"] },
      } as LookupResponse;
    }
    try {
      return await runLookup(universe[i], {
        budget_inr,
        risk_pct,
        funda: true,
        news: false,
        tech,
        fundaDeadlineAt,
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
  // Verified-funda buys first, then Fundamentals UNKNOWN (not verified) ones.
  const capped = diversifyPicks(buys, budget_inr, 10, { verifiedFirst: true });
  const nUnverified = capped.filter((v) => v.risk_flags?.includes("funda_unknown")).length;

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
    note: `Live Yahoo tech + HTTP funda (only for tape buys) + TS mergeVerdict (news skipped). risk_v3 levels: T1 ≥ 1R, T2 ≥ 1.8R; resistance under 1R blocks a buy. Sector round-robin (${maxPer}); soft-demote mega-PSU repeats (−18); verified fundamentals rank above UNKNOWN ones${nUnverified ? ` (${nUnverified} pick(s) with Fundamentals UNKNOWN)` : ""}. Scan ${Math.round((Date.now() - t0) / 100) / 10} s.`,
    empty_code,
    reasons: reasons.length ? reasons : undefined,
    warnings: warnings.length ? warnings : undefined,
    skipped_samples: skipped_samples.length ? skipped_samples : undefined,
  };
}
