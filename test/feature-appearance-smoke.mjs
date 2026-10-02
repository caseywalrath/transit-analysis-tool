#!/usr/bin/env node
// test/feature-appearance-smoke.mjs
//
// Browser smoke test for the shared Appearance popover
// (docs/feature-appearance-plan.md, Phase 1): it opens from the Features-pane
// icon, the Attributes pop-up swatch, the Layers-tab row swatch and the
// Attribute Summary swatch; edits color / opacity / width / offset with the
// muted-default + x-clear semantics; takes one undo step per gesture; and the
// old Attributes override-icon strip is gone.
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
    check("drawer rows: Opacity, Weight, Offset, Buffer", JSON.stringify(drawerInfo) === JSON.stringify(["Opacity", "Weight", "Offset", "Buffer"]), drawerInfo);
    await page.evaluate(`(() => { var d = ${rowOf("Line 2")}.parentElement.querySelector(".lp-style-drawer-feature");
      var r = Array.prototype.filter.call(d.querySelectorAll(".lp-style-row"), (x) => x.querySelector(".lp-style-label").textContent === "Weight")[0];
      var i = r.querySelector(".fp-scrub-input"); i.value = "2"; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    check("drawer edit writes the same override", (await props(page, "line", 1))._lineWidth === 2);
    check("drawer edit is undoable (new in Phase 1)", await page.evaluate(() => { App.undo.undo(); return App.lines[1].properties._lineWidth === undefined; }));
    // ================= END ASSERTIONS =================
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " - " + (total - failures) + "/" + total + " assertions passed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
