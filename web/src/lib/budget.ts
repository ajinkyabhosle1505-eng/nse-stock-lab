export const BUDGET_KEY = "stock-lab.budget_inr";
export const DEFAULT_BUDGET = 10000;
/** Includes micro chips for P0a sizing demos. */
export const BUDGET_CHIPS = [100, 500, 1000, 5000, 10000, 25000, 50000] as const;

export function readBudget(): number {
  if (typeof window === "undefined") return DEFAULT_BUDGET;
  const raw = window.localStorage.getItem(BUDGET_KEY);
  const n = raw != null ? Number(raw) : DEFAULT_BUDGET;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
}

export function writeBudget(n: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(BUDGET_KEY, String(n));
}
