#!/usr/bin/env node
// test/browser/osm-pieces.test.mjs
//
// OpenStreetMap download by point boxes (docs/osm-pieces-plan.md, Card B).
// Walkshed asks for one box per selected point. When the points are far apart
// (the summed box area is under half the whole rectangle), the OpenStreetMap
// download sends one Overpass request with one statement per box, stores the
// result under an "osm-boxes:" id (never area-matched), and restores it at
// startup with its boxes as coverage. Close points keep the single rectangle.
// Checks:
//   - two far-apart points: one Overpass request with two box statements
//   - the on-map outline is two rectangles, and only the boxes are covered
//   - the stored record has an osm-boxes id and its two boxes
//   - after a reload the restored network keeps the same box coverage
//   - close boxes fall back to one rectangle, and no CDOT request is made
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/osm-pieces.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, sleep } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/osm-pieces.test.mjs");

// A small street grid near the app's default map view. Its only job is to be
// non-empty: an empty Overpass answer makes the download report "No roads found"
// and load nothing. It does not reach the far-apart test points on purpose.
function overpassPayload() {
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

// One bbox statement looks like `](s,w,n,e);` after the highway filter.
function bboxStatementCount(query) {
  return (query.match(/\]\(-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+\);/g) || []).length;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}
async function waitFor(page, fn, timeout = 20000, arg = null) {
  try { await page.waitForFunction(fn, arg, { timeout }); return true; } catch (e) { return false; }
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  const overpassQueries = [];
  const cdotRequests = [];
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("dtdapps.codot.gov")) {
        cdotRequests.push(url);
        route.abort();
        return true;
      }
      if (url.includes("overpass-api.de")) {
        overpassQueries.push(decodeURIComponent((route.request().postData() || "").replace(/^data=/, "")));
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
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });

    check("app ready", await page.evaluate(() =>
      typeof App.fetchRoadNetworkForExtent === "function" && typeof App.roadNetworkCoversExtent === "function"));

    // ---- Two far-apart points, one Calculate press, one download press ----
    // About 34 km apart; each point's box is about 3 km out, so the boxes are far
    // smaller than half the rectangle that spans them.
    await page.evaluate(() => {
      App.addPoint(-105.15, 39.76);
      App.addPoint(-104.75, 39.76);
      App.notifyProject();
    });
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    const twoBoxes = await waitFor(page, () => document.querySelectorAll("#wsPointList input[type=checkbox]").length === 2, 10000);
    if (!twoBoxes) throw new Error("Walkshed point list did not show two points");
    await page.evaluate(() => {
      for (const cb of document.querySelectorAll("#wsPointList input[type=checkbox]")) {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    await page.locator("#wsComputeBtn").click();
    const dlShown = await waitFor(page, () => {
      const b = document.getElementById("wsDownloadBtn");
      return !!b && b.style.display !== "none";
    }, 20000);
    if (!dlShown) {
      const status = await page.evaluate(() => (document.getElementById("wsStatusText") || {}).textContent);
      throw new Error("Download button never appeared; Walkshed status: " + status);
    }

    overpassQueries.length = 0; // count only the requests the download itself makes
    await page.locator("#wsDownloadBtn").click();
    await waitFor(page, () => App.roadNetworkLoaded() && App.roadNetworkSource() === "overpass", 30000);

    check("one Overpass request", overpassQueries.length === 1, "requests=" + overpassQueries.length);
    check("two boxes in the request", bboxStatementCount(overpassQueries[0] || "") === 2,
      "statements=" + bboxStatementCount(overpassQueries[0] || "") + " query=" + String(overpassQueries[0] || "").slice(-160));

    const cover = await page.evaluate(() => {
      const ext = App.getRoadDownloadExtent();
      return {
        type: ext ? ext.geometry.type : null,
        first: App.roadNetworkCoversExtent(turf.bboxPolygon([-105.151, 39.759, -105.149, 39.761])),
        gap: App.roadNetworkCoversExtent(turf.bboxPolygon([-104.951, 39.759, -104.949, 39.761])),
      };
    });
    check("outline is two rectangles", cover.type === "MultiPolygon", "type=" + cover.type);
    check("first point covered", cover.first === true, "first=" + cover.first);
    check("gap not covered", cover.gap === false, "gap=" + cover.gap);

    // ---- Stored under an osm-boxes id, never area-matched ----
    // Storage is deferred with setTimeout, so poll for the record to appear.
    let rec = null;
    for (let t = 0; t < 200; t++) {
      rec = await page.evaluate(async () => {
        const r = await App.networkStore.latest();
        return r ? { id: r.id, source: r.source, boxes: r.boxes || null } : null;
      });
      if (rec && typeof rec.id === "string" && rec.id.indexOf("osm-boxes:") === 0) break;
      await sleep(100);
    }
    check("stored under an osm-boxes id",
      !!rec && typeof rec.id === "string" && rec.id.indexOf("osm-boxes:") === 0 &&
      rec.source === "overpass" && Array.isArray(rec.boxes) && rec.boxes.length === 2,
      JSON.stringify(rec));

    // ---- Reload: the startup restore brings back the same box coverage ----
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await waitFor(page, () => App.roadNetworkLoaded(), 30000);
    const restored = await page.evaluate(() => ({
      loaded: App.roadNetworkLoaded(),
      first: App.roadNetworkCoversExtent(turf.bboxPolygon([-105.151, 39.759, -105.149, 39.761])),
      gap: App.roadNetworkCoversExtent(turf.bboxPolygon([-104.951, 39.759, -104.949, 39.761])),
    }));
    check("restored network still not covering the gap", restored.loaded && restored.gap === false,
      JSON.stringify(restored));
    check("restored network covers the first point", restored.loaded && restored.first === true,
      JSON.stringify(restored));

    // ---- Removed from the map, then run again: the stored boxes come back without a download ----
    overpassQueries.length = 0;
    const reRestored = await page.evaluate(async (boxes) => {
      App.unloadRoadNetwork();
      const ok = await App.restoreNetworkCovering(turf.bboxPolygon([boxes[0][0], boxes[0][1], boxes[1][2], boxes[1][3]]), boxes);
      return { ok, source: App.roadNetworkSource() };
    }, rec ? rec.boxes : [[0, 0, 0, 0], [0, 0, 0, 0]]);
    check("removed piecewise network restores by its boxes", reRestored.ok === true &&
      reRestored.source === "overpass" && overpassQueries.length === 0, JSON.stringify(reRestored));

    // ---- Close boxes: one rectangle, as before ----
    await page.evaluate(() => App.unloadRoadNetwork());
    overpassQueries.length = 0;
    const closeOk = await page.evaluate(async () => App.fetchRoadNetworkForExtent(
      turf.bboxPolygon([-105.04, 39.73, -104.95, 39.79]),
      [[-105.04, 39.73, -104.97, 39.79], [-105.02, 39.73, -104.95, 39.79]]));
    check("close boxes use one rectangle",
      overpassQueries.length === 1 && bboxStatementCount(overpassQueries[0] || "") === 1,
      "requests=" + overpassQueries.length + " statements=" + bboxStatementCount(overpassQueries[0] || "") +
      " ok=" + closeOk);
    const closeType = await page.evaluate(() => {
      const ext = App.getRoadDownloadExtent();
      return ext ? ext.geometry.type : null;
    });
    check("close boxes outline is a polygon", closeType === "Polygon", "type=" + closeType);

    check("no CDOT request", cdotRequests.length === 0, "cdot=" + cdotRequests.length);
    if (pageErrors.length) console.log("  (info) page errors during run: " + pageErrors.length + " — " + pageErrors.join(" | ").slice(0, 300));
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
