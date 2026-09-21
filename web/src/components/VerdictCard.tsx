import Link from "next/link";
import type { Verdict } from "@/lib/types";
import { actionClass, actionDot, inr, num } from "@/lib/format";

export default function VerdictCard({ v }: { v: Verdict }) {
  return (
    <Link
      href={`/ideas/${encodeURIComponent(v.ticker)}`}
      className="block rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-sm transition hover:border-slate-600 active:scale-[0.99]"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${actionDot(v.action)}`} />
            <h2 className="text-lg font-semibold tracking-tight text-white">{v.ticker}</h2>
          </div>
          {v.sector ? (
            <p className="mt-0.5 text-xs text-slate-400">{v.sector}</p>
          ) : null}
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${actionClass(
            v.action
          )}`}
        >
          {v.action}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <Metric label="Confidence" value={`${v.confidence_1_10}/10`} />
        <Metric label="Entry" value={inr(v.entry ?? undefined)} />
        <Metric label="SL" value={inr(v.sl ?? undefined)} />
        <Metric
          label="Targets"
          value={
            v.targets?.length
              ? v.targets.map((t) => num(t)).join(" · ")
              : "—"
          }
        />
        <Metric label="Size" value={inr(v.size_inr ?? undefined)} />
        {v.shares != null ? <Metric label="Shares" value={String(v.shares)} /> : null}
      </div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950/60 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 font-medium text-slate-100">{value}</div>
    </div>
  );
}
