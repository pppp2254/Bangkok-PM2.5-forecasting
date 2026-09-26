# PM2.5 dashboard (Elysia + DuckDB)

Interactive view of the 2024 test results. DuckDB loads the CSVs from `../data/` into memory at startup; nothing is imported by hand.

```bash
bun install
bun index.ts          # http://localhost:3200 (PORT=xxxx to change)
```

Needs `../data/clean/test_predictions.csv` and `hourly.csv` (from `pm25-project.zip`). The fire map also needs `../data/raw/firms/` (from `pm25-data-raw.zip`); without it the map shows no fires.

New model columns in `test_predictions.csv` (any `pred_*`, such as `pred_tft`) appear automatically after a restart.

| Endpoint | Returns |
|---|---|
| `/api/meta` | models, stations, date range |
| `/api/series?station=&from=&to=` | hourly measured vs each model's 24 h-ahead forecast |
| `/api/metrics?season=all\|burning\|rest` | MAE and RMSE per model on rows every model covers |
| `/api/daily?station=` | daily means and unhealthy-day precision, recall, F1 |
| `/api/fires?date=` | FIRMS hotspots within 500 km on that UTC date, plus the day's wind |
