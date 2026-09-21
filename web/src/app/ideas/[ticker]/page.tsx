import Link from "next/link";
import { notFound } from "next/navigation";
import { findVerdict, getLanes, getVerdicts, indexByTicker } from "@/lib/data";
import { actionClass, inr, num, planLevels } from "@/lib/format";
import { enrichPlanFields } from "@/lib/plan";
import { runLookup } from "@/lib/live";
import type { Verdict } from "@/lib/types";
import PlanChart from "@/components/PlanChart";
import Sparkline from "@/components/Sparkline";
import { plainAction, plainReason, plainBreakout, plainStructure, plainVsDma } from "@/lib/plain";

type Props = {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<{ live?: string }>;
};

export async function generateStaticParams() {
  const data = await getVerdicts();
  return data.verdicts.map((v) => ({ ticker: v.ticker }));
}

export default async function IdeaDetailPage({ params, searchParams }: Props) {
  const { ticker: raw } = await params;
  const sp = await searchParams;
  const ticker = decodeURIComponent(raw).toUpperCase();
  const live = sp.live === "1" || sp.live === "true";

  let verdict: Verdict | undefined;
  let techLane:
    | { fields: Record<string, unknown>; unknowns?: string[]; sources?: string[] }
    | undefined;
  let fundaLane:
    | { fields: Record<string, unknown>; unknowns?: string[]; sources?: string[]; note?: string }
    | undefined;
  let newsLane:
    | { fields: Record<string, unknown>; unknowns?: string[]; sources?: string[]; note?: string }
    | undefined;
  let liveNote: string | null = null;

  if (live) {
    try {
      const lu = await runLookup(ticker);
      verdict = enrichPlanFields(lu.verdict);
      techLane = {
        fields: lu.tech.fields as unknown as Record<string, unknown>,
        unknowns: lu.tech.unknowns,
        sources: lu.tech.sources,
      };
      fundaLane = { ...lu.funda, sources: [] };
      newsLane = { ...lu.news, sources: [] };
      liveNote = `Live Yahoo · ${lu.yahoo_symbol} · ${lu.as_of}`;
    } catch {
      liveNote = "Live Yahoo lookup failed";
    }
  }

  if (!verdict) {
    const [verdicts, lanes] = await Promise.all([getVerdicts(), getLanes()]);
    verdict = findVerdict(verdicts, ticker);
    if (!verdict && !live) notFound();
    if (!verdict) {
      // live failed and no fixture
      notFound();
    }
    verdict = enrichPlanFields(verdict);
    if (!live) {
      techLane = indexByTicker(lanes.tech)[ticker];
      fundaLane = indexByTicker(lanes.funda)[ticker];
      newsLane = indexByTicker(lanes.news)[ticker];
    }
  }

  const plan = planLevels(verdict);

  return (
    <div className="space-y-4">
      <Link href="/ideas" className="text-sm text-emerald-400 hover:underline">
        ← Ideas
      </Link>

      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            {verdict.ticker}
            {verdict.live ? (
              <span className="ml-2 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-300">
                live
              </span>
            ) : null}
          </h1>
          {verdict.sector ? (
            <p className="text-sm text-slate-400">{verdict.sector}</p>
          ) : null}
          {liveNote ? (
            <p className="mt-1 text-xs text-slate-500">{liveNote}</p>
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

      {!live ? (
        <p className="text-xs text-slate-500">
          Fixture data.{" "}
          <Link
            href={`/ideas/${encodeURIComponent(ticker)}?live=1`}
            className="text-emerald-400 hover:underline"
          >
            Refresh live from Yahoo →
          </Link>
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          <Link
            href={`/ideas/${encodeURIComponent(ticker)}`}
            className="text-emerald-400 hover:underline"
          >
            View fixture →
          </Link>
          {" · "}
          <Link href="/lookup" className="text-emerald-400 hover:underline">
            Lookup
          </Link>
        </p>
      )}

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
          <Item
            label="Shares"
            value={verdict.shares != null ? String(verdict.shares) : "—"}
          />
          <Item label="R:R" value={verdict.r_r != null ? num(verdict.r_r) : "—"} />
        </dl>

        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-sky-400/80">
          Plan
        </h3>
        <p className="mb-2 text-xs text-slate-400">{plainAction(verdict.action)}</p>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Item label="Buy trigger" value={plan.buy_trigger} />
          <Item label="Stop invalidation" value={plan.stop_invalidation} />
          <Item label="Sell targets" value={plan.sell_targets} />
          <Item label="Time horizon" value={plan.time_horizon} />
        </dl>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Plan chart
          </h3>
          <PlanChart
            entry={typeof verdict.entry === "number" ? verdict.entry : null}
            sl={typeof verdict.sl === "number" ? verdict.sl : null}
            targets={verdict.targets}
          />
        </div>

        {Array.isArray(techLane?.fields?.closes_30d) &&
        (techLane!.fields.closes_30d as number[]).length >= 2 ? (
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              ~30-day tape
            </h3>
            <Sparkline closes={techLane!.fields.closes_30d as number[]} />
          </div>
        ) : null}

        {techLane?.fields ? (
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300 space-y-1">
            <p>{plainStructure(String(techLane.fields.structure ?? ""))}</p>
            <p>{plainBreakout(String(techLane.fields.breakout_state ?? ""))}</p>
            <p>{plainVsDma(String(techLane.fields.price_vs_dma ?? ""))}</p>
          </div>
        ) : null}

        {verdict.reasons?.length ? (
          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Why (plain language)
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-slate-300">
              {verdict.reasons.map((r) => (
                <li key={r}>{plainReason(r)}</li>
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

      <LaneBlock title="Tech" lane={techLane} />
      <LaneBlock title="Funda" lane={fundaLane} />
      <LaneBlock title="News" lane={newsLane} />
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium text-slate-100">{value}</dd>
    </div>
  );
}

function LaneBlock({
  title,
  lane,
}: {
  title: string;
  lane?: {
    fields: Record<string, unknown>;
    unknowns?: string[];
    sources?: string[];
    note?: string;
  };
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
      {lane.note ? (
        <p className="mb-2 text-xs text-slate-400">{lane.note}</p>
      ) : null}
      <dl className="space-y-2 text-sm">
        {entries.map(([k, v]) => (
          <div
            key={k}
            className="flex gap-3 border-b border-slate-800/80 pb-2 last:border-0"
          >
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
    return v
      .map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x)))
      .join(" · ");
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
