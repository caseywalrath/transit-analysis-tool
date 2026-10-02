#!/usr/bin/env node
// test/browser/walkshed-flatten.test.mjs
//
// Behavior test for the Walkshed module's "Flatten overlaps" display option
// (js/projects/walkshed.js's buildFlattenedFillFeatures/renderWalkshedLayers,
// toggled from the Layers panel's walkshed-fill style drawer via
// App.layerStyles.walkshed.flatten — js/core/layers-panel.js). This is a
// map-layer-lifecycle change (the fill and outline layers now read from two
// separate sources), so it belongs here rather than in the golden harness
// (no pure function to pin — this is App.map/turf rendering) or
// test/ui-screens (it changes runtime geometry, not just pixels of a fixed
// popup state).
//
// What this checks:
//   - default (flatten off) behavior is unchanged: the fill source holds the
//     same per-point, per-band ring-differenced polygons it always has
//   - turning flatten on collapses the fill source to one polygon per
//     distinct minutes tier, unioned across every point, with each tier
//     disjoint from every other (no double-painted overlap)
//   - the outline source is NEVER flattened — it always carries every
//     point's own band boundaries, so an overlap stays visible as a
//     preserved outline even while the fill hides it
//   - the toggle is exposed as plain App.layerStyles state (App.setLayerStyle),
//     the same persisted cascade every other layer-color override already
//     uses, and turning it back off restores the un-flattened fill exactly
//
// Shared plumbing lives in test/browser/harness.mjs — see
// docs/browser-test-harness-plan.md.
//
// USAGE (same NODE_PATH dance as capture.mjs — this repo has no npm install)
//   mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null
//   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
//   NODE_PATH=/tmp/pw-install/node_modules node test/browser/walkshed-flatten.test.mjs
//
// Exits 0 when every check passes, 1 otherwise (same contract as run-golden.mjs).

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/walkshed-flatten.test.mjs");

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
    page.on("dialog", (d) => d.accept()); // fetchRoadNetwork()'s large-area confirm

    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });

    // ---- Set up: a network plus two nearby points ----
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });

    // Near the grid's middle (row 6 of 0-13), ~170m apart — close enough
    // that both points' 15-min AND 30-min bands overlap heavily, and far
    // enough from every grid edge that neither band gets clipped by running
    // off the downloaded network.
    await page.evaluate(() => {
      App.addPoint(-104.995 + 0.005 * 6.4, 39.735 + 0.005 * 6);
      App.addPoint(-104.995 + 0.005 * 6.6, 39.735 + 0.005 * 6);
    });
    check("two points placed", (await page.evaluate(() => App.points.length)) === 2);

    // ---- Run the Walkshed module (15 / 30 min, default speed) ----
    // App.openModulePopup is assigned inside map.js's async "load" handler,
    // not at script-parse time like App.fetchRoadNetwork/roadNetworkLoaded
    // above — map.loaded() can go true before that handler finishes, so wait
    // for the function to actually exist rather than racing it.
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

    const unflattened = await page.evaluate(() => ({
      fill: App.map.getSource("walkshed-src")._data.features.length,
      line: App.map.getSource("walkshed-line-src")._data.features.length
    }));
    // 2 points x 2 bands (15, 30 min) each = 4 ring-differenced polygons in
    // BOTH sources when nothing is flattened — the fill and outline sources
    // are identical off.
    check("flatten off: fill has one polygon per point per band",
      unflattened.fill === 4, JSON.stringify(unflattened));
    check("flatten off: outline matches fill (nothing flattened yet)",
      unflattened.line === unflattened.fill, JSON.stringify(unflattened));

    const normalOutline = await page.evaluate(() => ({
      width: App.map.getPaintProperty("walkshed-line", "line-width"),
      opacity: App.map.getPaintProperty("walkshed-line", "line-opacity")
    }));
    check("flatten off: outline paint is the normal, clearly-visible style",
      normalOutline.width === 2 && normalOutline.opacity === 0.9, JSON.stringify(normalOutline));

    // ---- Turn "Flatten overlaps" on via the same App.layerStyles cascade
    // the Layers panel's checkbox writes through ----
    await page.evaluate(() => App.setLayerStyle("walkshed", { flatten: true }));
    await page.waitForFunction(
      () => { const s = App.map.getSource("walkshed-src"); return s && s._data && s._data.features.length === 2; },
      { timeout: 5000 }
    ).catch(() => {}); // fall through to the explicit check below for a clearer failure message

    const flattened = await page.evaluate(() => {
      const fillFc = App.map.getSource("walkshed-src")._data;
      const lineFc = App.map.getSource("walkshed-line-src")._data;
      // No two fill features should overlap — that is the whole point of
      // flattening: each tier is disjoint from every smaller one.
      let anyOverlap = false;
      for (let i = 0; i < fillFc.features.length && !anyOverlap; i++) {
        for (let j = i + 1; j < fillFc.features.length; j++) {
          let inter = null;
          try { inter = turf.intersect(fillFc.features[i], fillFc.features[j]); } catch (e) { /* treat as no overlap */ }
          if (inter && turf.area(inter) > 1) { anyOverlap = true; break; } // >1 m^2, ignore float-noise slivers
        }
      }
      return {
        fillCount: fillFc.features.length,
        lineCount: lineFc.features.length,
        fillMinutes: fillFc.features.map((f) => f.properties.minutes).sort((a, b) => a - b),
        anyOverlap
      };
    });
    // One flattened polygon per distinct minutes TIER (15, 30) across both
    // points combined, not per point-band — this is the actual behavior
    // change: 4 per-point polygons collapse to 2 tier polygons.
    check("flatten on: fill collapses to one polygon per tier",
      flattened.fillCount === 2, JSON.stringify(flattened));
    check("flatten on: tiers are the expected minute values",
      JSON.stringify(flattened.fillMinutes) === JSON.stringify([15, 30]), JSON.stringify(flattened));
    check("flatten on: no two fill polygons overlap (shortest walkshed wins)",
      flattened.anyOverlap === false, JSON.stringify(flattened));
    // The outline layer is untouched by flattening — every point's own band
    // boundary is still drawn, so an overlap stays visible as an outline
    // even though the fill only shows the shortest band there.
    check("flatten on: outline still shows every point's own bands",
      flattened.lineCount === unflattened.line, JSON.stringify(flattened));

    const subtleOutline = await page.evaluate(() => ({
      width: App.map.getPaintProperty("walkshed-line", "line-width"),
      opacity: App.map.getPaintProperty("walkshed-line", "line-opacity")
    }));
    // The preserved per-point outlines mostly sit INSIDE the flattened fill
    // now (not on its real edge), so they must be much less prominent than
    // the flatten-off style — thinner and far lower opacity, not removed.
    check("flatten on: outline is thinner and much lower opacity than normal",
      subtleOutline.width < normalOutline.width && subtleOutline.opacity < 0.2,
      JSON.stringify({ normalOutline, subtleOutline }));

    // ---- Turn it back off: fill must return to the un-flattened set ----
    await page.evaluate(() => App.setLayerStyle("walkshed", { flatten: null }));
    await page.waitForFunction(
      () => { const s = App.map.getSource("walkshed-src"); return s && s._data && s._data.features.length === 4; },
      { timeout: 5000 }
    );
    const restored = await page.evaluate(() => ({
      fill: App.map.getSource("walkshed-src")._data.features.length,
      styleCleared: !App.layerStyles.walkshed
    }));
    check("flatten off again: fill restores to per-point-per-band polygons",
      restored.fill === 4, JSON.stringify(restored));
    check("clearing the only override removes the layerStyles entry entirely",
      restored.styleCleared, JSON.stringify(restored));

    const restoredOutline = await page.evaluate(() => ({
      width: App.map.getPaintProperty("walkshed-line", "line-width"),
      opacity: App.map.getPaintProperty("walkshed-line", "line-opacity")
    }));
    check("flatten off again: outline paint returns to the normal style",
      restoredOutline.width === normalOutline.width && restoredOutline.opacity === normalOutline.opacity,
      JSON.stringify(restoredOutline));

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
