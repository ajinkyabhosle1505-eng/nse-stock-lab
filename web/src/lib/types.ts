export type Action = "buy" | "hold" | "avoid" | string;

export interface Verdict {
  ticker: string;
  action: Action;
  confidence_1_10: number;
  entry: number | null;
  sl: number | null;
  targets: number[];
  size_inr: number | null;
  shares?: number | null;
  r_r?: number | null;
  reasons?: string[];
  risk_flags?: string[];
  avoids_note?: string | null;
  insufficient_data?: boolean;
  sebi_banner?: string;
  cmp?: number | null | "UNKNOWN";
  under_1000?: boolean;
  penny_under_50?: boolean;
  sector?: string | null;
  /** Plan fields */
  buy_trigger?: number | string | null;
  sell_targets?: number[];
  stop_invalidation?: number | null;
  time_horizon?: string | null;
  live?: boolean;
  yahoo_symbol?: string;
  note?: string;
  sizing_mode?: "risk_pct" | "afford_one_share" | string;
  /** Plain-language why buy (budget picks). */
  plain_why?: string;
}

export interface SkippedSample {
  ticker: string;
  action: string;
  sector?: string | null;
  cmp?: number | null;
  plain_why_skip: string;
}

export interface VerdictsFile {
  job_id: string;
  as_of: string;
  budget_inr: number;
  sebi_banner?: string;
  counts?: Record<string, number>;
  verdicts: Verdict[];
  MarketOverview?: Record<string, unknown>;
}

export interface LaneResult {
  ticker: string;
  fields: Record<string, unknown>;
  unknowns?: string[];
  sources?: string[];
  ts?: string;
}

export interface LaneFile {
  job_id?: string;
  as_of?: string;
  lane?: string;
  results: LaneResult[];
  MarketOverview?: Record<string, unknown>;
}

export interface Fill {
  fillId: string;
  ticker: string;
  symbol?: string;
  side: string;
  action?: string;
  entry: number;
  sl?: number;
  targets?: number[];
  qty: number;
  shares?: number;
  size_inr: number;
  filledAt: string;
  status: string;
  unrealizedPnl: number | string;
  realizedPnl?: number;
  sector?: string;
  confidence_1_10?: number;
  mark?: number | null;
  mark_note?: string;
}

/** Paper forecast point — Stock Research brief atr_piecewise_T1_T2_v1 */
export type ForecastPointStatus = "pending" | "scored" | "sparse" | "error";

export interface ForecastPoint {
  dayOffset: number;
  predictedClose: number;
  targetDate: string;
  actualClose: number | null;
  actualSessionDate: string | null;
  ape_pct: number | null;
  within_1atr: boolean | null;
  within_2pct: boolean | null;
  within_0_5r: boolean | null;
  direction_ok: boolean | null;
  status: ForecastPointStatus;
  tradingDayIndex?: number | null;
  corporate_action_suspect?: boolean;
}

export interface ForecastScoreSummary {
  n_scored: number;
  mape_pct: number | null;
  hit_within_1atr_pct: number | null;
  hit_within_2pct_pct: number | null;
  hit_within_0_5r_pct: number | null;
  directional_pct: number | null;
  by_horizon: {
    bucket: "le7" | "8to21" | "ge22";
    n: number;
    mape_pct: number | null;
    hit_within_1atr_pct: number | null;
    directional_pct: number | null;
  }[];
  touched_t1: boolean | null;
  touched_t2: boolean | null;
  touched_sl: boolean | null;
  lastMarkedAt: string | null;
}

export interface ForecastBundle {
  method: "atr_piecewise_T1_T2_v1";
  status?: "ok" | "skipped";
  skip_reason?: string;
  createdAt: string;
  params: {
    entry: number;
    sl: number;
    t1: number;
    t2: number;
    atr_14: number;
    R: number;
    d_T1: number;
    d_T2: number;
    scale: number;
    structure?: string;
    breakout_state?: string;
  };
  checkDays: number[];
  points: ForecastPoint[];
  scoreSummary: ForecastScoreSummary;
}

export type PaperFillWithForecast = Fill & {
  yahoo_symbol: string;
  budget_inr?: number;
  forecast?: ForecastBundle | null;
};

/** Client-stored paper forecast position (localStorage MVP). */
export interface PaperForecastPosition {
  id: string;
  ticker: string;
  yahoo_symbol: string;
  entry: number;
  sl: number | null;
  targets: number[];
  qty: number;
  budget_inr: number;
  size_inr: number;
  boughtAt: string;
  sector?: string | null;
  checkDays: number[];
  atr_14?: number | null;
  structure?: string;
  breakout_state?: string;
  sebi_banner: string;
  forecast: ForecastBundle | null;
}

export interface LedgerFile {
  job_id: string;
  as_of: string;
  budget_inr: number;
  sebi_banner?: string;
  note?: string;
  fills: Fill[];
  positions?: Array<Record<string, unknown>>;
  summary?: {
    open_positions?: number;
    notional_inr?: number;
    allocated_size_inr?: number;
    realizedPnl?: number;
    unrealizedPnl?: number | string;
  };
}

export interface TechFields {
  cmp: number | "UNKNOWN";
  atr_14: number | "UNKNOWN";
  support_levels: number[];
  resistance_levels: number[];
  structure: string;
  breakout_state: string;
  breakout_level?: number | "UNKNOWN";
  /** Nearest reclaim: active breakout_level or dma_20 */
  trigger_level?: number | "UNKNOWN";
  rsi_14: number | "UNKNOWN";
  price_vs_dma: string;
  dma_20: number | "UNKNOWN";
  dma_50: number | "UNKNOWN";
  dma_200: number | "UNKNOWN";
  volume_vs_avg_20d?: number | "UNKNOWN";
  price_bucket?: string;
  timeframe: string;
  /** Last ~30 daily closes for sparkline (P1b). */
  closes_30d?: number[];
}

export interface TechLane {
  ticker: string;
  yahoo_symbol: string;
  fields: TechFields;
  unknowns: string[];
  sources: string[];
  ts: string;
}

export interface LookupResponse {
  ticker: string;
  yahoo_symbol: string;
  as_of: string;
  sebi_banner: string;
  tech: TechLane;
  funda: {
    ticker: string;
    fields: Record<string, unknown>;
    unknowns: string[];
    note: string;
    sources?: string[];
  };
  news: {
    ticker: string;
    fields: Record<string, unknown>;
    unknowns: string[];
    note: string;
    sources?: string[];
  };
  verdict: Verdict;
}
