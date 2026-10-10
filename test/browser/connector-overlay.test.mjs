#!/usr/bin/env node
// test/browser/connector-overlay.test.mjs
//
// Behavior test for the Network Connectors overlay (applyConnectorOverlay in
// js/core/road-network.js). When a connector splits or welds a base street
// segment, that segment must leave BOTH the routing graph and the segment
// index. The segment index feeds the Walk network layer, sidewalk coverage
// (walk-audit.js) and snapping, so a stale entry draws a street that routing
// no longer has and can snap a walkshed origin onto a dead segment.
//
// Past bug: connector-graph.js returns removeSegIds as strings (Object.keys),
// and the index filter compared them against numeric indices, so no replaced
// segment was ever dropped from the index.
//
// Shared plumbing lives in test/browser/harness.mjs. Exits 0 when every check
// passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/connector-overlay.test.mjs");

// 4x4 street grid (same fixture shape as network-cache.test.mjs): 4 east-west
// and 4 north-south ways, 3 segments each = 24 base segments.
const LAT0 = 38.8339, LNG0 = -104.8214, D = 0.004;
function overpassPayload() {
  const elements = [];
  let id = 1000;
  for (let i = 0; i < 4; i++) {
    const lat = LAT0 + i * D;
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "EW " + i },
      geometry: [0, 1, 2, 3].map((j) => ({ lat, lon: LNG0 + j * D })) });
  }
  for (let j = 0; j < 4; j++) {
    const lon = LNG0 + j * D;
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "NS " + j },
      geometry: [0, 1, 2, 3].map((i) => ({ lat: LAT0 + i * D, lon })) });
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

    const countBase = () => page.evaluate(() =>
      App.getWalkNetworkSegments().filter((s) => s.kind === "base").length);
    const before = await countBase();
    check("fixture builds 24 base segments", before === 24, "base=" + before);

    // A north-south connector crossing the middle of EW street 1's middle
    // segment (between NS 1 and NS 2), away from every grid vertex, so the
    // overlay must split that one base segment.
    const midLng = LNG0 + 1.5 * D;
    const report = await page.evaluate(([lng, a, b]) => App.setNetworkConnectors(
      [{ id: "line:0", coords: [[lng, a], [lng, b]] }], { snapToleranceKm: 0 }),
      [midLng, LAT0 + 0.5 * D, LAT0 + 1.5 * D]);
    check("overlay split at least one base segment",
      !!report && report.removeSegIds >= 1, JSON.stringify(report && { add: report.addEdges, rm: report.removeSegIds }));

    const after = await countBase();
    check("replaced base segments leave the segment index",
      report && after === before - report.removeSegIds, "base " + before + " -> " + after);

    const spansCrossing = await page.evaluate(([lng, lat]) => App.getWalkNetworkSegments().some((s) =>
      s.kind === "base" &&
      Math.abs(s.coords[0][1] - lat) < 1e-9 && Math.abs(s.coords[1][1] - lat) < 1e-9 &&
      Math.min(s.coords[0][0], s.coords[1][0]) < lng && Math.max(s.coords[0][0], s.coords[1][0]) > lng),
      [midLng, LAT0 + D]);
    check("no base segment still spans the split point", !spansCrossing);

    // Clearing the connectors restores the original base network.
    await page.evaluate(() => App.setNetworkConnectors([], {}));
    const restored = await countBase();
    check("removing the connector restores all base segments", restored === before, "base=" + restored);

    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (err) {
    check("test ran to completion", false, err && err.stack || String(err));
  } finally {
    if (browser) await browser.close();
    stopServer();
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n" + (failed ? "FAIL — " + failed + "/" + results.length + " checks failed"
    : "PASS — " + results.length + "/" + results.length + " checks passed"));
  process.exit(failed ? 1 : 0);
})();
