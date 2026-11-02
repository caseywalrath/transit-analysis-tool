#!/usr/bin/env node
// test/browser/walkshed-shape.test.mjs
//
// Boundary-shape settings (App.networkSettings.walkShape): defaults and
// persistence, stale marking on a change, the study-area hand-off, and the
// "previous shape" comparison overlay in Walkshed. The shape's geometry is
// covered by walkshed-contour.test.mjs.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/walkshed-shape.test.mjs

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/walkshed-shape.test.mjs");

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

    // ---- Fresh-session default ----
    check("fresh session has the default shape settings",
      await page.evaluate(() => App.walkShapeSignature() === "|shape:10:80:330"));

    // ---- Network + points ----
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });
    await page.evaluate(() => {
      App.addPoint(-104.995 + 0.005 * 6.4, 39.735 + 0.005 * 6);
      App.addPoint(-104.995 + 0.005 * 6.6, 39.735 + 0.005 * 6);
    });
    await page.evaluate(() => App.notifyProject());
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });

    // computeWalkshed without a shape argument uses the current settings.
    const same = await page.evaluate(() => {
      const c = [-104.995 + 0.005 * 6.4, 39.735 + 0.005 * 6];
      const a = App.computeWalkshed(c, 1.25, { budgetsKm: [0.6, 1.25] });
      const b = App.computeWalkshed(c, 1.25, { budgetsKm: [0.6, 1.25], shape: App.walkShapeFor() });
      return a.polygons.every((p) => p.polygon) &&
        JSON.stringify(a.polygons.map((p) => p.polygon)) === JSON.stringify(b.polygons.map((p) => p.polygon));
    });
    check("computeWalkshed: no shape argument = current settings, both bands non-null", same);

    // ---- UI: no method picker or hull field any more; the shape fields remain ----
    const ui = await page.evaluate(() => ({
      select: !!document.getElementById("wsShapeMethod"), hull: !!document.getElementById("wsMaxEdge"),
      fields: ["wsHoleAcres", "wsGridFt", "wsOffStreetFt"].every((id) => !!document.getElementById(id)),
      values: ["wsHoleAcres", "wsGridFt", "wsOffStreetFt"].map((id) => document.getElementById(id).value).join(",")
    }));
    check("Walkshed panel: shape fields only, synced to the settings",
      !ui.select && !ui.hull && ui.fields && ui.values === "10,80,330", JSON.stringify(ui));

    // ---- Run, change a shape setting, run again: comparison overlay ----
    const run = async () => {
      if (!(await page.locator("#wsComputeBtn").isVisible())) await page.locator(".module-inputs-header").first().click();
      await page.evaluate(() => { window.__ran = 0; const s = App.map.getSource("walkshed-src"); const o = s.setData.bind(s); s.setData = (d) => { window.__ran++; return o(d); }; });
      await page.locator("#wsComputeBtn").click();
      await page.waitForFunction(() => window.__ran > 0 || (document.getElementById("wsStatus") || {}).textContent.includes("Calculated"), { timeout: 20000 });
      await page.waitForFunction(() => (document.getElementById("wsStatus") || {}).textContent.includes("Calculated"), { timeout: 20000 });
    };
    await page.locator("#wsMinutes").fill("15");
    await page.locator("#wsMinutes2").fill("30");
    await page.locator("#wsMinutes3").fill("");
    await page.locator("#wsComputeBtn").click();
    await page.waitForFunction(() => { const s = App.map.getSource("walkshed-src"); return s && s._data && s._data.features.length > 0; }, { timeout: 20000 });
    const stdArea = await page.evaluate(() => App.getPointWalkshed(App.points[0].properties.pointIdx) && turf.area(App.getPointWalkshed(App.points[0].properties.pointIdx)));
    check("first run: no previous shape overlay", await page.evaluate(() =>
      !App.map.getLayer("walkshed-prev-line") && document.getElementById("wsPrevShape").style.display === "none"));

    // A settings change marks Walkshed stale (and fires the shared listener list).
    await page.evaluate(() => { window.__shapeFired = 0; App.onWalkShapeChange(() => { window.__shapeFired++; }); });
    // Through the panel field (inputs are collapsed after the run, so set it directly).
    await page.evaluate(() => { const el = document.getElementById("wsOffStreetFt"); el.value = "200"; el.dispatchEvent(new Event("change")); });
    check("setting change notifies both modules' listeners", (await page.evaluate(() => window.__shapeFired)) === 1);
    check("setting change marks Walkshed stale", await page.evaluate(() => !!document.querySelector("#wsStatus.rf-status-stale")));
    check("cache-key suffix follows the settings", await page.evaluate(() => App.walkShapeSignature() === "|shape:10:80:200"));

    await run();
    const cmp = await page.evaluate(() => ({
      layer: !!App.map.getLayer("walkshed-prev-line"),
      feats: App.map.getSource("walkshed-prev-src") ? App.map.getSource("walkshed-prev-src")._data.features.length : -1,
      dash: App.map.getLayer("walkshed-prev-line") ? App.map.getPaintProperty("walkshed-prev-line", "line-dasharray") : null,
      shown: document.getElementById("wsPrevShape").style.display !== "none",
      label: document.getElementById("wsPrevShapeLabel").textContent,
      note: document.getElementById("wsPrevShapeNote").textContent
    }));
    check("run after a setting change draws the previous-shape line, one feature per point",
      cmp.layer && cmp.feats === 2 && JSON.stringify(cmp.dash) === "[2,2]", JSON.stringify(cmp));
    check("comparison checkbox and area note are visible",
      cmp.shown && cmp.label === "Show previous shape (earlier settings)" &&
      /^Area vs earlier settings: 15 min [+−]\d/.test(cmp.note) && cmp.note.includes("30 min"), cmp.note);
    check("Layers panel does not list the transient comparison layer", await page.evaluate(() => {
      return !Array.from(document.querySelectorAll("#fp-tab-layers *")).some((e) => /previous/i.test(e.textContent || "") && e.children.length === 0);
    }));
    // Re-running with the same shape clears the comparison.
    await run();
    check("re-running with the same shape clears the comparison",
      await page.evaluate(() => !App.map.getLayer("walkshed-prev-line") && document.getElementById("wsPrevShape").style.display === "none"));

    // Back to 330 ft -> comparison again.
    await page.evaluate(() => App.setWalkShape({ offStreetFt: 330 }));
    await run();
    check("changing the setting back shows the comparison again",
      await page.evaluate(() => !!App.map.getLayer("walkshed-prev-line") &&
        document.getElementById("wsPrevShapeLabel").textContent === "Show previous shape (earlier settings)"));
    await page.locator("#wsPrevShapeToggle").uncheck();
    check("unchecking hides the dashed line",
      (await page.evaluate(() => App.map.getLayoutProperty("walkshed-prev-line", "visibility"))) === "none");
    const stdArea2 = await page.evaluate(() => turf.area(App.getPointWalkshed(App.points[0].properties.pointIdx)));
    check("study-area polygon is reproducible across runs", Math.abs(stdArea2 - stdArea) < 1e-6 * stdArea);

    // ---- Downstream: study area uses the walkshed polygon ----
    const down = await page.evaluate(() => {
      const p = App.points[0];
      p.properties._bufferRadius = 0.5;
      p.properties.attributes = Object.assign({}, p.properties.attributes, { serviceAreaType: "walkshed" });
      App.refreshBuffers();
      const b = App.buffers[0];
      const w = App.getPointWalkshed(App.points[0].properties.pointIdx);
      return { isWalkshed: !!(b && b.properties.walkshed), same: !!(b && w && Math.abs(turf.area(b) - turf.area(w)) < 1) };
    });
    check("study-area buffer is the walkshed polygon", down.isWalkshed && down.same, JSON.stringify(down));

    // ---- Persistence + defaults ----
    await page.evaluate(() => App.setWalkShape({ holeAcres: 12, gridFt: 100 }));
    await page.waitForFunction(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) || "").includes('"holeAcres":12')), { timeout: 5000 });
    await page.evaluate(() => { App.networkSettings.walkShape = { holeAcres: 1, gridFt: 1, offStreetFt: 1 }; App.cache.restore(); });
    check("saved shape settings restore", await page.evaluate(() =>
      App.networkSettings.walkShape.holeAcres === 12 && App.networkSettings.walkShape.gridFt === 100));
    // Older sessions also stored a method name and an edge-rounding distance; both are dropped.
    await page.evaluate(() => {
      Object.keys(localStorage).forEach((k) => {
        const v = localStorage.getItem(k);
        if (v && v.includes("networkWalkShape")) { const o = JSON.parse(v); o.networkWalkShape = { method: "simplified", roundFt: 150, holeAcres: 7 }; localStorage.setItem(k, JSON.stringify(o)); }
      });
      App.cache.restore();
    });
    check("old method/roundFt fields are dropped on restore; known fields kept", await page.evaluate(() =>
      JSON.stringify(App.networkSettings.walkShape) === JSON.stringify({ holeAcres: 7, gridFt: 80, offStreetFt: 330 })),
      await page.evaluate(() => JSON.stringify(App.networkSettings.walkShape)));
    // A session with no stored shape gets the defaults (old sessions are not preserved).
    await page.evaluate(() => {
      Object.keys(localStorage).forEach((k) => {
        const v = localStorage.getItem(k);
        if (v && v.includes("networkWalkShape")) { const o = JSON.parse(v); delete o.networkWalkShape; localStorage.setItem(k, JSON.stringify(o)); }
      });
      App.networkSettings.walkShape = { holeAcres: 3, gridFt: 50, offStreetFt: 100 };
      App.cache.restore();
    });
    check("a restored session lacking networkWalkShape gets the defaults",
      await page.evaluate(() => App.walkShapeSignature() === "|shape:10:80:330"));

    // ---- Clear results removes the overlay too ----
    await page.evaluate(() => App.setWalkShape({ holeAcres: 20 }));
    await run();
    check("overlay present before clearing", await page.evaluate(() => !!App.map.getLayer("walkshed-prev-line")));
    if (!(await page.locator("#wsClearResults").isVisible())) await page.locator(".module-inputs-header").first().click();
    await page.locator("#wsClearResults").click();
    await page.waitForFunction(() => !App.map.getLayer("walkshed-line"), { timeout: 5000 });
    check("Clear results removes walkshed-prev-line and hides the note",
      await page.evaluate(() => !App.map.getLayer("walkshed-prev-line") && !App.map.getSource("walkshed-prev-src") &&
        document.getElementById("wsPrevShape").style.display === "none"));

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
