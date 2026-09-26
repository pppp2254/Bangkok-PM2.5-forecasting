import { Elysia, t } from "elysia";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";

const DATA = new URL("../data/", import.meta.url).pathname;
const PREDS = `${DATA}clean/test_predictions.csv`;
// compact copy committed to git (confident detections within 500 km); the raw FIRMS files work too
const FIRES = existsSync(`${DATA}clean/fires_500km.csv`) ? `${DATA}clean/fires_500km.csv` : `${DATA}raw/firms/*.csv`;
const BKK = { lat: 13.7563, lon: 100.5018 };
const UNHEALTHY = 37.5;
const ROOT = new URL("../", import.meta.url).pathname;
const LIVE = `${DATA}live/forecast.json`;
const PYTHON = process.env.PYTHON ?? `${ROOT}.venv/bin/python`;

const db = await (await DuckDBInstance.create(":memory:")).connect();

// CSVs are loaded into memory once; querying them in place re-reads the file on every request (seconds).
// Timestamps are read as text and cut to Bangkok wall-clock time, so no timezone setting is involved.
await db.run(`
  create table preds as
  select * exclude (t, target_time),
         strptime(left(target_time, 19), '%Y-%m-%d %H:%M:%S') as ts
  from read_csv('${PREDS}', header = true, types = {'t': 'VARCHAR', 'target_time': 'VARCHAR'})
`);

await db.run(`
  create table hourly as
  select station, strptime(left(time, 19), '%Y-%m-%d %H:%M:%S') as ts, pm25, pm25_raw, imputed,
         wind_sin, wind_cos, wind_speed_10m, fire_upwind_48h
  from read_csv('${DATA}clean/hourly.csv', header = true, types = {'time': 'VARCHAR'})
`);

// Scanning 175 MB of FIRMS CSVs per request takes seconds, so keep only confident fires within 500 km, once.
const HAS_FIRES = existsSync(`${DATA}clean/fires_500km.csv`) || existsSync(`${DATA}raw/firms`);
if (HAS_FIRES)
  await db.run(`
    create table fires as
    select * from (
      select latitude as lat, longitude as lon, frp, acq_date, acq_time,
             6371 * 2 * asin(sqrt(
               pow(sin(radians(latitude - ${BKK.lat}) / 2), 2) +
               cos(radians(${BKK.lat})) * cos(radians(latitude)) * pow(sin(radians(longitude - ${BKK.lon}) / 2), 2)
             )) as dist_km
      from read_csv('${FIRES}', union_by_name = true, types = {'acq_date': 'VARCHAR', 'acq_time': 'VARCHAR'})
      where confidence in ('n', 'h')
    ) where dist_km <= 500
  `);

const MODELS = (await db.runAndReadAll(`describe preds`))
  .getRowObjectsJson()
  .map((r) => String(r.column_name))
  .filter((c) => c.startsWith("pred_"));
const q = (c: string) => `"${c.replaceAll('"', '""')}"`;
const allPresent = MODELS.map((m) => `${q(m)} is not null`).join(" and ");

// ponytail: one shared connection, queries run one at a time; tables are in memory so each takes milliseconds. Pool connections if it ever serves many viewers.
let queue: Promise<unknown> = Promise.resolve();
const rows = (sql: string, values: (string | number)[] = []) => {
  const run = queue.then(async () => (await db.runAndReadAll(sql, values)).getRowObjectsJson());
  queue = run.catch(() => {});
  return run;
};

const SEASON: Record<string, string> = {
  all: "true",
  burning: "month(ts) <= 4",
  rest: "month(ts) > 4",
};

export const app = new Elysia()
  .get("/", () => Bun.file(new URL("public/index.html", import.meta.url).pathname))

  .get("/api/meta", async () => ({
    models: MODELS,
    stations: (await rows(`select distinct station from preds order by station`)).map((r) => r.station),
    range: (await rows(`select min(ts)::date::varchar as start, max(ts)::date::varchar as end from preds`))[0],
    unhealthy: UNHEALTHY,
    fires: HAS_FIRES,
  }))

  // measured vs every model's 24 h-ahead forecast for one station and date range;
  // every hour is listed so missing hours show as gaps instead of straight lines
  .get(
    "/api/series",
    ({ query }) =>
      rows(
        `with hours as (
           select unnest(generate_series(?::timestamp, ?::timestamp + interval 23 hour, interval 1 hour)) as ts
         )
         select strftime(hours.ts, '%Y-%m-%d %H:%M') as ts, y, ${MODELS.map(q).join(", ")}
         from hours left join (select * from preds where station = ?) p on p.ts = hours.ts
         order by hours.ts`,
        [query.from, query.to, query.station],
      ),
    { query: t.Object({ station: t.String(), from: t.String(), to: t.String() }) },
  )

  // MAE and RMSE per model on rows where every model has a forecast, as in model.ipynb
  .get(
    "/api/metrics",
    async ({ query }) => {
      const where = `${allPresent} and ${SEASON[query.season ?? "all"] ?? "true"}`;
      const parts = MODELS.map(
        (m) => `select '${m}' as model, avg(abs(${q(m)} - y)) as mae,
                sqrt(avg(pow(${q(m)} - y, 2))) as rmse, count(*) as n from preds where ${where}`,
      );
      return rows(`${parts.join(" union all ")} order by mae`);
    },
    { query: t.Object({ season: t.Optional(t.String()) }) },
  )

  // daily means (days with 18+ measured hours) and unhealthy-day precision, recall, F1 per model
  .get(
    "/api/daily",
    async ({ query }) => {
      const days = await rows(
        `select station, ts::date::varchar as date, count(*) as n, avg(y) as y,
                ${MODELS.map((m) => `avg(${q(m)}) as ${q(m)}`).join(", ")}
         from preds where ${allPresent}
         group by all having count(*) >= 18 order by station, date`,
      );
      const scores = MODELS.map((m) => {
        let tp = 0, hit = 0, actual = 0;
        for (const d of days) {
          const a = Number(d.y) > UNHEALTHY, p = Number(d[m]) > UNHEALTHY;
          tp += +(a && p); hit += +p; actual += +a;
        }
        const precision = hit ? tp / hit : 0, recall = actual ? tp / actual : 0;
        return { model: m, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
      });
      return { days: days.filter((d) => !query.station || d.station === query.station), scores };
    },
    { query: t.Object({ station: t.Optional(t.String()) }) },
  )

  // What the app would have shown at one hour of 2024: the reading then, and the next 24 hours as
  // forecast. Each hour's forecast was issued 24 h before it, so all of them were known at "at".
  // The error range is the 10th to 90th percentile of this model's 2024 errors at a similar level.
  .get(
    "/api/now",
    async ({ query }) => {
      const model = MODELS.includes(query.model ?? "") ? query.model! : "pred_lgb + fire";
      const [current] = await rows(
        `select h.pm25_raw, h.pm25, h.imputed, h.fire_upwind_48h,
                (select pm25 from hourly p where p.station = h.station and p.ts = h.ts - interval 3 hour) as pm25_3h_ago
         from hourly h where h.station = ? and h.ts = ?::timestamp`,
        [query.station, query.at],
      );
      const [wind] = await rows(
        `select (degrees(atan2(avg(wind_sin), avg(wind_cos))) + 360) % 360 as from_deg, avg(wind_speed_10m) as speed
         from hourly where station = ? and ts > ?::timestamp and ts <= ?::timestamp + interval 24 hour`,
        [query.station, query.at, query.at],
      );
      const errors = await rows(
        `select least(floor(${q(model)} / 25), 2) as bin,
                quantile_cont(y - ${q(model)}, 0.1) as lo, quantile_cont(y - ${q(model)}, 0.9) as hi
         from preds where ${q(model)} is not null group by bin`,
      );
      const next = await rows(
        `with hours as (
           select unnest(generate_series(?::timestamp + interval 1 hour, ?::timestamp + interval 24 hour, interval 1 hour)) as ts
         )
         select strftime(hours.ts, '%Y-%m-%d %H:%M') as ts, p.${q(model)} as forecast, p.y as actual
         from hours left join (select * from preds where station = ?) p on p.ts = hours.ts
         order by hours.ts`,
        [query.at, query.at, query.station],
      );
      const range = (f: number) => errors.find((e) => Number(e.bin) === Math.min(Math.floor(f / 25), 2));
      return {
        model,
        at: query.at,
        current: current ?? null,
        wind: wind ?? null,
        next: next.map((r) => {
          const e = r.forecast == null ? undefined : range(Number(r.forecast));
          return { ...r, lo: e ? Math.max(0, Number(r.forecast) + Number(e.lo)) : null, hi: e ? Number(r.forecast) + Number(e.hi) : null };
        }),
      };
    },
    { query: t.Object({ station: t.String(), at: t.String(), model: t.Optional(t.String()) }) },
  )

  // live forecast in the same shape as /api/now: the latest one from ../live.py, or, with `at`,
  // a forecast from any past hour (runs `live.py --at`, about 15 s, then cached in data/live/at/)
  .get(
    "/api/live",
    async ({ query, set }) => {
      let live;
      if (query.at) {
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:00$/.test(query.at)) {
          set.status = 400;
          return { error: "at must look like 2025-03-15 07:00" };
        }
        const cached = Bun.file(`${DATA}live/at/${query.at.replace(/\D/g, "")}.json`);
        if (await cached.exists()) live = await cached.json();
        else {
          if (!existsSync(PYTHON) || !existsSync(`${ROOT}.env`)) {
            set.status = 503;
            return { error: "This date has not been computed yet. Pick one from Saved forecasts, or set up .venv and .env (see README) to compute new dates." };
          }
          const proc = Bun.spawn([PYTHON, "live.py", "--at", query.at], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
          const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          if (code !== 0) {
            set.status = 500;
            return { error: err.trim().split("\n").slice(-3).join(" ") };
          }
          live = JSON.parse(out);
          await Bun.write(cached, out);
        }
      } else {
        const file = Bun.file(LIVE);
        if (!(await file.exists())) {
          set.status = 404;
          return { error: "No live forecast yet. Press Refresh." };
        }
        live = await file.json();
      }
      const s = live.stations[query.station];
      const errors = await rows(
        `select least(floor("pred_lgb + fire" / 25), 2) as bin,
                quantile_cont(y - "pred_lgb + fire", 0.1) as lo, quantile_cont(y - "pred_lgb + fire", 0.9) as hi
         from preds where "pred_lgb + fire" is not null group by bin`,
      );
      const range = (f: number) => errors.find((e) => Number(e.bin) === Math.min(Math.floor(f / 25), 2));
      return {
        model: live.model,
        generated_at: live.generated_at,
        notes: live.notes ?? [],
        at: s.at,
        current: s.current,
        wind: s.wind,
        next: s.next.map((r: { ts: string; forecast: number; actual?: number | null }) => {
          const e = range(r.forecast);
          return { ...r, actual: r.actual ?? null, lo: e ? Math.max(0, r.forecast + Number(e.lo)) : null, hi: e ? r.forecast + Number(e.hi) : null };
        }),
      };
    },
    { query: t.Object({ station: t.String(), at: t.Optional(t.String()) }) },
  )

  // forecasts already computed and saved in data/live/at/ (committed, so they work without API keys)
  .get("/api/live/saved", async () => {
    const dir = `${DATA}live/at/`;
    if (!existsSync(dir)) return [];
    const names = [...new Bun.Glob("*.json").scanSync(dir)].sort();
    return names.map((n) => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)} ${n.slice(8, 10)}:${n.slice(10, 12)}`);
  })

  // rerun ../live.py for the latest hour (about 15 s)
  .post("/api/live/refresh", async ({ set }) => {
    if (!existsSync(PYTHON) || !existsSync(`${ROOT}.env`)) {
      set.status = 503;
      return { ok: false, log: "Refreshing needs .venv and .env (see README). Showing the last saved forecast." };
    }
    const proc = Bun.spawn([PYTHON, "live.py"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) set.status = 500;
    return { ok: code === 0, log: (code === 0 ? out : err).trim().split("\n").slice(-5).join("\n") };
  })

  // measured daily means for 2022 to 2024 (days with 18+ measured hours) and the hour-of-day pattern
  .get(
    "/api/history",
    async ({ query }) => ({
      days: await rows(
        `select ts::date::varchar as date, avg(pm25_raw) as mean
         from hourly where station = ? and pm25_raw is not null
         group by all having count(*) >= 18 order by date`,
        [query.station],
      ),
      hours: await rows(
        `select hour(ts) as hour,
                avg(pm25_raw) filter (where month(ts) <= 4) as burning,
                avg(pm25_raw) filter (where month(ts) > 4) as rest
         from hourly where station = ? group by all order by hour`,
        [query.station],
      ),
    }),
    { query: t.Object({ station: t.String() }) },
  )

  // the same rows as /api/series, as a CSV download
  .get(
    "/api/export",
    async ({ query, set }) => {
      const data = await rows(
        `select strftime(ts, '%Y-%m-%d %H:%M') as time, station, y as measured, ${MODELS.map(q).join(", ")}
         from preds where station = ? and ts >= ?::timestamp and ts < ?::timestamp + interval 1 day order by ts`,
        [query.station, query.from, query.to],
      );
      const cols = ["time", "station", "measured", ...MODELS];
      const cell = (v: unknown) => (v == null ? "" : /[",]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
      set.headers["content-type"] = "text/csv; charset=utf-8";
      set.headers["content-disposition"] = `attachment; filename="pm25_${query.station}_${query.from}_${query.to}.csv"`;
      return [cols.map(cell).join(","), ...data.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    },
    { query: t.Object({ station: t.String(), from: t.String(), to: t.String() }) },
  )

  // FIRMS hotspots within 500 km on one UTC date (needs pm25-data-raw.zip unzipped),
  // plus that day's mean forecast wind; wind direction is where the wind blows FROM
  .get(
    "/api/fires",
    async ({ query }) => {
      const [wind] = await rows(
        `select (degrees(atan2(avg(wind_sin), avg(wind_cos))) + 360) % 360 as from_deg, avg(wind_speed_10m) as speed
         from hourly where station = 'stou' and ts::date = ?::date`,
        [query.date],
      );
      const fires = HAS_FIRES
        ? await rows(`select lat, lon, frp, acq_time, dist_km from fires where acq_date = ?`, [query.date])
        : [];
      return { wind, fires };
    },
    { query: t.Object({ date: t.String() }) },
  );

// build-static.ts imports the app to call its routes; only start a server when run directly
if (import.meta.main) app.listen(Number(process.env.PORT ?? 3200), ({ port }) => console.log(`dashboard on http://localhost:${port}`));
