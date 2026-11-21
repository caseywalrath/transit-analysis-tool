#!/usr/bin/env node
// test/browser/multi-walk-flood.test.mjs
//
// The multi-origin walk flood (App.computeMultiWalkCostMap, App.multiWalkPolygon): seeded from many
// stops at once, each node's distance must equal the smallest of the single-origin floods, origins off
// the network are reported, and the traced area covers every origin's own walkshed.
// Grid: 20x20 residential streets, ~220 m x ~170 m blocks (synthetic Overpass payload).
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/multi-walk-flood.test.mjs

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/multi-walk-flood.test.mjs");

const LAT0 = 39.712, LNG0 = -105.02, N = 20, D = 0.002;
function overpassPayload() {
  const el = []; let id = 9000;
  const P = (i, j) => ({ lat: LAT0 + i * D, lon: LNG0 + j * D });
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (j + 1 < N) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i, j + 1)] });
    if (i + 1 < N) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i + 1, j)] });
  }
  return JSON.stringify({ elements: el });
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

    const before = await page.evaluate(() => App.computeMultiWalkCostMap([{ lngLat: [0, 0], id: "x" }], 1));
    check("no network → null", before === null);

    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 30000 });

    const r = await page.evaluate(({ LAT0, LNG0, D }) => {
      const A = [LNG0 + 4.3 * D, LAT0 + 5.6 * D], B = [LNG0 + 12.7 * D, LAT0 + 9.2 * D];
      const far = [LNG0 + 60 * D, LAT0 + 60 * D];
      const km = 0.8;
      const sa = App.computeWalkCostMap(A, km).distMap, sb = App.computeWalkCostMap(B, km).distMap;
      const m = App.computeMultiWalkCostMap([{ lngLat: A, id: "a" }, { lngLat: B, id: "b" }, { lngLat: far, id: "far" }], km);
      // Single-origin maps also hold the temporary snap node; compare on real graph nodes only.
      let worst = 0, missing = 0, extra = 0, origins = { 0: 0, 1: 0 }, wrongOrigin = 0;
      const keys = new Set();
      sa.forEach((v, k) => keys.add(k)); sb.forEach((v, k) => keys.add(k));
      const snapA = App.snapWalk(A).key, snapB = App.snapWalk(B).key;
      keys.delete(snapA); keys.delete(snapB);
      keys.forEach((k) => {
        const want = Math.min(sa.has(k) ? sa.get(k) : Infinity, sb.has(k) ? sb.get(k) : Infinity);
        if (!m.distMap.has(k)) { missing++; return; }
        worst = Math.max(worst, Math.abs(m.distMap.get(k) - want));
        const o = m.originOf.get(k); origins[o] = (origins[o] || 0) + 1;
        const da = sa.has(k) ? sa.get(k) : Infinity, db = sb.has(k) ? sb.get(k) : Infinity;
        if (Math.abs(da - db) > 1e-9 && o !== (da < db ? 0 : 1)) wrongOrigin++;
      });
      m.distMap.forEach((v, k) => { if (!keys.has(k)) extra++; });
      const poly = App.multiWalkPolygon([{ lngLat: A, id: "a" }, { lngLat: B, id: "b" }], km);
      const wa = App.computeWalkshed(A, km).polygon, wb = App.computeWalkshed(B, km).polygon;
      const inside = (pt) => turf.booleanPointInPolygon(turf.point(pt), poly.polygon);
      const areaM = turf.area(poly.polygon), areaU = turf.area(turf.union(wa, wb));
      const t0 = performance.now();
      const many = [];
      for (let i = 1; i < 19; i += 2) for (let j = 1; j < 19; j += 2) many.push({ lngLat: [LNG0 + j * D + 0.0003, LAT0 + i * D], id: i + "-" + j });
      const big = App.multiWalkPolygon(many, 0.4);
      const ms = performance.now() - t0;
      const none = App.multiWalkPolygon([{ lngLat: far, id: "far" }], km);
      // A budget shorter than the distance to either end of the origin's block still covers the stop.
      const mid = [LNG0 + 4.5 * D, LAT0 + 5 * D];
      const tiny = App.multiWalkPolygon([{ lngLat: mid, id: "mid" }], 0.05);
      const midIn = !!(tiny && tiny.polygon) && turf.booleanPointInPolygon(turf.point(mid), tiny.polygon);
      return { midIn, worst, missing, extra, origins, wrongOrigin, snapped: m.snapped, unsnapped: m.unsnapped,
        inA: inside(A), inB: inside(B), ratio: areaM / areaU, manyN: many.length, manySnapped: big.snapped,
        bigOk: !!big.polygon, ms: Math.round(ms), nonePoly: none.polygon, noneUnsnapped: none.unsnapped };
    }, { LAT0, LNG0, D });

    check("each node's distance = min of the single-origin floods", r.worst < 1e-9 && r.missing === 0,
      "max diff " + r.worst + " km, missing " + r.missing);
    check("no nodes beyond the single-origin floods", r.extra === 0, "extra " + r.extra);
    check("originOf names the nearer origin", r.wrongOrigin === 0 && r.origins[0] > 0 && r.origins[1] > 0,
      JSON.stringify(r.origins) + ", wrong " + r.wrongOrigin);
    check("off-network origin reported as unsnapped", r.snapped === 2 && r.unsnapped.length === 1 && r.unsnapped[0] === "far");
    check("polygon contains both origins", r.inA && r.inB);
    check("polygon area ≈ union of the two single walksheds", r.ratio > 0.9 && r.ratio < 1.1, "ratio " + r.ratio.toFixed(3));
    check("81 origins snap and trace", r.manySnapped === r.manyN && r.bigOk, r.manySnapped + "/" + r.manyN + " in " + r.ms + " ms");
    check("nothing snapped → polygon null, origin listed", r.nonePoly === null && r.noneUnsnapped.length === 1);
    check("mid-block origin with a short budget still covers its stop", r.midIn);
    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    check("test ran", false, e && e.stack || String(e));
  } finally {
    if (browser) await browser.close();
    stopServer();
  }
  const passed = results.filter((x) => x.pass).length;
  console.log((passed === results.length ? "PASS" : "FAIL") + " — " + passed + "/" + results.length + " checks passed");
  process.exit(passed === results.length ? 0 : 1);
})();
