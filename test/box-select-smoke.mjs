#!/usr/bin/env node
// test/box-select-smoke.mjs — browser smoke test for box select (docs/box-select-plan.md).
// USAGE: NODE_PATH=/path/to/playwright/node_modules node test/box-select-smoke.mjs
// Same harness as test/feature-color-smoke.mjs (vendored CDN libs, remote aborted).


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

async function loadFixture(page) {
  await page.evaluate(() => {
    var st = App.cache.collectState("full");
    st.labels = [];
    st.sectionColors = { point: null, line: null, route: null, polygon: null, label: null };
    st.points = [[-104.800, 38.810], [-104.780, 38.810]].map((c, i) => ({ type: "Feature",
      properties: { name: "Point " + (i + 1), pointIdx: i + 1, color: "", attributes: {} }, geometry: { type: "Point", coordinates: c } }));
    // Line 1: long, crosses the left box but extends far beyond it. Line 2: short, near the left point.
    st.lines = [
      { type: "Feature", properties: { name: "Line 1", lineIdx: 1, waypoints: 2, color: "", colorSeq: 0, attributes: {} },
        geometry: { type: "LineString", coordinates: [[-104.815, 38.806], [-104.770, 38.806]] } },
      { type: "Feature", properties: { name: "Line 2", lineIdx: 2, waypoints: 2, color: "", colorSeq: 1, attributes: {} },
        geometry: { type: "LineString", coordinates: [[-104.8015, 38.8125], [-104.7985, 38.8125]] } }];
    st.routes = [];
    // Polygon much larger than any box drawn inside it.
    st.polygons = [{ type: "Feature", properties: { name: "Polygon 1", polyIdx: 1, color: "", attributes: {} },
      geometry: { type: "Polygon", coordinates: [[[-104.79, 38.795], [-104.77, 38.795], [-104.77, 38.802], [-104.79, 38.802], [-104.79, 38.795]]] } }];
    App.cache.applyState(st);
    App.refreshFeaturePanel();
  });
}

const sel = (page) => page.evaluate(() => App.getSelectedFeatures().map((s) => s.type + ":" + s.index).sort().join(","));
const px = (page, lng, lat) => page.evaluate(([lng, lat]) => {
  var p = App.map.project([lng, lat]); var r = App.map.getCanvasContainer().getBoundingClientRect();
  return [r.left + p.x, r.top + p.y];
}, [lng, lat]);
async function drag(page, a, b, mods = []) {
  const A = await px(page, a[0], a[1]), B = await px(page, b[0], b[1]);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(A[0], A[1]); await page.mouse.down();
  await page.mouse.move((A[0] + B[0]) / 2, (A[1] + B[1]) / 2, { steps: 3 });
  await page.mouse.move(B[0], B[1], { steps: 3 });
  await page.waitForTimeout(50);
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(80);
}

async function main() {
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
    await page.evaluate(() => App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }));
    await loadFixture(page);
    await page.waitForTimeout(300);

    console.log("\n# Tool on/off");
    await page.click('.tool-btn[data-mode="box-select"]');
    check("button turns the tool on", await page.evaluate(() => App.drawMode === "box-select"));
    await page.keyboard.press("Escape");
    check("Escape turns it off", await page.evaluate(() => App.drawMode === null));
    await page.keyboard.press("a");
    check("A key turns it on", await page.evaluate(() => App.drawMode === "box-select"));

    console.log("\n# Drags");
    const c0 = await page.evaluate(() => App.map.getCenter().toArray());
    // Box around Point 1 + Line 2, crossing Line 1.
    await drag(page, [-104.803, 38.814], [-104.797, 38.804]);
    check("map did not pan during the drag", JSON.stringify(await page.evaluate(() => App.map.getCenter().toArray())) === JSON.stringify(c0));
    check("touch: point 1, line 1 (crossing), line 2", (await sel(page)) === "line:0,line:1,point:0", await sel(page));
    check("tool stays on after a drag", await page.evaluate(() => App.drawMode === "box-select"));
    check("no box left on screen", await page.evaluate(() => !document.querySelector(".box-select-rect")));
    await drag(page, [-104.803, 38.814], [-104.797, 38.804], ["Alt"]);
    check("Alt (fully inside): long line 1 excluded", (await sel(page)) === "line:1,point:0", await sel(page));
    await drag(page, [-104.782, 38.812], [-104.778, 38.808], ["Shift"]);
    check("Shift adds point 2", (await sel(page)) === "line:1,point:0,point:1", await sel(page));
    await drag(page, [-104.803, 38.814], [-104.797, 38.8095], ["Control"]);
    check("Ctrl removes point 1 and line 2", (await sel(page)) === "point:1", await sel(page));
    await drag(page, [-104.785, 38.800], [-104.775, 38.797]);
    check("box inside a big polygon selects it", (await sel(page)) === "polygon:0", await sel(page));
    await drag(page, [-104.795, 38.818], [-104.792, 38.816]);
    check("empty box clears the selection", (await sel(page)) === "", await sel(page));

    console.log("\n# Click and hidden");
    const P1 = await px(page, -104.800, 38.810);
    await page.mouse.click(P1[0], P1[1]);
    await page.waitForTimeout(80);
    check("a click selects the point under it", (await sel(page)) === "point:0", await sel(page));
    await page.evaluate(() => { App.points[1].properties.hidden = true; App.renderPointLayers(); });
    await drag(page, [-104.782, 38.812], [-104.778, 38.808]);
    check("hidden point is skipped", (await sel(page)) === "", await sel(page));

    if (process.env.BOX_SHOT_DIR) {
      const S = await px(page, -104.803, 38.814), E = await px(page, -104.797, 38.804);
      await page.mouse.move(S[0], S[1]); await page.mouse.down(); await page.mouse.move(E[0], E[1], { steps: 4 });
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(process.env.BOX_SHOT_DIR, "box-select-drag.png") });
      await page.keyboard.press("Escape"); await page.mouse.up();
    }

    console.log("\n# Escape mid-drag, then normal panning");
    const A = await px(page, -104.79, 38.81);
    await page.mouse.move(A[0], A[1]); await page.mouse.down(); await page.mouse.move(A[0] + 60, A[1] + 60, { steps: 3 });
    await page.keyboard.press("Escape");
    check("Escape cancels the drag but keeps the tool", await page.evaluate(() => !App.boxSelect.isDragging() && App.drawMode === "box-select"));
    await page.mouse.up();
    await page.keyboard.press("Escape");
    const before = await page.evaluate(() => App.map.getCenter().toArray());
    await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(800, 500, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(200);
    check("map pans normally after the tool is off", JSON.stringify(await page.evaluate(() => App.map.getCenter().toArray())) !== JSON.stringify(before));

    console.log("\n# Group actions");
    await page.keyboard.press("Escape"); // make sure the tool state is known
    await page.evaluate(() => { App.exitDrawMode && App.exitDrawMode(); App.setSelection && App.setSelection([]); });
    await page.evaluate(() => App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }));
    await loadFixture(page);
    await page.waitForTimeout(300);
    const menuTexts = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
    const clickMenu = async (pg, label) => { await pg.locator("#fp-context-menu button", { hasText: label }).first().click(); await pg.waitForTimeout(150); };
    const rclick = async (pg, lng, lat) => { const p = await px(pg, lng, lat); await pg.mouse.click(p[0], p[1], { button: "right" }); await pg.waitForTimeout(150); };
    const counts = () => page.evaluate(() => [App.points.length, App.lines.length, App.polygons.length]);
    const names = () => page.evaluate(() => [].concat(App.points, App.lines, App.polygons).map((f) => f.properties.name + "#" + (f.properties.pointIdx || f.properties.lineIdx || f.properties.polyIdx)).sort().join(","));
    const hiddenN = () => page.evaluate(() => [].concat(App.points, App.lines, App.polygons).filter((f) => f.properties.hidden).length);

    // 3 features: point 1, line 1, line 2 (tool on)
    await page.click('.tool-btn[data-mode="box-select"]');
    await drag(page, [-104.803, 38.814], [-104.797, 38.804]);
    check("fixture: 3 selected", (await sel(page)) === "line:0,line:1,point:0", await sel(page));
    await rclick(page, -104.800, 38.810);
    let m = await menuTexts(page);
    check("tool on: group menu items", m.includes("Zoom to selection") && m.includes("Hide 3") && m.includes("Delete 3 features…"), m);
    check("selection kept after right-click", (await sel(page)) === "line:0,line:1,point:0", await sel(page));
    check("2 lines + point: no Merge", !m.includes("Merge…"), m);
    await clickMenu(page, "Hide 3");
    check("Hide 3 hides all three", (await hiddenN()) === 3, await hiddenN());
    await page.evaluate(() => App.undo.undo());
    check("one undo shows all again", (await hiddenN()) === 0, await hiddenN());

    // tool off
    await page.keyboard.press("Escape");
    await page.evaluate(() => App.setSelection([{ type: "point", index: 0 }, { type: "line", index: 0 }, { type: "line", index: 1 }]));
    check("tool off now", await page.evaluate(() => App.drawMode === null));
    await rclick(page, -104.800, 38.810);
    m = await menuTexts(page);
    check("tool off: group menu items", m.includes("Hide 3") && m.includes("Delete 3 features…"), m);

    // Delete dialog: cancel, then confirm
    const nm0 = await names();
    const cnt0 = await counts();
    await clickMenu(page, "Delete 3 features");
    check("delete opens a dialog", await page.evaluate(() => !!document.querySelector(".fm-dialog")));
    await page.locator(".fm-dialog button", { hasText: "Cancel" }).first().click();
    await page.waitForTimeout(100);
    check("Cancel deletes nothing", JSON.stringify(await counts()) === JSON.stringify(cnt0) && (await names()) === nm0);
    await rclick(page, -104.800, 38.810);
    await clickMenu(page, "Delete 3 features");
    await page.locator(".fm-dialog button", { hasText: /^Delete$/ }).first().click();
    await page.waitForTimeout(150);
    check("Delete removes exactly 3", JSON.stringify(await counts()) === JSON.stringify([1, 0, 1]), await counts());
    check("the right ones remain", (await names()) === "Point 2#2,Polygon 1#1", await names());
    await page.evaluate(() => App.undo.undo());
    check("one undo restores names and IDs", (await names()) === nm0 && JSON.stringify(await counts()) === JSON.stringify(cnt0), await names());

    // Delete key
    await page.evaluate(() => { App.setSelection([{ type: "point", index: 0 }, { type: "point", index: 1 }]); document.activeElement && document.activeElement.blur(); });
    await page.keyboard.press("Delete");
    await page.waitForTimeout(150);
    check("Delete key opens the dialog", await page.evaluate(() => !!document.querySelector(".fm-dialog")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check("Escape closes it, nothing deleted", (await page.evaluate(() => !document.querySelector(".fm-dialog"))) && JSON.stringify(await counts()) === JSON.stringify(cnt0));

    // Features pane
    await page.evaluate(() => App.setSelection([{ type: "point", index: 0 }, { type: "point", index: 1 }]));
    await page.waitForTimeout(150);
    await page.locator(".fp-item", { hasText: "Point 1" }).first().click({ button: "right" });
    await page.waitForTimeout(150);
    m = await menuTexts(page);
    check("Features pane: Hide 2 / Delete 2", m.includes("Hide 2") && m.includes("Delete 2 features…"), m);
    check("Features pane: two points offer Merge…", m.includes("Merge…"), m);
    await page.mouse.click(5, 5);

    // Mergeable pair on the map: 2 lines
    await page.evaluate(() => App.setSelection([{ type: "line", index: 0 }, { type: "line", index: 1 }]));
    await rclick(page, -104.80, 38.8125);
    m = await menuTexts(page);
    check("map menu: 2 lines show Merge…", m.includes("Merge…") && m.includes("Hide 2"), m);
    console.log("\n# Shift+drag with the tool off (Phase 4)");
    await loadFixture(page);
    await page.evaluate(() => { App.exitDrawMode(); App.setSelection([]); App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }); });
    await page.waitForTimeout(200);
    const v0 = await page.evaluate(() => [App.map.getCenter().toArray(), App.map.getZoom()]);
    await drag(page, [-104.803, 38.814], [-104.797, 38.8095], ["Shift"]);
    check("Shift+drag selects without the tool (replace)", (await sel(page)) === "line:1,point:0", await sel(page));
    check("tool stays off", await page.evaluate(() => App.drawMode === null));
    check("map neither panned nor box-zoomed", JSON.stringify(await page.evaluate(() => [App.map.getCenter().toArray(), App.map.getZoom()])) === JSON.stringify(v0));
    await drag(page, [-104.782, 38.812], [-104.778, 38.808], ["Shift"]);
    check("a second Shift+drag replaces", (await sel(page)) === "point:1", await sel(page));
    await drag(page, [-104.782, 38.812], [-104.778, 38.808], ["Shift", "Control"]);
    check("Shift+Ctrl+drag removes", (await sel(page)) === "", await sel(page));
    const before4 = await page.evaluate(() => App.map.getCenter().toArray());
    await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(800, 500, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(200);
    check("plain drag still pans", JSON.stringify(await page.evaluate(() => App.map.getCenter().toArray())) !== JSON.stringify(before4));

    console.log("\n# Middle-button pan");
    const mpan = async () => {
      const c0 = await page.evaluate(() => App.map.getCenter().toArray());
      await page.mouse.move(700, 450);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(790, 500, { steps: 6 });
      const cursorDuring = await page.evaluate(() => App.map.getCanvas().style.cursor);
      await page.mouse.up({ button: "middle" });
      await page.waitForTimeout(100);
      const c1 = await page.evaluate(() => App.map.getCenter().toArray());
      return { moved: JSON.stringify(c0) !== JSON.stringify(c1), cursorDuring, c0, c1 };
    };
    let mp = await mpan();
    check("middle drag pans with no tool", mp.moved, mp);
    check("middle drag shows the grabbing cursor", mp.cursorDuring === "grabbing", mp.cursorDuring);
    // Drag direction: grabbing the map and moving right/down moves the view left/up.
    check("map follows the drag (center moves west and north)", mp.c1[0] < mp.c0[0] && mp.c1[1] > mp.c0[1], mp);
    check("cursor restored after release", await page.evaluate(() => App.map.getCanvas().style.cursor !== "grabbing"));

    await page.evaluate(() => App.setSelection([{ type: "point", index: 0 }]));
    await page.click('.tool-btn[data-mode="box-select"]');
    mp = await mpan();
    check("middle drag pans while box select is on", mp.moved, mp);
    check("middle drag leaves the selection and the tool alone", (await sel(page)) === "point:0" && (await page.evaluate(() => App.drawMode === "box-select" && !App.boxSelect.isDragging())), await sel(page));
    // Left drag with the tool on still selects (middle pan did not disturb it).
    await drag(page, [-104.782, 38.812], [-104.778, 38.808]);
    check("left box drag still works afterwards", (await sel(page)) !== "point:0", await sel(page));
    await page.keyboard.press("Escape");

    await page.click('.tool-btn[data-mode="line"]');
    const nLines = await page.evaluate(() => App.lines.length);
    mp = await mpan();
    check("middle drag pans while a draw tool is on", mp.moved, mp);
    check("middle drag adds no line vertex", await page.evaluate((n) => App.lines.length === n && App.drawMode === "line", nLines));
    await page.keyboard.press("Escape");
    await page.evaluate(() => { App.cancelLineDrawing && App.cancelLineDrawing(); App.exitDrawMode && App.exitDrawMode(); });

  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log("\n" + (failures ? "FAIL" : "PASS") + " — " + (total - failures) + "/" + total);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
