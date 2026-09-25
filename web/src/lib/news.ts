/** Live news lane from Yahoo RSS / Google News RSS. Never invent deal values. */

import type { LaneResult } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const NAMED_WIRES = [
  "reuters",
  "bloomberg",
  "pti",
  "ani",
  "associated press",
  "the hindu",
  "hindu businessline",
  "businessline",
  "economic times",
  "business standard",
  "livemint",
  "mint",
  "financial express",
  "moneycontrol",
  "ndtv profit",
  "cnbctv18",
  "zee business",
  "bse india",
  "nse india",
];

export type CatalystExpiry = "intraday" | "days" | null;

export interface NewsItem {
  headline: string;
  summary: string;
  sentiment: "positive" | "negative" | "mixed" | "neutral";
  confirmation_status: "confirmed" | "rumored";
  catalyst_strength: "med" | "low";
  why_for_verdict: string;
  impact_horizon: "near_term" | "medium" | "unclear";
  catalyst_expiry: CatalystExpiry;
  source?: string | null;
  link?: string | null;
  pubDate?: string | null;
}

export interface NewsLane extends LaneResult {
  ticker: string;
  fields: Record<string, unknown>;
  unknowns: string[];
  sources: string[];
  note: string;
  ts: string;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(s: string): string {
  return decodeXml(s);
}

function isNamedWire(text: string): boolean {
  const t = text.toLowerCase();
  return NAMED_WIRES.some((w) => t.includes(w));
}

function sentimentFromTitle(title: string): NewsItem["sentiment"] {
  const t = title.toLowerCase();
  const pos =
    /(surge|rally|gain|rises?|jump|profit|upgrade|beat|growth|wins?|record|buyback|dividend|allot)/.test(
      t
    );
  const neg =
    /(fall|falls|drop|slump|loss|probe|scam|fraud|strike|downgrade|cut|miss|weak|pledge|encumbrance|avoid|ban)/.test(
      t
    );
  if (pos && neg) return "mixed";
  if (pos) return "positive";
  if (neg) return "negative";
  return "neutral";
}

function catalystExpiry(title: string, summary: string): CatalystExpiry {
  const t = `${title} ${summary}`.toLowerCase();
  if (
    /(intraday|today'?s session|during the session|hits? (upper|lower) circuit|falls?\s+\d+%|rises?\s+\d+%)/.test(
      t
    )
  ) {
    return "intraday";
  }
  if (
    /(ex-dividend|this week|next week|deadline|strike|board meeting|within days|by month-end|auction|ipo window)/.test(
      t
    )
  ) {
    return "days";
  }
  return null;
}

function catalystStrength(
  title: string,
  confirmation: "confirmed" | "rumored"
): "med" | "low" {
  const t = title.toLowerCase();
  const material =
    /(deal|merger|acquisition|ncd|bond|ipo|stake sale|dividend|earnings|profit|rating|strike|ban|probe)/.test(
      t
    );
  if (material && confirmation === "confirmed") return "med";
  if (material) return "low";
  return "low";
}

function impactHorizon(expiry: CatalystExpiry): NewsItem["impact_horizon"] {
  if (expiry === "intraday") return "near_term";
  if (expiry === "days") return "near_term";
  return "unclear";
}

function parseRssItems(xml: string): Array<{
  title: string;
  description: string;
  link: string | null;
  pubDate: string | null;
  source: string | null;
}> {
  const out: Array<{
    title: string;
    description: string;
    link: string | null;
    pubDate: string | null;
    source: string | null;
  }> = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    if (!title) continue;
    const description =
      block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || "";
    const link = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || null;
    const pubDate =
      block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || null;
    const source =
      block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] || null;
    // Google often encodes source as "Title - Outlet"
    let src = source ? stripHtml(source) : null;
    const cleanTitle = stripHtml(title);
    if (!src) {
      const dash = cleanTitle.match(/\s[-–—]\s([^)+]+)$/);
      if (dash) src = dash[1].trim();
    }
    out.push({
      title: cleanTitle,
      description: stripHtml(description).slice(0, 600),
      link: link ? stripHtml(link) : null,
      pubDate: pubDate ? stripHtml(pubDate) : null,
      source: src,
    });
  }
  return out;
}

function toNewsItem(raw: {
  title: string;
  description: string;
  link: string | null;
  pubDate: string | null;
  source: string | null;
}): NewsItem {
  const blob = `${raw.title} ${raw.description} ${raw.source || ""} ${
    raw.link || ""
  }`;
  const confirmation: "confirmed" | "rumored" = isNamedWire(blob)
    ? "confirmed"
    : "rumored";
  const sentiment = sentimentFromTitle(raw.title);
  const expiry = catalystExpiry(raw.title, raw.description);
  const strength = catalystStrength(raw.title, confirmation);
  const why = [
    confirmation === "confirmed" ? "Named-wire / confirmed outlet" : "Rumored / unverified outlet",
    `sentiment=${sentiment}`,
    strength === "med" ? "material headline" : "limited catalyst",
  ].join("; ");

  return {
    headline: raw.title,
    summary: raw.description || raw.title,
    sentiment,
    confirmation_status: confirmation,
    catalyst_strength: strength,
    why_for_verdict: why,
    impact_horizon: impactHorizon(expiry),
    catalyst_expiry: expiry,
    source: raw.source,
    link: raw.link,
    pubDate: raw.pubDate,
  };
}

async function fetchRss(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchLiveNews(
  ticker: string,
  yahooSymbol: string
): Promise<NewsLane> {
  const sources: string[] = [];
  const collected: ReturnType<typeof parseRssItems> = [];

  const yahooUrl = `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(
    yahooSymbol
  )}`;
  const yXml = await fetchRss(yahooUrl);
  if (yXml) {
    const items = parseRssItems(yXml);
    if (items.length) {
      sources.push(yahooUrl);
      for (const it of items) {
        if (!it.source) it.source = "Yahoo Finance";
        collected.push(it);
      }
    }
  }

  if (collected.length < 2) {
    const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
      `NSE ${ticker} stock`
    )}&hl=en-IN&gl=IN&ceid=IN:en`;
    const gXml = await fetchRss(gUrl);
    if (gXml) {
      const items = parseRssItems(gXml);
      if (items.length) {
        sources.push(gUrl);
        collected.push(...items);
      }
    }
  }

  // De-dupe by headline prefix
  const seen = new Set<string>();
  const unique = [];
  for (const it of collected) {
    const key = it.title.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
  }

  const top = unique.slice(0, 3).map(toNewsItem);
  if (!top.length) {
    return {
      ticker,
      fields: {},
      unknowns: [
        "headline",
        "summary",
        "sentiment",
        "confirmation_status",
        "catalyst_strength",
        "why_for_verdict",
        "impact_horizon",
        "catalyst_expiry",
      ],
      sources,
      note: "No live news items from Yahoo/Google RSS",
      ts: new Date().toISOString(),
    };
  }

  const primary = top[0];
  const fields: Record<string, unknown> = {
    headline: primary.headline,
    summary: primary.summary,
    sentiment: primary.sentiment,
    confirmation_status: primary.confirmation_status,
    catalyst_strength: primary.catalyst_strength,
    why_for_verdict: primary.why_for_verdict,
    impact_horizon: primary.impact_horizon,
    catalyst_expiry: primary.catalyst_expiry,
    deal_value_inr: null, // never invent
    items: top,
  };

  return {
    ticker,
    fields,
    unknowns: [],
    sources,
    note: `Live RSS (${sources.length} feed(s)); deal values not invented`,
    ts: new Date().toISOString(),
  };
}

export function unknownNews(ticker: string, note: string): NewsLane {
  return {
    ticker,
    fields: {},
    unknowns: ["headline", "summary", "sentiment", "catalysts"],
    sources: [],
    note,
    ts: new Date().toISOString(),
  };
}

/**
 * Market-level headlines for the daily report (Google News RSS, India/NSE query).
 * Returns [] on failure — never invents items. Headlines are labeled with
 * confirmation_status (named wire vs rumored/unverified outlet).
 */
export async function fetchMarketHeadlines(limit = 5): Promise<{
  items: NewsItem[];
  sources: string[];
  note: string;
}> {
  const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
    "Nifty Sensex stock market India when:1d"
  )}&hl=en-IN&gl=IN&ceid=IN:en`;
  const xml = await fetchRss(gUrl);
  if (!xml) {
    return { items: [], sources: [], note: "Market headlines UNKNOWN — RSS fetch failed" };
  }
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const raw of parseRssItems(xml)) {
    const key = raw.title.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(toNewsItem(raw));
    if (items.length >= limit) break;
  }
  return {
    items,
    sources: [gUrl],
    note: items.length
      ? `Google News RSS (${items.length} item(s)); outlet-labeled, not verified by desk`
      : "No market headlines returned by RSS",
  };
}
