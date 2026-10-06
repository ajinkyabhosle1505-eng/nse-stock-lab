/**
 * "As of" labels for numbers older than the report's based_on_close (report_v3.1).
 * Pure + client-safe: used by the report builder (stored in v3.1 reports) and by the
 * UI (computed at render time for older stored reports, which have no stored label).
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-01" → "1 Oct" */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return m >= 1 && m <= 12 && d ? `${d} ${MONTHS[m - 1]}` : iso;
}

export interface IndexLike {
  bar_date: string | null;
  close_source?: string;
}

const SOURCE_NAME: Record<string, string> = {
  nse_index_close: "NSE official index close",
  nse_bhavcopy: "NSE bhavcopy",
  bse_bhavcopy: "BSE bhavcopy",
};

/**
 * Label for an index row, or null when it is a normal Yahoo bar for based_on_close.
 *   older bar   → { stale: true,  "Index data as of 1 Oct (Yahoo had no 5 Oct bar)" }
 *   no bar      → { stale: true,  "Index data UNKNOWN (Yahoo had no 5 Oct bar)" }
 *   filled bar  → { stale: false, "NSE official index close for 5 Oct (Yahoo had no 5 Oct bar)" }
 */
export function indexAsOf(ix: IndexLike, basedOnClose: string): { stale: boolean; label: string } | null {
  const want = shortDay(basedOnClose);
  if (!ix.bar_date) return { stale: true, label: `Index data UNKNOWN (Yahoo had no ${want} bar)` };
  if (ix.bar_date < basedOnClose) return { stale: true, label: `Index data as of ${shortDay(ix.bar_date)} (Yahoo had no ${want} bar)` };
  if (ix.close_source && ix.close_source !== "yahoo") {
    return { stale: false, label: `${SOURCE_NAME[ix.close_source] || ix.close_source} for ${want} (Yahoo had no ${want} bar)` };
  }
  return null;
}

/** Label for a stock bar used in a report (only non-null when older than based_on_close or filled). */
export function barAsOf(barDate: string | null | undefined, basedOnClose: string, closeSource?: string): string | null {
  if (!barDate) return null;
  if (barDate < basedOnClose) return `Price as of ${shortDay(barDate)} (no ${shortDay(basedOnClose)} bar)`;
  if (closeSource && closeSource !== "yahoo") return `Close from ${SOURCE_NAME[closeSource] || closeSource} (Yahoo had no ${shortDay(basedOnClose)} bar)`;
  return null;
}
