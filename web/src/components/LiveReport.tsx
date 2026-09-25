"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ReportV1 } from "@/lib/reportTypes";
import { fmtDayLabel } from "@/lib/marketCalendar";
import { inr } from "@/lib/format";
import { SEBI_BANNER } from "@/lib/universe";

type Envelope = {
  report: ReportV1;
  stale: boolean;
  age_hours: number;
  expected_session: string;
  holiday?: { date: string; name: string };
  served_at: string;
  storage: "redis" | "ephemeral";
  storage_note?: string;
  served?: { source: string; note?: string };
};

function hhmmIst(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(new Date(iso)) + " IST";
  } catch {
    return iso;
  }
}

const num = (v: number | "UNKNOWN") => (v === "UNKNOWN" ? "UNKNOWN" : String(v));

export default function LiveReport({ fallback }: { fallback: ReactNode }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  const [env, setEnv] = useState<Envelope | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    fetch("/api/report/latest", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as (Envelope & { error?: string; note?: string }) | null;
        if (dead) return;
        if (r.ok && j?.report) {
          setEnv(j);
          setState("ok");
        } else {
          setErr(j?.note || j?.error || `HTTP ${r.status}`);
          setState("failed");
        }
      })
      .catch((e) => {
        if (!dead) {
          setErr(e instanceof Error ? e.message : "network error");
          setState("failed");
        }
      });
    return () => {
      dead = true;
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight text-white">Pre-market research digest</h1>
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
          Loading the latest report… If today&apos;s has not been built yet it is generated now from the prior close (can take up to a minute).
        </p>
        <p className="text-[11px] text-slate-500">{SEBI_BANNER}</p>
      </div>
    );
  }
  if (state === "failed" || !env) {
    return (
      <div className="space-y-3">
        <p className="rounded-xl border border-rose-500/50 bg-rose-500/10 p-3 text-sm font-semibold text-rose-200">
          FIXTURE — live report unavailable ({err}). Below is an old desk snapshot, not today&apos;s data.
        </p>
        {fallback}
      </div>
    );
  }

  const r = env.report;
  const s = r.sections;
  const mo = s.market_overview;
  const nFailed = r.unknowns.filter((u) => u.lane === "tech").length;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-white">Pre-market research digest</h1>
        <p className="text-sm text-slate-300">
          Pre-market research digest · Based on close of {fmtDayLabel(r.based_on_close)} (NSE, via Yahoo) · Generated {hhmmIst(r.generated_at)}
        </p>
        <p className="text-[11px] text-slate-500">{SEBI_BANNER}</p>
        <p className="text-[11px] text-slate-400">
          For session {fmtDayLabel(r.for_session)} · {r.status} · <span className="font-mono">{r.report_hash.slice(0, 12)}</span>
          {env.storage === "ephemeral" ? " · not archived (no database yet)" : ""}
        </p>
        {env.holiday ? (
          <p className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">NSE closed today ({env.holiday.name}). Showing the last report.</p>
        ) : null}
        {env.stale ? (
          <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            This is the {r.for_session} report ({env.age_hours} h old). Today&apos;s report has not been generated yet. Prices are older than the last session.
          </p>
        ) : null}
        {r.status === "partial" ? (
          <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Partial: {nFailed} of {mo.breadth.scanned + nFailed} symbols could not be fetched and are listed as UNKNOWN. Nothing was estimated.
          </p>
        ) : null}
        {env.served?.note ? <p className="text-xs text-amber-200">{env.served.note}</p> : null}
        <p className="text-[11px] text-slate-500">Pre-open / indicative prices are not used. Levels are from the prior close.</p>
      </header>

      <Card title="Market overview">
        <div className="space-y-1 text-sm text-slate-300">
          {mo.indices.map((i) => (
            <p key={i.symbol}>
              {i.name}: {num(i.close)} ({i.chg_pct === "UNKNOWN" ? "UNKNOWN" : `${i.chg_pct > 0 ? "+" : ""}${i.chg_pct}%`}){i.bar_date ? ` · ${i.bar_date}` : ""}
            </p>
          ))}
          <p className="text-xs text-slate-400">
            Breadth ({mo.breadth.scanned} scanned): above 50-DMA {mo.breadth.above_dma50} · HH/HL {mo.breadth.hh_hl} · buy {mo.breadth.buy} / hold {mo.breadth.hold} / avoid {mo.breadth.avoid} · unknown {mo.breadth.unknown}
          </p>
          {mo.global_cues.length ? (
            <p className="text-xs text-slate-400">
              Global: {mo.global_cues.map((g) => `${g.name} ${num(g.close)} (${g.chg_pct === "UNKNOWN" ? "UNKNOWN" : `${g.chg_pct}%`})`).join(" · ")}
            </p>
          ) : null}
          {mo.headlines.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-slate-400">
              {mo.headlines.slice(0, 6).map((h) => (
                <li key={h.headline}>
                  {h.link ? (
                    <a href={h.link} target="_blank" rel="noreferrer" className="hover:text-slate-200">
                      {h.headline}
                    </a>
                  ) : (
                    h.headline
                  )}
                  {h.source ? ` — ${h.source}` : ""} <span className="text-slate-600">({h.confirmation_status})</span>
                </li>
              ))}
            </ul>
          ) : null}
          {mo.not_available.length ? <p className="text-[11px] text-slate-500">Not available: {mo.not_available.join(", ")}</p> : null}
        </div>
      </Card>

      <Card title="Top 10 paper setups under ₹1000">
        <div className="space-y-2">
          {s.top10_under_1000.items.map((p) => (
            <Row
              key={p.ticker}
              left={`${p.rank}. ${p.ticker}`}
              mid={`${p.sector || "—"} · conf ${p.confidence_1_10}/10`}
              right={`Close ${inr(p.cmp)}`}
              sub={`SL ${inr(p.sl)} · ATR level T1 ${inr(p.t1)}${p.t2 != null ? ` · T2 ${inr(p.t2)}` : ""} · ${p.shares} sh ≈ ${inr(p.size_inr)} — ${p.plain_why}${p.risk_flags?.includes("funda_unknown") ? " · Fundamentals UNKNOWN (not verified)" : ""}`}
            />
          ))}
          {!s.top10_under_1000.items.length ? <Empty note={s.top10_under_1000.note} /> : null}
          {s.top10_under_1000.note && s.top10_under_1000.items.length ? <p className="text-[11px] text-slate-500">{s.top10_under_1000.note}</p> : null}
        </div>
      </Card>

      <Card title="Deep dive: top 3 paper setups">
        <div className="space-y-3">
          {s.deep_dive_top3.items.map((d) => (
            <div key={d.ticker} className="rounded-xl bg-slate-950/50 p-3 text-sm text-slate-300">
              <div className="flex justify-between">
                <span className="font-semibold text-white">{d.ticker}</span>
                <span className="text-xs text-slate-400">{inr(d.cmp)} · bar {d.bar_date}</span>
              </div>
              <p className="mt-1 text-xs">{d.plain_why}</p>
              <p className="mt-1 text-[11px] text-slate-400">
                {d.scenario_path_label}: {d.scenario_path.map((p) => `D${p.dayOffset} ${inr(p.predictedClose)}`).join(" · ") || "—"}
              </p>
              {d.risk_flags.length ? <p className="mt-1 text-[11px] text-amber-200">Flags: {d.risk_flags.join(", ")}</p> : null}
            </div>
          ))}
          {!s.deep_dive_top3.items.length ? <Empty note={s.deep_dive_top3.note} /> : null}
        </div>
      </Card>

      <Card title="5 names our gates skip">
        <div className="space-y-2">
          {s.avoids5.items.map((a) => (
            <Row key={a.ticker} left={a.ticker} mid={`${a.sector || "—"} · ${a.severity}`} right={inr(a.cmp)} sub={a.reason} />
          ))}
          {!s.avoids5.items.length ? <Empty note={s.avoids5.note} /> : null}
        </div>
      </Card>

      <Card title="Under ₹50 (awareness only)">
        <p className="mb-2 text-xs text-amber-200">{s.penny_under_50.warning}</p>
        <div className="space-y-2">
          {s.penny_under_50.items.map((p) => (
            <Row key={p.ticker} left={p.ticker} mid={p.action} right={inr(p.cmp)} sub={p.note} />
          ))}
          {!s.penny_under_50.items.length ? <Empty note={s.penny_under_50.note} /> : null}
        </div>
      </Card>

      <Card title="Final summary">
        <p className="text-sm font-medium text-slate-200">{s.final_summary.headline}</p>
        <p className="mt-2 text-xs text-slate-400">
          {Object.entries(s.final_summary.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}
        </p>
        {s.final_summary.changes_vs_prev.prev_key ? (
          <p className="mt-1 text-xs text-slate-400">
            vs {s.final_summary.changes_vs_prev.prev_key}: in {s.final_summary.changes_vs_prev.top10_in.join(", ") || "—"} · out {s.final_summary.changes_vs_prev.top10_out.join(", ") || "—"}
          </p>
        ) : null}
        {r.unknowns.length ? (
          <details className="mt-2 text-[11px] text-slate-500">
            <summary>UNKNOWN ({r.unknowns.length})</summary>
            <p className="mt-1">{r.unknowns.map((u) => `${u.ticker} (${u.lane}: ${u.reason})`).join(" · ")}</p>
          </details>
        ) : null}
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-slate-500">
          {r.data_notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">
          JSON: <span className="font-mono">/api/report/latest</span> · <span className="font-mono">/api/report/{r.for_session}</span>
        </p>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function Row({ left, mid, right, sub }: { left: string; mid: string; right: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-slate-950/50 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-white">{left}</div>
          {mid ? <div className="text-[11px] uppercase text-slate-500">{mid}</div> : null}
        </div>
        <div className="max-w-[55%] text-right text-sm text-slate-300">{right}</div>
      </div>
      {sub ? <p className="mt-1 text-xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

function Empty({ note }: { note?: string }) {
  return <p className="text-sm text-slate-500">{note || "None today."}</p>;
}
