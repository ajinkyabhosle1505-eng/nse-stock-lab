"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import VerdictCard from "@/components/VerdictCard";
import PlanChart from "@/components/PlanChart";
import Sparkline from "@/components/Sparkline";
import type { LookupResponse } from "@/lib/types";
import { actionClass, inr, num } from "@/lib/format";
import { enrichPlanFields } from "@/lib/plan";
import {
  plainAction,
  plainBreakout,
  plainPlanLines,
  plainReason,
  plainStructure,
  plainVsDma,
} from "@/lib/plain";

function LookupPage() {
  const searchParams = useSearchParams();
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LookupResponse | null>(null);
  const [prefillDone, setPrefillDone] = useState(false);

  const run = useCallback(async (override?: string) => {
    const s = (override ?? symbol).trim();
    if (!s) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/lookup?symbol=${encodeURIComponent(s)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as LookupResponse & { error?: string };
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`);
        setData(null);
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "lookup failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    if (prefillDone) return;
    const pre =
      searchParams.get("prefill") ||
      searchParams.get("symbol") ||
      searchParams.get("q");
    if (pre && pre.trim()) {
      const s = pre.trim().toUpperCase();
      setSymbol(s);
      setPrefillDone(true);
      void run(s);
    } else {
      setPrefillDone(true);
    }
  }, [searchParams, prefillDone, run]);

  const verd = useMemo(
    () => (data ? enrichPlanFields(data.verdict) : null),
    [data]
  );
  const planLines = useMemo(
    () => (verd ? plainPlanLines(verd) : []),
    [verd]
  );
  const closes = data?.tech?.fields?.closes_30d;
  const hasSpark =
    Array.isArray(closes) && closes.length >= 2;
  const hasPlanLevels =
    verd != null &&
    ((typeof verd.entry === "number" && typeof verd.sl === "number") ||
      (typeof verd.buy_trigger === "number" &&
        typeof verd.stop_invalidation === "number"));

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Lookup</h1>
        <p className="mt-1 text-sm text-slate-400">
          Live Yahoo tech for NSE symbols (auto <code className="text-slate-300">.NS</code>
          ). Prices never invented — missing → UNKNOWN.
        </p>
      </header>

      <form
        className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label
          htmlFor="symbol"
          className="text-xs font-medium uppercase tracking-wider text-slate-500"
        >
          Symbol
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. INFY"
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-lg font-semibold uppercase text-white outline-none ring-emerald-500/40 focus:ring-2"
            autoCapitalize="characters"
            autoCorrect="off"
          />
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
          >
            {loading ? "…" : "Go"}
          </button>
        </div>
      </form>

      {error ? (
        <p className="rounded-xl border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      {data && verd ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>
              {data.yahoo_symbol} · {new Date(data.as_of).toLocaleString("en-IN")}
            </span>
            <Link
              href={`/ideas/${encodeURIComponent(data.ticker)}?live=1`}
              className="text-emerald-400 hover:underline"
            >
              Open detail →
            </Link>
          </div>

          <section className="rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400/90">
              Plain plan
            </h2>
            <p className="mb-2 text-xs text-slate-400">{plainAction(verd.action)}</p>
            <ul className="space-y-1.5 text-sm text-slate-100">
              {planLines.map((line) => (
                <li key={line} className="leading-snug">
                  {line}
                </li>
              ))}
            </ul>
            {verd.reasons?.[0] ? (
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                {plainReason(verd.reasons[0])}
              </p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Tape chart
            </h2>
            {hasSpark ? (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  ~{(closes as number[]).length}-day closes
                </p>
                <Sparkline closes={closes as number[]} />
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-3 py-4 text-center text-sm text-slate-500">
                UNKNOWN — no Yahoo OHLC (≥30 bars preferred) for sparkline
              </p>
            )}
            {hasPlanLevels ? (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Plan ladder
                </p>
                <PlanChart
                  entry={
                    typeof verd.entry === "number"
                      ? verd.entry
                      : typeof verd.buy_trigger === "number"
                        ? verd.buy_trigger
                        : null
                  }
                  sl={
                    typeof verd.sl === "number"
                      ? verd.sl
                      : typeof verd.stop_invalidation === "number"
                        ? verd.stop_invalidation
                        : null
                  }
                  targets={
                    verd.sell_targets?.length
                      ? verd.sell_targets
                      : verd.targets
                  }
                />
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Plan chart: UNKNOWN (entry / stop incomplete)
              </p>
            )}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300 space-y-1">
              <p>{plainStructure(String(data.tech.fields.structure ?? ""))}</p>
              <p>{plainBreakout(String(data.tech.fields.breakout_state ?? ""))}</p>
              <p>{plainVsDma(String(data.tech.fields.price_vs_dma ?? ""))}</p>
            </div>
          </section>

          <VerdictCard v={verd} href={`/ideas/${encodeURIComponent(data.ticker)}?live=1`} />

          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Live tech
            </h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Item label="CMP" value={fmt(data.tech.fields.cmp)} />
              <Item label="ATR 14" value={fmt(data.tech.fields.atr_14)} />
              <Item label="RSI 14" value={fmt(data.tech.fields.rsi_14)} />
              <Item label="Structure" value={String(data.tech.fields.structure)} />
              <Item
                label="Breakout"
                value={String(data.tech.fields.breakout_state)}
              />
              <Item
                label="vs DMA"
                value={String(data.tech.fields.price_vs_dma)}
              />
              <Item label="DMA 20" value={fmt(data.tech.fields.dma_20)} />
              <Item label="DMA 50" value={fmt(data.tech.fields.dma_50)} />
              <Item label="DMA 200" value={fmt(data.tech.fields.dma_200)} />
              <Item
                label="Support"
                value={
                  data.tech.fields.support_levels?.length
                    ? data.tech.fields.support_levels.map((x) => num(x)).join(" · ")
                    : "—"
                }
              />
              <Item
                label="Resistance"
                value={
                  data.tech.fields.resistance_levels?.length
                    ? data.tech.fields.resistance_levels
                        .map((x) => num(x))
                        .join(" · ")
                    : "—"
                }
              />
            </dl>
            {data.tech.unknowns?.length ? (
              <p className="mt-3 text-xs text-slate-500">
                Unknowns: {data.tech.unknowns.join(", ")}
              </p>
            ) : null}
            {data.tech.sources?.length ? (
              <p className="mt-1 text-[10px] text-slate-600">
                {data.tech.sources.join(" · ")}
              </p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Funda / News (live scrape)
            </h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Item
                label="funda_quality"
                value={String(data.funda.fields.funda_quality ?? "UNKNOWN")}
              />
              <Item
                label="PE / ROE / D-E"
                value={[
                  data.funda.fields.pe_ttm != null ? `PE ${data.funda.fields.pe_ttm}` : null,
                  data.funda.fields.roe_pct != null ? `ROE ${data.funda.fields.roe_pct}` : null,
                  data.funda.fields.debt_equity != null
                    ? `D/E ${data.funda.fields.debt_equity}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "UNKNOWN"}
              />
            </dl>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Headline</p>
              <p className="mt-0.5 text-sm text-slate-100">
                {String(data.news.fields.headline ?? "UNKNOWN")}
              </p>
              {data.news.fields.why_for_verdict ? (
                <p className="mt-1 text-xs text-slate-400">
                  why: {String(data.news.fields.why_for_verdict)}
                </p>
              ) : null}
              <p className="mt-1 text-[10px] text-slate-500">
                {String(data.news.fields.confirmation_status ?? "?")} ·{" "}
                {String(data.news.fields.catalyst_strength ?? "?")} · expiry{" "}
                {String(data.news.fields.catalyst_expiry ?? "null")}
              </p>
            </div>
            <p className="text-xs text-slate-500">
              Funda unknowns: {data.funda.unknowns.join(", ") || "—"}
            </p>
            <p className="text-xs text-slate-500">
              News unknowns: {data.news.unknowns.join(", ") || "—"}
            </p>
            <p className="text-[10px] text-slate-600">
              {data.funda.note} · {data.news.note}
            </p>
            <p className="mt-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase ${actionClass(
                  data.verdict.action
                )}`}
              >
                {data.verdict.action}
              </span>
              <span className="ml-2 text-xs text-slate-500">
                size {inr(data.verdict.size_inr ?? undefined)}
              </span>
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function fmt(v: number | "UNKNOWN" | undefined): string {
  if (v === "UNKNOWN" || v == null) return "UNKNOWN";
  return num(v);
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

export default function LookupPageSuspense() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <h1 className="text-2xl font-bold tracking-tight text-white">Lookup</h1>
          <p className="text-sm text-slate-400">Loading…</p>
        </div>
      }
    >
      <LookupPage />
    </Suspense>
  );
}
