#!/usr/bin/env node
// test/browser/clear-all.test.mjs
//
// Regression test for the toolbar Clear button. Its handler used to throw on
// two DOM ids that no longer exist, so clearModules() never ran and module
// output (e.g. Walkshed layers + legend) stayed on screen.
//
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/clear-all.test.mjs");

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
    await page.evaluate(() => App.addPoint(-104.995 + 0.005 * 6.5, 39.735 + 0.005 * 6));

    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#wsMinutes").fill("15");
    await page.locator("#wsMinutes2").fill("30");
    await page.locator("#wsMinutes3").fill("");
    await page.locator("#wsComputeBtn").click();
    await page.waitForFunction(
      () => { const s = App.map.getSource("walkshed-src"); return s && s._data && s._data.features.length > 0; },
      { timeout: 20000 }
    );
    check("walkshed fill layer exists before Clear",
      await page.evaluate(() => !!App.map.getLayer("walkshed-fill")));

    await page.evaluate(() => document.getElementById("clear").click());
    await page.waitForFunction(() => !App.map.getLayer("walkshed-fill"), { timeout: 10000 })
      .catch(() => {});

    const after = await page.evaluate(() => {
      const w = document.getElementById("ws-legend");
      return {
        fill: !!App.map.getLayer("walkshed-fill"),
        line: !!App.map.getLayer("walkshed-line"),
        seg: !!App.map.getLayer("walkshed-seg"),
        legendHidden: !w || w.style.display === "none" || w.offsetParent === null
      };
    });
    check("walkshed-fill removed", !after.fill, JSON.stringify(after));
    check("walkshed-line removed", !after.line, JSON.stringify(after));
    check("walkshed-seg removed", !after.seg, JSON.stringify(after));
    check("walkshed legend hidden", after.legendHidden, JSON.stringify(after));
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
