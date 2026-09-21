import {
  isPennyWatch,
  isPreferredSector,
  sectorOf,
  SEBI_BANNER,
} from "./universe";
import { numOrNull } from "./tech";
import type { TechLane, Verdict } from "./types";

export interface SizeInput {
  budget_inr: number;
  risk_pct: number;
  entry: number;
  sl: number;
}

export interface SizeResult {
  risk_inr: number;
  per_share: number;
  shares: number;
  size_inr: number;
  ok: boolean;
  reason?: string;
}

/**
 * risk_inr = budget * (risk_pct/100)
 * per_share = entry - sl
 * shares = floor(risk_inr / per_share)
 * no buy if per_share<=0 or shares<1 or notional>budget
 */
export function sizePosition(input: SizeInput): SizeResult {
  const { budget_inr, risk_pct, entry, sl } = input;
  const risk_inr = budget_inr * (risk_pct / 100);
  const per_share = entry - sl;
  if (!(per_share > 0)) {
    return {
      risk_inr,
      per_share,
      shares: 0,
      size_inr: 0,
      ok: false,
      reason: "per_share<=0",
    };
  }
  let shares = Math.floor(risk_inr / per_share);
  if (shares < 1) {
    return {
      risk_inr,
      per_share,
      shares: 0,
      size_inr: 0,
      ok: false,
      reason: "shares<1",
    };
  }
  // Cap by budget notional
  while (shares >= 1 && entry * shares > budget_inr) {
    shares -= 1;
  }
  if (shares < 1) {
    return {
      risk_inr,
      per_share,
      shares: 0,
      size_inr: 0,
      ok: false,
      reason: "notional>budget",
    };
  }
  return {
    risk_inr,
    per_share,
    shares,
    size_inr: Math.round(entry * shares * 100) / 100,
    ok: true,
  };
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function deriveLevels(tech: TechLane): {
  entry: number | null;
  sl: number | null;
  targets: number[];
} {
  const cmp = numOrNull(tech.fields.cmp);
  const atr = numOrNull(tech.fields.atr_14);
  if (cmp == null) return { entry: null, sl: null, targets: [] };

  const entry = cmp;
  let sl: number | null = null;
  if (atr != null && atr > 0) {
    sl = round(entry - 2.4 * atr);
  } else if (tech.fields.support_levels?.length) {
    sl = round(Math.min(...tech.fields.support_levels) * 0.995);
  }

  const targets: number[] = [];
  if (atr != null && atr > 0) {
    targets.push(round(entry + 2 * atr));
    targets.push(round(entry + 3.5 * atr));
  }
  // Prefer listed resistance if above entry
  for (const r of tech.fields.resistance_levels || []) {
    if (r > entry && !targets.includes(r)) {
      // keep ATR targets as primary; resistance as risk note only
    }
  }
  return { entry, sl, targets };
}

function buyBias(tech: TechLane): {
  favorBuy: boolean;
  holdAvoid: boolean;
  reasons: string[];
  flags: string[];
} {
  const f = tech.fields;
  const reasons: string[] = [];
  const flags: string[] = [];
  const structure = f.structure;
  const brk = f.breakout_state;
  const pvd = f.price_vs_dma;
  const rsi = numOrNull(f.rsi_14);
  const cmp = numOrNull(f.cmp);

  const isBreakout = brk === "breakout";
  const isHhHl = structure === "HH_HL";
  const isBreakdown = brk === "breakdown";
  const belowLhLl = pvd === "below" && structure === "LH_LL";

  if (isBreakdown || belowLhLl) {
    return {
      favorBuy: false,
      holdAvoid: true,
      reasons: [
        isBreakdown
          ? "Tape: breakdown — no fresh long"
          : "Tape: below all DMAs + LH_LL — hold/avoid",
      ],
      flags: isBreakdown ? ["breakdown"] : ["below_dma_lh_ll"],
    };
  }

  let favorBuy = isBreakout || isHhHl;

  if (isBreakout) {
    reasons.push(
      `Tape: breakout, price_vs_dma=${pvd}${
        rsi != null ? `, RSI~${Math.round(rsi)}` : ""
      }`
    );
  } else if (isHhHl) {
    reasons.push(
      `Tape: HH_HL structure, price_vs_dma=${pvd}${
        rsi != null ? `, RSI~${Math.round(rsi)}` : ""
      }`
    );
  } else {
    reasons.push(
      `Tape: structure=${structure}, breakout=${brk}, price_vs_dma=${pvd}`
    );
  }

  // Penny watch: avoid unless exceptional
  if (cmp != null && (cmp < 50 || isPennyWatch(tech.ticker))) {
    const exceptional =
      isBreakout && pvd === "above" && rsi != null && rsi >= 55 && rsi <= 70;
    if (!exceptional) {
      favorBuy = false;
      flags.push("penny_watch");
      reasons.push("Penny / watchlist name — avoid unless exceptional tape");
    } else {
      flags.push("penny_exceptional");
      reasons.push("Penny watch but exceptional breakout above DMAs");
    }
  }

  if (rsi != null && rsi >= 72) {
    flags.push("rsi_stretched");
  }

  if ((f.resistance_levels || []).length && cmp != null) {
    const near = f.resistance_levels.filter((r) => r <= cmp * 1.03 && r >= cmp);
    if (near.length) {
      flags.push(
        `Listed resistance tight (${near.join("–")}) — scale / ATR extension`
      );
    }
  }

  return { favorBuy, holdAvoid: false, reasons, flags };
}

export interface MergeOpts {
  budget_inr?: number;
  risk_pct?: number;
}

/**
 * Merge live tech into a Verdict with plan fields.
 * Funda/news are thin stubs — risk is tech-led for MVP.
 */
export function mergeVerdict(
  tech: TechLane,
  opts: MergeOpts = {}
): Verdict {
  const budget_inr = opts.budget_inr ?? 10000;
  const risk_pct = opts.risk_pct ?? 1;
  const cmp = numOrNull(tech.fields.cmp);
  const { entry, sl, targets } = deriveLevels(tech);
  const bias = buyBias(tech);
  const sector = sectorOf(tech.ticker);
  const preferred = isPreferredSector(tech.ticker);

  let action: Verdict["action"] = "hold";
  let confidence = 4;
  const reasons = [...bias.reasons];
  const risk_flags = [...bias.flags];

  if (cmp == null || entry == null || sl == null) {
    return {
      ticker: tech.ticker,
      action: "avoid",
      confidence_1_10: 1,
      entry: null,
      sl: null,
      targets: [],
      size_inr: null,
      shares: null,
      r_r: null,
      reasons: ["Yahoo history missing — cannot size"],
      risk_flags: ["insufficient_yahoo"],
      avoids_note: "No live CMP from Yahoo",
      insufficient_data: true,
      sebi_banner: SEBI_BANNER,
      cmp: "UNKNOWN",
      under_1000: undefined,
      penny_under_50: undefined,
      sector,
      buy_trigger: null,
      sell_targets: [],
      stop_invalidation: null,
      time_horizon: null,
      live: true,
      yahoo_symbol: tech.yahoo_symbol,
      note: "Price data UNKNOWN — not invented",
    };
  }

  const sized =
    entry != null && sl != null
      ? sizePosition({ budget_inr, risk_pct, entry, sl })
      : null;

  if (bias.holdAvoid) {
    action = bias.flags.includes("breakdown") ? "avoid" : "hold";
    confidence = 5;
  } else if (bias.favorBuy && sized?.ok) {
    action = "buy";
    confidence = 6;
    if (tech.fields.breakout_state === "breakout") confidence += 1;
    if (tech.fields.price_vs_dma === "above") confidence += 1;
    if (preferred) {
      confidence += 0;
      reasons.push(`Sector preference: ${sector}`);
    }
    confidence = Math.min(9, confidence);
  } else if (bias.favorBuy && sized && !sized.ok) {
    action = "hold";
    confidence = 5;
    risk_flags.push(`size_blocked:${sized.reason}`);
    reasons.push(`Tape favors long but size blocked (${sized.reason})`);
  } else {
    action = "hold";
    confidence = 4;
  }

  // Prefer PSU/Infra/Banks/Energy — slight confidence nudge already via reasons
  if (action === "buy" && !preferred && !bias.favorBuy) {
    // unreachable guard
  }

  let r_r: number | null = null;
  if (entry != null && sl != null && targets.length) {
    const risk = entry - sl;
    const reward = targets[0] - entry;
    if (risk > 0) r_r = round(reward / risk, 2);
  }

  const shares = action === "buy" && sized?.ok ? sized.shares : null;
  const size_inr = action === "buy" && sized?.ok ? sized.size_inr : null;

  return {
    ticker: tech.ticker,
    action,
    confidence_1_10: confidence,
    entry,
    sl,
    targets,
    size_inr,
    shares,
    r_r,
    reasons,
    risk_flags,
    avoids_note: action === "avoid" ? reasons[0] ?? null : null,
    insufficient_data: false,
    sebi_banner: SEBI_BANNER,
    cmp,
    under_1000: cmp < 1000,
    penny_under_50: cmp < 50,
    sector,
    buy_trigger: entry,
    sell_targets: targets,
    stop_invalidation: sl,
    time_horizon: "2–6 weeks (swing)",
    live: true,
    yahoo_symbol: tech.yahoo_symbol,
  };
}

/** Score for ranking budget picks (higher = better). */
export function pickScore(v: Verdict): number {
  let s = (v.confidence_1_10 || 0) * 10;
  if (v.action === "buy") s += 100;
  if (isPreferredSector(v.ticker)) s += 15;
  if (v.penny_under_50) s -= 40;
  if (v.r_r != null) s += v.r_r * 5;
  if (v.under_1000) s += 5;
  return s;
}
