import { getDailyReport } from "@/lib/data";
import { inr } from "@/lib/format";

export default async function ReportPage() {
  const report = await getDailyReport();
  const sections = (report.sections || {}) as Record<string, Record<string, unknown>>;
  const market = sections["1_market_overview"] || {};
  const top10 = (sections["2_top10_under_1000"]?.items || []) as Array<Record<string, unknown>>;
  const deep = (sections["3_deep_dive_top3"]?.items || []) as Array<Record<string, unknown>>;
  const avoids = (sections["4_five_avoids"]?.items || []) as Array<Record<string, unknown>>;
  const penny = sections["5_penny_under_50"] || {};
  const pennyItems = (
    ((penny.items as unknown[])?.length
      ? penny.items
      : penny.avoided_pennies) || []
  ) as Array<Record<string, unknown>>;
  const summary = sections["6_final_summary"] || {};

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Daily report</h1>
        <p className="mt-1 text-sm text-slate-400">
          {(report.report_id as string) || "report"} · as of {String(report.as_of || "—")}
        </p>
      </header>

      <Card title="Market overview">
        <p className="text-sm leading-relaxed text-slate-300">
          {String(market.indices_note || "—")}
        </p>
        <BulletList title="Global cues" items={asStringArray(market.global_cues)} />
        <BulletList title="Policy watch" items={asStringArray(market.policy_watch)} />
        <BulletList title="Sector flows" items={asStringArray(market.sector_flows)} />
      </Card>

      <Card title="Top under ₹1000">
        <div className="space-y-2">
          {top10.map((item, i) => (
            <Row
              key={String(item.ticker || i)}
              left={String(item.ticker || "—")}
              mid={`${String(item.action || "")}${
                item.confidence_1_10 != null ? ` · conf ${item.confidence_1_10}` : ""
              }`}
              right={item.entry != null ? inr(Number(item.entry)) : "—"}
              sub={
                item.size_inr != null
                  ? `Size ${inr(Number(item.size_inr))}`
                  : undefined
              }
            />
          ))}
          {!top10.length ? <Empty /> : null}
        </div>
      </Card>

      <Card title="Deep dive (top 3)">
        <div className="space-y-3">
          {deep.map((item, i) => {
            const verdict = (item.verdict || item) as Record<string, unknown>;
            const reasons = asStringArray(verdict.reasons);
            return (
              <div key={String(item.ticker || i)} className="rounded-xl bg-slate-950/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-white">
                    {String(item.ticker || verdict.ticker || "—")}
                  </span>
                  <span className="text-xs uppercase text-slate-400">
                    {String(verdict.action || "")}
                  </span>
                </div>
                {reasons.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-slate-300">
                    {reasons.slice(0, 4).map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-slate-400">No thesis text.</p>
                )}
              </div>
            );
          })}
          {!deep.length ? <Empty /> : null}
        </div>
      </Card>

      <Card title="Avoids">
        <div className="space-y-2">
          {avoids.map((item, i) => (
            <Row
              key={String(item.ticker || i)}
              left={String(item.ticker || "—")}
              mid={String(item.kind || item.action || "avoid")}
              right={String(item.note || item.avoids_note || "—")}
            />
          ))}
          {!avoids.length ? <Empty /> : null}
        </div>
      </Card>

      <Card title="Penny under ₹50">
        {penny.note ? (
          <p className="mb-2 text-sm text-slate-400">{String(penny.note)}</p>
        ) : null}
        <div className="space-y-2">
          {pennyItems.map((item, i) => (
            <Row
              key={String(item.ticker || i)}
              left={String(item.ticker || "—")}
              mid={String(item.action || "avoid")}
              right={item.cmp != null ? inr(Number(item.cmp)) : "—"}
              sub={item.note ? String(item.note) : undefined}
            />
          ))}
          {!pennyItems.length ? <Empty /> : null}
        </div>
      </Card>

      <Card title="Final summary">
        <p className="text-sm font-medium text-slate-200">
          {String(summary.headline || "—")}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <Stat
            label="Universe"
            value={
              Array.isArray(summary.universe)
                ? String(summary.universe.length)
                : String(summary.universe ?? "—")
            }
          />
          <Stat label="Buys" value={formatMaybeList(summary.buys)} />
          <Stat
            label="Holds"
            value={
              Array.isArray(summary.holds)
                ? String(summary.holds.length)
                : String(summary.holds ?? "—")
            }
          />
          <Stat label="Avoids" value={formatMaybeList(summary.avoids)} />
          <Stat label="Paper fills" value={String(summary.paper_fills ?? "—")} />
          <Stat
            label="Paper notional"
            value={
              summary.paper_notional_inr != null
                ? inr(Number(summary.paper_notional_inr))
                : "—"
            }
          />
        </dl>
      </Card>
    </div>
  );
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function formatMaybeList(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(", ") || "—";
  if (v == null) return "—";
  return String(v);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BulletList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="mt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-slate-300">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function Row({
  left,
  mid,
  right,
  sub,
}: {
  left: string;
  mid: string;
  right: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl bg-slate-950/50 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-white">{left}</div>
          {mid ? <div className="text-[11px] uppercase text-slate-500">{mid}</div> : null}
        </div>
        <div className="max-w-[55%] text-right text-sm text-slate-300">{right}</div>
      </div>
      {sub ? <p className="mt-1 text-xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950/50 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 font-medium text-slate-100">{value}</div>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-slate-500">No items.</p>;
}
