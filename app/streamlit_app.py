"""Stock Lab Streamlit MVP shell.

Reads the existing Stock Lab JSON/Markdown artifacts without mutating them.
Run from /workspace/stock-lab with: streamlit run app/streamlit_app.py
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import streamlit as st


ROOT = Path("/workspace/stock-lab")
RISK_PATH = ROOT / "risk/verdicts_multi-2026-09-21.json"
TECH_PATH = ROOT / "tech/lane_results_multi-2026-09-21.json"
FUNDA_PATH = ROOT / "funda/lane_results_multi-2026-09-21.json"
NEWS_PATH = ROOT / "news/lane_results_multi-2026-09-21.json"
REPORT_MD_PATH = ROOT / "daily_report/out/multi_2026-09-21_report.md"
REPORT_JSON_PATH = ROOT / "daily_report/out/multi_2026-09-21_report.json"
LEDGER_PATH = ROOT / "paper/ledger_multi-2026-09-21.json"
LEDGER_LATEST_PATH = ROOT / "paper/ledger_latest.json"
DEFAULT_BANNER = (
    "Not SEBI-registered advice. Paper / research only. Past or hypothetical levels "
    "are not a recommendation to buy or sell."
)

st.set_page_config(page_title="Stock Lab", page_icon="📈", layout="wide", initial_sidebar_state="expanded")

st.markdown(
    """
    <style>
    .stApp { background: #f7f9fc; }
    [data-testid="stSidebar"] { background: #101827; }
    [data-testid="stSidebar"] * { color: #e5edf7; }
    .brand { display:flex; align-items:center; gap:.65rem; margin-bottom:.3rem; }
    .brand-mark { background:#29c38a; color:#0b1b2a; border-radius:10px; padding:.35rem .5rem; font-weight:800; }
    .brand-name { font-size:1.35rem; font-weight:800; letter-spacing:-.03em; }
    .eyebrow { text-transform:uppercase; letter-spacing:.12em; color:#6b7b91; font-size:.72rem; font-weight:700; }
    .hero { background:linear-gradient(115deg,#102238,#173c5c); color:white; border-radius:18px; padding:1.15rem 1.35rem; margin-bottom:1rem; }
    .hero h1 { margin:0; font-size:2rem; }
    .hero p { margin:.35rem 0 0; color:#c9d8e9; }
    .metric-card { background:white; border:1px solid #e7edf4; border-radius:14px; padding:1rem; box-shadow:0 3px 12px rgba(25,45,70,.04); }
    .idea-card { background:white; border:1px solid #e7edf4; border-radius:14px; padding:1rem 1.1rem; margin:.55rem 0; }
    .pill { display:inline-block; padding:.2rem .55rem; border-radius:999px; font-size:.75rem; font-weight:800; margin-right:.35rem; }
    .pill-buy { background:#dff7ed; color:#087a50; }
    .pill-hold { background:#fff3d5; color:#926400; }
    .pill-avoid { background:#ffe5e5; color:#ac2b2b; }
    .pill-neutral { background:#e7eef6; color:#49627a; }
    .source { color:#718198; font-size:.77rem; }
    div[data-testid="stMetric"] { background:white; border:1px solid #e7edf4; padding:.8rem; border-radius:12px; }
    </style>
    """,
    unsafe_allow_html=True,
)


def read_json(path: Path) -> tuple[Any | None, str | None]:
    if not path.exists():
        return None, f"Missing file: {path}"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"Could not read {path}: {exc}"


def read_text(path: Path) -> tuple[str | None, str | None]:
    if not path.exists():
        return None, f"Missing file: {path}"
    try:
        return path.read_text(encoding="utf-8"), None
    except OSError as exc:
        return None, f"Could not read {path}: {exc}"


@st.cache_data(show_spinner=False)
def load_json(path_str: str) -> tuple[Any | None, str | None]:
    return read_json(Path(path_str))


@st.cache_data(show_spinner=False)
def load_text(path_str: str) -> tuple[str | None, str | None]:
    return read_text(Path(path_str))


def results_from(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("results"), list):
        return [x for x in payload["results"] if isinstance(x, dict)]
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    return []


def by_ticker(payload: Any) -> dict[str, dict[str, Any]]:
    return {str(row.get("ticker", "")).upper(): row for row in results_from(payload) if row.get("ticker")}


def money(value: Any) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, (float, int)):
        return f"₹{value:,.2f}" if isinstance(value, float) and not value.is_integer() else f"₹{value:,.0f}"
    return str(value)


def val(value: Any) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, list):
        return ", ".join(map(str, value)) if value else "—"
    return str(value)


def action_pill(action: str) -> str:
    action = (action or "unknown").lower()
    klass = {"buy": "pill-buy", "hold": "pill-hold", "avoid": "pill-avoid"}.get(action, "pill-neutral")
    return f'<span class="pill {klass}">{action.upper()}</span>'


def lane_block(title: str, row: dict[str, Any] | None, empty_note: str = "No lane result found.") -> None:
    st.markdown(f"### {title}")
    if not row:
        st.info(empty_note)
        return
    fields = row.get("fields", row)
    if title == "News":
        headline = fields.get("headline")
        if headline:
            st.markdown(f"**{headline}**")
        if fields.get("summary"):
            st.write(fields["summary"])
        cols = st.columns(4)
        for col, (label, key) in zip(cols, [("Sentiment", "sentiment"), ("Status", "confirmation_status"), ("Confidence", "confidence_news"), ("Horizon", "impact_horizon")]):
            col.metric(label, val(fields.get(key)))
        if fields.get("why_for_verdict"):
            st.caption(f"Why it matters: {fields['why_for_verdict']}")
    elif title == "Technical":
        cols = st.columns(4)
        metrics = [("CMP", money(fields.get("cmp"))), ("RSI (14)", val(fields.get("rsi_14"))), ("Structure", val(fields.get("structure"))), ("vs DMA", val(fields.get("price_vs_dma")))]
        for col, (label, value) in zip(cols, metrics):
            col.metric(label, value)
        st.write({k.replace("_", " ").title(): v for k, v in fields.items() if k not in {"cmp", "rsi_14", "structure", "price_vs_dma"}})
    else:
        cols = st.columns(4)
        metrics = [("P/E", val(fields.get("pe_ttm"))), ("ROE", val(fields.get("roe_pct"))), ("D/E", val(fields.get("debt_equity"))), ("Sector", val(fields.get("sector")))]
        for col, (label, value) in zip(cols, metrics):
            col.metric(label, value)
        if fields.get("red_flags"):
            st.warning("Red flags: " + val(fields["red_flags"]))
        st.write({k.replace("_", " ").title(): v for k, v in fields.items() if k not in {"pe_ttm", "roe_pct", "debt_equity", "sector", "red_flags"}})
    if row.get("unknowns"):
        st.caption("Unknowns: " + val(row["unknowns"]))
    if row.get("sources"):
        st.caption("Sources: " + val(row["sources"]))


def load_core() -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    risk, error = load_json(str(RISK_PATH))
    if error:
        errors.append(error)
    risk = risk if isinstance(risk, dict) else {}
    banner = risk.get("sebi_banner", DEFAULT_BANNER)
    return {"risk": risk, "banner": banner}, errors


def page_budget(risk: dict[str, Any]) -> None:
    st.markdown('<div class="eyebrow">Portfolio setup</div><h2>Budget</h2>', unsafe_allow_html=True)
    st.write("Set a paper-trading budget for this session. Existing research artifacts remain read-only.")
    if "budget_input" not in st.session_state:
        st.session_state["budget_input"] = int(risk.get("budget_inr", 10000) or 10000)
    st.markdown("**Quick amounts**")
    cols = st.columns(4)
    for col, amount in zip(cols, [5000, 10000, 25000, 50000]):
        if col.button(f"₹{amount:,}", key=f"budget_chip_{amount}", width="stretch"):
            st.session_state["budget_input"] = amount
            st.rerun()
    budget = st.number_input("Paper budget (INR)", min_value=0, step=500, key="budget_input", help="Used for sizing context only; it does not rewrite the source files.")
    st.divider()
    risk_pct = float(risk.get("risk_pct", 0.01) or 0.01)
    c1, c2, c3 = st.columns(3)
    c1.metric("Budget", money(budget))
    c2.metric("Risk / idea", money(budget * risk_pct))
    c3.metric("Source budget", money(risk.get("budget_inr")))
    st.info("This MVP keeps budget controls local to the current session. It does not place orders or edit ledger files.")


def page_ideas(risk: dict[str, Any]) -> None:
    st.markdown('<div class="eyebrow">Research queue</div><h2>Ideas</h2>', unsafe_allow_html=True)
    verdicts = risk.get("verdicts", []) if isinstance(risk.get("verdicts"), list) else []
    counts = risk.get("counts", {}) if isinstance(risk.get("counts"), dict) else {}
    cols = st.columns(4)
    for col, label, key in zip(cols, ["Buy", "Hold", "Avoid", "Total"], ["buy", "hold", "avoid", None]):
        col.metric(label, len(verdicts) if key is None else counts.get(key, sum(1 for x in verdicts if x.get("action") == key)))
    selected = st.selectbox("Filter action", ["All", "buy", "hold", "avoid"], index=0)
    shown = [x for x in verdicts if selected == "All" or x.get("action") == selected]
    st.caption(f"Showing {len(shown)} of {len(verdicts)} verdicts · as of {risk.get('as_of', '—')}")
    if not shown:
        st.info("No verdicts match this filter.")
    for idea in shown:
        ticker = idea.get("ticker", "Unknown")
        action = idea.get("action", "unknown")
        with st.container():
            st.markdown(
                f'<div class="idea-card"><div><strong style="font-size:1.1rem">{ticker}</strong> &nbsp; {action_pill(action)} '
                f'<span class="pill pill-neutral">Confidence {val(idea.get("confidence_1_10"))}/10</span></div>'
                f'<div style="margin-top:.65rem;color:#43556b">Entry <b>{money(idea.get("entry"))}</b> &nbsp; · &nbsp; Stop loss <b>{money(idea.get("sl"))}</b> &nbsp; · &nbsp; '
                f'Targets <b>{val(idea.get("targets"))}</b></div></div>',
                unsafe_allow_html=True,
            )


def page_detail(risk: dict[str, Any]) -> None:
    st.markdown('<div class="eyebrow">Cross-lane view</div><h2>Detail</h2>', unsafe_allow_html=True)
    tech, tech_error = load_json(str(TECH_PATH))
    funda, funda_error = load_json(str(FUNDA_PATH))
    news, news_error = load_json(str(NEWS_PATH))
    lane_maps = {"tech": by_ticker(tech), "funda": by_ticker(funda), "news": by_ticker(news)}
    verdict_map = {str(x.get("ticker", "")).upper(): x for x in risk.get("verdicts", []) if isinstance(x, dict)}
    tickers = sorted(set(verdict_map) | set().union(*(set(m) for m in lane_maps.values())))
    if not tickers:
        st.warning("No ticker data found in the configured lane files.")
        return
    selected = st.selectbox("Pick ticker", tickers, index=tickers.index("PNB") if "PNB" in tickers else 0)
    verdict = verdict_map.get(selected)
    if verdict:
        st.markdown(f"## {selected} {action_pill(verdict.get('action', 'unknown'))}", unsafe_allow_html=True)
        cols = st.columns(5)
        for col, label, value in zip(cols, ["Confidence", "CMP", "Entry", "Stop loss", "R:R"], [f"{val(verdict.get('confidence_1_10'))}/10", money(verdict.get("cmp")), money(verdict.get("entry")), money(verdict.get("sl")), val(verdict.get("r_r"))]):
            col.metric(label, value)
        if verdict.get("reasons"):
            st.caption(" · ".join(map(str, verdict["reasons"])))
        if verdict.get("risk_flags"):
            st.warning("Risk flags: " + val(verdict["risk_flags"]))
    else:
        st.info("No risk verdict is available for this ticker.")
    st.divider()
    lane_block("Technical", lane_maps["tech"].get(selected))
    lane_block("Fundamental", lane_maps["funda"].get(selected))
    lane_block("News", lane_maps["news"].get(selected))
    for error in [tech_error, funda_error, news_error]:
        if error:
            st.error(error)


def page_report() -> None:
    st.markdown('<div class="eyebrow">Desk output</div><h2>Daily report</h2>', unsafe_allow_html=True)
    report, error = load_text(str(REPORT_MD_PATH))
    source = REPORT_MD_PATH
    if report is None:
        payload, json_error = load_json(str(REPORT_JSON_PATH))
        if payload is not None:
            report = json.dumps(payload, indent=2, ensure_ascii=False)
            source = REPORT_JSON_PATH
            error = None
        else:
            error = json_error or error
    if error:
        st.error(error)
        return
    st.caption(f"Source: {source}")
    if source.suffix == ".md":
        st.markdown(report)
    else:
        st.json(json.loads(report))


def page_ledger() -> None:
    st.markdown('<div class="eyebrow">Paper execution</div><h2>Paper ledger</h2>', unsafe_allow_html=True)
    payload, error = load_json(str(LEDGER_PATH))
    source = LEDGER_PATH
    if payload is None:
        payload, error = load_json(str(LEDGER_LATEST_PATH))
        source = LEDGER_LATEST_PATH
    if error or not isinstance(payload, dict):
        st.error(error or "Ledger JSON is not an object.")
        return
    st.caption(f"Source: {source} · {payload.get('written_at', 'timestamp unavailable')}")
    summary = payload.get("summary", {}) if isinstance(payload.get("summary"), dict) else {}
    cols = st.columns(4)
    for col, label, key in zip(cols, ["Open positions", "Notional", "Allocated", "Paper"], ["open_positions", "notional_inr", "allocated_size_inr", None]):
        col.metric(label, "Yes" if key is None and payload.get("paper") else (money(summary.get(key)) if key else "No"))
    fills = payload.get("fills", [])
    if fills:
        st.subheader("Fills")
        rows = [{"Ticker": x.get("ticker", x.get("symbol")), "Side": x.get("side"), "Qty": x.get("qty", x.get("shares")), "Entry": x.get("entry"), "Stop loss": x.get("sl"), "Status": x.get("status"), "Size": x.get("size_inr")} for x in fills]
        st.dataframe(rows, width="stretch", hide_index=True, column_config={"Entry": st.column_config.NumberColumn(format="₹%.2f"), "Stop loss": st.column_config.NumberColumn(format="₹%.2f"), "Size": st.column_config.NumberColumn(format="₹%.2f")})
    positions = payload.get("positions", [])
    if positions:
        st.subheader("Positions")
        st.dataframe(positions, width="stretch", hide_index=True)
    with st.expander("Raw ledger JSON"):
        st.json(payload)


def main() -> None:
    core, errors = load_core()
    risk = core["risk"]
    banner = core["banner"]
    st.sidebar.markdown('<div class="brand"><span class="brand-mark">↗</span><span class="brand-name">Stock Lab</span></div>', unsafe_allow_html=True)
    st.sidebar.caption("Research cockpit · paper only")
    screen = st.sidebar.radio("Workspace", ["Budget", "Ideas", "Detail", "Daily report", "Paper ledger"], label_visibility="collapsed")
    st.sidebar.divider()
    st.sidebar.caption(f"As of {risk.get('as_of', '—')}")
    st.sidebar.caption("Data source: /workspace/stock-lab")
    st.markdown('<div class="hero"><h1>Stock Lab</h1><p>Multi-lane research, risk verdicts and paper execution in one view.</p></div>', unsafe_allow_html=True)
    st.warning(f"⚠️ {banner}")
    for error in errors:
        st.error(error)
    if screen == "Budget":
        page_budget(risk)
    elif screen == "Ideas":
        page_ideas(risk)
    elif screen == "Detail":
        page_detail(risk)
    elif screen == "Daily report":
        page_report()
    else:
        page_ledger()
    st.caption("MVP shell · local artifacts only · no brokerage connectivity")


if __name__ == "__main__":
    main()
