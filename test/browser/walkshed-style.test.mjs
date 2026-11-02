#!/usr/bin/env node
// test/browser/walkshed-style.test.mjs
//
// Behavior test for the display-only style options on Walkshed and Transit
// Travelshed layers (App.resolveShedStyle; Layers-panel drawer): outline mode,
// weight, tone, soft edge and band fade. Defaults must be byte-identical to
// the pre-option rendering, so the first checks pin today's numbers.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/walkshed-style.test.mjs

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/walkshed-style.test.mjs");

// A 14x14 street grid (~65m... ~555m spacing, ~7km across). Two sizing
// constraints fight each other here: dense/small enough that BOTH the
// 15-min and the 30-min band each reach enough real 2-D street intersections
// to polygonize (a too-sparse flood reaches only a handful of collinear
// nodes along one street, which the concave-hull builder can't turn into a
// polygon at all — App.computeWalkshed's `polygons[i].polygon` comes back
// null), and large enough that the 30-min band actually reaches farther
// than the 15-min one (a too-small grid saturates at 15 min already, so
// both bands come back geometrically identical and there is nothing for
// "flatten overlaps" to visibly flatten). This size was picked by measuring
// both bands' polygon/area with App.computeWalkshed directly until both
// held (see the debug session that produced this file).
function overpassPayload() {
  // Centered near the app's default map view (js/core/map.js's [-104.9903,
  // 39.7392] @ zoom 10) — fetchRoadNetwork() records its download extent
  // from the CURRENT MAP VIEW, not from wherever the stubbed Overpass data
  // happens to be, so the Walkshed module's own coverage check (which
  // network-cache.test.mjs's direct App.computeWalkshed() call bypasses)
  // only passes for points inside that view.
  const lat0 = 39.735, lng0 = -104.995;
  const n = 14, d = 0.005;
  const elements = [];
  let id = 2000;
  for (let i = 0; i < n; i++) {
    const lat = lat0 + i * d;
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "EW " + i },
      geometry: Array.from({ length: n }, (_, j) => ({ lat, lon: lng0 + j * d })) });
  }
  for (let j = 0; j < n; j++) {
    const lon = lng0 + j * d;
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "NS " + j },
      geometry: Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * d, lon })) });
  }
  return JSON.stringify({ elements });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("overpass-api.de")) {
        route.fulfill({ status: 200, contentType: "application/json", body: overpassPayload() });
        return true;
      }
      return false;
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());

    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });
    await page.evaluate(() => {
      App.addPoint(-104.995 + 0.005 * 6.4, 39.735 + 0.005 * 6);
      App.addPoint(-104.995 + 0.005 * 6.6, 39.735 + 0.005 * 6);
    });
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#wsMinutes").fill("15");
    await page.locator("#wsMinutes2").fill("30");
    await page.locator("#wsMinutes3").fill("");
    await page.locator("#wsComputeBtn").click();
    await page.waitForFunction(
      () => { const s = App.map.getSource("walkshed-src"); return s && s._data && s._data.features.length > 0; },
      { timeout: 20000 });

    const lineFeatures = () => page.evaluate(() => App.map.getSource("walkshed-line-src")._data.features);
    const lp = (prop) => page.evaluate((p) => App.map.getPaintProperty("walkshed-line", p), prop);
    const fp = (prop) => page.evaluate((p) => App.map.getPaintProperty("walkshed-fill", p), prop);
    const style = (patch) => page.evaluate((p) => App.setLayerStyle("walkshed", p), patch);

    // ---- Defaults: band outlines off ----
    const defFill = await fp("fill-color");
    check("default: outlines off (line layer present, 0 features)",
      (await lineFeatures()).length === 0 && await page.evaluate(() => !!App.map.getLayer("walkshed-line")));
    check("default: line width 2, opacity 0.9", (await lp("line-width")) === 2 && (await lp("line-opacity")) === 0.9);
    check("default: fill color is the plain band match expression", !JSON.stringify(defFill).includes("rgba("));
    check("default: no glow layer", await page.evaluate(() => !App.map.getLayer("walkshed-glow")));
    check("default: no style entry in layerStyles", await page.evaluate(() => !App.layerStyles.walkshed));

    // ---- Band outlines on: one merged outline per time band ----
    await style({ outline: "merged" });
    const tiers = await lineFeatures();
    check("outlines on: one feature per distinct minutes tier",
      tiers.length === 2 && JSON.stringify(tiers.map((f) => f.properties.minutes).sort((a, b) => a - b)) === "[15,30]");
    check("outlines on: line color matches the fill colors (tone Match)",
      JSON.stringify(await lp("line-color")) === JSON.stringify(defFill));

    // ---- Weight and tone ----
    await style({ outlineWeight: "bold" });
    check("weight bold: line-width 3", (await lp("line-width")) === 3);
    await style({ outlineWeight: "thin" });
    check("weight thin: line-width 1", (await lp("line-width")) === 1);
    await style({ outlineWeight: null });
    await style({ outlineTone: "white" });
    check("tone white: line-color #ffffff", (await lp("line-color")) === "#ffffff");
    await style({ outlineTone: "dark" });
    const dark = JSON.stringify(await lp("line-color"));
    check("tone dark: line colors differ from fill colors", dark !== JSON.stringify(await fp("fill-color")));
    await style({ outlineTone: null });
    await style({ outline: null });
    check("outlines off again: 0 features", (await lineFeatures()).length === 0);

    // ---- Band fade ----
    await style({ bandFade: true });
    check("band fade: fill-color contains rgba(", JSON.stringify(await fp("fill-color")).includes("rgba("));
    check("band fade: outline color not faded", !JSON.stringify(await lp("line-color")).includes("rgba("));
    await style({ bandFade: null });
    check("band fade off: fill-color restored", JSON.stringify(await fp("fill-color")) === JSON.stringify(defFill));

    // ---- Soft edge ----
    await style({ softEdge: true });
    const glowVis = () => page.evaluate(() => App.map.getLayer("walkshed-glow") ? App.map.getLayoutProperty("walkshed-glow", "visibility") : "absent");
    check("soft edge: glow layer exists and is visible", (await glowVis()) === "visible");
    check("soft edge: glow sits below the outline layer", await page.evaluate(() => {
      const ids = App.map.getStyle().layers.map((l) => l.id);
      return ids.indexOf("walkshed-fill") < ids.indexOf("walkshed-glow") && ids.indexOf("walkshed-glow") < ids.indexOf("walkshed-line");
    }));
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    await page.locator('#fp-tab-layers button[aria-label="More actions for Walkshed"]').first()
      .waitFor({ state: "visible", timeout: 10000 });
    // The Layers-panel eye must cover the glow (it is a sub-layer of the entry).
    const eye = (label) => page.evaluate((l) => {
      const b = document.querySelector('#fp-tab-layers button[aria-label="' + l + ' Walkshed"]');
      if (!b) return false;
      b.click();
      return true;
    }, label);
    check("eye off hides the glow too",
      (await eye("Hide")) && (await glowVis()) === "none" &&
      await page.evaluate(() => App.map.getLayoutProperty("walkshed-fill", "visibility") === "none"));
    await style({ bandFade: true }); // a repaint while hidden must not re-show the glow
    check("repaint while hidden keeps the glow hidden", (await glowVis()) === "none");
    await style({ bandFade: null });
    check("eye on shows the glow again", (await eye("Show")) && (await glowVis()) === "visible");
    await style({ softEdge: null });
    check("soft edge off: glow layer removed", (await glowVis()) === "absent");

    // ---- Persistence ----
    await style({ outline: "merged", softEdge: true, bandFade: true, outlineWeight: "thin", outlineTone: "dark" });
    const saved = await page.evaluate(() => JSON.parse(JSON.stringify(App.layerStyles.walkshed)));
    // Autosave is debounced: wait until localStorage holds the new style.
    await page.waitForFunction(() => {
      const raw = Object.keys(localStorage).map((k) => localStorage.getItem(k)).find((v) => v && v.includes('"bandFade":true'));
      return !!raw;
    }, { timeout: 5000 });
    await page.evaluate(() => { App.layerStyles = {}; App.cache.restore(); });
    const restoredStyle = await page.evaluate(() => JSON.stringify(App.layerStyles.walkshed));
    check("style keys persisted in layerStyles", JSON.stringify(saved) === restoredStyle &&
      saved.outline === "merged" && saved.softEdge === true && saved.bandFade === true &&
      saved.outlineWeight === "thin" && saved.outlineTone === "dark", restoredStyle);
    await style({ outline: null, softEdge: null, bandFade: null, outlineWeight: null, outlineTone: null });
    check("clearing every option removes the layerStyles entry", await page.evaluate(() => !App.layerStyles.walkshed));

    // ---- Clear removes glow ----
    await style({ softEdge: true });
    if (!(await page.locator("#wsClearResults").isVisible())) {
      await page.locator(".module-inputs-header").first().click();
    }
    await page.locator("#wsClearResults").click();
    await page.waitForFunction(() => !App.map.getLayer("walkshed-line"), { timeout: 5000 });
    check("Clear results removes walkshed-glow", await page.evaluate(() => !App.map.getLayer("walkshed-glow")));

    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer();
  }
  const failed = results.filter((r) => !r.pass);
  console.log("\n" + (failed.length
    ? "FAIL — " + failed.length + "/" + results.length + " checks failed"
    : "PASS — " + results.length + "/" + results.length + " checks passed"));
  process.exit(failed.length ? 1 : 0);
})();
