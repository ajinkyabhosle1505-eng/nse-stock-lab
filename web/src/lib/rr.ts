/**
 * Plain-language risk:reward line (client-safe, no I/O).
 * risk_v3: R = entry − SL; T1 ≥ entry + 1R, T2 ≥ entry + 1.8R.
 */

export const RR_T1_MIN = 1.0;
export const RR_T2_MIN = 1.8;

function amt(n: number): string {
  const a = Math.abs(n);
  const d = a < 10 ? 2 : a < 100 ? 1 : 0;
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(Number(a.toFixed(d)))}`;
}

export function rrOf(entry: number, sl: number, target: number | null | undefined): number | null {
  const risk = entry - sl;
  if (!(risk > 0) || target == null || !Number.isFinite(target)) return null;
  return Math.round(((target - entry) / risk) * 100) / 100;
}

/** e.g. "Risk ₹15.9 to stop, ₹16 to T1 (1.0R), ₹28.7 to T2 (1.8R)". null when entry/SL unknown. */
export function rrPlain(
  entry: number | null | undefined,
  sl: number | null | undefined,
  t1: number | null | undefined,
  t2?: number | null
): string | null {
  if (entry == null || sl == null || !Number.isFinite(entry) || !Number.isFinite(sl)) return null;
  const risk = entry - sl;
  if (!(risk > 0)) return null;
  const parts = [`Risk ${amt(risk)} to stop`];
  if (t1 != null && Number.isFinite(t1)) parts.push(`${amt(t1 - entry)} to T1 (${((t1 - entry) / risk).toFixed(1)}R)`);
  else parts.push("T1 UNKNOWN");
  if (t2 != null && Number.isFinite(t2)) parts.push(`${amt(t2 - entry)} to T2 (${((t2 - entry) / risk).toFixed(1)}R)`);
  return parts.join(", ");
}
