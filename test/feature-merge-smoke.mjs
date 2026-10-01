#!/usr/bin/env node
// test/feature-merge-smoke.mjs
//
// Browser smoke test for the Feature Merge work (docs/feature-merge-plan.md).
// Loads the real app, drives window.App through page.evaluate, and asserts.
// Phase 1 covers unique, stable per-type feature IDs; Phase 2 covers the merge
// engine, dialog, polygons and lines (including a pass through the real UI:
// Ctrl+click rows, right-click, dialog, Escape/Merge); Phase 3 covers routes
// (street-routed connectors via a mocked OSRM), points and line + route;
// Phase 4a covers Unmerge (history recorded on the survivor, exact restore for
// every merge kind, nested history, edited-since warning, best-effort stop
// reversal, reload persistence, exports omitting `_mergedFrom`).
// Phase 4b-1 covers module references by stable ID (Route Costing, Trip Builder,
// Title VI: survive delete/merge of earlier features, reload, legacy index sessions).
// Phase 4b-2 does the same for TPI, Ridership Forecasting, Corridor Scoring,
// Transit Coverage and Feature Area Analysis (checklists, corridor dropdowns,
// restored per-route results, legacy index sessions).
// Later phases append
// more `await check(...)` groups in the "ASSERTIONS" section below.
// Screenshots of the dialog are written to $MERGE_SHOT_DIR (default: os tmpdir).
//
// USAGE (Playwright is not an npm dependency of this repo — see
// test/ui-screens/capture.mjs for the one-time install):
//   NODE_PATH=/path/to/playwright/node_modules node test/feature-merge-smoke.mjs
//
// Same approach as capture.mjs: the CDN libraries are served from
// test/ui-screens/vendor/ via route interception, everything else remote is
// aborted (so street-snapped routing falls back to a straight line between
// waypoints — fine for ID tests). Phase 3 installs a page-level handler for the
// OSRM demo server (fake geometry / failure / held-open) to test connector routing. Prints PASS/FAIL per assertion; exits
// non-zero if any fail.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import os from "node:os";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const VENDOR_DIR = join(HERE, "ui-screens", "vendor");
const SHOT_DIR = process.env.MERGE_SHOT_DIR || os.tmpdir();

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


// Replace every drawn feature with a controlled fixture (routes are cleared).
// fx = { lines: [{name, id, coords, attrs}], polygons: [...], points: [...] }
async function setFixture(page, fx) {
  await page.evaluate((fx) => {
    var st = App.cache.collectState("full");
    st.labels = st.labels || [];
    // routes: [{name, id, coords, waypoints, attrs, color, props}] (props = extra properties such as _opacity)
    st.routes = (fx.routes || []).map((r) => ({ type: "Feature",
      properties: Object.assign({ name: r.name, routeIdx: r.id, waypoints: r.waypoints || [r.coords[0], r.coords[r.coords.length - 1]],
        color: r.color || "", attributes: r.attrs || {} }, r.props || {}),
      geometry: { type: "LineString", coordinates: r.coords } }));
    st.lines = (fx.lines || []).map((l) => ({ type: "Feature",
      properties: { name: l.name, lineIdx: l.id, waypoints: l.coords.length, color: l.color || "", attributes: l.attrs || {} },
      geometry: { type: "LineString", coordinates: l.coords } }));
    st.polygons = (fx.polygons || []).map((p) => ({ type: "Feature",
      properties: { name: p.name, polyIdx: p.id, vertices: p.rings[0].length - 1, color: "", attributes: p.attrs || {} },
      geometry: { type: "Polygon", coordinates: p.rings } }));
    st.points = (fx.points || []).map((p) => ({ type: "Feature",
      properties: { name: p.name, pointIdx: p.id, color: "", attributes: Object.assign({ associatedRoutes: p.refs || [] }, p.attrs || {}) },
      geometry: { type: "Point", coordinates: p.at } }));
    App.cache.applyState(st);
  }, fx);
}
const square = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const snapshot = (page) => page.evaluate(() => JSON.stringify({ l: App.lines, r: App.routes, p: App.polygons, pt: App.points }));

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
    // OSRM mock (Phase 3). Modes: "fail" (abort, default), "ok" (a fake detour via
    // a midpoint nudged 0.002 deg north), "hang" (hold the response until osrm.release()).
    const osrm = { mode: "fail", hits: [], gate: null, release: null };
    osrm.hold = () => { osrm.gate = new Promise((r) => { osrm.release = r; }); };
    await page.route("https://router.project-osrm.org/**", async (route) => {
      osrm.hits.push(route.request().url());
      if (osrm.mode === "hang") await osrm.gate;
      if (osrm.mode === "fail") return route.abort();
      const m = /driving\/([^?]+)/.exec(route.request().url());
      const pts = decodeURIComponent(m[1]).split(";").map((p) => p.split(",").map(Number));
      const a = pts[0], b = pts[pts.length - 1];
      const geometry = { type: "LineString", coordinates: [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.002], b] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "Ok", routes: [{ geometry }] }) });
    });
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

    // 7. Counters survive a page reload: delete the highest-ID route, reload,
    // draw a new route — the deleted ID must not be reissued.
    const deletedId = await page.evaluate(async () => {
      var maxI = 0;
      App.routes.forEach(function (r, i) { if (r.properties.routeIdx > App.routes[maxI].properties.routeIdx) maxI = i; });
      var id = App.routes[maxI].properties.routeIdx;
      App.removeRoute(maxI);
      App.cache.save();
      await new Promise((r) => setTimeout(r, 800)); // save is debounced
      return id;
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && App.routes.length > 0", { timeout: 30000 });
    await drawRoute(page, [-104.5, 38.83], [-104.49, 38.84]);
    ids = await routeIds(page);
    check("deleted ID is not reissued after a page reload", !ids.includes(deletedId) && allUnique(ids), { deletedId, ids });

    // ---- Phase 2: merge engine, dialog, polygons and lines ----
    console.log("\n# Phase 2 - merge (lines + polygons)");

    check("App.merge / mergeGeom / mergeAttrs are exposed",
      await page.evaluate(() => !!(App.merge && App.merge.run && App.mergeGeom && App.mergeAttrs)));

    // -- Polygons --
    const P1 = square(-104.80, 38.80, 0.01, 0.01), P2 = square(-104.79, 38.80, 0.01, 0.01), P3 = square(-104.60, 38.70, 0.01, 0.01);
    await setFixture(page, { polygons: [
      { name: "Poly A", id: 21, rings: [P1], attrs: { notes: "west" } }, { name: "Poly B", id: 22, rings: [P2], attrs: { notes: "east" } },
      { name: "Poly C", id: 23, rings: [P3] } ] });
    let before = await snapshot(page);
    let res = await page.evaluate(() => App.merge.run("polygon", [0, 2], 0));
    check("separate polygons: merge is blocked (MultiPolygon)", res.ok === false && /touch or overlap/.test(res.errors.join(" ")), res);
    check("blocked merge changes nothing", (await snapshot(page)) === before);

    res = await page.evaluate(() => App.merge.run("polygon", [0, 1], 0));
    let poly = await page.evaluate(() => ({ n: App.polygons.length, name: App.polygons[0].properties.name, id: App.polygons[0].properties.polyIdx,
      type: App.polygons[0].geometry.type, rings: App.polygons[0].geometry.coordinates.length,
      ringLen: App.polygons[0].geometry.coordinates[0].length, vertices: App.polygons[0].properties.vertices,
      notes: App.polygons[0].properties.attributes.notes, names: App.polygons.map((p) => p.properties.name) }));
    check("touching polygons merge into one Polygon", res.ok && poly.n === 2 && poly.type === "Polygon" && poly.rings === 1, { res, poly });
    check("polygon survivor keeps name and ID", poly.name === "Poly A" && poly.id === 21 && poly.names[1] === "Poly C", poly);
    check("polygon vertices property recomputed from the ring", poly.vertices === poly.ringLen - 1 && poly.vertices >= 4, poly);
    check("polygon notes joined", poly.notes === "west\neast", poly);
    await page.evaluate(() => App.undo.undo());
    check("single Ctrl+Z restores both polygons exactly", (await snapshot(page)) === before);

    // holes are dropped: a square-with-hole unioned with a neighbour
    await setFixture(page, { polygons: [
      { name: "Donut", id: 31, rings: [square(-104.80, 38.80, 0.03, 0.03), square(-104.79, 38.81, 0.01, 0.01).reverse()] },
      { name: "Next", id: 32, rings: [square(-104.77, 38.80, 0.01, 0.03)] } ] });
    const plan = await page.evaluate(() => App.merge.analyze("polygon", [0, 1], 0));
    check("hole is reported as filled", plan.ok && plan.summary.some((t) => /Enclosed gaps will be filled/.test(t)), plan);
    await page.evaluate(() => App.merge.run("polygon", [0, 1], 0));
    check("merged polygon has no interior rings", await page.evaluate(() => App.polygons.length === 1 && App.polygons[0].geometry.coordinates.length === 1));

    // -- Lines --
    // X(out of order, reversed) Y(primary, middle of array) Z, plus untouched W.
    const Y = [[-104.80, 38.80], [-104.79, 38.80]];                         // west piece
    const Zl = [[-104.78, 38.80], [-104.79, 38.80]];                        // stored reversed, touches Y's end
    const X = [[-104.78, 38.80], [-104.77, 38.80], [-104.77, 38.81]];       // continues Zl's first vertex
    const W = [[-104.50, 38.50], [-104.49, 38.50]];
    const lineFx = () => ({
      lines: [
        { name: "Line X", id: 11, coords: X, attrs: { mode: "BRT", direction: "NB", notes: "x", runTime: 10 } },
        { name: "Line Y", id: 12, coords: Y, attrs: { mode: "", direction: "NB", group: "G", runTime: 20, avgSpeed: 10 } },
        { name: "Line Z", id: 13, coords: Zl, attrs: { mode: "Bus", direction: "SB", runTime: 5 } },
        { name: "Line W", id: 14, coords: W, attrs: {} } ],
      points: [
        { name: "Stop 1", id: 41, at: [-104.79, 38.80], refs: [{ featureType: "line", featureId: 11, name: "Line X" }, { featureType: "line", featureId: 12, name: "Line Y" }] },
        { name: "Stop 2", id: 42, at: [-104.78, 38.80], refs: [{ featureType: "line", featureId: 13, name: "Line Z" }] },
        { name: "Stop 3", id: 43, at: [-104.50, 38.50], refs: [{ featureType: "line", featureId: 14, name: "Line W" }] } ]
    });
    await setFixture(page, lineFx());
    before = await snapshot(page);
    const lplan = await page.evaluate(() => App.merge.analyze("line", [0, 1, 2], 1));
    check("3 lines (one reversed, out of order) chain without errors", lplan.ok && lplan.errors.length === 0, lplan);
    check("plan reports 2 stops to re-link", lplan.stopsRepointed === 2, lplan.stopsRepointed);
    check("plan warns about different directions", lplan.warnings.some((w) => /different directions/.test(w)), lplan.warnings);
    check("plan lists discarded mode/direction values", lplan.discarded.some((d) => d.key === "mode" ) && lplan.discarded.some((d) => d.key === "direction"), lplan.discarded);
    res = await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    const ln = await page.evaluate(() => ({
      n: App.lines.length, names: App.lines.map((l) => l.properties.name),
      coords: App.lines[0].geometry.coordinates, waypoints: App.lines[0].properties.waypoints,
      id: App.lines[0].properties.lineIdx, attrs: App.lines[0].properties.attributes,
      sel: App.getSelectedFeatures(), buf: App.lineBuffers.length,
      stops: App.points.map((p) => p.properties.attributes.associatedRoutes.map((r) => r.featureId + ":" + r.name)) }));
    check("merge ok; survivor is the primary (Line Y) at its new array index 0", res.ok && ln.n === 2 && ln.names[0] === "Line Y" && ln.names[1] === "Line W" && res.survivorIndex === 0, { res, ln });
    check("chained coordinates run end to end in order",
      JSON.stringify(ln.coords) === JSON.stringify([[-104.80, 38.80], [-104.79, 38.80], [-104.78, 38.80], [-104.77, 38.80], [-104.77, 38.81]]), ln.coords);
    check("waypoints property = vertex count", ln.waypoints === 5, ln.waypoints);
    check("survivor keeps its ID; attributes: primary wins, blanks filled", ln.id === 12 && ln.attrs.direction === "NB" && ln.attrs.mode === "BRT" && ln.attrs.group === "G" && ln.attrs.notes === "x", ln.attrs);
    check("runTime summed (every line had one)", ln.attrs.runTime === 35, ln.attrs);
    check("avgSpeed left alone when only one line had it", ln.attrs.avgSpeed === 10, ln.attrs);
    check("stops re-linked to the survivor and de-duplicated",
      JSON.stringify(ln.stops) === JSON.stringify([["12:Line Y"], ["12:Line Y"], ["14:Line W"]]), ln.stops);
    check("survivor is selected; buffers rebuilt for remaining lines", ln.sel.length === 1 && ln.sel[0].type === "line" && ln.sel[0].index === 0 && ln.buf === 2, ln);
    await page.evaluate(() => App.undo.undo());
    check("single Ctrl+Z restores lines, stops and IDs exactly", (await snapshot(page)) === before);

    // branch is blocked
    await setFixture(page, { lines: [
      { name: "Trunk", id: 51, coords: [[-104.80, 38.80], [-104.78, 38.80]] },
      { name: "Spur", id: 52, coords: [[-104.79, 38.80], [-104.79, 38.81]] } ] });
    res = await page.evaluate(() => App.merge.run("line", [0, 1], 0));
    check("a T-junction selection is blocked", res.ok === false && /branch/.test(res.errors.join(" ")), res);

    // long connector warns but still merges; selection eligibility
    await setFixture(page, { lines: [
      { name: "Near", id: 61, coords: [[-104.80, 38.80], [-104.79, 38.80]] },
      { name: "Far", id: 62, coords: [[-104.70, 38.80], [-104.69, 38.80]] } ], polygons: [{ name: "Sq", id: 63, rings: [P1] }] });
    const far = await page.evaluate(() => App.merge.analyze("line", [0, 1], 0));
    check("long connector is a warning, not an error", far.ok && far.warnings.some((w) => /mi\. Check/.test(w)), far);
    check("mergeableSelection: lines ok, mixed/single/labels rejected", await page.evaluate(() =>
      !!App.merge.mergeableSelection([{ type: "line", index: 0 }, { type: "line", index: 1 }]) &&
      !App.merge.mergeableSelection([{ type: "line", index: 0 }, { type: "polygon", index: 0 }]) &&
      !App.merge.mergeableSelection([{ type: "line", index: 0 }]) &&
      !App.merge.mergeableSelection([{ type: "label", index: 0 }, { type: "label", index: 1 }])));
    check("Copy Attributes' has-value helper still behaves as before", await page.evaluate(() =>
      App.mergeAttrs.fieldHasValue("text", "") === false && App.mergeAttrs.fieldHasValue("number", 0) === true));

    // -- Real UI: Ctrl+click rows, right-click, dialog --
    console.log("\n# Phase 2 - UI walkthrough");
    await setFixture(page, { lines: [
      { name: "Line Alpha", id: 71, coords: [[-104.80, 38.80], [-104.79, 38.80]], attrs: { mode: "Bus", direction: "NB", serviceId: "Blue", notes: "from alpha" } },
      { name: "Line Beta", id: 72, coords: [[-104.78, 38.80], [-104.79, 38.80]], attrs: { mode: "BRT", direction: "SB", serviceId: "Blue" } },
      { name: "Line Gamma", id: 73, coords: [[-104.78, 38.80], [-104.77, 38.80]] } ] });
    const row = (name) => page.locator("#fp-tab-features .fp-item", { hasText: name }).first();
    await row("Line Alpha").click();
    await row("Line Beta").click({ modifiers: ["Control"] });
    check("Ctrl+click multi-selects two lines", await page.evaluate(() => App.getSelectedFeatures().length === 2));
    await row("Line Beta").click({ button: "right" });
    const menuTexts = await page.locator("#fp-context-menu button").allTextContents();
    check("right-click menu offers Merge…", menuTexts.some((t) => t.trim() === "Merge…"), menuTexts);
    await page.locator("#fp-context-menu button", { hasText: "Merge" }).click();
    await page.waitForSelector(".fm-dialog", { timeout: 3000 });
    check("dialog title counts the features", (await page.locator("#fmTitle").textContent()) === "Merge 2 Lines");
    check("right-clicked feature is the default primary", await page.evaluate(() => document.querySelector('.fm-dialog input[name="fmPrimary"]:checked').closest("label").textContent.trim() === "Line Beta"));
    const discardText = await page.locator(".fm-dialog .fm-section:has(.fm-section-title:text('Will be discarded'))").textContent();
    check("discard list shows the lost values", /Mode: Bus/.test(discardText) && /Direction: NB/.test(discardText), discardText);
    const warnText = await page.locator(".fm-note-warn").textContent();
    check("warnings render (same Service + different directions)", /same Service/.test(warnText) && /different directions/.test(warnText), warnText);
    check("Merge button enabled and focused", await page.evaluate(() => { var b = document.activeElement; return b && b.textContent === "Merge" && !b.disabled; }));
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-light.png") });
    // switching the primary recomputes the discard list live
    await page.locator('.fm-dialog input[name="fmPrimary"]').first().check();
    await page.waitForFunction(() => /Mode: BRT/.test(document.querySelector(".fm-dialog").textContent));
    check("changing the primary recomputes the discarded list", /Mode: BRT/.test(await page.locator(".fm-dialog").textContent()));
    await page.keyboard.press("Escape");
    check("Escape closes the dialog without merging", await page.evaluate(() => !document.querySelector(".fm-dialog") && App.lines.length === 3));
    // dark mode + narrow screenshots
    await row("Line Beta").click({ button: "right" });
    await page.locator("#fp-context-menu button", { hasText: "Merge" }).click();
    await page.waitForSelector(".fm-dialog");
    await page.keyboard.press("Escape");
    await page.click("#darkmode-btn");
    await page.waitForFunction("document.body.classList.contains('dark-mode')");
    await page.evaluate(() => App.merge.openDialog("line", [0, 1], 1));
    await page.waitForSelector(".fm-dialog .fm-note-warn");
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-dark.png") });
    await page.setViewportSize({ width: 390, height: 780 });
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-dark-narrow.png") });
    check("dialog fits a phone-width viewport (no horizontal overflow of its own)", await page.evaluate(() => {
      var d = document.querySelector(".fm-dialog"), r = d.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth && d.scrollWidth <= d.clientWidth;
    }));
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.keyboard.press("Escape");
    await page.click("#darkmode-btn");
    await page.waitForFunction("!document.body.classList.contains('dark-mode')");
    // blocked dialog (separate polygons): red error, Merge disabled
    await setFixture(page, { polygons: [{ name: "Sq 1", id: 81, rings: [P1] }, { name: "Sq 2", id: 82, rings: [P3] }] });
    await page.evaluate(() => App.merge.openDialog("polygon", [0, 1], 0));
    await page.waitForSelector(".fm-note-error");
    check("blocked dialog: error shown, Merge disabled, Cancel focused", await page.evaluate(() => {
      var btns = document.querySelectorAll(".fm-dialog .rf-weights-modal-actions button");
      return btns[1].disabled && document.activeElement === btns[0];
    }));
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-blocked.png") });
    await page.keyboard.press("Escape");
    // complete the real thing: select, open, click Merge
    await setFixture(page, { lines: [
      { name: "Line Alpha", id: 71, coords: [[-104.80, 38.80], [-104.79, 38.80]], attrs: { mode: "Bus" } },
      { name: "Line Beta", id: 72, coords: [[-104.78, 38.80], [-104.79, 38.80]], attrs: { mode: "BRT" } } ] });
    await row("Line Alpha").click();
    await row("Line Beta").click({ modifiers: ["Shift"] });
    await row("Line Alpha").click({ button: "right" });
    await page.locator("#fp-context-menu button", { hasText: "Merge" }).click();
    await page.waitForSelector(".fm-dialog");
    await page.locator(".fm-dialog .rf-action-primary").click();
    await page.waitForFunction(() => !document.querySelector(".fm-dialog"));
    const done = await page.evaluate(() => ({ n: App.lines.length, name: App.lines[0].properties.name, verts: App.lines[0].geometry.coordinates.length,
      status: (document.getElementById("status") || {}).textContent || "" }));
    check("clicking Merge in the dialog merges and closes it", done.n === 1 && done.name === "Line Alpha" && done.verts === 3, done);
    check("Merge… is not offered for a single feature", await (async () => {
      await row("Line Alpha").click({ button: "right" });
      const t = await page.locator("#fp-context-menu button").allTextContents();
      await page.keyboard.press("Escape"); await page.mouse.click(5, 5);
      return !t.some((x) => /Merge/.test(x));
    })());

    // ================= Phase 3 - routes, points, line + route =================
    console.log("\n# Phase 3 - routes, points, line + route");
    // Count undo snapshots so "exactly one (and none when cancelled)" is checkable.
    await page.evaluate(() => { window.__pushes = 0; var o = App.undo.push; App.undo.push = function () { window.__pushes++; return o.apply(this, arguments); }; });
    const pushes = () => page.evaluate(() => window.__pushes);
    const ROUTE_A = [[-104.80, 38.80], [-104.79, 38.80]];
    const ROUTE_B = [[-104.787, 38.80], [-104.777, 38.80]];      // ~0.16 mi east of A's end
    const routeFx = () => ({
      routes: [
        { name: "Route A", id: 21, coords: ROUTE_A, waypoints: ROUTE_A, attrs: { mode: "Bus", direction: "EB", runTime: 10 } },
        { name: "Route B", id: 22, coords: ROUTE_B, waypoints: ROUTE_B, attrs: { direction: "EB", runTime: 8 } },
        { name: "Route C", id: 23, coords: [[-104.50, 38.50], [-104.49, 38.50]], attrs: {} } ],
      points: [
        { name: "Stop 1", id: 41, at: [-104.78, 38.80], refs: [{ featureType: "route", featureId: 22, name: "Route B" }] },
        { name: "Stop 2", id: 42, at: [-104.79, 38.80], refs: [{ featureType: "route", featureId: 21, name: "Route A" }, { featureType: "route", featureId: 22, name: "Route B" }] },
        { name: "Stop 3", id: 43, at: [-104.50, 38.50], refs: [{ featureType: "route", featureId: 23, name: "Route C" }] } ]
    });
    const dump = (page) => page.evaluate(() => ({
      nR: App.routes.length, nL: App.lines.length, nP: App.points.length,
      routeNames: App.routes.map((r) => r.properties.name), lineNames: App.lines.map((l) => l.properties.name),
      pointNames: App.points.map((p) => p.properties.name),
      sel: App.getSelectedFeatures(),
      stops: App.points.map((p) => ((p.properties.attributes || {}).associatedRoutes || []).map((r) => r.featureType + ":" + r.featureId + ":" + r.name)),
      status: (document.getElementById("status") || {}).textContent || ""
    }));

    // -- selection eligibility --
    check("mergeableSelection: routes, points, line+route ok; point+line, route+polygon, label+line rejected", await page.evaluate(() => {
      var m = App.merge.mergeableSelection;
      return m([{ type: "route", index: 0 }, { type: "route", index: 1 }]).type === "route" &&
        m([{ type: "point", index: 0 }, { type: "point", index: 1 }]).type === "point" &&
        m([{ type: "line", index: 0 }, { type: "route", index: 0 }]).type === "linemix" &&
        m([{ type: "route", index: 0 }, { type: "line", index: 0 }, { type: "route", index: 1 }]).indices.length === 3 &&
        !m([{ type: "point", index: 0 }, { type: "line", index: 0 }]) &&
        !m([{ type: "route", index: 0 }, { type: "polygon", index: 0 }]) &&
        !m([{ type: "label", index: 0 }, { type: "line", index: 0 }]) &&
        !m([{ type: "line", index: 0 }, { type: "route", index: 0 }, { type: "point", index: 0 }]);
    }));

    // -- Routes: gap street-routed through the (mocked) router --
    osrm.mode = "ok"; osrm.hits.length = 0;
    await setFixture(page, routeFx());
    before = await snapshot(page);
    const rplan = await page.evaluate(() => {
      const p = App.merge.analyze("route", [0, 1], 0);
      return { ok: p.ok, errors: p.errors, warnings: p.warnings, summary: p.summary, gaps: p.routingGaps, hasPrepare: typeof p.prepare === "function", stops: p.stopsRepointed };
    });
    check("route analyze is cheap: ok, one gap to route, no network request made",
      rplan.ok && rplan.gaps === 1 && rplan.hasPrepare && osrm.hits.length === 0 && rplan.summary.some((t) => /will be street-routed/.test(t)), { rplan, hits: osrm.hits.length });
    check("route plan reports the stops to re-link", rplan.stops === 2, rplan.stops);
    let p0 = await pushes();
    res = await page.evaluate(() => App.merge.run("route", [0, 1], 0));
    let rm = await dump(page);
    const rgeo = await page.evaluate(() => ({ c: App.routes[0].geometry.coordinates, w: App.routes[0].properties.waypoints, id: App.routes[0].properties.routeIdx, a: App.routes[0].properties.attributes }));
    check("route merge ok; survivor is Route A (primary) and the other routes are untouched", res.ok && rm.nR === 2 && rm.routeNames[0] === "Route A" && rm.routeNames[1] === "Route C" && rgeo.id === 21, { res, rm });
    check("connector was street-routed through the router exactly once", osrm.hits.length === 1 && res.routing && res.routing.routed === 1 && res.routing.failed === 0 && /street-routed/.test(res.message), { hits: osrm.hits, routing: res.routing });
    check("geometry = A + routed detour + B (5 vertices, joins de-duplicated)",
      rgeo.c.length === 5 && rgeo.c[2][1] > 38.801 && JSON.stringify(rgeo.c[0]) === JSON.stringify(ROUTE_A[0]) && JSON.stringify(rgeo.c[4]) === JSON.stringify(ROUTE_B[1]), rgeo.c);
    check("waypoints concatenated in order (4), ready for re-routing", JSON.stringify(rgeo.w) === JSON.stringify([ROUTE_A[0], ROUTE_A[1], ROUTE_B[0], ROUTE_B[1]]), rgeo.w);
    check("runTime summed, primary direction kept", rgeo.a.runTime === 18 && rgeo.a.direction === "EB" && rgeo.a.mode === "Bus", rgeo.a);
    check("stops re-linked to the surviving route and de-duplicated",
      JSON.stringify(rm.stops) === JSON.stringify([["route:21:Route A"], ["route:21:Route A"], ["route:23:Route C"]]), rm.stops);
    check("survivor selected; exactly ONE undo snapshot taken", rm.sel.length === 1 && rm.sel[0].type === "route" && rm.sel[0].index === 0 && (await pushes()) - p0 === 1, { sel: rm.sel });
    await page.evaluate(() => App.undo.undo());
    check("single Ctrl+Z restores routes, stops and IDs exactly", (await snapshot(page)) === before);

    // -- Routes: routing unavailable falls back to a straight connector --
    osrm.mode = "fail"; osrm.hits.length = 0;
    res = await page.evaluate(() => App.merge.run("route", [0, 1], 0));
    const fb = await page.evaluate(() => ({ c: App.routes[0].geometry.coordinates, w: App.routes[0].properties.waypoints.length, status: (document.getElementById("status") || {}).textContent || "" }));
    check("routing failure still merges, with a straight connector (4 vertices)", res.ok && fb.c.length === 4 && fb.w === 4, { res, fb });
    check("failure is reported in the status message", res.routing.failed === 1 && /could not be street-routed/.test(res.message) && /could not be street-routed/.test(fb.status), { msg: res.message, status: fb.status });
    await page.evaluate(() => App.undo.undo());

    // -- Routes: touching join does not duplicate a waypoint; reversed directional segment warns --
    osrm.mode = "ok"; osrm.hits.length = 0;
    await setFixture(page, { routes: [
      { name: "Route East", id: 31, coords: [[-104.80, 38.80], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.795, 38.80], [-104.79, 38.80]], attrs: { direction: "EB" } },
      { name: "Route West", id: 32, coords: [[-104.78, 38.80], [-104.79, 38.80]], waypoints: [[-104.78, 38.80], [-104.79, 38.80]], attrs: { direction: "WB" } } ] });
    before = await snapshot(page);
    const tplan = await page.evaluate(() => { const p = App.merge.analyze("route", [0, 1], 0); return { ok: p.ok, warnings: p.warnings, prepare: typeof p.prepare, summary: p.summary }; });
    check("touching routes need no routing", tplan.ok && tplan.prepare !== "function", tplan);
    check("reversed directional route warns: names it and says direction is flipped",
      tplan.warnings.some((w) => /Route West/.test(w) && /WB/.test(w) && /flipped/.test(w)), tplan.warnings);
    check("the un-reversed directional route does not warn", !tplan.warnings.some((w) => /Route East.*flipped/.test(w)), tplan.warnings);
    res = await page.evaluate(() => App.merge.run("route", [0, 1], 0));
    const tj = await page.evaluate(() => ({ c: App.routes[0].geometry.coordinates, w: App.routes[0].properties.waypoints }));
    check("coincident join: no duplicate vertex and no duplicate waypoint (and no network request)",
      res.ok && tj.c.length === 3 && JSON.stringify(tj.w) === JSON.stringify([[-104.80, 38.80], [-104.795, 38.80], [-104.79, 38.80], [-104.78, 38.80]]) && osrm.hits.length === 0, { tj, hits: osrm.hits.length });
    await page.evaluate(() => App.undo.undo());
    await setFixture(page, lineFx());
    const lw = await page.evaluate(() => App.merge.analyze("line", [0, 1, 2], 1).warnings);
    check("reversed directional LINE (Line Z, SB) warns; un-reversed Line X does not",
      lw.some((w) => /Line Z/.test(w) && /SB/.test(w) && /flipped/.test(w)) && !lw.some((w) => /Line X.*flipped/.test(w)), lw);

    // -- Routes: cancelling while routing changes nothing --
    osrm.mode = "hang"; osrm.hold(); osrm.hits.length = 0;
    await setFixture(page, routeFx());
    before = await snapshot(page);
    p0 = await pushes();
    await page.evaluate(() => App.merge.openDialog("route", [0, 1], 0));
    await page.waitForFunction(() => [].some.call(document.querySelectorAll(".fm-dialog button"), (b) => b.textContent === "Merge" && !b.disabled));
    check("opening the dialog made no routing request (analysis stays cheap)", osrm.hits.length === 0, osrm.hits);
    check("route dialog says gaps will be street-routed", /will be street-routed when you merge/.test(await page.locator(".fm-dialog").textContent()));
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-route.png") });
    await page.locator(".fm-dialog .rf-action-primary").click();
    await page.waitForFunction(() => { var b = document.querySelector(".fm-busy"); return b && b.style.display !== "none" && /Routing connections/.test(b.textContent); });
    const busy = await page.evaluate(() => {
      var btns = [].slice.call(document.querySelectorAll(".fm-dialog .rf-weights-modal-actions button"));
      return { text: document.querySelector(".fm-busy").textContent, cancelEnabled: !btns[0].disabled, mergeDisabled: btns[1].disabled,
               radiosDisabled: [].every.call(document.querySelectorAll('.fm-dialog input[name="fmPrimary"]'), (r) => r.disabled) };
    });
    check("while routing: 'Routing connections…' shown, Merge + radios disabled, Cancel still available",
      /Routing connections/.test(busy.text) && busy.mergeDisabled && busy.radiosDisabled && busy.cancelEnabled, busy);
    check("no undo snapshot is taken until routing completes", (await pushes()) === p0);
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-routing.png") });
    await page.keyboard.press("Escape");
    osrm.release();
    await page.waitForTimeout(400);
    check("Escape during routing closes the dialog and aborts", await page.evaluate(() => !document.querySelector(".fm-dialog")));
    check("after the late router response: nothing changed, no undo snapshot", (await snapshot(page)) === before && (await pushes()) === p0);
    // cancellation through the API
    osrm.mode = "ok";
    res = await page.evaluate(() => App.merge.run("route", [0, 1], 0, { isCancelled: function () { return true; } }));
    check("run() with isCancelled resolves cancelled and leaves everything alone", res.ok === false && res.cancelled === true && (await snapshot(page)) === before && (await pushes()) === p0, res);
    // the Cancel button path
    osrm.mode = "hang"; osrm.hold();
    await page.evaluate(() => App.merge.openDialog("route", [0, 1], 0));
    await page.waitForFunction(() => [].some.call(document.querySelectorAll(".fm-dialog button"), (b) => b.textContent === "Merge" && !b.disabled));
    await page.locator(".fm-dialog .rf-action-primary").click();
    await page.waitForFunction(() => /Routing connections/.test((document.querySelector(".fm-busy") || {}).textContent || ""));
    await page.locator(".fm-dialog .rf-btn-sm", { hasText: "Cancel" }).click();
    osrm.release(); await page.waitForTimeout(400);
    check("Cancel button during routing also aborts cleanly", (await snapshot(page)) === before && (await pushes()) === p0);
    osrm.mode = "ok";

    // -- Points ("combine stops") --
    const STOP_A = [-104.79, 38.80];
    const pointFx = () => ({
      routes: [{ name: "Route A", id: 21, coords: ROUTE_A, waypoints: ROUTE_A }, { name: "Route B", id: 22, coords: ROUTE_B, waypoints: ROUTE_B }],
      points: [
        { name: "Stop A", id: 41, at: STOP_A, refs: [{ featureType: "route", featureId: 21, name: "Route A" }], attrs: { stopId: "100", serviceAreaType: "walkshed", group: "G" } },
        { name: "Stop B", id: 42, at: [-104.789, 38.80], refs: [{ featureType: "route", featureId: 21, name: "Route A (old)" }, { featureType: "route", featureId: 22, name: "Route B" }], attrs: { stopId: "200", serviceAreaType: "" } },
        { name: "Stop C", id: 43, at: [-104.50, 38.50], refs: [], attrs: { stopId: "300" } } ]
    });
    await setFixture(page, pointFx());
    before = await snapshot(page);
    const pplan = await page.evaluate(() => { const p = App.merge.analyze("point", [0, 1], 0); return { ok: p.ok, summary: p.summary, warnings: p.warnings, discarded: p.discarded.map((d) => d.key) }; });
    check("point plan: ok, says the stop stays at the primary's location", pplan.ok && pplan.summary.some((t) => /stays at that stop's location/.test(t)), pplan);
    check("conflicting Stop IDs are a warning and listed as discarded", pplan.warnings.some((w) => /different Stop IDs/.test(w)) && pplan.discarded.includes("stopId"), pplan);
    await page.evaluate(() => {
      window.__calls = []; window.__orig = {};
      ["dropPointWalksheds", "ensurePointWalksheds", "refreshBuffers"].forEach((n) => {
        var o = App[n]; window.__orig[n] = o;
        App[n] = function () { window.__calls.push(n + ":" + JSON.stringify([].slice.call(arguments))); return o && o.apply(this, arguments); };
      });
    });
    p0 = await pushes();
    res = await page.evaluate(() => App.merge.run("point", [0, 1], 0));
    const calls = await page.evaluate(() => { Object.keys(window.__orig).forEach((n) => { App[n] = window.__orig[n]; }); return window.__calls; });
    const pm = await page.evaluate(() => ({ n: App.points.length, names: App.points.map((p) => p.properties.name), at: App.points[0].geometry.coordinates, id: App.points[0].properties.pointIdx, a: App.points[0].properties.attributes, sel: App.getSelectedFeatures() }));
    check("point merge ok: 2 points left, survivor Stop A keeps its ID and exact location", res.ok && pm.n === 2 && pm.names[0] === "Stop A" && pm.names[1] === "Stop C" && pm.id === 41 && JSON.stringify(pm.at) === JSON.stringify(STOP_A), { res, pm });
    check("associatedRoutes is the de-duplicated union (primary's entry wins)",
      JSON.stringify(pm.a.associatedRoutes.map((r) => r.featureId + ":" + r.name)) === JSON.stringify(["21:Route A", "22:Route B"]), pm.a);
    check("walkshed-flagged primary keeps serviceAreaType; primary's stopId wins", pm.a.serviceAreaType === "walkshed" && pm.a.stopId === "100" && pm.a.group === "G", pm.a);
    check("removed point's walkshed cache dropped by pointIdx; walksheds + buffers refreshed",
      calls.includes("dropPointWalksheds:[[42]]") && calls.some((c) => c.indexOf("ensurePointWalksheds") === 0) && calls.some((c) => c.indexOf("refreshBuffers") === 0), calls);
    check("survivor selected, one undo snapshot", pm.sel.length === 1 && pm.sel[0].type === "point" && pm.sel[0].index === 0 && (await pushes()) - p0 === 1, pm.sel);
    await page.evaluate(() => App.undo.undo());
    check("single Ctrl+Z restores the points exactly", (await snapshot(page)) === before);
    // a circular-buffer primary is NOT turned into a walkshed by a walkshed donor
    res = await page.evaluate(() => App.merge.run("point", [0, 1], 1));
    const pc = await page.evaluate(() => ({ names: App.points.map((p) => p.properties.name), a: App.points[0].properties.attributes }));
    check("circular-buffer primary stays circular when a walkshed stop is merged in", res.ok && pc.names[0] === "Stop B" && !pc.a.serviceAreaType, pc);
    await page.evaluate(() => App.undo.undo());
    check("the real App.dropPointWalksheds exists and tolerates unknown IDs", await page.evaluate(() => { App.dropPointWalksheds([999, 41]); return typeof App.dropPointWalksheds === "function"; }));

    // -- Line + route (result is always a Line) --
    const QC = [[-104.79, 38.80], [-104.785, 38.8005], [-104.78, 38.80]];
    const mixFx = () => ({
      lines: [
        { name: "Line X", id: 11, coords: [[-104.80, 38.80], [-104.79, 38.80]], attrs: { mode: "Bus" } },
        { name: "Line Y", id: 12, coords: [[-104.50, 38.50], [-104.49, 38.50]], attrs: {} },
        { name: "Line Z", id: 13, coords: [[-104.78, 38.80], [-104.77, 38.80]], attrs: { group: "GZ" } } ],
      routes: [{ name: "Route Q", id: 22, coords: QC, waypoints: [QC[0], QC[2]], color: "#ff0000", props: { _opacity: 40, _lineWidth: 2 }, attrs: { mode: "BRT", direction: "NB", notes: "rq" } }],
      points: [
        { name: "Stop 1", id: 41, at: [-104.785, 38.80], refs: [{ featureType: "route", featureId: 22, name: "Route Q" }] },
        { name: "Stop 2", id: 42, at: [-104.78, 38.80], refs: [{ featureType: "line", featureId: 13, name: "Line Z" }, { featureType: "route", featureId: 22, name: "Route Q" }] },
        { name: "Stop 3", id: 43, at: [-104.50, 38.50], refs: [{ featureType: "line", featureId: 12, name: "Line Y" }] } ]
    });
    await setFixture(page, mixFx());
    await page.evaluate(() => { App.lines[0].properties.colorSeq = 76; App.routes[0].properties.colorSeq = 77; });
    before = await snapshot(page);
    osrm.hits.length = 0;
    const seqBefore = await page.evaluate(() => App.routes[0].properties.colorSeq); // survivor takes the route primary's palette slot
    const mixRefs = [{ type: "line", index: 0 }, { type: "route", index: 0 }, { type: "line", index: 2 }];
    const mplan = await page.evaluate((refs) => { const p = App.merge.analyze("linemix", refs, { type: "route", index: 0 }); return { ok: p.ok, summary: p.summary, stops: p.stopsRepointed, prepare: typeof p.prepare }; }, mixRefs);
    check("line+route plan: ok, says the result is a Line and snapping is removed, no routing step",
      mplan.ok && mplan.prepare !== "function" && mplan.summary.some((t) => /result will be a Line with 5 vertices; street snapping will be removed/.test(t)), mplan);
    p0 = await pushes();
    res = await page.evaluate((refs) => App.merge.run("linemix", refs, { type: "route", index: 0 }), mixRefs);
    let mx = await dump(page);
    const ml = await page.evaluate(() => { var l = App.lines[0]; return { p: l.properties, c: l.geometry.coordinates, rb: App.routeBuffers.length, lb: App.lineBuffers.length }; });
    check("route primary: the first selected LINE survives at its own index (with the route's colorSeq); route + other line removed",
      res.ok && res.survivorType === "line" && res.survivorIndex === 0 && mx.nR === 0 && mx.nL === 2 && ml.p.lineIdx === 11 && seqBefore === 77 && ml.p.colorSeq === 77, { res, mx });
    check("survivor takes the route primary's name, color and appearance overrides",
      ml.p.name === "Route Q" && ml.p.color === "#ff0000" && ml.p._opacity === 40 && ml.p._lineWidth === 2, ml.p);
    check("attributes: primary wins, blanks filled from the others", ml.p.attributes.mode === "BRT" && ml.p.attributes.direction === "NB" && ml.p.attributes.notes === "rq" && ml.p.attributes.group === "GZ", ml.p.attributes);
    check("geometry kept exactly; result is a LineString with `waypoints` = vertex count (5), no route waypoints array",
      ml.c.length === 5 && ml.p.waypoints === 5 && typeof ml.p.waypoints === "number" && JSON.stringify(ml.c[2]) === JSON.stringify(QC[1]), ml);
    check("stops that pointed at the removed route/line now point at the surviving LINE",
      JSON.stringify(mx.stops) === JSON.stringify([["line:11:Route Q"], ["line:11:Route Q"], ["line:12:Line Y"]]), mx.stops);
    check("survivor selected as a line; both layer types re-rendered; one undo snapshot; no routing",
      mx.sel.length === 1 && mx.sel[0].type === "line" && mx.sel[0].index === 0 && ml.rb === 0 && ml.lb === 2 && (await pushes()) - p0 === 1 && osrm.hits.length === 0, { sel: mx.sel, ml });
    await page.evaluate(() => App.undo.undo());
    check("single Ctrl+Z restores the lines, the route and the stops exactly", (await snapshot(page)) === before);
    // line primary, with a removed line sitting BEFORE the survivor in the array
    const mixRefs2 = [{ type: "line", index: 2 }, { type: "route", index: 0 }, { type: "line", index: 0 }];
    res = await page.evaluate((refs) => App.merge.run("linemix", refs, { type: "line", index: 2 }), mixRefs2);
    mx = await dump(page);
    const m2 = await page.evaluate(() => { var l = App.lines.filter((x) => x.properties.lineIdx === 13)[0]; return { name: l.properties.name, at: App.lines.indexOf(l) }; });
    check("line primary survives in place; its index shifts correctly after the earlier line is removed",
      res.ok && res.survivorType === "line" && res.survivorIndex === 1 && m2.at === 1 && m2.name === "Line Z" && mx.lineNames.join() === "Line Y,Line Z" && mx.nR === 0 && mx.sel[0].index === 1 && mx.sel[0].type === "line", { res, mx, m2 });
    check("stops repointed from the route (and removed line) to the surviving line", JSON.stringify(mx.stops) === JSON.stringify([["line:13:Line Z"], ["line:13:Line Z"], ["line:12:Line Y"]]), mx.stops);
    await page.evaluate(() => App.undo.undo());
    check("undo restores (line-primary case)", (await snapshot(page)) === before);

    // -- Real UI for the new types --
    console.log("\n# Phase 3 - UI walkthrough");
    await row("Line X").click();
    await row("Route Q").click({ modifiers: ["Control"] });
    await row("Route Q").click({ button: "right" });
    let mt = await page.locator("#fp-context-menu button").allTextContents();
    check("Merge… appears for a line + route selection", mt.some((t) => t.trim() === "Merge…"), mt);
    await page.locator("#fp-context-menu button", { hasText: "Merge" }).click();
    await page.waitForSelector(".fm-dialog .fm-list");
    const mixDlg = await page.locator(".fm-dialog").textContent();
    check("mixed dialog: title counts lines and routes, states the result is a Line and snapping is removed",
      (await page.locator("#fmTitle").textContent()) === "Merge 2 Lines and Routes" && /result is always a Line/.test(mixDlg) && /street snapping will be removed/.test(mixDlg), mixDlg.slice(0, 400));
    check("mixed dialog: right-clicked route is the default primary, rows are tagged by type",
      await page.evaluate(() => document.querySelector('.fm-dialog input[name="fmPrimary"]:checked').closest("label").textContent.trim() === "Route Q (route)"));
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-linemix.png") });
    await page.keyboard.press("Escape");
    await row("Stop 1").click();
    await row("Line X").click({ modifiers: ["Control"] });
    await row("Line X").click({ button: "right" });
    mt = await page.locator("#fp-context-menu button").allTextContents();
    check("Merge… is NOT offered for a point + line selection", !mt.some((t) => /Merge/.test(t)), mt);
    await page.keyboard.press("Escape"); await page.mouse.click(5, 5);
    await row("Stop 1").click();
    await row("Stop 2").click({ modifiers: ["Control"] });
    await row("Stop 1").click({ button: "right" });
    mt = await page.locator("#fp-context-menu button").allTextContents();
    check("Merge… is offered for two points", mt.some((t) => t.trim() === "Merge…"), mt);
    await page.locator("#fp-context-menu button", { hasText: "Merge" }).click();
    await page.waitForSelector(".fm-dialog .fm-list");
    check("point dialog title and intro", (await page.locator("#fmTitle").textContent()) === "Merge 2 Points" && /combined into one stop/.test(await page.locator(".fm-dialog").textContent()));
    await page.screenshot({ path: join(SHOT_DIR, "merge-dialog-points.png") });
    await page.keyboard.press("Escape");
    // complete a real route merge through the dialog (OSRM mocked)
    await setFixture(page, routeFx());
    osrm.mode = "ok";
    await row("Route A").click();
    await row("Route B").click({ modifiers: ["Control"] });
    await row("Route A").click({ button: "right" });
    await page.locator("#fp-context-menu button", { hasText: "Merge" }).click();
    await page.waitForSelector(".fm-dialog .fm-list");
    check("route dialog title", (await page.locator("#fmTitle").textContent()) === "Merge 2 Routes");
    await page.locator(".fm-dialog .rf-action-primary").click();
    await page.waitForFunction(() => !document.querySelector(".fm-dialog"));
    const ui = await page.evaluate(() => ({ n: App.routes.length, verts: App.routes[0].geometry.coordinates.length, wps: App.routes[0].properties.waypoints.length }));
    check("clicking Merge in the dialog routes the connector, merges and closes", ui.n === 2 && ui.verts === 5 && ui.wps === 4, ui);

    // ================= Phase 4a - Unmerge =================
    console.log("\n# Phase 4a - Unmerge");
    // Arrays sorted by ID: an unmerge appends the other originals to the ends of
    // their arrays, so compare the set of features, not their positions.
    const sortedSnap = (pg) => pg.evaluate(() => {
      const s = (arr, k) => arr.slice().sort((a, b) => a.properties[k] - b.properties[k]);
      return JSON.stringify({ l: s(App.lines, "lineIdx"), r: s(App.routes, "routeIdx"), p: s(App.polygons, "polyIdx"), pt: s(App.points, "pointIdx") });
    });
    const hist = (pg, type, idx) => pg.evaluate(([t, i]) => {
      const f = { line: App.lines, route: App.routes, point: App.points, polygon: App.polygons }[t][i];
      const h = f && f.properties._mergedFrom;
      return h ? { version: h.version, at: h.at, survivorRef: h.survivorRef, nOrig: h.originals.length,
        origKinds: h.originals.map((o) => o.type + ":" + o.feature.properties.name), stops: h.stops, fp: typeof h.resultFingerprint,
        nested: h.originals.map((o) => !!o.feature.properties._mergedFrom) } : null;
    }, [type, idx]);
    const trackPushes = () => page.evaluate(() => { window.__pushes = 0; if (!App.undo.__wrapped) { var o = App.undo.push; App.undo.push = function () { window.__pushes++; return o.apply(this, arguments); }; App.undo.__wrapped = true; } });

    // -- Lines: record + exact restore + single undo step --
    osrm.mode = "ok";
    await setFixture(page, lineFx());
    before = await sortedSnap(page);
    const beforeRaw = await snapshot(page);
    res = await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    const merged1 = await snapshot(page);
    let h = await hist(page, "line", 0);
    check("merge records _mergedFrom v1 on the survivor (ISO time, survivor ref, 3 originals incl. the primary, fingerprint)",
      res.ok && h && h.version === 1 && /^\d{4}-\d\d-\d\dT/.test(h.at) && h.survivorRef.type === "line" && h.survivorRef.id === 12 &&
      h.nOrig === 3 && h.origKinds.includes("line:Line X") && h.origKinds.includes("line:Line Y") && h.origKinds.includes("line:Line Z") && h.fp === "string", h);
    check("originals were cloned pre-merge: the survivor's own clone is not recursive and has no history",
      await page.evaluate(() => { var o = App.lines[0].properties._mergedFrom.originals; return o.every((x) => !x.feature.properties._mergedFrom) && JSON.stringify(o).indexOf("_mergedFrom") < 0; }));
    check("stop links changed by the merge are recorded with pre/post lists (2 stops: 41, 42)",
      h.stops.length === 2 && h.stops.map((x) => x.pointId).sort().join() === "41,42", h.stops);
    check("only the survivor carries history (other lines do not)", await page.evaluate(() => App.lines.filter((l) => l.properties._mergedFrom).length === 1));
    check("Unmerge is offered (hasHistory) for the survivor only", await page.evaluate(() => App.merge.hasHistory("line", 0) && !App.merge.hasHistory("line", 1) && !App.merge.hasHistory("point", 0)));

    p0 = await pushes();
    res = await page.evaluate(() => App.merge.unmerge("line", 0));
    const um = await page.evaluate(() => ({ names: App.lines.map((l) => l.properties.name), sel: App.getSelectedFeatures(),
      status: (document.getElementById("status") || {}).textContent || "", hasH: App.lines.some((l) => l.properties._mergedFrom) }));
    check("unmerge restores the exact pre-merge lines, stops and IDs (sorted compare)", res.ok && (await sortedSnap(page)) === before, res);
    check("survivor replaced in place (position 0), others appended in selection order",
      um.names.join() === "Line Y,Line W,Line X,Line Z" && res.survivorIndex === 0 && res.restored.length === 2, um.names);
    check("restored survivor is selected; status says 'Unmerged 'Line Y' into 3 features — Ctrl+Z to undo'",
      um.sel.length === 1 && um.sel[0].type === "line" && um.sel[0].index === 0 && um.status === "Unmerged 'Line Y' into 3 features — Ctrl+Z to undo", { sel: um.sel, status: um.status });
    check("no history left on any restored line (they had none before)", !um.hasH);
    check("unmerge took exactly ONE undo snapshot", (await pushes()) - p0 === 1);
    await page.evaluate(() => App.undo.undo());
    check("Ctrl+Z after Unmerge brings the merged line back (with its history)", (await snapshot(page)) === merged1);
    await page.evaluate(() => App.undo.undo());
    check("a second Ctrl+Z undoes the merge itself", (await snapshot(page)) === beforeRaw);
    // redo keeps history through the snapshot round trip
    await page.evaluate(() => { App.undo.redo(); });
    check("undo/redo snapshots keep _mergedFrom", await page.evaluate(() => !!App.lines[0].properties._mergedFrom));
    await page.evaluate(() => { App.undo.undo(); });

    // -- Polygons --
    await setFixture(page, { polygons: [
      { name: "Poly A", id: 21, rings: [P1], attrs: { notes: "west" } }, { name: "Poly B", id: 22, rings: [P2], attrs: { notes: "east", group: "g" } },
      { name: "Poly C", id: 23, rings: [P3] } ] });
    before = await sortedSnap(page);
    await page.evaluate(() => App.merge.run("polygon", [0, 1], 0));
    h = await hist(page, "polygon", 0);
    check("polygon merge records history (2 originals, no stops)", h && h.nOrig === 2 && h.stops.length === 0 && h.survivorRef.id === 21, h);
    res = await page.evaluate(() => App.merge.unmerge("polygon", 0));
    check("polygon unmerge restores both polygons exactly (incl. the un-unioned ring)", res.ok && (await sortedSnap(page)) === before);

    // -- Routes (street-routed connector) --
    osrm.mode = "ok";
    await setFixture(page, routeFx());
    before = await sortedSnap(page);
    await page.evaluate(() => App.merge.run("route", [0, 1], 0));
    h = await hist(page, "route", 0);
    check("route merge records history with both originals' full geometry and the stop changes",
      h && h.nOrig === 2 && h.stops.length === 2 && await page.evaluate(() => App.routes[0].properties._mergedFrom.originals.every((o) => o.feature.geometry.coordinates.length === 2 && o.feature.properties.waypoints.length === 2)), h);
    res = await page.evaluate(() => App.merge.unmerge("route", 0));
    check("route unmerge restores both routes (un-routed geometry, waypoints) and every stop link exactly", res.ok && (await sortedSnap(page)) === before, res);

    // -- Points --
    await setFixture(page, pointFx());
    before = await sortedSnap(page);
    await page.evaluate(() => App.merge.run("point", [0, 1], 0));
    h = await hist(page, "point", 0);
    check("point merge records history (2 originals, no stop repoints — no route moved)", h && h.nOrig === 2 && h.stops.length === 0, h);
    res = await page.evaluate(() => App.merge.unmerge("point", 0));
    check("point unmerge brings the removed stop back with its own attributes and links", res.ok && (await sortedSnap(page)) === before, res);

    // -- Line + route, route primary (survivor is the first LINE, a different feature) --
    await setFixture(page, mixFx());
    await page.evaluate(() => { App.lines[0].properties.colorSeq = 76; App.routes[0].properties.colorSeq = 77; });
    before = await sortedSnap(page);
    await page.evaluate((refs) => App.merge.run("linemix", refs, { type: "route", index: 0 }), mixRefs);
    h = await hist(page, "line", 0);
    check("line+route merge (route primary): survivor is a LINE (id 11); originals include the route, both lines; survivor clone kept separately",
      h && h.survivorRef.type === "line" && h.survivorRef.id === 11 && h.nOrig === 3 && h.origKinds.includes("route:Route Q") && h.origKinds.includes("line:Line X") && h.origKinds.includes("line:Line Z"), h);
    res = await page.evaluate(() => App.merge.unmerge("line", 0));
    const lm = await page.evaluate(() => ({ lines: App.lines.map((l) => l.properties.name), routes: App.routes.map((r) => r.properties.name), q: App.routes[0] && App.routes[0].properties }));
    check("line+route unmerge: Line X back in place with its own name/color, Route Q back as a route with its appearance overrides",
      res.ok && lm.lines[0] === "Line X" && lm.routes.join() === "Route Q" && lm.q._opacity === 40 && lm.q.color === "#ff0000" && lm.q.colorSeq === 77, lm);
    check("line+route unmerge restores everything exactly (sorted compare), stops included", (await sortedSnap(page)) === before);

    // -- Nested: merge, merge again, unmerge goes back ONE level --
    await setFixture(page, lineFx());
    before = await sortedSnap(page);
    await page.evaluate(() => App.merge.run("line", [1, 2], 1));          // Line Y + Line Z -> M1 (Y)
    const m1 = await page.evaluate(() => App.lines.map((l) => l.properties.name));
    await page.evaluate(() => { var ix = App.lines.findIndex((l) => l.properties.name === "Line Y"), iX = App.lines.findIndex((l) => l.properties.name === "Line X"); return App.merge.run("line", [ix, iX], ix); }); // M1 + Line X -> M2
    const afterM2 = await page.evaluate(() => App.lines.map((l) => l.properties.name));
    h = await hist(page, "line", await page.evaluate(() => App.lines.findIndex((l) => l.properties.name === "Line Y")));
    check("second merge keeps the first merge's history inside its original (nested, not stripped)", h && h.nOrig === 2 && h.nested.some(Boolean), h);
    const i2 = await page.evaluate(() => App.lines.findIndex((l) => l.properties.name === "Line Y"));
    res = await page.evaluate((i) => App.merge.unmerge("line", i), i2);
    let h1 = await hist(page, "line", await page.evaluate(() => App.lines.findIndex((l) => l.properties.name === "Line Y")));
    check("unmerging the second merge goes back exactly one level: the first merge result is back WITH its history",
      res.ok && h1 && h1.nOrig === 2 && h1.origKinds.join() !== "" && await page.evaluate(() => App.lines.some((l) => l.properties.name === "Line X") && App.lines.length === 3), { h1, afterM2 });
    const i1 = await page.evaluate(() => App.lines.findIndex((l) => l.properties.name === "Line Y"));
    res = await page.evaluate((i) => App.merge.unmerge("line", i), i1);
    check("unmerging again restores the original four lines exactly", res.ok && (await sortedSnap(page)) === before);

    // -- Dialog, edited-since warning, menus --
    console.log("\n# Phase 4a - dialog + menus");
    // Opening the attributes popup seeds blank defaults (avgSpeed = 14); that is not an edit.
    await setFixture(page, lineFx());
    const seeded = await page.evaluate(async () => {
      App.lines.forEach(function (l) { if (l.properties.attributes) delete l.properties.attributes.avgSpeed; });
      await App.merge.run("line", [0, 1, 2], 1);
      var l = App.lines[0];
      var before = l.properties.attributes ? l.properties.attributes.avgSpeed : undefined;
      App.openAttrPopup("line", 0, l);
      var r = { before: before, speed: l.properties.attributes.avgSpeed, edited: App.merge.describeUnmerge("line", 0).edited };
      App.closeAttrPopup();
      return r;
    });
    check("opening the attributes popup (which seeds avgSpeed) does not count as an edit",
      seeded.before === undefined && seeded.speed != null && seeded.edited === false, seeded);
    await setFixture(page, lineFx());
    await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    await page.evaluate(() => App.clearSelection && App.clearSelection());
    const fresh = await page.evaluate(() => App.merge.describeUnmerge("line", 0));
    check("describeUnmerge: not edited right after the merge; lists 3 originals; 2 stop records", fresh.ok && !fresh.edited && fresh.originals.length === 3 && fresh.stopCount === 2, fresh);
    await page.evaluate(() => App.merge.openUnmergeDialog("line", 0));
    await page.waitForSelector(".fm-dialog");
    let dtxt = await page.locator(".fm-dialog").textContent();
    check("unmerge dialog: title, what comes back (names + types), 'returns to what it was', footer note; no warning when unedited",
      (await page.locator("#fmTitle").textContent()) === "Unmerge 'Line Y'" && /Line X \(line\)/.test(dtxt) && /Line Z \(line\)/.test(dtxt) &&
      /returns to what it was before merging/.test(dtxt) && /Ctrl\+Z until you reload/.test(dtxt) && (await page.locator(".fm-note-warn").count()) === 0, dtxt.slice(0, 500));
    check("unmerge dialog uses the shared .fm-* shell (overlay + dialog + actions), focus lands on Unmerge when nothing is lost",
      await page.evaluate(() => !!document.querySelector(".fm-overlay .fm-dialog .rf-weights-modal-actions") && document.activeElement && document.activeElement.textContent === "Unmerge"));
    p0 = await pushes(); const snapNow = await snapshot(page);
    await page.keyboard.press("Escape");
    check("Escape closes the unmerge dialog and changes nothing", await page.evaluate(() => !document.querySelector(".fm-dialog")) && (await snapshot(page)) === snapNow && (await pushes()) === p0);
    await page.evaluate(() => App.merge.openUnmergeDialog("line", 0));
    await page.waitForSelector(".fm-dialog");
    await page.locator(".fm-dialog .rf-btn-sm", { hasText: "Cancel" }).click();
    check("Cancel closes it and changes nothing", await page.evaluate(() => !document.querySelector(".fm-dialog")) && (await snapshot(page)) === snapNow);
    // edit the merged line: rename + nudge a vertex + change an attribute
    await page.evaluate(() => { var l = App.lines[0]; l.properties.name = "Renamed merged"; l.geometry.coordinates[1] = [l.geometry.coordinates[1][0], l.geometry.coordinates[1][1] + 0.0001]; l.properties.attributes.mode = "Rail"; });
    check("describeUnmerge: edited = true after renaming / reshaping / changing attributes", (await page.evaluate(() => App.merge.describeUnmerge("line", 0))).edited === true);
    await page.evaluate(() => App.merge.openUnmergeDialog("line", 0));
    await page.waitForSelector(".fm-dialog");
    const warn = await page.locator(".fm-note-warn").allTextContents();
    check("edited since merging: amber warning says shape, attributes and name edits will be lost; Cancel is focused",
      warn.length === 1 && /edited since it was merged/.test(warn[0]) && /shape, attributes, name/.test(warn[0]) && /lost/.test(warn[0]) &&
      await page.evaluate(() => document.activeElement && document.activeElement.textContent === "Cancel"), warn);
    await page.screenshot({ path: join(SHOT_DIR, "unmerge-dialog-edited.png") });
    await page.locator(".fm-dialog .rf-action-primary").click();
    check("clicking Unmerge in the dialog unmerges (3 lines + W) and closes it",
      await page.evaluate(() => !document.querySelector(".fm-dialog") && App.lines.length === 4 && App.lines.every((l) => !l.properties._mergedFrom)));
    check("the edits made since merging are gone: the line is exactly the pre-merge Line Y again",
      await page.evaluate(() => { var y = App.lines.filter((l) => l.properties.name === "Line Y")[0]; return y.geometry.coordinates.length === 2 && y.properties.attributes.mode === "" ; }));

    // Features panel menu: Unmerge… only for a single feature WITH history
    await setFixture(page, lineFx());
    await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    await page.evaluate(() => App.clearSelection && App.clearSelection());
    await page.locator("#fp-tab-features").getByText("G", { exact: true }).first().click(); // the merged line sits in group "G" (collapsed)
    await row("Line Y").click({ button: "right" });
    let menu = await page.locator("#fp-context-menu button").allTextContents();
    check("Features panel menu: Unmerge… appears for the merged line", menu.some((t) => t.trim() === "Unmerge…"), menu);
    await page.evaluate(() => { var m = document.getElementById("fp-context-menu"); if (m) m.remove(); });
    await row("Line W").click({ button: "right" });
    menu = await page.locator("#fp-context-menu button").allTextContents();
    check("Features panel menu: no Unmerge… for a line without history", !menu.some((t) => /Unmerge/.test(t)), menu);
    await page.evaluate(() => { var m = document.getElementById("fp-context-menu"); if (m) m.remove(); });
    await row("Line Y").click();
    await row("Line W").click({ modifiers: ["Control"] });
    await row("Line Y").click({ button: "right" });
    menu = await page.locator("#fp-context-menu button").allTextContents();
    check("Features panel menu: no Unmerge… on a multi-selection", !menu.some((t) => /Unmerge/.test(t)), menu);
    await page.evaluate(() => { var m = document.getElementById("fp-context-menu"); if (m) m.remove(); });
    await row("Line Y").click();
    await row("Line Y").click({ button: "right" });
    await page.locator("#fp-context-menu button", { hasText: "Unmerge" }).click();
    await page.waitForSelector(".fm-dialog");
    check("the menu item opens the unmerge dialog", (await page.locator("#fmTitle").textContent()) === "Unmerge 'Line Y'");
    await page.keyboard.press("Escape");

    // Map right-click menu (editing.js)
    const mapMenu = async (lngLat) => {
      await page.evaluate(([c]) => { App.map.jumpTo({ center: c, zoom: 15 }); }, [lngLat]);
      await page.waitForTimeout(500);
      const pt = await page.evaluate(([c]) => { var p = App.map.project(c); var r = App.map.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, [lngLat]);
      await page.mouse.click(pt.x, pt.y, { button: "right" });
      await page.waitForTimeout(200);
      const t = await page.locator("#fp-context-menu button").allTextContents();
      await page.evaluate(() => { var m = document.getElementById("fp-context-menu"); if (m) m.remove(); });
      return t;
    };
    const mergedMid = await page.evaluate(() => { var c = App.lines[0].geometry.coordinates; return [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2]; }); // mid-segment, not a vertex
    let mm = await mapMenu(mergedMid);
    check("map right-click menu: Unmerge… appears for the merged line", mm.some((t) => t.trim() === "Unmerge…") && mm.some((t) => /Attributes/.test(t)), mm);
    mm = await mapMenu([-104.495, 38.50]);
    check("map right-click menu: no Unmerge… for a line without history", mm.length > 0 && !mm.some((t) => /Unmerge/.test(t)), mm);

    // -- Stops: best-effort reversal when a stop was edited since the merge --
    console.log("\n# Phase 4a - stops");
    await setFixture(page, lineFx());
    before = await sortedSnap(page);
    await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    const stopsAfterMerge = await page.evaluate(() => App.points.map((p) => p.properties.attributes.associatedRoutes.map((r) => r.featureType + ":" + r.featureId)));
    check("after the merge, stops 1 and 2 point at the merged line (12), stop 3 at W (14)",
      JSON.stringify(stopsAfterMerge) === JSON.stringify([["line:12"], ["line:12"], ["line:14"]]), stopsAfterMerge);
    // stop 1 (was [11,12]) gains a link to W; stop 2 (was [13]) gains a link to W; stop 3 untouched
    await page.evaluate(() => {
      [0, 1].forEach((i) => App.points[i].properties.attributes.associatedRoutes.push({ featureType: "line", featureId: 14, name: "Line W" }));
    });
    await page.evaluate(() => App.merge.unmerge("line", 0));
    const stopsRestored = await page.evaluate(() => App.points.map((p) => p.properties.attributes.associatedRoutes.map((r) => r.featureType + ":" + r.featureId + ":" + r.name)));
    check("edited stop 1 (was [X,Y]): survivor link kept (was linked before), new W link kept, removed X link re-added, names refreshed",
      JSON.stringify(stopsRestored[0]) === JSON.stringify(["line:12:Line Y", "line:14:Line W", "line:11:Line X"]), stopsRestored[0]);
    check("edited stop 2 (was [Z]): survivor link dropped (wasn't linked before), new W link kept, Z link re-added",
      JSON.stringify(stopsRestored[1]) === JSON.stringify(["line:14:Line W", "line:13:Line Z"]), stopsRestored[1]);
    check("untouched stop 3 is identical", JSON.stringify(stopsRestored[2]) === JSON.stringify(["line:14:Line W"]), stopsRestored[2]);
    // a stop deleted since the merge is simply skipped
    await setFixture(page, lineFx());
    await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    await page.evaluate(() => { App.points.splice(1, 1); });
    res = await page.evaluate(() => App.merge.unmerge("line", 0));
    check("a stop deleted since the merge does not break unmerge", res.ok && await page.evaluate(() => App.points.length === 2));

    // -- Persistence: history survives a page reload --
    console.log("\n# Phase 4a - persistence");
    await setFixture(page, lineFx());
    before = await sortedSnap(page);
    await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    await page.evaluate(async () => { App.cache.save(); await new Promise((r) => setTimeout(r, 900)); });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && App.lines.length > 0", { timeout: 30000 });
    await trackPushes();
    check("after a reload the survivor still has its merge history", await page.evaluate(() => App.lines.length === 2 && App.merge.hasHistory("line", 0) && App.lines[0].properties._mergedFrom.originals.length === 3));
    res = await page.evaluate(() => App.merge.unmerge("line", 0));
    check("unmerge after a reload restores the exact pre-merge features, IDs and stops", res.ok && (await sortedSnap(page)) === before, res);
    check("... as one undo step", (await pushes()) === 1);
    check("... and no feature ID collision (new feature gets a fresh ID)", await page.evaluate(() => {
      App.addLineFromCoords([[-104.3, 38.3], [-104.2, 38.3]]);
      var ids = App.lines.map((l) => l.properties.lineIdx); return new Set(ids).size === ids.length;
    }));

    // -- Exports omit _mergedFrom; session / autosave / undo keep it --
    console.log("\n# Phase 4a - exports");
    await setFixture(page, Object.assign(lineFx(), {}));
    await page.evaluate(() => App.merge.run("line", [0, 1, 2], 1));
    await page.evaluate(() => {
      window.__blobs = [];
      if (!window.__origCreate) { window.__origCreate = URL.createObjectURL; }
      URL.createObjectURL = function (b) { window.__blobs.push(b); return window.__origCreate.call(URL, b); };
    });
    const grabBlobs = async (fn) => page.evaluate(async (which) => {
      window.__blobs.length = 0;
      App.cache[which]("all");
      await new Promise((r) => setTimeout(r, 1200));
      const out = [];
      for (const b of window.__blobs) {
        if (/zip/.test(b.type) || b.type === "") {
          const z = await JSZip.loadAsync(b);
          for (const name of Object.keys(z.files)) out.push({ name, text: await z.files[name].async("string") });
        } else out.push({ name: b.type, text: await b.text() });
      }
      return out;
    }, fn);
    const leak = (files) => files.some((f) => /_mergedFrom|originals|resultFingerprint/.test(f.text));
    const fJson = await grabBlobs("exportFeaturesOnly");
    check("JSON (Features only) export: still has the merged line, omits _mergedFrom", fJson.length === 1 && /Line Y/.test(fJson[0].text) && !leak(fJson), fJson.map((f) => f.text.length));
    const fCsv = await grabBlobs("exportCSV");
    check("CSV export omits _mergedFrom (and has the row)", fCsv.length === 1 && /Line Y/.test(fCsv[0].text) && !leak(fCsv));
    const fKml = await grabBlobs("exportKML");
    check("KML export omits _mergedFrom (and has the placemark)", fKml.length === 1 && /Line Y/.test(fKml[0].text) && !leak(fKml));
    const fShp = await grabBlobs("exportSHP");
    check("Shapefile/DBF export omits _mergedFrom (zip has .shp/.dbf)", fShp.some((f) => /\.dbf$/.test(f.name)) && !leak(fShp), fShp.map((f) => f.name));
    const fSess = await grabBlobs("exportToFile");
    check("Session JSON export KEEPS _mergedFrom", fSess.length === 1 && /_mergedFrom/.test(fSess[0].text) && /originals/.test(fSess[0].text));
    check("autosave state (light) and full state keep it", await page.evaluate(() => JSON.stringify(App.cache.collectState("light")).indexOf("_mergedFrom") > 0 && JSON.stringify(App.cache.collectState("full")).indexOf("_mergedFrom") > 0) &&
      await page.evaluate(() => (localStorage.getItem("mat-session") || "").indexOf("_mergedFrom") > 0));
    await page.evaluate(() => { URL.createObjectURL = window.__origCreate; });

    // -- Display / copy paths --
    console.log("\n# Phase 4a - display + copy paths");
    const leaks = await page.evaluate(async () => {
      var out = {};
      App.selectFeature("line", 0);
      await new Promise((r) => setTimeout(r, 200));
      ["lines", "routes", "points", "polygons", "hl-feature"].forEach(function (id) {
        var src = App.map.getSource(id);
        out[id] = src ? JSON.stringify(src.serialize().data).indexOf("_mergedFrom") : "no source";
      });
      var f = App.lines[0];
      App.openAttrPopup("line", 0, f);
      await new Promise((r) => setTimeout(r, 200));
      out.attrPopup = (document.getElementById("fp-attr-popup") || { textContent: "" }).textContent.indexOf("rigin") + "/" + (document.getElementById("fp-attr-popup") || { innerHTML: "" }).innerHTML.indexOf("_mergedFrom");
      App.closeAttrPopup();
      App.duplicateLine(0);
      out.dup = App.lines[App.lines.length - 1].properties._mergedFrom === undefined;
      out.dupOrigHasHist = !!App.lines[0].properties._mergedFrom;
      return out;
    });
    check("map sources (lines, hl-feature, ...) carry no _mergedFrom", [leaks.lines, leaks.routes, leaks.points, leaks.polygons, leaks["hl-feature"]].every((v) => v === -1 || v === "no source"), leaks);
    check("the attribute popup shows nothing about merge history", leaks.attrPopup === "-1/-1", leaks.attrPopup);
    check("Duplicate does not copy merge history (the original keeps it)", leaks.dup === true && leaks.dupOrigHasHist === true, leaks);
    await page.evaluate(() => App.openAttributeSummary && App.openAttributeSummary());
    await page.waitForTimeout(300);
    check("Attribute Summary shows nothing about merge history", await page.evaluate(() => document.body.innerText.indexOf("_mergedFrom") < 0 && document.body.innerText.indexOf("resultFingerprint") < 0));
    await page.keyboard.press("Escape");

    // ---- Phase 4b-1: module references by stable ID (Route Costing, Trip Builder, Title VI) ----
    console.log("\n# Phase 4b-1 - module references by stable ID");

    const BANDS = { weekday: [{ from: "06:00", to: "10:00", frequency: 30 }], saturday: [], sunday: [] };
    const solo = (name, id, y) => ({ name, id, coords: [[-104.80, y], [-104.70, y + 0.01]], attrs: { direction: "Both", avgSpeed: 12, service: BANDS } });
    const fx4b = () => ({ routes: [
      solo("Alpha", 10, 38.80), solo("Bravo", 11, 38.82), solo("Charlie", 12, 38.84), solo("Delta", 13, 38.86),
      { name: "NB leg", id: 14, coords: [[-104.60, 38.80], [-104.50, 38.81]], attrs: { direction: "NB", avgSpeed: 12, serviceId: "Pair", service: BANDS } },
      { name: "SB leg", id: 15, coords: [[-104.50, 38.81], [-104.60, 38.80]], attrs: { direction: "SB", avgSpeed: 12, serviceId: "Pair", service: BANDS } }
    ] });
    const settle = (ms) => page.waitForTimeout(ms || 700);
    const closeModule = () => page.evaluate(() => App.popup.isOpen() && App.popup.close());
    const rcChecked = () => page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll("#rcServiceList input[type=checkbox]"), (b) => b.checked)
      .map((b) => b.closest("label").querySelector(".rc-service-name").textContent.replace(/\s*⚠.*/, "").trim()).sort());
    const rcKeys = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#rcServiceList input[type=checkbox]"), (b) => b.getAttribute("data-key")));
    const modState = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(App.cache.collectState("light").moduleState[id] || null)), id);
    const reloadApp = async () => {
      await page.evaluate(() => App.cache.save()); await settle(800);
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && App.routes.length > 0", { timeout: 30000 });
    };

    // -- Route Costing --
    await setFixture(page, fx4b());
    await page.evaluate(() => App.openModulePopup("route-costing"));
    await settle(500);
    check("Route Costing: solo Service keys are ID-based (solo-route-id10 ...)", JSON.stringify(await rcKeys()) ===
      JSON.stringify(["solo-route-id10", "solo-route-id11", "solo-route-id12", "solo-route-id13", "service-Pair"]), await rcKeys());
    // Uncheck Bravo, then cost.
    await page.evaluate(() => { document.querySelector('#rcServiceList input[data-key="solo-route-id11"]').checked = false; });
    await page.click("#rcCostBtn");
    await page.waitForFunction("document.querySelector('#rcResultsTable') && document.querySelector('#rcResultsTable').innerHTML.length > 50", { timeout: 10000 });
    check("Route Costing: costing ran for the checked Services", await page.evaluate(() => /Alpha/.test(document.getElementById("rcResultsTable").textContent) && !/Bravo/.test(document.getElementById("rcResultsTable").textContent)));
    const rcBefore = await rcChecked();
    // Delete the EARLIEST route (Alpha): every later index shifts down by one.
    await page.evaluate(async () => { App.removeRoute(0); await App.notifyProject(); });
    await settle(300);
    check("Route Costing: deleting an earlier route keeps the selection on the same Services (Bravo still unchecked)",
      JSON.stringify(await rcChecked()) === JSON.stringify(rcBefore.filter((n) => n !== "Alpha")), { now: await rcChecked(), before: rcBefore });
    check("Route Costing: keys of later Services are unchanged by the delete", JSON.stringify(await rcKeys()) ===
      JSON.stringify(["solo-route-id11", "solo-route-id12", "solo-route-id13", "service-Pair"]), await rcKeys());
    // Merge two later routes (Charlie + Delta, primary Charlie) via the real engine.
    osrm.mode = "ok";
    const mres = await page.evaluate(async () => {
      var ci = App.routes.findIndex((r) => r.properties.name === "Charlie"), di = App.routes.findIndex((r) => r.properties.name === "Delta");
      var r = await App.merge.run("route", [ci, di], ci);
      await App.notifyProject();
      return r;
    });
    await settle(300);
    check("Route Costing: a merge of later routes leaves Bravo unchecked and Charlie (survivor) checked",
      mres && mres.ok !== false && JSON.stringify(await rcChecked()) === JSON.stringify(["Charlie", "NB leg + SB leg".length ? "Pair" : ""].sort()) , { mres: mres && mres.ok, now: await rcChecked() });
    await closeModule();
    // Persisted state is ID-based and survives a reload.
    let rcSt = await modState("route-costing");
    check("Route Costing: persisted selectedKeys / lastSummary keys are ID-based",
      JSON.stringify(rcSt.selectedKeys.slice().sort()) === JSON.stringify(["service-Pair", "solo-route-id12"]) &&
      rcSt.lastSummary && rcSt.lastSummary.services.every((r) => /^(solo-route-id\d+|service-.+)$/.test(r.key)), rcSt.selectedKeys);
    await reloadApp();
    await page.evaluate(() => App.openModulePopup("route-costing"));
    await settle(500);
    check("Route Costing: after reload the same Services are still checked", JSON.stringify(await rcChecked()) === JSON.stringify(["Charlie", "Pair"]), await rcChecked());
    await closeModule();

    // -- Route Costing: legacy (index-based) session migration --
    await setFixture(page, fx4b());   // ids 10..13 at indices 0..3; NB/SB = 14/15 at 4/5
    // Produce a REAL lastSummary (run costing), then rewrite every key to its legacy index form.
    await page.evaluate(() => App.openModulePopup("route-costing"));
    await settle(400);
    await page.click("#rcCostBtn");
    await page.waitForFunction("document.querySelector('#rcResultsTable') && document.querySelector('#rcResultsTable').innerHTML.length > 50", { timeout: 10000 });
    await closeModule();
    await page.evaluate(() => {
      var st = JSON.parse(JSON.stringify(App.cache.collectState("full")));
      var legacy = { "solo-route-id10": "solo-route-0", "solo-route-id11": "solo-route-1", "solo-route-id12": "solo-route-2", "solo-route-id13": "solo-route-3" };
      var rc = st.moduleState["route-costing"];
      rc.version = 2;
      rc.lastSummary.services.forEach((r) => { if (legacy[r.key]) r.key = legacy[r.key]; });
      rc.selectedKeys = ["solo-route-1", "solo-route-3", "group-Pair", "solo-route-99"];
      rc.interlineGroups = [{ id: "ilg-1", name: "G", serviceKeys: ["solo-route-0", "solo-route-2", "service-Pair", "solo-line-4"], days: {} }];
      App.cache.applyState(st);
    });
    await page.evaluate(() => App.openModulePopup("route-costing"));
    await settle(500);
    rcSt = await modState("route-costing");
    check("Route Costing legacy restore: selected index keys -> ID keys (and group- -> service-), unresolvable dropped",
      JSON.stringify(await rcChecked()) === JSON.stringify(["Bravo", "Delta", "Pair"]) &&
      JSON.stringify(rcSt.selectedKeys.slice().sort()) === JSON.stringify(["service-Pair", "solo-route-id11", "solo-route-id13"]), { checked: await rcChecked(), keys: rcSt.selectedKeys });
    check("Route Costing legacy restore: interline group member keys migrated (unresolvable dropped)",
      JSON.stringify(rcSt.interlineGroups[0].serviceKeys) === JSON.stringify(["solo-route-id10", "solo-route-id12", "service-Pair"]), rcSt.interlineGroups);
    check("Route Costing legacy restore: lastSummary row keys migrated", rcSt.lastSummary.services.length >= 2 && rcSt.lastSummary.services.some((r) => r.key === "solo-route-id12") &&
      rcSt.lastSummary.services.every((r) => /^(solo-route-id\d+|service-.+)$/.test(r.key)), rcSt.lastSummary.services.map((r) => r.key));
    await closeModule();

    // -- Trip Builder --
    await setFixture(page, fx4b());
    const tbRows = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#tbServiceList .tb-svc-row"), (r) =>
      ({ key: r.getAttribute("data-key"), name: r.querySelector(".tb-svc-name").textContent.replace(/Needs setup/, "").trim(), sel: r.classList.contains("tb-svc-selected") })));
    await page.evaluate(() => App.openModulePopup("trip-builder"));
    await settle(500);
    await page.click('#tbServiceList .tb-svc-row[data-key="solo-route-id12"]');
    await page.click("#tbGenerateBtn");
    await settle(300);
    check("Trip Builder: solo key is ID-based and trips generated for Charlie",
      await page.evaluate(() => /Charlie/.test(document.getElementById("tbHeader").textContent) && document.querySelectorAll("#tbResults tbody tr").length > 0));
    const tripsBefore = await page.evaluate(() => document.querySelectorAll("#tbResults tbody tr").length);
    await page.evaluate(async () => { App.removeRoute(0); App.removeRoute(0); await App.notifyProject(); });   // delete Alpha and Bravo
    await settle(300);
    let rows = await tbRows();
    check("Trip Builder: deleting earlier routes keeps the selection on Charlie (same key, same name)",
      rows.filter((r) => r.sel).length === 1 && rows.find((r) => r.sel).name === "Charlie" && rows.find((r) => r.sel).key === "solo-route-id12", rows);
    check("Trip Builder: the generated trips still belong to Charlie (stored under its ID key, still shown)",
      await page.evaluate((n) => document.querySelectorAll("#tbResults tbody tr").length === n && /Charlie/.test(document.getElementById("tbHeader").textContent), tripsBefore) &&
      JSON.stringify(Object.keys((await modState("trip-builder")).tripsByService)) === JSON.stringify(["solo-route-id12"]), await modState("trip-builder"));
    // refreshAfterEdit anchors by ID: re-key Charlie through the Edit popup after the shifts above.
    await page.click("#tbEditBtn");
    await page.waitForSelector("#fp-mini-popup .tb-edit-popup-body input.fp-attr-input");
    await page.fill("#fp-mini-popup .tb-edit-popup-body input.fp-attr-input", "Renamed");
    await page.press("#fp-mini-popup .tb-edit-popup-body input.fp-attr-input", "Tab");
    await settle(300);
    rows = await tbRows();
    check("Trip Builder: re-keying a Service via the Edit popup keeps the selection (anchored by ID)",
      rows.filter((r) => r.sel).length === 1 && rows.find((r) => r.sel).key === "service-Renamed", rows);
    await page.evaluate(() => App.closeMiniPopup && App.closeMiniPopup());
    // Undo the rename so the session is back to a solo Charlie.
    await page.evaluate(() => { delete App.routes.find((r) => r.properties.name === "Charlie").properties.attributes.serviceId; });
    await closeModule();
    await page.evaluate(() => App.openModulePopup("trip-builder"));
    await settle(400);
    await page.click('#tbServiceList .tb-svc-row[data-key="solo-route-id12"]');
    await page.click("#tbGenerateBtn");
    await settle(300);
    await closeModule();
    await reloadApp();
    let tbSt = await modState("trip-builder");
    check("Trip Builder: persisted selectedKey/tripsByService are ID-keyed and survive a reload",
      tbSt.version === 2 && tbSt.selectedKey === "solo-route-id12" && Object.keys(tbSt.tripsByService).includes("solo-route-id12"), tbSt && { v: tbSt.version, k: tbSt.selectedKey });
    await page.evaluate(() => App.openModulePopup("trip-builder"));
    await settle(500);
    rows = await tbRows();
    check("Trip Builder: after reload the selected row is still Charlie with its trips",
      rows.find((r) => r.sel) && rows.find((r) => r.sel).name === "Charlie" && await page.evaluate(() => document.querySelectorAll("#tbResults tbody tr").length > 0), rows);
    await closeModule();

    // -- Trip Builder: legacy (index-based) session migration --
    await setFixture(page, fx4b());
    await page.evaluate(() => {
      var st = JSON.parse(JSON.stringify(App.cache.collectState("full")));
      st.moduleState = st.moduleState || {};
      var cols = { weekday: [{ direction: "Both", label: "Outbound*", withAsterisk: true, color: "#000", patternName: "x", runtimeMin: 30, trips: [{ startMin: 360, endMin: 390 }] }], saturday: [], sunday: [] };
      st.moduleState["trip-builder"] = { version: 1, selectedKey: "solo-route-2",
        tripsByService: { "solo-route-2": cols, "solo-route-3": cols, "service-Pair": cols, "solo-route-77": cols } };
      App.cache.applyState(st);
    });
    tbSt = await modState("trip-builder");
    check("Trip Builder legacy restore: selectedKey and tripsByService keys migrated; unresolvable dropped",
      tbSt.selectedKey === "solo-route-id12" && JSON.stringify(Object.keys(tbSt.tripsByService).sort()) === JSON.stringify(["service-Pair", "solo-route-id12", "solo-route-id13"]), tbSt);

    // -- Title VI --
    const tviAlts = () => page.evaluate(() => JSON.parse(JSON.stringify((App.cache.collectState("light").moduleState["title-vi"].scenarios[0] || {}).alterations || [])));
    await setFixture(page, fx4b());
    await page.evaluate(() => App.openModulePopup("title-vi"));
    await settle(500);
    await page.click("#tviAddAlteration");
    const optVals = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll(".tvi-alt-before option"), (o) => o.value));
    check("Title VI: feature dropdown values encode the stable ID (route:10 ...)", optVals.includes("route:10") && optVals.includes("route:13") && !optVals.includes("route:0"), optVals);
    await page.selectOption(".tvi-alt-before", "route:11");
    await page.selectOption(".tvi-alt-after", "route:12");
    await settle(300);
    let alts = await tviAlts();
    check("Title VI: alteration stores { featureType, featureId, featureName } (no featureIndex)",
      alts[0].before.featureId === 11 && alts[0].before.featureName === "Bravo" && alts[0].after.featureId === 12 &&
      alts[0].before.featureIndex === undefined && alts[0].computed && Number.isFinite(alts[0].computed.beforeMiles), alts[0]);
    const cardSel = () => page.evaluate(() => ({
      before: (document.querySelector(".tvi-alt-before").selectedOptions[0] || {}).textContent,
      after: (document.querySelector(".tvi-alt-after").selectedOptions[0] || {}).textContent,
      note: getComputedStyle(document.querySelector(".tvi-alt-missing")).display }));
    // Delete an EARLIER route, then merge away a LATER one: refs must keep pointing at Bravo/Charlie.
    await page.evaluate(async () => { App.removeRoute(0); await App.notifyProject(); });
    await settle(300);
    check("Title VI: after deleting an earlier route the card still shows Bravo -> Charlie", JSON.stringify(await cardSel()) === JSON.stringify({ before: "Bravo", after: "Charlie", note: "none" }), await cardSel());
    check("Title VI: engine resolves the refs to the same features after the shift",
      await page.evaluate(() => { var a = App.cache.collectState("light").moduleState["title-vi"].scenarios[0].alterations[0];
        return TitleVI.resolveFeature(a.before).properties.name === "Bravo" && TitleVI.resolveFeature(a.after).properties.name === "Charlie" && TitleVI.findMissingRefs({ alterations: [a] }).length === 0; }));
    // Persist + reload keeps the ID refs.
    await reloadApp();
    alts = await tviAlts();
    check("Title VI: refs survive a page reload (IDs, v3)", alts[0].before.featureId === 11 && alts[0].after.featureId === 12 && (await modState("title-vi")).version === 3, alts[0]);
    await page.evaluate(() => App.openModulePopup("title-vi"));
    await settle(500);
    check("Title VI: after reload the card still shows Bravo -> Charlie", JSON.stringify(await cardSel()) === JSON.stringify({ before: "Bravo", after: "Charlie", note: "none" }), await cardSel());
    // Delete the BEFORE feature: shown as missing; analysis refuses to run (and never uses another feature).
    await page.evaluate(() => { var s = App.cache.collectState("full"); s.moduleState["title-vi"].baseline = { type: "system_population", geoLevel: "bg", year: "2022", minorityShare: 0.3, lowIncomeShare: 0.2, totalPop: 1000, minorityPop: 300, lowIncomePop: 200, geoCount: 3, computedAt: "x" }; App.cache.applyState(s); });
    await page.evaluate(() => App.openModulePopup("title-vi")); await settle(400);
    await page.evaluate(async () => { App.removeRoute(App.routes.findIndex((r) => r.properties.name === "Bravo")); await App.notifyProject(); });
    await settle(300);
    const miss = await cardSel();
    check("Title VI: a deleted Before feature shows as '(deleted feature: Bravo)' with a warning (not another feature)",
      /^\(deleted feature: Bravo\)$/.test(miss.before) && miss.after === "Charlie" && miss.note === "block", miss);
    await page.click('.tvi-tab[data-tab="analysis"]');
    await page.click("#tviRunAnalysis");
    await settle(400);
    const tviStatus = await page.evaluate(() => document.getElementById("tviAnalysisStatus").textContent);
    check("Title VI: Run Equity Analysis refuses with a clear message naming the deleted feature", /deleted/.test(tviStatus) && /Error/.test(tviStatus), tviStatus);
    check("Title VI: the missing ref stays recorded as a dangling ID (featureId 11), not retargeted", (await tviAlts())[0].before.featureId === 11);
    await closeModule();

    // -- Title VI: baseline feature filter by ID --
    await setFixture(page, fx4b());
    await page.evaluate(() => { var s = App.cache.collectState("full"); var t = s.moduleState["title-vi"] || {};
      t.version = 3; t.baselineFeatureFilter = { routeIds: [11], lineIds: [], polygonIds: [] }; s.moduleState["title-vi"] = t; App.cache.applyState(s); });
    await page.evaluate(async () => { App.removeRoute(0); await App.notifyProject(); });
    await page.evaluate(() => App.openModulePopup("title-vi")); await settle(400);
    const baseChecks = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#tviBaselineFeatureList .rf-feature-check-row"), (r) => r.querySelector("label").textContent + ":" + r.querySelector("input").checked));
    check("Title VI: baseline checklist filter follows IDs after an earlier route is deleted (only Bravo checked)",
      JSON.stringify(await baseChecks()) === JSON.stringify(["Bravo:true", "Charlie:false", "Delta:false", "NB leg:false", "SB leg:false"]), await baseChecks());
    check("Title VI: baseline filter persists as stable IDs", JSON.stringify((await modState("title-vi")).baselineFeatureFilter) === JSON.stringify({ routeIds: [11], lineIds: [], polygonIds: [] }));
    await closeModule();

    // -- Title VI: legacy v2 session migration (indices -> IDs) --
    await setFixture(page, fx4b());   // Alpha..Delta = ids 10..13 at indices 0..3
    await page.evaluate(() => {
      var s = JSON.parse(JSON.stringify(App.cache.collectState("full")));
      var alt = (b, a) => ({ name: "alt", changeType: "adjustment", before: b, after: a, computed: null,
        manual: { revenueHours: {}, spanHours: {}, fare: {} } });
      s.moduleState["title-vi"] = { version: 2, policy: JSON.parse(JSON.stringify(TitleVI.defaultPolicy())),
        scenarios: [{ id: "scenario-1", name: "Legacy", type: "service_change", impactMethod: "service_loss_area", notes: "",
          alterations: [alt({ featureType: "route", featureIndex: 1, featureName: "Bravo" }, { featureType: "route", featureIndex: 3, featureName: "Delta" }),
                        alt({ featureType: "route", featureIndex: 40, featureName: "Gone" }, null)] }],
        activeScenarioIdx: 0, baseline: null, stale: false, activeTab: "policies", results: {} };
      App.cache.applyState(s);
    });
    alts = await tviAlts();
    check("Title VI legacy v2 restore: index refs -> featureId (Bravo=11, Delta=13), featureIndex dropped",
      alts[0].before.featureId === 11 && alts[0].after.featureId === 13 && alts[0].before.featureIndex === undefined && alts[0].before.featureName === "Bravo", alts[0]);
    check("Title VI legacy v2 restore: an unresolvable index becomes a missing ref (featureId null), not another feature",
      alts[1].before.featureId === null && alts[1].before.featureName === "Gone" &&
      await page.evaluate(() => TitleVI.findMissingRefs(App.cache.collectState("light").moduleState["title-vi"].scenarios[0]).length === 1), alts[1]);
    check("Title VI legacy restore is saved back as v3", (await modState("title-vi")).version === 3);


    // ---- Phase 4b-2: TPI, Ridership Forecasting, Corridor Scoring, Transit Coverage, Feature Area Analysis ----
    console.log("\n# Phase 4b-2 - module references by stable ID (analysis modules)");

    const fx42 = () => ({
      routes: [
        solo("Alpha", 10, 38.80), solo("Bravo", 11, 38.82), solo("Charlie", 12, 38.84), solo("Delta", 13, 38.86)
      ],
      lines: [
        { name: "L-One", id: 20, coords: [[-104.60, 38.70], [-104.50, 38.71]], attrs: {} },
        { name: "L-Two", id: 21, coords: [[-104.60, 38.72], [-104.50, 38.73]], attrs: {} }
      ],
      polygons: [
        { name: "PolyA", id: 30, rings: [square(-104.90, 38.70, 0.05, 0.05)] },
        { name: "PolyB", id: 31, rings: [square(-104.80, 38.70, 0.05, 0.05)] },
        { name: "PolyC", id: 32, rings: [square(-104.70, 38.70, 0.05, 0.05)] }
      ]
    });
    // Replace one module's saved state (keeping every other module's) and re-apply the session.
    const applyMod = (id, data) => page.evaluate(([id, data]) => {
      var st = JSON.parse(JSON.stringify(App.cache.collectState("full")));
      st.moduleState = st.moduleState || {};
      st.moduleState[id] = data;
      App.cache.applyState(st);
    }, [id, data]);
    const checkedIn = (sel) => page.evaluate((sel) => Array.prototype.filter.call(document.querySelectorAll(sel + " input[type=checkbox]"), (b) => b.checked)
      .map((b) => b.closest(".rf-feature-check-row").querySelector("label").textContent.trim()).sort(), sel);
    const delRoute = (name) => page.evaluate(async (name) => {
      App.removeRoute(App.routes.findIndex((r) => r.properties.name === name)); await App.notifyProject();
    }, name);
    const mergeRoutes = (a, b) => page.evaluate(async ([a, b]) => {
      var ai = App.routes.findIndex((r) => r.properties.name === a), bi = App.routes.findIndex((r) => r.properties.name === b);
      var r = await App.merge.run("route", [ai, bi], ai); await App.notifyProject(); return r && r.ok !== false;
    }, [a, b]);
    const openMod = async (id) => { await page.evaluate((id) => App.openModulePopup(id), id); await settle(500); };
    const selText = (id) => page.evaluate((id) => { var s = document.getElementById(id); return s ? { value: s.value, text: s.selectedIndex >= 0 ? s.options[s.selectedIndex].textContent : null } : null; }, id);
    const ALL_ROUTES = ["Alpha", "Bravo", "Charlie", "Delta"];
    osrm.mode = "ok";

    // -- Transit Propensity --
    await setFixture(page, fx42());
    await applyMod("tpi", { schemaVersion: 2, selectedCorridor: "route:12",
      uncheckedFeatures: [{ type: "route", id: 11 }, { type: "polygon", id: 30 }] });
    await openMod("transit-propensity");
    check("TPI: restored checklist unchecks exactly Bravo and PolyA", JSON.stringify((await checkedIn("#tpiFeatureChecklist")).filter((n) => !["L-One", "L-Two", "PolyB", "PolyC"].includes(n))) === JSON.stringify(["Alpha", "Charlie", "Delta"]) &&
      (await checkedIn("#tpiFeatureChecklist")).includes("PolyB") && !(await checkedIn("#tpiFeatureChecklist")).includes("PolyA"), await checkedIn("#tpiFeatureChecklist"));
    let sel = await selText("tpiCorridorSelect");
    check("TPI: restored corridor is Charlie (route:12)", sel.value === "route:12" && sel.text === "Charlie", sel);
    await delRoute("Alpha");
    await settle(300);
    let chk = await checkedIn("#tpiFeatureChecklist");
    check("TPI: deleting an earlier route keeps Bravo/PolyA unchecked and the rest checked", !chk.includes("Bravo") && !chk.includes("PolyA") &&
      chk.includes("Charlie") && chk.includes("Delta") && chk.includes("PolyB") && chk.includes("L-One"), chk);
    sel = await selText("tpiCorridorSelect");
    check("TPI: deleting an earlier route keeps the corridor on Charlie", sel.value === "route:12" && sel.text === "Charlie", sel);
    check("TPI: merging later routes keeps the corridor on the surviving Charlie and the Bravo uncheck", await mergeRoutes("Charlie", "Delta") &&
      (await selText("tpiCorridorSelect")).text === "Charlie" && !(await checkedIn("#tpiFeatureChecklist")).includes("Bravo"), [await selText("tpiCorridorSelect"), await checkedIn("#tpiFeatureChecklist")]);
    // user changes through the real checkbox handler persist by ID
    await page.evaluate(() => { var b = Array.prototype.find.call(document.querySelectorAll("#tpiFeatureChecklist input"), (x) => x.closest(".rf-feature-check-row").querySelector("label").textContent === "L-Two");
      b.checked = false; b.dispatchEvent(new Event("change")); });
    let tpiSt = await modState("tpi");
    check("TPI: persisted state is v2 with unchecked refs + corridor by ID", tpiSt.schemaVersion === 2 && tpiSt.selectedCorridor === "route:12" &&
      JSON.stringify(tpiSt.uncheckedFeatures.map((r) => r.type + ":" + r.id).sort()) === JSON.stringify(["line:21", "polygon:30", "route:11"]), tpiSt);
    await closeModule();
    await reloadApp();
    await openMod("transit-propensity");
    chk = await checkedIn("#tpiFeatureChecklist");
    check("TPI: after reload the same features are unchecked and the corridor is still Charlie", !chk.includes("Bravo") && !chk.includes("PolyA") && !chk.includes("L-Two") &&
      chk.includes("Charlie") && (await selText("tpiCorridorSelect")).text === "Charlie", [chk, await selText("tpiCorridorSelect")]);
    await delRoute("Charlie");
    await settle(300);
    check("TPI: deleting the corridor's feature resets the dropdown to all features", (await selText("tpiCorridorSelect")).value === "all");
    await closeModule();
    // legacy (v1, indices)
    await setFixture(page, fx42());
    await applyMod("tpi", { weights: undefined, selectedCorridor: "route:2",
      tpiFeatureFilter: { routeIndices: [0, 1], lineIndices: [0], pointIndices: [], polygonIndices: [0, 1, 2] } });
    await openMod("transit-propensity");
    chk = await checkedIn("#tpiFeatureChecklist");
    check("TPI legacy restore: index filter -> checked Alpha, Bravo, L-One, all polygons", JSON.stringify(chk) === JSON.stringify(["Alpha", "Bravo", "L-One", "PolyA", "PolyB", "PolyC"]), chk);
    sel = await selText("tpiCorridorSelect");
    check("TPI legacy restore: corridor \"route:2\" -> Charlie by ID", sel.value === "route:12" && sel.text === "Charlie", sel);
    check("TPI legacy restore: saved back as v2", (await modState("tpi")).schemaVersion === 2);
    await closeModule();

    // -- Corridor Scoring --
    await setFixture(page, fx42());
    await applyMod("corridor-scoring", { version: 2, uncheckedFeatures: [{ type: "route", id: 11 }, { type: "line", id: 21 }] });
    await openMod("corridor-scoring");
    chk = await checkedIn("#csFeatureList");
    check("Corridor Scoring: restored checklist unchecks Bravo and L-Two only", JSON.stringify(chk) === JSON.stringify(["Alpha", "Charlie", "Delta", "L-One"]), chk);
    await delRoute("Alpha");
    await settle(300);
    chk = await checkedIn("#csFeatureList");
    check("Corridor Scoring: deleting an earlier route keeps the same unchecked features", JSON.stringify(chk) === JSON.stringify(["Charlie", "Delta", "L-One"]), chk);
    check("Corridor Scoring: merging later routes keeps Bravo/L-Two unchecked", await mergeRoutes("Charlie", "Delta") &&
      JSON.stringify(await checkedIn("#csFeatureList")) === JSON.stringify(["Charlie", "L-One"]), await checkedIn("#csFeatureList"));
    await closeModule();
    let csSt = await modState("corridor-scoring");
    check("Corridor Scoring: persisted state is v2 with unchecked refs by ID", csSt.version === 2 &&
      JSON.stringify(csSt.uncheckedFeatures.map((r) => r.type + ":" + r.id).sort()) === JSON.stringify(["line:21", "route:11"]), csSt.uncheckedFeatures);
    await reloadApp();
    await openMod("corridor-scoring");
    check("Corridor Scoring: after reload the same features are checked", JSON.stringify(await checkedIn("#csFeatureList")) === JSON.stringify(["Charlie", "L-One"]), await checkedIn("#csFeatureList"));
    await closeModule();

    // Restored scored results: the map layer and exports resolve rows by ID.
    const csRow = (name, id, type, extra) => Object.assign({ name, featureType: type || "route", featureId: id, cdi: 3.1, classification: "Medium", geoCount: 4,
      lengthMiles: 2, factorBreakdown: {}, compositeRange: { min: 1, max: 4 } }, extra || {});
    const csMap = () => page.evaluate(() => { var src = App.map.getSource("corridor-scoring-routes"); if (!src) return null;
      return src.serialize().data.features.map((f) => ({ name: f.properties.name, c0: f.geometry.coordinates[0].join(",") })); });
    const geomOf = (name) => page.evaluate((name) => { var f = App.routes.concat(App.lines).find((x) => x.properties.name === name); return f.geometry.coordinates[0].join(","); }, name);
    await setFixture(page, fx42());
    await page.evaluate(async () => { App.removeRoute(0); await App.notifyProject(); });   // Alpha gone: Bravo/Charlie/Delta now at 0/1/2
    await applyMod("corridor-scoring", { version: 2, uncheckedFeatures: [], geoLevel: "bg", year: "2022", apportionByArea: false,
      lastSummary: { geoLevel: "bg", year: "2022", apportionByArea: false, bufferMiles: 0.5, weights: {}, featureRefs: [],
        routeCDIs: [csRow("Charlie", 12), csRow("Bravo", 11), csRow("Ghost", 99)] } });
    await settle(300);
    let cm = await csMap();
    check("Corridor Scoring v2 restore: map draws Charlie and Bravo from THEIR geometry; a deleted feature is skipped",
      cm && cm.length === 2 && cm.find((f) => f.name === "Charlie").c0 === await geomOf("Charlie") && cm.find((f) => f.name === "Bravo").c0 === await geomOf("Bravo"), cm);
    await openMod("corridor-scoring");
    check("Corridor Scoring v2 restore: a row whose feature is gone marks the results stale (exports disabled)",
      await page.evaluate(() => document.getElementById("csExportCSV").disabled && /re-run/i.test(document.getElementById("csStatus").textContent)));
    await closeModule();
    // legacy v1: rows saved with featureIndex only (positions at save time)
    await setFixture(page, fx42());
    await applyMod("corridor-scoring", { version: 1, featureFilter: { routeIndices: [1, 2], lineIndices: [0] }, geoLevel: "bg", year: "2022",
      lastSummary: { geoLevel: "bg", year: "2022", apportionByArea: false, bufferMiles: 0.5, weights: {}, featureFilter: { routeIndices: [1, 3], lineIndices: [] },
        routeCDIs: [csRow("Bravo", undefined, "route", { featureId: undefined, featureIndex: 1 }), csRow("Delta", undefined, "route", { featureId: undefined, featureIndex: 3 }),
          csRow("L-Two", undefined, "line", { featureId: undefined, featureIndex: 1 })] } });
    await settle(300);
    cm = await csMap();
    check("Corridor Scoring legacy restore: featureIndex rows draw the right features (Bravo, Delta, L-Two)",
      cm && cm.length === 3 &&
      cm.find((f) => f.name === "Bravo").c0 === await geomOf("Bravo") && cm.find((f) => f.name === "Delta").c0 === await geomOf("Delta") &&
      cm.find((f) => f.name === "L-Two").c0 === await geomOf("L-Two"), cm);
    csSt = await modState("corridor-scoring");
    check("Corridor Scoring legacy restore: saved back as v2 with featureId rows, unchecked = everything not in the old filter",
      csSt.version === 2 && JSON.stringify(csSt.lastSummary.routeCDIs.map((r) => r.featureId)) === JSON.stringify([11, 13, 21]) &&
      csSt.lastSummary.routeCDIs.every((r) => r.featureIndex === undefined) &&
      JSON.stringify(csSt.uncheckedFeatures.map((r) => r.type + ":" + r.id).sort()) === JSON.stringify(["line:21", "route:10", "route:13"]), csSt);
    await closeModule();

    // -- Transit Coverage --
    await setFixture(page, fx42());
    await applyMod("transit-coverage", { version: 2, settings: {}, uncheckedFeatures: [{ type: "route", id: 11 }, { type: "polygon", id: 31 }] });
    await openMod("transit-coverage");
    check("Transit Coverage: restored checklists uncheck Bravo and PolyB only", JSON.stringify(await checkedIn("#tcFeatureList")) === JSON.stringify(["Alpha", "Charlie", "Delta", "L-One", "L-Two"]) &&
      JSON.stringify(await checkedIn("#tcAreaList")) === JSON.stringify(["PolyA", "PolyC"]), [await checkedIn("#tcFeatureList"), await checkedIn("#tcAreaList")]);
    await delRoute("Alpha");
    await page.evaluate(async () => { App.removePolygon(0); await App.notifyProject(); });   // PolyA too
    await settle(300);
    check("Transit Coverage: deleting earlier route + polygon keeps the same selection",
      JSON.stringify(await checkedIn("#tcFeatureList")) === JSON.stringify(["Charlie", "Delta", "L-One", "L-Two"]) &&
      JSON.stringify(await checkedIn("#tcAreaList")) === JSON.stringify(["PolyC"]), [await checkedIn("#tcFeatureList"), await checkedIn("#tcAreaList")]);
    check("Transit Coverage: merging later routes keeps Bravo unchecked", await mergeRoutes("Charlie", "Delta") &&
      JSON.stringify(await checkedIn("#tcFeatureList")) === JSON.stringify(["Charlie", "L-One", "L-Two"]), await checkedIn("#tcFeatureList"));
    await closeModule();
    let tcSt = await modState("transit-coverage");
    check("Transit Coverage: persisted state is v2, unchecked refs by ID (deleted PolyA pruned)", tcSt.version === 2 &&
      JSON.stringify(tcSt.uncheckedFeatures.map((r) => r.type + ":" + r.id).sort()) === JSON.stringify(["polygon:31", "route:11"]), tcSt.uncheckedFeatures);
    await reloadApp();
    await openMod("transit-coverage");
    check("Transit Coverage: after reload the same selection holds", JSON.stringify(await checkedIn("#tcFeatureList")) === JSON.stringify(["Charlie", "L-One", "L-Two"]) &&
      JSON.stringify(await checkedIn("#tcAreaList")) === JSON.stringify(["PolyC"]), [await checkedIn("#tcFeatureList"), await checkedIn("#tcAreaList")]);
    await closeModule();
    await setFixture(page, fx42());
    await applyMod("transit-coverage", { version: 1, settings: {}, selections: { routeIndices: [0, 2], lineIndices: [1], polygonIndices: [0, 2] },
      lastSummary: { geoLevel: "bg", year: "2022", bufferMiles: 0.5, dayType: "weekday", thresholdMin: null, popTotal: 1, popCovered: 1, popThreshold: null,
        jobsTotal: null, jobsCovered: null, jobsThreshold: null,
        headwayRows: [{ name: "Charlie", featureType: "route", featureIndex: 2, peakHeadway: 30, qualifies: false }, { name: "L-Two", featureType: "line", featureIndex: 1, peakHeadway: null, qualifies: false }] } });
    await openMod("transit-coverage");
    check("Transit Coverage legacy restore: index selections -> Alpha, Charlie, L-Two / PolyA, PolyC",
      JSON.stringify(await checkedIn("#tcFeatureList")) === JSON.stringify(["Alpha", "Charlie", "L-Two"]) &&
      JSON.stringify(await checkedIn("#tcAreaList")) === JSON.stringify(["PolyA", "PolyC"]), [await checkedIn("#tcFeatureList"), await checkedIn("#tcAreaList")]);
    tcSt = await modState("transit-coverage");
    check("Transit Coverage legacy restore: headway rows get featureId (Charlie=12, L-Two=21), saved as v2",
      tcSt.version === 2 && JSON.stringify(tcSt.lastSummary.headwayRows.map((r) => r.featureId)) === JSON.stringify([12, 21]) && tcSt.lastSummary.headwayRows.every((r) => r.featureIndex === undefined), tcSt.lastSummary);
    await closeModule();

    // -- Feature Area Analysis --
    await setFixture(page, fx42());
    await applyMod("buffer-summary", { schemaVersion: 2, featureRefs: [{ type: "route", id: 11 }, { type: "route", id: 12 }, { type: "polygon", id: 31 }] });
    await openMod("buffer-summary");
    check("Feature Area Analysis: restored checklist checks exactly Bravo, Charlie, PolyB", JSON.stringify(await checkedIn("#basFeatureChecklist")) === JSON.stringify(["Bravo", "Charlie", "PolyB"]), await checkedIn("#basFeatureChecklist"));
    await delRoute("Alpha");
    await settle(300);
    check("Feature Area Analysis: deleting an earlier route keeps the same checked features", JSON.stringify(await checkedIn("#basFeatureChecklist")) === JSON.stringify(["Bravo", "Charlie", "PolyB"]), await checkedIn("#basFeatureChecklist"));
    check("Feature Area Analysis: merging later routes keeps Bravo checked and Delta unchecked", await mergeRoutes("Charlie", "Delta") &&
      JSON.stringify(await checkedIn("#basFeatureChecklist")) === JSON.stringify(["Bravo", "Charlie", "PolyB"]), await checkedIn("#basFeatureChecklist"));
    await closeModule();
    let basSt = await modState("buffer-summary");
    check("Feature Area Analysis: persisted state is v2 refs by ID", basSt.schemaVersion === 2 &&
      JSON.stringify(basSt.featureRefs.map((r) => r.type + ":" + r.id).sort()) === JSON.stringify(["polygon:31", "route:11", "route:12"]), basSt.featureRefs);
    await reloadApp();
    await openMod("buffer-summary");
    check("Feature Area Analysis: after reload the same features are checked", JSON.stringify(await checkedIn("#basFeatureChecklist")) === JSON.stringify(["Bravo", "Charlie", "PolyB"]), await checkedIn("#basFeatureChecklist"));
    await closeModule();
    await setFixture(page, fx42());
    await applyMod("buffer-summary", { featureFilter: { routeIndices: [1, 3], lineIndices: [], pointIndices: [], polygonIndices: [2] } });
    await openMod("buffer-summary");
    check("Feature Area Analysis legacy restore: index filter -> Bravo, Delta, PolyC", JSON.stringify(await checkedIn("#basFeatureChecklist")) === JSON.stringify(["Bravo", "Delta", "PolyC"]), await checkedIn("#basFeatureChecklist"));
    await closeModule();

    // -- Ridership Forecasting --
    const rfRow = (name, id, type, extra) => Object.assign({ name, featureType: type || "route", featureId: id, cdi: 3.2, classification: "Medium", geoCount: 3, lengthMiles: 4,
      factorBreakdown: {}, compositeRange: { min: 1, max: 4 } }, extra || {});
    const tinyTpi = { geoLevel: "bg", year: "2022", geoids: ["1"], geos: [{ type: "Feature", properties: { GEOID: "1" },
      geometry: { type: "Polygon", coordinates: [square(-104.9, 38.7, 0.5, 0.2)] } }], effectiveWeights: {}, tractFallbackFactors: [], apportionByArea: false,
      scores: { "1": { composite: 3 } }, factorScores: {}, rawValues: {} };
    const rfLines = () => page.evaluate(() => { var src = App.map.getSource("rf-corridor-cdi"); if (!src) return null;
      return src.serialize().data.features.map((f) => ({ name: f.properties.name, c0: f.geometry.coordinates[0].join(",") })); });
    await setFixture(page, fx42());
    await applyMod("rf", { _schemaVersion: 4, selectedCorridor: "route:12", demandUseSameSystem: true,
      calibFeatureFilter: { routeIds: [11, 12], lineIds: [21] }, demandFeatureFilter: { routeIds: [12, 13], lineIds: [] },
      perRouteCDI: [rfRow("Bravo", 11), rfRow("Charlie", 12), rfRow("L-Two", 21, "line"), rfRow("Ghost", 99)],
      systemResult: { systemCDI: { value: 3, scored: 1, total: 1 }, geoLevel: "bg", year: "2022", tpiResult: tinyTpi } });
    await settle(300);
    let rl = await rfLines();
    check("RF v4 restore: corridor lines drawn from the right features (Bravo, Charlie, L-Two); the deleted one is skipped",
      rl && rl.length === 3 && rl.find((f) => f.name === "Charlie").c0 === await geomOf("Charlie") && rl.find((f) => f.name === "Bravo").c0 === await geomOf("Bravo") &&
      rl.find((f) => f.name === "L-Two").c0 === await geomOf("L-Two"), rl);
    await delRoute("Alpha");
    await openMod("ridership-forecasting");
    check("RF: calibration checklist shows the last-run filter (Bravo, Charlie, L-Two) after an earlier route is deleted",
      JSON.stringify(await checkedIn("#rfCalibFeatureList")) === JSON.stringify(["Bravo", "Charlie", "L-Two"]), await checkedIn("#rfCalibFeatureList"));
    sel = await selText("rfCorridorSelect");
    check("RF: corridor dropdown still targets Charlie and lists only features that still exist", sel.value === "route:12" && sel.text.indexOf("Charlie") === 0 &&
      await page.evaluate(() => Array.prototype.map.call(document.getElementById("rfCorridorSelect").options, (o) => o.value).join()) === "route:11,route:12,line:21", sel);
    check("RF: merging later routes keeps the corridor on the surviving Charlie", await mergeRoutes("Charlie", "Delta") && (await selText("rfCorridorSelect")).value === "route:12");
    await closeModule();
    let rfSt = await modState("rf");
    check("RF: persisted state is v4 (corridor + filters + per-route rows by stable ID, no stale featureIndex)", rfSt._schemaVersion === 4 && rfSt.selectedCorridor === "route:12" &&
      JSON.stringify(rfSt.calibFeatureFilter) === JSON.stringify({ routeIds: [11, 12], lineIds: [21] }) &&
      rfSt.perRouteCDI.every((r) => Number.isFinite(r.featureId) && r.featureIndex === undefined), rfSt);
    await reloadApp();
    rfSt = await modState("rf");   // autosave is "light" (no geometry), so only the references are checked here
    check("RF: after reload the corridor, filters and per-route rows are unchanged", rfSt.selectedCorridor === "route:12" &&
      JSON.stringify(rfSt.calibFeatureFilter) === JSON.stringify({ routeIds: [11, 12], lineIds: [21] }) &&
      JSON.stringify(rfSt.perRouteCDI.map((r) => r.featureId)) === JSON.stringify([11, 12, 21, 99]), rfSt.perRouteCDI);
    // legacy session (v3, indices)
    await setFixture(page, fx42());
    await applyMod("rf", { _schemaVersion: 3, selectedCorridor: "route:2", demandUseSameSystem: true,
      calibFeatureFilter: { routeIndices: [1, 2], lineIndices: [1] }, demandFeatureFilter: { routeIndices: [2, 3], lineIndices: [] },
      perRouteCDI: [rfRow("Bravo", undefined, "route", { featureId: undefined, featureIndex: 1 }), rfRow("Delta", undefined, "route", { featureId: undefined, featureIndex: 3 }),
        rfRow("Nowhere", undefined, "route", { featureId: undefined, featureIndex: 77 })],
      systemResult: { systemCDI: { value: 3, scored: 1, total: 1 }, geoLevel: "bg", year: "2022", tpiResult: tinyTpi } });
    await settle(300);
    rfSt = await modState("rf");
    check("RF legacy restore: corridor \"route:2\" -> route:12; filters -> IDs; rows get featureId (unresolvable stays null)",
      rfSt._schemaVersion === 4 && rfSt.selectedCorridor === "route:12" &&
      JSON.stringify(rfSt.calibFeatureFilter) === JSON.stringify({ routeIds: [11, 12], lineIds: [21] }) &&
      JSON.stringify(rfSt.demandFeatureFilter) === JSON.stringify({ routeIds: [12, 13], lineIds: [] }) &&
      JSON.stringify(rfSt.perRouteCDI.map((r) => r.featureId)) === JSON.stringify([11, 13, null]), rfSt);
    rl = await rfLines();
    check("RF legacy restore: corridor lines drawn for the right features (Bravo, Delta), unresolvable row skipped",
      rl && rl.length === 2 && rl.find((f) => f.name === "Bravo").c0 === await geomOf("Bravo") && rl.find((f) => f.name === "Delta").c0 === await geomOf("Delta"), rl);
    // calibration file import: ID rows resolve by ID, legacy rows best-effort by position
    await openMod("ridership-forecasting");
    const importCalib = (json) => page.evaluate(async (json) => {
      var inp = document.getElementById("rfCalibImportFile");
      var dt = new DataTransfer(); dt.items.add(new File([json], "calib.json", { type: "application/json" }));
      inp.files = dt.files; inp.dispatchEvent(new Event("change"));
    }, json);
    await page.evaluate(async () => { App.removeRoute(0); await App.notifyProject(); });   // Alpha gone: Bravo now index 0
    await importCalib(JSON.stringify({ type: "ridership-calibration", version: 2, calibration: { factor: 1, n: 3, rSquared: 0.9, method: "ratio" },
      featureFilter: { routeIds: [11, 13], lineIds: [] },
      perRouteCDI: [rfRow("Bravo", 11), rfRow("Delta", 13)] }));
    await settle(400);
    check("RF calibration import (ID file): rows and filter resolve by ID after an earlier route was deleted",
      await page.evaluate(() => Array.prototype.map.call(document.getElementById("rfCorridorSelect").options, (o) => o.value).join()) === "route:11,route:13", await selText("rfCorridorSelect"));
    await importCalib(JSON.stringify({ type: "ridership-calibration", version: 2, calibration: { factor: 1, n: 3, rSquared: 0.9, method: "ratio" },
      featureFilter: { routeIndices: [0, 1], lineIndices: [] },
      perRouteCDI: [rfRow("Bravo", undefined, "route", { featureId: undefined, featureIndex: 0 }), rfRow("Delta", undefined, "route", { featureId: undefined, featureIndex: 9 })] }));
    await settle(400);
    check("RF calibration import (legacy file): best-effort by position — in-range index resolves, out-of-range row is skipped",
      await page.evaluate(() => Array.prototype.map.call(document.getElementById("rfCorridorSelect").options, (o) => o.value).join()) === "route:11", await selText("rfCorridorSelect"));

    // Engine: per-route results carry the stable featureId next to the positional featureIndex.
    await setFixture(page, fx42());
    await page.evaluate(async () => { App.removeRoute(0); await App.notifyProject(); });
    const engine = await page.evaluate(() => {
      var tpi = { rawValues: new Map([["pop_density", new Map()]]), scores: new Map(), factorScores: new Map(), geos: [] };
      var filter = { routeIndices: [1, 2], lineIndices: [1] };
      var rows = RidershipModel.computePerRouteCDI(tpi, filter, App.buildAnalysisBufferSet(filter, 0.5));
      return rows.map((r) => [r.name, r.featureType, r.featureIndex, r.featureId]);
    });
    check("RidershipModel.computePerRouteCDI rows carry featureId (Charlie=12 at index 1, Delta=13, L-Two=21)",
      JSON.stringify(engine) === JSON.stringify([["Charlie", "route", 1, 12], ["Delta", "route", 2, 13], ["L-Two", "line", 1, 21]]), engine);
    await closeModule();

    // ================= END ASSERTIONS =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
