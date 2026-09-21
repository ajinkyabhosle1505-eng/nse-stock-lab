/** Live budget-picks universe (~22–25 NSE names across sectors). Do not invent prices. */

export const BUDGET_UNIVERSE = [
  // Banks
  "SBIN",
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "PNB",
  // Energy / Oil
  "ONGC",
  "NTPC",
  "COALINDIA",
  "RELIANCE",
  // IT
  "INFY",
  "TCS",
  "WIPRO",
  // Pharma
  "SUNPHARMA",
  "CIPLA",
  // Auto
  "TATAMOTORS",
  "MARUTI",
  // FMCG
  "ITC",
  "HINDUNILVR",
  // Metals
  "TATASTEEL",
  "NMDC",
  // Infra / Capital goods
  "LT",
  "IRFC",
  // Telecom
  "BHARTIARTL",
] as const;

export type UniverseTicker = (typeof BUDGET_UNIVERSE)[number];

const SECTOR: Record<string, string> = {
  SBIN: "Banks",
  HDFCBANK: "Banks",
  ICICIBANK: "Banks",
  AXISBANK: "Banks",
  PNB: "Banks",
  ONGC: "Energy",
  NTPC: "Energy",
  COALINDIA: "Energy",
  RELIANCE: "Energy",
  INFY: "IT",
  TCS: "IT",
  WIPRO: "IT",
  SUNPHARMA: "Pharma",
  CIPLA: "Pharma",
  TATAMOTORS: "Auto",
  MARUTI: "Auto",
  ITC: "FMCG",
  HINDUNILVR: "FMCG",
  TATASTEEL: "Metals",
  NMDC: "Metals",
  LT: "Infra",
  IRFC: "Infra",
  BHARTIARTL: "Telecom",
  // legacy / penny watch (may appear in fixtures)
  YESBANK: "Banks",
  IDEA: "Telecom",
  BANKBARODA: "Banks",
  CANBK: "Banks",
  POWERGRID: "Energy",
  IOC: "Energy",
  BPCL: "Energy",
  TATAPOWER: "Energy",
  RECLTD: "Infra",
  PFC: "Infra",
  VEDL: "Metals",
};

/** @deprecated P0b — sector preference neutralized; kept for label only. */
const PREFERRED_SECTORS = new Set<string>();

const PENNY_WATCH = new Set(["YESBANK", "IDEA"]);

/** Budgets at or below this use micro 1-share floor when risk sizing yields 0. */
export const MICRO_BUDGET_INR = 2500;

export function sectorOf(ticker: string): string {
  return SECTOR[ticker.toUpperCase()] || "Unknown";
}

/** Always false after P0b neutralize — kept so call sites compile. */
export function isPreferredSector(_ticker: string): boolean {
  return PREFERRED_SECTORS.has(sectorOf(_ticker));
}

export function isPennyWatch(ticker: string): boolean {
  return PENNY_WATCH.has(ticker.toUpperCase());
}

export const SEBI_BANNER =
  "Not SEBI-registered advice. Paper / research only. Levels are not a recommendation to buy or sell.";
