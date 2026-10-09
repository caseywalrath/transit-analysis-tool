#!/usr/bin/env node
// test/browser/tvi-clear.test.mjs
//
// Title VI registers a `clear` hook so Reset Session (and toolbar Clear) remove
// its map overlay. Injects dummy tvi-* sources/layers, then triggers the real
// Reset Session button, which runs clearModules().
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/tvi-clear.test.mjs

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/tvi-clear.test.mjs");

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
    await routeVendoredAssets(context, port, () => false);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });

    await page.evaluate(() => {
      const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: {},
        geometry: { type: "Polygon", coordinates: [[[-104.82, 38.83], [-104.81, 38.83], [-104.81, 38.84], [-104.82, 38.83]]] } }] };
      ["tvi-impacted", "tvi-gain"].forEach((id) => {
        App.map.addSource(id, { type: "geojson", data: fc });
        App.map.addLayer({ id: id + "-fill", type: "fill", source: id, paint: { "fill-color": "#f00" } });
        App.map.addLayer({ id: id + "-outline", type: "line", source: id, paint: { "line-color": "#f00" } });
      });
    });
    check("dummy overlay present before reset", await page.evaluate(() =>
      !!App.map.getLayer("tvi-impacted-fill") && !!App.map.getLayer("tvi-gain-fill")));

    await page.click("#reset");
    try {
      await page.waitForFunction(() => !App.map.getLayer("tvi-impacted-fill") && !App.map.getLayer("tvi-gain-fill"), null, { timeout: 5000 });
    } catch (e) {}
    check("Reset Session removes all Title VI layers", await page.evaluate(() =>
      ["tvi-impacted-fill", "tvi-impacted-outline", "tvi-gain-fill", "tvi-gain-outline"].every((l) => !App.map.getLayer(l))));
    check("Reset Session removes Title VI sources", await page.evaluate(() =>
      !App.map.getSource("tvi-impacted") && !App.map.getSource("tvi-gain")));
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
