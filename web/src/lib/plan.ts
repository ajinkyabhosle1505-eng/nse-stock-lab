import type { Verdict } from "./types";

/**
 * Ensure plan fields exist. For static fixture verdicts, derive:
 * buy_trigger ← entry, sell_targets ← targets, stop_invalidation ← sl
 */
export function enrichPlanFields<T extends Verdict>(v: T): T {
  const buy_trigger =
    v.buy_trigger != null && v.buy_trigger !== ""
      ? v.buy_trigger
      : v.entry ?? null;
  const sell_targets =
    v.sell_targets && v.sell_targets.length
      ? v.sell_targets
      : v.targets ?? [];
  const stop_invalidation =
    v.stop_invalidation != null ? v.stop_invalidation : v.sl ?? null;
  const time_horizon =
    v.time_horizon != null && v.time_horizon !== ""
      ? v.time_horizon
      : "2–6 weeks (swing)";

  return {
    ...v,
    buy_trigger,
    sell_targets,
    stop_invalidation,
    time_horizon,
  };
}

export function enrichVerdicts(list: Verdict[]): Verdict[] {
  return list.map(enrichPlanFields);
}
