/** Yahoo Finance chart + quoteSummary for NSE symbols (SYMBOL.NS). Never invent prices. */

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

export interface YahooRawValue {
  raw?: number | null;
  fmt?: string | null;
}

export interface YahooQuoteSummary {
  symbol: string;
  trailingPE: number | null;
  forwardPE: number | null;
  returnOnEquity: number | null; // decimal from Yahoo (0.15 = 15%)
  debtToEquity: number | null; // Yahoo often % (11.6 = 0.116 ratio)
  debtToEquityFmt: string | null;
  profitMargins: number | null; // decimal
  marketCap: number | null;
  priceToBook: number | null;
  sector: string | null;
  industry: string | null;
  longName: string | null;
  source: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

type CrumbState = {
  crumb: string;
  cookie: string;
  fetchedAt: number;
};

let crumbState: CrumbState | null = null;
const CRUMB_TTL_MS = 30 * 60 * 1000;

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

function parseSetCookie(headers: Headers, existing: string): string {
  const bag = new Map<string, string>();
  for (const part of existing.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k && rest.length) bag.set(k, rest.join("="));
  }
  // Node fetch may expose getSetCookie()
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const lines =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : [];
  const single = headers.get("set-cookie");
  const all = lines.length ? lines : single ? [single] : [];
  for (const line of all) {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) {
      bag.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  return [...bag.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function ensureCrumb(force = false): Promise<CrumbState | null> {
  if (
    !force &&
    crumbState &&
    Date.now() - crumbState.fetchedAt < CRUMB_TTL_MS
  ) {
    return crumbState;
  }

  try {
    let cookie = crumbState?.cookie || "";
    const quoteRes = await fetch("https://finance.yahoo.com/quote/RELIANCE.NS", {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: "follow",
      cache: "no-store",
    });
    cookie = parseSetCookie(quoteRes.headers, cookie);
    const html = await quoteRes.text();
    const crumbMatch = html.match(/"crumb"\s*:\s*"([^"]+)"/);
    if (crumbMatch?.[1]) {
      crumbState = {
        crumb: crumbMatch[1],
        cookie,
        fetchedAt: Date.now(),
      };
      return crumbState;
    }

    // Fallback: getcrumb endpoint
    const crumbRes = await fetch(
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: {
          "User-Agent": UA,
          Accept: "text/plain",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        cache: "no-store",
      }
    );
    cookie = parseSetCookie(crumbRes.headers, cookie);
    const crumbText = (await crumbRes.text()).trim();
    if (
      crumbText &&
      !crumbText.toLowerCase().includes("too many") &&
      crumbText.length < 80
    ) {
      crumbState = { crumb: crumbText, cookie, fetchedAt: Date.now() };
      return crumbState;
    }
  } catch {
    /* leave null */
  }
  return crumbState;
}

function rawNum(v: YahooRawValue | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  const r = v.raw;
  if (r == null || !Number.isFinite(r)) return null;
  return r;
}

export async function fetchYahooQuoteSummary(
  yahooSymbol: string
): Promise<YahooQuoteSummary | null> {
  const auth = await ensureCrumb();
  if (!auth) return null;

  const modules = [
    "financialData",
    "defaultKeyStatistics",
    "summaryDetail",
    "assetProfile",
    "incomeStatementHistory",
  ].join(",");

  const buildUrl = (crumb: string) =>
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      yahooSymbol
    )}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;

  const tryFetch = async (state: CrumbState) => {
    const res = await fetch(buildUrl(state.crumb), {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: state.cookie,
      },
      cache: "no-store",
    });
    return res;
  };

  let res = await tryFetch(auth);
  if (res.status === 401 || res.status === 403) {
    const refreshed = await ensureCrumb(true);
    if (!refreshed) return null;
    res = await tryFetch(refreshed);
  }
  if (!res.ok) return null;

  const data = (await res.json()) as {
    quoteSummary?: {
      result?: Array<{
        assetProfile?: { sector?: string; industry?: string };
        summaryDetail?: Record<string, YahooRawValue | unknown>;
        defaultKeyStatistics?: Record<string, YahooRawValue | unknown>;
        financialData?: Record<string, YahooRawValue | unknown>;
        price?: { longName?: string; shortName?: string };
      }>;
      error?: unknown;
    };
    finance?: { error?: unknown };
  };

  const result = data.quoteSummary?.result?.[0];
  if (!result) return null;

  const sd = result.summaryDetail || {};
  const ks = result.defaultKeyStatistics || {};
  const fd = result.financialData || {};
  const ap = result.assetProfile || {};

  const debtVal = fd.debtToEquity as YahooRawValue | undefined;

  return {
    symbol: yahooSymbol,
    trailingPE: rawNum(sd.trailingPE as YahooRawValue),
    forwardPE: rawNum(sd.forwardPE as YahooRawValue),
    returnOnEquity: rawNum(fd.returnOnEquity as YahooRawValue),
    debtToEquity: rawNum(debtVal),
    debtToEquityFmt: debtVal?.fmt ?? null,
    profitMargins:
      rawNum(fd.profitMargins as YahooRawValue) ??
      rawNum(ks.profitMargins as YahooRawValue),
    marketCap: rawNum(sd.marketCap as YahooRawValue),
    priceToBook:
      rawNum(ks.priceToBook as YahooRawValue) ??
      rawNum(sd.priceToBook as YahooRawValue),
    sector: ap.sector ?? null,
    industry: ap.industry ?? null,
    longName: null,
    source: `yahoo:quoteSummary:${yahooSymbol}`,
  };
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
