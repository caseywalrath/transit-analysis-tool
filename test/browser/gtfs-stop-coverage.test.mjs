#!/usr/bin/env node
// test/browser/gtfs-stop-coverage.test.mjs
//
// Behavior test for the Coverage tab on GTFS stop details (js/projects/gtfs.js), against the real app
// in headless Chromium and the mini fixture (test/fixtures/gtfs/mini):
//
//   - mode, walk distance, trips and peak headway match GtfsSchedule.stopServiceTable
//   - nothing is requested from the Census Bureau until "Count residents" is pressed
//   - the resident count equals a hand sum of the 2020 blocks inside the radius (TIGERweb stubbed)
//   - the count survives an instant redraw (date change); a failed download shows its error
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see test/browser/README.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-stop-coverage.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (pass || !detail ? "" : "  — " + detail));
}

const MINI_DIR = join(REPO_ROOT, "test", "fixtures", "gtfs", "mini");
const MINI_FILES = ["agency", "calendar", "calendar_dates", "frequencies", "routes", "shapes", "stop_times", "stops", "trips"]
  .map((n) => n + ".txt");
const mini = {};
MINI_FILES.forEach((f) => { mini[f] = readFileSync(join(MINI_DIR, f), "utf8"); });

// Stop S2 sits at 39.7400, -104.9800 (bus only). At that latitude 0.001 deg of latitude is ~0.069 mi and
// 0.001 deg of longitude ~0.053 mi, so a quarter-mile radius reaches about 0.0036 deg north and 0.0047 deg east.
const BG_NEAR = "080310001001";
const BG_FAR = "080310001002";
const square = (geoid, lon0, lat0, lon1, lat1) => ({
  type: "Feature", properties: { GEOID: geoid },
  geometry: { type: "Polygon", coordinates: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]] }
});
const BG_RESPONSE = {
  type: "FeatureCollection",
  features: [
    square(BG_NEAR, -104.99, 39.735, -104.97, 39.745),
    square(BG_FAR, -104.60, 39.60, -104.59, 39.61)
  ]
};
const block = (geoid, lon, lat, pop) => ({
  type: "Feature", geometry: null,
  properties: { GEOID: geoid, INTPTLAT: String(lat), INTPTLON: String(lon), POP100: pop, HU100: 0 }
});
// Inside the quarter-mile circle: 100 + 250 + 40. Outside it: 900 (0.28 mi north) and 700 (0.27 mi east).
// The last block is inside the circle but belongs to a block group the stubbed layer never returns.
const BLOCK_RESPONSE = {
  type: "FeatureCollection",
  features: [
    block(BG_NEAR + "0001", -104.9800, 39.7410, 100),
    block(BG_NEAR + "0002", -104.9765, 39.7400, 250),
    block(BG_NEAR + "0003", -104.9805, 39.7405, 40),
    block(BG_NEAR + "0004", -104.9800, 39.7440, 900),
    block(BG_NEAR + "0005", -104.9750, 39.7400, 700),
    block(BG_FAR + "0001", -104.9800, 39.7402, 5000)
  ]
};
const HAND_SUM = 100 + 250 + 40;

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const census = [];
    let blockMode = "ok";
    await routeVendoredAssets(context, port, async (route, url) => {
      if (url.indexOf("tigerweb.geo.census.gov") === -1 && url.indexOf("api.census.gov") === -1) return false;
      census.push(url);
      if (url.indexOf("Tracts_Blocks/MapServer/1/query") !== -1) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BG_RESPONSE) });
      } else if (url.indexOf("Tracts_Blocks/MapServer/2/query") !== -1) {
        if (blockMode === "500") await route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
        else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BLOCK_RESPONSE) });
      } else {
        await route.abort();
      }
      return true;
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());
    census.length = 0;

    const loaded = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      return App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
    }, mini);
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    check("0. mini feed loads and the day is Mon 2026-01-12",
      loaded === true && await page.evaluate(() => App.gtfsAnalysisDate.get()) === "20260112");

    const clickTab = (label) => page.locator("#attr-dock .ad-tab", { hasText: label }).click();
    const fields = () => page.evaluate(() => {
      const out = {};
      Array.from(document.querySelectorAll("#attr-dock .gtfs-fields tbody tr")).forEach((tr) => {
        out[tr.children[0].textContent] = tr.children[1].textContent;
      });
      return out;
    });
    const resultText = () => page.evaluate(() => {
      const n = document.querySelector("#attr-dock [data-coverage-result]");
      return n ? n.textContent : null;
    });
    const tableRow = (stopId) => page.evaluate((s) =>
      GtfsSchedule.stopServiceTable(App.gtfsSchedule(), App.gtfsAnalysisDate.get(), { stopIds: [s] })[0] || null, stopId);
    const minutes = (sec) => typeof sec === "number" ? Math.round(sec / 60) + " min" : "—";

    // 1
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S2" }));
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .ad-tab")).map((b) => b.textContent));
    check("1. a stop shows a Coverage tab after Spacing",
      tabs.join(",") === "Details,Trips,Spacing,Coverage", tabs.join(","));

    // 2
    await clickTab("Coverage");
    const f2 = await fields();
    const row2 = await tableRow("S2");
    check("2. S2 is a bus stop with a ¼ mi walk, and its trips and peak headway match stopServiceTable",
      !!row2 && f2["Mode"] === "Bus" && f2["Walk distance"] === "¼ mi" &&
      f2["Trips on this day"] === String(row2.trips) && f2["Peak headway"] === minutes(row2.peakHeadwaySec),
      JSON.stringify(f2) + " vs " + JSON.stringify(row2));

    // 3
    const frequent = typeof row2.peakHeadwaySec === "number" && row2.peakHeadwaySec <= 900 ? "Yes" : "No";
    check("3. the Frequent line follows the 15 minute peak headway",
      f2["Frequent (peak headway ≤ 15 min)"] === frequent, JSON.stringify(f2) + " peak " + row2.peakHeadwaySec);

    // 4
    check("4. no Census request is made before the button is pressed", census.length === 0 && await resultText() === "",
      census.length + " requests, result " + JSON.stringify(await resultText()));

    // 5
    blockMode = "500";
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S3" }));
    await clickTab("Coverage");
    await page.locator("#attr-dock button", { hasText: "Count residents" }).click();
    await page.waitForFunction(() => {
      const n = document.querySelector("#attr-dock [data-coverage-result]");
      return n && n.getAttribute("data-coverage-result") === "error";
    }, null, { timeout: 10000 });
    const text9 = await resultText();
    check("5. a failed download shows the error text", /^Could not count residents: .*500/.test(text9), JSON.stringify(text9));

    blockMode = "ok";
    census.length = 0;
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S2" }));
    await clickTab("Coverage");

    // 6
    await page.locator("#attr-dock button", { hasText: "Count residents" }).click();
    await page.waitForFunction(() => {
      const n = document.querySelector("#attr-dock [data-coverage-result]");
      return n && n.getAttribute("data-coverage-result") !== "busy";
    }, null, { timeout: 10000 });
    const text5 = await resultText();
    const expected5 = "About " + HAND_SUM + " residents live within ¼ mi (2020 census blocks).";
    check("6. the count equals the hand sum of blocks inside the radius (blocks outside it or in other block groups left out)",
      text5 === expected5, JSON.stringify(text5) + " expected " + JSON.stringify(expected5));

    // 6
    const kinds = census.map((u) => /MapServer\/(\d)\/query/.exec(u)).map((m) => m && m[1]).join(",");
    check("7. one block-group request and one block request were made", kinds === "1,2", kinds);

    // 7
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260124"));
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    check("8. the count survives instant redraws", await resultText() === expected5, JSON.stringify(await resultText()));

    // 8
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "R2" }));
    await clickTab("Coverage");
    const f8 = await fields();
    const row8 = await tableRow("R2");
    check("9. the rail stop R2 uses a ½ mi walk and starts with no count",
      f8["Mode"] === "Rail" && f8["Walk distance"] === "½ mi" &&
      f8["Trips on this day"] === String(row8 ? row8.trips : 0) && await resultText() === "",
      JSON.stringify(f8) + " result " + JSON.stringify(await resultText()));

    // 10
    let added = null;
    await page.evaluate(() => {
      App.gtfsAddStopTab({ id: "probe", label: "Probe", render: (el, stopId) => { el.textContent = "probe " + stopId; } });
    });
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S1" }));
    await clickTab("Probe");
    added = await page.locator("#attr-dock .ad-tab-pane").textContent();
    check("10. App.gtfsAddStopTab adds a tab that receives the stop_id", added.trim() === "probe S1", JSON.stringify(added));

    check("11. no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
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
