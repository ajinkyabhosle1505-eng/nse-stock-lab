"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildForecastBundle,
  DEFAULT_CHECK_DAY_CHIPS,
} from "@/lib/forecast";
import { upsertPaperForecast } from "@/lib/paperStore";
import { ensureDevice, getMe, newIdempotencyKey } from "@/lib/paperClient";
import { SEBI_BANNER } from "@/lib/universe";
import { inr } from "@/lib/format";
import type { PaperForecastPosition } from "@/lib/types";

export type PaperBuyInput = {
  ticker: string;
  yahoo_symbol?: string;
  entry: number;
  sl?: number | null;
  targets?: number[];
  qty?: number;
  budget_inr?: number;
  atr_14?: number | null;
  structure?: string;
  breakout_state?: string;
  sector?: string | null;
  action?: string;
};

export default function PaperBuyButton({
  input,
  className = "",
}: {
  input: PaperBuyInput;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number[]>([...DEFAULT_CHECK_DAY_CHIPS]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState<string>("");
  const [moved, setMoved] = useState<{ server_price: number; moved_pct: number; tolerance_pct: number } | null>(null);

  const canBuy =
    String(input.action || "buy").toLowerCase() === "buy" &&
    Number.isFinite(input.entry) &&
    input.entry > 0;

  const preview = useMemo(() => {
    if (!open) return null;
    return buildForecastBundle({
      action: "buy",
      entry: input.entry,
      sl: input.sl,
      targets: input.targets,
      atr_14: input.atr_14,
      checkDays: days,
      structure: input.structure,
      breakout_state: input.breakout_state,
    });
  }, [open, input, days]);

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)
    );
  }

  function addCustom() {
    const n = Math.round(Number(custom));
    if (!Number.isFinite(n) || n < 1) return;
    setDays((prev) =>
      prev.includes(n) ? prev : [...prev, n].sort((a, b) => a - b)
    );
    setCustom("");
  }

  function openDialog() {
    setIdemKey(newIdempotencyKey());
    setMoved(null);
    setErr(null);
    setOpen(true);
  }

  /** Server mode: entry is set by the server from a fresh quote. Returns false → use browser fallback. */
  async function confirmServer(clientEntry: number): Promise<boolean> {
    const me = await getMe();
    if (!me.server_paper) return false;
    const dev = await ensureDevice();
    if (!dev.ok) return false;
    const res = await fetch("/api/paper/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: idemKey || newIdempotencyKey(),
        ticker: input.ticker,
        qty: Math.max(1, Math.floor(input.qty || 1)),
        budget_inr: input.budget_inr,
        client_entry: clientEntry,
        checkDays: days,
      }),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      server_price?: number;
      moved_pct?: number;
      tolerance_pct?: number;
      note?: string;
      position?: { id: string };
    };
    if (res.status === 503 && json.error === "db_not_configured") return false;
    if (res.status === 409 && json.error === "quote_moved" && json.server_price) {
      setMoved({ server_price: json.server_price, moved_pct: json.moved_pct ?? 0, tolerance_pct: json.tolerance_pct ?? 0 });
      return true;
    }
    if (!res.ok || !json.position) {
      setErr(json.note || json.error || `HTTP ${res.status}`);
      return true;
    }
    setOpen(false);
    router.push(`/paper?highlight=${encodeURIComponent(json.position.id)}`);
    return true;
  }

  async function confirm() {
    if (!days.length) {
      setErr("Pick at least one check day");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const handled = await confirmServer(moved ? moved.server_price : input.entry);
      if (handled) {
        setBusy(false);
        return;
      }
    } catch {
      /* fall back to browser mode */
    }
    const qty = Math.max(1, Math.floor(input.qty || 1));
    const budget_inr = input.budget_inr || input.entry * qty;
    const boughtAt = new Date().toISOString();
    const forecast = buildForecastBundle({
      action: "buy",
      entry: input.entry,
      sl: input.sl,
      targets: input.targets,
      atr_14: input.atr_14,
      checkDays: days,
      filledAt: boughtAt,
      structure: input.structure,
      breakout_state: input.breakout_state,
    });

    const pos: PaperForecastPosition = {
      id: `pf_${input.ticker}_${Date.now()}`,
      ticker: input.ticker.toUpperCase(),
      yahoo_symbol: input.yahoo_symbol || `${input.ticker.toUpperCase()}.NS`,
      entry: input.entry,
      sl: input.sl ?? null,
      targets: input.targets || [],
      qty,
      budget_inr,
      size_inr: Math.round(input.entry * qty * 100) / 100,
      boughtAt,
      sector: input.sector,
      checkDays: days,
      atr_14: input.atr_14 ?? null,
      structure: input.structure,
      breakout_state: input.breakout_state,
      sebi_banner: SEBI_BANNER,
      forecast,
    };

    upsertPaperForecast(pos);

    setBusy(false);
    setOpen(false);
    router.push(`/paper?highlight=${encodeURIComponent(pos.id)}`);
  }

  if (!canBuy) return null;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className={
          className ||
          "w-full rounded-xl border border-sky-500/40 bg-sky-500/15 py-2.5 text-sm font-semibold text-sky-200 hover:bg-sky-500/25"
        }
      >
        Paper buy → scenario path
      </button>

      {open ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-3 sm:items-center">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-xl space-y-3">
            <h3 className="text-lg font-semibold text-white">
              Paper buy · {input.ticker}
            </h3>
            <p className="text-xs text-slate-400">
              Paper scenario path (ATR) — research / learning only. Paper trade,
              not a real order. With sync on, the server fills at its own fresh
              quote and freezes the path.
            </p>
            <p className="text-sm text-slate-200">
              Entry {inr(input.entry)}
              {input.sl != null ? ` · SL ${inr(input.sl)}` : ""}
              {input.targets?.[0] != null ? ` · T1 ${inr(input.targets[0])}` : ""}
            </p>

            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">
                Check days (calendar offsets)
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {DEFAULT_CHECK_DAY_CHIPS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(d)}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                      days.includes(d)
                        ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                        : "border-slate-700 text-slate-300"
                    }`}
                  >
                    {d}d
                  </button>
                ))}
                {days
                  .filter((d) => !(DEFAULT_CHECK_DAY_CHIPS as readonly number[]).includes(d))
                  .map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDay(d)}
                      className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300"
                    >
                      {d}d ×
                    </button>
                  ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="Add day…"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none"
                />
                <button
                  type="button"
                  onClick={addCustom}
                  className="shrink-0 rounded-xl border border-slate-600 px-3 text-xs font-semibold text-slate-200"
                >
                  Add
                </button>
              </div>
            </div>

            {preview?.status === "skipped" ? (
              <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {preview.skip_reason} — fill still allowed without scenario path.
              </p>
            ) : preview?.points?.length ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-300 space-y-1 max-h-36 overflow-auto">
                <p className="font-semibold text-slate-200">
                  Scenario path · {preview.method} · scale {preview.params.scale}
                </p>
                {preview.points.map((p) => (
                  <p key={p.dayOffset}>
                    Day {p.dayOffset} ({p.targetDate}): {inr(p.predictedClose)}
                  </p>
                ))}
              </div>
            ) : null}

            {moved ? (
              <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                Price moved {moved.moved_pct}% (limit {moved.tolerance_pct}%). Server price now{" "}
                {inr(moved.server_price)}. Confirm again to paper-buy at the server price.
              </p>
            ) : null}
            {err ? <p className="text-xs text-rose-300">{err}</p> : null}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex-1 rounded-xl border border-slate-700 py-2.5 text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !days.length}
                onClick={() => void confirm()}
                className="flex-1 rounded-xl bg-emerald-500 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-60"
              >
                {busy ? "…" : moved ? "Confirm at server price" : "Confirm paper buy"}
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-500">{SEBI_BANNER}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
