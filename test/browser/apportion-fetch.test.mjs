#!/usr/bin/env node
// test/browser/apportion-fetch.test.mjs
//
// App.computeApportionFractions (js/core/census.js): block-population
// apportionment from a stubbed TIGERweb layer-2 response, the session block
// cache, and the visible fallback to land area when the download fails.
// USAGE: see test/browser/README.md.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/apportion-fetch.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const block = (geoid, lon, lat, pop, hu) => ({
  type: "Feature", geometry: null,
  properties: { GEOID: geoid, INTPTLAT: String(lat), INTPTLON: String(lon), POP100: pop, HU100: hu }
});
const BLOCKS = {
  type: "FeatureCollection",
  features: [
    block("080310001001000", -104.795, 38.805, 400, 150),
    block("080310001001001", -104.7995, 38.805, 800, 300),
    block("080310001002000", -104.782, 38.805, 0, 0),
    block("080310001002001", -104.789, 38.805, 0, 0)
  ]
};

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    let requests = 0;
    let mode = "ok";
    await routeVendoredAssets(context, port, async (route, url) => {
      if (url.indexOf("Tracts_Blocks/MapServer/2/query") === -1) return false;
      requests++;
      if (mode === "500") await route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
      else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BLOCKS) });
      return true;
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.computeApportionFractions", { timeout: 30000 });

    // Serializable summary of one call, run in the page.
    const run = (method) => page.evaluate(async (method) => {
      const sq = (id, x0, x1) => ({
        type: "Feature", properties: { GEOID: id },
        geometry: { type: "Polygon", coordinates: [[[x0, 38.80], [x1, 38.80], [x1, 38.81], [x0, 38.81], [x0, 38.80]]] }
      });
      const geos = [sq("080310001001", -104.80, -104.79), sq("080310001002", -104.79, -104.78)];
      const union = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-104.798, 38.80], [-104.788, 38.80], [-104.788, 38.81], [-104.798, 38.81], [-104.798, 38.80]]] } };
      const r = await App.computeApportionFractions(union, geos, method);
      return {
        methodUsed: r.methodUsed, note: r.note,
        f: Object.fromEntries(r.fractions),
        basis: r.basis ? Object.fromEntries(r.basis) : null
      };
    }, method);
    const BG1 = "080310001001", BG2 = "080310001002";

    const a = await run("blockPop");
    check("blockPop fraction for BG1 is 1/3 and basis is pop",
      a.methodUsed === "blockPop" && Math.abs(a.f[BG1] - 1 / 3) < 0.0001 && a.basis[BG1] === "pop", JSON.stringify(a));
    const area = await run("area");
    check("BG2 falls back to its area fraction with basis area",
      a.basis[BG2] === "area" && Math.abs(a.f[BG2] - area.f[BG2]) < 1e-9 && area.f[BG2] > 0, JSON.stringify(a.f));

    const before = requests;
    await run("blockPop");
    check("second call makes no new TIGERweb request", before === 1 && requests === before, "requests=" + requests);

    mode = "500";
    await page.evaluate(() => App.censusCache.clear());
    // The block cache is private to census.js; a shifted study area changes the
    // geos' bbox so the failing route is really hit.
    const fail = await page.evaluate(async () => {
      const sq = (id, x0, x1) => ({
        type: "Feature", properties: { GEOID: id },
        geometry: { type: "Polygon", coordinates: [[[x0, 38.90], [x1, 38.90], [x1, 38.91], [x0, 38.91], [x0, 38.90]]] }
      });
      const geos = [sq("080310001001", -104.80, -104.79), sq("080310001002", -104.79, -104.78)];
      const union = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-104.798, 38.90], [-104.788, 38.90], [-104.788, 38.91], [-104.798, 38.91], [-104.798, 38.90]]] } };
      const b = await App.computeApportionFractions(union, geos, "blockPop");
      const ar = await App.computeApportionFractions(union, geos, "area");
      return { used: b.methodUsed, note: b.note, f: Object.fromEntries(b.fractions), af: Object.fromEntries(ar.fractions) };
    });
    check("HTTP 500: area fallback with the exact note and area fractions",
      fail.used === "area" &&
      fail.note === "Census block data could not be downloaded, so residents were apportioned by land area." &&
      JSON.stringify(fail.f) === JSON.stringify(fail.af) && Object.keys(fail.f).length === 2, JSON.stringify(fail));

    const whole = await run("whole");
    check("whole returns 1 for both", whole.methodUsed === "whole" && whole.f[BG1] === 1 && whole.f[BG2] === 1, JSON.stringify(whole.f));

    const legacy = await page.evaluate(() => [App.apportionMethodFromLegacy(true), App.apportionMethodFromLegacy(false), App.apportionMethodFromLegacy(undefined)]);
    check("apportionMethodFromLegacy maps true/false/undefined", legacy.join(",") === "area,whole,area", legacy.join(","));

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
