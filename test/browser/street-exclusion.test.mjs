#!/usr/bin/env node
// test/browser/street-exclusion.test.mjs
//
// Behavior test for opt-in street exclusion on the Walk network layer
// (js/core/network-connectors.js: App.setWayExclusionMode / isWayExclusionMode,
// wireWalkNetworkInteraction). Exclusion used to be live whenever a network was
// loaded, so every map click on a street — placing a point, selecting a feature
// — also toggled that street. This is map-layer event wiring, so it belongs
// here rather than in the golden harness.
//
// What this checks (with real mouse clicks on a rendered street):
//   - by default a click on a street excludes nothing
//   - with the mode on, a click excludes the street and a second click restores it
//   - an active draw tool suspends it, and picking a toolbar draw tool switches it off
//   - clearing and re-downloading the network does not stack a second click
//     handler (a doubled handler toggles twice = a silent no-op)
//   - clearing the network switches the mode off
//   - exclusions survive unload and a reload from the stored copy, and still
//     apply to routing; Reset Session clears them
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/street-exclusion.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/street-exclusion.test.mjs");

const LAT0 = 38.8339, LNG0 = -104.8214, D = 0.004;

function overpassPayload() {
  const elements = [];
  let id = 1000;
  for (let i = 0; i < 4; i++) {
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "EW " + i },
      geometry: [0, 1, 2, 3].map((j) => ({ lat: LAT0 + i * D, lon: LNG0 + j * D })) });
  }
  for (let j = 0; j < 4; j++) {
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "NS " + j },
      geometry: [0, 1, 2, 3].map((i) => ({ lat: LAT0 + i * D, lon: LNG0 + j * D })) });
  }
  return JSON.stringify({ elements });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const excludedCount = (page) => page.evaluate(() => App.networkSettings.excludedWayIds.length);

async function waitExcluded(page, n, timeout = 3000) {
  try {
    await page.waitForFunction((k) => App.networkSettings.excludedWayIds.length === k, n, { timeout });
    return true;
  } catch (e) { return false; }
}

// Clicks the middle of the street segment between grid nodes (row 1, col 1) and (row 1, col 2).
async function clickStreet(page) {
  const pt = await page.evaluate(({ lat, lng }) => {
    const p = App.map.project([lng, lat]);
    const r = App.map.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, { lat: LAT0 + D, lng: LNG0 + 1.5 * D });
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
}

async function downloadNetwork(page) {
  await page.evaluate(({ lat, lng }) => App.map.jumpTo({ center: [lng, lat], zoom: 14.5 }),
    { lat: LAT0 + 1.5 * D, lng: LNG0 + 1.5 * D });
  await page.waitForFunction("App.map.loaded()", { timeout: 10000 });
  await page.evaluate(() => App.fetchRoadNetwork());
  await page.waitForFunction("App.roadNetworkLoaded() && !!App.map.getLayer('walk-network-line')", { timeout: 20000 });
  await page.waitForFunction("App.map.loaded()", { timeout: 10000 });
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

    await downloadNetwork(page);

    // ---- default: off ----
    check("mode is off by default", !(await page.evaluate(() => App.isWayExclusionMode())));
    await clickStreet(page);
    await page.waitForTimeout(400);
    check("click on a street excludes nothing while the mode is off", (await excludedCount(page)) === 0);

    // ---- on: toggles ----
    await page.evaluate(() => App.setWayExclusionMode(true));
    await clickStreet(page);
    check("click excludes the street while the mode is on", await waitExcluded(page, 1));
    await page.waitForFunction("App.map.loaded()", { timeout: 10000 });
    await clickStreet(page);
    check("second click restores it", await waitExcluded(page, 0));
    await page.waitForFunction("App.map.loaded()", { timeout: 10000 });

    // ---- draw tool suspends it ----
    await page.evaluate(() => { App.drawMode = "box-select"; });
    await clickStreet(page);
    await page.waitForTimeout(400);
    check("an active draw tool suspends street clicks", (await excludedCount(page)) === 0);
    await page.evaluate(() => { App.drawMode = null; });

    // ---- toolbar draw tool switches the mode off ----
    await page.evaluate(() => { window.__modeEvents = 0; document.addEventListener("wayexclusionmodechange", () => window.__modeEvents++); });
    await page.click('.tool-btn[data-mode="point"]');
    check("picking a toolbar draw tool switches the mode off", !(await page.evaluate(() => App.isWayExclusionMode())));
    check("switching off fires wayexclusionmodechange", (await page.evaluate(() => window.__modeEvents)) === 1);
    await page.click('.tool-btn[data-mode="point"]'); // deselect the tool again
    check("draw tool deselected", (await page.evaluate(() => App.drawMode)) === null);

    // ---- clear + re-download must not stack handlers ----
    await page.evaluate(() => App.setWayExclusionMode(true));
    await page.evaluate(() => App.clearRoadNetwork());
    await page.waitForFunction("!App.roadNetworkLoaded()", { timeout: 10000 });
    check("clearing the network switches the mode off", !(await page.evaluate(() => App.isWayExclusionMode())));
    await downloadNetwork(page);
    await page.evaluate(() => App.setWayExclusionMode(true));
    await clickStreet(page);
    check("after clear + re-download one click still excludes exactly once (no stacked handler)",
      await waitExcluded(page, 1), "count=" + (await excludedCount(page)));

    // ---- exclusions survive unload + re-load; Reset clears them ----
    const excludedId = await page.evaluate(() => App.networkSettings.excludedWayIds[0]);
    // persistNetwork writes after a setTimeout(0); wait for it before unloading.
    await page.waitForFunction(async () => !!(await App.networkStore.latest()), null, { timeout: 5000 });
    await page.evaluate(() => App.unloadRoadNetwork());
    await page.waitForFunction("!App.roadNetworkLoaded()", { timeout: 10000 });
    check("exclusions survive unload", (await excludedCount(page)) === 1);
    const restored = await page.evaluate(() => App.restoreCachedNetwork());
    check("network re-loads from the stored copy", restored === true);
    check("exclusions survive the re-load", (await excludedCount(page)) === 1 &&
      (await page.evaluate(() => App.networkSettings.excludedWayIds[0])) === excludedId);
    check("re-loaded network still draws the excluded street",
      await page.evaluate((id) => {
        const src = App.map.getSource("walk-network");
        if (!src || !src._data) return false;
        return src._data.features.some((f) => f.properties && f.properties.excluded && f.properties.wayId === id);
      }, excludedId));
    await page.click("#reset");
    check("Reset Session clears exclusions", await waitExcluded(page, 0), "count=" + (await excludedCount(page)));

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
