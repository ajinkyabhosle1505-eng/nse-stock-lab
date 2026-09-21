export function inr(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
}

export function num(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
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
