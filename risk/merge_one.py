#!/usr/bin/env python3
"""Risk Verdict — merge Tech (+ optional Funda/News) JSON → Verdict on stdout.

Usage:
  python3 merge_one.py --tech tech.json [--funda funda.json] [--news news.json] \\
      [--budget 10000] [--risk-pct 1] [--pretty]

Mirrors web/src/lib/risk.ts mergeVerdict. Never invents CMP.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any

SEBI = (
    "Not SEBI-registered advice. Paper / research only. "
    "Levels are not a recommendation to buy or sell."
)


def _num(x: Any) -> float | None:
    if isinstance(x, bool) or x is None:
        return None
    if isinstance(x, (int, float)) and not (
        isinstance(x, float) and math.isnan(x)
    ):
        return float(x)
    return None


def _round(n: float, d: int = 2) -> float:
    return round(n, d)


MICRO_BUDGET_INR = 2500


def size_position(
    budget: float, risk_pct: float, entry: float, sl: float
) -> dict[str, Any]:
    risk_inr = budget * (risk_pct / 100.0)
    per = entry - sl
    if per <= 0:
        return {
            "ok": False,
            "shares": 0,
            "size_inr": 0,
            "reason": "per_share<=0",
        }
    shares = int(risk_inr // per)
    micro = False
    # P0a: micro-budget 1-share floor when risk% cannot fund a share
    if shares < 1:
        if budget <= MICRO_BUDGET_INR and entry <= budget:
            shares = 1
            micro = True
        else:
            return {"ok": False, "shares": 0, "size_inr": 0, "reason": "shares<1"}
    while shares >= 1 and entry * shares > budget:
        shares -= 1
    if shares < 1:
        return {
            "ok": False,
            "shares": 0,
            "size_inr": 0,
            "reason": "notional>budget",
        }
    return {
        "ok": True,
        "shares": shares,
        "size_inr": _round(entry * shares),
        "reason": "micro_floor_1share" if micro else None,
    }


def merge(
    tech: dict,
    funda: dict | None,
    news: dict | None,
    budget: float,
    risk_pct: float,
) -> dict:
    f = tech.get("fields") or {}
    cmp = _num(f.get("cmp"))
    atr = _num(f.get("atr_14"))
    supports = [x for x in (f.get("support_levels") or []) if _num(x) is not None]
    structure = f.get("structure")
    brk = f.get("breakout_state")
    pvd = f.get("price_vs_dma")
    rsi = _num(f.get("rsi_14"))
    trigger = f.get("trigger_level")

    ff = (funda or {}).get("fields") or {}
    nf = (news or {}).get("fields") or {}
    sector = ff.get("sector")
    quality = ff.get("funda_quality") or ff.get("funda_quality")
    conf = nf.get("confirmation_status") or nf.get("confirmation_status")
    strength = nf.get("catalyst_strength") or nf.get("catalyst_strength")
    sentiment = nf.get("sentiment")
    why = nf.get("why_for_verdict") or nf.get("why_for_verdict")
    expiry = nf.get("catalyst_expiry") or nf.get("catalyst_expiry")
    red = ff.get("red_flags") if isinstance(ff.get("red_flags"), list) else (ff.get("red_flags") if isinstance(ff.get("red_flags"), list) else [])

    if cmp is None:
        return {
            "ticker": tech.get("ticker"),
            "action": "avoid",
            "confidence_1_10": 1,
            "entry": None,
            "sl": None,
            "targets": [],
            "size_inr": None,
            "shares": None,
            "r_r": None,
            "reasons": ["CMP UNKNOWN — cannot size"],
            "risk_flags": ["insufficient_yahoo"],
            "avoids_note": "No live CMP",
            "insufficient_data": True,
            "sebi_banner": SEBI,
            "cmp": "UNKNOWN",
            "buy_trigger": None,
            "sell_targets": [],
            "stop_invalidation": None,
            "time_horizon": None,
            "live": True,
        }

    entry = cmp
    if supports:
        sl = _round(min(float(x) for x in supports) * 0.998)
    elif atr and atr > 0:
        sl = _round(entry - 1.5 * atr)
    else:
        sl = _round(entry * 0.97)

    targets: list[float] = []
    if atr and atr > 0:
        targets = [_round(entry + 2 * atr), _round(entry + 3.5 * atr)]

    reasons: list[str] = []
    flags: list[str] = []
    soft = (
        brk != "breakdown"
        and structure != "LH_LL"
        and pvd in ("above", "mixed")
        and rsi is not None
        and 48 <= rsi <= 62
    )
    favor = brk == "breakout" or structure == "HH_HL" or soft
    hold_avoid = brk == "breakdown" or (
        pvd == "below" and structure == "LH_LL"
    )

    if hold_avoid:
        favor = False
        reasons.append(
            "Tape: breakdown — no fresh long"
            if brk == "breakdown"
            else "Tape: below DMAs + LH_LL — hold/avoid"
        )
        flags.append("breakdown" if brk == "breakdown" else "below_dma_lh_ll")
    elif brk == "breakout":
        reasons.append(f"Tape: breakout, price_vs_dma={pvd}, RSI~{rsi}")
    elif structure == "HH_HL":
        reasons.append(f"Tape: HH_HL, price_vs_dma={pvd}, RSI~{rsi}")
    elif soft:
        reasons.append(
            f"Tape: constructive (structure={structure}, price_vs_dma={pvd}, RSI~{round(rsi)}) — multi-sector soft long"
        )
    else:
        reasons.append(
            f"Tape: structure={structure}, breakout={brk}, price_vs_dma={pvd}"
        )

    force_avoid = False
    if quality == "fail":
        favor, force_avoid = False, True
        flags.append("funda_quality=fail")
        reasons.append("Funda: quality=fail")
    elif quality == "watch":
        flags.append("funda_quality=watch")
        reasons.append("Funda: quality=watch")
    elif quality == "pass":
        flags.append("funda_quality=pass")
        reasons.append("Funda: quality=pass")
    if red:
        flags.append(f"red_flags:{len(red)}")
        reasons.append(f"Funda: {len(red)} red_flags (informational)")
    if conf == "rumored" and strength in ("med", "high"):
        favor = False
        flags.append("news_rumored")
        reasons.append("News: rumored — no chase")
    if sentiment == "bear" and conf == "confirmed":
        favor = False
        flags.append("news_bear_confirmed")
        reasons.append("News: confirmed bearish")
    if why:
        reasons.append(f"News why: {why}")

    sized = size_position(budget, risk_pct, entry, sl)
    action = "hold"
    confidence = 4
    if force_avoid:
        action, confidence = "avoid", 5
    elif hold_avoid:
        action = "avoid" if "breakdown" in flags else "hold"
        confidence = 5
    elif favor and sized["ok"]:
        action = "buy"
        confidence = 6
        if brk == "breakout":
            confidence += 1
        if pvd == "above":
            confidence += 1
        if quality == "pass":
            confidence += 1
        if quality == "watch":
            confidence -= 1
        confidence = max(1, min(9, confidence))
    elif favor and not sized["ok"]:
        action, confidence = "hold", 5
        flags.append(f"size_blocked:{sized['reason']}")
        reasons.append(f"Size blocked ({sized['reason']})")

    risk = entry - sl
    r_r = (
        _round((targets[0] - entry) / risk, 2) if targets and risk > 0 else None
    )

    if isinstance(trigger, (int, float)):
        buy_trigger = (
            f"Hold above breakout/trigger {trigger} (CMP~{entry})"
            if brk == "breakout"
            else f"Reclaim/hold trigger {trigger}; CMP~{entry}"
        )
    else:
        buy_trigger = (
            f"Buy zone near CMP {entry} if structure stays constructive"
        )

    if expiry == "intraday":
        horizon = "intraday / 1–2 sessions (event)"
    elif expiry == "days":
        horizon = "3–10 trading days (catalyst window)"
    elif expiry == "event_date":
        horizon = "event-driven — exit into/after event"
    else:
        horizon = "2–6 weeks (swing)"

    return {
        "ticker": tech.get("ticker"),
        "action": action,
        "confidence_1_10": confidence,
        "entry": entry,
        "sl": sl,
        "targets": targets,
        "size_inr": sized["size_inr"]
        if action == "buy" and sized["ok"]
        else None,
        "shares": sized["shares"] if action == "buy" and sized["ok"] else None,
        "r_r": r_r,
        "reasons": reasons,
        "risk_flags": flags,
        "avoids_note": reasons[0] if action == "avoid" else None,
        "insufficient_data": False,
        "sebi_banner": SEBI,
        "cmp": cmp,
        "under_1000": cmp < 1000,
        "penny_under_50": cmp < 50,
        "sector": sector,
        "buy_trigger": buy_trigger,
        "sell_targets": targets,
        "stop_invalidation": sl,
        "time_horizon": horizon,
        "live": True,
        "yahoo_symbol": tech.get("yahoo_symbol"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tech", required=True)
    ap.add_argument("--funda")
    ap.add_argument("--news")
    ap.add_argument("--budget", type=float, default=10000)
    ap.add_argument("--risk-pct", type=float, default=1)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()
    tech = json.load(open(args.tech))
    # Allow full lane file or single result
    if "results" in tech and isinstance(tech["results"], list):
        print("Pass a single-ticker tech JSON, not a lane file", file=sys.stderr)
        return 2
    funda = json.load(open(args.funda)) if args.funda else None
    news = json.load(open(args.news)) if args.news else None
    out = merge(tech, funda, news, args.budget, args.risk_pct)
    print(json.dumps(out, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
