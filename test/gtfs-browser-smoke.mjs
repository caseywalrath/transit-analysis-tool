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
  // direction_id: 177198 all 0 (Outbound), 177198_A 1 (Inbound), 177202 mixed (blank).
  const t = (r, s, h, n, d) => Array.from({ length: n }, (_, i) => [r, "svc", r + "_" + s + "_" + i, h, s, typeof d === "function" ? d(i) : (d == null ? "" : d)].join(",")).join("\n");
  const trips = "route_id,service_id,trip_id,trip_headsign,shape_id,direction_id\n" +
    [t("red", "177198", "Downtown", 3, 0), t("red", "177198_A", "Downtown", 1, 1), t("red", "177202", "Loop", 4, (i) => i % 2), t("blue", "B1", "North", 2), t("ten", "T10", "East", 1)].join("\n") + "\n";
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

    console.log("\n# Copy all as grouped Service (Phase 3)");
    const svcAttrs = () => page.evaluate(() => App.lines.map((l) => { const a = l.properties.attributes || {}; return { name: l.properties.name, group: a.group, serviceId: a.serviceId, direction: a.direction || "" }; }));
    const svcN0 = await page.evaluate(() => App.lines.length);
    made = await page.evaluate(() => App.gtfsCopy({ routeId: "red", mode: "service" }));
    let S = (await svcAttrs()).slice(svcN0);
    check("service copy -> 3 new lines", made.length === 3 && S.length === 3, made);
    check("service copy: shared group + serviceId = route name", S.every((l) => l.group === "Red" && l.serviceId === "Red"), S);
    check("service copy: direction from unambiguous direction_id, else blank",
      eq(S.map((l) => [l.name, l.direction]), [["Red \u2013 177202", ""], ["Red \u2013 177198", "Outbound"], ["Red \u2013 177198_A", "Inbound"]]), S);
    let svc = await page.evaluate(() => App.buildTransitServices().filter((x) => x.key === "service-Red").map((x) => ({ n: x.patterns.length, w: x.warnings.map((w) => w.msg) })));
    check("buildTransitServices -> one 3-pattern Service", svc.length === 1 && svc[0].n === 3, svc);
    check("blank direction -> 'needs a one-way direction' warning (Needs setup), no max-2 error",
      svc[0] && svc[0].w.some((m) => /177202.*one-way direction/.test(m)) && !svc[0].w.some((m) => /max 2/.test(m)), svc);
    made = await page.evaluate(() => App.gtfsCopy({ routeId: "red", mode: "service" }));
    S = (await svcAttrs()).slice(svcN0 + 3);
    check("second service copy gets a unique serviceId 'Red (2)'", made.length === 3 && S.every((l) => l.serviceId === "Red (2)" && l.group === "Red"), S);
    await page.evaluate(() => App.undo.undo());
    check("service copy is ONE undo step", (await page.evaluate(() => App.lines.length)) === svcN0 + 3);
    // Fill in direction + bands + speed on the first copy -> a costable 3-pattern Service.
    svc = await page.evaluate((n0) => {
      App.lines.slice(n0, n0 + 3).forEach((l) => {
        const a = l.properties.attributes;
        if (!a.direction) a.direction = "Outbound";
        a.avgSpeed = 12;
        a.service = { weekday: [{ from: "6:00", to: "9:00", frequency: 30 }] };
      });
      return App.buildTransitServices().filter((x) => x.key === "service-Red").map((x) => ({ n: x.patterns.length, blocked: App.hasBlockingWarnings(x), w: x.warnings }));
    }, svcN0);
    check("set-up 3-pattern Service has no blocking warnings", svc.length === 1 && svc[0].n === 3 && !svc[0].blocked, svc);
    await page.evaluate((n0) => { App.lines.splice(n0); App.renderLineLayers(); }, svcN0);

    console.log("\n# Session round trip + clear");
    await page.evaluate(() => { App.gtfsSetRouteHidden("ten", true); App.gtfsSetShapeHidden("B1", true); });
    const state = await page.evaluate(() => { const s = App.cache.collectState("full"); s.gtfsData = App.serializeGTFSData(); return JSON.parse(JSON.stringify(s)); });
    check("hidden sets collected into moduleState", eq(state.moduleState["gtfs-browse"], { routes: ["ten"], shapes: ["B1"], stops: [], feedFile: state.moduleState["gtfs-browse"].feedFile }), state.moduleState["gtfs-browse"]);
    await page.evaluate(() => App.clearGTFS());
    check("clear: index null, layers + highlight layers gone", await page.evaluate(() => App.gtfsRouteIndex() === null &&
      !["gtfs-shapes-layer", "gtfs-shapes-hl", "gtfs-shapes-hl-casing", "gtfs-stops-layer"].some((id) => App.map.getLayer(id))));
    check("clear: API calls are harmless no-ops", await page.evaluate(() => { App.gtfsSetRouteHidden("red", true); App.gtfsHighlight({ shapeId: "x" }); App.gtfsZoomTo({ routeId: "red" }); return true; }));
    await page.evaluate((s) => { App.cache.applyState(s); App.restoreGTFSFromData(s.gtfsData); }, state);
    await page.waitForFunction("App.gtfsRouteIndex()", { timeout: 15000 });
    const restored = await page.evaluate(() => ({ n: App.gtfsRouteIndex().length, h: App.gtfsHiddenState(), f: App.map.getFilter("gtfs-shapes-layer") }));
    check("restore rebuilds the index and re-applies hidden sets", restored.n === 4 && eq(restored.h, { routes: ["ten"], shapes: ["B1"] }) && restored.f && restored.f[0] === "all", restored);
    await page.evaluate(() => App.clearGTFS());


    // ================= Phase 2: Layers tab UI =================
    console.log("\n# Layers tab route browser (real UI)");
    await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      await App.loadGTFSFile(await zip.generateAsync({ type: "blob" }));
    }, feedFiles());
    await page.waitForFunction("App.gtfsRouteIndex()", { timeout: 15000 });
    await page.click('[data-fptab="layers"]');
    const BR = "#fp-tab-layers .lp-gtfs-browser";
    check("browser collapsed by default", (await page.locator(BR).count()) === 0);
    const gtfsRow = page.locator("#fp-tab-layers .lp-row", { hasText: "GTFS routes" }).first();
    await gtfsRow.locator(".lp-gtfs-browse-btn").click();
    check("caret expands the browser", (await page.locator(BR).count()) === 1);
    check("routes listed in index order", eq(await page.locator(BR + " .lp-gtfs-route .lp-gtfs-title").evaluateAll((els) => els.map((e) => e.textContent)), ["10", "Blue Line", "Red", "Unassigned shapes"]));
    check("shape rows are lazy (none built yet)", (await page.locator(BR + " .lp-gtfs-shape").count()) === 0);
    check("route row shows '(3 shapes)' and color dot", (await page.locator(BR + " .lp-gtfs-route", { hasText: "Red" }).locator(".lp-gtfs-count").textContent()) === "(3 shapes)" &&
      (await page.locator(BR + " .lp-gtfs-route", { hasText: "Red" }).locator(".lp-gtfs-dot").evaluate((e) => getComputedStyle(e).backgroundColor)) === "rgb(255, 0, 0)");

    // Filter: typing keeps focus; list only re-renders.
    const filterIn = page.locator(BR + " .lp-gtfs-filter");
    await filterIn.click();
    await page.keyboard.type("1771");
    check("filter keeps focus while typing", await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lp-gtfs-filter")));
    check("filter by shape_id narrows to Red", eq(await page.locator(BR + " .lp-gtfs-route .lp-gtfs-title").evaluateAll((els) => els.map((e) => e.textContent)), ["Red"]));
    check("'Show only filtered' enabled with filter", await page.locator(BR + " .lp-gtfs-actions button", { hasText: "Show only filtered" }).isEnabled());
    await filterIn.fill("");
    check("blank filter lists all 4 again + only-filtered disabled", (await page.locator(BR + " .lp-gtfs-route").count()) === 4 && !(await page.locator(BR + " .lp-gtfs-actions button", { hasText: "Show only filtered" }).isEnabled()));

    // Expand a route (lazy shapes), hover highlight.
    const redRow = page.locator(BR + " .lp-gtfs-route", { hasText: "Red" });
    await redRow.locator(".lp-caret").click();
    check("expanding builds the 3 shape rows in order", eq(await page.locator(BR + " .lp-gtfs-shape .lp-row-label").evaluateAll((els) => els.map((e) => e.textContent.split(" · ")[0])), ["177202", "177198", "177198_A"]));
    check("shape row text has length, trips, headsign", /^177202\d+\.\d mi · 4 trips · Loop$/.test(await page.locator(BR + " .lp-gtfs-shape").first().locator(".lp-gtfs-text").textContent()));
    await redRow.hover();
    check("hover route row highlights the route", JSON.stringify(await hl("gtfs-shapes-hl")).includes("route_id") && JSON.stringify(await hl("gtfs-shapes-hl")).includes("red"));
    await page.locator(BR + " .lp-gtfs-shape").nth(1).hover();
    check("hover shape row highlights the shape", JSON.stringify(await hl("gtfs-shapes-hl")).includes("177198") && !JSON.stringify(await hl("gtfs-shapes-hl")).includes("route_id"));
    await page.mouse.move(5, 5);
    check("mouse leave clears highlight", JSON.stringify(await hl("gtfs-shapes-hl")).includes("none"));

    // Click pins; survives refresh; second click unpins.
    await page.locator(BR + " .lp-gtfs-shape").nth(1).click();
    check("click pins the shape highlight after mouse leaves", await (async () => { await page.mouse.move(5, 5); return JSON.stringify(await hl("gtfs-shapes-hl")).includes("177198"); })());

    // State survives a rebuild; scroll preserved.
    await page.evaluate(() => { document.querySelector("#fp-tab-layers").closest(".fp-content").scrollTop = 40; });
    await page.evaluate(() => App.refreshLayersPanel());
    check("expand state survives refreshLayersPanel", (await page.locator(BR + " .lp-gtfs-shape").count()) === 3);
    check("pinned highlight + pinned row class survive refresh", JSON.stringify(await hl("gtfs-shapes-hl")).includes("177198") && (await page.locator(BR + " .lp-gtfs-pinned").count()) === 1);
    await filterIn.fill("red");
    await page.evaluate(() => App.refreshLayersPanel());
    check("filter text survives refreshLayersPanel", (await page.locator(BR + " .lp-gtfs-filter").inputValue()) === "red");
    await page.locator(BR + " .lp-gtfs-filter").focus();
    await page.evaluate(() => App.refreshLayersPanel());
    check("filter keeps focus through a rebuild", await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lp-gtfs-filter")));
    await page.locator(BR + " .lp-gtfs-filter").fill("");
    check("scroll position survives rebuild (when scrollable)", await page.evaluate(() => { const c = document.querySelector("#fp-tab-layers").closest(".fp-content"); const want = Math.min(40, c.scrollHeight - c.clientHeight); return Math.abs(c.scrollTop - want) <= 1; }));

    // Eye toggles drive the main layer filter.
    await page.locator(BR + " .lp-gtfs-route", { hasText: "Blue Line" }).hover();
    await page.locator(BR + " .lp-gtfs-route", { hasText: "Blue Line" }).locator(".lp-gtfs-eye").click();
    check("route eye hides it on the map layer", JSON.stringify(await filt()).includes('"blue"'), await filt());
    check("hidden route row is dimmed with an eye-off icon", await page.locator(BR + " .lp-gtfs-route", { hasText: "Blue Line" }).evaluate((r) => r.classList.contains("lp-row-hidden") && !!r.querySelector(".lp-eye-off")));
    await page.locator(BR + " .lp-gtfs-route", { hasText: "Red" }).hover();
    await page.locator(BR + " .lp-gtfs-route", { hasText: "Red" }).locator(".lp-gtfs-eye").click();
    check("hidden route dims its shape rows too", (await page.locator(BR + " .lp-gtfs-shape.lp-row-hidden").count()) === 3);
    await page.locator(BR + " .lp-gtfs-actions button", { hasText: "Show all" }).click();
    check("Show all clears the filter + dimming", (await filt()) == null && (await page.locator(BR + " .lp-row-hidden").count()) === 0);
    await page.locator(BR + " .lp-gtfs-shape").first().hover();
    await page.locator(BR + " .lp-gtfs-shape").first().locator(".lp-gtfs-eye").click();
    check("shape eye hides just that shape", JSON.stringify(await filt()).includes("177202") && !JSON.stringify(await filt()).includes('"red"'), await filt());
    await page.locator(BR + " .lp-gtfs-actions button", { hasText: "Hide all" }).click();
    check("Hide all hides every route", (await page.locator(BR + " .lp-gtfs-route.lp-row-hidden").count()) === 4);
    await filterIn.fill("blue");
    await page.locator(BR + " .lp-gtfs-actions button", { hasText: "Show only filtered" }).click();
    check("Show only filtered shows just Blue", (await page.locator(BR + " .lp-gtfs-route:not(.lp-row-hidden)").count()) === 1 && !JSON.stringify(await filt()).includes('"blue"'));
    await page.locator(BR + " .lp-gtfs-actions button", { hasText: "Show all" }).click();
    await filterIn.fill("");

    // Menus + copy.
    const before = await page.evaluate(() => App.lines.length);
    await redRow.click({ button: "right" });
    check("right-click opens the route menu", eq(await page.locator("#fp-context-menu button").allTextContents(), ["Copy as line", "Copy each shape as a line", "Copy all as grouped Service", "Show only this", "Zoom to"]));
    await page.locator("#fp-context-menu button", { hasText: "Copy each shape as a line" }).click();
    let nl = await page.evaluate((b) => App.lines.slice(b).map((l) => ({ n: l.properties.name, g: (l.properties.attributes || {}).group, c: l.properties.color })), before);
    check("copy each -> 3 lines, shared group, color", nl.length === 3 && nl.every((l) => l.g === "Red" && l.c.toLowerCase() === "#ff0000") && nl[0].n === "Red – 177202", nl);
    check("first new line is selected", await page.evaluate(() => App.isFeatureSelected("line", App.lines.length - 3)));
    await page.evaluate(() => App.undo.undo());
    check("copy each is ONE undo step", (await page.evaluate(() => App.lines.length)) === before, await page.evaluate(() => App.lines.length));
    await page.locator(BR + " .lp-gtfs-route", { hasText: "Red" }).locator(".lp-row-menu").evaluate((b) => b.click());
    check("⋯ button opens the same menu", (await page.locator("#fp-context-menu button").count()) === 5);
    await page.locator("#fp-context-menu button", { hasText: "Show only this" }).click();
    check("Show only this hides the other routes", JSON.stringify(await filt()).includes('"blue"') && !JSON.stringify(await filt()).includes('"red"'));
    await page.locator(BR + " .lp-gtfs-actions button", { hasText: "Show all" }).click();
    await page.locator(BR + " .lp-gtfs-shape").nth(2).click({ button: "right" });
    check("shape menu has 3 entries", eq(await page.locator("#fp-context-menu button").allTextContents(), ["Copy as line", "Show only this route", "Zoom to"]));
    await page.locator("#fp-context-menu button", { hasText: "Copy as line" }).click();
    const last = await page.evaluate(() => { const l = App.lines[App.lines.length - 1]; return { n: l.properties.name, g: (l.properties.attributes || {}).group, notes: (l.properties.attributes || {}).notes }; });
    check("shape copy -> single name, no group, notes carry shape_id", last.n === "Red" && !last.g && /177198_A/.test(last.notes), last);

    // ---- Phase 4: map right-click menu ----
    console.log("\n# Map right-click menu");
    const rightClickAt = async (lng, lat, zoom) => {
      const pt = await page.evaluate(async ([lng, lat, zoom]) => {
        App.map.jumpTo({ center: [lng, lat], zoom });
        await new Promise((r) => App.map.once("idle", r));
        const p = App.map.project([lng, lat]);
        const r = App.map.getCanvas().getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y };
      }, [lng, lat, zoom]);
      await page.mouse.move(pt.x, pt.y);
      await page.mouse.click(pt.x, pt.y, { button: "right" });
      await page.waitForSelector("#fp-context-menu button", { timeout: 5000 });
    };
    const menuTexts = () => page.locator("#fp-context-menu > *").allTextContents();
    const hlJson = () => page.evaluate(() => JSON.stringify(App.map.getFilter("gtfs-shapes-hl")));
    await page.evaluate(() => { App.gtfsHighlight(null); });
    // One route under the cursor: no header, trips desc.
    await rightClickAt(-104.78, 38.802, 9);
    check("single-route menu: shapes by trips desc, no header", eq(await menuTexts(), [
      "Copy as line: Red \u00b7 177202 \u00b7 4 trips", "Copy as line: Red \u00b7 177198 \u00b7 3 trips", "Copy as line: Red \u00b7 177198_A \u00b7 1 trip"]), await menuTexts());
    const items = page.locator("#fp-context-menu button");
    const base = await hlJson(); // whatever the Layers panel has pinned (earlier tests may leave a pin)
    await items.nth(1).hover();
    check("hover highlights that shape", (await hlJson()).includes('"177198"') && !(await hlJson()).includes("177198_A"), await hlJson());
    await page.mouse.move(5, 5);
    check("leaving the item restores the prior highlight", (await hlJson()) === base, await hlJson());
    await items.nth(2).hover();
    await page.mouse.click(600, 20);
    check("closing the menu (outside click) restores highlight", (await page.locator("#fp-context-menu").count()) === 0 && (await hlJson()) === base, await hlJson());
    // Real pin from the Layers panel.
    await page.evaluate(() => { const t = document.querySelector('.fp-tab-btn[data-fptab="layers"]'); if (t) t.click(); });
    const blueRow = page.locator(BR + " .lp-gtfs-route", { hasText: "Blue" });
    await blueRow.click();
    check("Layers panel pin highlights Blue's route", (await hlJson()).includes("blue"), await hlJson());
    await rightClickAt(-104.78, 38.802, 9);
    await page.locator("#fp-context-menu button").nth(0).hover();
    check("hover shows the shape over the pin", (await hlJson()).includes("177202"));
    await page.keyboard.press("Escape");
    await page.mouse.click(600, 20);
    check("close restores the pinned (route) highlight", (await hlJson()).includes("blue"), await hlJson());
    await blueRow.click();
    // Multiple routes: headers.
    await rightClickAt(-104.75, 38.8025, 7);
    const mt = await menuTexts();
    check("multi-route menu has route headers (Red, Blue Line)", ["Red", "Blue Line"].every((n) => mt.includes(n)), mt);
    const redHdr = mt.indexOf("Red");
    check("shapes sit under their route header", mt[redHdr + 1].startsWith("Copy as line: Red \u00b7 177202"), mt);
    // Click -> line created.
    const nBefore = await page.evaluate(() => App.lines.length);
    await page.locator("#fp-context-menu button", { hasText: "177202" }).click();
    const created = await page.evaluate(() => ({ n: App.lines.length, name: App.lines[App.lines.length - 1].properties.name, notes: App.lines[App.lines.length - 1].properties.attributes.notes }));
    check("click creates a line for that shape", created.n === nBefore + 1 && created.name === "Red" && /177202/.test(created.notes), created);
    check("highlight restored after click", !(await hlJson()).includes("177202"), await hlJson());
    await page.evaluate(() => App.gtfsShowAll());

    // Keyboard.
    await page.locator(BR + " .lp-gtfs-route", { hasText: "Red" }).focus();
    await page.keyboard.press("Enter");
    check("Enter on a focused route row toggles expand", (await page.locator(BR + " .lp-gtfs-shape").count()) === 0 || (await page.locator(BR + " .lp-gtfs-shapes").evaluate((e) => e.style.display)) === "none");
    await page.keyboard.press("Shift+F10");
    check("Shift+F10 opens the row menu", (await page.locator("#fp-context-menu button").count()) === 5);
    await page.keyboard.press("Escape");
    await page.mouse.click(600, 400);

    // >200 routes cap, via the real list renderer.
    check("no 'Showing N of' note when under the cap", (await page.locator(BR + " .lp-gtfs-more").count()) === 0);

    await page.screenshot({ path: process.env.GTFS_SHOT || "/tmp/gtfs-browser-shot.png", clip: { x: 1180, y: 0, width: 220, height: 900 } });
    await page.evaluate(() => App.clearGTFS());
    check("browser disappears when the feed is cleared", (await page.locator(BR).count()) === 0);

    // ================= END =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
