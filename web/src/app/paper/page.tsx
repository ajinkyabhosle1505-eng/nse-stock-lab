import { getLedger } from "@/lib/data";
import { inr, num } from "@/lib/format";

export default async function PaperPage() {
  const ledger = await getLedger();
  const summary = ledger.summary || {};

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Paper ledger</h1>
        <p className="mt-1 text-sm text-slate-400">
          {ledger.job_id} · as of {ledger.as_of} · budget {inr(ledger.budget_inr)}
        </p>
        {ledger.note ? (
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{ledger.note}</p>
        ) : null}
      </header>

      <section className="grid grid-cols-2 gap-2">
        <Stat label="Open positions" value={String(summary.open_positions ?? "—")} />
        <Stat label="Notional" value={inr(summary.notional_inr)} />
        <Stat label="Realized P&L" value={inr(summary.realizedPnl)} />
        <Stat
          label="Unrealized P&L"
          value={
            summary.unrealizedPnl === "UNKNOWN" || summary.unrealizedPnl == null
              ? "UNKNOWN"
              : inr(Number(summary.unrealizedPnl))
          }
          warn={summary.unrealizedPnl === "UNKNOWN"}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Fills
        </h2>
        {ledger.fills?.map((f) => {
          const unrealized =
            f.unrealizedPnl === "UNKNOWN" || f.unrealizedPnl == null
              ? "UNKNOWN"
              : inr(Number(f.unrealizedPnl));
          return (
            <article
              key={f.fillId}
              className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4"
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-lg font-semibold text-white">
                    {f.ticker || f.symbol}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {f.side} · {f.status}
                    {f.sector ? ` · ${f.sector}` : ""}
                  </p>
                </div>
                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase text-emerald-300">
                  paper
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Item label="Entry" value={inr(f.entry)} />
                <Item label="SL" value={inr(f.sl)} />
                <Item
                  label="Targets"
                  value={f.targets?.map((t) => num(t)).join(" · ") || "—"}
                />
                <Item label="Qty" value={String(f.qty ?? f.shares ?? "—")} />
                <Item label="Size" value={inr(f.size_inr)} />
                <Item label="Filled" value={formatTime(f.filledAt)} />
                <Item label="Realized" value={inr(f.realizedPnl)} />
                <Item
                  label="Unrealized"
                  value={unrealized}
                  warn={unrealized === "UNKNOWN"}
                />
              </dl>
              {f.mark_note ? (
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{f.mark_note}</p>
              ) : null}
            </article>
          );
        })}
        {!ledger.fills?.length ? (
          <p className="text-sm text-slate-500">No paper fills yet.</p>
        ) : null}
      </section>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-3 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div
        className={`mt-1 text-base font-semibold ${
          warn ? "text-amber-300" : "text-white"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Item({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl bg-slate-950/60 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-0.5 font-medium ${warn ? "text-amber-300" : "text-slate-100"}`}>
        {value}
      </div>
    </div>
  );
}
