# Bangkok PM2.5 forecasting

Forecast hourly PM2.5 in Bangkok 24 hours ahead from air-quality sensors (OpenAQ), archived weather forecasts (Open-Meteo) and satellite fire hotspots (NASA FIRMS).

## What's in the bundle

| Path | What |
|---|---|
| `fetch.py` | Downloads all raw data into `data/raw/` (needs `.env`) |
| `preprocess.ipynb` | Raw data to `data/clean/hourly.csv`: time alignment, outliers, imputation, fire features |
| `model.ipynb` | Persistence, SARIMA, CAMS, LightGBM with ablation; writes `data/clean/test_predictions.csv` |
| `tft.ipynb` | Temporal Fusion Transformer; adds `pred_tft` to `test_predictions.csv` |
| `live.py` | Live 24-hour forecast from today's data |
| `data/clean/` | Outputs of the notebooks, ready to use |
| `figures/` | Charts for the slides |
| `dashboard/` | Web dashboard (Bun, Elysia, DuckDB) |

Raw data is in a separate zip (`pm25-data-raw.zip`, 41 MB). You only need it to rerun `preprocess.ipynb`.

## Setup

Python 3.12.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

To download the data yourself, get a free OpenAQ key at https://explore.openaq.org/register, then:

```bash
cp .env.example .env   # put your key in it; never commit or share .env
.venv/bin/python fetch.py
```

## Run order

1. `fetch.py` (skip if you unzipped `pm25-data-raw.zip`)
2. `preprocess.ipynb` (about 1 minute)
3. `model.ipynb` (about 10 minutes, mostly SARIMA)
4. `tft.ipynb`

Run notebooks from this folder so the `data/` paths resolve.

## TFT on Colab (recommended)

Training on an old laptop CPU takes hours; on a Colab GPU it takes minutes.

1. Upload `tft.ipynb` to Colab and set Runtime > Change runtime type > GPU.
2. Upload `data/clean/hourly.csv` and `data/clean/test_predictions.csv` into a `data/clean/` folder in the Colab file panel, and create an empty `figures/` folder.
3. In a first cell run `!pip install pytorch-forecasting lightning` (Colab's own torch is fine; the `torch==2.3.1` pin in `requirements-tft.txt` is only for pre-AVX2 CPUs).
4. Run all. Download the updated `data/clean/test_predictions.csv` and `figures/tft_variable_importance.png`.

For a quick check that everything runs, set the environment variable `SMOKE=1` (or change `SMOKE` to `True` in the first code cell).

## Dashboard (Elysia + DuckDB)

Interactive replay of the 2024 test year: current reading with health advice (Thai PCD, US EPA or WHO bands), the next 24 hours, model accuracy, a 2022 to 2024 calendar and a fire map. Light and dark mode.

```bash
cd dashboard
bun install
bun index.ts   # http://localhost:3200
```

Needs `data/clean/` (and `data/raw/firms/` for the fire map). Details in `dashboard/README.md`.

## Live forecast

`live.py` makes a real 24-hour forecast from today's data: the last 8 days of PM2.5 (OpenAQ), the Open-Meteo weather forecast and the last 7 days of FIRMS fire detections, run through the saved LightGBM model (`data/clean/lgb_fire.txt`). It takes about 20 seconds and writes `data/live/forecast.json`.

```bash
.venv/bin/python live.py
```

For any past hour from 2022-01-08 on, pass `--at "2025-03-15 07:00"` (Bangkok time): it rebuilds the forecast from the data available at that hour and includes the measured values afterwards.

Fire data for dates older than 7 days and after 2024 needs a free FIRMS key: get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/ and add `FIRMS_MAP_KEY=...` to `.env`. Without it those dates run with fire inputs set to zero, and the dashboard says so.

The dashboard's Now tab opens in live mode: pick any date and hour, press Latest for the current forecast, or Refresh to fetch new data.

Computed forecasts are saved in `data/live/` and committed, so the dashboard shows them without API keys or Python: the latest forecast, plus 10 showcase dates in the "Saved forecasts" list (burning-season days from 2022 to 2026, including the 2025-01-24 haze). Picking a new date needs `.venv` and `.env`; each new date is saved too. To add more, run `live.py --at "..." > data/live/at/YYYYMMDDHHMM.json`. Needs `.env` with an OpenAQ key and the `.venv` from Setup. Known limit: the model rarely saw values below 6 µg/m³ in training, so on very clean days it reads a few µg/m³ high (forecasts stay around 9); the band and advice are unaffected.

## Key rules (so results stay honest)

- At forecast time *t* we predict *t*+24 h; every input must be known at or before *t*.
- Train 2022, validate Jan to Jun 2023, retrain 2022 to 2023, test 2024. Never shuffle.
- Score only on measured PM2.5, never on imputed hours.
- Known gap: OpenAQ has no Bangkok data from 2023-02-02 to 2023-03-19.

## Current results (2024 test, MAE in µg/m³)

Scored on the 21,010 measured hours every model covers.

| Model | MAE | Burning season (Jan to Apr) | F1 unhealthy day |
|---|---|---|---|
| LightGBM + weather + fire (2 features) | 5.02 | 6.46 | 0.77 |
| LightGBM + weather | 5.21 | 6.76 | 0.73 |
| Temporal Fusion Transformer (median) | 5.29 | 6.80 | 0.68 |
| Temporal Fusion Transformer (90th percentile, as a warning) | | | 0.76 (recall 0.84) |
| LightGBM, all 39 fire features | 5.47 | 7.21 | 0.65 |
| SARIMA | 5.68 | 7.43 | 0.73 |
| LightGBM, PM2.5 only | 5.68 | 7.74 | 0.65 |
| Persistence | 5.92 | 7.62 | 0.75 |
| CAMS | 12.95 | 14.62 | 0.53 |

TFT was trained on Colab; its weights are in `data/clean/tft.pt`. To reproduce its predictions without retraining, run `tft.ipynb` with `TFT_LOAD=1`.


Member
1. 6710503780 จักรภัทร ชัยดิลกลาภ

    explore.ipynb, report and edit the video

2. 6710504077 ปัญญวัฒน์ เชื้อวัชรินทร์

    Bun + Elysia API with DuckDB reading the CSVs directly. Pages: station and date picker, results table, ablation chart, unhealthy-day view, map of fires upwind of Bangkok.

3. 6710504310 รัชพล สนิทวงษ์

    tft.ipynb on Colab GPU, download the updated test_predictions.csv and tft_variable_importance.png.write the TFT slides and the Colab demo


