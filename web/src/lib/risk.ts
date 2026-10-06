import {
  isPennyWatch,
  isPreferredSector,
  sectorOf,
  SEBI_BANNER,
} from "./universe";
import { numOrNull } from "./tech";
import { RR_T1_MIN, RR_T2_MIN, rrOf, rrPlain } from "./rr";
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

/** Optional funda / news lane blobs (live or stub). */
export interface LaneStub {
  ticker?: string;
  fields?: Record<string, unknown>;
  unknowns?: string[];
  sources?: string[];
  note?: string;
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
  let affordOneShare = false;
  // P0a: if classic risk% yields 0 shares but 1 share fits in budget, offer afford_one_share
  if (shares < 1) {
    if (entry <= budget_inr) {
      shares = Math.max(1, Math.floor(budget_inr / entry));
      affordOneShare = true;
    } else {
      return {
        risk_inr,
        per_share,
        shares: 0,
        size_inr: 0,
        ok: false,
        reason: "cant_buy_even_one_share",
      };
    }
  }
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
    reason: affordOneShare ? "afford_one_share" : undefined,
  };
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Level policy.
 * "atr_v2" (report_v1/v2, legacy): SL = entry − 2.4×ATR, T1 = +2×ATR, T2 = +3.5×ATR
 *   → T1 is 0.83R by construction. Kept so stored v1/v2 reports re-verify.
 * "rr_floor_v3" (report_v3|risk_v3): structure SL (nearest swing low − 0.25×ATR,
 *   clamped to 1.0–2.4×ATR); T1 ≥ entry + 1.0R, T2 ≥ entry + 1.8R,
 *   moved out to real overhead resistance (swing high / prior 20- or 50-day high)
 *   when that sits beyond the floor. Resistance below entry + 1R caps the setup → no buy.
 */
export type LevelPolicy = "atr_v2" | "rr_floor_v3";
export const CURRENT_LEVEL_POLICY: LevelPolicy = "rr_floor_v3";

export interface ResistanceLevel {
  price: number;
  source: "swing high" | "20-day high" | "50-day high" | "listed resistance";
}

export interface LevelPlan {
  entry: number | null;
  sl: number | null;
  targets: number[];
  /** rr_floor_v3 only */
  risk?: number;
  t1_basis?: string;
  t2_basis?: string;
  cap?: (ResistanceLevel & { rr: number }) | null;
}

const ceil2 = (n: number) => Math.ceil(n * 100 - 1e-6) / 100;

function stopFor(tech: TechLane, entry: number, policy: LevelPolicy = "atr_v2"): number | null {
  const atr = numOrNull(tech.fields.atr_14);
  if (policy === "rr_floor_v3" && atr != null && atr > 0) {
    // Structure stop: just under the nearest swing low (0.25×ATR buffer), kept between
    // 1.0×ATR (noise) and 2.4×ATR (the legacy wide stop). No support → 2.0×ATR.
    const sup = (tech.fields.support_levels ?? []).filter((x) => typeof x === "number" && x < entry);
    const nearest = sup.length ? Math.max(...sup) : null;
    const raw = nearest != null ? entry - (nearest - 0.25 * atr) : 2.0 * atr;
    const dist = Math.min(2.4 * atr, Math.max(1.0 * atr, raw));
    return round(entry - dist);
  }
  if (atr != null && atr > 0) return round(entry - 2.4 * atr);
  if (tech.fields.support_levels?.length) return round(Math.min(...tech.fields.support_levels) * 0.995);
  return null;
}

/** Real overhead resistance above `entry`, nearest first (deduped). */
export function overheadResistance(tech: TechLane, entry: number): ResistanceLevel[] {
  const f = tech.fields;
  const out: ResistanceLevel[] = [];
  const swing = Array.isArray(f.resistance_swing) ? f.resistance_swing : null;
  for (const r of swing ?? f.resistance_levels ?? []) {
    if (typeof r === "number" && Number.isFinite(r)) out.push({ price: r, source: swing ? "swing high" : "listed resistance" });
  }
  const h20 = numOrNull(f.high_20d);
  const h50 = numOrNull(f.high_50d);
  if (h20 != null) out.push({ price: h20, source: "20-day high" });
  if (h50 != null) out.push({ price: h50, source: "50-day high" });
  const seen = new Set<number>();
  return out
    .filter((r) => r.price > entry)
    .sort((a, b) => a.price - b.price)
    .filter((r) => (seen.has(r.price) ? false : (seen.add(r.price), true)));
}

export function deriveLevels(tech: TechLane, policy: LevelPolicy = CURRENT_LEVEL_POLICY): LevelPlan {
  const cmp = numOrNull(tech.fields.cmp);
  const atr = numOrNull(tech.fields.atr_14);
  if (cmp == null) return { entry: null, sl: null, targets: [] };

  const entry = cmp;
  const sl = stopFor(tech, entry, policy);

  if (policy === "atr_v2") {
    const targets: number[] = [];
    if (atr != null && atr > 0) {
      targets.push(round(entry + 2 * atr));
      targets.push(round(entry + 3.5 * atr));
    }
    return { entry, sl, targets };
  }

  if (sl == null || !(entry - sl > 0)) return { entry, sl, targets: [] };
  const R = entry - sl;
  const floor1 = ceil2(entry + RR_T1_MIN * R);
  const floor2 = ceil2(entry + RR_T2_MIN * R);
  const maxT2 = entry + 3 * R;
  const res = overheadResistance(tech, entry);

  const capRes = res.find((r) => r.price < floor1) || null;
  const t1Res = res.find((r) => r.price >= floor1 && r.price < floor2);
  const t1 = t1Res ? t1Res.price : floor1;
  const t2Res = res.find((r) => r.price >= floor2 && r.price <= maxT2);
  const t2 = t2Res ? t2Res.price : floor2;
  const cap = capRes ? { ...capRes, rr: round((capRes.price - entry) / R, 2) } : null;
  return {
    entry,
    sl,
    // A capped setup is reported honestly: T1 = the resistance that caps it (R:R < 1).
    targets: cap ? [cap.price, t2] : [t1, t2],
    risk: round(R),
    t1_basis: cap ? `capped by ${cap.source}` : t1Res ? t1Res.source : "1R floor",
    t2_basis: t2Res ? t2Res.source : "1.8R floor",
    cap,
  };
}

function buyBias(tech: TechLane): {
  favorBuy: boolean;
  holdAvoid: boolean;
  exceptionalTape: boolean;
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

  const exceptionalTape =
    isBreakout &&
    pvd === "above" &&
    rsi != null &&
    rsi >= 55 &&
    rsi <= 70;

  if (isBreakdown || belowLhLl) {
    return {
      favorBuy: false,
      holdAvoid: true,
      exceptionalTape: false,
      reasons: [
        isBreakdown
          ? "Tape: breakdown — no fresh long"
          : "Tape: below all DMAs + LH_LL — hold/avoid",
      ],
      flags: isBreakdown ? ["breakdown"] : ["below_dma_lh_ll"],
    };
  }

  // Soft constructive: mixed/above DMAs + mid RSI, not LH_LL — enables multi-sector buys
  const softConstructive =
    !isBreakdown &&
    structure !== "LH_LL" &&
    (pvd === "above" || pvd === "mixed") &&
    rsi != null &&
    rsi >= 48 &&
    rsi <= 62;

  let favorBuy = isBreakout || isHhHl || softConstructive;

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
  } else if (softConstructive) {
    reasons.push(
      `Tape: constructive (structure=${structure}, price_vs_dma=${pvd}, RSI~${Math.round(
        rsi!
      )}) — multi-sector soft long`
    );
  } else {
    reasons.push(
      `Tape: structure=${structure}, breakout=${brk}, price_vs_dma=${pvd}`
    );
  }

  if (cmp != null && (cmp < 50 || isPennyWatch(tech.ticker))) {
    if (!exceptionalTape) {
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
    const near = f.resistance_levels.filter(
      (r) => r <= cmp * 1.03 && r >= cmp
    );
    if (near.length) {
      flags.push(
        `Listed resistance tight (${near.join("–")}) — scale / ATR extension`
      );
    }
  }

  return { favorBuy, holdAvoid: false, exceptionalTape, reasons, flags };
}

function strField(
  fields: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!fields) return null;
  const v = fields[key];
  return typeof v === "string" ? v : null;
}

/**
 * True when funda_quality=fail comes only from missing data (Screener blocked /
 * not fetched: no PE, ROE or D/E at all) rather than from a real red flag.
 */
export function isFundaDataGap(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;
  if (strField(fields, "funda_quality") !== "fail") return false;
  const rf = Array.isArray(fields.red_flags) ? fields.red_flags.map(String) : [];
  if (!rf.some((x) => /Heavy unknowns|No live funda/i.test(x))) return false;
  return !["pe_ttm", "roe_pct", "debt_equity"].some((k) => typeof fields[k] === "number");
}

function applyFundaNewsGates(
  funda: LaneStub | null | undefined,
  news: LaneStub | null | undefined,
  favorBuy: boolean,
  exceptionalTape: boolean,
  reasons: string[],
  risk_flags: string[],
  fundaGap: "avoid" | "unknown" = "unknown"
): { favorBuy: boolean; forceAvoid: boolean; holdLean: boolean; fundaUnknown: boolean } {
  let buy = favorBuy;
  let forceAvoid = false;
  let holdLean = false;
  let fundaUnknown = false;

  const ff = funda?.fields;
  const quality = strField(ff, "funda_quality");

  if (fundaGap === "unknown" && (funda == null || isFundaDataGap(ff))) {
    // A data failure is not a thesis: PE/ROE/D-E are UNKNOWN (shown as such),
    // the tape decides, and confidence is capped one notch below a verified name.
    fundaUnknown = true;
    risk_flags.push("funda_unknown");
    reasons.push(
      funda == null
        ? "Funda: not fetched — UNKNOWN; confidence capped"
        : "Funda: UNKNOWN (PE/ROE/D-E unavailable) — not verified; confidence capped"
    );
  } else if (quality === "fail") {
    risk_flags.push("funda_quality=fail");
    if (exceptionalTape) {
      holdLean = true;
      buy = false;
      reasons.push(
        "Funda: quality=fail — exceptional tape only; hold-lean / no chase"
      );
    } else {
      forceAvoid = true;
      buy = false;
      reasons.push("Funda: quality=fail — avoid/hold unless tape exceptional");
    }
  } else if (quality === "watch") {
    risk_flags.push("funda_quality=watch");
    reasons.push("Funda: quality=watch — size/confidence capped");
  } else if (quality === "pass") {
    risk_flags.push("funda_quality=pass");
    const pe = typeof ff?.pe_ttm === "number" ? ff.pe_ttm : null;
    const roe = typeof ff?.roe_pct === "number" ? ff.roe_pct : null;
    const bits = [
      pe != null ? `PE~${pe}` : null,
      roe != null ? `ROE~${roe}` : null,
    ].filter(Boolean);
    reasons.push(
      bits.length
        ? `Funda: quality=pass (${bits.join(", ")})`
        : "Funda: quality=pass"
    );
  } else if (funda?.unknowns?.length) {
    risk_flags.push("funda_thin");
  }

  const red = fundaUnknown ? null : ff?.red_flags;
  if (Array.isArray(red)) {
    for (const r of red.slice(0, 3)) {
      if (typeof r === "string") risk_flags.push(r);
    }
  }

  const nf = news?.fields;
  const conf = strField(nf, "confirmation_status");
  const strength = strField(nf, "catalyst_strength");
  const sentiment = strField(nf, "sentiment");
  const why = strField(nf, "why_for_verdict");
  const headline = strField(nf, "headline");

  // Rumored-only strong claims → no chase / hold-lean
  if (conf === "rumored" && (strength === "med" || strength === "high")) {
    buy = false;
    holdLean = true;
    risk_flags.push("news_rumored");
    reasons.push("News: rumored-only strong claim — no chase / hold-lean");
  } else if (conf === "confirmed") {
    reasons.push(
      `News: confirmed${strength ? ` (${strength})` : ""}${
        sentiment ? `, sentiment=${sentiment}` : ""
      }`
    );
  } else if (headline) {
    reasons.push(`News: ${headline.slice(0, 80)}`);
  }

  if (sentiment === "negative" && conf === "confirmed") {
    buy = false;
    holdLean = true;
    risk_flags.push("news_bear_confirmed");
    reasons.push("News: confirmed bearish — hold/avoid");
  }

  if (why) {
    reasons.push(`News why: ${why}`);
  }

  return { favorBuy: buy, forceAvoid, holdLean, fundaUnknown };
}

function buildBuyTrigger(tech: TechLane, entry: number): number | string {
  const tl = tech.fields.trigger_level;
  if (typeof tl === "number") {
    if (tech.fields.breakout_state === "breakout") {
      return `Hold above breakout/trigger ${tl} (CMP~${entry})`;
    }
    return `Reclaim/hold trigger ${tl}; CMP~${entry}`;
  }
  return entry;
}

function buildTimeHorizon(news: LaneStub | null | undefined): string {
  const exp = strField(news?.fields, "catalyst_expiry");
  if (exp === "intraday") return "intraday / 1–2 sessions (catalyst_expiry)";
  if (exp === "days") return "days (catalyst window)";
  return "2–6 weeks (swing)";
}

export interface MergeOpts {
  budget_inr?: number;
  risk_pct?: number;
  funda?: LaneStub | null;
  news?: LaneStub | null;
  /**
   * How to treat funda that is missing (Screener blocked / not fetched).
   * "avoid" (legacy default): funda_quality=fail → avoid unless tape exceptional.
   * "unknown" (report_v2+, /lookup, /budget-picks — default): funda shown as
   * UNKNOWN (flag funda_unknown), tape decides, confidence −1.
   */
  fundaGap?: "avoid" | "unknown";
  /** Level policy (default rr_floor_v3). Stored v1/v2 reports pass "atr_v2". */
  levels?: LevelPolicy;
}

/**
 * Merge live tech (+ optional funda/news) into a Verdict with plan fields.
 * Gates: rumored-only strong → hold-lean; funda_quality=fail → avoid/hold
 * unless tape exceptional; fold why_for_verdict; time_horizon from catalyst_expiry.
 */
export function mergeVerdict(tech: TechLane, opts: MergeOpts = {}): Verdict {
  const budget_inr = opts.budget_inr ?? 10000;
  const risk_pct = opts.risk_pct ?? 1;
  const cmp = numOrNull(tech.fields.cmp);
  const policy = opts.levels ?? CURRENT_LEVEL_POLICY;
  const plan = deriveLevels(tech, policy);
  const { entry, sl, targets } = plan;
  const bias = buyBias(tech);
  const sector =
    strField(opts.funda?.fields, "sector") || sectorOf(tech.ticker);
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

  const gated = applyFundaNewsGates(
    opts.funda,
    opts.news,
    bias.favorBuy,
    bias.exceptionalTape,
    reasons,
    risk_flags,
    opts.fundaGap ?? "unknown"
  );

  const sized = sizePosition({ budget_inr, risk_pct, entry, sl });

  if (gated.forceAvoid) {
    action = "avoid";
    confidence = 5;
  } else if (bias.holdAvoid) {
    action = risk_flags.includes("breakdown") ? "avoid" : "hold";
    confidence = 5;
  } else if (gated.holdLean) {
    action = "hold";
    confidence = 5;
  } else if (gated.favorBuy && sized.ok) {
    action = "buy";
    confidence = 6;
    if (tech.fields.breakout_state === "breakout") confidence += 1;
    if (tech.fields.price_vs_dma === "above") confidence += 1;
    if (strField(opts.funda?.fields, "funda_quality") === "pass") {
      confidence += 1;
    }
    if (strField(opts.funda?.fields, "funda_quality") === "watch" || gated.fundaUnknown) {
      confidence -= 1;
    }
    // P0b: sector preference neutralized — no score/reason boost
    void preferred;
    confidence = Math.max(1, Math.min(9, confidence));
  } else if (gated.favorBuy && !sized.ok) {
    action = "hold";
    confidence = 5;
    risk_flags.push(`size_blocked:${sized.reason}`);
    reasons.push(`Tape favors long but size blocked (${sized.reason})`);
  } else {
    action = "hold";
    confidence = 4;
  }

  // risk_v3: never a buy whose T1 R:R is below 1 — real resistance under entry + 1R caps it.
  if (policy === "rr_floor_v3" && plan.cap) {
    risk_flags.push("rr_below_1r");
    if (action === "buy") {
      action = "hold";
      confidence = 5;
      reasons.unshift(
        `Resistance at ₹${plan.cap.price} (${plan.cap.source}) caps upside below 1R (${plan.cap.rr}R to it) — no paper buy`
      );
    }
  }

  let r_r: number | null = null;
  if (targets.length) {
    const risk = entry - sl;
    const reward = targets[0] - entry;
    if (risk > 0) r_r = round(reward / risk, 2);
  }
  if (policy === "rr_floor_v3" && action === "buy" && !(r_r != null && r_r >= RR_T1_MIN)) {
    // Defensive: the floor makes this unreachable; never ship a sub-1R buy.
    action = "hold";
    confidence = 5;
    reasons.unshift(`T1 R:R ${r_r ?? "UNKNOWN"} is below 1R — no paper buy`);
  }
  const v3 =
    policy === "rr_floor_v3"
      ? {
          level_method: "rr_floor_v3",
          risk_per_share: plan.risk ?? null,
          rr_t1: rrOf(entry, sl, targets[0]),
          rr_t2: rrOf(entry, sl, targets[1]),
          rr_plain: rrPlain(entry, sl, targets[0], targets[1]),
          t1_basis: plan.t1_basis ?? null,
          t2_basis: plan.t2_basis ?? null,
          resistance_cap: plan.cap ?? null,
          rr_rule: `T1 ≥ ${RR_T1_MIN}R, T2 ≥ ${RR_T2_MIN}R (R = entry − SL); resistance under 1R blocks a buy`,
        }
      : {};

  const shares = action === "buy" && sized.ok ? sized.shares : null;
  const size_inr = action === "buy" && sized.ok ? sized.size_inr : null;

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
    buy_trigger: buildBuyTrigger(tech, entry),
    sell_targets: targets,
    stop_invalidation: sl,
    time_horizon: buildTimeHorizon(opts.news),
    live: true,
    yahoo_symbol: tech.yahoo_symbol,
    ...(gated.fundaUnknown ? { funda_unknown: true } : {}),
    ...v3,
  };
}

/** Score for ranking budget picks (higher = better). */
export function pickScore(v: Verdict): number {
  let s = (v.confidence_1_10 || 0) * 10;
  if (v.action === "buy") s += 100;
  // P0b: no preferred-sector +15 — rank on tape/funda/R:R only
  void isPreferredSector;
  if (v.penny_under_50) s -= 40;
  if (v.r_r != null) s += v.r_r * 5;
  if (v.under_1000) s += 5;
  if (v.risk_flags?.includes("funda_quality=pass")) s += 8;
  if (v.risk_flags?.includes("funda_quality=fail")) s -= 50;
  if (v.risk_flags?.includes("news_rumored")) s -= 20;
  return s;
}
