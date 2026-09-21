"use client";

import { useCallback, useEffect, useState } from "react";
import VerdictCard from "@/components/VerdictCard";
import {
  BUDGET_CHIPS,
  DEFAULT_BUDGET,
  readBudget,
} from "@/lib/budget";
import { inr } from "@/lib/format";
import type { Verdict } from "@/lib/types";

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
          What can you paper-buy with ₹X? Live Yahoo scan → up to 10 buys that
          fit your budget (max 2 per sector). Not a broker.
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
            (entry − SL))
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
          {data.picks.length === 0 ? (
            <p className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
              No buys fit budget/risk right now (tape or sizing). Try a larger
              budget or check Lookup.
            </p>
          ) : (
            data.picks.map((v) => <VerdictCard key={v.ticker} v={v} />)
          )}
        </div>
      ) : null}
    </div>
  );
}
