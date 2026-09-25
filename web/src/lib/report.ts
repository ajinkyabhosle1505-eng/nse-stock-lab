/**
 * Pre-market daily report generator — ReportV1 (research / PAPER only).
 * Spec: docs/cos-premarket-report-and-server-paper-plan-2026-09-25.md §2.
 *
 * Built from the PRIOR session's settled close (`based_on_close`) for
 * `for_session`. Bars dated after based_on_close (incl. Yahoo's intraday
 * partial bar) are never used. Missing data → `unknowns`, never estimated.
 *
 * Pipeline (fits Vercel Hobby 300 s; typical ~30–60 s):
 *   pass 1  tech: Yahoo chart 1y for every symbol (pool 5, jitter, retries,
 *           429 circuit breaker, soft deadline)
 *   pass 2  funda: screener.in only (no Yahoo crumb in cron) for symbols whose
 *           tape doesn't already fail the gates (pool 3) — saves Screener load
 *   pass 3  news: only the shortlist (buy candidates, avoid candidates, pennies)
 * Sections are a pure function of the stored `inputs` (mergeVerdict), so any
 * report can be recomputed from inputs → same report_hash.
 */

import { fetchYahooChartX, type ChartResult, type YahooHistory } from "./yahoo";
import { computeTech } from "./tech";
import { fetchLiveFunda } from "./funda";
import { fetchLiveNews, fetchMarketHeadlines, type NewsItem } from "./news";
import { mergeVerdict, sizePosition, type LaneStub } from "./risk";
import { diversifiedPickScore, diversifyPicks, mapPool } from "./live";
import { plainReason } from "./plain";
import { buildForecastBundle } from "./forecast";
import { BUDGET_UNIVERSE, SEBI_BANNER, sectorOf } from "./universe";
import { SCREEN_UNIVERSE, screenSectorOf } from "./screenUniverse";
import {
  CALENDAR_SOURCE,
  HOLIDAY_FILE,
  calendarVerified,
  fmtDayLabel,
  prevTradingDay,
} from "./marketCalendar";
import { canonicalJSON, sha256hex } from "./hash";
import type { TechFields, TechLane, Verdict } from "./types";
import type { Lane, LaneStat, ReportPick, ReportV1 } from "./reportTypes";

export const METHOD_VERSION = "report_v1|risk_v1|atr_piecewise_T1_T2_v1";
const BUDGET_INR = 10000;
const RISK_PCT = 1;
const MAX_PER_SECTOR = 2;

/**
 * Extra names beyond BUDGET ∪ SCREEN (59): low-priced names so the "Under ₹50"
 * section can be populated from live data, plus PSU/infra/energy midcaps.
 * Inclusion is not a view; sections are decided by live data only.
 */
export const REPORT_EXTRA_UNIVERSE = [
  "YESBANK", "IDEA", "SUZLON", "JPPOWER", "SOUTHBANK", "UCOBANK", "IOB", "IRB",
  "NHPC", "GAIL", "BHEL", "NBCC", "HUDCO", "RVNL", "FEDERALBNK", "IDFCFIRSTB", "ASHOKLEY",
] as const;
const EXTRA_SECTOR: Record<string, string> = {
  YESBANK: "Banks", IDEA: "Telecom", SUZLON: "Energy", JPPOWER: "Energy", SOUTHBANK: "Banks",
  UCOBANK: "Banks", IOB: "Banks", IRB: "Infra", NHPC: "Energy", GAIL: "Energy", BHEL: "Infra",
  NBCC: "Infra", HUDCO: "Finance", RVNL: "Infra", FEDERALBNK: "Banks", IDFCFIRSTB: "Banks",
  ASHOKLEY: "Auto",
};

export function reportUniverse(): string[] {
  return [...new Set<string>([...BUDGET_UNIVERSE, ...SCREEN_UNIVERSE, ...REPORT_EXTRA_UNIVERSE])].sort();
}

export function universeVersion(u: string[] = reportUniverse()): string {
  const sorted = [...u].sort();
  return `u${sorted.length}-${sha256hex(sorted.join(",")).slice(0, 12)}`;
}

export function reportSectorOf(t: string): string {
  const a = sectorOf(t);
  if (a !== "Unknown") return a;
  const b = screenSectorOf(t);
  if (b !== "Unknown") return b;
  return EXTRA_SECTOR[t] || "Unknown";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- inputs
export interface SymbolInput {
  ticker: string;
  yahoo_symbol: string;
  sector: string;
  bar: { date: string; open: number; high: number; low: number; close: number; adjclose: number | null; volume: number } | null;
  tech: Omit<TechFields, "closes_30d"> | null;
  funda: { fields: Record<string, unknown>; sources: string[]; note: string } | null;
  news: { fields: Record<string, unknown>; sources: string[]; note: string } | null;
}

export interface ReportInputs {
  for_session: string;
  based_on_close: string;
  universe: string[];
  symbols: Record<string, SymbolInput>;
  indices: { symbol: string; name: string; close: number | "UNKNOWN"; prev_close: number | "UNKNOWN"; chg_pct: number | "UNKNOWN"; bar_date: string | null }[];
  global_cues: { symbol: string; name: string; close: number | "UNKNOWN"; chg_pct: number | "UNKNOWN"; as_of: string }[];
  headlines: { headline: string; source: string | null; link: string | null; pubDate: string | null; confirmation_status: string }[];
  headlines_as_of: string;
}

function techLane(s: SymbolInput): TechLane {
  return {
    ticker: s.ticker,
    yahoo_symbol: s.yahoo_symbol,
    fields: { ...(s.tech as TechFields) },
    unknowns: [],
    sources: [],
    ts: "",
  };
}

function stub(x: SymbolInput["funda"], ticker: string): LaneStub | null {
  return x ? { ticker, fields: x.fields, unknowns: [], sources: x.sources, note: x.note } : null;
}

export function verdictFor(s: SymbolInput): Verdict | null {
  if (!s.tech) return null;
  const v = mergeVerdict(techLane(s), {
    budget_inr: BUDGET_INR,
    risk_pct: RISK_PCT,
    funda: stub(s.funda, s.ticker),
    news: stub(s.news, s.ticker),
  });
  return { ...v, sector: s.sector };
}

function histFrom(symbol: string, bars: ChartResult["bars"]): YahooHistory {
  return {
    symbol,
    currency: "INR",
    regularMarketPrice: bars.length ? bars[bars.length - 1].close : null, // settled close, never LTP
    bars: bars.map((b) => ({ date: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    source: `yahoo:query1/chart:${symbol}:1y,1d`,
  };
}

function isDataGapFunda(f: SymbolInput["funda"]): boolean {
  if (!f) return true;
  const rf = f.fields?.red_flags;
  return Array.isArray(rf) && rf.some((x) => /Heavy unknowns|No live funda/i.test(String(x)));
}

// ---------------------------------------------------------------- sections (pure)
export function buildSections(
  inp: ReportInputs,
  prev: ReportV1 | null
): { sections: ReportV1["sections"]; unknownsFromData: { ticker: string; lane: Lane; reason: string }[] } {
  const unknownsFromData: { ticker: string; lane: Lane; reason: string }[] = [];
  const rows: { s: SymbolInput; v: Verdict }[] = [];
  for (const t of inp.universe) {
    const s = inp.symbols[t];
    if (!s?.tech) continue;
    const v = verdictFor(s);
    if (!v || v.insufficient_data || typeof v.cmp !== "number") continue;
    rows.push({ s, v });
  }
  const cmpOf = (v: Verdict) => v.cmp as number;

  // Top 10: buys under ₹1000 (no pennies), diversified; never padded.
  const buys = rows
    .filter(({ v }) => v.action === "buy" && cmpOf(v) < 1000 && cmpOf(v) >= 50 && v.entry != null && v.sl != null)
    .map(({ v }) => v);
  const eligible = buys.length;
  const top = diversifyPicks(
    [...buys].sort((a, b) => diversifiedPickScore(b) - diversifiedPickScore(a)),
    BUDGET_INR,
    10
  );
  const picks: ReportPick[] = top.map((v, i) => {
    const sized = sizePosition({ budget_inr: BUDGET_INR, risk_pct: RISK_PCT, entry: v.entry!, sl: v.sl! });
    return {
      rank: i + 1,
      ticker: v.ticker,
      sector: v.sector || null,
      cmp: cmpOf(v),
      action: "buy",
      confidence_1_10: v.confidence_1_10,
      entry: v.entry!,
      sl: v.sl!,
      t1: v.targets[0],
      t2: v.targets[1] ?? null,
      r_r: v.r_r ?? null,
      shares: sized.shares,
      size_inr: sized.size_inr,
      sizing_mode: sized.reason === "afford_one_share" ? "afford_one_share" : "risk_pct",
      plain_why: plainReason(String(v.reasons?.[0] || "Tape/funda gates pass for a paper setup")),
      risk_flags: v.risk_flags || [],
      bar_date: inp.symbols[v.ticker]?.bar?.date || inp.based_on_close,
    };
  });

  const deep = picks.slice(0, 3).map((p) => {
    const s = inp.symbols[p.ticker];
    const t = s.tech!;
    const bundle = buildForecastBundle({
      action: "buy",
      entry: p.entry,
      sl: p.sl,
      targets: [p.t1, ...(p.t2 != null ? [p.t2] : [])],
      atr_14: typeof t.atr_14 === "number" ? t.atr_14 : null,
      checkDays: [7, 14, 30],
      filledAt: `${inp.based_on_close}T12:00:00+05:30`,
      structure: t.structure,
      breakout_state: t.breakout_state,
    });
    const items = (Array.isArray(s.news?.fields?.items) ? (s.news!.fields.items as NewsItem[]) : []).map((n) => ({
      headline: n.headline,
      confirmation_status: n.confirmation_status,
      pubDate: n.pubDate ?? null,
      link: n.link ?? null,
      source: n.source ?? null,
    }));
    const v = verdictFor(s)!;
    return {
      ...p,
      plain_why: (v.reasons || []).slice(0, 4).map((x) => plainReason(String(x))).join(" · "),
      tech: {
        cmp: t.cmp, atr_14: t.atr_14, rsi_14: t.rsi_14, dma_20: t.dma_20, dma_50: t.dma_50, dma_200: t.dma_200,
        structure: t.structure, breakout_state: t.breakout_state, volume_vs_avg_20d: t.volume_vs_avg_20d ?? "UNKNOWN",
        bar_date: s.bar?.date ?? null,
      },
      funda: {
        pe: s.funda?.fields?.pe_ttm ?? "UNKNOWN",
        roe_pct: s.funda?.fields?.roe_pct ?? "UNKNOWN",
        debt_equity: s.funda?.fields?.debt_equity ?? "UNKNOWN",
        funda_quality: s.funda?.fields?.funda_quality ?? "UNKNOWN",
        source: s.funda?.sources?.[0] ?? null,
      },
      news: { items, note: s.news?.note ?? "news not fetched" },
      scenario_path_label: "Paper scenario path (ATR) — atr_piecewise_T1_T2_v1, from ATR levels; not a price call",
      scenario_path: (bundle?.points || []).map((x) => ({ dayOffset: x.dayOffset, predictedClose: x.predictedClose })),
    };
  });

  // Avoids: severity funda fail > confirmed bearish news > breakdown > below DMAs + LH_LL.
  const sev = (v: Verdict): [number, string] | null => {
    const f = v.risk_flags || [];
    const s = inp.symbols[v.ticker];
    if (f.includes("funda_quality=fail") && !isDataGapFunda(s.funda)) return [0, "funda_quality=fail"];
    if (f.includes("news_bear_confirmed")) return [1, "news_bear_confirmed"];
    if (f.includes("breakdown")) return [2, "breakdown"];
    if (f.includes("below_dma_lh_ll")) return [3, "below_dma_lh_ll"];
    return null;
  };
  const avoidRows = rows
    .filter(({ v }) => v.action === "avoid")
    .map(({ v }) => ({ v, sv: sev(v) }));
  for (const a of avoidRows) {
    if (!a.sv && isDataGapFunda(inp.symbols[a.v.ticker].funda)) {
      unknownsFromData.push({ ticker: a.v.ticker, lane: "funda", reason: "funda_unavailable (gate needs PE/ROE/D-E) — not listed as an avoid" });
    }
  }
  const ranked = avoidRows
    .filter((a) => a.sv)
    .sort((a, b) => a.sv![0] - b.sv![0] || (b.v.confidence_1_10 || 0) - (a.v.confidence_1_10 || 0) || a.v.ticker.localeCompare(b.v.ticker));
  const perSector = new Map<string, number>();
  const avoids: ReportV1["sections"]["avoids5"]["items"] = [];
  for (const a of ranked) {
    if (avoids.length >= 5) break;
    const sec = a.v.sector || "Unknown";
    if ((perSector.get(sec) || 0) >= MAX_PER_SECTOR) continue;
    perSector.set(sec, (perSector.get(sec) || 0) + 1);
    const raw = a.v.reasons?.find((r) => !/^Funda: quality=fail/.test(r) || a.sv![1] === "funda_quality=fail") || a.v.avoids_note || "";
    avoids.push({ ticker: a.v.ticker, sector: a.v.sector || null, cmp: cmpOf(a.v), reason: plainReason(String(raw)), flags: a.v.risk_flags || [], severity: a.sv![1] });
  }

  const pennies = rows
    .filter(({ v }) => cmpOf(v) < 50)
    .sort((a, b) => cmpOf(a.v) - cmpOf(b.v))
    .map(({ v }) => ({
      ticker: v.ticker,
      cmp: cmpOf(v),
      action: String(v.action),
      note: plainReason(String(v.reasons?.[0] || v.avoids_note || "")),
    }));

  // Breadth over our universe
  const scannedN = inp.universe.length;
  const ok = rows.length;
  const count = (a: string) => rows.filter(({ v }) => v.action === a).length;
  const above50 = rows.filter(({ s }) => typeof s.tech?.dma_50 === "number" && typeof s.tech?.cmp === "number" && (s.tech.cmp as number) > (s.tech.dma_50 as number)).length;
  const hhhl = rows.filter(({ s }) => s.tech?.structure === "HH_HL").length;

  const prevTop = prev?.sections?.top10_under_1000?.items?.map((x) => x.ticker) || [];
  const prevAv = prev?.sections?.avoids5?.items?.map((x) => x.ticker) || [];
  const nowTop = picks.map((x) => x.ticker);
  const nowAv = avoids.map((x) => x.ticker);
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

  const nifty = inp.indices.find((i) => i.symbol === "^NSEI");
  const niftyTxt =
    nifty && typeof nifty.close === "number"
      ? `Nifty 50 closed at ${nifty.close}${typeof nifty.chg_pct === "number" ? ` (${nifty.chg_pct >= 0 ? "+" : ""}${nifty.chg_pct}%)` : ""} on ${nifty.bar_date}`
      : "Nifty 50 close UNKNOWN";

  return {
    unknownsFromData,
    sections: {
      market_overview: {
        indices: inp.indices,
        breadth: { scanned: scannedN, above_dma50: above50, hh_hl: hhhl, buy: count("buy"), hold: count("hold"), avoid: count("avoid"), unknown: scannedN - ok },
        global_cues: inp.global_cues,
        headlines: inp.headlines,
        headlines_as_of: inp.headlines_as_of,
        not_available: ["GIFT Nifty", "FII/DII flows", "NSE pre-open / indicative prices"],
      },
      top10_under_1000: {
        items: picks,
        n_eligible: eligible,
        ...(picks.length < 10 ? { note: `Only ${picks.length} names passed gates today (max ${MAX_PER_SECTOR} per sector; not padded).` } : {}),
      },
      deep_dive_top3: { items: deep, ...(deep.length ? {} : { note: "No paper setups passed gates — nothing to deep-dive." }) },
      avoids5: { items: avoids, ...(avoids.length < 5 ? { note: `Only ${avoids.length} names met the skip rules (not padded).` } : {}) },
      penny_under_50: {
        items: pennies,
        warning: "Under ₹50: low price, often low liquidity and high volatility. Shown for awareness, not ranked.",
        ...(pennies.length ? {} : { note: "No scanned name closed under ₹50 with usable data — none invented." }),
      },
      final_summary: {
        counts: { scanned: scannedN, ok, unknown: scannedN - ok, buy: count("buy"), hold: count("hold"), avoid: count("avoid") },
        top3: deep.map((d) => d.ticker),
        changes_vs_prev: {
          prev_key: prev?.key ?? null,
          top10_in: prev ? diff(nowTop, prevTop) : [],
          top10_out: prev ? diff(prevTop, nowTop) : [],
          avoids_in: prev ? diff(nowAv, prevAv) : [],
          avoids_out: prev ? diff(prevAv, nowAv) : [],
        },
        headline: `${niftyTxt}. ${ok}/${scannedN} names with usable data: ${count("buy")} paper setups (${picks.length} in Top 10 under ₹1000), ${count("hold")} hold, ${count("avoid")} skip.${deep.length ? ` Deep dive: ${deep.map((d) => d.ticker).join(", ")}.` : ""}`,
      },
    },
  };
}

// ---------------------------------------------------------------- generation (I/O)
const INDEX_LIST = [
  { symbol: "^NSEI", name: "Nifty 50" },
  { symbol: "^BSESN", name: "Sensex" },
  { symbol: "^NSEBANK", name: "Nifty Bank" },
  { symbol: "^INDIAVIX", name: "India VIX" },
];
const GLOBAL_LIST = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "Nasdaq Composite" },
];

export interface GenerateOpts {
  for_session: string;
  prev?: ReportV1 | null;
  deadlineMs?: number; // stop scheduling new symbols after this many ms (default 210 s)
  universe?: string[];
}

export interface GenerateResult {
  report: ReportV1;
  inputs: ReportInputs;
}

export async function generateReport(opts: GenerateOpts): Promise<GenerateResult> {
  const t0 = Date.now();
  const fluidOff = process.env.FLUID_OFF === "1";
  const scheduleCutoff = t0 + (opts.deadlineMs ?? (fluidOff ? 45_000 : 210_000));
  const for_session = opts.for_session;
  const based_on_close = prevTradingDay(for_session);
  const universe = (opts.universe || reportUniverse()).slice().sort();
  const unknowns: { ticker: string; lane: Lane; reason: string }[] = [];
  const lanes: Record<Lane, LaneStat> = {
    tech: { source: "Yahoo v8 chart 1d (1y)", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0 },
    funda: { source: "screener.in HTML (Yahoo quoteSummary skipped in cron)", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0, skipped: 0 },
    news: { source: "Yahoo Finance RSS / Google News RSS", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0, skipped: 0 },
    index: { source: "Yahoo v8 chart 1d", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0 },
  };
  const touch = (l: Lane) => {
    const now = new Date().toISOString();
    lanes[l].first_fetch_at ||= now;
    lanes[l].last_fetch_at = now;
  };

  // Market-level lanes in parallel
  const idxP = Promise.all(
    [...INDEX_LIST, ...GLOBAL_LIST].map(async (ix) => {
      const r = await fetchYahooChartX(ix.symbol, "1mo", { minBars: 2 });
      touch("index");
      const isIndia = INDEX_LIST.some((x) => x.symbol === ix.symbol);
      const bars = isIndia ? r.bars.filter((b) => b.date <= based_on_close) : r.bars;
      if (!r.ok || bars.length < 2) {
        lanes.index.failed++;
        unknowns.push({ ticker: ix.symbol, lane: "index", reason: r.error || "short_history" });
        return { ...ix, isIndia, close: "UNKNOWN" as const, prev_close: "UNKNOWN" as const, chg_pct: "UNKNOWN" as const, bar_date: null };
      }
      lanes.index.ok++;
      const last = bars[bars.length - 1];
      const prevB = bars[bars.length - 2];
      if (isIndia && last.date !== based_on_close) {
        unknowns.push({ ticker: ix.symbol, lane: "index", reason: `no bar for ${based_on_close} (last ${last.date})` });
      }
      return { ...ix, isIndia, close: r2(last.close), prev_close: r2(prevB.close), chg_pct: r2(((last.close - prevB.close) / prevB.close) * 100), bar_date: last.date };
    })
  );
  const headP = fetchMarketHeadlines(5).catch(() => ({ items: [] as NewsItem[], sources: [], note: "failed" }));

  // Pass 1 — tech
  const symbols: Record<string, SymbolInput> = {};
  let first20 = 0;
  let first20_429 = 0;
  let breaker = false;
  const notScanned: string[] = [];
  await mapPool(universe, 5, async (t) => {
    if (breaker || Date.now() > scheduleCutoff) {
      notScanned.push(t);
      return;
    }
    const yahoo = `${t}.NS`;
    const r = await fetchYahooChartX(yahoo, "1y", { minBars: 30 });
    touch("tech");
    if (first20 < 20) {
      first20++;
      if (r.error === "yahoo_429") first20_429++;
      if (first20_429 >= 6) breaker = true;
    }
    const sector = reportSectorOf(t);
    const base: SymbolInput = { ticker: t, yahoo_symbol: yahoo, sector, bar: null, tech: null, funda: null, news: null };
    if (!r.ok) {
      lanes.tech.failed++;
      unknowns.push({ ticker: t, lane: "tech", reason: r.error || "unknown" });
      symbols[t] = base;
      return;
    }
    const bars = r.bars.filter((b) => b.date <= based_on_close);
    const last = bars[bars.length - 1];
    if (!last || last.date !== based_on_close) {
      lanes.tech.failed++;
      unknowns.push({ ticker: t, lane: "tech", reason: `yahoo_missing_bar: no settled bar for ${based_on_close}${last ? ` (last ${last.date})` : ""}` });
      symbols[t] = base;
      return;
    }
    if (bars.length < 30) {
      lanes.tech.failed++;
      unknowns.push({ ticker: t, lane: "tech", reason: "short_history" });
      symbols[t] = base;
      return;
    }
    const tech = computeTech(t, histFrom(yahoo, bars));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { closes_30d, ...techNoCloses } = tech.fields;
    lanes.tech.ok++;
    symbols[t] = {
      ...base,
      bar: { date: last.date, open: r2(last.open), high: r2(last.high), low: r2(last.low), close: r2(last.close), adjclose: last.adjclose != null ? r2(last.adjclose) : null, volume: last.volume },
      tech: techNoCloses,
    };
  });
  for (const t of notScanned) {
    unknowns.push({ ticker: t, lane: "tech", reason: breaker ? "circuit_breaker_429" : "deadline_not_scanned" });
    symbols[t] = { ticker: t, yahoo_symbol: `${t}.NS`, sector: reportSectorOf(t), bar: null, tech: null, funda: null, news: null };
  }

  // Pass 2 — funda (skip names whose tape already fails: funda can't flip them to buy)
  const fundaTargets = universe.filter((t) => {
    const s = symbols[t];
    if (!s?.tech) return false;
    const v = verdictFor(s);
    return v != null && v.action !== "avoid";
  });
  lanes.funda.skipped = universe.filter((t) => symbols[t]?.tech).length - fundaTargets.length;
  await mapPool(fundaTargets, 2, async (t) => {
    if (Date.now() > scheduleCutoff + 30_000) {
      unknowns.push({ ticker: t, lane: "funda", reason: "deadline_not_fetched" });
      return;
    }
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
    const f = await fetchLiveFunda(t, `${t}.NS`, { yahoo: false }).catch(() => null);
    touch("funda");
    if (!f || isDataGapFunda({ fields: f.fields, sources: f.sources, note: f.note })) {
      lanes.funda.failed++;
      unknowns.push({ ticker: t, lane: "funda", reason: "screener_unavailable_or_blocked" });
    } else lanes.funda.ok++;
    if (f) symbols[t].funda = { fields: f.fields, sources: f.sources, note: f.note };
  });

  // Pass 3 — news for the shortlist only
  const pre = universe
    .map((t) => ({ t, v: symbols[t]?.tech ? verdictFor(symbols[t]) : null }))
    .filter((x) => x.v && typeof x.v.cmp === "number");
  const shortlist = new Set<string>();
  pre.filter((x) => x.v!.action === "buy" && (x.v!.cmp as number) < 1000).sort((a, b) => diversifiedPickScore(b.v!) - diversifiedPickScore(a.v!)).slice(0, 14).forEach((x) => shortlist.add(x.t));
  pre.filter((x) => x.v!.action === "avoid").slice(0, 3).forEach((x) => shortlist.add(x.t));
  pre.filter((x) => (x.v!.cmp as number) < 50).slice(0, 3).forEach((x) => shortlist.add(x.t));
  lanes.news.skipped = pre.length - shortlist.size;
  await mapPool([...shortlist], 4, async (t) => {
    const n = await Promise.race([
      fetchLiveNews(t, `${t}.NS`).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    touch("news");
    if (!n) {
      lanes.news.failed++;
      unknowns.push({ ticker: t, lane: "news", reason: "timeout_or_error" });
      return;
    }
    lanes.news.ok++;
    // store only what mergeVerdict + UI need
    const items = Array.isArray(n.fields.items) ? (n.fields.items as NewsItem[]) : [];
    symbols[t].news = {
      fields: {
        ...Object.fromEntries(Object.entries(n.fields).filter(([k]) => k !== "items")),
        items: items.map((i) => ({ headline: i.headline, source: i.source ?? null, link: i.link ?? null, pubDate: i.pubDate ?? null, confirmation_status: i.confirmation_status, sentiment: i.sentiment, catalyst_strength: i.catalyst_strength })),
      },
      sources: n.sources,
      note: n.note,
    };
  });

  const [idx, heads] = await Promise.all([idxP, headP]);
  const inputs: ReportInputs = {
    for_session,
    based_on_close,
    universe,
    symbols,
    indices: idx.filter((x) => x.isIndia).map(({ symbol, name, close, prev_close, chg_pct, bar_date }) => ({ symbol, name, close, prev_close, chg_pct, bar_date })),
    global_cues: idx.filter((x) => !x.isIndia).map(({ symbol, name, close, chg_pct, bar_date }) => ({ symbol, name, close, chg_pct, as_of: bar_date ? `US close ${bar_date}` : "UNKNOWN" })),
    headlines: (heads.items || []).map((h) => ({ headline: h.headline, source: h.source ?? null, link: h.link ?? null, pubDate: h.pubDate ?? null, confirmation_status: h.confirmation_status })),
    headlines_as_of: new Date().toISOString(),
  };

  const report = assembleReport(inputs, opts.prev ?? null, {
    lanes,
    unknowns,
    // partial = could not FETCH (429/5xx/timeout/network/not scanned); Yahoo data holes (null bar, short history, 404) are UNKNOWN but not partial
    partial: notScanned.length > 0 || breaker || unknowns.some((u) => u.lane === "tech" && /^(yahoo_429|http_5xx|timeout|network|not_scanned)/.test(u.reason)),
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    scan_deadline_ms: scheduleCutoff - t0,
  });
  return { report, inputs };
}

export function inputsHash(inputs: ReportInputs): string {
  return sha256hex(
    canonicalJSON({ universe_sorted: [...inputs.universe].sort(), inputs, budget_inr: BUDGET_INR, risk_pct: RISK_PCT, method_version: METHOD_VERSION })
  );
}

export function assembleReport(
  inputs: ReportInputs,
  prev: ReportV1 | null,
  meta: { lanes: Record<Lane, LaneStat>; unknowns: ReportV1["unknowns"]; partial: boolean; generated_at: string; elapsed_ms: number; scan_deadline_ms: number }
): ReportV1 {
  const { sections, unknownsFromData } = buildSections(inputs, prev);
  const allUnknowns = [...meta.unknowns];
  for (const u of unknownsFromData) if (!allUnknowns.some((x) => x.ticker === u.ticker && x.lane === u.lane)) allUnknowns.push(u);
  const body: Omit<ReportV1, "report_hash"> = {
    schema: "stock-lab.report.v1",
    key: `report:${inputs.for_session}`,
    for_session: inputs.for_session,
    based_on_close: inputs.based_on_close,
    label: `Based on close of ${fmtDayLabel(inputs.based_on_close)} · For session ${fmtDayLabel(inputs.for_session)}`,
    generated_at: meta.generated_at,
    status: meta.partial ? "partial" : "complete",
    method_version: METHOD_VERSION,
    universe_version: universeVersion(inputs.universe),
    inputs_hash: inputsHash(inputs),
    budget_inr: BUDGET_INR,
    risk_pct: RISK_PCT,
    sebi_banner: SEBI_BANNER,
    data_notes: [
      "Prices are NSE daily closes via Yahoo (raw close); pre-open / indicative prices are not used. Levels are from the prior close.",
      "Levels: entry = close, SL = entry − 2.4×ATR14, ATR level T1 = +2×ATR, T2 = +3.5×ATR (risk.ts deriveLevels). Confidence is a gate score, not a probability.",
      "Research / paper setups only — this service is not SEBI-registered.",
      "Sector preference (high-delivery PSU/Infra/Banks/IT/Energy) NOT applied: delivery % is not available from our feeds.",
    ],
    calendar: { source: CALENDAR_SOURCE, holiday_file: HOLIDAY_FILE, ...(calendarVerified(inputs.for_session) ? {} : { unverified: true }) },
    lanes: meta.lanes,
    unknowns: allUnknowns.sort((a, b) => a.lane.localeCompare(b.lane) || a.ticker.localeCompare(b.ticker)),
    timing: { elapsed_ms: meta.elapsed_ms, scan_deadline_ms: meta.scan_deadline_ms },
    sections,
  };
  return { ...body, report_hash: reportHash(body) };
}

export function reportHash(body: Omit<ReportV1, "report_hash"> | ReportV1): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { report_hash, ...rest } = body as ReportV1;
  return sha256hex(canonicalJSON(rest));
}

/**
 * Determinism check (acceptance §2.10 #8): rebuild the report from its stored
 * inputs (+ the prev report it was diffed against) and compare report_hash.
 */
export function verifyReport(stored: ReportV1, inputs: ReportInputs, prev: ReportV1 | null): { ok: boolean; recomputed_hash: string } {
  const re = assembleReport(inputs, prev, {
    lanes: stored.lanes,
    unknowns: stored.unknowns,
    partial: stored.status === "partial",
    generated_at: stored.generated_at,
    elapsed_ms: stored.timing.elapsed_ms,
    scan_deadline_ms: stored.timing.scan_deadline_ms,
  });
  return { ok: re.report_hash === stored.report_hash && re.inputs_hash === stored.inputs_hash, recomputed_hash: re.report_hash };
}
