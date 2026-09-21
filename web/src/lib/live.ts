/**
 * Live lookup / budget-picks orchestrator.
 * Tech: in-process Yahoo + computeTech.
 * Funda/News: desk Python scrapers (never invent numbers).
 * Risk: mergeVerdict(tech, { budget_inr, risk_pct, funda, news }).
 */

import { spawn } from "child_process";
import { fetchYahooHistory, normalizeNseSymbol } from "./yahoo";
import { computeTech, unknownTech } from "./tech";
import {
  mergeVerdict,
  pickScore,
  sizePosition,
  type LaneStub,
} from "./risk";
import { BUDGET_UNIVERSE, SEBI_BANNER } from "./universe";
import type { LookupResponse, Verdict } from "./types";

const FUNDA_SCRIPT = "/workspace/stock-lab/funda/scrape_one.py";
const NEWS_SCRIPT = "/workspace/stock-lab/news/scrape_one.py";
const SCRAPE_TIMEOUT_MS = 20_000;

export interface LookupOpts {
  budget_inr?: number;
  risk_pct?: number;
  /** Spawn funda scrape_one.py (default true). */
  funda?: boolean;
  /** Spawn news scrape_one.py (default true for single lookup). */
  news?: boolean;
}

function unknownLane(ticker: string, note: string, keys: string[]): LaneStub {
  return {
    ticker,
    fields: {},
    unknowns: keys,
    sources: [],
    note,
  };
}

/** Spawn desk scrape_one.py; on fail/timeout → unknowns[]. Never invents. */
function runScrapeOne(
  script: string,
  ticker: string,
  timeoutMs = SCRAPE_TIMEOUT_MS
): Promise<LaneStub> {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, ticker], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (lane: LaneStub) => {
      if (settled) return;
      settled = true;
      resolve(lane);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(
        unknownLane(ticker, `scrape timeout after ${timeoutMs}ms (${script})`, [
          "scrape_timeout",
        ])
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(
        unknownLane(ticker, `scrape spawn error: ${err.message}`, [
          "scrape_spawn_error",
        ])
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as {
          ticker?: string;
          fields?: Record<string, unknown>;
          unknowns?: string[];
          sources?: string[];
          note?: string;
          ts?: string;
        };
        finish({
          ticker: parsed.ticker || ticker,
          fields: parsed.fields || {},
          unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns : [],
          sources: Array.isArray(parsed.sources) ? parsed.sources : [],
          note: parsed.note,
        });
      } catch {
        finish(
          unknownLane(
            ticker,
            `scrape parse/fail (exit ${code}): ${(stderr || stdout).slice(0, 240) || "empty"}`,
            ["scrape_failed"]
          )
        );
      }
    });
  });
}

function laneToResponse(
  lane: LaneStub,
  ticker: string
): LookupResponse["funda"] {
  return {
    ticker: lane.ticker || ticker,
    fields: lane.fields || {},
    unknowns: lane.unknowns || [],
    note:
      lane.note ||
      (lane.sources?.length
        ? `sources: ${lane.sources.join(" · ")}`
        : "live scrape"),
    sources: lane.sources,
  };
}

export async function runLookup(
  symbolRaw: string,
  opts: LookupOpts = {}
): Promise<LookupResponse> {
  const { ticker, yahoo } = normalizeNseSymbol(symbolRaw);
  const hist = await fetchYahooHistory(yahoo);
  const tech = hist
    ? computeTech(ticker, hist)
    : unknownTech(ticker, yahoo);

  const wantFunda = opts.funda !== false;
  const wantNews = opts.news !== false;

  const [funda, news] = await Promise.all([
    wantFunda
      ? runScrapeOne(FUNDA_SCRIPT, ticker)
      : Promise.resolve(
          unknownLane(ticker, "Funda scrape skipped", [
            "pe_ttm",
            "roe_pct",
            "debt_equity",
            "funda_quality",
          ])
        ),
    wantNews
      ? runScrapeOne(NEWS_SCRIPT, ticker)
      : Promise.resolve(
          unknownLane(ticker, "News scrape skipped", [
            "headline",
            "confirmation_status",
            "why_for_verdict",
          ])
        ),
  ]);

  const verdict = mergeVerdict(tech, {
    budget_inr: opts.budget_inr ?? 10000,
    risk_pct: opts.risk_pct ?? 1,
    funda,
    news,
  });

  return {
    ticker,
    yahoo_symbol: yahoo,
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    tech,
    funda: laneToResponse(funda, ticker),
    news: laneToResponse(news, ticker),
    verdict,
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export interface BudgetPicksResult {
  budget_inr: number;
  risk_pct: number;
  risk_inr: number;
  as_of: string;
  sebi_banner: string;
  universe: string[];
  picks: Verdict[];
  scanned: number;
  note: string;
}

/**
 * Scan universe with live Yahoo tech + funda scrape + risk.
 * News skipped for speed (prefer at least Screener funda per ticker).
 */
export async function runBudgetPicks(
  budget_inr: number,
  risk_pct: number
): Promise<BudgetPicksResult> {
  const universe = [...BUDGET_UNIVERSE];
  const lookups = await mapPool(universe, 3, async (sym) => {
    try {
      return await runLookup(sym, {
        budget_inr,
        risk_pct,
        funda: true,
        news: false,
      });
    } catch {
      return null;
    }
  });

  const buys: Verdict[] = [];
  for (const lu of lookups) {
    if (!lu) continue;
    const v = lu.verdict;
    if (v.action !== "buy") continue;
    if (v.entry == null || v.sl == null) continue;
    const sized = sizePosition({
      budget_inr,
      risk_pct,
      entry: v.entry,
      sl: v.sl,
    });
    if (!sized.ok) continue;
    if (sized.shares < 1) continue;
    if (v.entry * sized.shares > budget_inr) continue;
    buys.push({
      ...v,
      shares: sized.shares,
      size_inr: sized.size_inr,
      buy_trigger: v.buy_trigger ?? v.entry,
      sell_targets: v.sell_targets?.length ? v.sell_targets : v.targets,
      stop_invalidation: v.stop_invalidation ?? v.sl,
      time_horizon: v.time_horizon ?? "2–6 weeks (swing)",
    });
  }

  buys.sort((a, b) => pickScore(b) - pickScore(a));

  return {
    budget_inr,
    risk_pct,
    risk_inr: budget_inr * (risk_pct / 100),
    as_of: new Date().toISOString(),
    sebi_banner: SEBI_BANNER,
    universe,
    picks: buys.slice(0, 10),
    scanned: universe.length,
    note: "Live Yahoo tech + funda scrape_one.py + TS mergeVerdict (news skipped for speed).",
  };
}
