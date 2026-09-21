/** Yahoo Finance chart fetch for NSE symbols (SYMBOL.NS). Never invent prices. */

export interface Bar {
  date: number; // unix sec
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooHistory {
  symbol: string;
  currency: string | null;
  regularMarketPrice: number | null;
  bars: Bar[];
  source: string;
}

const UA =
  "Mozilla/5.0 (compatible; StockLab/0.1; +https://localhost; research)";

/** Normalize user input to NSE Yahoo symbol: PNB → PNB.NS */
export function normalizeNseSymbol(raw: string): {
  ticker: string;
  yahoo: string;
} {
  let s = (raw || "").trim().toUpperCase();
  s = s.replace(/\s+/g, "");
  if (s.endsWith(".BO")) {
    const ticker = s.slice(0, -3);
    return { ticker, yahoo: s };
  }
  if (s.endsWith(".NS")) {
    const ticker = s.slice(0, -3);
    return { ticker, yahoo: s };
  }
  // strip exchange prefixes
  s = s.replace(/^NSE[:/]/, "").replace(/^BSE[:/]/, "");
  return { ticker: s, yahoo: `${s}.NS` };
}

export async function fetchYahooHistory(
  yahooSymbol: string,
  range = "1y",
  interval = "1d"
): Promise<YahooHistory | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
    next: { revalidate: 0 },
    cache: "no-store",
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    chart?: {
      result?: Array<{
        meta?: {
          symbol?: string;
          currency?: string;
          regularMarketPrice?: number;
        };
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
            volume?: (number | null)[];
          }>;
        };
      }>;
      error?: unknown;
    };
  };

  const result = data.chart?.result?.[0];
  if (!result?.timestamp?.length) return null;

  const quote = result.indicators?.quote?.[0];
  if (!quote) return null;

  const bars: Bar[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];
    if (
      o == null ||
      h == null ||
      l == null ||
      c == null ||
      !Number.isFinite(o) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(c)
    ) {
      continue;
    }
    bars.push({
      date: result.timestamp[i],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v != null && Number.isFinite(v) ? v : 0,
    });
  }

  if (bars.length < 30) return null;

  return {
    symbol: result.meta?.symbol || yahooSymbol,
    currency: result.meta?.currency ?? null,
    regularMarketPrice:
      result.meta?.regularMarketPrice != null &&
      Number.isFinite(result.meta.regularMarketPrice)
        ? result.meta.regularMarketPrice
        : null,
    bars,
    source: `yahoo:query1/chart:${yahooSymbol}:${range},${interval}`,
  };
}
