import type { Bar, YahooHistory } from "./yahoo";
import type { TechFields, TechLane } from "./types";

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Wilder RSI */
function rsiWilder(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder ATR */
function atrWilder(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function findSwingPivots(
  bars: Bar[],
  left = 2,
  right = 2
): { highs: { i: number; price: number }[]; lows: { i: number; price: number }[] } {
  const highs: { i: number; price: number }[] = [];
  const lows: { i: number; price: number }[] = [];
  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) highs.push({ i, price: bars[i].high });
    if (isLow) lows.push({ i, price: bars[i].low });
  }
  return { highs, lows };
}

function structureFromPivots(
  highs: { i: number; price: number }[],
  lows: { i: number; price: number }[]
): string {
  const recentH = highs.slice(-3);
  const recentL = lows.slice(-3);
  if (recentH.length < 2 || recentL.length < 2) return "unclear";

  const hh =
    recentH[recentH.length - 1].price > recentH[recentH.length - 2].price;
  const hl =
    recentL[recentL.length - 1].price > recentL[recentL.length - 2].price;
  const lh =
    recentH[recentH.length - 1].price < recentH[recentH.length - 2].price;
  const ll =
    recentL[recentL.length - 1].price < recentL[recentL.length - 2].price;

  if (hh && hl) return "HH_HL";
  if (lh && ll) return "LH_LL";
  return "unclear";
}

function breakoutState(
  bars: Bar[],
  lookback = 20
): { state: string; level: number | null } {
  if (bars.length < lookback + 2) return { state: "none", level: null };
  const prior = bars.slice(-(lookback + 1), -1);
  const last = bars[bars.length - 1];
  const high = Math.max(...prior.map((b) => b.high));
  const low = Math.min(...prior.map((b) => b.low));
  if (last.close > high) return { state: "breakout", level: round(high) };
  if (last.close < low) return { state: "breakdown", level: round(low) };
  return { state: "none", level: null };
}

function nearbyLevels(
  pivots: { price: number }[],
  cmp: number,
  side: "support" | "resistance",
  max = 2
): number[] {
  const filtered =
    side === "support"
      ? pivots.filter((p) => p.price < cmp * 0.999).sort((a, b) => b.price - a.price)
      : pivots.filter((p) => p.price > cmp * 1.001).sort((a, b) => a.price - b.price);

  const out: number[] = [];
  for (const p of filtered) {
    const r = round(p.price);
    if (!out.includes(r)) out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

function priceVsDma(
  cmp: number,
  d20: number | null,
  d50: number | null,
  d200: number | null
): string {
  const dmas = [d20, d50, d200].filter((x): x is number => x != null);
  if (dmas.length === 0) return "UNKNOWN";
  const above = dmas.every((d) => cmp > d);
  const below = dmas.every((d) => cmp < d);
  if (above) return "above";
  if (below) return "below";
  return "mixed";
}

function priceBucket(cmp: number): string {
  if (cmp < 50) return "penny_under_50";
  if (cmp < 1000) return "under_1000";
  return "over_1000";
}

/**
 * Build tech lane from Yahoo history. Marks UNKNOWN when a field cannot be computed.
 * Never invents prices.
 */
export function computeTech(
  ticker: string,
  yahoo: YahooHistory
): TechLane {
  const bars = yahoo.bars;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);

  const cmpRaw =
    yahoo.regularMarketPrice != null
      ? yahoo.regularMarketPrice
      : closes[closes.length - 1];
  const cmp = round(cmpRaw);

  const dma20 = sma(closes, 20);
  const dma50 = sma(closes, 50);
  const dma200 = sma(closes, 200);
  const atr = atrWilder(bars, 14);
  const rsi = rsiWilder(closes, 14);

  const { highs, lows } = findSwingPivots(bars);
  const structure = structureFromPivots(highs, lows);
  const brk = breakoutState(bars, 20);

  const support = nearbyLevels(lows, cmp, "support", 2);
  const resistance = nearbyLevels(highs, cmp, "resistance", 2);

  // fallback supports/resistances from recent range
  if (support.length === 0 && bars.length >= 20) {
    const recent = bars.slice(-20);
    support.push(round(Math.min(...recent.map((b) => b.low))));
  }
  if (resistance.length === 0 && bars.length >= 20) {
    const recent = bars.slice(-20);
    resistance.push(round(Math.max(...recent.map((b) => b.high))));
  }

  let volRatio: number | "UNKNOWN" = "UNKNOWN";
  if (volumes.length >= 21) {
    const avg20 =
      volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    if (avg20 > 0) volRatio = round(volumes[volumes.length - 1] / avg20, 2);
  }

  const unknowns: string[] = [];
  const closes_30d = closes.slice(-30).map((c) => round(c));

  const fields: TechFields = {
    cmp,
    atr_14: atr != null ? round(atr) : "UNKNOWN",
    support_levels: support,
    resistance_levels: resistance,
    structure,
    breakout_state: brk.state,
    rsi_14: rsi != null ? round(rsi) : "UNKNOWN",
    price_vs_dma: priceVsDma(cmp, dma20, dma50, dma200),
    dma_20: dma20 != null ? round(dma20) : "UNKNOWN",
    dma_50: dma50 != null ? round(dma50) : "UNKNOWN",
    dma_200: dma200 != null ? round(dma200) : "UNKNOWN",
    volume_vs_avg_20d: volRatio,
    price_bucket: priceBucket(cmp),
    timeframe: "1D",
    closes_30d,
  };

  if (brk.level != null) {
    fields.breakout_level = brk.level;
  } else {
    unknowns.push("breakout_level");
  }

  // trigger_level: active breakout hold level, else dma_20 reclaim
  if (brk.state === "breakout" && brk.level != null) {
    fields.trigger_level = brk.level;
  } else if (dma20 != null) {
    fields.trigger_level = round(dma20);
  } else {
    fields.trigger_level = "UNKNOWN";
    unknowns.push("trigger_level");
  }

  if (fields.atr_14 === "UNKNOWN") unknowns.push("atr_14");
  if (fields.rsi_14 === "UNKNOWN") unknowns.push("rsi_14");
  if (fields.dma_20 === "UNKNOWN") unknowns.push("dma_20");
  if (fields.dma_50 === "UNKNOWN") unknowns.push("dma_50");
  if (fields.dma_200 === "UNKNOWN") unknowns.push("dma_200");
  if (volRatio === "UNKNOWN") unknowns.push("volume_vs_avg_20d");

  const ts = new Date().toISOString();

  return {
    ticker: ticker.toUpperCase(),
    yahoo_symbol: yahoo.symbol,
    fields,
    unknowns,
    sources: [yahoo.source],
    ts,
  };
}

/** Empty tech stub when Yahoo fails — every price field UNKNOWN. */
export function unknownTech(ticker: string, yahooSymbol: string): TechLane {
  return {
    ticker: ticker.toUpperCase(),
    yahoo_symbol: yahooSymbol,
    fields: {
      cmp: "UNKNOWN",
      atr_14: "UNKNOWN",
      support_levels: [],
      resistance_levels: [],
      structure: "UNKNOWN",
      breakout_state: "UNKNOWN",
      trigger_level: "UNKNOWN",
      rsi_14: "UNKNOWN",
      price_vs_dma: "UNKNOWN",
      dma_20: "UNKNOWN",
      dma_50: "UNKNOWN",
      dma_200: "UNKNOWN",
      volume_vs_avg_20d: "UNKNOWN",
      price_bucket: "UNKNOWN",
      timeframe: "1D",
    },
    unknowns: [
      "cmp",
      "atr_14",
      "support_levels",
      "resistance_levels",
      "structure",
      "breakout_state",
      "trigger_level",
      "rsi_14",
      "price_vs_dma",
      "dma_20",
      "dma_50",
      "dma_200",
    ],
    sources: [],
    ts: new Date().toISOString(),
  };
}

export function numOrNull(v: number | "UNKNOWN" | null | undefined): number | null {
  if (v == null || v === "UNKNOWN") return null;
  return Number.isFinite(v) ? v : null;
}
