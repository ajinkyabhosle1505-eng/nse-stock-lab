"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BUDGET_CHIPS,
  DEFAULT_BUDGET,
  readBudget,
} from "@/lib/budget";
import { inr, num } from "@/lib/format";
import { SCREEN_SECTORS } from "@/lib/screenUniverse";
import type { ScreenResult, ScreenRow } from "@/lib/screen";

export default function ScreenPage() {
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [sectors, setSectors] = useState<string[]>([]);
  const [peMax, setPeMax] = useState<string>("");
  const [roeMin, setRoeMin] = useState<string>("");
  const [minVol, setMinVol] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScreenResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBudget(readBudget());
  }, []);

  const toggleSector = (s: string) => {
    setSectors((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  };

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { budget_inr: budget };
      if (sectors.length) body.sectors = sectors;
      if (peMax.trim() !== "" && Number.isFinite(Number(peMax))) {
        body.pe_max = Number(peMax);
      }
      if (roeMin.trim() !== "" && Number.isFinite(Number(roeMin))) {
        body.roe_min = Number(roeMin);
      }
      if (minVol.trim() !== "" && Number.isFinite(Number(minVol))) {
        body.min_volume_vs_avg = Number(minVol);
      }
      const res = await fetch("/api/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = (await res.json()) as ScreenResult & { error?: string };
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`);
        setData(null);
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "screen failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [budget, sectors, peMax, roeMin, minVol]);

  const rows: ScreenRow[] = data?.fits?.length
    ? data.fits
    : data?.results || [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Screen</h1>
        <p className="mt-1 text-sm text-slate-400">
          Budget-aware scan of ~50 liquid NSE names. CMP ≤ budget when known.
          Never invents prices — gaps stay UNKNOWN.
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
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Sectors
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {SCREEN_SECTORS.map((s) => {
              const on = sectors.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSector(s)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                    on
                      ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                      : "border-slate-700 text-slate-300"
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
          {sectors.length ? (
            <button
              type="button"
              className="mt-2 text-[11px] text-slate-500 hover:text-slate-300"
              onClick={() => setSectors([])}
            >
              Clear sectors
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              PE max
            </label>
            <input
              type="number"
              value={peMax}
              onChange={(e) => setPeMax(e.target.value)}
              placeholder="e.g. 25"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-white outline-none ring-emerald-500/40 focus:ring-2"
            />
          </div>
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              ROE min %
            </label>
            <input
              type="number"
              value={roeMin}
              onChange={(e) => setRoeMin(e.target.value)}
              placeholder="e.g. 12"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-white outline-none ring-emerald-500/40 focus:ring-2"
            />
          </div>
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Vol vs avg ≥
            </label>
            <input
              type="number"
              step={0.1}
              value={minVol}
              onChange={(e) => setMinVol(e.target.value)}
              placeholder="e.g. 1.2"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-white outline-none ring-emerald-500/40 focus:ring-2"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => void run()}
          disabled={loading}
          className="w-full rounded-xl bg-emerald-500 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
        >
          {loading ? "Scanning Yahoo…" : "Run screen"}
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
            {data.fits.length} fit budget · {data.results.length} after filters ·
            scanned {data.scanned} ·{" "}
            {new Date(data.as_of).toLocaleString("en-IN")}
          </p>
          {data.note ? (
            <p className="text-xs text-slate-500">{data.note}</p>
          ) : null}

          {rows.length === 0 ? (
            <p className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
              No names fit. Try a larger budget, clear PE/ROE filters, or check
              Lookup for a single ticker.
            </p>
          ) : (
            rows.map((r) => (
              <Link
                key={r.ticker}
                href={`/lookup?prefill=${encodeURIComponent(r.ticker)}`}
                className="block rounded-2xl border border-slate-800 bg-slate-900/80 p-4 transition hover:border-slate-600 active:scale-[0.99]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-white">
                      {r.ticker}
                    </h2>
                    <p className="text-xs text-slate-400">{r.sector}</p>
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      r.fits_budget
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                        : "border-slate-600 text-slate-400"
                    }`}
                  >
                    {r.fits_budget ? "fits" : "no fit"}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <Metric
                    label="CMP"
                    value={
                      typeof r.cmp === "number" ? inr(r.cmp) : "UNKNOWN"
                    }
                  />
                  <Metric
                    label="PE TTM"
                    value={
                      typeof r.pe_ttm === "number" ? num(r.pe_ttm) : "UNKNOWN"
                    }
                  />
                  <Metric
                    label="ROE %"
                    value={
                      typeof r.roe_pct === "number" ? num(r.roe_pct) : "UNKNOWN"
                    }
                  />
                  <Metric
                    label="Vol vs 20d"
                    value={
                      typeof r.volume_vs_avg_20d === "number"
                        ? num(r.volume_vs_avg_20d)
                        : "UNKNOWN"
                    }
                  />
                  <Metric
                    label="Afford shares"
                    value={
                      r.afford_shares != null ? String(r.afford_shares) : "—"
                    }
                  />
                </dl>
                {r.unknowns?.length ? (
                  <p className="mt-2 text-[10px] text-slate-500">
                    Unknowns: {r.unknowns.slice(0, 6).join(", ")}
                    {r.unknowns.length > 6 ? "…" : ""}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-emerald-400">Lookup →</p>
              </Link>
            ))
          )}
        </div>
      ) : null}
    </div>
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
