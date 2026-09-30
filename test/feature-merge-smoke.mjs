#!/usr/bin/env node
// test/feature-merge-smoke.mjs
//
// Browser smoke test for the Feature Merge work (docs/feature-merge-plan.md).
// Loads the real app, drives window.App through page.evaluate, and asserts.
// Phase 1 covers unique, stable per-type feature IDs; Phase 2 covers the merge
// engine, dialog, polygons and lines (including a pass through the real UI:
// Ctrl+click rows, right-click, dialog, Escape/Merge). Later phases append
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
// waypoints — fine for ID tests). Prints PASS/FAIL per assertion; exits
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
    st.routes = []; st.labels = st.labels || []; 
    st.lines = (fx.lines || []).map((l) => ({ type: "Feature",
      properties: { name: l.name, lineIdx: l.id, waypoints: l.coords.length, color: l.color || "", attributes: l.attrs || {} },
      geometry: { type: "LineString", coordinates: l.coords } }));
    st.polygons = (fx.polygons || []).map((p) => ({ type: "Feature",
      properties: { name: p.name, polyIdx: p.id, vertices: p.rings[0].length - 1, color: "", attributes: p.attrs || {} },
      geometry: { type: "Polygon", coordinates: p.rings } }));
    st.points = (fx.points || []).map((p) => ({ type: "Feature",
      properties: { name: p.name, pointIdx: p.id, color: "", attributes: { associatedRoutes: p.refs || [] } },
      geometry: { type: "Point", coordinates: p.at } }));
    App.cache.applyState(st);
  }, fx);
}
const square = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const snapshot = (page) => page.evaluate(() => JSON.stringify({ l: App.lines, p: App.polygons, pt: App.points }));

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

    // ================= END ASSERTIONS =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
