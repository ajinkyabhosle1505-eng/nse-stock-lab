"""Map DeskJob lane + verdict blobs → NSE Stock Lab daily report (6 sections)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SEBI = (
    "Not SEBI-registered advice. Paper / research only. "
    "Past or hypothetical levels are not a recommendation to buy or sell."
)


def _cmp(pack: dict, ticker: str) -> Any:
    tech = pack.get("lanes", {}).get("tech") or {}
    if tech.get("ticker") == ticker:
        return (tech.get("fields") or {}).get("cmp")
    return None


def map_daily_report(pack: dict) -> dict:
    job = pack.get("desk_job") or {}
    overview = pack.get("market_overview") or {}
    verdicts: list[dict] = list(pack.get("verdicts") or [])

    buys = [v for v in verdicts if v.get("action") == "buy" and not v.get("insufficient_data")]
    holds = [v for v in verdicts if v.get("action") == "hold"]
    avoids = [v for v in verdicts if v.get("action") == "avoid"]

    # Soft avoid-for-fresh-longs: holds with avoids_note (Risk guidance)
    soft_avoids = [v for v in holds if v.get("avoids_note")]

    under_1000 = []
    for v in buys:
        cmp_v = _cmp(pack, v["ticker"])
        if cmp_v is not None and cmp_v < 1000:
            under_1000.append({**v, "cmp": cmp_v})
    under_1000.sort(key=lambda x: (-(x.get("confidence_1_10") or 0), x["ticker"]))
    top10 = under_1000[:10]

    deep_dive = []
    for v in top10[:3]:
        t = v["ticker"]
        deep_dive.append(
            {
                "ticker": t,
                "verdict": v,
                "tech": pack.get("lanes", {}).get("tech") if t == (pack.get("lanes", {}).get("tech") or {}).get("ticker") else None,
                "funda": pack.get("lanes", {}).get("funda") if t == (pack.get("lanes", {}).get("funda") or {}).get("ticker") else None,
                "news": pack.get("lanes", {}).get("news") if t == (pack.get("lanes", {}).get("news") or {}).get("ticker") else None,
            }
        )

    # Hard avoids + soft (fresh-long) rows for section 4
    section4 = []
    for v in avoids[:5]:
        section4.append(
            {
                "ticker": v["ticker"],
                "kind": "avoid",
                "confidence_1_10": v.get("confidence_1_10"),
                "note": "; ".join(v.get("reasons") or []) or v.get("avoids_note"),
                "risk_flags": v.get("risk_flags") or [],
            }
        )
    for v in soft_avoids:
        if len(section4) >= 5:
            break
        if any(r["ticker"] == v["ticker"] for r in section4):
            continue
        section4.append(
            {
                "ticker": v["ticker"],
                "kind": "soft_avoid_fresh_longs",
                "confidence_1_10": v.get("confidence_1_10"),
                "note": v.get("avoids_note"),
                "risk_flags": v.get("risk_flags") or [],
            }
        )

    pennies = []
    for v in buys:
        cmp_v = _cmp(pack, v["ticker"])
        if cmp_v is not None and cmp_v < 50:
            pennies.append({**v, "cmp": cmp_v})

    report = {
        "report_id": f"daily-{job.get('job_id', 'unknown')}",
        "as_of": job.get("as_of"),
        "budget_inr": job.get("budget_inr"),
        "sebi_banner": SEBI,
        "sections": {
            "1_market_overview": {
                "indices_note": overview.get("indices_note"),
                "global_cues": overview.get("global_cues") or [],
                "policy_watch": overview.get("policy_watch") or [],
                "sector_flows": overview.get("sector_flows") or [],
            },
            "2_top10_under_1000": {
                "items": [
                    {
                        "ticker": v["ticker"],
                        "cmp": v.get("cmp"),
                        "action": v.get("action"),
                        "confidence_1_10": v.get("confidence_1_10"),
                        "entry": v.get("entry"),
                        "sl": v.get("sl"),
                        "targets": v.get("targets") or [],
                        "size_inr": v.get("size_inr"),
                    }
                    for v in top10
                ],
                "note": "Empty when no buy verdicts under ₹1000 (smoke: RELIANCE is hold)."
                if not top10
                else None,
            },
            "3_deep_dive_top3": {
                "items": deep_dive,
                "note": "Empty when Top 10 is empty — holds are not deep-dive buys."
                if not deep_dive
                else None,
            },
            "4_five_avoids": {
                "items": section4[:5],
            },
            "5_penny_under_50": {
                "items": [
                    {
                        "ticker": v["ticker"],
                        "cmp": v.get("cmp"),
                        "confidence_1_10": v.get("confidence_1_10"),
                        "entry": v.get("entry"),
                        "sl": v.get("sl"),
                    }
                    for v in pennies
                ],
                "note": "Empty when no buy under ₹50." if not pennies else None,
            },
            "6_final_summary": {
                "universe": job.get("universe") or [],
                "buys": [v["ticker"] for v in buys],
                "holds": [v["ticker"] for v in holds],
                "avoids": [v["ticker"] for v in avoids],
                "soft_avoid_fresh_longs": [v["ticker"] for v in soft_avoids],
                "paper_fills": "none — no buy actions",
                "headline": (
                    f"{len(buys)} buy / {len(holds)} hold / {len(avoids)} avoid on "
                    f"{len(job.get('universe') or [])} names; risk_pct={job.get('risk_pct')}."
                ),
            },
        },
    }
    return report


def render_markdown(report: dict) -> str:
    s = report["sections"]
    lines = [
        f"# Daily desk report — {report.get('as_of', '')}",
        "",
        f"> {report['sebi_banner']}",
        "",
        "## 1. Market overview",
        s["1_market_overview"].get("indices_note") or "_(no overview)_",
        "",
        "**Global cues:** " + ("; ".join(s["1_market_overview"]["global_cues"]) or "—"),
        "**Sector flows:** " + ("; ".join(s["1_market_overview"]["sector_flows"]) or "—"),
        "",
        "## 2. Top 10 under ₹1000",
    ]
    items = s["2_top10_under_1000"]["items"]
    if not items:
        lines.append(s["2_top10_under_1000"].get("note") or "_(none)_")
    else:
        for i, it in enumerate(items, 1):
            lines.append(
                f"{i}. `{it['ticker']}` cmp={it.get('cmp')} conf={it.get('confidence_1_10')} "
                f"entry={it.get('entry')} sl={it.get('sl')}"
            )
    lines += ["", "## 3. Deep dive top 3"]
    dd = s["3_deep_dive_top3"]["items"]
    if not dd:
        lines.append(s["3_deep_dive_top3"].get("note") or "_(none)_")
    else:
        for it in dd:
            lines.append(f"### {it['ticker']}")
            lines.append(json.dumps(it.get("verdict"), indent=2)[:500])
    lines += ["", "## 4. Five avoids (incl. soft avoid fresh longs)"]
    for it in s["4_five_avoids"]["items"]:
        lines.append(f"- `{it['ticker']}` [{it['kind']}] — {it.get('note')}")
        if it.get("risk_flags"):
            lines.append(f"  flags: {', '.join(it['risk_flags'])}")
    if not s["4_five_avoids"]["items"]:
        lines.append("_(none)_")
    lines += ["", "## 5. Penny under ₹50"]
    p = s["5_penny_under_50"]["items"]
    lines.append(s["5_penny_under_50"].get("note") if not p else "")
    for it in p:
        lines.append(f"- `{it['ticker']}` cmp={it.get('cmp')}")
    lines += [
        "",
        "## 6. Final summary",
        s["6_final_summary"]["headline"],
        f"Holds: {', '.join(s['6_final_summary']['holds']) or '—'}",
        f"Soft avoid fresh longs: {', '.join(s['6_final_summary']['soft_avoid_fresh_longs']) or '—'}",
        f"Paper fills: {s['6_final_summary']['paper_fills']}",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    fixture = root / "fixtures" / "reliance_smoke.json"
    pack = json.loads(fixture.read_text())
    report = map_daily_report(pack)
    out_json = root / "daily_report" / "out" / "reliance_smoke_report.json"
    out_md = root / "daily_report" / "out" / "reliance_smoke_report.md"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2))
    out_md.write_text(render_markdown(report))
    print(f"wrote {out_json}")
    print(f"wrote {out_md}")
    print(render_markdown(report))


if __name__ == "__main__":
    main()
