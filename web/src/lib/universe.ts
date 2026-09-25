/** Live budget-picks universe — multi-sector liquid NSE names. Do not invent prices. */

export const BUDGET_UNIVERSE = [
  // Banks (mix of affordable + liquid)
  "SBIN",
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "PNB",
  "BANKBARODA",
  "CANBK",
  // Energy / Oil / Power
  "ONGC",
  "NTPC",
  "COALINDIA",
  "RELIANCE",
  "IOC",
  "BPCL",
  "POWERGRID",
  "TATAPOWER",
  // IT
  "INFY",
  "TCS",
  "WIPRO",
  // Pharma
  "SUNPHARMA",
  "CIPLA",
  // Auto
  "TMPV", // Tata Motors Passenger Vehicles (TATAMOTORS.NS delisted on Yahoo after demerger; TMPV.NS verified 2026-09-25)
  "MARUTI",
  // FMCG
  "ITC",
  "HINDUNILVR",
  // Metals
  "TATASTEEL",
  "NMDC",
  "VEDL",
  // Infra / NBFC / Cap goods
  "LT",
  "IRFC",
  "PFC",
  "RECLTD",
  // Defence / Telecom
  "BEL",
  "BHARTIARTL",
] as const;

export type UniverseTicker = (typeof BUDGET_UNIVERSE)[number];

const SECTOR: Record<string, string> = {
  SBIN: "Banks",
  HDFCBANK: "Banks",
  ICICIBANK: "Banks",
  AXISBANK: "Banks",
  PNB: "Banks",
  BANKBARODA: "Banks",
  CANBK: "Banks",
  ONGC: "Energy",
  NTPC: "Energy",
  COALINDIA: "Energy",
  RELIANCE: "Energy",
  IOC: "Energy",
  BPCL: "Energy",
  POWERGRID: "Energy",
  TATAPOWER: "Energy",
  INFY: "IT",
  TCS: "IT",
  WIPRO: "IT",
  SUNPHARMA: "Pharma",
  CIPLA: "Pharma",
  TMPV: "Auto",
  MARUTI: "Auto",
  ITC: "FMCG",
  HINDUNILVR: "FMCG",
  TATASTEEL: "Metals",
  NMDC: "Metals",
  VEDL: "Metals",
  LT: "Infra",
  IRFC: "Infra",
  PFC: "Infra",
  RECLTD: "Infra",
  BEL: "Defence",
  BHARTIARTL: "Telecom",
  // legacy / penny watch (may appear in fixtures)
  YESBANK: "Banks",
  IDEA: "Telecom",
};

/** Soft-demote mega-PSU names that otherwise own every top-N list. */
export const MEGA_PSU_DEMOTE = new Set([
  "PNB",
  "COALINDIA",
  "SBIN",
  "ONGC",
  "NTPC",
]);

/** @deprecated P0b — sector preference neutralized; kept for label only. */
const PREFERRED_SECTORS = new Set<string>();

const PENNY_WATCH = new Set(["YESBANK", "IDEA"]);

/** Budgets at or below this use micro 1-share floor when risk sizing yields 0. */
export const MICRO_BUDGET_INR = 2500;

/** Budget ≤ this → max 1 pick per sector; otherwise max 2. */
export const TIGHT_SECTOR_BUDGET_INR = 5000;

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

export function isMegaPsuDemote(ticker: string): boolean {
  return MEGA_PSU_DEMOTE.has(ticker.toUpperCase());
}

export const SEBI_BANNER =
  "Not SEBI-registered advice. Paper / research only. Levels are not a recommendation to buy or sell.";
