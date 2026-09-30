#!/usr/bin/env node
// test/feature-merge-smoke.mjs
//
// Browser smoke test for the Feature Merge work (docs/feature-merge-plan.md).
// Loads the real app, drives window.App through page.evaluate, and asserts.
// Phase 1 covers unique, stable per-type feature IDs. Later phases append
// more `await check(...)` groups in the "ASSERTIONS" section below.
//
// USAGE (Playwright is not an npm dependency of this repo — see
// test/ui-screens/capture.mjs for the one-time install):
//   NODE_PATH=/path/to/playwright/node_modules node test/feature-merge-smoke.mjs
//
// Same approach as capture.mjs: the CDN libraries are served from
// test/ui-screens/vendor/ via route interception, everything else remote is
// aborted (so street-snapped routing falls back to a straight line between
// waypoints — fine for ID tests). Prints PASS/FAIL per assertion; exits
// non-zero if any fail.

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
const allUnique = (arr) => new Set(arr).size === arr.length;

// ---- Page helpers (run inside the browser) ----

// Draw a route through the real click handlers (OSRM is blocked, so the
// geometry falls back to the straight waypoint line).
async function drawRoute(page, a, b) {
  await page.evaluate(async ([a, b]) => {
    App.handleRouteClick({ lng: a[0], lat: a[1] });
    await App.handleRouteClick({ lng: b[0], lat: b[1] });
    await App.saveRoute();
  }, [a, b]);
}

const routeIds = (page) => page.evaluate(() => App.routes.map((r) => r.properties.routeIdx));

// ---- Main ----

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
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache", { timeout: 30000 });
    // Start every run from a clean slate.
    await page.evaluate(() => App.cache.reset && App.cache.reset());
    await page.waitForFunction("App.routes.length === 0");

    // ================= ASSERTIONS =================

    // ---- Phase 1: unique, stable feature IDs ----
    console.log("\n# Phase 1 - feature IDs");

    // 1. Draw 3 routes, delete the first, add another: IDs stay unique.
    await drawRoute(page, [-104.80, 38.83], [-104.79, 38.84]);
    await drawRoute(page, [-104.78, 38.83], [-104.77, 38.84]);
    await drawRoute(page, [-104.76, 38.83], [-104.75, 38.84]);
    let ids = await routeIds(page);
    check("3 routes drawn have unique routeIdx", ids.length === 3 && allUnique(ids), ids);
    await page.evaluate(() => App.removeRoute(0));
    await drawRoute(page, [-104.74, 38.83], [-104.73, 38.84]);
    ids = await routeIds(page);
    check("after delete-first + add, routeIdx still unique", ids.length === 3 && allUnique(ids), ids);
    check("a deleted ID is never reused", !ids.slice(0, 2).includes(1) && ids[2] > 3, ids);
    const names = await page.evaluate(() => App.routes.map((r) => r.properties.name));
    check("default names keep the old length+1 scheme", names[2] === "Route 3", names);

    // 2. Every type hands out unique IDs across add/delete/duplicate.
    const others = await page.evaluate(() => {
      App.addPoint(-104.8, 38.8); App.addPoint(-104.81, 38.8); App.removePoint(0); App.addPoint(-104.82, 38.8);
      App.duplicatePoint(0);
      App.addLineFromCoords([[-104.8, 38.7], [-104.7, 38.7]]); App.addLineFromCoords([[-104.8, 38.6], [-104.7, 38.6]]);
      App.removeLine(0); App.addLineFromCoords([[-104.8, 38.5], [-104.7, 38.5]]);
      App.duplicateLine(0); App.duplicateRoute(0);
      var seqs = function (arr) { return arr.map(function (f) { return f.properties.colorSeq; }); };
      return {
        point: App.points.map((f) => f.properties.pointIdx),
        line: App.lines.map((f) => f.properties.lineIdx),
        route: App.routes.map((f) => f.properties.routeIdx),
        lineSeq: seqs(App.lines), routeSeq: seqs(App.routes)
      };
    });
    check("point IDs unique (add/delete/duplicate)", allUnique(others.point), others.point);
    check("line IDs unique (add/delete/duplicate)", allUnique(others.line), others.line);
    check("route IDs unique after duplicateRoute", allUnique(others.route), others.route);
    check("duplicated line/route get their own colorSeq", allUnique(others.lineSeq) && allUnique(others.routeSeq) &&
      others.lineSeq.every((s) => typeof s === "number") && others.routeSeq.every((s) => typeof s === "number"), others);

    // 3. Restoring a session with duplicate / missing / non-numeric IDs repairs them.
    const restored = await page.evaluate(() => {
      var st = App.cache.collectState("full");
      var mk = (name, id, prop) => { var p = { name: name }; if (id !== undefined) p[prop] = id; return p; };
      st.routes = [0, 1, 2, 3].map((i) => ({ type: "Feature", properties: mk("R" + i, [1, 1, undefined, "x"][i], "routeIdx"),
        geometry: { type: "LineString", coordinates: [[-104.9 + i * 0.01, 38.9], [-104.89 + i * 0.01, 38.91]] } }));
      st.points = [{ type: "Feature", properties: { name: "P0", pointIdx: 5 }, geometry: { type: "Point", coordinates: [-104.9, 38.9] } },
                   { type: "Feature", properties: { name: "P1", pointIdx: 5 }, geometry: { type: "Point", coordinates: [-104.91, 38.9] } }];
      App.cache.applyState(st);
      var fresh = App.nextFeatureId("route");
      return { route: App.routes.map((f) => f.properties.routeIdx), point: App.points.map((f) => f.properties.pointIdx), fresh: fresh };
    });
    check("restored duplicate/missing/non-numeric route IDs become unique", allUnique(restored.route) && restored.route.every((n) => Number.isInteger(n) && n >= 1), restored.route);
    check("older duplicate keeps its ID (first occurrence wins)", restored.route[0] === 1 && restored.point[0] === 5, restored);
    check("restored duplicate point IDs become unique", allUnique(restored.point), restored.point);
    check("counter advanced past every restored ID", restored.fresh > Math.max(...restored.route), restored);

    // 4. Already-unique IDs are not renumbered by applyState (undo/redo path).
    const stable = await page.evaluate(() => {
      var before = App.routes.map((f) => f.properties.routeIdx);
      App.cache.applyState(JSON.parse(JSON.stringify(App.cache.collectState("full"))));
      return { before: before, after: App.routes.map((f) => f.properties.routeIdx), changes: App.ensureFeatureIds() };
    });
    check("re-applying unique IDs changes nothing", JSON.stringify(stable.before) === JSON.stringify(stable.after) && stable.changes.length === 0, stable);

    // 5. Real undo: delete a route, undo, IDs identical; new route does not collide.
    const undo = await page.evaluate(async () => {
      var before = App.routes.map((f) => f.properties.routeIdx);
      App.removeRoute(1);
      App.undo.undo();
      return { before: before, after: App.routes.map((f) => f.properties.routeIdx) };
    });
    check("delete then Ctrl+Z restores the same route IDs", JSON.stringify(undo.before) === JSON.stringify(undo.after), undo);
    await drawRoute(page, [-104.6, 38.83], [-104.59, 38.84]);
    ids = await routeIds(page);
    check("route drawn after undo gets a non-colliding ID", allUnique(ids), ids);

    // 6. Click resolution (editing.js findRouteIndexByProp semantics): every
    // route buffer/vertex carries its route's ID, and that ID matches exactly
    // one route, so a clicked map feature maps to one unambiguous index.
    const resolve = await page.evaluate(() => {
      App.rebuildRouteBuffers && App.rebuildRouteBuffers(0.5);
      return App.routes.map(function (r, i) {
        var id = r.properties.routeIdx;
        var matches = []; App.routes.forEach(function (x, k) { if (x.properties.routeIdx == id) matches.push(k); });
        var buf = App.routeBuffers[i];
        return { i: i, matches: matches, bufferId: buf && buf.properties.routeIdx, id: id };
      });
    });
    check("each route ID resolves to exactly its own array index",
      resolve.every((x) => x.matches.length === 1 && x.matches[0] === x.i), resolve);
    check("route buffers carry the route's ID", resolve.every((x) => x.bufferId === x.id), resolve);

    // ================= END ASSERTIONS =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
