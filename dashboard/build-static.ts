// Builds a static copy of the dashboard for GitHub Pages in dist/.
// Every API answer the page needs is fetched from the real app (no server started) and saved as JSON,
// so the static site shows exactly what the local server shows. Picking new live dates needs Python,
// so the static site offers the latest forecast and the saved dates only.
import { app } from "./index.ts";
import { mkdirSync, rmSync } from "node:fs";

const OUT = new URL("dist/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });

const call = async (path: string) => {
  const r = await app.handle(new Request(`http://local${path}`));
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};
const save = async (file: string, data: unknown) => {
  mkdirSync(`${OUT}api/${file.split("/").slice(0, -1).join("/")}`, { recursive: true });
  await Bun.write(`${OUT}api/${file}.json`, JSON.stringify(data));
};
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1))
    out.push(d.toISOString().slice(0, 10));
  return out;
};

const meta = await call("/api/meta");
await save("meta", meta);
const stations: string[] = meta.stations;
const saved: string[] = await call("/api/live/saved");
await save("saved", saved);

for (const season of ["all", "burning", "rest"]) await save(`metrics/${season}`, await call(`/api/metrics?season=${season}`));
await save("daily/all", await call("/api/daily"));

for (const s of stations) {
  await save(`daily/${s}`, await call(`/api/daily?station=${s}`));
  await save(`history/${s}`, await call(`/api/history?station=${s}`));
  await save(`series/${s}`, await call(`/api/series?station=${s}&from=2024-01-01&to=2024-12-31`));
  await save(`live/${s}`, await call(`/api/live?station=${s}`));
  for (const at of saved) await save(`live/${s}-${at.replace(/\D/g, "")}`, await call(`/api/live?station=${s}&at=${encodeURIComponent(at)}`));
  // backtest replay: one file per station and day, holding the 24 hourly answers
  for (const day of days("2024-01-01", "2024-12-30")) {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(await call(`/api/now?station=${s}&at=${encodeURIComponent(`${day} ${String(h).padStart(2, "0")}:00`)}`));
    await save(`now/${s}/${day}`, hours);
  }
  console.log(`${s} done`);
}

if (meta.fires) for (const day of days("2022-01-01", "2024-12-31")) await save(`fires/${day}`, await call(`/api/fires?date=${day}`));

const html = (await Bun.file(new URL("public/index.html", import.meta.url)).text()).replace('<html lang="en">', '<html lang="en" data-static="1">');
await Bun.write(`${OUT}index.html`, html);
await Bun.write(`${OUT}.nojekyll`, ""); // serve files as they are, no Jekyll processing
console.log(`static site written to ${OUT}`);
process.exit(0);
