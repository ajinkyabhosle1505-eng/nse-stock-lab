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
