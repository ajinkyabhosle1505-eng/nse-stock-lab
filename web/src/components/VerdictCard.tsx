import Link from "next/link";
import type { Verdict } from "@/lib/types";
import { actionClass, actionDot, inr, num, planLevels } from "@/lib/format";
import { enrichPlanFields } from "@/lib/plan";

export default function VerdictCard({
  v,
  href,
}: {
  v: Verdict;
  href?: string;
}) {
  const verd = enrichPlanFields(v);
  const plan = planLevels(verd);
  const link =
    href ??
    (verd.live
      ? `/ideas/${encodeURIComponent(verd.ticker)}?live=1`
      : `/ideas/${encodeURIComponent(verd.ticker)}`);

  return (
    <Link
      href={link}
      className="block rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-sm transition hover:border-slate-600 active:scale-[0.99]"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${actionDot(verd.action)}`} />
            <h2 className="text-lg font-semibold tracking-tight text-white">
              {verd.ticker}
            </h2>
            {verd.live ? (
              <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-300">
                live
              </span>
            ) : null}
          </div>
          {verd.sector ? (
            <p className="mt-0.5 text-xs text-slate-400">{verd.sector}</p>
          ) : null}
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${actionClass(
            verd.action
          )}`}
        >
          {verd.action}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <Metric label="Confidence" value={`${verd.confidence_1_10}/10`} />
        <Metric label="Entry" value={inr(verd.entry ?? undefined)} />
        <Metric label="SL" value={inr(verd.sl ?? undefined)} />
        <Metric
          label="Targets"
          value={
            verd.targets?.length
              ? verd.targets.map((t) => num(t)).join(" · ")
              : "—"
          }
        />
        <Metric label="Size" value={inr(verd.size_inr ?? undefined)} />
        {verd.shares != null ? (
          <Metric label="Shares" value={String(verd.shares)} />
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <Metric label="Buy trigger" value={plan.buy_trigger} />
        <Metric label="Stop invalidation" value={plan.stop_invalidation} />
        <Metric label="Sell targets" value={plan.sell_targets} />
        <Metric label="Horizon" value={plan.time_horizon} />
      </div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950/60 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 font-medium text-slate-100">{value}</div>
    </div>
  );
}
