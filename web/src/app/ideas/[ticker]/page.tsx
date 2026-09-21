import Link from "next/link";
import { notFound } from "next/navigation";
import { findVerdict, getLanes, getVerdicts, indexByTicker } from "@/lib/data";
import { actionClass, inr, num } from "@/lib/format";

type Props = { params: Promise<{ ticker: string }> };

export async function generateStaticParams() {
  const data = await getVerdicts();
  return data.verdicts.map((v) => ({ ticker: v.ticker }));
}

export default async function IdeaDetailPage({ params }: Props) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw).toUpperCase();
  const [verdicts, lanes] = await Promise.all([getVerdicts(), getLanes()]);
  const verdict = findVerdict(verdicts, ticker);
  if (!verdict) notFound();

  const tech = indexByTicker(lanes.tech)[ticker];
  const funda = indexByTicker(lanes.funda)[ticker];
  const news = indexByTicker(lanes.news)[ticker];

  return (
    <div className="space-y-4">
      <Link href="/ideas" className="text-sm text-emerald-400 hover:underline">
        ← Ideas
      </Link>

      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{verdict.ticker}</h1>
          {verdict.sector ? (
            <p className="text-sm text-slate-400">{verdict.sector}</p>
          ) : null}
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${actionClass(
            verdict.action
          )}`}
        >
          {verdict.action}
        </span>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Verdict
        </h2>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Item label="Confidence" value={`${verdict.confidence_1_10}/10`} />
          <Item label="CMP" value={inr(verdict.cmp ?? undefined)} />
          <Item label="Entry" value={inr(verdict.entry ?? undefined)} />
          <Item label="SL" value={inr(verdict.sl ?? undefined)} />
          <Item
            label="Targets"
            value={verdict.targets?.map((t) => num(t)).join(" · ") || "—"}
          />
          <Item label="Size" value={inr(verdict.size_inr ?? undefined)} />
          <Item label="Shares" value={verdict.shares != null ? String(verdict.shares) : "—"} />
          <Item label="R:R" value={verdict.r_r != null ? num(verdict.r_r) : "—"} />
        </dl>

        {verdict.reasons?.length ? (
          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Reasons
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-slate-300">
              {verdict.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {verdict.risk_flags?.length ? (
          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-rose-400/80">
              Risk flags
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-rose-200/80">
              {verdict.risk_flags.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <LaneBlock title="Tech" lane={tech} />
      <LaneBlock title="Funda" lane={funda} />
      <LaneBlock title="News" lane={news} />
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-medium text-slate-100">{value}</dd>
    </div>
  );
}

function LaneBlock({
  title,
  lane,
}: {
  title: string;
  lane?: { fields: Record<string, unknown>; unknowns?: string[]; sources?: string[] };
}) {
  if (!lane) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </h2>
        <p className="mt-2 text-sm text-slate-500">No lane data for this ticker.</p>
      </section>
    );
  }

  const entries = Object.entries(lane.fields || {}).filter(
    ([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
  );

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h2>
      <dl className="space-y-2 text-sm">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-3 border-b border-slate-800/80 pb-2 last:border-0">
            <dt className="w-36 shrink-0 text-xs text-slate-500">{k}</dt>
            <dd className="min-w-0 flex-1 break-words text-slate-200">
              {formatField(v)}
            </dd>
          </div>
        ))}
      </dl>
      {lane.unknowns?.length ? (
        <p className="mt-3 text-xs text-slate-500">
          Unknowns: {lane.unknowns.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

function formatField(v: unknown): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" · ");
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
