#!/usr/bin/env python3
"""News Wire Desk — single-ticker Google News RSS scrape for /api/lookup.

Usage:
  python3 scrape_one.py SYMBOL
  python3 scrape_one.py SYMBOL --pretty

Stdout: one JSON LaneResult. Keyword heuristics only — never invents
catalysts, prices, or deal_value_inr. Missing / unclear → unknowns[].
RSS: news.google.com (14d, en-IN). Failures encoded in unknowns; exit 0.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

IST = timezone(timedelta(hours=5, minutes=30))
UA = "NSEStockLab-News/1.0 (+https://github.com/ajinkyabhosle1505-eng/nse-stock-lab)"

# Field keys Risk / lookup expect from News Wire (empty-scrape unknowns).
RISK_SUBSET_KEYS = [
    "headline",
    "summary",
    "event_type",
    "sentiment",
    "confidence_news",
    "confirmation_status",
    "tickers",
    "relevance",
    "impact_horizon",
    "catalyst_strength",
    "sectors",
    "macro_tags",
    "insider_side",
    "deal_value_inr",
    "as_of_ist",
    "why_for_verdict",
    "catalyst_expiry",
]

# --- Heuristic keyword tables (title/text only; documented, not LLM) ---
# confirmation_status:
#   "rumored" if reportedly / sources say / may / could / in talks / buzz
#   "denied"  if denies / clarifies false / refutes / not true
#   "confirmed" default for reputable wire headlines WITHOUT rumor words;
#               bump confidence when filing/corporate-action verbs present.
#   Wire headlines ≠ exchange filings — confidence_news 5–6 without filing verbs.
RUMOR_WORDS = (
    "reportedly", "sources say", "source say", "may ", "could ",
    "in talks", "in discussion", "rumor", "rumour", "buzz",
    "likely to", "expected to", "weighing", "mulling", "considering",
    "in-principle", "in principle", "said to be",
)
DENIED_WORDS = (
    "denies", "denied", "clarifies false", "refutes", "not true",
    "dismisses rumor", "no truth", "false report",
)
FILING_VERBS = (
    "allot", "allots", "allotted", "board approv", "files ", "filing",
    "sebi", "exchange", "announces", "announced", "raises ₹", "raises rs",
    "ncd", "at1", "approves", "approved", "incorpora", "appoints",
    "reappoint", "declares", "declared", "issues ", "issued ",
)

BULL_WORDS = (
    "surge", "rally", "jump", "soar", "gain", "profit", "raises",
    "upgrade", "beat", "record", "win", "wins", "order win", "bag",
    "bags", "approval", "allot", "growth", "strong", "boost",
)
BEAR_WORDS = (
    "fall", "falls", "drop", "drops", "plunge", "slump", "slip", "slips",
    "loss", "losses", "downgrade", "bearish", "miss", "probe", "raid",
    "fraud", "scam", "strike", "penalty", "fine", "default", "cut", "cuts",
    "weak", "decline", "warns", "warning", "terminate", "terminates",
)

# event_type keyword → label (first match wins; order matters)
EVENT_MAP: list[tuple[tuple[str, ...], str]] = [
    (("merger", "acquire", "acquisition", "m&a", "takeover", "demerger"), "mna"),
    (("order win", "wins order", "bags order", "secures order", "contract worth"), "order"),
    (("deal", "ncd", "at1", "bond issue", "raises ₹", "raises rs", "fund raise",
      "qip", "fpo", "preferential"), "deal"),
    (("sebi", "rbi", "policy", "regulation", "govt", "ministry", "cabinet"), "policy"),
    (("insider", "promoter buy", "promoter sell", "pledge", "encumbrance",
      "bulk deal", "block deal"), "insider"),
    (("result", "earnings", "q1 ", "q2 ", "q3 ", "q4 ", "pat ", "revenue",
      "profit after tax", "quarterly"), "results"),
    (("sector", "industry"), "sector"),
    (("macro", "inflation", "gdp", "crude", "fed ", "rate cut", "rate hike"), "macro"),
    (("rumor", "rumour", "reportedly", "sources say"), "rumor"),
]


def _now_ist() -> datetime:
    return datetime.now(IST)


def _fetch_rss(symbol: str, timeout: int = 20) -> tuple[str, str | None]:
    """Return (xml_text, error_note). error_note set on failure."""
    q = quote_plus(f"{symbol} NSE OR stock when:14d")
    url = (
        f"https://news.google.com/rss/search?q={q}"
        f"&hl=en-IN&gl=IN&ceid=IN:en"
    )
    req = Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/rss+xml, application/xml, text/xml, */*",
        },
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace"), None
    except (HTTPError, URLError, TimeoutError, OSError) as e:
        return "", f"fetch_failed:{type(e).__name__}:{e}"


def _parse_items(xml_text: str) -> list[dict[str, Any]]:
    """Parse up to 5 RSS items: title, link, pubDate."""
    if not xml_text.strip():
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    items: list[dict[str, Any]] = []
    # Google RSS: channel/item
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        pub_dt: datetime | None = None
        if pub:
            try:
                pub_dt = parsedate_to_datetime(pub)
                if pub_dt.tzinfo is None:
                    pub_dt = pub_dt.replace(tzinfo=timezone.utc)
                pub_dt = pub_dt.astimezone(IST)
            except (TypeError, ValueError, IndexError, OverflowError):
                pub_dt = None
        if title:
            items.append({"title": title, "link": link, "pubDate": pub_dt})
        if len(items) >= 5:
            break
    return items


def _prefer_items(items: list[dict[str, Any]], ticker: str) -> list[dict[str, Any]]:
    """Prefer titles that mention the ticker / common company tokens."""
    t = ticker.upper()
    # Light alias hints for common NSE names (keyword-only, no invented news).
    aliases: dict[str, tuple[str, ...]] = {
        "PNB": ("punjab national", "pnb"),
        "COALINDIA": ("coal india", "cil", "coalindia"),
        "IDEA": ("vodafone idea", "vodafone-idea", "vi ", " idea"),
        "RELIANCE": ("reliance industries", "ril", "reliance"),
        "SBIN": ("state bank", "sbi "),
        "HDFCBANK": ("hdfc bank", "hdfcbank"),
        "BANKBARODA": ("bank of baroda", "bob "),
        "CANBK": ("canara bank", "canbk"),
        "YESBANK": ("yes bank", "yesbank"),
        "POWERGRID": ("power grid", "powergrid"),
        "IRFC": ("irfc", "indian railway finance"),
        "RECLTD": ("rec ltd", "rec limited", " rural electrification"),
        "NMDC": ("nmdc",),
        "VEDL": ("vedanta", "vedl"),
        "ONGC": ("ongc", "oil and natural"),
        "IOC": ("indian oil", "ioc "),
        "BPCL": ("bharat petroleum", "bpcl"),
        "NTPC": ("ntpc",),
        "ITC": ("itc ", "itc ltd"),
        "PFC": ("power finance", "pfc "),
    }
    needles = [t.lower()] + list(aliases.get(t, ()))
    scored: list[tuple[int, dict[str, Any]]] = []
    for it in items:
        title_l = it["title"].lower()
        hit = 1 if any(n.strip() in title_l for n in needles) else 0
        scored.append((hit, it))
    scored.sort(key=lambda x: (-x[0],))
    return [it for _, it in scored]


def _confirmation_status(text: str) -> tuple[str, int]:
    """Return (status, confidence_hint). See module docstring heuristics."""
    tl = text.lower()
    if any(w in tl for w in DENIED_WORDS):
        return "denied", 7
    if any(w in tl for w in RUMOR_WORDS):
        return "rumored", 5
    has_filing = any(w in tl for w in FILING_VERBS)
    # Default confirmed for wire headlines without rumor words;
    # lower confidence when not a clear corporate-action / filing verb.
    if has_filing:
        return "confirmed", 8
    return "confirmed", 6


def _sentiment(text: str) -> str:
    tl = text.lower()
    bull = sum(1 for w in BULL_WORDS if w in tl)
    bear = sum(1 for w in BEAR_WORDS if w in tl)
    if bull and bear:
        return "mixed"
    if bull:
        return "bull"
    if bear:
        return "bear"
    return "neutral"


def _event_type(text: str) -> str:
    tl = text.lower()
    for keys, label in EVENT_MAP:
        if any(k in tl for k in keys):
            return label
    return "other"


def _parse_deal_value_inr(text: str) -> float | None:
    """Parse ₹ / Cr / crore from title only when clear; else None (no invent)."""
    # ₹12,000 Cr / Rs 2042 crore / INR 35000 Cr
    pats = [
        r"(?:₹|rs\.?|inr)\s*([\d,.]+)\s*(?:lakh\s*)?cr(?:ore)?s?",
        r"([\d,.]+)\s*(?:lakh\s*)?cr(?:ore)?s?\s*(?:ncd|at1|bond|deal|package|raise)",
    ]
    tl = text.lower().replace(",", "")
    for pat in pats:
        m = re.search(pat, tl, re.I)
        if not m:
            continue
        try:
            num = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if "lakh cr" in tl[max(0, m.start() - 5) : m.end() + 12]:
            # e.g. ₹1.45 lakh Cr → 1.45 * 100000 Cr → INR
            return num * 100_000 * 10_000_000
        # Cr → INR (1 Cr = 10_000_000)
        return num * 10_000_000
    return None


def _has_numbers(text: str) -> bool:
    return bool(re.search(r"\d", text))


def _catalyst_strength(event_type: str, text: str, deal: float | None) -> str:
    tl = text.lower()
    if deal is not None and deal > 0:
        return "high"
    if event_type in {"deal", "order", "results", "mna"} and _has_numbers(text):
        return "high"
    if len(tl) < 40 or event_type == "other" and not _has_numbers(text):
        return "low"
    return "med"


def _impact_horizon(event_type: str, pub_dt: datetime | None, text: str) -> str:
    tl = text.lower()
    if event_type == "mna" or "ipo" in tl or "merger" in tl:
        return "medium"
    if pub_dt is not None:
        today = _now_ist().date()
        if pub_dt.astimezone(IST).date() == today:
            return "intraday"
    return "near_term"


def _catalyst_expiry(
    impact_horizon: str, event_type: str, text: str
) -> tuple[str | None, bool]:
    """Return (expiry, unclear). unclear → caller adds to unknowns."""
    tl = text.lower()
    if impact_horizon == "intraday":
        return "intraday", False
    if event_type == "results" or re.search(
        r"\b\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", tl
    ):
        return "event_date", False
    if impact_horizon in {"near_term", "medium"}:
        return "days", False
    return None, True


def _empty_result(ticker: str, note: str) -> dict[str, Any]:
    now = _now_ist().isoformat()
    fields: dict[str, Any] = {
        "headline": None,
        "summary": None,
        "event_type": None,
        "sentiment": None,
        "confidence_news": None,
        "confirmation_status": None,
        "tickers": [ticker],
        "relevance": "primary",
        "impact_horizon": None,
        "catalyst_strength": None,
        "sectors": [],
        "macro_tags": [],
        "insider_side": None,
        "deal_value_inr": None,
        "as_of_ist": now,
        "why_for_verdict": note,
        "catalyst_expiry": None,
    }
    # unknowns = Risk subset keys that are null / unusable
    unknowns = [
        k
        for k in RISK_SUBSET_KEYS
        if fields.get(k) is None
        or (k in ("sectors", "macro_tags") and fields.get(k) == [])
    ]
    # tickers/relevance/as_of/why always present — drop those from unknowns
    for keep in ("tickers", "relevance", "as_of_ist", "why_for_verdict"):
        if keep in unknowns:
            unknowns.remove(keep)
    return {
        "ticker": ticker,
        "fields": fields,
        "unknowns": unknowns,
        "sources": [],
        "ts": now,
    }


def scrape_one(symbol: str) -> dict[str, Any]:
    ticker = symbol.strip().upper().replace(".NS", "").replace(".BO", "")
    xml_text, err = _fetch_rss(ticker)
    items = _parse_items(xml_text)
    if not items:
        note = (
            f"scrape missed: {err}"
            if err
            else "scrape missed: empty Google News RSS (14d)"
        )
        return _empty_result(ticker, note)

    ranked = _prefer_items(items, ticker)
    primary = ranked[0]
    # Build a short summary from up to 3 preferred titles (no invented prose).
    titles = [it["title"] for it in ranked[:3]]
    headline = primary["title"]
    summary = " | ".join(titles) if len(titles) > 1 else titles[0]
    blob = " ".join(titles)

    conf_status, conf_hint = _confirmation_status(blob)
    sentiment = _sentiment(blob)
    event_type = _event_type(blob)
    deal = _parse_deal_value_inr(headline)  # title only, never invent
    if deal is None:
        # try other titles only if clear ₹/Cr pattern
        for t in titles[1:]:
            deal = _parse_deal_value_inr(t)
            if deal is not None:
                break

    strength = _catalyst_strength(event_type, blob, deal)
    horizon = _impact_horizon(event_type, primary.get("pubDate"), blob)
    expiry, expiry_unclear = _catalyst_expiry(horizon, event_type, blob)

    # Confidence: filing verbs → higher; rumor → lower; thin text → lower
    confidence = conf_hint
    if strength == "low":
        confidence = min(confidence, 5)
    if conf_status == "rumored":
        confidence = min(confidence, 6)
    confidence = max(1, min(10, confidence))

    as_of = primary.get("pubDate") or _now_ist()
    if isinstance(as_of, datetime):
        as_of_ist = as_of.astimezone(IST).isoformat()
    else:
        as_of_ist = _now_ist().isoformat()

    why = (
        f"{conf_status} {event_type} via Google News RSS; "
        f"strength={strength}; sentiment={sentiment}."
    )
    if conf_status == "confirmed" and conf_hint <= 6:
        why += " Wire headline without filing verb — confidence capped."

    fields: dict[str, Any] = {
        "headline": headline,
        "summary": summary,
        "event_type": event_type,
        "sentiment": sentiment,
        "confidence_news": confidence,
        "confirmation_status": conf_status,
        "tickers": [ticker],
        "relevance": "primary",
        "impact_horizon": horizon,
        "catalyst_strength": strength,
        "sectors": [],
        "macro_tags": [],
        "insider_side": None,
        "deal_value_inr": deal,
        "as_of_ist": as_of_ist,
        "why_for_verdict": why[:240],
        "catalyst_expiry": expiry,
    }

    unknowns: list[str] = []
    if deal is None:
        unknowns.append("deal_value_inr")
    if expiry_unclear or expiry is None:
        unknowns.append("catalyst_expiry")
        fields["catalyst_expiry"] = None
    # sectors / macro_tags / insider_side intentionally empty without inventing
    unknowns.extend(["sectors", "macro_tags", "insider_side"])
    unknowns = sorted(set(unknowns))

    sources = [it["link"] for it in ranked if it.get("link")][:5]

    return {
        "ticker": ticker,
        "fields": fields,
        "unknowns": unknowns,
        "sources": sources,
        "ts": _now_ist().isoformat(),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="News Wire Google RSS scrape_one")
    ap.add_argument("symbol", help="NSE symbol, e.g. PNB or RELIANCE")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()
    try:
        result = scrape_one(args.symbol)
    except Exception as e:  # noqa: BLE001 — always emit JSON
        result = _empty_result(
            args.symbol.strip().upper(),
            f"scrape missed: unexpected:{type(e).__name__}:{e}",
        )
    if args.pretty:
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
