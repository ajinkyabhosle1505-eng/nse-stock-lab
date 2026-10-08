/** ReportV1 — brief docs/cos-premarket-report-and-server-paper-plan-2026-09-25.md §2.5 */

export type U = "UNKNOWN";
export type Lane = "tech" | "funda" | "news" | "index";

export interface ReportPick {
  rank: number;
  ticker: string;
  sector: string | null;
  cmp: number;
  action: "buy";
  confidence_1_10: number;
  entry: number;
  sl: number;
  t1: number;
  t2: number | null;
  r_r: number | null;
  shares: number;
  size_inr: number;
  sizing_mode: string;
  plain_why: string;
  risk_flags: string[];
  bar_date: string;
  /** report_v3+ only */
  risk_per_share?: number;
  rr_t1?: number | null;
  rr_t2?: number | null;
  rr_plain?: string;
  t1_basis?: string | null;
  t2_basis?: string | null;
  funda_status?: "verified" | "UNKNOWN (not verified)";
  /** report_v3.1+: only when the bar came from an official EOD file (Yahoo had none) */
  close_source?: string;
  close_label?: string;
}

export interface IndexRow {
  symbol: string;
  name: string;
  close: number | U;
  prev_close: number | U;
  chg_pct: number | U;
  bar_date: string | null;
  /** report_v3.1+ */
  close_source?: string;
  stale?: boolean;
  as_of_label?: string;
}

export interface RrCapped {
  ticker: string;
  sector: string | null;
  cmp: number;
  resistance: number;
  source: string;
  rr_to_resistance: number;
  reason: string;
}

/** report_v3.2+: a buy-rated name priced ₹1000 or more (same gates as Top 10, no price cap). */
export type OtherBuy = ReportPick & { reasons_plain: string[] };

/** report_v3.2+: where a deep-dive name came from. */
export type DeepSource = "top10" | "other_buys" | "buy_set";

/**
 * report_v3.2+: near-miss — would be a paper buy except real resistance caps T1 under 1R.
 * NOT a buy and never paper-bought; the trigger is always above the close.
 */
export interface BreakoutWatch {
  rank: number;
  ticker: string;
  sector: string | null;
  cmp: number;
  label: "watch only — not a buy, no paper buy";
  trigger: number;
  trigger_source: string;
  trigger_text: string;
  /** resistance levels under 1R that the trigger clears (nearest first; the last one is the trigger) */
  levels_cleared: { price: number; source: string }[];
  distance_r: number;
  distance_atr: number | null;
  risk_per_share: number;
  rr_to_resistance: number;
  /** same risk_v3 rules re-applied with entry = trigger; null when they cannot be computed honestly */
  if_breakout: {
    entry: number;
    sl: number;
    t1: number;
    t2: number | null;
    rr_t1: number | null;
    rr_t2: number | null;
    rr_plain: string;
    t1_basis: string | null;
    t2_basis: string | null;
    note: string;
  } | null;
  if_breakout_note?: string;
  risk_flags: string[];
  bar_date: string;
}

export interface LaneStat {
  source: string;
  first_fetch_at: string | null;
  last_fetch_at: string | null;
  ok: number;
  failed: number;
  skipped?: number;
}

export interface ReportV1 {
  schema: "stock-lab.report.v1";
  key: string;
  for_session: string;
  based_on_close: string;
  label: string;
  generated_at: string;
  status: "complete" | "partial";
  method_version: string;
  universe_version: string;
  inputs_hash: string;
  report_hash: string;
  budget_inr: number;
  risk_pct: number;
  sebi_banner: string;
  data_notes: string[];
  calendar: { source: string; holiday_file: string; unverified?: boolean };
  lanes: Record<Lane, LaneStat>;
  unknowns: { ticker: string; lane: Lane; reason: string }[];
  timing: { elapsed_ms: number; scan_deadline_ms: number };
  /** ---- report_v3.1+ (absent on older stored reports) ---- */
  version?: number;
  supersedes?: { key: string; version: number; status: "complete" | "partial"; report_hash: string; inputs_hash: string; missing: number } | null;
  incomplete?: {
    missing_bars: { symbol: string; kind: "stock" | "index"; reason: string; last_bar_date?: string | null }[];
    n_stocks: number;
    n_indices: number;
    note: string;
  } | null;
  data_fills?: { symbol: string; kind: "stock" | "index"; date: string; close_source: string; close: number }[];
  close_sources?: Record<string, number>;
  close_fallback?: { files: { url: string; ok: boolean; error?: string; rows?: number }[] } | null;
  version_note?: string;
  sections: {
    market_overview: {
      indices: IndexRow[];
      data_as_of_note?: string;
      breadth: { scanned: number; above_dma50: number; hh_hl: number; buy: number; hold: number; avoid: number; unknown: number };
      global_cues: { symbol: string; name: string; close: number | U; chg_pct: number | U; as_of: string }[];
      headlines: { headline: string; source: string | null; link: string | null; pubDate: string | null; confirmation_status: string }[];
      headlines_as_of: string;
      not_available: string[];
    };
    top10_under_1000: { items: ReportPick[]; n_eligible: number; note?: string; rr_capped?: RrCapped[] };
    /** report_v3.2+ (absent on older stored reports — never back-filled) */
    other_buys_1000_plus?: { items: OtherBuy[]; n_eligible: number; sector_capped: string[]; rule: string; note?: string };
    deep_dive_top3: {
      items: (ReportPick & {
        /** report_v3.2+ */
        source?: DeepSource;
        source_label?: string;
        tech: Record<string, unknown>;
        funda: Record<string, unknown>;
        news: Record<string, unknown>;
        scenario_path_label: string;
        scenario_path: { dayOffset: number; predictedClose: number }[];
      })[];
      note?: string;
    };
    /** report_v3.2+ (absent on older stored reports) */
    breakout_watch?: { items: BreakoutWatch[]; n_candidates: number; rule: string; label: string; note?: string };
    avoids5: { items: { ticker: string; sector: string | null; cmp: number; reason: string; flags: string[]; severity: string }[]; note?: string };
    penny_under_50: { items: { ticker: string; cmp: number; action: string; note: string }[]; warning: string; note?: string };
    final_summary: {
      counts: Record<string, number>;
      top3: string[];
      changes_vs_prev: { prev_key: string | null; top10_in: string[]; top10_out: string[]; avoids_in: string[]; avoids_out: string[] };
      headline: string;
      /** report_v3.2+ */
      other_buys?: string[];
      breakout_watch?: string[];
    };
  };
}
