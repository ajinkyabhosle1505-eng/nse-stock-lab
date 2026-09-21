"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import VerdictCard from "@/components/VerdictCard";
import type { LookupResponse } from "@/lib/types";
import { actionClass, inr, num } from "@/lib/format";

export default function LookupPage() {
  const [symbol, setSymbol] = useState("PNB");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LookupResponse | null>(null);

  const run = useCallback(async () => {
    const s = symbol.trim();
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
            placeholder="PNB"
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

      {data ? (
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

          <VerdictCard v={data.verdict} href={`/ideas/${encodeURIComponent(data.ticker)}?live=1`} />

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

          <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Funda / News (stubs)
            </h2>
            <p className="mt-2 text-sm text-slate-400">{data.funda.note}</p>
            <p className="mt-1 text-sm text-slate-400">{data.news.note}</p>
            <p className="mt-2 text-xs text-slate-500">
              Unknowns: {[...data.funda.unknowns, ...data.news.unknowns].join(", ")}
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
