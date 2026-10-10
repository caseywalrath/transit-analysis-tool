#!/usr/bin/env node
// test/feature-split-smoke.mjs
//
// Browser smoke test for Feature Split (docs/archive/feature-split-plan.md, Phase 1:
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
    await page.evaluate(() => App.setSelection([])); // a 2+ selection would show the group menu
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


    // ================= PHASE 2 =================
    const px = (ll) => page.evaluate((ll) => { const p = App.map.project(ll); const r = App.map.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y }; }, ll);
    const view = async (c, z) => { await page.evaluate(({ c, z }) => App.map.jumpTo({ center: c, zoom: z }), { c, z }); await page.waitForTimeout(600); };
    const menuItems = () => page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
    const clickMenu = (label) => page.evaluate((label) => Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === label).click(), label);
    const previewLayers = () => page.evaluate(() => ({ src: !!App.map.getSource("split-preview"), line: !!App.map.getLayer("split-preview-line"), cut: !!App.map.getLayer("split-preview-cut") }));
    const close = (a, b, tol = 1e-5) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

    console.log("\n# Split out section: line (real right-click menu, preview, click, dialog)");
    await loadFixture(page);
    await view([-104.785, 38.803], 14);
    const snap0 = await snapshot(page);
    await page.evaluate(() => { window.__pushes = 0; });
    const A = await px([-104.795, 38.80]), B = await px([-104.78, 38.805]);
    await page.evaluate(() => App.setSelection([])); // a 2+ selection would show the group menu
    await page.mouse.click(A.x, A.y, { button: "right" });
    await page.waitForTimeout(200);
    let items2 = await menuItems();
    check("menu: 'Split out section…' directly after 'Split here'", items2.indexOf("Split out section…") === items2.indexOf("Split here") + 1 && items2.indexOf("Split here") > 0, items2);
    await clickMenu("Split out section…");
    await page.waitForTimeout(100);
    check("pick mode armed: drawMode split-pick, preview layers exist", await page.evaluate(() => App.drawMode === "split-pick" && App.split.isPicking()) &&
      (await previewLayers()).cut);
    await page.mouse.move(B.x - 30, B.y + 10);
    await page.mouse.move(B.x, B.y, { steps: 4 });
    await page.waitForTimeout(150);
    const pv = await page.evaluate(() => { const d = App.map.getSource("split-preview")._data || App.map.getSource("split-preview").serialize().data;
      const ids = App.map.getStyle().layers.map((l) => l.id);
      return { feats: d.features.map((f) => ({ k: f.properties.kind, n: f.geometry.coordinates.length, c: f.geometry.coordinates })),
               aboveLines: App.lineStyleLayerIds().every((lid) => ids.indexOf(lid) >= 0 && ids.indexOf("split-preview-line") > ids.indexOf(lid)), last: ids.slice(-2) }; });
    const sec = pv.feats.find((f) => f.k === "section");
    check("preview highlights the stretch from the first point to the cursor (4 coords through 2 vertices); marker at the first cut; drawn above lines",
      sec && sec.n === 4 && pv.feats.some((f) => f.k === "cut") && pv.aboveLines && close(sec.c[1], LINE[1]) && close(sec.c[2], LINE[2]), pv);
    await page.keyboard.press("l"); await page.keyboard.press("r");
    check("tool shortcuts do not fire during pick mode", await page.evaluate(() => App.drawMode === "split-pick"));
    await page.mouse.click(B.x, B.y);
    await page.waitForTimeout(150);
    const d2 = await page.evaluate(() => ({ open: !!document.querySelector(".fm-dialog"), mode: App.drawMode, picking: App.split.isPicking(),
      names: Array.from(document.querySelectorAll(".fs-piece-row input")).map((i) => i.value) }));
    check("second click opens the dialog with 3 pieces; mode ended; preview layers removed", d2.open && d2.names.length === 3 && d2.mode === null &&
      !d2.picking && (await previewLayers()).src === false && (await previewLayers()).line === false, d2);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const s1 = await page.evaluate(() => ({ n: App.lines.length, sel: App.getSelectedFeatures(), mid: App.lines[2].geometry.coordinates,
      a: App.lines[0].geometry.coordinates, last: App.lines[3].geometry.coordinates, pushes: window.__pushes,
      names: App.lines.map((l) => l.properties.name) }));
    // lines array: [Blue (first piece), Blue (2) (the fixture's other line), section, last piece]
    check("3 pieces; the middle piece (the section) is the one selected; one undo snapshot",
      s1.n === 4 && s1.sel.length === 1 && s1.sel[0].index === 2 && s1.pushes === 1, s1);
    check("section geometry: cut -> two vertices -> cut; first piece ends at the first cut; last starts at the second", s1.mid.length === 4 &&
      close(s1.mid[0], [-104.795, 38.80], 1e-3) && close(s1.mid[1], LINE[1]) && close(s1.mid[2], LINE[2]) && close(s1.mid[3], [-104.78, 38.805], 1e-3) &&
      JSON.stringify(s1.mid[0]) === JSON.stringify(s1.a[1]) && JSON.stringify(s1.mid[3]) === JSON.stringify(s1.last[0]), s1);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(500);
    check("Undo restores the session exactly", (await snapshot(page)) === snap0);

    console.log("\n# Split out section: cancel paths and refused points");
    await page.evaluate(() => App.setSelection([])); // a 2+ selection would show the group menu
    await page.mouse.click(A.x, A.y, { button: "right" }); await page.waitForTimeout(150);
    await clickMenu("Split out section…"); await page.waitForTimeout(100);
    await page.mouse.move(B.x, B.y, { steps: 3 }); await page.waitForTimeout(120);
    await page.mouse.click(A.x, A.y); await page.waitForTimeout(150); // same spot as the first point
    check("second point on the first point is refused; still picking; no dialog",
      await page.evaluate(() => App.split.isPicking() && !document.querySelector(".fm-dialog") && App.lines.length === 2));
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
    const esc = await page.evaluate(() => ({ mode: App.drawMode, picking: App.split.isPicking(), dlg: !!document.querySelector(".fm-dialog"), n: App.lines.length }));
    const escL = await previewLayers();
    check("Escape cancels: no preview layers/source left, drawMode cleared, nothing changed", esc.mode === null && !esc.picking && !esc.dlg &&
      !escL.src && !escL.line && !escL.cut && (await snapshot(page)) === snap0, { esc, escL });
    await page.evaluate(() => App.setSelection([])); // a 2+ selection would show the group menu
    await page.mouse.click(A.x, A.y, { button: "right" }); await page.waitForTimeout(150);
    await clickMenu("Split out section…"); await page.waitForTimeout(100);
    await page.mouse.move(B.x, B.y, { steps: 3 }); await page.waitForTimeout(100);
    await page.mouse.click(B.x, B.y - 120, { button: "right" }); await page.waitForTimeout(150);
    const rc = await previewLayers();
    check("right-click cancels and cleans the layers", await page.evaluate(() => !App.split.isPicking() && App.drawMode === null) && !rc.src && !rc.line);

    console.log("\n# Split out section: ends");
    const endPlan = await page.evaluate(() => { const p = App.split.analyze("line", 0, [[-104.79999, 38.80], [-104.785, 38.80]]);
      return { ok: p.ok, n: p.pieces.length, sec: p.sectionPiece, errs: p.errors }; });
    check("a point on the start end gives 2 pieces; the section is piece 1 (first)", endPlan.ok && endPlan.n === 2 && endPlan.sec === 0, endPlan);
    const endPlan2 = await page.evaluate(() => { const p = App.split.analyze("line", 0, [[-104.785, 38.80], [-104.78, 38.80999]]);
      return { ok: p.ok, n: p.pieces.length, sec: p.sectionPiece }; });
    check("a point on the far end gives 2 pieces; the section is the last piece", endPlan2.ok && endPlan2.n === 2 && endPlan2.sec === 1, endPlan2);
    check("both points at the two ends, or the same spot: refused", await page.evaluate(() =>
      !App.split.analyze("line", 0, [[-104.79999, 38.80], [-104.78, 38.80999]]).ok && !App.split.analyze("line", 0, [[-104.785, 38.80], [-104.785, 38.80]]).ok));
    const endRun = await page.evaluate(() => { const r = App.split.run("line", 0, [[-104.79999, 38.80], [-104.785, 38.80]]);
      return { ok: r.ok, n: App.lines.length, sel: App.getSelectedFeatures().length, first: App.lines[0].geometry.coordinates.length }; });
    check("end-section run: 2 pieces, the section (first piece) selected", endRun.ok && endRun.n === 3 && endRun.sel === 1, endRun);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(500);

    console.log("\n# Split out section: route");
    const c1 = [-104.795, 38.82], c2 = [-104.775, 38.82];
    const rsec = await page.evaluate(({ c1, c2 }) => { const p = App.split.analyze("route", 0, [c1, c2]);
      return { ok: p.ok, n: p.pieces.length, sec: p.sectionPiece, wps: p.pieces.map((x) => x.waypoints), rt: p.pieces.map((x) => x.runTime), errs: p.errors }; }, { c1, c2 });
    check("route: 3 pieces, waypoints partitioned with cut points as shared ends",
      rsec.ok && rsec.n === 3 && rsec.sec === 1 && rsec.wps[1].length === 3 && close(rsec.wps[1][1], ROUTE[2]) && close(rsec.wps[0][rsec.wps[0].length - 1], rsec.wps[1][0]) &&
      close(rsec.wps[1][2], rsec.wps[2][0]), rsec);
    await view([-104.785, 38.82], 14);
    await page.evaluate(({ c1, c2 }) => { App.split.startSectionPick("route", 0, c1); }, { c1, c2 });
    const P2 = await px(c2);
    await page.mouse.move(P2.x, P2.y, { steps: 3 }); await page.waitForTimeout(120);
    await page.mouse.click(P2.x, P2.y); await page.waitForTimeout(150);
    await page.keyboard.press("Enter"); await page.waitForTimeout(200);
    const rr = await page.evaluate(() => ({ n: App.routes.length, sel: App.getSelectedFeatures(), mid: App.routes[2].geometry.coordinates, mw: App.routes[2].properties.waypoints,
      mr: App.routes[2].properties.attributes.runTime }));
    check("route section split via the pick: appended section piece selected, with its own waypoints",
      rr.n === 4 && rr.sel.length === 1 && rr.sel[0].index === 2 && rr.mid.length === 4 && rr.mw.length === 3, rr);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(500);

    console.log("\n# Split out section: loop");
    await page.evaluate(() => { var st = App.cache.collectState("full"); st.lines.push({ type: "Feature",
      properties: { name: "Loop", lineIdx: 9, waypoints: 5, color: "", attributes: { runTime: 40 } },
      geometry: { type: "LineString", coordinates: [[-104.8, 38.85], [-104.79, 38.85], [-104.79, 38.86], [-104.8, 38.86], [-104.80005, 38.85]] } });
      App.cache.applyState(st); });
    await view([-104.795, 38.855], 14);
    const LA = await px([-104.795, 38.85]), LB = await px([-104.79, 38.855]);
    await page.evaluate(() => App.setSelection([])); // a 2+ selection would show the group menu
    await page.mouse.click(LA.x, LA.y, { button: "right" }); await page.waitForTimeout(150);
    const loopItems = await menuItems();
    check("loop: 'Split here' hidden, 'Split out section…' offered", !loopItems.includes("Split here") && loopItems.includes("Split out section…"), loopItems);
    await clickMenu("Split out section…"); await page.waitForTimeout(100);
    await page.mouse.move(LB.x, LB.y, { steps: 3 }); await page.waitForTimeout(120);
    await page.mouse.click(LB.x, LB.y); await page.waitForTimeout(150);
    const lp = await page.evaluate(() => ({ open: !!document.querySelector(".fm-dialog"), n: document.querySelectorAll(".fs-piece-row").length }));
    check("loop dialog: 2 pieces (the rest is joined into one)", lp.open && lp.n === 2, lp);
    await page.keyboard.press("Enter"); await page.waitForTimeout(200);
    const lr = await page.evaluate(() => { const l0 = App.lines[2], l1 = App.lines[3];
      return { n: App.lines.length, rest: l0.geometry.coordinates, sec: l1.geometry.coordinates, rt: [l0.properties.attributes.runTime, l1.properties.attributes.runTime],
               sel: App.getSelectedFeatures().length, names: [l0.properties.name, l1.properties.name] }; });
    check("loop result: rest keeps the feature, starts at the second point, runs through the loop start; section is the new feature and is selected",
      lr.n === 4 && lr.rest.length === 6 && close(lr.rest[0], lr.sec[lr.sec.length - 1]) && close(lr.rest[lr.rest.length - 1], lr.sec[0]) &&
      lr.sel === 1 && lr.names[1] === "Loop (2)" && Math.abs(lr.rt[0] + lr.rt[1] - 40) < 1e-9, lr);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(500);

    console.log("\n# Split at this node (vertex-edit menu)");
    await loadFixture(page);
    await view([-104.785, 38.81], 14);
    const nodeBefore = await snapshot(page);
    await page.evaluate(() => App.selectFeature("line", 0));
    await page.waitForTimeout(150);
    const V1 = await px(LINE[1]), V0 = await px(LINE[0]);
    await page.mouse.click(V0.x, V0.y, { button: "right" }); await page.waitForTimeout(150);
    const endMenu = await page.evaluate(() => Array.from(document.querySelectorAll("#vertex-ctx-menu button")).map((b) => b.textContent));
    check("end vertex: no 'Split at this node'", endMenu.length >= 1 && !endMenu.includes("Split at this node"), endMenu);
    await page.mouse.click(5, 5); await page.waitForTimeout(100);
    await page.mouse.click(V1.x, V1.y, { button: "right" }); await page.waitForTimeout(150);
    const midMenu = await page.evaluate(() => Array.from(document.querySelectorAll("#vertex-ctx-menu button")).map((b) => b.textContent));
    check("interior vertex: 'Split at this node' next to 'Delete node'", midMenu[0] === "Delete node" && midMenu[1] === "Split at this node", midMenu);
    await page.evaluate(() => document.getElementById("vertex-ctx-split").click());
    await page.waitForTimeout(150);
    const nd = await page.evaluate(() => ({ dlg: !!document.querySelector(".fm-dialog"), editing: App._editing, names: document.querySelectorAll(".fs-piece-row").length }));
    check("dialog opens after leaving vertex-edit mode, 2 pieces", nd.dlg && nd.editing === null && nd.names === 2, nd);
    await page.keyboard.press("Enter"); await page.waitForTimeout(200);
    const nl = await page.evaluate(() => ({ a: App.lines[0].geometry.coordinates, b: App.lines[2].geometry.coordinates }));
    check("line node split: cut exactly at the vertex (no new vertex)", JSON.stringify(nl.a) === JSON.stringify([LINE[0], LINE[1]]) &&
      JSON.stringify(nl.b) === JSON.stringify([LINE[1], LINE[2], LINE[3]]), nl);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(500);
    check("node split then Undo restores exactly", (await snapshot(page)) === nodeBefore);

    await view([-104.785, 38.82], 14);
    await page.evaluate(() => App.selectFeature("route", 0));
    await page.waitForTimeout(150);
    const W1 = await px(ROUTE[2]);
    await page.mouse.click(W1.x, W1.y, { button: "right" }); await page.waitForTimeout(150);
    const rMenu = await page.evaluate(() => Array.from(document.querySelectorAll("#vertex-ctx-menu button")).map((b) => b.textContent));
    check("route interior waypoint: 'Split at this node' offered", rMenu.includes("Split at this node"), rMenu);
    await page.evaluate(() => document.getElementById("vertex-ctx-split").click());
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter"); await page.waitForTimeout(200);
    const rn = await page.evaluate(() => ({ a: App.routes[0].geometry.coordinates, b: App.routes[2].geometry.coordinates,
      aw: App.routes[0].properties.waypoints, bw: App.routes[2].properties.waypoints }));
    check("route node split: pieces meet exactly at the waypoint's geometry position; waypoints are [first, node] / [node, last]",
      JSON.stringify(rn.a) === JSON.stringify([ROUTE[0], ROUTE[1], ROUTE[2]]) && JSON.stringify(rn.b) === JSON.stringify([ROUTE[2], ROUTE[3]]) &&
      JSON.stringify(rn.aw) === JSON.stringify([ROUTE[0], ROUTE[2]]) && JSON.stringify(rn.bw) === JSON.stringify([ROUTE[2], ROUTE[3]]), rn);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(500);
    // ================= END PHASE 2 =================

    // ================= PHASE 3 =================
    console.log("\n# Phase 3: module usage warnings + opposite-direction split");
    await loadFixture(page);
    const far = await page.evaluate(() => { const p = App.split.analyze("route", 0, [-104.785, 38.8201]);
      return { has: !!p.opposite, av: p.opposite && p.opposite.available, why: p.opposite && p.opposite.reason }; });
    check("opposite direction ~1100 ft away: option offered but unavailable, with the reason", far.has && far.av === false && /300 ft/.test(far.why), far);
    // Bring Red SB within ~180 ft and give Title VI a 'before' ref to Red (route 5).
    await page.evaluate(({ ROUTE }) => {
      var st = App.cache.collectState("full");
      var sb = ROUTE.slice().reverse().map((c) => [c[0], c[1] + 0.0005]);
      st.routes[1].geometry.coordinates = sb;
      st.routes[1].properties.waypoints = [sb[0], sb[3]];
      st.moduleState = st.moduleState || {};
      st.moduleState["title-vi"] = { version: 3, policy: TitleVI.defaultPolicy(), activeScenarioIdx: 0, baselineFeatureFilter: null,
        scenarios: [{ name: "Scenario A", impactMethod: "service_loss_area", alterations: [{ name: "Adjustment 1", changeType: "adjustment",
          before: { featureType: "route", featureId: 5, featureName: "Red" }, after: null, computed: null, manual: {} }] }] };
      App.cache.applyState(st);
    }, { ROUTE });
    const usage = await page.evaluate(() => App.describeFeatureUsage("route", 5));
    check("describeFeatureUsage reports the Title VI 'before' ref as a warning",
      usage.some((u) => u.severity === "warn" && u.label === "Title VI · Scenario A · 'before' of Adjustment 1"), usage);
    check("a throwing provider is ignored", await page.evaluate(() => { App.registerFeatureUsage(() => { throw new Error("x"); });
      return Array.isArray(App.describeFeatureUsage("route", 5)); }));
    const p3 = await page.evaluate(() => { const p = App.split.analyze("route", 0, [-104.785, 38.8201]);
      return { av: p.opposite && p.opposite.available, why: p.opposite && p.opposite.reason, pairOf: p.opposite && p.opposite.pairOf, warn: p.usage.warn }; });
    check("opposite direction ~180 ft away: available, its pieces pair in reverse order", p3.av === true && JSON.stringify(p3.pairOf) === "[1,0]", p3);
    await page.evaluate(() => App.split.openDialog("route", 0, [-104.785, 38.8201]));
    await page.waitForTimeout(150);
    const dl = await page.evaluate(() => ({ cb: !!document.getElementById("fsOpposite") && !document.getElementById("fsOpposite").disabled,
      warn: (document.querySelector(".fm-usage-warn") || {}).textContent || "",
      pair: getComputedStyle(document.querySelector(".fs-pair-warn")).display }));
    check("Split dialog: Title VI usage warning shown; opposite checkbox enabled; pair warning visible while unchecked",
      dl.cb && /Title VI · Scenario A · 'before' of Adjustment 1/.test(dl.warn) && /part 1/.test(dl.warn) && dl.pair !== "none", dl);
    const before3 = await snapshot(page);
    await page.evaluate(() => { const cb = document.getElementById("fsOpposite"); cb.checked = true; cb.dispatchEvent(new Event("change")); });
    const dl2 = await page.evaluate(() => ({ rows: document.querySelectorAll(".fs-opposite-body .fs-piece-row").length,
      svc: Array.from(document.querySelectorAll(".fs-piece-svc")).map((e) => e.textContent),
      pair: getComputedStyle(document.querySelector(".fs-pair-warn")).display }));
    check("checked: opposite pieces shown with their Service ids, pair warning hidden",
      dl2.rows === 2 && JSON.stringify(dl2.svc) === JSON.stringify(["Service 'R (2)'", "Service 'R'"]) && dl2.pair === "none", dl2);
    await page.evaluate(() => Array.from(document.querySelectorAll(".fm-dialog button")).find((b) => b.textContent === "Split").click());
    await page.waitForTimeout(200);
    const after3 = await page.evaluate(() => ({
      r: App.routes.map((f) => ({ n: f.properties.name, s: f.properties.attributes.serviceId, d: f.properties.attributes.direction, x0: f.geometry.coordinates[0][0] })),
      svcs: App.buildTransitServices().filter((s) => s.isGroup && /^service-R/.test(s.key)).map((s) => ({ k: s.key, n: s.patterns.length,
        w: (s.warnings || []).map((w) => w.msg || w).filter((m) => /opposite|pair/i.test(m)) })) }));
    const east = after3.r.filter((r) => r.s === "R (2)");
    check("both directions split in one go: 4 routes; the two east pieces share 'R (2)', the west pieces keep 'R'",
      after3.r.length === 4 && east.length === 2 && east.every((r) => r.x0 > -104.7851 || r.x0 === -104.77) &&
      after3.r.filter((r) => r.s === "R").length === 2, after3.r);
    check("App.buildTransitServices: two 2-pattern Services, no pairing warnings",
      after3.svcs.length === 2 && after3.svcs.every((s) => s.n === 2 && s.w.length === 0), after3.svcs);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(400);
    check("one Undo restores both directions", (await snapshot(page)) === before3);
    // Two-cut section split with the opposite direction.
    const secOpp = await page.evaluate(() => {
      const r = App.split.run("route", 0, [[-104.795, 38.8201], [-104.775, 38.8201]], { opposite: true });
      return { ok: r.ok, err: r.errors, n: App.routes.length, opp: r.opposite && r.opposite.indices.length,
        svcs: App.buildTransitServices().filter((s) => s.isGroup && /^service-R/.test(s.key)).map((s) => ({ n: s.patterns.length, dirs: s.patterns.map((p) => p.direction).sort().join("+"),
          w: (s.warnings || []).length })) };
    });
    check("section split with opposite: 6 routes form three valid NB+SB pairs",
      secOpp.ok && secOpp.n === 6 && secOpp.opp === 3 && secOpp.svcs.length === 3 && secOpp.svcs.every((s) => s.n === 2 && s.dirs === "NB+SB"), secOpp);
    await page.evaluate(() => App.undo.undo()); await page.waitForTimeout(400);
    check("section split then one Undo restores both", (await snapshot(page)) === before3);
    // Merge dialog shows usage for every feature being merged.
    await page.evaluate(() => App.merge.openDialog("route", [1, 0], 1));
    await page.waitForTimeout(300);
    const mw = await page.evaluate(() => ({ warn: (document.querySelector(".fm-usage-warn") || {}).textContent || "",
      info: (document.querySelector(".fm-usage-info") || {}).textContent || "" }));
    check("Merge dialog: Title VI ref on the removed feature warns it will be missing",
      /Title VI · Scenario A · 'before' of Adjustment 1 — 'Red' is removed by the merge/.test(mw.warn), mw);
    await page.evaluate(() => App.merge.closeDialog());
    // ================= END PHASE 3 =================

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
