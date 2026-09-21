export function inr(n: number | null | undefined | "UNKNOWN"): string {
  if (n == null || n === "UNKNOWN" || (typeof n === "number" && Number.isNaN(n)))
    return n === "UNKNOWN" ? "UNKNOWN" : "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
}

export function num(
  n: number | null | undefined | "UNKNOWN",
  digits = 2
): string {
  if (n == null || n === "UNKNOWN" || (typeof n === "number" && Number.isNaN(n)))
    return n === "UNKNOWN" ? "UNKNOWN" : "—";
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: digits,
  }).format(n);
}

export function actionClass(action: string): string {
  const a = (action || "").toLowerCase();
  if (a === "buy") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/40";
  if (a === "hold") return "bg-amber-500/15 text-amber-400 border-amber-500/40";
  if (a === "avoid") return "bg-rose-500/15 text-rose-400 border-rose-500/40";
  return "bg-slate-500/15 text-slate-300 border-slate-500/40";
}

export function actionDot(action: string): string {
  const a = (action || "").toLowerCase();
  if (a === "buy") return "bg-emerald-400";
  if (a === "hold") return "bg-amber-400";
  if (a === "avoid") return "bg-rose-400";
  return "bg-slate-400";
}

export function planLevels(v: {
  buy_trigger?: number | string | null;
  entry?: number | null;
  sell_targets?: number[];
  targets?: number[];
  stop_invalidation?: number | null;
  sl?: number | null;
  time_horizon?: string | null;
}): {
  buy_trigger: string;
  sell_targets: string;
  stop_invalidation: string;
  time_horizon: string;
} {
  const bt = v.buy_trigger ?? v.entry;
  const st = v.sell_targets?.length ? v.sell_targets : v.targets;
  const si = v.stop_invalidation ?? v.sl;
  return {
    buy_trigger:
      typeof bt === "string" ? bt : bt != null ? inr(bt) : "—",
    sell_targets: st?.length ? st.map((t) => num(t)).join(" · ") : "—",
    stop_invalidation: si != null ? inr(si) : "—",
    time_horizon: v.time_horizon || "2–6 weeks (swing)",
  };
}
