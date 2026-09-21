/** Live budget-picks universe (~20–25 NSE names). Do not invent prices. */

export const BUDGET_UNIVERSE = [
  "SBIN",
  "BANKBARODA",
  "PNB",
  "CANBK",
  "HDFCBANK",
  "ONGC",
  "NTPC",
  "POWERGRID",
  "COALINDIA",
  "IOC",
  "BPCL",
  "IRFC",
  "RECLTD",
  "PFC",
  "NMDC",
  "VEDL",
  "TATAPOWER",
  "ITC",
  "WIPRO",
  "RELIANCE",
  "YESBANK",
  "IDEA",
] as const;

export type UniverseTicker = (typeof BUDGET_UNIVERSE)[number];

const SECTOR: Record<string, string> = {
  SBIN: "Banks",
  BANKBARODA: "Banks",
  PNB: "Banks",
  CANBK: "Banks",
  HDFCBANK: "Banks",
  YESBANK: "Banks",
  ONGC: "Energy",
  NTPC: "Energy",
  POWERGRID: "Energy",
  COALINDIA: "Energy",
  IOC: "Energy",
  BPCL: "Energy",
  TATAPOWER: "Energy",
  RELIANCE: "Energy",
  IRFC: "Infra",
  RECLTD: "Infra",
  PFC: "Infra",
  NMDC: "Metals",
  VEDL: "Metals",
  ITC: "FMCG",
  WIPRO: "IT",
  IDEA: "Telecom",
};

/** Preferred when tape supports: PSU / Infra / Banks / Energy */
const PREFERRED_SECTORS = new Set(["Banks", "Energy", "Infra"]);

const PENNY_WATCH = new Set(["YESBANK", "IDEA"]);

export function sectorOf(ticker: string): string {
  return SECTOR[ticker.toUpperCase()] || "Unknown";
}

export function isPreferredSector(ticker: string): boolean {
  return PREFERRED_SECTORS.has(sectorOf(ticker));
}

export function isPennyWatch(ticker: string): boolean {
  return PENNY_WATCH.has(ticker.toUpperCase());
}

export const SEBI_BANNER =
  "Not SEBI-registered advice. Paper / research only. Levels are not a recommendation to buy or sell.";
