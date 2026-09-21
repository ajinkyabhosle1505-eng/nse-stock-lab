/** P1a — plain-language helpers for tape jargon. */

const STRUCTURE: Record<string, string> = {
  HH_HL: "Price making higher highs and higher lows (uptrend)",
  LH_LL: "Price making lower highs and lower lows (downtrend)",
  MIXED: "Mixed swing structure — no clean trend",
  UNKNOWN: "Structure unknown",
};

const BREAKOUT: Record<string, string> = {
  breakout: "Broke above a recent ceiling — momentum up",
  breakdown: "Broke below a recent floor — momentum down",
  none: "No fresh breakout or breakdown",
  range: "Still chopping in a range",
  UNKNOWN: "Breakout state unknown",
};

const VS_DMA: Record<string, string> = {
  above: "Trading above key moving averages (supportive)",
  below: "Trading below key moving averages (weak)",
  mixed: "Mixed vs moving averages",
  UNKNOWN: "Vs averages unknown",
};

export function plainStructure(s: string | null | undefined): string {
  if (!s) return "—";
  return STRUCTURE[s] || s;
}

export function plainBreakout(s: string | null | undefined): string {
  if (!s) return "—";
  return BREAKOUT[s] || s;
}

export function plainVsDma(s: string | null | undefined): string {
  if (!s) return "—";
  return VS_DMA[s] || s;
}

/** Soften a single reason line for display. */
export function plainReason(raw: string): string {
  let t = raw;
  t = t.replace(/\bHH_HL\b/g, "higher-highs / higher-lows uptrend");
  t = t.replace(/\bLH_LL\b/g, "lower-highs / lower-lows downtrend");
  t = t.replace(/\bprice_vs_dma=above\b/g, "price above moving averages");
  t = t.replace(/\bprice_vs_dma=below\b/g, "price below moving averages");
  t = t.replace(/\bprice_vs_dma=mixed\b/g, "price mixed vs moving averages");
  t = t.replace(/\bbreakout_state=breakout\b/gi, "breakout");
  t = t.replace(/\bbreakout_state=breakdown\b/gi, "breakdown");
  t = t.replace(/\bDMA(s)?\b/g, "moving average$1");
  t = t.replace(/\bRSI~?/gi, "momentum RSI~");
  t = t.replace(/\bTape:\s*/i, "");
  t = t.replace(/\bFunda:\s*/i, "Fundamentals: ");
  t = t.replace(/\bNews:\s*/i, "News: ");
  return t;
}

export function plainAction(action: string): string {
  const a = (action || "").toLowerCase();
  if (a === "buy") return "Paper buy — plan only, not advice";
  if (a === "hold") return "Hold / wait — no fresh paper buy";
  if (a === "avoid") return "Avoid — skip fresh paper long";
  return action;
}

function fmtInrPlain(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
}

export type PlainPlanInput = {
  buy_trigger?: number | string | null;
  entry?: number | null;
  sell_targets?: number[] | null;
  targets?: number[] | null;
  stop_invalidation?: number | null;
  sl?: number | null;
  time_horizon?: string | null;
};

/** P1a — plain CTA lines from verdict plan fields. */
export function plainPlanLines(plan: PlainPlanInput): string[] {
  const lines: string[] = [];

  const buyRaw = plan.buy_trigger ?? plan.entry;
  if (buyRaw == null || buyRaw === "") {
    lines.push("Buy near: UNKNOWN");
  } else if (typeof buyRaw === "string") {
    lines.push(`Buy near ${buyRaw}`);
  } else if (Number.isFinite(buyRaw)) {
    lines.push(`Buy near ${fmtInrPlain(buyRaw)}`);
  } else {
    lines.push("Buy near: UNKNOWN");
  }

  const sells =
    plan.sell_targets && plan.sell_targets.length
      ? plan.sell_targets
      : plan.targets && plan.targets.length
        ? plan.targets
        : null;
  if (sells && sells.length) {
    const near =
      sells.length === 1
        ? fmtInrPlain(sells[0])
        : sells.map((t) => fmtInrPlain(t)).join(" / ");
    lines.push(`Take profit near ${near}`);
  } else {
    lines.push("Take profit near: UNKNOWN");
  }

  const stop = plan.stop_invalidation ?? plan.sl;
  if (stop != null && Number.isFinite(stop)) {
    lines.push(`Exit if closes below ${fmtInrPlain(stop)}`);
  } else {
    lines.push("Exit if closes below: UNKNOWN");
  }

  const horizon = (plan.time_horizon || "").trim();
  if (horizon) {
    // Soften "2–6 weeks (swing)" → "Hold about 2–6 weeks"
    const weeks = horizon.replace(/\s*\(swing\)\s*/i, "").trim();
    if (/^hold\b/i.test(weeks)) {
      lines.push(weeks);
    } else if (/week/i.test(weeks)) {
      lines.push(`Hold about ${weeks}`);
    } else {
      lines.push(`Hold about ${weeks}`);
    }
  } else {
    lines.push("Hold about: UNKNOWN");
  }

  return lines;
}

