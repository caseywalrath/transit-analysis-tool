#!/usr/bin/env node
// test/feature-split-smoke.mjs
//
// Browser smoke test for Feature Split (docs/feature-split-plan.md, Phase 1:
// "Split here" for lines and routes). Loads the real app, drives window.App
// through page.evaluate and the real map right-click menu + dialog, and asserts:
// piece count / IDs / inherited attributes / run-time share / Service choice /
// stop re-links, split then Merge gives identical coordinates, split then Undo
// restores the session exactly, and loops / end cuts are refused.
//
// USAGE (Playwright is not an npm dependency of this repo — see
// test/ui-screens/capture.mjs for the one-time install):
//   NODE_PATH=/path/to/playwright/node_modules node test/feature-split-smoke.mjs
// Same harness as test/feature-merge-smoke.mjs (vendored CDN libs, remote aborted).
// Prints PASS/FAIL per assertion; exits non-zero if any fail.

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
const SHOT_DIR = process.env.SPLIT_SHOT_DIR || os.tmpdir();

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


// ---- Fixture ----
const LINE = [[-104.80, 38.80], [-104.79, 38.80], [-104.78, 38.80], [-104.78, 38.81]];
const ROUTE = [[-104.80, 38.82], [-104.79, 38.82], [-104.78, 38.82], [-104.77, 38.82]];
const bands = { weekday: [{ from: "06:00", to: "09:00", frequency: 15 }], saturday: [], sunday: [], sundayMirrorsSaturday: false };

async function loadFixture(page) {
  await page.evaluate(({ LINE, ROUTE, bands }) => {
    var st = App.cache.collectState("full");
    st.labels = st.labels || [];
    st.polygons = [];
    st.lines = [
      { type: "Feature", properties: { name: "Blue", lineIdx: 1, waypoints: 4, color: "", colorSeq: 3, _opacity: 60, _lineWidth: 2,
          attributes: { group: "G", direction: "Both", mode: "Bus", avgSpeed: 12, runTime: 30, notes: "n", serviceId: "S1", service: bands } },
        geometry: { type: "LineString", coordinates: LINE } },
      { type: "Feature", properties: { name: "Blue (2)", lineIdx: 2, waypoints: 2, color: "#123456", attributes: {} },
        geometry: { type: "LineString", coordinates: [[-104.70, 38.70], [-104.69, 38.70]] } }
    ];
    st.routes = [
      { type: "Feature", properties: { name: "Red", routeIdx: 5, waypoints: [ROUTE[0], ROUTE[2], ROUTE[3]], color: "#aa0000",
          attributes: { direction: "NB", serviceId: "R", runTime: 20 } },
        geometry: { type: "LineString", coordinates: ROUTE } },
      { type: "Feature", properties: { name: "Red SB", routeIdx: 6, waypoints: [ROUTE[3], ROUTE[0]], color: "#aa0000",
          attributes: { direction: "SB", serviceId: "R" } },
        geometry: { type: "LineString", coordinates: ROUTE.slice().reverse().map((c) => [c[0], c[1] + 0.003]) } }
    ];
    var pt = (name, id, at, refs) => ({ type: "Feature", properties: { name, pointIdx: id, color: "", attributes: { associatedRoutes: refs } },
      geometry: { type: "Point", coordinates: at } });
    var L1 = { featureType: "line", featureId: 1, name: "Blue" };
    st.points = [
      pt("Start", 1, [-104.799, 38.8001], [L1]),
      pt("End", 2, [-104.7801, 38.808], [L1, { featureType: "route", featureId: 5, name: "Red" }]),
      pt("Corner", 3, [-104.78, 38.80005], [L1]),
      pt("Other", 4, [-104.75, 38.75], [])
    ];
    App.cache.applyState(st);
  }, { LINE, ROUTE, bands });
}
const snapshot = (page) => page.evaluate(() => JSON.stringify({ l: App.lines, r: App.routes, pt: App.points }));

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
    await page.evaluate(() => App.cache.reset && App.cache.reset());
    // Zoom in so a click location is not snapped to a vertex 10 px away.
    await page.evaluate(() => App.map.jumpTo({ center: [-104.785, 38.81], zoom: 15 }));

    // ================= ASSERTIONS =================
    console.log("\n# Engine + pure helpers loaded");
    check("App.split and App.splitGeom exist; merge exports its dialog kit",
      await page.evaluate(() => !!(App.split && App.split.analyze && App.split.run && App.split.openDialog && App.splitGeom && App.merge._dialogKit)));

    console.log("\n# Line: split at a vertex");
    await loadFixture(page);
    const before = await snapshot(page);
    await page.evaluate(() => { window.__pushes = 0; var o = App.undo.push; App.undo.push = function () { window.__pushes++; return o.apply(this, arguments); }; });
    const plan = await page.evaluate(() => { const p = App.split.analyze("line", 0, [{ segIndex: 2, t: 0 }]);
      return { ok: p.ok, n: p.pieces.length, names: p.pieces.map((x) => x.name), rt: p.pieces.map((x) => x.runTime), svc: p.newServiceIds,
               stops: p.stops, moved: p.stopsMoved, both: p.stopsBoth, summary: p.summary, warnings: p.warnings }; });
    check("analyze: 2 pieces, unique name 'Blue (3)', run time split by length", plan.ok && plan.n === 2 && plan.names[1] === "Blue (3)" &&
      Math.abs(plan.rt[0] + plan.rt[1] - 30) < 1e-9 && plan.rt[0] > plan.rt[1], plan);
    check("analyze: new Service 'S1 (2)'; stops: Start part 1, End part 2, Corner both", JSON.stringify(plan.svc) === '["S1 (2)"]' &&
      JSON.stringify(plan.stops.map((s) => s.pieces)) === "[[0],[1],[0,1]]" && plan.moved === 1 && plan.both === 1, plan);
    let res = await page.evaluate(() => App.split.run("line", 0, [{ segIndex: 2, t: 0 }]));
    const ln = await page.evaluate(() => ({ n: App.lines.length, a: App.lines[0].properties, b: App.lines[2].properties,
      ca: App.lines[0].geometry.coordinates, cb: App.lines[2].geometry.coordinates,
      pts: App.points.map((p) => p.properties.attributes.associatedRoutes.map((r) => r.featureType + ":" + r.featureId)),
      sel: App.getSelectedFeatures(), pushes: window.__pushes }));
    check("run ok; first piece keeps slot/ID/colorSeq; new piece appended with a new ID", res.ok && ln.n === 3 && ln.a.lineIdx === 1 &&
      ln.a.colorSeq === 3 && ln.b.lineIdx > 2 && ln.b.colorSeq !== 3 && typeof ln.b.colorSeq === "number", { res, a: ln.a, b: ln.b });
    check("attributes copied (group/direction/mode/avgSpeed/notes/bands/appearance), runTime split, serviceId new",
      ln.b.attributes.group === "G" && ln.b.attributes.mode === "Bus" && ln.b.attributes.avgSpeed === 12 && ln.b.attributes.notes === "n" &&
      ln.b.attributes.service.weekday.length === 1 && ln.b._opacity === 60 && ln.b._lineWidth === 2 &&
      ln.a.attributes.serviceId === "S1" && ln.b.attributes.serviceId === "S1 (2)" &&
      Math.abs(ln.a.attributes.runTime + ln.b.attributes.runTime - 30) < 1e-9, ln.b);
    check("geometry: pieces share the cut vertex; line waypoints recomputed", ln.ca.length === 3 && ln.cb.length === 2 &&
      JSON.stringify(ln.ca[2]) === JSON.stringify(ln.cb[0]) && ln.a.waypoints === 3 && ln.b.waypoints === 2, { ca: ln.ca, cb: ln.cb });
    const nid = ln.b.lineIdx;
    check("stops re-linked by ID (End -> new piece; Corner -> both; route link untouched)",
      JSON.stringify(ln.pts) === JSON.stringify([["line:1"], ["line:" + nid, "route:5"], ["line:1", "line:" + nid], []]), ln.pts);
    check("both pieces selected; exactly one undo snapshot", ln.sel.length === 2 && ln.pushes === 1, ln);

    // Merge back -> identical coordinates
    res = await page.evaluate(async () => App.merge.run("line", [0, 2], 0));
    check("split then Merge gives identical coordinates",
      res.ok && JSON.stringify(await page.evaluate(() => App.lines[0].geometry.coordinates)) === JSON.stringify(LINE), res);
    await page.evaluate(() => App.undo.undo());   // undo merge
    await page.evaluate(() => App.undo.undo());   // undo split
    check("split then Undo restores the session exactly", (await snapshot(page)) === before);

    console.log("\n# Route: mid-segment cut via lngLat, Service = none, paired warning");
    const rplan = await page.evaluate(() => { const p = App.split.analyze("route", 0, [-104.785, 38.8201]);
      return { ok: p.ok, cuts: p.cuts, wps: p.pieces.map((x) => x.waypoints), warnings: p.warnings }; });
    check("route waypoints partitioned with the cut point as a shared end waypoint", rplan.ok &&
      JSON.stringify(rplan.wps) === JSON.stringify([[ROUTE[0], [-104.785, 38.82]], [[-104.785, 38.82], ROUTE[2], ROUTE[3]]]), rplan);
    check("paired-Service warning shown", rplan.warnings.some((w) => /opposite direction/.test(w)), rplan.warnings);
    res = await page.evaluate(() => App.split.run("route", 0, [-104.785, 38.8201], { service: "none", names: ["Red A", "Red B"] }));
    const rt = await page.evaluate(() => ({ n: App.routes.length, a: App.routes[0].properties, b: App.routes[2].properties }));
    check("route split: names from choices, explicit color copied, no colorSeq, Service cleared on new piece",
      res.ok && rt.n === 3 && rt.a.name === "Red A" && rt.b.name === "Red B" && rt.b.color === "#aa0000" && rt.b.colorSeq === undefined &&
      rt.b.attributes.serviceId === "" && rt.a.attributes.serviceId === "R" && rt.b.attributes.direction === "NB", rt);
    res = await page.evaluate(async () => App.merge.run("route", [0, 2], 0));
    const merged = await page.evaluate(() => App.routes[0].geometry.coordinates);
    const expect = [ROUTE[0], ROUTE[1], [-104.785, 38.82], ROUTE[2], ROUTE[3]];
    check("route split (mid-segment) then Merge gives the original line plus the collinear cut vertex",
      res.ok && JSON.stringify(merged) === JSON.stringify(expect), merged);
    await page.evaluate(() => { App.undo.undo(); App.undo.undo(); });
    check("route: Undo restores exactly", (await snapshot(page)) === before);

    console.log("\n# Guards");
    const g = await page.evaluate(() => ({
      end: App.split.analyze("line", 0, [-104.79995, 38.80]).ok,
      endMenu: App.split.canSplitAt("line", 0, [-104.79995, 38.80]),
      midMenu: App.split.canSplitAt("line", 0, [-104.785, 38.80]),
      poly: App.split.analyze("polygon", 0, [-104.785, 38.80]).ok
    }));
    check("cut within 30 ft of an end refused; Split here hidden there; offered mid-line; polygons refused",
      !g.end && !g.endMenu && g.midMenu && !g.poly, g);
    await page.evaluate(() => { var st = App.cache.collectState("full"); st.lines.push({ type: "Feature",
      properties: { name: "Loop", lineIdx: 9, waypoints: 4, color: "", attributes: {} },
      geometry: { type: "LineString", coordinates: [[-104.8, 38.85], [-104.79, 38.85], [-104.79, 38.86], [-104.80005, 38.85]] } });
      App.cache.applyState(st); });
    check("loops: Split here not offered and analyze refuses one cut", await page.evaluate(() =>
      !App.split.canSplitAt("line", 2, [-104.79, 38.855]) && !App.split.analyze("line", 2, [-104.79, 38.855]).ok));

    console.log("\n# Merge history removed");
    await loadFixture(page);
    await page.evaluate(async () => { await App.merge.run("line", [0, 1], 0); });
    const h = await page.evaluate(() => { const has = !!App.lines[0].properties._mergedFrom;
      const p = App.split.analyze("line", 0, [{ segIndex: 1, t: 0 }]); const r = App.split.run("line", 0, [{ segIndex: 1, t: 0 }]);
      return { has, warn: p.warnings.some((w) => /Unmerge/.test(w)), ok: r.ok, after: App.lines.map((l) => !!l.properties._mergedFrom)
             }; });
    check("merged feature: dialog warns Unmerge goes away; no piece keeps _mergedFrom", h.has && h.warn && h.ok && h.after.every((x) => !x), h);

    console.log("\n# Real UI: map right-click -> Split here -> dialog -> Enter");
    await loadFixture(page);
    await page.evaluate(() => { App.map.jumpTo({ center: [-104.785, 38.803], zoom: 14 }); });
    await page.waitForTimeout(800);
    const xy = await page.evaluate(() => { const p = App.map.project([-104.785, 38.80]); const r = App.map.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y }; });
    await page.mouse.click(xy.x, xy.y, { button: "right" });
    await page.waitForTimeout(200);
    const items = await page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
    check("map menu offers 'Split here' right after Duplicate", items.indexOf("Split here") === items.indexOf("Duplicate") + 1, items);
    await page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === "Split here").click());
    await page.waitForTimeout(100);
    const dlg = await page.evaluate(() => ({ open: !!document.querySelector(".fm-dialog"), title: (document.getElementById("fmTitle") || {}).textContent,
      names: Array.from(document.querySelectorAll(".fs-piece-row input")).map((i) => i.value),
      radios: document.querySelectorAll('input[name="fsService"]').length, focus: document.activeElement && document.activeElement.textContent }));
    check("dialog: piece names, Service choice (3 radios), Split focused", dlg.open && dlg.names.length === 2 && dlg.names[1] === "Blue (3)" &&
      dlg.radios === 3 && dlg.focus === "Split", dlg);
    await page.screenshot({ path: join(SHOT_DIR, "split-dialog.png") });
    await page.focus(".fs-piece-row:nth-of-type(2) input").catch(() => {});
    await page.evaluate(() => { const i = document.querySelectorAll(".fs-piece-row input")[1]; i.value = "Blue east"; i.focus(); });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    check("Enter splits with the edited name; dialog closes", await page.evaluate(() =>
      !document.querySelector(".fm-dialog") && App.lines.length === 3 && App.lines[2].properties.name === "Blue east"));
    await page.evaluate(() => App.undo.undo());
    await page.evaluate(() => App.split.openDialog("line", 0, [-104.785, 38.80]));
    await page.keyboard.press("Escape");
    check("Escape cancels with nothing changed", await page.evaluate(() => !document.querySelector(".fm-dialog") && App.lines.length === 2));

    console.log("\n# Reload persistence");
    await page.evaluate(() => App.split.run("line", 0, [{ segIndex: 2, t: 0 }]));
    await page.evaluate(() => App.cache.save && App.cache.save());
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && App.lines.length === 3", { timeout: 30000 });
    check("pieces survive reload with their IDs", await page.evaluate(() => App.lines.length === 3 &&
      App.lines[0].properties.lineIdx === 1 && App.lines[2].properties.lineIdx > 2));
    // ================= END ASSERTIONS =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
