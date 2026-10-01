#!/usr/bin/env node
// test/feature-color-smoke.mjs
//
// Browser smoke test for color sync (docs/feature-color-sync-plan.md): the
// Features-pane icon, the Attributes pop-up swatch and the Layers-pane Style
// defaults preview must match what the map draws, and "last action wins"
// between feature-level colors (Features) and type-wide colors (Layers).
//
// USAGE (Playwright is not an npm dependency of this repo — see
// test/ui-screens/capture.mjs for the one-time install):
//   NODE_PATH=/path/to/playwright/node_modules node test/feature-color-smoke.mjs
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
const SHOT_DIR = process.env.COLOR_SHOT_DIR || os.tmpdir();

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
const feat = (props, coords) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
async function loadFixture(page) {
  await page.evaluate(() => {
    var st = App.cache.collectState("full");
    st.labels = []; st.polygons = []; st.points = [];
    st.sectionColors = { point: null, line: null, route: null, polygon: null, label: null };
    st.lines = [0, 1, 2].map((i) => ({ type: "Feature", properties: { name: "Line " + (i + 1), lineIdx: i + 1, waypoints: 2, color: "", colorSeq: i, attributes: {} },
      geometry: { type: "LineString", coordinates: [[-104.80, 38.80 + i * 0.002], [-104.79, 38.80 + i * 0.002]] } }));
    st.routes = [0, 1].map((i) => ({ type: "Feature", properties: { name: "Route " + (i + 1), routeIdx: i + 1, waypoints: [], color: "", colorSeq: 3 + i, attributes: {} },
      geometry: { type: "LineString", coordinates: [[-104.80, 38.82 + i * 0.002], [-104.79, 38.82 + i * 0.002]] } }));
    App.cache.applyState(st);
    App.refreshFeaturePanel();
  });
}
// Color of the Features-pane icon on the row named `name`, as #rrggbb.
const iconColor = (page, name) => page.evaluate((name) => {
  var rows = Array.prototype.slice.call(document.querySelectorAll("#fp-tab-features .fp-item"));
  var row = rows.filter((r) => { var n = r.querySelector(".fp-name"); return n && n.textContent === name; })[0];
  if (!row) return "no-row";
  var m = row.querySelector(".fp-type-icon").style.color.match(/\d+/g);
  return "#" + m.slice(0, 3).map((x) => ("0" + (+x).toString(16)).slice(-2)).join("");
}, name);
const mapColor = (page, type, idx) => page.evaluate(([type, idx]) => {
  var f = { line: App.lines, route: App.routes }[type][idx];
  var c = App.resolveFeatureColor(type, f);
  // normalize to #rrggbb lower-case
  return c.toLowerCase();
}, [type, idx]);
const renderedColor = (page, type, idx) => page.evaluate(([type, idx]) => {
  // What the map source actually carries for this feature.
  var src = App.map.getSource(type === "line" ? "lines" : "routes");
  var data = src && src._data;
  var id = { line: App.lines, route: App.routes }[type][idx].properties[type === "line" ? "lineIdx" : "routeIdx"];
  var f = data && data.features && data.features.filter((x) => x.properties[type === "line" ? "lineIdx" : "routeIdx"] === id)[0];
  return f ? (f.properties.resolvedColor || "").toLowerCase() : "no-source";
}, [type, idx]);
const previewStroke = (page, label) => page.evaluate((label) => {
  var groups = Array.prototype.slice.call(document.querySelectorAll(".lp-style-group"));
  var g = groups.filter((x) => (x.querySelector(".lp-row-label") || {}).textContent === label)[0];
  if (!g) return "no-group";
  var segs = g.querySelectorAll(".lp-style-preview .lp-preview-seg");
  if (segs.length) return "rainbow:" + segs.length + ":" + new Set(Array.prototype.map.call(segs, (x) => x.getAttribute("stroke"))).size;
  var l = g.querySelector(".lp-style-preview line");
  return l ? l.getAttribute("stroke") : "no-line";
}, label);

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
    await page.evaluate(() => App.map.jumpTo({ center: [-104.795, 38.81], zoom: 14 }));
    await loadFixture(page);
    await page.waitForTimeout(300);

    // ================= ASSERTIONS =================
    console.log("\n# Automatic: icons match the map");
    const names = [["line", 0, "Line 1"], ["line", 1, "Line 2"], ["line", 2, "Line 3"], ["route", 0, "Route 1"], ["route", 1, "Route 2"]];
    const icons = [], maps = [];
    for (const [t, i, n] of names) { icons.push(await iconColor(page, n)); maps.push(await mapColor(page, t, i)); }
    check("each Features-pane icon equals the resolved (map) color", JSON.stringify(icons) === JSON.stringify(maps), { icons, maps });
    check("rainbow: the five features have five different colors", new Set(icons).size === 5, icons);
    const rendered = [];
    for (const [t, i] of names) rendered.push(await renderedColor(page, t, i));
    check("map source carries the same colors", JSON.stringify(rendered) === JSON.stringify(maps), { rendered, maps });

    console.log("\n# Newly drawn line shows its rainbow color too");
    await page.evaluate(() => { App.drawMode = null; });
    const newIdx = await page.evaluate(() => {
      var before = App.lines.length;
      App.handleLineClick({ lng: -104.80, lat: 38.85 }); App.handleLineClick({ lng: -104.79, lat: 38.85 });
      App.saveLine && App.saveLine();
      return App.lines.length > before ? App.lines.length - 1 : -1;
    });
    if (newIdx >= 0) {
      await page.evaluate(() => App.refreshFeaturePanel());
      const nm = await page.evaluate((i) => App.lines[i].properties.name, newIdx);
      check("new line's icon equals its map color (not the type default)", (await iconColor(page, nm)) === (await mapColor(page, "line", newIdx)));
      await page.evaluate(() => { App.lines.pop(); App.renderLineLayers(); App.refreshFeaturePanel(); });
    } else {
      check("(skipped) could not draw a line via the API", true);
    }

    console.log("\n# Layers pane: preview");
    await page.click('.fp-tab-btn[data-fptab="layers"]');
    await page.waitForTimeout(300);
    check("Lines preview is six rainbow segments while Automatic", /^rainbow:6:6$/.test(await previewStroke(page, "Lines")), await previewStroke(page, "Lines"));
    check("Routes preview is six rainbow segments while Automatic", /^rainbow:6:6$/.test(await previewStroke(page, "Routes")), await previewStroke(page, "Routes"));

    console.log("\n# Attributes pop-up swatch");
    await page.evaluate(() => App.openAttrPopup("line", 1, App.lines[1]));
    await page.waitForTimeout(200);
    const sw = () => page.evaluate(() => { var m = document.querySelector(".fp-attr-popup-swatch").style.background.match(/\d+/g);
      return "#" + m.slice(0, 3).map((x) => ("0" + (+x).toString(16)).slice(-2)).join(""); });
    check("pop-up swatch = the line's real (rainbow) color", (await sw()) === (await mapColor(page, "line", 1)), await sw());

    console.log("\n# Last action wins");
    await page.evaluate(() => { window.__pushes = 0; var o = App.undo.push; App.undo.push = function () { window.__pushes++; return o.apply(this, arguments); }; });
    await page.evaluate(() => App.setTypeColor("line", "#0000ff"));
    let cs = [];
    for (let i = 0; i < 3; i++) cs.push(await iconColor(page, "Line " + (i + 1)));
    check("Layers: all Lines blue -> every icon blue", cs.every((c) => c === "#0000ff"), cs);
    check("Layers: Routes untouched (still rainbow)", (await iconColor(page, "Route 1")) !== (await iconColor(page, "Route 2")));
    check("Layers: Lines preview shows the flat blue", (await previewStroke(page, "Lines")) === "#0000ff", await previewStroke(page, "Lines"));
    check("Attributes pop-up swatch followed the Layers change", (await sw()) === "#0000ff", await sw());
    await page.evaluate(() => App.updateFeatureColor("line", 1, "#ff0000"));
    cs = [];
    for (let i = 0; i < 3; i++) cs.push(await iconColor(page, "Line " + (i + 1)));
    check("Features: Line 2 red, the others stay blue", JSON.stringify(cs) === JSON.stringify(["#0000ff", "#ff0000", "#0000ff"]), cs);
    check("Features: map agrees (Line 2 red)", (await renderedColor(page, "line", 1)) === "#ff0000");
    await page.evaluate(() => App.setTypeColor("line", "#00aa00"));
    cs = [];
    for (let i = 0; i < 3; i++) cs.push(await iconColor(page, "Line " + (i + 1)));
    check("Layers: all Lines green -> Line 2 turns green too", cs.every((c) => c === "#00aa00"), cs);
    check("Layers: map agrees for all three", (await Promise.all([0, 1, 2].map((i) => renderedColor(page, "line", i)))).every((c) => c === "#00aa00"));
    check("Layers: Line 2's own color was cleared", await page.evaluate(() => App.lines[1].properties.color === ""));
    check("Layers change = one undo snapshot each (3 pushes total incl. Line 2 edit)", (await page.evaluate(() => window.__pushes)) === 3);
    await page.evaluate(() => App.undo.undo());
    cs = [];
    for (let i = 0; i < 3; i++) cs.push(await iconColor(page, "Line " + (i + 1)));
    check("Ctrl+Z restores Line 2 red and the others blue", JSON.stringify(cs) === JSON.stringify(["#0000ff", "#ff0000", "#0000ff"]), cs);

    console.log("\n# Reset to Automatic (x button) clears overrides too");
    await page.click('.fp-tab-btn[data-fptab="layers"]');
    await page.waitForTimeout(300);
    const clicked = await page.evaluate(() => {
      var g = Array.prototype.slice.call(document.querySelectorAll(".lp-style-group")).filter((x) => (x.querySelector(".lp-row-label") || {}).textContent === "Lines")[0];
      var b = g && g.querySelector(".lp-style-clear");
      if (!b) return false; b.click(); return true;
    });
    check("x button is present for a flat Lines color", clicked);
    await page.waitForTimeout(200);
    const after = [];
    for (let i = 0; i < 3; i++) after.push(await iconColor(page, "Line " + (i + 1)));
    const expect = [];
    for (let i = 0; i < 3; i++) expect.push(await mapColor(page, "line", i));
    check("every line is back on its rainbow color (including the custom red one)", JSON.stringify(after) === JSON.stringify(expect) && new Set(after).size === 3, { after, expect });
    check("Lines preview is six rainbow segments again", /^rainbow:6:6$/.test(await previewStroke(page, "Lines")));

    console.log("\n# Points and polygons follow the same rule");
    await page.evaluate(() => {
      var st = App.cache.collectState("full");
      st.points = [{ type: "Feature", properties: { name: "P1", pointIdx: 1, color: "#ff00ff", attributes: {} }, geometry: { type: "Point", coordinates: [-104.80, 38.83] } }];
      st.polygons = [{ type: "Feature", properties: { name: "Poly 1", polyIdx: 1, color: "#00ffff", attributes: {} },
        geometry: { type: "Polygon", coordinates: [[[-104.81, 38.84], [-104.80, 38.84], [-104.80, 38.85], [-104.81, 38.84]]] } }];
      App.cache.applyState(st);
    });
    await page.evaluate(() => { App.setTypeColor("point", "#112233"); App.setTypeColor("polygon", "#445566"); });
    check("point + polygon own colors cleared; resolve to the type color", await page.evaluate(() =>
      App.points[0].properties.color === "" && App.polygons[0].properties.color === "" &&
      App.resolveFeatureColor("point", App.points[0]) === "#112233" && App.resolveFeatureColor("polygon", App.polygons[0]) === "#445566"));
    check("Features-pane icons for point/polygon match", (await iconColor(page, "P1")) === "#112233" && (await iconColor(page, "Poly 1")) === "#445566",
      [await iconColor(page, "P1"), await iconColor(page, "Poly 1")]);

    console.log("\n# Persistence");
    await page.evaluate(() => App.setTypeColor("route", "#abcdef"));
    await page.evaluate(() => App.cache.save());
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && App.routes.length === 2", { timeout: 30000 });
    check("type color survives reload; route overrides stay cleared", await page.evaluate(() =>
      App.sectionColors.route === "#abcdef" && App.routes.every((r) => !r.properties.color)));
    // ================= END ASSERTIONS =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
