"""24-hour PM2.5 forecast for the 3 Bangkok stations, for now or any past hour.

Builds the same features as model.ipynb from real data and runs the saved LightGBM model
(data/clean/lgb_fire.txt):
- PM2.5: OpenAQ, the 8 days before the forecast time (and the 24 h after it, when known, for comparison)
- weather: Open-Meteo archived forecasts, the source the model was trained on (covers 2022 to tomorrow)
- fires: NASA FIRMS. Last 7 days: public near-real-time feed. 2022 to 2024: data/raw/firms.
  Other dates need FIRMS_MAP_KEY in .env (free, https://firms.modaps.eosdis.nasa.gov/api/map_key/);
  without it the fire inputs are set to zero and the output says so.

The forecast for each of the next 24 hours comes from the forecast time 24 hours before it,
exactly as in the backtest, so every input was known when the forecast was made.

Usage:
  python3 live.py                          # now; writes data/live/forecast.json
  python3 live.py --at "2025-03-15 07:00"  # any past hour (Bangkok time); prints JSON
"""
import argparse
import io
import json
import urllib.error
import urllib.parse
from datetime import timedelta
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from fetch import get, load_key

ROOT = Path(__file__).parent
TZ = "Asia/Bangkok"
H = 24
BKK_LAT, BKK_LON = 13.7563, 100.5018
# station -> (OpenAQ PM2.5 sensor, latitude, longitude)
STATIONS = {
    "stou": (1304255, 13.907861, 100.535641),
    "mineral": (1304207, 13.652141, 100.531805),
    "highway": (1304205, 13.7054879, 100.315622),
}
WEATHER = ["temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m", "precipitation"]
FIRMS_7D = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_7d.csv"
BBOX_500KM = "95.8,9.2,105.2,18.3"  # west,south,east,north around Bangkok


def env(name):
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    return None


def fetch_pm25(sensor, key, start, end):
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    q = urllib.parse.urlencode({"datetime_from": start.tz_convert("UTC").strftime(fmt),
                                "datetime_to": end.tz_convert("UTC").strftime(fmt), "limit": 1000})
    rows = json.loads(get(f"https://api.openaq.org/v3/sensors/{sensor}/hours?{q}", {"X-API-Key": key}))["results"]
    s = pd.Series({pd.Timestamp(r["period"]["datetimeFrom"]["utc"]): r["value"] for r in rows}, dtype=float)
    if s.empty:
        return s
    s.index = s.index.tz_convert(TZ)
    return s.where(s > 0)  # zero or negative readings are sensor faults, as in preprocessing


def fetch_weather(lat, lon, start, end):
    q = urllib.parse.urlencode({"latitude": lat, "longitude": lon, "hourly": ",".join(WEATHER), "timezone": "GMT",
                                "start_date": start.tz_convert("UTC").strftime("%Y-%m-%d"),
                                "end_date": end.tz_convert("UTC").strftime("%Y-%m-%d")})
    h = json.loads(get(f"https://historical-forecast-api.open-meteo.com/v1/forecast?{q}"))["hourly"]
    w = pd.DataFrame(h).set_index("time")
    w.index = pd.to_datetime(w.index, utc=True).tz_convert(TZ)
    rad = np.radians(w.pop("wind_direction_10m"))
    w["wind_dir_rad"], w["wind_sin"], w["wind_cos"] = rad, np.sin(rad), np.cos(rad)
    return w


def fetch_fires(at):
    """Detections within 500 km available up to `at`, and a note if none could be fetched."""
    start = at - timedelta(hours=73)
    now = pd.Timestamp.now(tz=TZ)
    frames, note = [], None
    if at >= now - timedelta(days=6):
        frames.append(pd.read_csv(io.BytesIO(get(FIRMS_7D))))
    elif at.year <= 2024 and (ROOT / "data/raw/firms").exists():
        for year in sorted({start.year, at.year}):
            frames += [pd.read_csv(p) for p in (ROOT / "data/raw/firms").glob(f"{year}_*.csv")]
    elif env("FIRMS_MAP_KEY"):
        day = (start - timedelta(days=1)).strftime("%Y-%m-%d")
        for source in ["VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"]:
            try:
                f = pd.read_csv(io.BytesIO(get(f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{env('FIRMS_MAP_KEY')}/{source}/{BBOX_500KM}/5/{day}")))
                if len(f):
                    frames.append(f)
                    break
            except (urllib.error.HTTPError, pd.errors.EmptyDataError):
                continue
    if not frames:
        return pd.DataFrame(columns=["available", "dist_km", "bearing"]), \
            "Fire data is not available for this date without a free FIRMS key, so fire inputs are set to zero."
    f = pd.concat(frames, ignore_index=True)
    f["confidence"] = f["confidence"].astype(str).str[0].str.lower()  # archive uses n/h/l, live feed nominal/high/low
    f = f[f.confidence.isin(["n", "h"])].copy()
    lat1, lon1, lat2, lon2 = np.radians(BKK_LAT), np.radians(BKK_LON), np.radians(f.latitude), np.radians(f.longitude)
    f["dist_km"] = 6371 * 2 * np.arcsin(np.sqrt(
        np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2))
    f["bearing"] = np.arctan2(np.sin(lon2 - lon1) * np.cos(lat2),
                              np.cos(lat1) * np.sin(lat2) - np.sin(lat1) * np.cos(lat2) * np.cos(lon2 - lon1)) % (2 * np.pi)
    f = f[f.dist_km <= 500]
    utc = pd.to_datetime(f.acq_date.astype(str) + f.acq_time.astype(str).str.zfill(4), format="%Y-%m-%d%H%M", utc=True)
    f["available"] = utc.dt.ceil("h").dt.tz_convert(TZ)  # usable from the next full hour, as in preprocessing
    return f[f.available <= at], note


def fire_features(fires, index, wind_dir_rad):
    """fire_n_r100_300_72h and fire_upwind_48h, computed as in preprocess.ipynb."""
    ring = fires[(fires.dist_km > 100) & (fires.dist_km <= 300)]
    n_ring = ring.groupby("available").size().reindex(index, fill_value=0).rolling(72, min_periods=1).sum()
    sector = (fires.bearing // (2 * np.pi / 16)).astype(int)
    counts = (fires.assign(sector=sector).groupby(["available", "sector"]).size().unstack(fill_value=0)
              .reindex(index=index, columns=range(16), fill_value=0).rolling(48, min_periods=1).sum())
    centres = (np.arange(16) + 0.5) * 2 * np.pi / 16
    weight = np.clip(np.cos(centres[None, :] - wind_dir_rad.to_numpy()[:, None]), 0, None)
    upwind = pd.Series((counts.to_numpy() * weight).sum(axis=1), index=index)
    return n_ring, upwind


def num(x):
    return None if x is None or pd.isna(x) else float(x)


def forecast(at=None):
    """Forecast from `at` (Bangkok time, None = the latest measured hour) for every station."""
    key = load_key()
    model = lgb.Booster(model_file=str(ROOT / "data/clean/lgb_fire.txt"))
    cols = json.loads((ROOT / "data/clean/lgb_fire_features.json").read_text())
    now = pd.Timestamp.now(tz=TZ).floor("h")
    if at is None:
        pm_now = fetch_pm25(STATIONS["stou"][0], key, now - timedelta(days=2), now)
        at = pm_now.dropna().index.max() if len(pm_now.dropna()) else now - timedelta(hours=1)
    at = min(at, now)
    fires, fire_note = fetch_fires(at)
    out = {"generated_at": pd.Timestamp.now(tz=TZ).isoformat(timespec="seconds"), "at": at.strftime("%Y-%m-%d %H:%M"),
           "model": "pred_lgb + fire", "notes": [n for n in [fire_note] if n], "stations": {}}
    index = pd.date_range(at - timedelta(days=8), at + timedelta(hours=H), freq="h", tz=TZ)

    for name, (sensor, lat, lon) in STATIONS.items():
        pm = fetch_pm25(sensor, key, index[0], min(index[-1], now)).reindex(index)
        w = fetch_weather(lat, lon, index[0], index[-1]).reindex(index)
        # ponytail: fills only gaps up to 6 h by straight line; the backtest also used neighbour-adjusted fills up to 72 h
        series = pm.where(pm.index <= at).interpolate(limit=6, limit_area="inside")
        n_ring, upwind = fire_features(fires, index, w["wind_dir_rad"].ffill())

        f = pd.DataFrame(index=index)
        f["pm_t"] = series
        for k in [1, 2, 3, 6, 12, 24, 168]:
            f[f"pm_lag{k}"] = series.shift(k)
        f["pm_mean6"] = series.rolling(6, min_periods=3).mean()
        f["pm_mean24"] = series.rolling(24, min_periods=12).mean()
        for c in ["temperature_2m", "relative_humidity_2m", "wind_speed_10m", "precipitation", "wind_sin", "wind_cos"]:
            f[f"wx_{c}_t24"] = w[c].shift(-H)
        f["wx_wind_mean_next24"] = w["wind_speed_10m"].rolling(H).mean().shift(-H)
        f["wx_rain_sum_next24"] = w["precipitation"].rolling(H).sum().shift(-H)
        target = index + pd.Timedelta(hours=H)
        f["cal_hour_sin"] = np.sin(2 * np.pi * target.hour / 24)
        f["cal_hour_cos"] = np.cos(2 * np.pi * target.hour / 24)
        f["cal_dow"] = target.dayofweek
        f["cal_month_sin"] = np.sin(2 * np.pi * target.month / 12)
        f["cal_month_cos"] = np.cos(2 * np.pi * target.month / 12)
        f["cal_burning"] = target.month.isin([1, 2, 3, 4]).astype(int)
        f["station"] = pd.Categorical([name] * len(f), categories=sorted(STATIONS))
        f["fire_upwind_48h"] = upwind
        f["fire_n_r100_300_72h"] = n_ring

        # the forecast for at+1 .. at+24 comes from forecast times at-23 .. at
        origins = f.loc[at - timedelta(hours=H - 1): at, cols]
        preds = model.predict(origins)
        nxt = w.loc[at + timedelta(hours=1): at + timedelta(hours=H)]
        out["stations"][name] = {
            "at": out["at"],
            "current": {
                "pm25_raw": num(pm.get(at)),
                "pm25": num(series.get(at)),
                "imputed": bool(pd.isna(pm.get(at)) and not pd.isna(series.get(at))),
                "fire_upwind_48h": num(upwind.get(at)),
                "pm25_3h_ago": num(series.get(at - timedelta(hours=3))),
            },
            "wind": {"from_deg": num((np.degrees(np.arctan2(nxt.wind_sin.mean(), nxt.wind_cos.mean())) + 360) % 360),
                     "speed": num(nxt.wind_speed_10m.mean())},
            "next": [{"ts": (o + timedelta(hours=H)).strftime("%Y-%m-%d %H:%M"), "forecast": float(p),
                      "actual": num(pm.get(o + timedelta(hours=H)))} for o, p in zip(origins.index, preds)],
        }
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--at", help='forecast time in Bangkok time, e.g. "2025-03-15 07:00" (default: latest reading)')
    args = parser.parse_args()
    if args.at:
        print(json.dumps(forecast(pd.Timestamp(args.at, tz=TZ).floor("h"))))
        return
    out = forecast()
    path = ROOT / "data/live/forecast.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1))
    for name, s in out["stations"].items():
        f = [r["forecast"] for r in s["next"]]
        print(f"{name}: at {s['at']}, now {s['current']['pm25']}, next 24 h {min(f):.0f} to {max(f):.0f} µg/m³")
    print("wrote", path)


if __name__ == "__main__":
    main()
