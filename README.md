# Stock Lab Streamlit MVP

A read-only Streamlit shell for the local Stock Lab research artifacts. It includes Budget, Ideas, Detail, Daily report, and Paper ledger screens, and shows the SEBI paper/research disclaimer on every screen.

## Open locally

```bash
cd /workspace/stock-lab
.venv/bin/streamlit run app/streamlit_app.py --server.address 0.0.0.0 --server.port 8501 --browser.gatherUsageStats false
```

Then open **http://localhost:8501** (or the host's port 8501) in a browser.

## Data paths

- Verdicts: `risk/verdicts_multi-2026-09-21.json`
- Technical lane: `tech/lane_results_multi-2026-09-21.json`
- Fundamental lane: `funda/lane_results_multi-2026-09-21.json`
- News lane: `news/lane_results_multi-2026-09-21.json`
- Daily report: `daily_report/out/multi_2026-09-21_report.md` (falls back to `.json`)
- Paper ledger: `paper/ledger_multi-2026-09-21.json` (falls back to `ledger_latest.json`)

The UI reads these artifacts dynamically and does not edit them. The Budget chips are session-only sizing context.
