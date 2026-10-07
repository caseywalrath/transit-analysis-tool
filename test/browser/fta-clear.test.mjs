#!/usr/bin/env node
// test/browser/fta-clear.test.mjs
//
// Proves the FTA Small Starts `clear` hook is wired into Reset Session: a dummy
// source/layer with the module's LBAR layer ids is injected, then the real Reset
// button is clicked (dialogs auto-accepted) and the layer must be gone. The module's
// own layer needs uploaded LBAR files, so a dummy stands in for it.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/fta-clear.test.mjs

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/fta-clear.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
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
      App.map.addSource("lbar-sites", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      App.map.addLayer({ id: "lbar-sites-layer", type: "circle", source: "lbar-sites" });
    });
    check("dummy layer present before reset",
      await page.evaluate(() => !!App.map.getLayer("lbar-sites-layer")));

    await page.click("#reset");
    try {
      await page.waitForFunction("!App.map.getLayer('lbar-sites-layer') && !App.map.getSource('lbar-sites')", { timeout: 5000 });
      check("Reset Session removes the LBAR layer and source", true);
    } catch (e) {
      check("Reset Session removes the LBAR layer and source", false);
    }
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
