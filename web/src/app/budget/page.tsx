"use client";

import { useEffect, useState } from "react";
import {
  BUDGET_CHIPS,
  DEFAULT_BUDGET,
  readBudget,
  writeBudget,
} from "@/lib/budget";
import { inr } from "@/lib/format";

export default function BudgetPage() {
  const [budget, setBudget] = useState<number>(DEFAULT_BUDGET);
  const [input, setInput] = useState<string>(String(DEFAULT_BUDGET));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const b = readBudget();
    setBudget(b);
    setInput(String(b));
  }, []);

  function apply(n: number) {
    if (!Number.isFinite(n) || n <= 0) return;
    const rounded = Math.round(n);
    setBudget(rounded);
    setInput(String(rounded));
    writeBudget(rounded);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Budget</h1>
        <p className="mt-1 text-sm text-slate-400">
          Paper allocation in ₹. Stored on this device only (localStorage).
        </p>
      </header>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
        <label htmlFor="budget" className="text-xs font-medium uppercase tracking-wider text-slate-500">
          Amount (INR)
        </label>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-2xl font-semibold text-slate-400">₹</span>
          <input
            id="budget"
            inputMode="numeric"
            type="number"
            min={1}
            step={100}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-2xl font-semibold text-white outline-none ring-emerald-500/40 focus:ring-2"
          />
        </div>
        <button
          type="button"
          onClick={() => apply(Number(input))}
          className="mt-3 w-full rounded-xl bg-emerald-500 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
        >
          Save budget
        </button>
        {saved ? (
          <p className="mt-2 text-center text-xs text-emerald-400">Saved · {inr(budget)}</p>
        ) : (
          <p className="mt-2 text-center text-xs text-slate-500">Current · {inr(budget)}</p>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
          Quick chips
        </p>
        <div className="grid grid-cols-2 gap-2">
          {BUDGET_CHIPS.map((chip) => {
            const active = budget === chip;
            return (
              <button
                key={chip}
                type="button"
                onClick={() => apply(chip)}
                className={`rounded-xl border px-3 py-3 text-sm font-semibold ${
                  active
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : "border-slate-800 bg-slate-900 text-slate-200 hover:border-slate-600"
                }`}
              >
                {inr(chip)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
