#!/usr/bin/env node
// test/gtfs-browser-smoke.mjs
//
// Browser smoke test for Phase 1 of docs/gtfs-route-browser-plan.md (GTFS route
// browser engine in js/projects/gtfs.js): route index, hide/show filters, the
// highlight layers, zoom, and copy-as-line. A small synthetic feed is zipped
// in-page with the vendored JSZip and loaded through App.loadGTFSFile.
//
// USAGE (see test/ui-screens/capture.mjs for the one-time Playwright install):
//   NODE_PATH=/path/to/playwright/node_modules node test/gtfs-browser-smoke.mjs
// CDN libraries are served from test/ui-screens/vendor/; other remote requests
// are aborted. Prints PASS/FAIL per assertion; exits non-zero on any failure.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const VENDOR_DIR = join(HERE, "ui-screens", "vendor");

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch (e) {
  console.error("Could not load 'playwright' (" + e.message + "). Set NODE_PATH to a playwright install.");
  process.exit(1);
}

const VENDOR_MAP = new Map([
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js", { file: "maplibre-gl.js", type: "application/javascript" }],
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css", { file: "maplibre-gl.css", type: "text/css" }],
  ["https://unpkg.com/@turf/turf@6.5.0/turf.min.js", { file: "turf.min.js", type: "application/javascript" }],
  ["https://unpkg.com/pako@2.1.0/dist/pako.min.js", { file: "pako.min.js", type: "application/javascript" }],
  ["https://unpkg.com/papaparse@5.4.1/papaparse.min.js", { file: "papaparse.min.js", type: "application/javascript" }],
  ["https://unpkg.com/jszip@3.10.1/dist/jszip.min.js", { file: "jszip.min.js", type: "application/javascript" }],
  ["https://unpkg.com/shapefile@0.6.6/dist/shapefile.js", { file: "shapefile.js", type: "application/javascript" }]
]);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function waitForHttpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const req = http.get({ host: "127.0.0.1", port, path: "/index.html", timeout: 1000 }, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("static server never became ready"));
        setTimeout(attempt, 100);
      });
      req.on("timeout", () => req.destroy());
    })();
  });
}

// ---- Assertion helpers ----
let failures = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (!ok && detail !== undefined ? "  -> " + JSON.stringify(detail) : ""));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Synthetic feed. Red: 3 shapes (trips 3 / 1 / 4 -> 177202 is representative);
// Blue: 1 shape; Ten: sorts after Red/Blue naturally ("2" < "10"); plus one
// shape with no trips ("lonely" -> Unassigned shapes).
function feedFiles() {
  const pts = (id, x0, n) => Array.from({ length: n }, (_, i) => id + "," + (38.8 + i * 0.001) + "," + (-104.8 + x0 + i * 0.01) + "," + (i + 1)).join("\n");
  const shapes = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
    [pts("177198", 0, 6), pts("177198_A", 0, 4), pts("177202", 0.001, 5), pts("B1", 0.05, 4), pts("T10", 0.1, 3), pts("lonely", 0.2, 3)].join("\n") + "\n";
  const t = (r, s, h, n) => Array.from({ length: n }, (_, i) => [r, "svc", r + "_" + s + "_" + i, h, s].join(",")).join("\n");
  const trips = "route_id,service_id,trip_id,trip_headsign,shape_id\n" +
    [t("red", "177198", "Downtown", 3), t("red", "177198_A", "Downtown", 1), t("red", "177202", "Loop", 4), t("blue", "B1", "North", 2), t("ten", "T10", "East", 1)].join("\n") + "\n";
  const routes = "route_id,route_short_name,route_long_name,route_type,route_color\n" +
    "ten,10,Ten Line,3,\nred,Red,Red Circulator,3,FF0000\nblue,,Blue Line,3,0000FF\n";
  const stops = "stop_id,stop_name,stop_lat,stop_lon\ns1,One,38.8,-104.8\n";
  return { "shapes.txt": shapes, "trips.txt": trips, "routes.txt": routes, "stops.txt": stops };
}

async function main() {
  for (const [url, v] of VENDOR_MAP) {
    if (!existsSync(join(VENDOR_DIR, v.file))) { console.error("Missing vendored asset for " + url); process.exit(1); }
  }
  const port = await findFreePort();
  const server = spawn(process.env.PYTHON || "python3", ["-m", "http.server", String(port)], { cwd: REPO_ROOT, stdio: "ignore" });
  let browser;
  try {
    await waitForHttpReady(port, 10000);
    browser = await playwright.chromium.launch({
      executablePath: existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined,
      headless: true,
      args: ["--no-sandbox"]
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      const vendored = VENDOR_MAP.get(url);
      if (vendored) return route.fulfill({ status: 200, contentType: vendored.type, body: readFileSync(join(VENDOR_DIR, vendored.file)) });
      if (url.startsWith("http://localhost:" + port + "/") || url.startsWith("http://127.0.0.1:" + port + "/")) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.warn("  [page error] " + e.message));
    await page.goto("http://localhost:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && App.loadGTFSFile", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    console.log("\n# Load + index");
    check("no index before a feed loads", await page.evaluate(() => App.gtfsRouteIndex() === null));
    await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      await App.loadGTFSFile(blob);
    }, feedFiles());
    await page.waitForFunction("App.map.getLayer('gtfs-shapes-layer') && App.gtfsRouteIndex()", { timeout: 15000 });
    const idx = await page.evaluate(() => App.gtfsRouteIndex());
    check("routes sorted naturally (10 < Blue Line < Red), unassigned last", eq(idx.map((r) => r.routeKey), ["ten", "blue", "red", "__unassigned__"]), idx.map((r) => r.routeKey));
    const red = idx.find((r) => r.routeKey === "red");
    check("Red has 3 shapes ordered by trips desc", eq(red.shapes.map((s) => s.shape_id), ["177202", "177198", "177198_A"]), red.shapes);
    check("Red trip counts 4/3/1, total 8", eq(red.shapes.map((s) => s.tripCount), [4, 3, 1]) && red.tripCount === 8);
    check("Red color + lengths positive", red.color === "#ff0000" && red.shapes.every((s) => s.lengthMi > 0));
    check("headsigns collected", eq(red.shapes[0].headsigns, ["Loop"]));
    const un = idx[idx.length - 1];
    check("shape with no trips lands in Unassigned shapes", un.routeKey === "__unassigned__" && eq(un.shapes.map((s) => s.shape_id), ["lonely"]) && un.long === "Unassigned shapes", un);
    check("highlight layers exist above shapes layer", await page.evaluate(() => {
      const order = App.map.getStyle().layers.map((l) => l.id);
      const a = order.indexOf("gtfs-shapes-layer");
      return a >= 0 && order.indexOf("gtfs-shapes-hl-casing") > a && order.indexOf("gtfs-shapes-hl") > order.indexOf("gtfs-shapes-hl-casing");
    }));

    console.log("\n# Visibility filters");
    const filt = () => page.evaluate(() => App.map.getFilter("gtfs-shapes-layer"));
    check("no filter initially", (await filt()) == null);
    await page.evaluate(() => App.gtfsSetRouteHidden("red", true));
    let f = await filt();
    check("hiding Red sets a route filter", JSON.stringify(f).includes('"red"') && JSON.stringify(f).includes("route_id"), f);
    await page.evaluate(() => App.gtfsSetShapeHidden("B1", true));
    f = await filt();
    check("route + shape hidden -> 'all' filter", f[0] === "all" && JSON.stringify(f).includes('"B1"'), f);
    const rendered = await page.evaluate(async () => {
      App.map.jumpTo({ center: [-104.7, 38.803], zoom: 9 });
      await new Promise((r) => App.map.once("idle", r));
      const feats = App.map.querySourceFeatures("gtfs-shapes", { filter: App.map.getFilter("gtfs-shapes-layer") });
      return Array.from(new Set(feats.map((x) => x.properties.shape_id))).sort();
    });
    check("filter really excludes Red + B1 (source query)", eq(rendered, ["T10", "lonely"]), rendered);
    await page.evaluate(() => App.gtfsShowAll());
    check("show all clears the filter", (await filt()) == null);
    await page.evaluate(() => App.gtfsShowOnly(["blue"]));
    f = await filt();
    check("show only Blue hides every other route", ["red", "ten", "__unassigned__"].every((k) => JSON.stringify(f).includes(k === "__unassigned__" ? '""' : '"' + k + '"')) && !JSON.stringify(f).includes('"blue"'), f);
    await page.evaluate(() => App.gtfsShowAll());
    check("layer-wide toggle still works", await page.evaluate(() => {
      App.setGtfsLayersVisible(false);
      const hidden = App.map.getLayoutProperty("gtfs-shapes-layer", "visibility") === "none" && App.map.getLayoutProperty("gtfs-shapes-hl", "visibility") === "none";
      App.setGtfsLayersVisible(true);
      return hidden && App.map.getLayoutProperty("gtfs-shapes-layer", "visibility") === "visible";
    }));

    console.log("\n# Highlight + zoom");
    const hl = (id) => page.evaluate((id) => App.map.getFilter(id), id);
    await page.evaluate(() => App.gtfsHighlight({ shapeId: "177198" }));
    check("highlight a shape sets both filters", JSON.stringify(await hl("gtfs-shapes-hl")).includes("177198") && eq(await hl("gtfs-shapes-hl"), await hl("gtfs-shapes-hl-casing")));
    await page.evaluate(() => App.gtfsHighlight({ routeId: "red" }));
    check("highlight a route filters on route_id", JSON.stringify(await hl("gtfs-shapes-hl")).includes("route_id") && JSON.stringify(await hl("gtfs-shapes-hl")).includes("red"));
    await page.evaluate(() => App.gtfsHighlight(null));
    check("highlight(null) matches nothing", JSON.stringify(await hl("gtfs-shapes-hl")).includes("none"));
    const moved = await page.evaluate(async () => {
      App.map.jumpTo({ center: [-100, 30], zoom: 3 });
      App.gtfsZoomTo({ routeId: "red" });
      await new Promise((r) => App.map.once("moveend", r));
      const c = App.map.getCenter();
      return Math.abs(c.lng + 104.78) < 0.1 && Math.abs(c.lat - 38.803) < 0.1;
    });
    check("zoomTo route fits its shapes", moved);

    console.log("\n# Copy");
    const lines = () => page.evaluate(() => App.lines.map((l) => ({ name: l.properties.name, color: l.properties.color, group: (l.properties.attributes || {}).group, mode: (l.properties.attributes || {}).mode, notes: (l.properties.attributes || {}).notes, n: l.geometry.coordinates.length })));
    let made = await page.evaluate(() => App.gtfsCopy({ routeId: "red", mode: "representative" }));
    let L = await lines();
    check("representative copy -> one line named 'Red', color, no group", eq(made, [0]) && L.length === 1 && L[0].name === "Red" && L[0].color.toLowerCase() === "#ff0000" && !L[0].group && L[0].n === 5 && L[0].mode === "Bus", { made, L });
    made = await page.evaluate(() => App.gtfsCopy({ routeId: "red", mode: "each" }));
    L = await lines();
    check("each copy -> 3 new lines", eq(made, [1, 2, 3]) && L.length === 4, made);
    check("multi names '<name> \u2013 <shape_id>'", eq(L.slice(1).map((l) => l.name), ["Red \u2013 177202", "Red \u2013 177198", "Red \u2013 177198_A"]), L.map((l) => l.name));
    check("multi copies share group = route name and color", L.slice(1).every((l) => l.group === "Red" && l.color.toLowerCase() === "#ff0000"), L);
    made = await page.evaluate(() => App.gtfsCopy({ routeId: "blue", mode: "shape", shapeId: "B1" }));
    L = await lines();
    check("single shape copy named by route (long name fallback), no group", eq(made, [4]) && L[4].name === "Blue Line" && !L[4].group && L[4].color.toLowerCase() === "#0000ff", L[4]);
    made = await page.evaluate(() => App.gtfsCopy({ routeId: "blue", mode: "each" }));
    L = await lines();
    check("'each' on a single-shape route is a plain single copy", eq(made, [5]) && L[5].name === "Blue Line" && !L[5].group, L[5]);
    made = await page.evaluate(() => App.gtfsCopy({ routeId: "__unassigned__", mode: "representative" }));
    L = await lines();
    check("unassigned shape copies under its shape_id", eq(made, [6]) && L[6].name === "lonely", L[6]);
    check("bad route -> nothing created", eq(await page.evaluate(() => App.gtfsCopy({ routeId: "nope", mode: "each" })), []));

    console.log("\n# Session round trip + clear");
    await page.evaluate(() => { App.gtfsSetRouteHidden("ten", true); App.gtfsSetShapeHidden("B1", true); });
    const state = await page.evaluate(() => { const s = App.cache.collectState("full"); s.gtfsData = App.serializeGTFSData(); return JSON.parse(JSON.stringify(s)); });
    check("hidden sets collected into moduleState", eq(state.moduleState["gtfs-browse"], { routes: ["ten"], shapes: ["B1"] }), state.moduleState["gtfs-browse"]);
    await page.evaluate(() => App.clearGTFS());
    check("clear: index null, layers + highlight layers gone", await page.evaluate(() => App.gtfsRouteIndex() === null &&
      !["gtfs-shapes-layer", "gtfs-shapes-hl", "gtfs-shapes-hl-casing", "gtfs-stops-layer"].some((id) => App.map.getLayer(id))));
    check("clear: API calls are harmless no-ops", await page.evaluate(() => { App.gtfsSetRouteHidden("red", true); App.gtfsHighlight({ shapeId: "x" }); App.gtfsZoomTo({ routeId: "red" }); return true; }));
    await page.evaluate((s) => { App.cache.applyState(s); App.restoreGTFSFromData(s.gtfsData); }, state);
    await page.waitForFunction("App.gtfsRouteIndex()", { timeout: 15000 });
    const restored = await page.evaluate(() => ({ n: App.gtfsRouteIndex().length, h: App.gtfsHiddenState(), f: App.map.getFilter("gtfs-shapes-layer") }));
    check("restore rebuilds the index and re-applies hidden sets", restored.n === 4 && eq(restored.h, { routes: ["ten"], shapes: ["B1"] }) && restored.f && restored.f[0] === "all", restored);
    await page.evaluate(() => App.clearGTFS());

    // ================= END =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
