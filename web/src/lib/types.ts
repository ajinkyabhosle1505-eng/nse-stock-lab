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
  rsi_14: number | "UNKNOWN";
  price_vs_dma: string;
  dma_20: number | "UNKNOWN";
  dma_50: number | "UNKNOWN";
  dma_200: number | "UNKNOWN";
  volume_vs_avg_20d?: number | "UNKNOWN";
  price_bucket?: string;
  timeframe: string;
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
  };
  news: {
    ticker: string;
    fields: Record<string, unknown>;
    unknowns: string[];
    note: string;
  };
  verdict: Verdict;
}
