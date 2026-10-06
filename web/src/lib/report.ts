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

import { fetchYahooChartX, type ChartResult, type DailyBarX, type YahooHistory } from "./yahoo";
import { BhavFetcher, type CloseSource } from "./bhavcopy";
import { computeTech } from "./tech";
import { fetchLiveFunda } from "./funda";
import { fetchLiveNews, fetchMarketHeadlines, type NewsItem } from "./news";
import { mergeVerdict, sizePosition, type LaneStub, type LevelPolicy } from "./risk";
import { rrPlain } from "./rr";
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
import { barAsOf, indexAsOf, shortDay } from "./staleLabel";
import type { ForecastMethod, TechFields, TechLane, Verdict } from "./types";
import type { Lane, LaneStat, ReportPick, ReportV1 } from "./reportTypes";

/**
 * report_v2|risk_v2 (2026-09-25): funda that is missing (Screener blocked / not
 * fetched) no longer forces "avoid" — it is shown as UNKNOWN, the tape decides
 * and confidence is capped −1 (risk.ts fundaGap:"unknown"). Stored v1 reports
 * are still re-verified with the v1 rules (see fundaGapPolicy).
 */
/**
 * report_v3|risk_v3 (2026-10-05): R:R floor — T1 ≥ entry + 1R, T2 ≥ entry + 1.8R,
 * extended to real resistance (swing high / prior 20-/50-day high) when that is
 * farther out; resistance under entry + 1R blocks the buy (hold + plain reason).
 * Paper scenario path for v3 levels = atr_piecewise_T1_T2_v2 (same formula, new
 * levels). Top 10 lists verified-funda names before funda_unknown ones.
 * Stored v1/v2 reports re-verify with their own level rules (levelPolicy).
 */
/**
 * report_v3.1 (2026-10-06): data-gap handling. A missing / null based_on_close bar
 * (stock OR India index) makes the report `partial` with `incomplete.missing_bars`
 * listed; a later run the same day may store an upgraded version (report:<d>:v<n>,
 * earlier versions kept). A missing Yahoo bar may be filled ONLY from the official
 * EOD file for that exact date (NSE/BSE bhavcopy, NSE index closes), tagged
 * `close_source`. Index numbers older than based_on_close carry an "as of" label.
 * Levels / gates are unchanged from v3 (same risk_v3, same paper method).
 */
export const METHOD_VERSION = "report_v3.1|risk_v3|atr_piecewise_T1_T2_v2";
/** [major, minor] of a report method string ("report_v3.1|…" → [3, 1]). */
export function reportVersionOf(method: string = METHOD_VERSION): [number, number] {
  const m = method.match(/^report_v(\d+)(?:\.(\d+))?\|/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0];
}
/** report_v3.1+: data-gap rules (missing bar → partial, close_source, stale labels, versions). */
export function dataGapRules(method: string = METHOD_VERSION): boolean {
  const [a, b] = reportVersionOf(method);
  return a > 3 || (a === 3 && b >= 1);
}
export function fundaGapPolicy(method: string = METHOD_VERSION): "avoid" | "unknown" {
  return method.startsWith("report_v1|") ? "avoid" : "unknown";
}
export function levelPolicy(method: string = METHOD_VERSION): LevelPolicy {
  return /^report_v[12]\|/.test(method) ? "atr_v2" : "rr_floor_v3";
}
export function scenarioMethodOf(method: string = METHOD_VERSION): ForecastMethod {
  return levelPolicy(method) === "atr_v2" ? "atr_piecewise_T1_T2_v1" : "atr_piecewise_T1_T2_v2";
}
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
  bar: {
    date: string; open: number; high: number; low: number; close: number; adjclose: number | null; volume: number;
    /** report_v3.1: set only when the based_on_close bar came from an official EOD file (Yahoo had none) */
    close_source?: CloseSource;
  } | null;
  tech: Omit<TechFields, "closes_30d"> | null;
  funda: { fields: Record<string, unknown>; sources: string[]; note: string } | null;
  news: { fields: Record<string, unknown>; sources: string[]; note: string } | null;
}

export interface ReportInputs {
  for_session: string;
  based_on_close: string;
  universe: string[];
  symbols: Record<string, SymbolInput>;
  indices: {
    symbol: string; name: string; close: number | "UNKNOWN"; prev_close: number | "UNKNOWN"; chg_pct: number | "UNKNOWN"; bar_date: string | null;
    /** report_v3.1: "nse_index_close" when Yahoo had no based_on_close bar and NSE's official close file did */
    close_source?: CloseSource;
  }[];
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

export function verdictFor(s: SymbolInput, method: string = METHOD_VERSION): Verdict | null {
  if (!s.tech) return null;
  const v = mergeVerdict(techLane(s), {
    budget_inr: BUDGET_INR,
    risk_pct: RISK_PCT,
    funda: stub(s.funda, s.ticker),
    news: stub(s.news, s.ticker),
    fundaGap: fundaGapPolicy(method),
    levels: levelPolicy(method),
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
  prev: ReportV1 | null,
  method: string = METHOD_VERSION
): { sections: ReportV1["sections"]; unknownsFromData: { ticker: string; lane: Lane; reason: string }[] } {
  const unknownsFromData: { ticker: string; lane: Lane; reason: string }[] = [];
  const rows: { s: SymbolInput; v: Verdict }[] = [];
  for (const t of inp.universe) {
    const s = inp.symbols[t];
    if (!s?.tech) continue;
    const v = verdictFor(s, method);
    if (!v || v.insufficient_data || typeof v.cmp !== "number") continue;
    rows.push({ s, v });
  }
  const cmpOf = (v: Verdict) => v.cmp as number;

  // Top 10: buys under ₹1000 (no pennies), diversified; never padded.
  const buys = rows
    .filter(({ v }) => v.action === "buy" && cmpOf(v) < 1000 && cmpOf(v) >= 50 && v.entry != null && v.sl != null)
    .map(({ v }) => v);
  const eligible = buys.length;
  const v3 = levelPolicy(method) === "rr_floor_v3";
  const gapRules = dataGapRules(method);
  const top = diversifyPicks(
    [...buys].sort((a, b) => diversifiedPickScore(b) - diversifiedPickScore(a)),
    BUDGET_INR,
    10,
    { verifiedFirst: v3 }
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
      // v3 only (v1/v2 picks keep their stored shape so old reports re-verify)
      ...(v3
        ? {
            risk_per_share: r2(v.entry! - v.sl!),
            rr_t1: v.rr_t1 ?? null,
            rr_t2: v.rr_t2 ?? null,
            rr_plain: rrPlain(v.entry, v.sl, v.targets[0], v.targets[1]) ?? "R:R UNKNOWN",
            t1_basis: v.t1_basis ?? null,
            t2_basis: v.t2_basis ?? null,
            funda_status: v.risk_flags?.includes("funda_unknown") ? ("UNKNOWN (not verified)" as const) : ("verified" as const),
          }
        : {}),
      // v3.1: bar filled from an official EOD file (Yahoo had none) → say so on the pick
      ...(gapRules && inp.symbols[v.ticker]?.bar?.close_source
        ? {
            close_source: inp.symbols[v.ticker].bar!.close_source,
            close_label: barAsOf(inp.symbols[v.ticker].bar!.date, inp.based_on_close, inp.symbols[v.ticker].bar!.close_source) ?? undefined,
          }
        : {}),
    };
  });

  // v3: names whose tape passed but real resistance caps T1 under 1R (downgraded to hold).
  const rrCapped = v3
    ? rows
        .filter(({ v }) => v.action !== "buy" && v.resistance_cap && /^Resistance at ₹/.test(String(v.reasons?.[0] || "")))
        .filter(({ v }) => cmpOf(v) < 1000 && cmpOf(v) >= 50)
        .map(({ v }) => ({
          ticker: v.ticker,
          sector: v.sector || null,
          cmp: cmpOf(v),
          resistance: v.resistance_cap!.price,
          source: v.resistance_cap!.source,
          rr_to_resistance: v.resistance_cap!.rr,
          reason: `Resistance at ₹${v.resistance_cap!.price} (${v.resistance_cap!.source}) caps upside below 1R (${v.resistance_cap!.rr}R)`,
        }))
        .sort((a, b) => a.ticker.localeCompare(b.ticker))
    : [];

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
      method: scenarioMethodOf(method),
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
    const v = verdictFor(s, method)!;
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
        funda_quality: isDataGapFunda(s.funda) ? "UNKNOWN" : (s.funda?.fields?.funda_quality ?? "UNKNOWN"),
        source: s.funda?.sources?.[0] ?? null,
      },
      news: { items, note: s.news?.note ?? "news not fetched" },
      scenario_path_label: v3
        ? "Paper scenario path — atr_piecewise_T1_T2_v2, from the R:R-floor levels (T1 ≥ 1R, T2 ≥ 1.8R); not a price call"
        : "Paper scenario path (ATR) — atr_piecewise_T1_T2_v1, from ATR levels; not a price call",
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
  const chgTxt = (n: { chg_pct: number | "UNKNOWN" }) => (typeof n.chg_pct === "number" ? ` (${n.chg_pct >= 0 ? "+" : ""}${n.chg_pct}%)` : "");
  let niftyTxt =
    nifty && typeof nifty.close === "number"
      ? `Nifty 50 closed at ${nifty.close}${chgTxt(nifty)} on ${nifty.bar_date}`
      : "Nifty 50 close UNKNOWN";
  // v3.1: never present an older index bar as the based_on_close number
  const indices = gapRules
    ? inp.indices.map((ix) => {
        const lab = indexAsOf(ix, inp.based_on_close);
        return lab ? { ...ix, stale: lab.stale, as_of_label: lab.label } : ix;
      })
    : inp.indices;
  const staleIdx = gapRules ? indices.filter((ix) => "stale" in ix && ix.stale) : [];
  if (gapRules && nifty) {
    const lab = indexAsOf(nifty, inp.based_on_close);
    if (lab?.stale && typeof nifty.close === "number") niftyTxt = `Nifty 50 ${lab.label.replace(/^Index data /, "data ")}: last close ${nifty.close}${chgTxt(nifty)} — not a ${shortDay(inp.based_on_close)} number`;
    else if (lab?.stale) niftyTxt = `Nifty 50 close for ${shortDay(inp.based_on_close)} UNKNOWN`;
    else if (lab && typeof nifty.close === "number") niftyTxt = `Nifty 50 closed at ${nifty.close}${chgTxt(nifty)} on ${nifty.bar_date} (${lab.label})`;
  }

  return {
    unknownsFromData,
    sections: {
      market_overview: {
        indices,
        ...(staleIdx.length
          ? {
              data_as_of_note: `Not ${shortDay(inp.based_on_close)} numbers: ${staleIdx
                .map((ix) => `${ix.name} ${ix.bar_date ? `as of ${shortDay(ix.bar_date)}` : "UNKNOWN"}`)
                .join(", ")} — Yahoo had no ${shortDay(inp.based_on_close)} bar and no official close file filled it.`,
            }
          : {}),
        breadth: { scanned: scannedN, above_dma50: above50, hh_hl: hhhl, buy: count("buy"), hold: count("hold"), avoid: count("avoid"), unknown: scannedN - ok },
        global_cues: inp.global_cues,
        headlines: inp.headlines,
        headlines_as_of: inp.headlines_as_of,
        not_available: ["GIFT Nifty", "FII/DII flows", "NSE pre-open / indicative prices"],
      },
      top10_under_1000: {
        items: picks,
        n_eligible: eligible,
        ...(v3 ? { rr_capped: rrCapped } : {}),
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
/** NSE ind_close_all names for the India indices NSE publishes (Sensex is BSE's: no NSE fallback). */
const NSE_INDEX_NAME: Record<string, string> = { "^NSEI": "Nifty 50", "^NSEBANK": "Nifty Bank", "^INDIAVIX": "India VIX" };
const GLOBAL_LIST = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "Nasdaq Composite" },
];

export interface GenerateOpts {
  for_session: string;
  prev?: ReportV1 | null;
  deadlineMs?: number; // stop scheduling new symbols after this many ms (default 210 s)
  universe?: string[];
  /** report_v3.1 versioning: 1 = first build for the session; n > 1 = upgrade of a partial report */
  version?: number;
  supersedes?: ReportSupersedes | null;
}

export interface ReportSupersedes {
  key: string;
  version: number;
  status: "complete" | "partial";
  report_hash: string;
  inputs_hash: string;
  missing: number;
}

export interface MissingBar {
  symbol: string;
  kind: "stock" | "index";
  reason: string;
  last_bar_date?: string | null;
}

/**
 * Stocks / India indices without a usable based_on_close bar (pure: inputs + unknowns).
 * Counted: Yahoo null / missing row and fetch failures. Not counted: permanent data holes
 * (404, short history), which stay UNKNOWN without making the report partial.
 */
export function missingBars(inputs: ReportInputs, unknowns: ReportV1["unknowns"]): MissingBar[] {
  const out: MissingBar[] = [];
  for (const u of unknowns) {
    if (u.lane === "tech" && /^(yahoo_null_bar|yahoo_missing_bar|yahoo_429|http_5xx|timeout|network|deadline_not_scanned|circuit_breaker_429)/.test(u.reason)) {
      out.push({ symbol: u.ticker, kind: "stock", reason: u.reason });
    }
  }
  for (const ix of inputs.indices) {
    if (ix.bar_date !== inputs.based_on_close) {
      const u = unknowns.find((x) => x.lane === "index" && x.ticker === ix.symbol);
      out.push({ symbol: ix.symbol, kind: "index", reason: u?.reason || `no bar for ${inputs.based_on_close}`, last_bar_date: ix.bar_date });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.symbol.localeCompare(b.symbol));
}

/**
 * Fill ONE missing based_on_close bar from the official EOD file for exactly that date.
 * Guards: Yahoo's last usable bar must be the previous trading day (no wider gap), the
 * file row's own date must equal based_on_close, OHLC must be consistent, and the file's
 * previous close must match Yahoo's last close within 1% (else: corporate action /
 * adjustment mismatch → not filled).
 */
async function fillFromBhav(
  ticker: string,
  bars: DailyBarX[],
  basedOnClose: string,
  bhav: BhavFetcher
): Promise<{ ok: true; bar: DailyBarX; source: CloseSource } | { ok: false; why: string }> {
  const last = bars[bars.length - 1];
  if (!last) return { ok: false, why: "bhavcopy: no prior Yahoo bars" };
  if (last.date !== prevTradingDay(basedOnClose)) return { ok: false, why: `bhavcopy: not used (gap before ${basedOnClose}, last ${last.date})` };
  const look = await bhav.equity(ticker, basedOnClose);
  if (!look.ok || !look.row || !look.source) return { ok: false, why: `bhavcopy: ${look.tried.join(", ") || "unavailable"}` };
  const b = look.row;
  if (![b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) {
    return { ok: false, why: `bhavcopy: ${look.source} row inconsistent` };
  }
  if (b.prev_close != null && Math.abs(b.prev_close - last.close) / last.close > 0.01) {
    return { ok: false, why: `bhavcopy: ${look.source} prev_close ${b.prev_close} ≠ Yahoo ${r2(last.close)} (corporate action?) — not filled` };
  }
  return {
    ok: true,
    source: look.source,
    bar: { date: basedOnClose, ts: Math.floor(Date.parse(`${basedOnClose}T15:30:00+05:30`) / 1000), open: b.open, high: b.high, low: b.low, close: b.close, adjclose: null, volume: b.volume },
  };
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
  const bhav = new BhavFetcher();
  const lanes: Record<Lane, LaneStat> = {
    tech: { source: "Yahoo v8 chart 1d (1y); a missing based_on_close bar is filled only from NSE/BSE bhavcopy for that date", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0 },
    funda: { source: "screener.in HTML (Yahoo quoteSummary skipped in cron)", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0, skipped: 0 },
    news: { source: "Yahoo Finance RSS / Google News RSS", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0, skipped: 0 },
    index: { source: "Yahoo v8 chart 1d; NSE ind_close_all for a missing based_on_close bar", first_fetch_at: null, last_fetch_at: null, ok: 0, failed: 0 },
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
      const last = bars[bars.length - 1];
      let fallbackNote = "";
      // v3.1: Yahoo has no based_on_close bar for an India index → NSE's official index close
      // file for exactly that date (never intraday, never a later date). Fails soft.
      if (isIndia && (!last || last.date !== based_on_close) && NSE_INDEX_NAME[ix.symbol]) {
        const f = await bhav.indexClose(NSE_INDEX_NAME[ix.symbol], based_on_close);
        const row = f.row;
        if (f.ok && row && row.points_change != null && row.close > 0) {
          const prev = r2(row.close - row.points_change);
          const yPrev = last && last.date === prevTradingDay(based_on_close) ? last.close : null;
          if (prev > 0 && (yPrev == null || Math.abs(prev - yPrev) / yPrev <= 0.005)) {
            lanes.index.ok++;
            return { ...ix, isIndia, close: r2(row.close), prev_close: prev, chg_pct: r2(((row.close - prev) / prev) * 100), bar_date: based_on_close, close_source: "nse_index_close" as CloseSource };
          }
          fallbackNote = `; nse_index_close: prev_close_mismatch (file ${prev} vs Yahoo ${yPrev})`;
        } else fallbackNote = `; ${f.tried.join(", ") || "nse_index_close: unavailable"}`;
      }
      if (!r.ok || bars.length < 2) {
        lanes.index.failed++;
        unknowns.push({ ticker: ix.symbol, lane: "index", reason: (r.error || "short_history") + fallbackNote });
        return { ...ix, isIndia, close: "UNKNOWN" as const, prev_close: "UNKNOWN" as const, chg_pct: "UNKNOWN" as const, bar_date: null };
      }
      lanes.index.ok++;
      const prevB = bars[bars.length - 2];
      if (isIndia && last.date !== based_on_close) {
        unknowns.push({ ticker: ix.symbol, lane: "index", reason: `no bar for ${based_on_close} (last ${last.date})${fallbackNote}` });
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
    let r = await fetchYahooChartX(yahoo, "1y", { minBars: 30 });
    // Yahoo occasionally serves the based_on_close row with null OHLC (seen 2026-09-25 for 8/76
    // names during market hours). Ask the other Yahoo host once; if it's still missing → UNKNOWN.
    if (r.ok && !r.bars.some((b) => b.date === based_on_close) && Date.now() < scheduleCutoff) {
      const r2nd = await fetchYahooChartX(yahoo, "1y", { minBars: 30, host: "query2", retries: 1 });
      if (r2nd.ok && r2nd.bars.some((b) => b.date === based_on_close)) r = r2nd;
    }
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
    let bars = r.bars.filter((b) => b.date <= based_on_close);
    let closeSource: CloseSource | undefined;
    let fillWhy = "";
    if (!bars.length || bars[bars.length - 1].date !== based_on_close) {
      const fill = await fillFromBhav(t, bars, based_on_close, bhav);
      if (fill.ok) {
        bars = [...bars, fill.bar];
        closeSource = fill.source;
      } else fillWhy = fill.why;
    }
    const last = bars[bars.length - 1];
    if (!last || last.date !== based_on_close) {
      lanes.tech.failed++;
      const nullRow = r.null_row_dates?.includes(based_on_close);
      unknowns.push({
        ticker: t,
        lane: "tech",
        reason: (nullRow
          ? `yahoo_null_bar: Yahoo returned the ${based_on_close} row with null OHLC${last ? ` (last usable ${last.date})` : ""} — not filled`
          : `yahoo_missing_bar: no settled bar for ${based_on_close}${last ? ` (last ${last.date})` : ""}`) + (fillWhy ? `; ${fillWhy}` : ""),
      });
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
      bar: { date: last.date, open: r2(last.open), high: r2(last.high), low: r2(last.low), close: r2(last.close), adjclose: last.adjclose != null ? r2(last.adjclose) : null, volume: last.volume, ...(closeSource ? { close_source: closeSource } : {}) },
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
  // Pacing lives in funda.ts (process-wide token bucket + 429 cool-down/retry): Screener
  // 429s after ~20 quick requests. ~55 names take ~60 s — fine under Fluid's 300 s.
  const fundaCutoff = fluidOff ? t0 + 50_000 : scheduleCutoff + 30_000;
  await mapPool(fundaTargets, 2, async (t) => {
    if (Date.now() > fundaCutoff) {
      lanes.funda.failed++;
      unknowns.push({ ticker: t, lane: "funda", reason: "deadline_not_fetched" });
      return;
    }
    const f = await fetchLiveFunda(t, `${t}.NS`, { yahoo: false, deadlineAt: fundaCutoff }).catch(() => null);
    touch("funda");
    if (!f || isDataGapFunda({ fields: f.fields, sources: f.sources, note: f.note })) {
      lanes.funda.failed++;
      unknowns.push({ ticker: t, lane: "funda", reason: f?.screener_error ? `${f.screener_error} (PE/ROE/D-E UNKNOWN)` : "screener_unavailable_or_blocked" });
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
    indices: idx.filter((x) => x.isIndia).map((x) => ({ symbol: x.symbol, name: x.name, close: x.close, prev_close: x.prev_close, chg_pct: x.chg_pct, bar_date: x.bar_date, ...("close_source" in x && x.close_source ? { close_source: x.close_source } : {}) })),
    global_cues: idx.filter((x) => !x.isIndia).map(({ symbol, name, close, chg_pct, bar_date }) => ({ symbol, name, close, chg_pct, as_of: bar_date ? `US close ${bar_date}` : "UNKNOWN" })),
    headlines: (heads.items || []).map((h) => ({ headline: h.headline, source: h.source ?? null, link: h.link ?? null, pubDate: h.pubDate ?? null, confirmation_status: h.confirmation_status })),
    headlines_as_of: new Date().toISOString(),
  };

  const fetchPartial = notScanned.length > 0 || breaker || unknowns.some((u) => u.lane === "tech" && /^(yahoo_429|http_5xx|timeout|network|not_scanned)/.test(u.reason));
  const report = assembleReport(inputs, opts.prev ?? null, {
    lanes,
    unknowns,
    // partial = could not FETCH (429/5xx/timeout/network/not scanned) or (v3.1) any stock / India index
    // without a based_on_close bar after the official-file fill. Permanent holes (404, short history) are UNKNOWN only.
    partial: fetchPartial || (dataGapRules() && missingBars(inputs, unknowns).length > 0),
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    scan_deadline_ms: scheduleCutoff - t0,
    version: opts.version ?? 1,
    supersedes: opts.supersedes ?? null,
    close_fallback: bhav.log.length ? { files: bhav.log } : null,
  });
  return { report, inputs };
}

export function inputsHash(inputs: ReportInputs, method: string = METHOD_VERSION): string {
  return sha256hex(
    canonicalJSON({ universe_sorted: [...inputs.universe].sort(), inputs, budget_inr: BUDGET_INR, risk_pct: RISK_PCT, method_version: method })
  );
}

export function assembleReport(
  inputs: ReportInputs,
  prev: ReportV1 | null,
  meta: {
    lanes: Record<Lane, LaneStat>;
    unknowns: ReportV1["unknowns"];
    partial: boolean;
    generated_at: string;
    elapsed_ms: number;
    scan_deadline_ms: number;
    method_version?: string;
    /** v3.1 only (ignored for older methods so stored reports keep their hash) */
    version?: number;
    supersedes?: ReportSupersedes | null;
    close_fallback?: ReportV1["close_fallback"] | null;
  }
): ReportV1 {
  const method = meta.method_version || METHOD_VERSION;
  const gapRules = dataGapRules(method);
  const { sections, unknownsFromData } = buildSections(inputs, prev, method);
  const allUnknowns = [...meta.unknowns];
  for (const u of unknownsFromData) if (!allUnknowns.some((x) => x.ticker === u.ticker && x.lane === u.lane)) allUnknowns.push(u);
  const version = gapRules ? Math.max(1, meta.version ?? 1) : 1;
  const gap = gapRules ? gapFields(inputs, meta.unknowns, meta.partial, version, meta.supersedes ?? null, meta.close_fallback ?? null, meta.generated_at) : null;
  const body: Omit<ReportV1, "report_hash"> = {
    schema: "stock-lab.report.v1",
    key: reportKey(inputs.for_session, version),
    for_session: inputs.for_session,
    based_on_close: inputs.based_on_close,
    label: `Based on close of ${fmtDayLabel(inputs.based_on_close)} · For session ${fmtDayLabel(inputs.for_session)}`,
    generated_at: meta.generated_at,
    status: meta.partial ? "partial" : "complete",
    method_version: method,
    universe_version: universeVersion(inputs.universe),
    inputs_hash: inputsHash(inputs, method),
    budget_inr: BUDGET_INR,
    risk_pct: RISK_PCT,
    sebi_banner: SEBI_BANNER,
    data_notes: [
      "Prices are NSE daily closes via Yahoo (raw close); pre-open / indicative prices are not used. Levels are from the prior close.",
      levelPolicy(method) === "atr_v2"
        ? "Levels: entry = close, SL = entry − 2.4×ATR14, ATR level T1 = +2×ATR, T2 = +3.5×ATR (risk.ts deriveLevels). Confidence is a gate score, not a probability."
        : "Levels: entry = close, SL = entry − 2.4×ATR14 (R = entry − SL). T1 = at least entry + 1R and T2 = at least entry + 1.8R, moved out to a real resistance (swing high, prior 20-/50-day high) when that is farther. Resistance below entry + 1R blocks the paper buy. Confidence is a gate score, not a probability.",
      "Research / paper setups only — this service is not SEBI-registered.",
      "Sector preference (high-delivery PSU/Infra/Banks/IT/Energy) NOT applied: delivery % is not available from our feeds.",
      ...(fundaGapPolicy(method) === "unknown"
        ? ["Fundamentals missing (Screener unavailable) are shown as UNKNOWN, never estimated; such names are judged on the tape with confidence capped one notch (flag funda_unknown)."]
        : []),
      ...(gapRules
        ? [
            "A missing Yahoo bar for the based-on close is filled only from the official end-of-day file for that exact date (NSE/BSE bhavcopy, NSE index closes) and tagged close_source; otherwise it stays UNKNOWN and the report is marked partial. Index numbers older than that close carry an 'as of' label.",
          ]
        : []),
    ],
    calendar: { source: CALENDAR_SOURCE, holiday_file: HOLIDAY_FILE, ...(calendarVerified(inputs.for_session) ? {} : { unverified: true }) },
    lanes: meta.lanes,
    unknowns: allUnknowns.sort((a, b) => a.lane.localeCompare(b.lane) || a.ticker.localeCompare(b.ticker)),
    timing: { elapsed_ms: meta.elapsed_ms, scan_deadline_ms: meta.scan_deadline_ms },
    ...(gap || {}),
    sections,
  };
  return { ...body, report_hash: reportHash(body) };
}

/** Redis key of a report version: v1 keeps the legacy key, upgrades get `:v<n>`. */
export function reportKey(forSession: string, version = 1): string {
  return version > 1 ? `report:${forSession}:v${version}` : `report:${forSession}`;
}

/** Missing-bar count used to decide whether an upgrade improved on a stored version. */
export function missingCountOf(r: ReportV1): number {
  if (r.incomplete) return r.incomplete.missing_bars.length;
  if (r.status === "complete" && dataGapRules(r.method_version)) return 0;
  return r.unknowns.filter((u) => u.lane === "index" || (u.lane === "tech" && !/^(yahoo_404|short_history|empty|http_other)/.test(u.reason))).length;
}

function gapFields(
  inputs: ReportInputs,
  unknowns: ReportV1["unknowns"],
  partial: boolean,
  version: number,
  supersedes: ReportSupersedes | null,
  closeFallback: ReportV1["close_fallback"] | null,
  generatedAt: string
): Pick<ReportV1, "version" | "supersedes" | "incomplete" | "data_fills" | "close_sources" | "close_fallback" | "version_note"> {
  const missing = missingBars(inputs, unknowns);
  const fills: NonNullable<ReportV1["data_fills"]> = [];
  const sources: Record<string, number> = {};
  for (const t of [...inputs.universe].sort()) {
    const b = inputs.symbols[t]?.bar;
    if (!b) continue;
    const src = b.close_source || "yahoo";
    sources[src] = (sources[src] || 0) + 1;
    if (b.close_source) fills.push({ symbol: t, kind: "stock", date: b.date, close_source: b.close_source, close: b.close });
  }
  for (const ix of inputs.indices) {
    if (!ix.bar_date) continue;
    const src = ix.close_source || "yahoo";
    sources[`index:${src}`] = (sources[`index:${src}`] || 0) + 1;
    if (ix.close_source && typeof ix.close === "number") fills.push({ symbol: ix.symbol, kind: "index", date: ix.bar_date, close_source: ix.close_source, close: ix.close });
  }
  const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(new Date(generatedAt));
  const afterOpen = Date.parse(generatedAt) >= Date.parse(`${inputs.for_session}T09:15:00+05:30`);
  const nS = missing.filter((m) => m.kind === "stock").length;
  const nI = missing.filter((m) => m.kind === "index").length;
  return {
    version,
    supersedes,
    incomplete:
      partial || missing.length
        ? {
            missing_bars: missing,
            n_stocks: nS,
            n_indices: nI,
            note: missing.length
              ? `Incomplete: no ${shortDay(inputs.based_on_close)} bar for ${nS} stock${nS === 1 ? "" : "s"} and ${nI} ${nI === 1 ? "index" : "indices"} (Yahoo, and no official close file filled it). Those names are UNKNOWN, not estimated. A retry later the same day may store an upgraded version.`
              : "Incomplete: some data could not be fetched (see unknowns). A retry later the same day may store an upgraded version.",
          }
        : null,
    data_fills: fills,
    close_sources: sources,
    close_fallback: closeFallback ? { files: [...closeFallback.files].sort((a, b) => a.url.localeCompare(b.url)) } : null,
    version_note:
      version > 1 && supersedes
        ? `Version ${version}, built ${hm} IST${afterOpen ? " (after the session opened)" : ""}; replaces v${supersedes.version} (${supersedes.status}, ${supersedes.missing} missing bars, hash ${supersedes.report_hash.slice(0, 12)}), which is kept for audit.`
        : `Version 1, built ${hm} IST.`,
  };
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
    version: stored.version,
    supersedes: stored.supersedes ?? null,
    close_fallback: stored.close_fallback ?? null,
    lanes: stored.lanes,
    unknowns: stored.unknowns,
    partial: stored.status === "partial",
    generated_at: stored.generated_at,
    elapsed_ms: stored.timing.elapsed_ms,
    scan_deadline_ms: stored.timing.scan_deadline_ms,
    method_version: stored.method_version,
  });
  return { ok: re.report_hash === stored.report_hash && re.inputs_hash === stored.inputs_hash, recomputed_hash: re.report_hash };
}
