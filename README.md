# Bangkok PM2.5 forecasting

Forecast hourly PM2.5 in Bangkok 24 hours ahead from air-quality sensors (OpenAQ), archived weather forecasts (Open-Meteo) and satellite fire hotspots (NASA FIRMS). Full plan: `project-plan.pdf`.

## What's in the bundle

| Path | What |
|---|---|
| `fetch.py` | Downloads all raw data into `data/raw/` (needs `.env`) |
| `preprocess.ipynb` | Raw data to `data/clean/hourly.csv`: time alignment, outliers, imputation, fire features |
| `model.ipynb` | Persistence, SARIMA, CAMS, LightGBM with ablation; writes `data/clean/test_predictions.csv` |
| `tft.ipynb` | Temporal Fusion Transformer; adds `pred_tft` to `test_predictions.csv` |
| `data/clean/` | Outputs of the notebooks, ready to use |
| `figures/` | Charts for the slides |
| `dashboard/` | Web dashboard (Bun, Elysia, DuckDB) |
| `project-plan.pdf` | The project plan |

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

## Key rules (so results stay honest)

- At forecast time *t* we predict *t*+24 h; every input must be known at or before *t*.
- Train 2022, validate Jan to Jun 2023, retrain 2022 to 2023, test 2024. Never shuffle.
- Score only on measured PM2.5, never on imputed hours.
- Known gap: OpenAQ has no Bangkok data from 2023-02-02 to 2023-03-19.

## Current results (2024 test, MAE in µg/m³)

| Model | MAE | Burning season | F1 unhealthy day |
|---|---|---|---|
| LightGBM + weather + fire (2 features) | 5.01 | 6.45 | 0.76 |
| LightGBM + weather | 5.22 | 6.75 | 0.72 |
| SARIMA | 5.67 | 7.43 | 0.73 |
| LightGBM, PM2.5 only | 5.67 | 7.72 | 0.65 |
| Persistence | 5.89 | 7.60 | 0.74 |
| CAMS | 12.93 | 14.59 | 0.53 |


Member
1. 6710503780 จักรภัทร ชัยดิลกลาภ
explore.ipynb, report and edit the video
2. 6710504077 ปัญญวัฒน์ เชื้อวัชรินทร์
Bun + Elysia API with DuckDB reading the CSVs directly. Pages: station and date picker, results table, ablation chart, unhealthy-day view, map of fires upwind of Bangkok.
3. 6710504310 รัชพล สนิทวงษ์
tft.ipynb on Colab GPU, download the updated test_predictions.csv and tft_variable_importance.png.write the TFT slides and the Colab demo


