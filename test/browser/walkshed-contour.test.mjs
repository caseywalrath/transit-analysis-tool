#!/usr/bin/env node
// test/browser/walkshed-contour.test.mjs
//
// The walk boundary shape (contour tracing: WalkShape.contour + App.contourSamples via
// App.computeWalkshed): nested bands, barriers kept, small gaps filled,
// partial-block reach, off-street limit, grid coarsening + its results note,
// speed, the panel fields, and the Transit Travelshed path (minutes-based
// samples with two disjoint clusters).
//
// Grid: 30x30 residential streets, ~220 m (N-S) x ~170 m (E-W) blocks. A 4x4
// block of intersections is removed to make a "lake" (~230 acres) fully inside
// the 30-min walk, and one intersection is removed to make a small gap that
// the 10-acre hole fill should close.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/walkshed-contour.test.mjs

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/walkshed-contour.test.mjs");

const LAT0 = 39.712, LNG0 = -105.02, N = 30, D = 0.002;
const lake = (i, j) => i >= 18 && i <= 21 && j >= 14 && j <= 17;
const gap = (i, j) => i === 11 && j === 19;
function overpassPayload() {
  const el = []; let id = 9000;
  const gone = (i, j) => lake(i, j) || gap(i, j);
  const P = (i, j) => ({ lat: LAT0 + i * D, lon: LNG0 + j * D });
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (gone(i, j)) continue;
    if (j + 1 < N && !gone(i, j + 1)) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i, j + 1)] });
    if (i + 1 < N && !gone(i + 1, j)) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i + 1, j)] });
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
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 30000 });

    // ---- Engine via App.computeWalkshed ----
    const eng = await page.evaluate(({ LAT0, LNG0, D }) => {
      const origin = [LNG0 + 15.3 * D, LAT0 + 14.6 * D];
      const budgets = [1.25, 2.5];                       // 15 / 30 min at 3.1 mph
      App.networkSettings.walkShape = App.walkShapeDefaults();
      const shape = App.walkShapeFor();
      const t0 = performance.now();
      const c = App.computeWalkshed(origin, 2.5, { budgetsKm: budgets, shape });
      const ms = performance.now() - t0;
      // Reference node counts straight from the flood, and the effect of the
      // partial-edge samples (one end reached): same surface with and without them.
      const dist = App.computeWalkCostMap(origin, 2.5).distMap;
      const floodCounts = budgets.map((b) => { let n = 0; dist.forEach((d) => { if (d <= b) n++; }); return n; });
      const g = WalkShape.scaledGridKm(shape.gridKm, 2);
      const opt = { gridKm: g, offStreetKm: shape.offStreetKm, costPerKm: 1, holeAcres: shape.holeAcres, roundKm: shape.roundKm };
      const withPartial = WalkShape.contour(App.contourSamples(dist, 2.5, g * 2, 1, true), budgets, opt).bands;
      const nodesOnly = WalkShape.contour(App.contourSamples(dist, 2.5, g * 2, 1, false), budgets, opt).bands;
      const [inner, outer] = c.polygons.map((p) => p.polygon);
      let leak = null;
      try { const dd = turf.difference(inner, outer); leak = dd ? turf.area(dd) / turf.area(inner) : 0; } catch (e) { leak = "err " + e.message; }
      const holesOf = (f) => {
        const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        const h = []; polys.forEach((p) => p.slice(1).forEach((r) => h.push(turf.area(turf.polygon([r])) / 4046.86)));
        return h;
      };
      // Farthest vertex from the origin (straight line).
      let far = 0;
      turf.coordEach(outer, (pt) => { const dd = turf.distance(origin, pt); if (dd > far) far = dd; });
      // Is the removed lake's centre outside the 30-min band, and the small gap's centre inside?
      const lakeC = [LNG0 + 15.5 * D, LAT0 + 19.5 * D], gapC = [LNG0 + 19 * D, LAT0 + 11 * D];
      return {
        ms, kinds: c.polygons.map((p) => p.polygon && p.polygon.geometry.type),
        nodeCounts: c.polygons.map((p) => p.nodeCount), floodCounts,
        partialRatio: withPartial.map((f, k) => turf.area(f) / turf.area(nodesOnly[k])),
        leak, holes: holesOf(outer), kinks: [inner, outer].map((f) => turf.kinks(f).features.length),
        far, limit: 2.5 + shape.offStreetKm, gridKmUsed: c.gridKmUsed, gridKmPlanned: c.gridKmPlanned, gridKm: shape.gridKm,
        lakeOut: !turf.booleanPointInPolygon(lakeC, outer), gapIn: turf.booleanPointInPolygon(gapC, outer)
      };
    }, { LAT0, LNG0, D });
    check("contour bands are polygons", eng.kinds.every((k) => k === "Polygon" || k === "MultiPolygon"), JSON.stringify(eng.kinds));
    check("node counts match the flood", JSON.stringify(eng.nodeCounts) === JSON.stringify(eng.floodCounts), JSON.stringify(eng.nodeCounts));
    check("nesting: 15-min band lies within the 30-min band (< 0.5% outside)",
      typeof eng.leak === "number" && eng.leak < 0.005, String(eng.leak));
    check("barrier: the lake stays a hole", eng.lakeOut && eng.holes.some((a) => a > 50), JSON.stringify(eng.holes.map(Math.round)));
    check("small gap (one missing intersection) is filled", eng.gapIn);
    check("no self-intersections", eng.kinks.every((k) => k === 0));
    check("off-street limit: no vertex beyond budget + reach from the origin",
      eng.far <= eng.limit, eng.far.toFixed(3) + " km <= " + eng.limit.toFixed(3));
    // Partial-edge samples only add reach, so the raw surface can only grow;
    // simplify/smooth in the cleanup can shave a fraction of a percent.
    check("partial edges extend the walk area (outer band clearly larger; none shrinks beyond cleanup noise)",
      eng.partialRatio.every((r) => r > 0.99) && eng.partialRatio[eng.partialRatio.length - 1] > 1.02, eng.partialRatio.map((r) => r.toFixed(3)).join(" / "));
    check("30-min grid scales to 80 ft x sqrt(2) and is not cell-capped",
      Math.abs(eng.gridKmPlanned - eng.gridKm * Math.SQRT2) < 1e-9 && Math.abs(eng.gridKmUsed - eng.gridKmPlanned) < 1e-9,
      Math.round(eng.gridKmPlanned * 3280.84) + " ft planned, " + Math.round(eng.gridKmUsed * 3280.84) + " ft used");
    const cap = await page.evaluate(() => {
      const s = []; for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) s.push([-105 + j * 0.002, 39.7 + i * 0.002, 0]);
      const r = WalkShape.contour(s, [1], { gridKm: 0.004, offStreetKm: 0.1, costPerKm: 1, holeAcres: 10, roundKm: 0.1 });
      return { used: r.gridKmUsed, planned: r.gridKmPlanned };
    });
    check("cell cap: a too-fine grid coarsens (gridKmUsed > gridKmPlanned)", cap.used > cap.planned * 1.2, JSON.stringify(cap));
    check("speed: under 600 ms per point", eng.ms < 600, Math.round(eng.ms) + " ms");

    // ---- Transit Travelshed path: minute costs, both-ends-only samples, two disjoint clusters ----
    const ts = await page.evaluate(({ LAT0, LNG0, D }) => {
      const walkMinPerKm = 60 / 5;   // 5 km/h
      const a = App.computeWalkCostMap([LNG0 + 5 * D, LAT0 + 5 * D], 0.8).distMap;
      const b = App.computeWalkCostMap([LNG0 + 25 * D, LAT0 + 25 * D], 0.8).distMap;
      const nodeTimes = {};
      a.forEach((km, k) => { nodeTimes[k] = km * walkMinPerKm; });
      b.forEach((km, k) => { const t = 3 + km * walkMinPerKm; if (nodeTimes[k] == null || t < nodeTimes[k]) nodeTimes[k] = t; });
      const shape = App.walkShapeFor();
      const budgets = [6, 12];
      const samples = App.contourSamples(nodeTimes, 12, shape.gridKm, walkMinPerKm, false);
      const r = WalkShape.contour(samples, budgets, { gridKm: shape.gridKm, offStreetKm: shape.offStreetKm,
        costPerKm: walkMinPerKm, holeAcres: shape.holeAcres, roundKm: shape.roundKm });
      const [i6, o12] = r.bands;
      let leak = null;
      try { const dd = turf.difference(i6, o12); leak = dd ? turf.area(dd) / turf.area(i6) : 0; } catch (e) { leak = "err"; }
      const parts = o12 && (o12.geometry.type === "MultiPolygon" ? o12.geometry.coordinates.length : 1);
      return { nonNull: r.bands.every(Boolean), leak, parts };
    }, { LAT0, LNG0, D });
    check("travelshed-style contour: non-null bands", ts.nonNull, JSON.stringify(ts));
    check("travelshed-style contour: bands nested", typeof ts.leak === "number" && ts.leak < 0.005, String(ts.leak));
    check("travelshed-style contour: disjoint clusters stay disjoint (2 parts)", ts.parts === 2, JSON.stringify(ts));

    // ---- Module: panel fields, cache-key signature, coarsening note ----
    await page.evaluate(() => {
      App.networkSettings.walkShape = App.walkShapeDefaults();
      App.addPoint(-105.02 + 0.002 * 15.3, 39.712 + 0.002 * 14.6);
      App.notifyProject();
    });
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("details.data-input-group summary").first().click();
    const fields = await page.evaluate(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!(el && el.offsetParent !== null); };
      return { grid: vis("wsGridFt"), off: vis("wsOffStreetFt"), holes: vis("wsHoleAcres"),
        select: !!document.getElementById("wsShapeMethod"), hull: !!document.getElementById("wsMaxEdge"), sig: App.walkShapeSignature() };
    });
    check("Advanced Settings shows Grid detail, Off-street reach and Fill holes (no shape picker, no hull field)",
      fields.grid && fields.off && fields.holes && !fields.select && !fields.hull, JSON.stringify(fields));
    check("cache-key signature", fields.sig === "|shape:10:80:330", fields.sig);

    // Three points: the run computes one point per tick and reports progress.
    await page.evaluate(() => {
      App.addPoint(-105.02 + 0.002 * 12.3, 39.712 + 0.002 * 14.6);
      App.addPoint(-105.02 + 0.002 * 18.3, 39.712 + 0.002 * 14.6);
      window.__wsStatuses = [];
      const el = document.getElementById("wsStatus");
      new MutationObserver(() => window.__wsStatuses.push(el.textContent.trim())).observe(el, { childList: true, subtree: true, characterData: true });
    });
    await page.locator("#wsMinutes").fill("15");
    await page.locator("#wsMinutes2").fill("30");
    await page.locator("#wsMinutes3").fill("");
    await page.evaluate(() => App.notifyProject());
    await page.waitForFunction(() => document.querySelectorAll("#wsPointList input[type=checkbox]:checked").length === 3, { timeout: 10000 });
    await page.locator("#wsComputeBtn").click();
    await page.waitForFunction(() => (document.getElementById("wsStatus") || {}).textContent.includes("Calculated"), { timeout: 30000 });
    const statuses = await page.evaluate(() => window.__wsStatuses);
    check("multi-point run shows per-point progress", statuses.some((t) => /1 of 3 done/.test(t)) && statuses.some((t) => /2 of 3 done/.test(t)),
      JSON.stringify(statuses.filter((t) => /of \d+ done/.test(t))));
    check("budget-scaled grid alone does not show the 'coarsened' note",
      await page.evaluate(() => !document.getElementById("wsGridNote")));
    check("module run produced contour bands", await page.evaluate(() => {
      const s = App.map.getSource("walkshed-src");
      return !!(s && s._data && s._data.features.length === 6); // 3 points x 2 bands
    }));

    // ---- Transit Travelshed module, end to end: one route with all-day 10-min service ----
    await page.evaluate(({ LAT0, LNG0, D }) => {
      const st = App.cache.collectState("full");
      const row = LAT0 + 5 * D;
      st.routes = [{ type: "Feature",
        properties: { name: "Test route", routeIdx: 1, waypoints: [[LNG0 + 2 * D, row], [LNG0 + 28 * D, row]],
          attributes: { direction: "Both", avgSpeed: 15,
            service: { weekday: [{ from: "00:00", to: "23:59", frequency: 10 }], saturday: [], sunday: [] } } },
        geometry: { type: "LineString", coordinates: [[LNG0 + 2 * D, row], [LNG0 + 28 * D, row]] } }];
      st.points = [];
      st.moduleState = st.moduleState || {};
      st.moduleState["transit-travelshed"] = { v: 2, origin: [LNG0 + 3 * D, row + 0.3 * D], budgets: [15, 30, null] };
      App.cache.applyState(st);
    }, { LAT0, LNG0, D });
    await page.evaluate(() => App.openModulePopup("transit-travelshed"));
    await page.locator("#tsRunBtn").waitFor({ state: "visible", timeout: 10000 });
    const runTs = async () => {
      await page.evaluate(() => { const t = document.getElementById("tsResultsTable"); if (t) t.innerHTML = ""; });
      // Inputs collapse after a run; the button still works when clicked directly.
      await page.evaluate(() => document.getElementById("tsRunBtn").click());
      await page.waitForFunction(() => (document.getElementById("tsResultsTable") || {}).textContent.includes("min"), { timeout: 60000 });
      // The run sets its final status after the table renders; wait for it to finish.
      await page.waitForFunction(() => !document.querySelector("#tsStatus.rf-status-running"), { timeout: 60000 });
      return page.evaluate(() => App.map.getSource("ts-travelshed")._data.features.map((f) => ({ band: f.properties.band, area: turf.area(f), type: f.geometry.type })));
    };
    const tsFirst = await runTs();
    await page.evaluate(() => App.setWalkShape({ offStreetFt: 200 }));
    check("Transit Travelshed: shape change marks it stale",
      await page.evaluate(() => !!document.querySelector("#tsStatus.rf-status-stale")));
    const tsContour = await runTs();
    const tsNest = await page.evaluate(() => {
      const fs = App.map.getSource("ts-travelshed")._data.features;   // ring-differenced bands
      let overlap = 0;
      try { const i = turf.intersect(fs[0], fs[1]); overlap = i ? turf.area(i) / turf.area(fs[0]) : 0; } catch (e) { overlap = "err"; }
      return overlap;
    });
    check("Transit Travelshed contour run produces both bands",
      tsContour.length === 2 && tsContour.every((b) => b.area > 0), JSON.stringify(tsContour.map((b) => Math.round(b.area / 4046.86))));
    check("Transit Travelshed contour bands are nested (rings barely overlap)",
      typeof tsNest === "number" && tsNest < 0.005, String(tsNest));
    check("Transit Travelshed: a shorter off-street reach gives a smaller area", (() => {
      const sum = (a) => a.reduce((t, b) => t + b.area, 0);
      return sum(tsContour) < sum(tsFirst);
    })(), (tsContour.reduce((t, b) => t + b.area, 0) / tsFirst.reduce((t, b) => t + b.area, 0)).toFixed(3));

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
