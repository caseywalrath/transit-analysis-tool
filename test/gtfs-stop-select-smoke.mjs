#!/usr/bin/env node
// test/gtfs-stop-select-smoke.mjs
//
// Browser smoke test for Phase 5 item 1 of docs/archive/gtfs-stop-selection-plan.md:
// box select on the GTFS stops target, the on-map bar, stop right-click items,
// stop-list export/import, feed switching, reload restore, clear lifecycle, and
// the "Selected" export scope for drawn features.
//
// USAGE (see test/ui-screens/capture.mjs for the one-time Playwright install):
//   NODE_PATH=/path/to/playwright/node_modules node test/gtfs-stop-select-smoke.mjs
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

let failures = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (!ok && detail !== undefined ? "  -> " + JSON.stringify(detail) : ""));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Minimal RFC 4180 reader (the exported stop names contain commas).
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// Two rows of four stops. Row A (north) a1..a4, row B (south) b1..b4.
const LONS = [-104.806, -104.802, -104.798, -104.794];
const LAT_A = 38.810, LAT_B = 38.806;
const STOPS = {};
["a", "b"].forEach((r) => LONS.forEach((lon, i) => { STOPS[r + (i + 1)] = [lon, r === "a" ? LAT_A : LAT_B]; }));
const NAMES = { b1: '"Main, & 1st ""Stn"""' };
function feedFiles(omit) {
  const rows = Object.keys(STOPS).filter((id) => !omit.includes(id))
    .map((id) => [id, "C" + id, NAMES[id] || "Stop " + id, STOPS[id][1], STOPS[id][0], 0, ""].join(","));
  const stops = "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n" + rows.join("\n") + "\n";
  const shapes = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS1,38.80,-104.81,1\nS1,38.80,-104.79,2\n";
  const trips = "route_id,service_id,trip_id,trip_headsign,shape_id,direction_id\nr1,svc,t1,Down,S1,0\n";
  const routes = "route_id,route_short_name,route_long_name,route_type\nr1,One,One Line,3\n";
  return { "stops.txt": stops, "shapes.txt": shapes, "trips.txt": trips, "routes.txt": routes };
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
      headless: true, args: ["--no-sandbox"]
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      const vendored = VENDOR_MAP.get(url);
      if (vendored) return route.fulfill({ status: 200, contentType: vendored.type, body: readFileSync(join(VENDOR_DIR, vendored.file)) });
      if (url.startsWith("http://localhost:" + port + "/") || url.startsWith("http://127.0.0.1:" + port + "/")) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.warn("  [page error] " + e.message));
    const URL_ = "http://localhost:" + port + "/index.html";
    const ready = async () => {
      await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && App.loadGTFSFile && App.gtfsStops && App.boxSelect", { timeout: 30000 });
    };
    await page.goto(URL_, { waitUntil: "load" });
    await ready();
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    // ---- helpers ----
    const loadFeed = async (name, omit) => {
      await page.evaluate(async ([name, files]) => {
        const zip = new JSZip();
        Object.keys(files).forEach((k) => zip.file(k, files[k]));
        const blob = await zip.generateAsync({ type: "blob" });
        await App.loadGTFSFile(new File([blob], name, { type: "application/zip" }));
      }, [name, feedFiles(omit)]);
      await page.waitForFunction("App.gtfsStops.isAvailable().ok && App.map.getLayer('gtfs-stops-selected')", { timeout: 15000 });
    };
    const view = () => page.evaluate(() => App.map.jumpTo({ center: [-104.8, 38.808], zoom: 15 }));
    const px = (lng, lat) => page.evaluate(([lng, lat]) => {
      const p = App.map.project([lng, lat]); const r = App.map.getCanvasContainer().getBoundingClientRect();
      return [r.left + p.x, r.top + p.y];
    }, [lng, lat]);
    async function drag(a, b, mods = []) {
      const A = await px(a[0], a[1]), B = await px(b[0], b[1]);
      for (const m of mods) await page.keyboard.down(m);
      await page.mouse.move(A[0], A[1]); await page.mouse.down();
      await page.mouse.move((A[0] + B[0]) / 2, (A[1] + B[1]) / 2, { steps: 3 });
      await page.mouse.move(B[0], B[1], { steps: 3 });
      await page.waitForTimeout(50);
      await page.mouse.up();
      for (const m of mods) await page.keyboard.up(m);
      await page.waitForTimeout(100);
    }
    const around = (id, d = 0.0012) => [[STOPS[id][0] - d, STOPS[id][1] + d * 0.8], [STOPS[id][0] + d, STOPS[id][1] - d * 0.8]];
    const dragStop = (id, mods) => drag(...around(id), mods);
    const sel = () => page.evaluate(() => App.gtfsStops.ids().slice().sort().join(","));
    const fsel = () => page.evaluate(() => App.getSelectedFeatures().map((s) => s.type + ":" + s.index).sort().join(","));
    const barText = () => page.evaluate(() => { const e = document.querySelector(".box-select-bar-count"); return e ? e.textContent : null; });
    const setTarget = async (id) => { await page.selectOption(".box-select-bar-target", id); await page.waitForTimeout(60); };
    async function download(trigger) {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.evaluate(trigger)]);
      return { name: dl.suggestedFilename(), text: readFileSync(await dl.path(), "utf8") };
    }

    // ================= Setup =================
    console.log("\n# Setup");
    await page.evaluate(() => App.map.jumpTo({ center: [-104.8, 38.808], zoom: 15 }));
    await loadFeed("build.zip", []);
    check("feed loaded; file name remembered", await page.evaluate(() => App.gtfsStops.feedFileName()) === "build.zip");
    check("candidates: 8 stops", (await page.evaluate(() => App.gtfsStops.candidates().length)) === 8);
    // Two drawn points (far from the stop rows), one selected.
    await page.evaluate(() => {
      App.addPoint(-104.790, 38.8030); App.addPoint(-104.810, 38.8030);
      App.setSelection([{ type: "point", index: 0 }]);
    });
    await view();
    await page.waitForTimeout(200);

    console.log("\n# Bar + target");
    check("bar hidden while the tool is off", await page.evaluate(() => { const b = document.querySelector(".box-select-bar"); return !b || b.hidden; }));
    await page.click('.tool-btn[data-mode="box-select"]');
    check("bar visible with the tool on", await page.evaluate(() => { const b = document.querySelector(".box-select-bar"); return !!b && !b.hidden; }));
    check("bar is inside the map container but outside the canvas container", await page.evaluate(() => {
      const b = document.querySelector(".box-select-bar");
      return App.map.getContainer().contains(b) && !App.map.getCanvasContainer().contains(b);
    }));
    check("target starts on Features", await page.evaluate(() => App.boxSelect.currentTarget()) === "features");
    check("target dropdown offers GTFS stops, enabled", await page.evaluate(() => {
      const o = Array.from(document.querySelectorAll(".box-select-bar-target option")).find((x) => x.value === "gtfs-stops");
      return !!o && !o.disabled;
    }));
    await setTarget("gtfs-stops");
    check("dropdown switches the target", await page.evaluate(() => App.boxSelect.currentTarget()) === "gtfs-stops");
    check("bar count: 0 stops selected", /^0 stops selected/.test(await barText()), await barText());

    console.log("\n# Box select on stops");
    const c0 = await page.evaluate(() => App.map.getCenter().toArray());
    await drag([-104.808, 38.8115], [-104.800, 38.8085]);
    check("replace: drag selects a1,a2", (await sel()) === "a1,a2", await sel());
    check("map did not pan", eq(await page.evaluate(() => App.map.getCenter().toArray()), c0));
    check("bar count: 2 stops selected", /^2 stops selected/.test(await barText()), await barText());
    check("highlight filter lists the selected stops", await page.evaluate(() => { const f = JSON.stringify(App.map.getFilter("gtfs-stops-selected")); return f.includes('"a1"') && f.includes('"a2"') && !f.includes('"b1"'); }));
    await dragStop("b1", ["Shift"]);
    check("Shift adds b1", (await sel()) === "a1,a2,b1", await sel());
    await dragStop("a1", ["Control"]);
    check("Ctrl removes a1", (await sel()) === "a2,b1", await sel());
    await drag([-104.800, 38.8075], [-104.792, 38.8045]);
    check("plain drag replaces (b3,b4)", (await sel()) === "b3,b4", await sel());
    const A3 = await px(...STOPS.a3);
    await page.mouse.click(A3[0], A3[1]);
    await page.waitForTimeout(100);
    check("click on a stop selects just it", (await sel()) === "a3", await sel());
    const E = await px(-104.790, 38.8135);
    await page.mouse.click(E[0], E[1]);
    await page.waitForTimeout(100);
    check("plain click on empty map clears the stop selection", (await sel()) === "", await sel());
    check("feature selection untouched by stop drags", (await fsel()) === "point:0", await fsel());

    console.log("\n# Features unaffected the other way");
    await page.evaluate(() => App.gtfsStops.set(["a1"]));
    await setTarget("features");
    await page.evaluate(() => App.setSelection([]));
    await drag([-104.792, 38.8045], [-104.788, 38.8015]);
    check("features target selects the point under the box", (await fsel()) === "point:0", await fsel());
    check("stop selection untouched by feature drag", (await sel()) === "a1", await sel());

    console.log("\n# Delete key on the stops target");
    await setTarget("gtfs-stops");
    const pc = await page.evaluate(() => App.points.length);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);
    check("Delete does nothing (no dialog, nothing removed, selection kept)",
      (await page.evaluate(() => !document.querySelector(".fm-dialog"))) && (await page.evaluate(() => App.points.length)) === pc && (await fsel()) === "point:0" && (await sel()) === "a1");

    console.log("\n# Bar click does not start a drag");
    const cb = await page.evaluate(() => { const r = document.querySelector(".box-select-bar-count").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.mouse.move(cb[0], cb[1]); await page.mouse.down(); await page.mouse.move(cb[0] + 40, cb[1] + 40, { steps: 3 });
    const dragging = await page.evaluate(() => App.boxSelect.isDragging());
    await page.mouse.up();
    await page.waitForTimeout(100);
    check("dragging from the bar starts no box", !dragging && (await sel()) === "a1" && (await page.evaluate(() => !document.querySelector(".box-select-rect"))));
    await page.click(".box-select-bar-target");
    await page.keyboard.press("Escape"); // closes native select popup if any
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    // Escape above may have exited the tool; make sure it is on for what follows.
    if (!(await page.evaluate(() => App.drawMode === "box-select"))) await page.click('.tool-btn[data-mode="box-select"]');
    await page.evaluate(() => App.boxSelect.setTarget("gtfs-stops"));

    console.log("\n# Stops layer hidden");
    await page.evaluate(() => { App.gtfsStops.set(["a1"]); App.boxSelect.setTarget("features"); App.setGtfsLayersVisible(false); App.boxSelect.refreshBar(); });
    check("isAvailable false with a reason", await page.evaluate(() => { const a = App.gtfsStops.isAvailable(); return !a.ok && /hidden/i.test(a.reason); }));
    check("GTFS stops option is disabled in the dropdown", await page.evaluate(() => {
      const o = Array.from(document.querySelectorAll(".box-select-bar-target option")).find((x) => x.value === "gtfs-stops");
      return !!o && o.disabled && !!o.title;
    }));
    await page.evaluate(() => { App.boxSelect.setTarget("gtfs-stops"); });
    await dragStop("a2");
    check("drag selects nothing while hidden (selection unchanged)", (await sel()) === "a1", await sel());
    check("bar count explains why", /hidden/i.test(await barText()), await barText());
    await page.evaluate(() => { App.setGtfsLayersVisible(true); App.boxSelect.refreshBar(); });
    check("visible again -> available and enabled", await page.evaluate(() => App.gtfsStops.isAvailable().ok));
    await dragStop("a2");
    check("drag works again", (await sel()) === "a2", await sel());

    console.log("\n# Bar Clear");
    await page.click(".box-select-bar-clear");
    check("bar Clear empties the stop selection (features kept)", (await sel()) === "" && (await fsel()) === "point:0");

    console.log("\n# Right-click add / remove");
    await page.keyboard.press("Escape");
    check("Escape exits the tool and hides the bar", await page.evaluate(() => App.drawMode === null && document.querySelector(".box-select-bar").hidden));
    const rclick = async (id) => {
      const p = await px(...STOPS[id]);
      await page.mouse.move(p[0], p[1]);
      await page.mouse.click(p[0], p[1], { button: "right" });
      await page.waitForSelector("#fp-context-menu button", { timeout: 5000 });
    };
    const menu = () => page.locator("#fp-context-menu button").allTextContents();
    await rclick("b2");
    let m = await menu();
    check("menu offers Add to stop selection", m.includes("Add to stop selection") && m.includes("Copy As Point"), m);
    await page.locator("#fp-context-menu button", { hasText: "Add to stop selection" }).click();
    check("Add puts b2 in the selection", (await sel()) === "b2", await sel());
    await rclick("b2");
    m = await menu();
    check("menu now offers Remove from stop selection", m.includes("Remove from stop selection") && !m.includes("Add to stop selection"), m);
    await page.locator("#fp-context-menu button", { hasText: "Remove from stop selection" }).click();
    check("Remove takes b2 out", (await sel()) === "", await sel());

    console.log("\n# Stop CSV export");
    await page.evaluate(() => App.gtfsStops.set(["a2", "b1", "ghost1"]));
    let dl = await download(() => App.gtfsStops.exportCSV());
    check("file name has the ZIP name", /^gtfs-stops-selected-build-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.name), dl.name);
    let rows = parseCSV(dl.text);
    check("header columns", eq(rows[0], ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station", "in_feed", "feed_file"]), rows[0]);
    check("rows: stops.txt order, then missing IDs", eq(rows.slice(1).map((r) => r[0]), ["a2", "b1", "ghost1"]), rows.map((r) => r[0]));
    const ix = rows[0].indexOf("in_feed");
    check("in_feed 1 for feed stops, 0 for the missing one", eq(rows.slice(1).map((r) => r[ix]), ["1", "1", "0"]), rows.slice(1).map((r) => r[ix]));
    check("name with comma and quotes round-trips", rows[2][2] === 'Main, & 1st "Stn"', rows[2]);
    check("feed_file column filled", rows[1][8] === "build.zip", rows[1]);

    console.log("\n# Selected scope (drawn features)");
    await page.evaluate(() => App.setSelection([{ type: "point", index: 1 }]));
    dl = await download(() => App.cache.exportCSV("selected"));
    rows = parseCSV(dl.text);
    check("file name has -selected suffix", /^features-selected-/.test(dl.name), dl.name);
    check("only the selected feature is exported", rows.length === 2 && rows.slice(1).every((r) => r.includes("Point 2")) && !dl.text.includes("Point 1"), dl.text);

    console.log("\n# Import list, then switch feed");
    await page.evaluate(() => App.gtfsStops.clear());
    await page.evaluate(() => {
      const f = new File(["stop_id\na1\na2\nb1\nb4\n"], "list.csv", { type: "text/csv" });
      App.gtfsStops.importFromFile(f);
    });
    await page.waitForFunction("App.gtfsStops.ids().length === 4", { timeout: 5000 });
    check("import replaced the selection", (await sel()) === "a1,a2,b1,b4", await sel());
    await loadFeed("nobuild.zip", ["a1", "b4"]);
    check("selection kept after loading the second feed", (await sel()) === "a1,a2,b1,b4", await sel());
    check("count: 4 total, 2 in feed", eq(await page.evaluate(() => App.gtfsStops.count()), { total: 4, inFeed: 2 }), await page.evaluate(() => App.gtfsStops.count()));
    check("feed file name updated", await page.evaluate(() => App.gtfsStops.feedFileName()) === "nobuild.zip");
    check("highlight filter still lists all 4 IDs", await page.evaluate(() => { const f = JSON.stringify(App.map.getFilter("gtfs-stops-selected")); return ["a1", "a2", "b1", "b4"].every((i) => f.includes('"' + i + '"')); }));
    await page.evaluate(() => { App.map.jumpTo({ center: [-104.8, 38.808], zoom: 15 }); });
    await page.click('.tool-btn[data-mode="box-select"]');
    await setTarget("gtfs-stops");
    check("bar shows '2 not in this feed'", /2 not in this feed/.test(await barText()), await barText());
    dl = await download(() => App.gtfsStops.exportCSV());
    rows = parseCSV(dl.text);
    const ix2 = rows[0].indexOf("in_feed");
    check("export: feed stops first, missing a1,b4 last with in_feed=0",
      eq(rows.slice(1).map((r) => [r[0], r[ix2]]), [["a2", "1"], ["b1", "1"], ["a1", "0"], ["b4", "0"]]), rows);
    check("file name uses the second ZIP", /nobuild/.test(dl.name), dl.name);
    await page.keyboard.press("Escape");

    console.log("\n# Reload restore");
    await page.waitForTimeout(1000); // debounced autosave
    await page.reload({ waitUntil: "load" });
    await ready();
    // The feed itself now comes back too (IndexedDB copy of the last ZIP,
    // js/core/gtfs-store.js): the last one loaded was nobuild.zip.
    await page.waitForFunction("App.gtfsStops.isAvailable().ok && App.map.getLayer('gtfs-stops-selected')", { timeout: 15000 });
    check("selection restored", (await sel()) === "a1,a2,b1,b4", await sel());
    check("last-loaded feed restored: 4 selected, 2 in it", eq(await page.evaluate(() => App.gtfsStops.count()), { total: 4, inFeed: 2 }), await page.evaluate(() => App.gtfsStops.count()));
    check("restored feed name is the last one loaded", await page.evaluate(() => App.gtfsStops.feedFileName()) === "nobuild.zip");
    await page.evaluate(() => App.map.jumpTo({ center: [-104.8, 38.808], zoom: 15 }));
    await loadFeed("build.zip", []);
    check("selection reappears once the other feed loads (highlight + counts)", (await sel()) === "a1,a2,b1,b4" &&
      eq(await page.evaluate(() => App.gtfsStops.count()), { total: 4, inFeed: 4 }) &&
      await page.evaluate(() => JSON.stringify(App.map.getFilter("gtfs-stops-selected")).includes('"b4"')));

    console.log("\n# Clear GTFS clears the selection");
    await page.evaluate(() => App.clearGTFS());
    check("clearGTFS empties the stop selection and removes layers", (await sel()) === "" && await page.evaluate(() => !App.map.getLayer("gtfs-stops-layer") && !App.map.getLayer("gtfs-stops-selected")));
    await loadFeed("build.zip", []);
    check("new feed starts with no selection", (await sel()) === "");

    console.log("\n# Escape exits the tool; map still pans");
    await page.click('.tool-btn[data-mode="box-select"]');
    check("bar shown", await page.evaluate(() => !document.querySelector(".box-select-bar").hidden));
    await page.keyboard.press("Escape");
    check("Escape: tool off, bar hidden", await page.evaluate(() => App.drawMode === null && document.querySelector(".box-select-bar").hidden));
    const before = await page.evaluate(() => App.map.getCenter().toArray());
    await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(800, 500, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(200);
    check("map pans normally", !eq(await page.evaluate(() => App.map.getCenter().toArray()), before));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
