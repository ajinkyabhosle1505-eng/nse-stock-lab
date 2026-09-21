#!/usr/bin/env python3
"""Funda Desk — single-ticker Screener scrape for /api/lookup.

Usage:
  python3 scrape_one.py SYMBOL
  python3 scrape_one.py SYMBOL --pretty

Stdout: one JSON object. Never invents numbers — missing → unknowns[].
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

IST = timezone(timedelta(hours=5, minutes=30))
UA = (
    "Mozilla/5.0 (compatible; NSEStockLab-Funda/1.0; "
    "+https://github.com/ajinkyabhosle1505-eng/nse-stock-lab)"
)

BANKISH = {
    "HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK",
    "BANKBARODA", "PNB", "CANBK", "UNIONBANK", "BANKINDIA", "IDFCFIRSTB",
    "YESBANK", "FEDERALBNK", "RBLBANK",
}


def _fetch(url: str, timeout: int = 25) -> str:
    req = Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _num(s: str | None) -> float | None:
    if s is None:
        return None
    t = s.strip().replace(",", "").replace("%", "")
    if not t or t in {"—", "-", "NA", "N/A", ""}:
        return None
    t = re.sub(r"[^0-9.+-]", "", t)
    if not t or t in {"+", "-", "."}:
        return None
    try:
        return float(t)
    except ValueError:
        return None


class _TextCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript"}:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if self._skip:
            return
        t = data.strip()
        if t:
            self.parts.append(t)


def _plain(html: str) -> str:
    p = _TextCollector()
    try:
        p.feed(html)
    except Exception:
        pass
    return "\n".join(p.parts)


def _ratio(plain: str, label: str) -> float | None:
    pat = re.compile(
        rf"{re.escape(label)}\s*\n\s*([0-9.,]+%?|—|-)",
        re.IGNORECASE,
    )
    m = pat.search(plain)
    if m:
        return _num(m.group(1))
    pat2 = re.compile(
        rf"{re.escape(label)}\s*[:]?\s*([0-9.,]+%?)",
        re.IGNORECASE,
    )
    m2 = pat2.search(plain)
    return _num(m2.group(1)) if m2 else None


def _sector(plain: str) -> str | None:
    m = re.search(r"Sector:\s*\n?\s*([^\n]+)", plain, re.I)
    if m:
        return m.group(1).strip()[:80]
    return None


def _market_cap_bucket(mcap_cr: float | None) -> str | None:
    if mcap_cr is None:
        return None
    if mcap_cr >= 50000:
        return "large"
    if mcap_cr >= 5000:
        return "mid"
    return "small"


def _cons_lines(plain: str) -> list[str]:
    """Prefer Screener Cons block; never treat Pros as red flags."""
    out: list[str] = []
    m = re.search(r"\nCons\n(.+?)(?:\nPros\n|\nPeers\n|$)", plain, re.S | re.I)
    block = m.group(1) if m else ""
    lines = block.split("\n") if block else plain.split("\n")
    neg = (
        "pledge", "low return", "high debt", "declin", "negative",
        "poor sales", "contingent", "working capital", "low interest",
        "low return on equity", "poor ", "high debtor",
    )
    for line in lines:
        line = line.strip()
        if not (12 <= len(line) <= 180):
            continue
        if line.lower().startswith("http"):
            continue
        # Skip clear positives even if under Cons mis-parse
        if any(k in line.lower() for k in ("good profit", "healthy dividend", "strong ", "consistent")):
            continue
        if any(k in line.lower() for k in neg) or (
            block and (line.startswith("Company has") or line.startswith("Company is"))
        ):
            if line not in out:
                out.append(line[:180])
        if len(out) >= 5:
            break
    return out[:5]


def _funda_quality(
    pe: float | None,
    roe: float | None,
    de: float | None,
    pledge: float | None,
    red_flags: list[str],
    unknowns: list[str],
    ticker: str,
) -> str:
    heavy = 0
    for f in red_flags:
        fl = f.lower()
        if any(k in fl for k in ("pledge", "negative book", "zero promoter", "fraud")):
            heavy += 2
        elif any(k in fl for k in ("low return", "high debt", "declin", "poor sales", "low roe")):
            heavy += 1
    if pledge is not None and pledge >= 10:
        heavy += 2
    if de is not None and ticker not in BANKISH and de >= 3:
        heavy += 1
    if pe is not None and pe >= 60:
        heavy += 1

    if heavy >= 3 or ("pe_ttm" in unknowns and "roe_pct" in unknowns):
        return "fail"
    if heavy >= 1 or pe is None or roe is None or (roe is not None and roe < 8):
        return "watch"
    return "pass"


def scrape_one(symbol: str) -> dict[str, Any]:
    ticker = symbol.strip().upper().replace(".NS", "").replace(".BO", "")
    urls = [
        f"https://www.screener.in/company/{ticker}/consolidated/",
        f"https://www.screener.in/company/{ticker}/",
    ]
    html = ""
    used = ""
    errors: list[str] = []
    for url in urls:
        try:
            html = _fetch(url)
            used = url
            if len(html) < 5000 and "consolidated" in url:
                errors.append(f"short_html:{url}")
                continue
            break
        except (HTTPError, URLError, TimeoutError, OSError) as e:
            errors.append(f"{url}:{e}")
            continue

    unknowns: list[str] = []
    fields: dict[str, Any] = {}
    sources: list[str] = []

    if not html:
        return {
            "ticker": ticker,
            "fields": {
                "funda_quality": "fail",
                "red_flags": ["scrape_failed"],
            },
            "unknowns": [
                "pe_ttm", "roe_pct", "debt_equity", "promoter_pledge_pct",
                "sector", "market_cap_bucket",
            ],
            "sources": [],
            "note": "; ".join(errors) or "fetch_failed",
            "ts": datetime.now(IST).isoformat(),
        }

    sources.append(used)
    plain = _plain(html)

    pe = _ratio(plain, "Stock P/E")
    if pe is None:
        pe = _ratio(plain, "P/E")
    roe = _ratio(plain, "ROE")
    roce = _ratio(plain, "ROCE")
    bv = _ratio(plain, "Book Value")
    cmp_ = _ratio(plain, "Current Price")
    pb = round(cmp_ / bv, 2) if bv and cmp_ and bv != 0 else None
    mcap = _ratio(plain, "Market Cap")
    de = _ratio(plain, "Debt to equity")
    if de is None:
        de = _ratio(plain, "Debt / Equity")
    pledge = _ratio(plain, "Pledged percentage")
    promoter = None  # shareholding table is noisy in plain text
    sector = _sector(plain)
    red_flags = _cons_lines(plain)

    def put(key: str, val: Any) -> None:
        if val is None:
            unknowns.append(key)
        else:
            fields[key] = val

    put("pe_ttm", pe)
    put("roe_pct", roe)
    put("roce_pct", roce)
    put("pb", pb)
    if ticker in BANKISH:
        unknowns.append("debt_equity")
    else:
        put("debt_equity", de)
    put("promoter_pledge_pct", pledge)
    put("promoter_holding_pct", promoter)
    put("sector", sector)
    put("market_cap_bucket", _market_cap_bucket(mcap))
    fields["red_flags"] = red_flags

    unknowns = sorted(set(unknowns))
    fields["funda_quality"] = _funda_quality(
        pe, roe, de, pledge, red_flags, unknowns, ticker
    )

    return {
        "ticker": ticker,
        "fields": fields,
        "unknowns": unknowns,
        "sources": sources,
        "ts": datetime.now(IST).isoformat(),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Funda Desk Screener scrape_one")
    ap.add_argument("symbol", help="NSE symbol, e.g. PNB or RELIANCE")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()
    result = scrape_one(args.symbol)
    if args.pretty:
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
