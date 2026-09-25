"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { inr, num } from "@/lib/format";
import {
  readPaperForecasts,
  removePaperForecast,
  writePaperForecasts,
} from "@/lib/paperStore";
import { SEBI_BANNER } from "@/lib/universe";
import type { PaperForecastPosition } from "@/lib/types";

type FixtureLedger = {
  job_id?: string;
  as_of?: string;
  budget_inr?: number;
  note?: string;
  fills?: Array<{
    fillId: string;
    ticker?: string;
    symbol?: string;
    side: string;
    status: string;
    sector?: string;
    entry: number;
    sl?: number;
    targets?: number[];
    qty?: number;
    shares?: number;
    size_inr: number;
    filledAt: string;
    realizedPnl?: number;
    unrealizedPnl?: number | string;
    mark_note?: string;
  }>;
  summary?: {
    open_positions?: number;
    notional_inr?: number;
    realizedPnl?: number;
    unrealizedPnl?: number | string;
  };
};

function PaperPageInner() {
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const [positions, setPositions] = useState<PaperForecastPosition[]>([]);
  const [marking, setMarking] = useState(false);
  const [markNote, setMarkNote] = useState<string | null>(null);
  const [showFixture, setShowFixture] = useState(false);
  const [fixture, setFixture] = useState<FixtureLedger | null>(null);

  const reload = useCallback(() => {
    setPositions(readPaperForecasts());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!showFixture || fixture) return;
    void fetch("/data/ledger.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setFixture(j as FixtureLedger | null))
      .catch(() => setFixture(null));
  }, [showFixture, fixture]);

  const scoreboard = useMemo(() => {
    let n_fills = 0;
    let n_scored = 0;
    const apes: number[] = [];
    const byHorizon: Record<string, { n: number; apes: number[]; dir: number; dirOk: number }> = {
      le7: { n: 0, apes: [], dir: 0, dirOk: 0 },
      "8to21": { n: 0, apes: [], dir: 0, dirOk: 0 },
      ge22: { n: 0, apes: [], dir: 0, dirOk: 0 },
    };
    for (const p of positions) {
      if (!p.forecast || p.forecast.status === "skipped") continue;
      n_fills += 1;
      const s = p.forecast.scoreSummary;
      n_scored += s.n_scored;
      for (const pt of p.forecast.points) {
        if (pt.status !== "scored" || pt.ape_pct == null || pt.corporate_action_suspect) continue;
        apes.push(pt.ape_pct);
        const b =
          pt.dayOffset <= 7 ? "le7" : pt.dayOffset <= 21 ? "8to21" : "ge22";
        byHorizon[b].n += 1;
        byHorizon[b].apes.push(pt.ape_pct);
        byHorizon[b].dir += 1;
        if (pt.direction_ok) byHorizon[b].dirOk += 1;
      }
      void s;
    }
    const mape =
      apes.length > 0
        ? Math.round((apes.reduce((a, b) => a + b, 0) / apes.length) * 100) / 100
        : null;
    return { n_fills, n_scored, mape, byHorizon, claimReady: n_fills >= 20 };
  }, [positions]);

  async function scoreDue() {
    setMarking(true);
    setMarkNote(null);
    try {
      const res = await fetch("/api/paper/mark-forecasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions }),
        cache: "no-store",
      });
      const json = (await res.json()) as {
        positions?: PaperForecastPosition[];
        error?: string;
        note?: string;
      };
      if (!res.ok) {
        setMarkNote(json.error || `HTTP ${res.status}`);
        return;
      }
      if (json.positions) {
        writePaperForecasts(json.positions);
        setPositions(json.positions);
      }
      setMarkNote(json.note || "Scored due check days with Yahoo daily closes.");
    } catch (e) {
      setMarkNote(e instanceof Error ? e.message : "mark failed");
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Paper forecasts
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Paper scenario path (ATR) scoreboard — research / learning only. Not a tip,
          strategy proof, or recommendation.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          {SEBI_BANNER}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Scoreboard
          </h2>
          <button
            type="button"
            onClick={() => void scoreDue()}
            disabled={marking || !positions.length}
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-300 disabled:opacity-50"
          >
            {marking ? "Marking…" : "Score due"}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Stat label="Fills with path" value={String(scoreboard.n_fills)} />
          <Stat label="Scored points (n)" value={String(scoreboard.n_scored)} />
          <Stat
            label="MAPE % (all)"
            value={scoreboard.mape != null ? String(scoreboard.mape) : "—"}
          />
          <Stat
            label="Skill claim"
            value={
              scoreboard.claimReady
                ? "n≥20 — inspect bands only"
                : "insufficient (need n≥20 fills)"
            }
            warn={!scoreboard.claimReady}
          />
        </div>
        <div className="space-y-1 text-xs text-slate-400">
          {(["le7", "8to21", "ge22"] as const).map((b) => {
            const h = scoreboard.byHorizon[b];
            const mape =
              h.apes.length > 0
                ? Math.round(
                    (h.apes.reduce((a, c) => a + c, 0) / h.apes.length) * 100
                  ) / 100
                : null;
            const dir =
              h.dir > 0
                ? Math.round((h.dirOk / h.dir) * 1000) / 10
                : null;
            const label = b === "le7" ? "≤7d" : b === "8to21" ? "8–21d" : "≥22d";
            return (
              <p key={b}>
                {label}: n={h.n}
                {mape != null ? ` · MAPE ${mape}%` : ""}
                {dir != null ? ` · dir ${dir}%` : ""}
              </p>
            );
          })}
        </div>
        {markNote ? (
          <p className="text-xs text-slate-400">{markNote}</p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          My paper forecasts
        </h2>
        {!positions.length ? (
          <p className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
            No paper buys yet. From Lookup or Budget picks, use{" "}
            <strong className="text-slate-200">Paper buy → scenario path</strong>{" "}
            and pick check days (7/14/30 chips are defaults — add any custom set).
          </p>
        ) : (
          positions.map((p) => (
            <article
              key={p.id}
              id={p.id}
              className={`rounded-2xl border p-4 ${
                highlight === p.id
                  ? "border-emerald-500/50 bg-emerald-950/20"
                  : "border-slate-800 bg-slate-900/80"
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-lg font-semibold text-white">{p.ticker}</h3>
                  <p className="text-xs text-slate-500">
                    {p.yahoo_symbol} · qty {p.qty} · bought{" "}
                    {formatTime(p.boughtAt)}
                    {p.sector ? ` · ${p.sector}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    removePaperForecast(p.id);
                    reload();
                  }}
                  className="text-[10px] text-slate-500 hover:text-rose-300"
                >
                  Remove
                </button>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Item label="Entry" value={inr(p.entry)} />
                <Item label="SL" value={p.sl != null ? inr(p.sl) : "—"} />
                <Item
                  label="Targets"
                  value={
                    p.targets?.length
                      ? p.targets.map((t) => num(t)).join(" · ")
                      : "—"
                  }
                />
                <Item label="Size" value={inr(p.size_inr)} />
              </dl>

              {p.forecast?.status === "skipped" ? (
                <p className="mt-3 text-xs text-amber-200">
                  Forecast skipped: {p.forecast.skip_reason}
                </p>
              ) : p.forecast ? (
                <div className="mt-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    Paper scenario path (ATR) · {p.forecast.method} · scale{" "}
                    {p.forecast.params.scale}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px] text-slate-300">
                      <thead className="text-slate-500">
                        <tr>
                          <th className="py-1 pr-2">Day</th>
                          <th className="py-1 pr-2">Scenario</th>
                          <th className="py-1 pr-2">Actual</th>
                          <th className="py-1 pr-2">APE%</th>
                          <th className="py-1">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.forecast.points.map((pt) => (
                          <tr key={pt.dayOffset} className="border-t border-slate-800">
                            <td className="py-1 pr-2">{pt.dayOffset}</td>
                            <td className="py-1 pr-2">{inr(pt.predictedClose)}</td>
                            <td className="py-1 pr-2">
                              {pt.actualClose != null
                                ? inr(pt.actualClose)
                                : "UNKNOWN"}
                              {pt.corporate_action_suspect ? " ⚠" : ""}
                            </td>
                            <td className="py-1 pr-2">
                              {pt.ape_pct != null ? String(pt.ape_pct) : "—"}
                            </td>
                            <td className="py-1">{pt.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    n_scored={p.forecast.scoreSummary.n_scored}
                    {p.forecast.scoreSummary.mape_pct != null
                      ? ` · MAPE ${p.forecast.scoreSummary.mape_pct}%`
                      : ""}
                    {p.forecast.scoreSummary.hit_within_1atr_pct != null
                      ? ` · hit~1ATR ${p.forecast.scoreSummary.hit_within_1atr_pct}%`
                      : ""}
                    {p.forecast.scoreSummary.hit_within_2pct_pct != null
                      ? ` · hit 2% ${p.forecast.scoreSummary.hit_within_2pct_pct}%`
                      : ""}
                    {p.forecast.scoreSummary.directional_pct != null
                      ? ` · dir ${p.forecast.scoreSummary.directional_pct}%`
                      : ""}
                    {" · "}
                    T1{" "}
                    {p.forecast.scoreSummary.touched_t1 == null
                      ? "?"
                      : p.forecast.scoreSummary.touched_t1
                        ? "yes"
                        : "no"}
                    / T2{" "}
                    {p.forecast.scoreSummary.touched_t2 == null
                      ? "?"
                      : p.forecast.scoreSummary.touched_t2
                        ? "yes"
                        : "no"}
                    / SL{" "}
                    {p.forecast.scoreSummary.touched_sl == null
                      ? "?"
                      : p.forecast.scoreSummary.touched_sl
                        ? "yes"
                        : "no"}
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-500">No forecast bundle.</p>
              )}
            </article>
          ))
        )}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40">
        <button
          type="button"
          onClick={() => setShowFixture((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500"
        >
          Fixture ledger (optional)
          <span>{showFixture ? "▾" : "▸"}</span>
        </button>
        {showFixture ? (
          <div className="space-y-3 border-t border-slate-800 px-4 pb-4 pt-3">
            {!fixture ? (
              <p className="text-sm text-slate-500">Loading fixture…</p>
            ) : (
              <>
                <p className="text-xs text-slate-500">
                  {fixture.job_id} · {fixture.as_of} · budget{" "}
                  {inr(fixture.budget_inr)}
                </p>
                {fixture.note ? (
                  <p className="text-xs text-slate-500">{fixture.note}</p>
                ) : null}
                {fixture.fills?.map((f) => (
                  <article
                    key={f.fillId}
                    className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"
                  >
                    <h3 className="font-semibold text-white">
                      {f.ticker || f.symbol}
                    </h3>
                    <p className="text-xs text-slate-500">
                      {f.side} · {f.status}
                    </p>
                    <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                      <Item label="Entry" value={inr(f.entry)} />
                      <Item label="Size" value={inr(f.size_inr)} />
                    </dl>
                  </article>
                ))}
                {!fixture.fills?.length ? (
                  <p className="text-sm text-slate-500">No fixture fills.</p>
                ) : null}
              </>
            )}
          </div>
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
    <div className="rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div
        className={`mt-1 text-sm font-semibold ${
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
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div
        className={`mt-0.5 font-medium ${
          warn ? "text-amber-300" : "text-slate-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default function PaperPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <h1 className="text-2xl font-bold text-white">Paper forecasts</h1>
          <p className="text-sm text-slate-400">Loading…</p>
        </div>
      }
    >
      <PaperPageInner />
    </Suspense>
  );
}
