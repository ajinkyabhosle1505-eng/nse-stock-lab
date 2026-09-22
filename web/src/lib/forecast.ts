/**
 * Paper scenario path (ATR) — method atr_piecewise_T1_T2_v1
 * Stock Research brief 2026-09-22. Never invent levels or closes.
 */

import type {
  ForecastBundle,
  ForecastPoint,
  ForecastScoreSummary,
} from "./types";

const METHOD = "atr_piecewise_T1_T2_v1" as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** IST calendar date YYYY-MM-DD for an Instant. */
export function istDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Add calendar days to an IST YYYY-MM-DD (no DST games). */
export function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Noon UTC avoids zone edge cases for IST (+5:30)
  const dt = new Date(Date.UTC(y, m - 1, d, 6, 30, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return istDateString(dt);
}

export function emptyScoreSummary(): ForecastScoreSummary {
  return {
    n_scored: 0,
    mape_pct: null,
    hit_within_1atr_pct: null,
    hit_within_2pct_pct: null,
    hit_within_0_5r_pct: null,
    directional_pct: null,
    by_horizon: [
      { bucket: "le7", n: 0, mape_pct: null, hit_within_1atr_pct: null, directional_pct: null },
      { bucket: "8to21", n: 0, mape_pct: null, hit_within_1atr_pct: null, directional_pct: null },
      { bucket: "ge22", n: 0, mape_pct: null, hit_within_1atr_pct: null, directional_pct: null },
    ],
    touched_t1: null,
    touched_t2: null,
    touched_sl: null,
    lastMarkedAt: null,
  };
}

export interface BuildForecastInput {
  action: string;
  entry: number | null | undefined;
  sl: number | null | undefined;
  targets: number[] | null | undefined;
  atr_14: number | null | undefined;
  checkDays: number[];
  filledAt?: string | Date;
  structure?: string;
  breakout_state?: string;
}

/**
 * Build ForecastBundle once at paper buy.
 * Skip (never invent) if action≠buy or entry/sl/atr/T1 missing.
 */
export function buildForecastBundle(
  input: BuildForecastInput
): ForecastBundle | null {
  const checkDays = [
    ...new Set(
      (input.checkDays || [])
        .map((d) => Math.round(Number(d)))
        .filter((d) => Number.isFinite(d) && d >= 1)
    ),
  ].sort((a, b) => a - b);

  const entry = input.entry;
  const sl = input.sl;
  const atr = input.atr_14;
  const t1 = input.targets?.[0];
  const t2 = input.targets?.[1] ?? t1;

  if (
    String(input.action).toLowerCase() !== "buy" ||
    entry == null ||
    !Number.isFinite(entry) ||
    sl == null ||
    !Number.isFinite(sl) ||
    atr == null ||
    !Number.isFinite(atr) ||
    atr <= 0 ||
    t1 == null ||
    !Number.isFinite(t1) ||
    !checkDays.length
  ) {
    return {
      method: METHOD,
      status: "skipped",
      skip_reason:
        "Forecast skipped — need action=buy and known entry/sl/atr/T1 + checkDays (never invent)",
      createdAt: new Date().toISOString(),
      params: {
        entry: entry ?? 0,
        sl: sl ?? 0,
        t1: t1 ?? 0,
        t2: t2 ?? 0,
        atr_14: atr ?? 0,
        R: entry != null && sl != null ? entry - sl : 0,
        d_T1: 0,
        d_T2: 0,
        scale: 0,
        structure: input.structure,
        breakout_state: input.breakout_state,
      },
      checkDays,
      points: [],
      scoreSummary: emptyScoreSummary(),
    };
  }

  const R = entry - sl;
  if (!(R > 0)) {
    return {
      method: METHOD,
      status: "skipped",
      skip_reason: "Forecast skipped — R=entry−sl must be > 0",
      createdAt: new Date().toISOString(),
      params: {
        entry,
        sl,
        t1,
        t2: t2 ?? t1,
        atr_14: atr,
        R,
        d_T1: 0,
        d_T2: 0,
        scale: 0,
        structure: input.structure,
        breakout_state: input.breakout_state,
      },
      checkDays,
      points: [],
      scoreSummary: emptyScoreSummary(),
    };
  }

  const d_max = Math.max(...checkDays);
  const d_min = Math.min(...checkDays);
  const d_T1 = clamp(Math.round(0.45 * d_max), d_min, d_max);
  const d_T2 = d_max;

  const scale =
    input.breakout_state === "breakout" || input.structure === "HH_HL"
      ? 1.0
      : 0.7;

  const filled =
    input.filledAt instanceof Date
      ? input.filledAt
      : input.filledAt
        ? new Date(input.filledAt)
        : new Date();
  const fillDate = istDateString(filled);

  const points: ForecastPoint[] = checkDays.map((d) => {
    let raw: number;
    if (d <= d_T1) {
      raw = entry + (d / d_T1) * (t1 - entry);
    } else if (d_T2 === d_T1) {
      raw = t1;
    } else {
      raw = t1 + ((d - d_T1) / (d_T2 - d_T1)) * ((t2 ?? t1) - t1);
    }
    let predicted = entry + scale * (raw - entry);
    // Never below entry on buy path v1
    if (predicted < entry) predicted = entry;
    predicted = round2(predicted);

    return {
      dayOffset: d,
      predictedClose: predicted,
      targetDate: addCalendarDays(fillDate, d),
      actualClose: null,
      actualSessionDate: null,
      ape_pct: null,
      within_1atr: null,
      within_2pct: null,
      within_0_5r: null,
      direction_ok: null,
      status: "pending",
      tradingDayIndex: null,
    };
  });

  return {
    method: METHOD,
    status: "ok",
    createdAt: new Date().toISOString(),
    params: {
      entry,
      sl,
      t1,
      t2: t2 ?? t1,
      atr_14: atr,
      R,
      d_T1,
      d_T2,
      scale,
      structure: input.structure,
      breakout_state: input.breakout_state,
    },
    checkDays,
    points,
    scoreSummary: emptyScoreSummary(),
  };
}

function horizonBucket(d: number): "le7" | "8to21" | "ge22" {
  if (d <= 7) return "le7";
  if (d <= 21) return "8to21";
  return "ge22";
}

function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  return round2(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function pctTrue(flags: boolean[]): number | null {
  if (!flags.length) return null;
  return round2((flags.filter(Boolean).length / flags.length) * 100);
}

function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

export interface MarkBar {
  date: string; // YYYY-MM-DD IST
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Mark pending points with Yahoo daily closes.
 * Prefer close on/after targetDate within ±3 calendar days; else sparse.
 */
export function markForecastPoints(
  bundle: ForecastBundle,
  bars: MarkBar[],
  todayIst?: string
): ForecastBundle {
  if (bundle.status === "skipped" || !bundle.points.length) return bundle;

  const today = todayIst || istDateString();
  const { entry, atr_14, R, t1, t2, sl } = bundle.params;
  const atrPctGate = Math.max(1.0, (100 * atr_14) / entry) / 100; // fraction of entry

  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));

  const points = bundle.points.map((p) => {
    if (p.targetDate > today) {
      return { ...p, status: "pending" as const };
    }
    // Find first bar on/after targetDate
    const idx = sorted.findIndex((b) => b.date >= p.targetDate);
    if (idx < 0) {
      return {
        ...p,
        actualClose: null,
        actualSessionDate: null,
        ape_pct: null,
        within_1atr: null,
        within_2pct: null,
        within_0_5r: null,
        direction_ok: null,
        status: "sparse" as const,
      };
    }
    const bar = sorted[idx];
    // Within 3 calendar days of target?
    const targetMs = Date.parse(`${p.targetDate}T00:00:00+05:30`);
    const barMs = Date.parse(`${bar.date}T00:00:00+05:30`);
    const calDiff = Math.round((barMs - targetMs) / 86400000);
    if (calDiff < 0 || calDiff > 3) {
      return {
        ...p,
        actualClose: null,
        actualSessionDate: null,
        status: "sparse" as const,
        ape_pct: null,
        within_1atr: null,
        within_2pct: null,
        within_0_5r: null,
        direction_ok: null,
      };
    }

    // Corporate action suspect: >15% gap vs prior close
    let corporate_action_suspect = false;
    if (idx > 0) {
      const prior = sorted[idx - 1].close;
      if (prior > 0 && Math.abs(bar.close - prior) / prior > 0.15) {
        corporate_action_suspect = true;
      }
    }

    const actual = bar.close;
    const ape =
      actual !== 0 ? round2((Math.abs(actual - p.predictedClose) / actual) * 100) : null;
    const absErr = Math.abs(actual - p.predictedClose);
    const within_1atr = absErr / entry <= atrPctGate;
    const within_2pct = absErr / entry <= 0.02;
    const within_0_5r = absErr <= 0.5 * R;
    const dirPred = sign(p.predictedClose - entry);
    const dirAct = sign(actual - entry);
    const direction_ok =
      dirPred === 0 || dirAct === 0 ? false : dirPred === dirAct;

    return {
      ...p,
      actualClose: actual,
      actualSessionDate: bar.date,
      ape_pct: ape,
      within_1atr,
      within_2pct,
      within_0_5r,
      direction_ok,
      status: "scored" as const,
      tradingDayIndex: idx,
      corporate_action_suspect,
    };
  });

  // Level touch flags from bars spanning fill→max check
  let touched_t1: boolean | null = null;
  let touched_t2: boolean | null = null;
  let touched_sl: boolean | null = null;
  const scoredPts = points.filter((p) => p.status === "scored");
  if (scoredPts.length && sorted.length) {
    touched_t1 = false;
    touched_t2 = false;
    touched_sl = false;
    for (const b of sorted) {
      if (b.low <= t1 && b.high >= t1) touched_t1 = true;
      if (b.low <= t2 && b.high >= t2) touched_t2 = true;
      if (b.low <= sl && b.high >= sl) touched_sl = true;
      if (b.close >= t1) touched_t1 = true;
      if (b.close >= t2) touched_t2 = true;
      if (b.close <= sl) touched_sl = true;
    }
  }

  const scoreSummary = computeScoreSummary(points, {
    touched_t1,
    touched_t2,
    touched_sl,
  });

  return {
    ...bundle,
    points,
    scoreSummary,
  };
}

export function computeScoreSummary(
  points: ForecastPoint[],
  touches?: {
    touched_t1: boolean | null;
    touched_t2: boolean | null;
    touched_sl: boolean | null;
  }
): ForecastScoreSummary {
  const scored = points.filter((p) => p.status === "scored" && p.actualClose != null);
  const apes = scored.map((p) => p.ape_pct!).filter((x) => x != null);
  const w1 = scored.map((p) => !!p.within_1atr);
  const w2 = scored.map((p) => !!p.within_2pct);
  const w05 = scored.map((p) => !!p.within_0_5r);
  const dirs = scored.map((p) => !!p.direction_ok);

  const buckets: ForecastScoreSummary["by_horizon"] = (
    ["le7", "8to21", "ge22"] as const
  ).map((bucket) => {
    const subset = scored.filter((p) => horizonBucket(p.dayOffset) === bucket);
    return {
      bucket,
      n: subset.length,
      mape_pct: mean(
        subset.map((p) => p.ape_pct!).filter((x) => x != null && Number.isFinite(x))
      ),
      hit_within_1atr_pct: pctTrue(subset.map((p) => !!p.within_1atr)),
      directional_pct: pctTrue(subset.map((p) => !!p.direction_ok)),
    };
  });

  return {
    n_scored: scored.length,
    mape_pct: mean(apes),
    hit_within_1atr_pct: pctTrue(w1),
    hit_within_2pct_pct: pctTrue(w2),
    hit_within_0_5r_pct: pctTrue(w05),
    directional_pct: pctTrue(dirs),
    by_horizon: buckets,
    touched_t1: touches?.touched_t1 ?? null,
    touched_t2: touches?.touched_t2 ?? null,
    touched_sl: touches?.touched_sl ?? null,
    lastMarkedAt: scored.length ? new Date().toISOString() : null,
  };
}

/** localStorage key for paper forecast positions. */
export const PAPER_FORECASTS_KEY = "nse-stock-lab-paper-forecasts-v1";

export const DEFAULT_CHECK_DAY_CHIPS = [7, 14, 30] as const;
