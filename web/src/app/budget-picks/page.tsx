"use client";

import { useCallback, useEffect, useState } from "react";
import VerdictCard from "@/components/VerdictCard";
import PaperBuyButton from "@/components/PaperBuyButton";
import {
  BUDGET_CHIPS,
  DEFAULT_BUDGET,
  readBudget,
} from "@/lib/budget";
import { inr } from "@/lib/format";
import type { SkippedSample, Verdict } from "@/lib/types";

interface PicksResponse {
  budget_inr: number;
  risk_pct: number;
  risk_inr: number;
  as_of: string;
  picks: Verdict[];
  scanned: number;
  note?: string;
  error?: string;
  universe?: string[];
  empty_code?: string;
  reasons?: string[];
  warnings?: string[];
  skipped_samples?: SkippedSample[];
}

export default function BudgetPicksPage() {
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [riskPct, setRiskPct] = useState(1);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PicksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBudget(readBudget());
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/budget-picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget_inr: budget, risk_pct: riskPct }),
        cache: "no-store",
      });
      const json = (await res.json()) as PicksResponse;
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`);
        setData(null);
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [budget, riskPct]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Budget picks
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          What can you paper-buy with ₹X? Live Yahoo scan → diversified buys that
          fit your budget (≤₹5k: max 1/sector; else max 2). Soft-demotes
          mega-PSU repeats. Not a broker.
        </p>
      </header>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 space-y-3">
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Budget (INR)
          </label>
          <input
            type="number"
            min={1}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value) || 0)}
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-lg font-semibold text-white outline-none ring-emerald-500/40 focus:ring-2"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {BUDGET_CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setBudget(c)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                  budget === c
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : "border-slate-700 text-slate-300"
                }`}
              >
                {inr(c)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Risk % per idea (default 1)
          </label>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={riskPct}
            onChange={(e) => setRiskPct(Number(e.target.value) || 1)}
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-lg font-semibold text-white outline-none ring-emerald-500/40 focus:ring-2"
          />
          <p className="mt-1 text-xs text-slate-500">
            Risk ₹ = {inr(budget * (riskPct / 100))} · shares = floor(risk /
            (entry − SL)); afford-one-share fallback when risk% yields 0.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void run()}
          disabled={loading}
          className="w-full rounded-xl bg-emerald-500 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
        >
          {loading ? "Scanning Yahoo…" : "Find top buys"}
        </button>
      </div>

      {error ? (
        <p className="rounded-xl border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      {data ? (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            {data.picks.length} buys · scanned {data.scanned} ·{" "}
            {new Date(data.as_of).toLocaleString("en-IN")}
          </p>
          {data.note ? (
            <p className="text-xs text-slate-500">{data.note}</p>
          ) : null}
          {data.reasons?.length ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100 space-y-1">
              {data.reasons.map((r) => (
                <p key={r}>{r}</p>
              ))}
            </div>
          ) : null}
          {data.warnings?.length ? (
            <div className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-3 text-xs text-orange-100 space-y-1">
              {data.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          ) : null}
          {data.picks.length === 0 ? (
            !data.reasons?.length ? (
              <p className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
                No buys fit budget/risk right now. Try a larger budget or check
                Lookup.
              </p>
            ) : null
          ) : (
            data.picks.map((v) => (
              <div key={v.ticker} className="space-y-2">
                <VerdictCard v={v} />
                {v.plain_why ? (
                  <p className="px-1 text-xs leading-relaxed text-slate-400">
                    Why buy: {v.plain_why}
                  </p>
                ) : null}
                {typeof v.entry === "number" ? (
                  <PaperBuyButton
                    input={{
                      ticker: v.ticker,
                      yahoo_symbol: v.yahoo_symbol,
                      entry: v.entry,
                      sl: v.sl,
                      targets: v.sell_targets?.length
                        ? v.sell_targets
                        : v.targets,
                      qty: v.shares ?? 1,
                      budget_inr: data.budget_inr,
                      sector: v.sector,
                      action: v.action,
                      atr_14:
                        typeof (v as Verdict & { atr_14?: number }).atr_14 ===
                        "number"
                          ? (v as Verdict & { atr_14?: number }).atr_14
                          : null,
                      structure: (v as Verdict & { structure?: string })
                        .structure,
                      breakout_state: (
                        v as Verdict & { breakout_state?: string }
                      ).breakout_state,
                    }}
                  />
                ) : null}
              </div>
            ))
          )}
          {data.skipped_samples?.length ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Why others were skipped (sample)
              </h2>
              {data.skipped_samples.map((s) => (
                <div
                  key={s.ticker}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300"
                >
                  <span className="font-semibold text-slate-100">{s.ticker}</span>
                  {s.sector ? (
                    <span className="text-slate-500"> · {s.sector}</span>
                  ) : null}
                  {s.cmp != null ? (
                    <span className="text-slate-500"> · CMP {inr(s.cmp)}</span>
                  ) : null}
                  <span className="text-slate-500"> · {s.action}</span>
                  <p className="mt-1 text-slate-400">{s.plain_why_skip}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
