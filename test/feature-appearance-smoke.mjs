#!/usr/bin/env node
// test/feature-appearance-smoke.mjs
//
// Browser smoke test for the shared Appearance popover
// (docs/feature-appearance-plan.md, Phase 1): it opens from the Features-pane
// icon, the Attributes pop-up swatch, the Layers-tab row swatch and the
// Attribute Summary swatch; edits color / opacity / width / offset with the
// muted-default + x-clear semantics; takes one undo step per gesture; and the
// old Attributes override-icon strip is gone. Phase 2: per-feature buffer
// radius lives in the Attributes popup's Study area section, the Attribute
// Summary Buffer column and Copy Attributes (not the Layers drawer).
//
// USAGE (Playwright is not an npm dependency of this repo — see
// test/ui-screens/capture.mjs for the one-time install):
//   NODE_PATH=/path/to/playwright/node_modules node test/feature-appearance-smoke.mjs
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
const SHOT_DIR = process.env.APPEARANCE_SHOT_DIR || os.tmpdir();

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
async function loadFixture(page) {
  await page.evaluate(() => {
    var st = App.cache.collectState("full");
    st.labels = [];
    st.sectionColors = { point: null, line: null, route: null, polygon: null, label: null };
    st.points = [{ type: "Feature", properties: { name: "P1", pointIdx: 1, color: "", attributes: {} }, geometry: { type: "Point", coordinates: [-104.80, 38.83] } }];
    st.lines = [0, 1].map((i) => ({ type: "Feature", properties: { name: "Line " + (i + 1), lineIdx: i + 1, waypoints: 2, color: "", colorSeq: i, attributes: {} },
      geometry: { type: "LineString", coordinates: [[-104.80, 38.80 + i * 0.002], [-104.79, 38.80 + i * 0.002]] } }));
    st.routes = [{ type: "Feature", properties: { name: "Route 1", routeIdx: 1, waypoints: [], color: "", colorSeq: 3, attributes: {} },
      geometry: { type: "LineString", coordinates: [[-104.80, 38.82], [-104.79, 38.82]] } }];
    st.polygons = [{ type: "Feature", properties: { name: "Poly 1", polyIdx: 1, color: "", attributes: {} },
      geometry: { type: "Polygon", coordinates: [[[-104.81, 38.84], [-104.80, 38.84], [-104.80, 38.85], [-104.81, 38.84]]] } }];
    App.cache.applyState(st);
    App.refreshFeaturePanel();
  });
}
const POP = "#fp-appearance-popover";
const popOpen = (page) => page.evaluate((s) => !!document.querySelector(s), POP);
const popTitle = (page) => page.evaluate((s) => { var e = document.querySelector(s + " .fa-title"); return e ? e.textContent : ""; }, POP);
// Row inside the popover by its label ("Opacity", "Weight", "Offset", ...).
const rowInput = (page, label) => page.locator(POP + " .lp-style-row", { has: page.locator(".lp-style-label", { hasText: new RegExp("^" + label + "$") }) }).locator(".fp-scrub-input");
const rowClear = (page, label) => page.locator(POP + " .lp-style-row", { has: page.locator(".lp-style-label", { hasText: new RegExp("^" + label + "$") }) }).locator(".lp-style-clear");
const rowInherited = (page, label) => page.evaluate(([s, label]) => {
  var rows = Array.prototype.slice.call(document.querySelectorAll(s + " .lp-style-row"));
  var r = rows.filter((x) => (x.querySelector(".lp-style-label") || {}).textContent === label)[0];
  return r ? r.classList.contains("lp-inherited") : "no-row";
}, [POP, label]);
const typeValue = async (page, label, v) => { const i = rowInput(page, label); await i.fill(String(v)); await i.press("Tab"); };
const props = (page, type, idx) => page.evaluate(([type, idx]) => JSON.parse(JSON.stringify(({ point: App.points, line: App.lines, route: App.routes, polygon: App.polygons })[type][idx].properties)), [type, idx]);

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
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && typeof App.buildScrubber === \"function\"", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());
    await page.evaluate(() => App.map.jumpTo({ center: [-104.795, 38.81], zoom: 14 }));
    await loadFixture(page);
    await page.waitForTimeout(300);

    // ================= ASSERTIONS =================
    console.log("\n# Opens from all four surfaces");
    await page.locator('#fp-tab-features .fp-item', { hasText: "Line 1" }).locator(".fp-type-icon").click();
    check("Features-pane icon opens the popover", await popOpen(page) && /Line 1/.test(await popTitle(page)), await popTitle(page));
    await page.keyboard.press("Escape");
    check("Escape closes it", !(await popOpen(page)));

    await page.evaluate(() => App.openAttrPopup("line", 1, App.lines[1]));
    await page.waitForTimeout(200);
    await page.click(".fp-attr-popup-swatch");
    check("Attributes header swatch opens it", await popOpen(page) && /Line 2/.test(await popTitle(page)), await popTitle(page));
    check("Attributes popup no longer has the override icon strip", await page.evaluate(() => !document.querySelector("#fp-attr-popup .fp-attr-overrides")));
    check("App.buildOverrideIcons is retired", await page.evaluate(() => typeof App.buildOverrideIcons === "undefined"));
    await page.keyboard.press("Escape");
    await page.evaluate(() => App.closeAttrPopup());

    await page.click('.fp-tab-btn[data-fptab="layers"]');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      var lab = Array.prototype.slice.call(document.querySelectorAll("#fp-tab-layers .lp-row-label")).filter((x) => x.textContent === "Route 1")[0];
      lab.parentElement.querySelector(".fp-type-icon").click();
    });
    check("Layers-tab row swatch opens it", await popOpen(page) && /Route 1/.test(await popTitle(page)), await popTitle(page));
    check("Route popover has Offset; no Buffer row", await page.evaluate((s) => {
      var l = Array.prototype.map.call(document.querySelectorAll(s + " .lp-style-label"), (x) => x.textContent);
      return l.indexOf("Offset") >= 0 && l.indexOf("Buffer") < 0 && l.indexOf("Opacity") >= 0 && l.indexOf("Weight") >= 0 && l.indexOf("Color") >= 0;
    }, POP));
    await page.keyboard.press("Escape");

    await page.evaluate(() => App.openAttributeSummary());
    await page.waitForTimeout(500);
    await page.locator('.as-swatch').first().click();
    check("Attribute Summary swatch opens it", await popOpen(page), await popTitle(page));
    await page.keyboard.press("Escape");
    await page.evaluate(() => App.popup.close());
    await page.click('.fp-tab-btn[data-fptab="features"]');

    console.log("\n# Toggle and outside-click dismissal");
    const icon = page.locator('#fp-tab-features .fp-item', { hasText: "Line 1" }).locator(".fp-type-icon");
    await icon.click();
    check("open", await popOpen(page));
    await icon.click();
    check("clicking the same icon again closes it (toggle)", !(await popOpen(page)));
    await icon.click();
    await page.mouse.click(700, 600);
    check("outside click closes it", !(await popOpen(page)));

    console.log("\n# Opacity / width / offset on a line (Line 1)");
    await icon.click();
    check("Opacity starts muted (inherited)", (await rowInherited(page, "Opacity")) === true);
    await typeValue(page, "Opacity", 50);
    let p = await props(page, "line", 0);
    check("opacity writes properties._opacity = 0.5", p._opacity === 0.5, p._opacity);
    check("row no longer muted; x visible", (await rowInherited(page, "Opacity")) === false && await rowClear(page, "Opacity").isVisible());
    check("map source carries the override", await page.evaluate(() => {
      var d = App.map.getSource("lines")._data; var f = d.features.filter((x) => x.properties.lineIdx === 1)[0];
      return f && f.properties._opacity === 0.5 && !!App.map.getLayer("lines-layer");
    }));
    await rowClear(page, "Opacity").click();
    p = await props(page, "line", 0);
    check("x clears _opacity", p._opacity === undefined && (await rowInherited(page, "Opacity")) === true, p._opacity);
    await typeValue(page, "Weight", 2.5);
    p = await props(page, "line", 0);
    check("weight writes _lineWidth", p._lineWidth === 2.5, p._lineWidth);
    await typeValue(page, "Offset", 3);
    p = await props(page, "line", 0);
    check("offset writes _offset + _offsetManual", p._offset === 3 && p._offsetManual === true, [p._offset, p._offsetManual]);
    await rowClear(page, "Offset").click();
    p = await props(page, "line", 0);
    check("offset x clears both", p._offset === undefined && p._offsetManual === undefined);

    console.log("\n# Color row");
    await page.locator(POP + " .fp-cp-cell").nth(14).click();
    const picked = await page.evaluate(() => document.querySelectorAll("#fp-appearance-popover .fp-cp-cell")[14].title);
    p = await props(page, "line", 0);
    check("palette click sets properties.color", p.color === picked, [p.color, picked]);
    check("popover stays open after a pick", await popOpen(page));
    check("Features icon followed the pick", await page.evaluate((c) => {
      var r = Array.prototype.filter.call(document.querySelectorAll("#fp-tab-features .fp-item"), (x) => x.querySelector(".fp-name").textContent === "Line 1")[0];
      var m = r.querySelector(".fp-type-icon").style.color.match(/\d+/g);
      return "#" + m.slice(0, 3).map((x) => ("0" + (+x).toString(16)).slice(-2)).join("") === c;
    }, picked));
    await page.locator(POP + " .fa-color-row .lp-style-clear").click();
    p = await props(page, "line", 0);
    check("color x clears back to inherit", p.color === "", p.color);

    console.log("\n# Last action wins still holds");
    await page.locator(POP + " .fp-cp-cell").nth(3).click();
    await page.evaluate(() => App.setTypeColor("line", "#123456"));
    check("Layers type color clears the per-feature color", (await props(page, "line", 0)).color === "");
    await page.keyboard.press("Escape");

    console.log("\n# Undo: one step per gesture");
    await page.evaluate(() => { while (App.undo.canUndo()) App.undo.undo(); });
    await icon.click();
    const field = rowInput(page, "Opacity");
    const box = await field.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 5, { steps: 6 });
    await page.mouse.move(box.x + 120, box.y + 5, { steps: 6 });
    await page.mouse.up();
    p = await props(page, "line", 0);
    check("drag changed opacity", p._opacity !== undefined, p._opacity);
    check("a whole drag is ONE undo step", await page.evaluate(() => { var n = 0; while (App.undo.canUndo() && n < 50) { App.undo.undo(); n++; } return n; }) === 1);
    p = await props(page, "line", 0);
    check("undoing it restores no override", p._opacity === undefined, p._opacity);
    await page.keyboard.press("Escape");
    await icon.click();
    const w = page.locator(POP + " .lp-style-row", { has: page.locator(".lp-style-label", { hasText: /^Weight$/ }) });
    await w.locator(".fp-scrub-inc").click();
    await w.locator(".fp-scrub-inc").click();
    p = await props(page, "line", 0);
    check("two + clicks -> 1.2", Math.abs(p._lineWidth - 1.2) < 1e-9, p._lineWidth);
    await page.evaluate(() => App.undo.undo());
    p = await props(page, "line", 0);
    check("two discrete clicks are two undo steps (one undo -> 1.1)", Math.abs(p._lineWidth - 1.1) < 1e-9, p._lineWidth);
    await page.evaluate(() => { while (App.undo.canUndo()) App.undo.undo(); });
    check("a color pick is one undo step", await (async () => {
      await page.keyboard.press("Escape");
      await icon.click();
      await page.locator(POP + " .fp-cp-cell").nth(5).click();
      return await page.evaluate(() => { var n = 0; while (App.undo.canUndo() && n < 50) { App.undo.undo(); n++; } return n; }) === 1;
    })());
    // Ctrl+Z with the popover open rebuilds from the restored feature.
    await page.keyboard.press("Escape");
    await icon.click();
    await typeValue(page, "Opacity", 30);
    await page.locator(POP + " .fa-title").click();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(150);
    check("Ctrl+Z restores the value and the popover shows it muted again", (await props(page, "line", 0))._opacity === undefined && (await rowInherited(page, "Opacity")) === true);

    console.log("\n# Reset all is one undo step");
    await typeValue(page, "Opacity", 40);
    await typeValue(page, "Weight", 3);
    await page.locator(POP + " .fp-cp-cell").nth(7).click();
    await page.evaluate(() => { while (App.undo.canUndo()) App.undo.undo(); window.__n = 0; });
    await icon.click().catch(() => {});
    if (!(await popOpen(page))) await icon.click();
    await typeValue(page, "Opacity", 40);
    await typeValue(page, "Weight", 3);
    await page.locator(POP + " .fp-cp-cell").nth(7).click();
    await page.evaluate(() => { var o = App.undo.push; window.__pushes = 0; App.undo.push = function () { window.__pushes++; return o.apply(this, arguments); }; });
    await page.locator(POP + " .fa-reset").click();
    p = await props(page, "line", 0);
    check("Reset all clears color/opacity/width", p.color === "" && p._opacity === undefined && p._lineWidth === undefined, p);
    check("Reset all pushes exactly one undo snapshot", (await page.evaluate(() => window.__pushes)) === 1);
    await page.keyboard.press("Escape");

    console.log("\n# Polygon opacity writes both keys");
    await page.locator('#fp-tab-features .fp-item', { hasText: "Poly 1" }).locator(".fp-type-icon").click();
    check("polygon popover has no Offset", await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + " .lp-style-label"), (x) => x.textContent).indexOf("Offset") < 0, POP));
    await typeValue(page, "Opacity", 80);
    p = await props(page, "polygon", 0);
    check("polygon writes _fillOpacity and _borderOpacity", typeof p._fillOpacity === "number" && typeof p._borderOpacity === "number" && p._opacity === undefined, p);
    await rowClear(page, "Opacity").click();
    p = await props(page, "polygon", 0);
    check("polygon x clears both", p._fillOpacity === undefined && p._borderOpacity === undefined);
    await page.keyboard.press("Escape");

    console.log("\n# Stale feature / merge safety");
    await page.locator('#fp-tab-features .fp-item', { hasText: "P1" }).locator(".fp-type-icon").click();
    check("point popover opens", await popOpen(page));
    await page.evaluate(() => { App.removePoint(0); });
    await page.evaluate(() => App.refreshFeaturePanel());
    await page.waitForTimeout(100);
    const typed = rowInput(page, "Opacity");
    if (await typed.count()) { await typeValue(page, "Opacity", 20); }
    check("deleting the feature while open never throws / leaves a ghost write", await page.evaluate(() => App.points.every((f) => f.properties._opacity === undefined || f.properties._opacity === 0.2)));
    await page.keyboard.press("Escape");
    await page.evaluate(() => App.closeAppearancePopup());

    console.log("\n# Layers drawer shares the rows (and now has undo)");
    await page.click('.fp-tab-btn[data-fptab="layers"]');
    await page.waitForTimeout(300);
    await page.evaluate(() => { while (App.undo.canUndo()) App.undo.undo(); });
    const rowOf = (name) => `(() => { var lab = Array.prototype.slice.call(document.querySelectorAll("#fp-tab-layers .lp-row-label")).filter((x) => x.textContent === "${name}")[0]; return lab.parentElement; })()`;
    await page.evaluate(`${rowOf("Line 2")}.querySelector(".lp-caret").click()`);
    await page.waitForTimeout(200);
    const drawerInfo = await page.evaluate(`(() => { var d = ${rowOf("Line 2")}.parentElement.querySelector(".lp-style-drawer-feature");
      return d && d.style.display !== "none" ? Array.prototype.map.call(d.querySelectorAll(".lp-style-label"), (x) => x.textContent) : null; })()`);
    check("drawer rows: Opacity, Weight, Offset, Line style (Buffer moved to Attributes in Phase 2)", JSON.stringify(drawerInfo) === JSON.stringify(["Opacity", "Weight", "Offset", "Line style"]), drawerInfo);
    await page.evaluate(`(() => { var d = ${rowOf("Line 2")}.parentElement.querySelector(".lp-style-drawer-feature");
      var r = Array.prototype.filter.call(d.querySelectorAll(".lp-style-row"), (x) => x.querySelector(".lp-style-label").textContent === "Weight")[0];
      var i = r.querySelector(".fp-scrub-input"); i.value = "2"; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    check("drawer edit writes the same override", (await props(page, "line", 1))._lineWidth === 2);
    check("drawer edit is undoable (new in Phase 1)", await page.evaluate(() => { App.undo.undo(); return App.lines[1].properties._lineWidth === undefined; }));

    // ================= PHASE 3: Line style control =================
    console.log("\n# Phase 3: Line style control (lines/routes only)");
    await page.click('.fp-tab-btn[data-fptab="features"]');
    await loadFixture(page);
    await page.waitForTimeout(300);
    const lsBtn = (style) => page.locator(POP + ' .fa-seg-btn[data-style="' + style + '"]');
    const lsClear = () => rowClear(page, "Line style");
    const lsActive = () => page.evaluate((s) => { var b = document.querySelector(s + " .fa-seg-btn.is-active"); return b ? b.getAttribute("data-style") : null; }, POP);
    const lsLayer = (id) => page.evaluate((id) => App.map.queryRenderedFeatures({ layers: [id] }).length, id);
    for (const [type, name, idx] of [["line", "Line 1", 0], ["route", "Route 1", 0]]) {
      await page.locator('#fp-tab-features .fp-item', { hasText: name }).locator(".fp-type-icon").click();
      check(type + ": popover has a Line style row with 3 options", (await page.locator(POP + " .fa-seg-btn").count()) === 3);
      check(type + ": starts Solid, muted, no x", (await lsActive()) === "solid" && (await rowInherited(page, "Line style")) === true && !(await lsClear().isVisible()));
      for (const st of ["dashed", "dotted"]) {
        await lsBtn(st).click();
        p = await props(page, type, idx);
        check(type + ": " + st + " writes _lineStyle", p._lineStyle === st, p._lineStyle);
        check(type + ": " + st + " control active, not muted, x visible", (await lsActive()) === st && (await rowInherited(page, "Line style")) === false && await lsClear().isVisible());
        await page.waitForTimeout(250);
        check(type + ": " + st + " feature renders on the " + st + " layer", (await lsLayer(type === "line" ? "lines-layer-" + st : "routes-layer-" + st)) >= 1);
        check(type + ": " + st + " is one undo step that restores the previous style", await page.evaluate(([t, i, st]) => {
          App.undo.undo();
          var q = ({ line: App.lines, route: App.routes })[t][i].properties._lineStyle;
          App.undo.redo();
          return q === undefined || q === "dashed" && st === "dotted";
        }, [type, idx, st]));
        await page.waitForTimeout(100);
        if (!(await popOpen(page))) await page.locator('#fp-tab-features .fp-item', { hasText: name }).locator(".fp-type-icon").click();
      }
      await lsClear().click();
      p = await props(page, type, idx);
      check(type + ": x clears _lineStyle (back to Solid)", p._lineStyle === undefined && (await lsActive()) === "solid");
      await lsBtn("dashed").click();
      await page.evaluate(() => App.undo.undo());
      await page.waitForTimeout(100);
      check(type + ": undo of a style change removes it", (await props(page, type, idx))._lineStyle === undefined);
      await page.evaluate(() => App.closeAppearancePopup());
    }
    // Reset all clears the style in ONE undo step
    await page.locator('#fp-tab-features .fp-item', { hasText: "Line 1" }).locator(".fp-type-icon").click();
    await lsBtn("dotted").click();
    await typeValue(page, "Weight", 3);
    await page.evaluate(() => { while (App.undo.canUndo()) App.undo.undo(); App.lines[0].properties._lineStyle = "dotted"; App.lines[0].properties._lineWidth = 3; App.undo.push(); window.__base = 0; });
    await page.locator(POP + " .fa-reset").click();
    p = await props(page, "line", 0);
    check("Reset all clears _lineStyle and _lineWidth", p._lineStyle === undefined && p._lineWidth === undefined, p);
    check("Reset all with a line style is exactly one undo step", await page.evaluate(() => { App.undo.undo(); return App.lines[0].properties._lineStyle === "dotted" && App.lines[0].properties._lineWidth === 3; }));
    check("Reset all moved the line back to the solid layer", (await lsActive()) === "solid");
    await page.evaluate(() => { App.closeAppearancePopup(); App.lines[0].properties._lineStyle = undefined; delete App.lines[0].properties._lineStyle; });
    // Points and polygons never show the control
    for (const name of ["P1", "Poly 1"]) {
      await page.locator('#fp-tab-features .fp-item', { hasText: name }).locator(".fp-type-icon").click();
      check(name + ": no Line style row", (await page.locator(POP + " .fa-seg-btn").count()) === 0 && !(await page.evaluate((s) => Array.prototype.some.call(document.querySelectorAll(s + " .lp-style-label"), (x) => x.textContent === "Line style"), POP)));
      await page.evaluate(() => App.closeAppearancePopup());
    }
    // Layers drawer shares the row
    await page.click('.fp-tab-btn[data-fptab="layers"]');
    await page.waitForTimeout(300);
    await page.evaluate(`${rowOf("Line 2")}.querySelector(".lp-caret").click()`);
    await page.waitForTimeout(200);
    await page.evaluate(`${rowOf("Line 2")}.parentElement.querySelector('.lp-style-drawer-feature .fa-seg-btn[data-style="dashed"]').click()`);
    check("Layers drawer segmented control writes the same override", (await props(page, "line", 1))._lineStyle === "dashed");
    await page.evaluate(() => { App.undo.undo(); });
    check("Layers drawer change is undoable", (await props(page, "line", 1))._lineStyle === undefined);

    // ================= PHASE 2: Study area / buffer radius =================
    console.log("\n# Phase 2: buffer radius in the Attributes popup");
    await page.click('.fp-tab-btn[data-fptab="features"]');
    await loadFixture(page);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__p2pushes = 0; window.__notifies = 0; window.__rebuilds = 0;
      var op = App.undo.push; App.undo.push = function () { window.__p2pushes++; return op.apply(this, arguments); };
      var on = App.notifyProject; App.notifyProject = function () { window.__notifies++; return on.apply(this, arguments); };
      var or = App.rebuildBuffers; App.rebuildBuffers = function () { window.__rebuilds++; return or.apply(this, arguments); };
      App.undo.__restore = function () { App.undo.push = op; App.notifyProject = on; App.rebuildBuffers = or; };
    });
    const counters = () => page.evaluate(() => ({ pushes: window.__p2pushes, notifies: window.__notifies, rebuilds: window.__rebuilds }));
    const resetCounters = () => page.evaluate(() => { window.__p2pushes = 0; window.__notifies = 0; window.__rebuilds = 0; });
    const area0 = () => page.evaluate(() => App.buffers[0] ? turf.area(App.buffers[0]) : 0);
    const ATTR = "#fp-attr-popup";
    const bufCtl = () => page.locator(ATTR + " .fp-buffer-ctl");
    const sections = () => page.evaluate((a) => Array.prototype.map.call(document.querySelectorAll(a + " .fp-attr-section"), (x) => x.textContent), ATTR);

    await page.evaluate(() => App.openAttrPopup("point", 0, App.points[0]));
    await page.waitForTimeout(200);
    check("point popup has a Study area section", (await sections()).indexOf("Study area") >= 0, await sections());
    check("Buffer control shows the type default, muted (inherited)", await page.evaluate((a) => {
      var c = document.querySelector(a + " .fp-buffer-ctl");
      return !!c && c.classList.contains("is-inherited") && parseFloat(c.querySelector(".fp-scrub-input").value) === App.featureSettings.bufferRadius;
    }, ATTR));
    check("x is hidden until an override exists", await page.evaluate((a) => document.querySelector(a + " .fp-buffer-ctl .lp-style-clear").style.display === "none", ATTR));

    const before = await area0();
    await resetCounters();
    const inp = bufCtl().locator(".fp-scrub-input");
    await inp.fill("1"); await inp.press("Tab");
    await page.waitForTimeout(150);
    p = await props(page, "point", 0);
    check("typing writes properties._bufferRadius (not attributes)", p._bufferRadius === 1 && p.attributes._bufferRadius === undefined && p.attributes.bufferRadius === undefined, p);
    const after = await area0();
    check("the point's buffer was rebuilt at the new radius", after > before * 1.5 || (before === 0 && after > 0), { before, after });
    let c = await counters();
    check("a typed change = one undo snapshot, one notifyProject", c.pushes === 1 && c.notifies === 1, c);
    check("control is no longer muted and x is shown", await page.evaluate((a) => { var e = document.querySelector(a + " .fp-buffer-ctl"); return !e.classList.contains("is-inherited") && e.querySelector(".lp-style-clear").style.display !== "none"; }, ATTR));

    // Drag-scrub: many ticks, ONE notify + ONE undo step, flushed on mouseup.
    await resetCounters();
    const ibox = await inp.boundingBox();
    await page.mouse.move(ibox.x + ibox.width / 2, ibox.y + ibox.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(ibox.x + ibox.width / 2 + i * 9, ibox.y + ibox.height / 2);
    c = await counters();
    check("during the drag buffers rebuild live but modules are NOT notified", c.rebuilds >= 2 && c.notifies === 0, c);
    await page.mouse.up();
    await page.waitForTimeout(150);
    c = await counters();
    check("drag end: exactly one notifyProject and one undo snapshot", c.notifies === 1 && c.pushes === 1, c);
    p = await props(page, "point", 0);
    check("drag changed the radius", p._bufferRadius !== 1 && p._bufferRadius > 1, p._bufferRadius);

    // x clears; undo restores
    await resetCounters();
    await bufCtl().locator(".lp-style-clear").click();
    await page.waitForTimeout(100);
    p = await props(page, "point", 0);
    check("x clears the override", p._bufferRadius === undefined, p);
    c = await counters();
    check("clear = one undo snapshot, one notify", c.pushes === 1 && c.notifies === 1, c);
    await page.evaluate(() => App.undo.undo());
    check("undo restores the cleared override", (await props(page, "point", 0))._bufferRadius > 1);
    await page.evaluate(() => App.undo.undo());
    await page.evaluate(() => App.undo.undo());

    // Walkshed point: disabled with a note
    console.log("\n# Phase 2: walkshed disables the control");
    await page.evaluate(() => { App.closeAttrPopup(); App.openAttrPopup("point", 0, App.points[0]); });
    await page.waitForTimeout(200);
    check("enabled for a circular-buffer point; note hidden", await page.evaluate((a) => {
      var c = document.querySelector(a + " .fp-buffer-ctl");
      return !c.querySelector(".fp-scrub-input").disabled && c.querySelector(".fp-buffer-note").style.display === "none";
    }, ATTR));
    await page.locator(ATTR + " select.fp-attr-input").first().selectOption("walkshed");
    await page.waitForTimeout(200);
    const wsState = await page.evaluate((a) => {
      var c = document.querySelector(a + " .fp-buffer-ctl");
      var note = c.querySelector(".fp-buffer-note");
      return { disabled: c.querySelector(".fp-scrub-input").disabled, btns: Array.prototype.every.call(c.querySelectorAll(".fp-scrub-btn"), (b) => b.disabled), note: note.style.display !== "none" && /Walkshed/.test(note.textContent) };
    }, ATTR);
    check("walkshed point: control disabled, with a note", wsState.disabled && wsState.btns && wsState.note, wsState);
    await page.locator(ATTR + " select.fp-attr-input").first().selectOption("");
    await page.waitForTimeout(200);
    check("back to circular buffer: control re-enabled", await page.evaluate((a) => !document.querySelector(a + " .fp-buffer-ctl .fp-scrub-input").disabled, ATTR));

    // Lines and routes
    console.log("\n# Phase 2: lines and routes");
    for (const [t, i] of [["line", 0], ["route", 0]]) {
      await page.evaluate(([t, i]) => { App.closeAttrPopup(); App.openAttrPopup(t, i, ({ line: App.lines, route: App.routes })[t][i]); }, [t, i]);
      await page.waitForTimeout(200);
      const secs = await sections();
      check(t + " popup: Study area section with a Buffer control", secs.indexOf("Study area") >= 0 && (await bufCtl().count()) === 1, secs);
      if (t === "route") check("route popup now has Transit service section too", secs[0] === "Transit service", secs);
      const bi = bufCtl().locator(".fp-scrub-input");
      await bi.fill("0.25"); await bi.press("Tab");
      await page.waitForTimeout(150);
      const pr = await props(page, t, i);
      check(t + ": writes _bufferRadius, never attributes", pr._bufferRadius === 0.25 && pr.attributes._bufferRadius === undefined && pr.attributes.bufferRadius === undefined, pr);
      const ba = await page.evaluate((t) => { var b = ({ line: App.lineBuffers, route: App.routeBuffers })[t][0]; return b ? turf.area(b) : 0; }, t);
      check(t + ": buffer rebuilt (non-empty)", ba > 0, ba);
    }
    await page.evaluate(() => App.closeAttrPopup());

    // Attribute Summary
    console.log("\n# Phase 2: Attribute Summary Buffer column");
    await page.evaluate(() => App.openAttributeSummary());
    await page.waitForTimeout(500);
    const asInfo = await page.evaluate(() => {
      function cols(sel) { var h = document.querySelector(sel + " .as-row-header"); var r = document.querySelector(sel + " .as-row:not(.as-row-header)"); return h && r ? { header: h.children.length, row: r.children.length, label: Array.prototype.map.call(h.children, (x) => x.textContent) } : null; }
      return { points: cols('[data-section="point"]'), lines: cols('[data-section="line"]'), routes: cols('[data-section="route"]') };
    });
    check("Points: Buffer header present, header/row column counts match", !!asInfo.points && asInfo.points.label.indexOf("Buffer") >= 0 && asInfo.points.header === asInfo.points.row, asInfo.points);
    check("Lines: Buffer header present, header/row column counts match", !!asInfo.lines && asInfo.lines.label.indexOf("Buffer") >= 0 && asInfo.lines.header === asInfo.lines.row, asInfo.lines);
    check("Routes: Buffer header present, header/row column counts match", !!asInfo.routes && asInfo.routes.label.indexOf("Buffer") >= 0 && asInfo.routes.header === asInfo.routes.row, asInfo.routes);
    check("Summary cell shows the same line value (0.25)", await page.evaluate(() => {
      var r = document.querySelector('[data-section="line"] .as-row[data-feature-index="0"]');
      return parseFloat(r.querySelector(".as-col-buffer .fp-scrub-input").value) === 0.25 && !r.querySelector(".as-col-buffer .fp-buffer-ctl").classList.contains("is-inherited");
    }));
    // Buffer column geometry: header cell and row cell share an x position.
    const align = await page.evaluate(() => {
      var out = {};
      ["point", "line"].forEach((t) => {
        var sec = document.querySelector('[data-section="' + t + '"]');
        var h = Array.prototype.filter.call(sec.querySelectorAll(".as-row-header .as-cell"), (x) => x.textContent === "Buffer")[0];
        var c = sec.querySelector(".as-row:not(.as-row-header) .as-col-buffer");
        var hr = h.getBoundingClientRect(), cr = c.getBoundingClientRect();
        out[t] = { dx: Math.abs(hr.left - cr.left), dw: Math.abs(hr.width - cr.width), overflowX: c.scrollWidth - c.clientWidth };
      });
      return out;
    });
    check("Buffer header and cells are aligned and not clipped", ["point", "line"].every((t) => align[t].dx < 1 && align[t].dw < 1 && align[t].overflowX <= 1), align);
    // Edit from the summary (point) -> same property
    const sInp = page.locator('[data-section="point"] .as-row:not(.as-row-header) .as-col-buffer .fp-scrub-input').first();
    await sInp.fill("0.75"); await sInp.press("Tab");
    await page.waitForTimeout(400);
    check("Attribute Summary edit writes the same _bufferRadius", (await props(page, "point", 0))._bufferRadius === 0.75);
    // Walkshed point in the summary: disabled
    await page.evaluate(() => { App.points[0].properties.attributes.serviceAreaType = "walkshed"; App.notifyProject(); });
    await page.waitForTimeout(400);
    check("Summary: walkshed point's Buffer control is disabled", await page.evaluate(() => document.querySelector('[data-section="point"] .as-row:not(.as-row-header) .as-col-buffer .fp-scrub-input').disabled));
    await page.evaluate(() => { delete App.points[0].properties.attributes.serviceAreaType; App.notifyProject(); });
    await page.waitForTimeout(300);

    // Copy Attributes
    console.log("\n# Phase 2: Copy Attributes carries _bufferRadius");
    await page.evaluate(() => { App.lines[1].properties._bufferRadius = 1.5; App.rebuildBuffersForType("line"); App.notifyProject(); });
    await page.waitForTimeout(400);
    await page.locator('[data-section="line"] .as-row[data-feature-index="1"] .fp-sib').click();
    await page.waitForTimeout(200);
    const cbState = await page.evaluate(() => { var cb = document.querySelector('#asCopyModal .as-copy-attr-list input[data-field-key="_bufferRadius"]'); return cb ? { disabled: cb.disabled } : null; });
    check("Copy modal lists Buffer Radius, enabled when the source has an override", !!cbState && cbState.disabled === false, cbState);
    await page.evaluate(() => { document.querySelector('#asCopyModal .as-copy-attr-list input[data-field-key="_bufferRadius"]').click(); });
    await page.evaluate(() => { var t = Array.prototype.filter.call(document.querySelectorAll('#asCopyTargetList input[type=checkbox]'), (x) => x.getAttribute("data-type") === "route")[0]; t.click(); });
    const routeBefore = await page.evaluate(() => turf.area(App.routeBuffers[0]));
    await page.evaluate(() => { window.__notifies = 0; });
    await page.click("#asCopyApplyBtn");
    await page.waitForTimeout(400);
    const rp = await props(page, "route", 0);
    check("copy wrote _bufferRadius onto the Route target", rp._bufferRadius === 1.5, rp._bufferRadius);
    check("copy rebuilt the route buffer and notified modules", (await page.evaluate(() => turf.area(App.routeBuffers[0]))) > routeBefore && (await counters()).notifies >= 1);
    // Source with no override: disabled
    await page.locator('[data-section="line"] .as-row[data-feature-index="1"] .fp-sib').click().catch(() => {});
    await page.evaluate(() => { var m = document.getElementById("asCopyModal"); if (m) m.style.display = "none"; });
    await page.evaluate(() => { delete App.lines[1].properties._bufferRadius; });
    await page.evaluate(() => App.popup.close());
    await page.evaluate(() => App.openAttributeSummary());
    await page.waitForTimeout(400);
    await page.locator('[data-section="line"] .as-row[data-feature-index="1"] .fp-sib').click();
    await page.waitForTimeout(200);
    check("no override on the source -> Buffer Radius disabled (no value to copy)", await page.evaluate(() => document.querySelector('#asCopyModal .as-copy-attr-list input[data-field-key="_bufferRadius"]').disabled));
    await page.evaluate(() => { var m = document.getElementById("asCopyModal"); if (m) m.style.display = "none"; App.popup.close(); });

    // Layers drawer: no Buffer row for points either
    console.log("\n# Phase 2: Layers drawer has no Buffer row");
    await page.click('.fp-tab-btn[data-fptab="layers"]');
    await page.waitForTimeout(300);
    const pointDrawer = await page.evaluate(`(() => { var lab = Array.prototype.slice.call(document.querySelectorAll("#fp-tab-layers .lp-row-label")).filter((x) => x.textContent === "P1")[0];
      var row = lab.parentElement; row.querySelector(".lp-caret").click();
      var d = row.parentElement.querySelector(".lp-style-drawer-feature");
      return Array.prototype.map.call(d.querySelectorAll(".lp-style-label"), (x) => x.textContent); })()`);
    check("point drawer: no Buffer row", pointDrawer.indexOf("Buffer") < 0 && pointDrawer.length > 0, pointDrawer);
    await page.evaluate(() => App.undo.__restore && App.undo.__restore());

    // ---- Color picker variety (docs/color-picker-variety-plan.md) ----
    console.log("\n# Color picker: 50-swatch grid, Recent row, Custom button");
    await page.keyboard.press("Escape");
    await page.click('.fp-tab-btn[data-fptab="features"]');
    await page.evaluate(() => { while (App.undo.canUndo()) App.undo.undo(); localStorage.removeItem("mat-recent-colors"); });
    const cpIcon = page.locator('#fp-tab-features .fp-item', { hasText: "Line 2" }).locator(".fp-type-icon");
    await cpIcon.click();
    check("grid has 50 cells", (await page.locator(POP + " .fp-cp-cell").count()) === 50);
    check("grid cells are unique hex colors", await page.evaluate((s) => { var t = Array.prototype.map.call(document.querySelectorAll(s + " .fp-cp-cell"), (c) => c.title); return new Set(t).size === 50 && t.every((x) => /^#[0-9a-f]{6}$/.test(x)); }, POP));
    const dims = await page.evaluate((s) => { var g = document.querySelector(s + " .fp-cp-grid").getBoundingClientRect(); var pr = document.querySelector(s).getBoundingClientRect(); var c = document.querySelector(s + " .fp-cp-cell").getBoundingClientRect(); return { g: g.width, pw: pr.width, cell: c.width, right: pr.right, vw: innerWidth }; }, POP);
    check("grid <= 170px wide, cells ~15px, popover inside viewport", dims.g <= 170 && dims.cell >= 14 && dims.cell <= 17 && dims.right <= dims.vw, dims);
    await page.screenshot({ path: join(SHOT_DIR, "color-picker-appearance-light.png"), clip: { x: Math.max(0, dims.right - dims.pw - 2), y: 0, width: dims.pw + 4, height: 700 } });
    const seededRecent = await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + " .fp-cp-recent-cell"), (c) => c.title), POP);
    check("Recent seeded from colors in use on the map (hex, unique, <= 10)", seededRecent.length > 0 && seededRecent.length <= 10 && allUnique(seededRecent), seededRecent);
    const picked2 = await page.evaluate((s) => document.querySelectorAll(s + " .fp-cp-cell")[23].title, POP);
    await page.locator(POP + " .fp-cp-cell").nth(23).click();
    check("pick applies to the feature", (await props(page, "line", 1)).color === picked2);
    await page.keyboard.press("Escape");
    await cpIcon.click();
    const rec1 = await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + " .fp-cp-recent-cell"), (c) => c.title), POP);
    check("picked color appears first in Recent", rec1[0] === picked2 && allUnique(rec1) && rec1.length <= 10, rec1);
    check("selected cell is marked", await page.evaluate((s) => document.querySelectorAll(s + " .fp-cp-cell-selected").length === 1, POP));
    // hex path also feeds Recent, de-duplicated
    await page.locator(POP + " .fp-cp-hex-input").fill("#123456");
    await page.locator(POP + " .fp-cp-apply").click();
    await cpIcon.click().catch(() => {});
    if (!(await popOpen(page))) await cpIcon.click();
    const rec2 = await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + " .fp-cp-recent-cell"), (c) => c.title), POP);
    check("hex apply goes first in Recent; earlier pick second", rec2[0] === "#123456" && rec2[1] === picked2, rec2);
    // Custom: only `change` commits
    await page.evaluate(() => { while (App.undo.canUndo()) App.undo.undo(); });
    await page.evaluate(() => { var o = App.undo.push; window.__cpOrigPush = o; window.__cpPushes = 0; App.undo.push = function () { window.__cpPushes++; return o.apply(this, arguments); }; });
    const cpBefore = (await props(page, "line", 1)).color;
    await page.evaluate((s) => { var i = document.querySelector(s + " .fp-cp-custom-input"); i.value = "#abcdef"; i.dispatchEvent(new Event("input", { bubbles: true })); i.value = "#abcdee"; i.dispatchEvent(new Event("input", { bubbles: true })); }, POP);
    check("custom input events do not commit", (await props(page, "line", 1)).color === cpBefore && (await page.evaluate(() => window.__cpPushes)) === 0);
    await page.evaluate((s) => { var i = document.querySelector(s + " .fp-cp-custom-input"); i.value = "#abcdef"; i.dispatchEvent(new Event("change", { bubbles: true })); }, POP);
    check("custom change applies exactly that color", (await props(page, "line", 1)).color === "#abcdef", (await props(page, "line", 1)).color);
    check("custom change is exactly one undo snapshot", (await page.evaluate(() => window.__cpPushes)) === 1);
    check("Custom button click leaves the popover open", await (async () => { await page.locator(POP + " .fp-cp-custom").click().catch(() => {}); await page.waitForTimeout(150); return await popOpen(page); })());
    await page.evaluate(() => { App.undo.push = window.__cpOrigPush; });
    // Recent survives reload
    await page.waitForTimeout(700);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("mat-recent-colors")));
    check("Recent persisted under mat-recent-colors (newest first)", Array.isArray(stored) && stored[0] === "#abcdef" && stored.length <= 10, stored);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.cache && typeof App.buildScrubber === \"function\"", { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.locator('#fp-tab-features .fp-item', { hasText: "Line 1" }).locator(".fp-type-icon").click();
    const rec3 = await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + " .fp-cp-recent-cell"), (c) => c.title), POP);
    check("Recent survives a reload", rec3[0] === "#abcdef", rec3);
    await page.screenshot({ path: join(SHOT_DIR, "color-picker-appearance-after-reload.png") });
    await page.keyboard.press("Escape");
    // Dark theme look
    await page.evaluate(() => document.body.classList.add("dark-mode"));
    await page.locator('#fp-tab-features .fp-item', { hasText: "Line 1" }).locator(".fp-type-icon").click();
    const dd = await page.evaluate((s) => { var pr = document.querySelector(s).getBoundingClientRect(); return { x: pr.left, w: pr.width }; }, POP);
    await page.screenshot({ path: join(SHOT_DIR, "color-picker-appearance-dark.png"), clip: { x: Math.max(0, dd.x - 2), y: 0, width: dd.w + 4, height: 700 } });
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.body.classList.remove("dark-mode"));
    // Floating picker (labels, text boxes, type defaults) still works
    console.log("\n# Floating picker");
    const fl = await page.evaluate(() => {
      var anchor = document.createElement("button"); anchor.id = "__cpAnchor"; anchor.textContent = "x";
      anchor.style.cssText = "position:fixed;left:1300px;top:20px;z-index:1"; document.body.appendChild(anchor);
      window.__fp = []; App.openColorPicker(anchor, "#ff0000", function (c) { window.__fp.push(c); });
      var pk = document.getElementById("fp-color-picker"); var r = pk.getBoundingClientRect();
      return { shown: pk.style.display !== "none", cells: pk.querySelectorAll(".fp-cp-cell").length, inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, hex: pk.querySelector(".fp-cp-hex-input").value, w: r.width };
    });
    check("floating picker opens with 50 cells, in viewport, seeded hex", fl.shown && fl.cells === 50 && fl.inView && fl.hex === "#ff0000", fl);
    await page.screenshot({ path: join(SHOT_DIR, "color-picker-floating.png"), clip: { x: 1100, y: 0, width: 300, height: 340 } });
    await page.locator("#fp-color-picker .fp-cp-custom").click().catch(() => {});
    await page.waitForTimeout(150);
    check("Custom click does not close the floating picker", await page.evaluate(() => document.getElementById("fp-color-picker").style.display !== "none"));
    await page.locator("#fp-color-picker .fp-cp-cell").nth(2).click();
    check("floating pick calls back once and closes", await page.evaluate(() => window.__fp.length === 1 && document.getElementById("fp-color-picker").style.display === "none"));
    // Label / text box swatch path
    await page.evaluate(() => { document.getElementById("__cpAnchor").remove(); });
    // ================= END ASSERTIONS =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
