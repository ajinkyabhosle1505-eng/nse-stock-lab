# Funda Desk LaneResults — multi-2026-09-21-p3

Source: screener.in | as_of: 2026-09-21 | tickers: 20

| Ticker | pe_ttm | roe_pct | debt_equity | promoter_pledge_pct | red_flags | unknowns |
|--------|--------|---------|-------------|---------------------|-----------|----------|
| RELIANCE | 22.4 | 8.91 | 0.45 | UNKNOWN | 1 | 2 |
| HDFCBANK | 14.5 | 13.6 | UNKNOWN | UNKNOWN | 3 | 4 |
| SBIN | 11.0 | 15.4 | UNKNOWN | UNKNOWN | 2 | 4 |
| ITC | 17.0 | 29.3 | 0.03 | UNKNOWN | 1 | 2 |
| BANKBARODA | 5.47 | 12.7 | UNKNOWN | UNKNOWN | 2 | 4 |
| PNB | 6.14 | 13.0 | UNKNOWN | UNKNOWN | 4 | 4 |
| CANBK | 5.66 | 16.1 | UNKNOWN | UNKNOWN | 3 | 4 |
| ONGC | 6.79 | 11.6 | 0.47 | UNKNOWN | 1 | 2 |
| NTPC | 11.4 | 15.1 | 1.33 | UNKNOWN | 0 | 2 |
| POWERGRID | 15.6 | 15.3 | 1.47 | UNKNOWN | 0 | 2 |
| COALINDIA | 8.15 | 28.2 | 0.12 | UNKNOWN | 1 | 2 |
| IOC | 5.74 | 20.5 | 0.6 | UNKNOWN | 0 | 2 |
| BPCL | 8.94 | 28.8 | 0.54 | UNKNOWN | 0 | 2 |
| IRFC | 14.6 | 12.8 | 7.69 | UNKNOWN | 3 | 3 |
| RECLTD | 5.1 | 20.1 | 6.1 | UNKNOWN | 1 | 3 |
| PFC | 4.32 | 20.7 | 7.62 | UNKNOWN | 1 | 3 |
| NMDC | 9.34 | 23.4 | 0.19 | UNKNOWN | 2 | 2 |
| VEDL | 9.48 | 38.2 | 0.66 | UNKNOWN | 2 | 2 |
| YESBANK | 18.9 | 7.1 | UNKNOWN | UNKNOWN | 5 | 4 |
| IDEA | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | 4 | 6 |

## Notes
- `promoter_pledge_pct` not shown on Screener shareholding tables for this scrape → UNKNOWN for all 20.
- `eps_growth_yoy_pct` not directly labeled on page → UNKNOWN for all 20.
- Banks / NBFCs: `debt_equity` and/or `interest_coverage` often UNKNOWN (not comparable). Banks: both UNKNOWN. NBFCs (IRFC/RECLTD/PFC): interest_coverage UNKNOWN; debt_equity from Borrowing/Equity.
- IRFC: consolidated URL returned empty financials; used standalone `https://www.screener.in/company/IRFC/`.
- HDFCBANK / ITC / YESBANK: no Promoters row in Screener shareholding → promoter_holding_pct = 0.0.
- IDEA: Stock P/E blank; negative book value → pe_ttm, pb, roe_pct, debt_equity UNKNOWN.
