"""Download raw data for the Bangkok PM2.5 project into data/raw/.

Sources: OpenAQ (PM2.5), Open-Meteo (archived weather forecasts and CAMS
modelled PM2.5), NASA FIRMS (fire hotspots).
Weather comes from archived forecasts, not observations, so the model only
sees weather it could have known at forecast time. Boundary layer height is
left out: the forecast archive has none and the observed archive is missing
Jan to Jun 2024.
Everything is saved in UTC and unmodified; cleaning happens in preprocessing.
Re-running skips files that already exist, so an interrupted run can resume.

Usage: python3 fetch.py
"""
import csv
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

YEARS = [2022, 2023, 2024]
# OpenAQ location id -> (short name, PM2.5 sensor id)
STATIONS = {
    701: ("stou", 1304255),
    906: ("mineral", 1304207),
    2167: ("highway", 1304205),
}
FIRMS_COUNTRIES = ["Thailand", "Myanmar", "Cambodia", "Lao_PDR"]
WEATHER_VARS = [
    "temperature_2m", "relative_humidity_2m", "wind_speed_10m",
    "wind_direction_10m", "precipitation",
]

RAW = Path(__file__).parent / "data" / "raw"


def load_key():
    for line in (Path(__file__).parent / ".env").read_text().splitlines():
        if line.startswith("OPENAQ_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("OPENAQ_API_KEY missing from .env")


def get(url, headers=None, retries=5):
    req = urllib.request.Request(url, headers=headers or {})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            # 429 = OpenAQ rate limit (60/min); 5xx = transient
            if e.code != 429 and e.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(2 ** attempt * 5)
    raise RuntimeError(f"gave up on {url}")


def fetch_openaq(key):
    headers = {"X-API-Key": key}
    coords = {}
    for loc, (name, sensor) in STATIONS.items():
        loc_info = json.loads(get(f"https://api.openaq.org/v3/locations/{loc}", headers))
        coords[name] = loc_info["results"][0]["coordinates"]
        out = RAW / "pm25" / f"{name}.csv"
        if out.exists():
            print(f"skip {out.name}")
            continue
        rows = []
        for year in YEARS:
            page = 1
            while True:
                q = urllib.parse.urlencode({
                    "datetime_from": f"{year}-01-01T00:00:00Z",
                    "datetime_to": f"{year + 1}-01-01T00:00:00Z",
                    "limit": 1000, "page": page,
                })
                data = json.loads(get(f"https://api.openaq.org/v3/sensors/{sensor}/hours?{q}", headers))
                results = data["results"]
                rows += [(r["period"]["datetimeFrom"]["utc"], r["value"]) for r in results]
                print(f"  {name} {year} page {page}: {len(results)} rows")
                if len(results) < 1000:
                    break
                page += 1
                time.sleep(1.1)  # stay under 60 requests/min
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["datetime_utc", "pm25"])
            w.writerows(sorted(set(rows)))
        print(f"wrote {out} ({len(rows)} rows)")
    return coords


def fetch_open_meteo(coords, folder, url, variables):
    for name, c in coords.items():
        out = RAW / folder / f"{name}.csv"
        if out.exists():
            print(f"skip {folder}/{out.name}")
            continue
        q = urllib.parse.urlencode({
            "latitude": c["latitude"], "longitude": c["longitude"],
            "start_date": f"{YEARS[0]}-01-01", "end_date": f"{YEARS[-1]}-12-31",
            "hourly": ",".join(variables), "timezone": "GMT",
        })
        h = json.loads(get(f"{url}?{q}"))["hourly"]
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["datetime_utc"] + variables)
            w.writerows(zip(h["time"], *(h[v] for v in variables)))
        print(f"wrote {out} ({len(h['time'])} rows)")


def fetch_firms():
    for year in YEARS:
        for country in FIRMS_COUNTRIES:
            out = RAW / "firms" / f"{year}_{country}.csv"
            if out.exists():
                print(f"skip {out.name}")
                continue
            url = f"https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/{year}/viirs-snpp_{year}_{country}.csv"
            body = get(url)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(body)
            print(f"wrote {out} ({len(body) // 1_000_000} MB)")


if __name__ == "__main__":
    coords = fetch_openaq(load_key())
    (RAW / "stations.json").write_text(json.dumps(coords, indent=2))
    fetch_open_meteo(coords, "weather", "https://historical-forecast-api.open-meteo.com/v1/forecast", WEATHER_VARS)
    # CAMS starts 2022-08-04; only the 2024 test year is needed as a baseline
    fetch_open_meteo(coords, "cams", "https://air-quality-api.open-meteo.com/v1/air-quality", ["pm2_5"])
    fetch_firms()
    print("done")
