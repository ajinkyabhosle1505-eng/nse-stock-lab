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
  sections: {
    market_overview: {
      indices: { symbol: string; name: string; close: number | U; prev_close: number | U; chg_pct: number | U; bar_date: string | null }[];
      breadth: { scanned: number; above_dma50: number; hh_hl: number; buy: number; hold: number; avoid: number; unknown: number };
      global_cues: { symbol: string; name: string; close: number | U; chg_pct: number | U; as_of: string }[];
      headlines: { headline: string; source: string | null; link: string | null; pubDate: string | null; confirmation_status: string }[];
      headlines_as_of: string;
      not_available: string[];
    };
    top10_under_1000: { items: ReportPick[]; n_eligible: number; note?: string };
    deep_dive_top3: {
      items: (ReportPick & {
        tech: Record<string, unknown>;
        funda: Record<string, unknown>;
        news: Record<string, unknown>;
        scenario_path_label: string;
        scenario_path: { dayOffset: number; predictedClose: number }[];
      })[];
      note?: string;
    };
    avoids5: { items: { ticker: string; sector: string | null; cmp: number; reason: string; flags: string[]; severity: string }[]; note?: string };
    penny_under_50: { items: { ticker: string; cmp: number; action: string; note: string }[]; warning: string; note?: string };
    final_summary: {
      counts: Record<string, number>;
      top3: string[];
      changes_vs_prev: { prev_key: string | null; top10_in: string[]; top10_out: string[]; avoids_in: string[]; avoids_out: string[] };
      headline: string;
    };
  };
}
