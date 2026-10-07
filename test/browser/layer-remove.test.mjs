#!/usr/bin/env node
// test/browser/layer-remove.test.mjs
//
// The Layers panel's shared Remove layer path (layers-panel.js removeEntry):
// it must snapshot for undo, clear, notify modules, save and re-render for
// BOTH the reference and analysis bands. Before this path existed, reference
// rows skipped the save, so a reload brought the removed layer back.
//
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/layer-remove.test.mjs");

// Same stub street grid as clear-all.test.mjs (sized so both walkshed bands polygonize).
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

// Open a Layers-panel row's ⋯ menu and return the visible menu item labels.
async function rowMenu(page, label) {
  // A long label can overlap the ⋯ chip, so click it programmatically.
  await page.evaluate((l) => {
    document.querySelector('#fp-tab-layers button[aria-label="More actions for ' + l + '"]').click();
  }, label);
  await page.locator("#fp-context-menu").waitFor({ state: "visible", timeout: 5000 });
  return page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
}
async function clickMenuItem(page, text) {
  await page.evaluate((t) => {
    Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === t).click();
  }, text);
}
async function closeMenu(page) {
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const m = document.getElementById("fp-context-menu"); if (m) m.remove(); });
  await page.waitForFunction(() => !document.getElementById("fp-context-menu"), { timeout: 5000 }).catch(() => {});
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
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });

    // ---- App.clearModule contract ----
    const api = await page.evaluate(() => ({
      unknown: App.clearModule("no-such-module"),
      hasWs: App.moduleHasClear("walkshed"),
      hasAs: App.moduleHasClear("attribute-summary")
    }));
    check("clearModule returns false for an unknown module", api.unknown === false, JSON.stringify(api));
    check("moduleHasClear is true for walkshed", api.hasWs === true, JSON.stringify(api));

    // ---- Spies: count undo pushes, notifies and saves made by Remove ----
    await page.evaluate(() => {
      window.__spy = { save: 0, notify: 0, undo: 0 };
      const s = App.cache.save, n = App.notifyProject, u = App.undo.push;
      App.cache.save = function () { window.__spy.save++; return s.apply(this, arguments); };
      App.notifyProject = function () { window.__spy.notify++; return n.apply(this, arguments); };
      App.undo.push = function () { window.__spy.undo++; return u.apply(this, arguments); };
    });

    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });
    await page.waitForFunction(() => !!App.map.getLayer("walk-network-line"), { timeout: 10000 });
    await page.evaluate(() => App.addPoint(-104.995 + 0.005 * 6.5, 39.735 + 0.005 * 6));

    // Run Walkshed, then flag the point as a walkshed study area.
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#wsMinutes").fill("15");
    await page.locator("#wsMinutes2").fill("");
    await page.locator("#wsMinutes3").fill("");
    await page.locator("#wsComputeBtn").click();
    await page.waitForFunction(
      () => { const s = App.map.getSource("walkshed-src"); return s && s._data && s._data.features.length > 0; },
      { timeout: 20000 }
    );
    await page.evaluate(() => {
      const p = App.points[0];
      p.properties._bufferRadius = 0.5;
      p.properties.attributes = Object.assign({}, p.properties.attributes, { serviceAreaType: "walkshed" });
      App.refreshBuffers();
    });
    await page.waitForFunction(() => App.buffers[0] && App.buffers[0].properties.walkshed, { timeout: 5000 });
    check("flagged point's buffer is the walkshed polygon before removal", true);

    // Show the Layers tab so rows are rendered.
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    await page.locator('#fp-tab-layers button[aria-label="More actions for Walkshed"]').first()
      .waitFor({ state: "visible", timeout: 10000 });

    // ---- walkshed-seg has no Remove yet (its street-only clear comes separately) ----
    if (await page.locator('#fp-tab-layers button[aria-label="More actions for Walkshed — reachable streets"]').count()) {
      const segItems = await rowMenu(page, "Walkshed — reachable streets");
      check("reachable-streets row offers no Remove layer", !segItems.includes("Remove layer"), JSON.stringify(segItems));
      await closeMenu(page);
    }

    // ---- Reference row: Walk network ----
    let items = await rowMenu(page, "Walk network");
    check("Walk network row offers Remove layer", items.includes("Remove layer"), JSON.stringify(items));
    await page.evaluate(() => { window.__spy = { save: 0, notify: 0, undo: 0 }; });
    await clickMenuItem(page, "Remove layer");
    await page.waitForFunction(() => !App.map.getLayer("walk-network-line"), { timeout: 5000 }).catch(() => {});
    let spy = await page.evaluate(() => Object.assign({ layer: !!App.map.getLayer("walk-network-line") }, window.__spy));
    check("reference Remove clears the layer", !spy.layer, JSON.stringify(spy));
    check("reference Remove saves the session", spy.save >= 1, JSON.stringify(spy));
    check("reference Remove notifies modules", spy.notify >= 1, JSON.stringify(spy));
    check("reference Remove pushes an undo snapshot", spy.undo === 1, JSON.stringify(spy));

    // ---- Analysis row: Walkshed (D3: takes reachable streets with it) ----
    items = await rowMenu(page, "Walkshed");
    check("Walkshed row offers Remove layer", items.includes("Remove layer"), JSON.stringify(items));
    await page.evaluate(() => { window.__spy = { save: 0, notify: 0, undo: 0 }; });
    await clickMenuItem(page, "Remove layer");
    await page.waitForFunction(
      () => !(App.buffers[0] && App.buffers[0].properties.walkshed), { timeout: 5000 }
    ).catch(() => {});
    const after = await page.evaluate(() => {
      const src = App.map.getSource("walkshed-src");
      const w = document.getElementById("ws-legend");
      const ring = App.buffers[0].geometry.coordinates[0];
      const expected = turf.circle(turf.point(App.points[0].geometry.coordinates), 0.5, { units: "miles", steps: 64 });
      return {
        layers: ["walkshed-fill", "walkshed-line", "walkshed-seg"].map((id) => !!App.map.getLayer(id)),
        fillFeatures: src && src._data ? src._data.features.length : 0,
        legendHidden: !w || w.style.display === "none" || w.offsetParent === null,
        verts: ring.length, expectedVerts: expected.geometry.coordinates[0].length,
        rowGone: !document.querySelector('#fp-tab-layers button[aria-label="More actions for Walkshed"]'),
        status: (document.getElementById("status") || {}).textContent || "",
        spy: window.__spy
      };
    });
    check("Walkshed Remove removes all walkshed layers",
      after.layers.every((x) => !x) || after.fillFeatures === 0, JSON.stringify(after));
    check("Walkshed Remove hides the legend", after.legendHidden, JSON.stringify(after));
    check("flagged point's buffer reverts to a circle", after.verts === after.expectedVerts, JSON.stringify(after));
    check("Walkshed row disappears from the panel", after.rowGone, JSON.stringify(after));
    check("analysis Remove saves, notifies and pushes undo",
      after.spy.save >= 1 && after.spy.notify >= 1 && after.spy.undo === 1, JSON.stringify(after.spy));

    // ---- Municipal boundaries: any hide resets the Add Data toggle ----
    const muni = await page.evaluate(() => {
      const b = document.getElementById("muni-boundaries-btn");
      b.classList.add("add-data-active");
      App.toggleMuniBoundaries(false);
      return b.classList.contains("add-data-active");
    });
    check("hiding municipal boundaries resets the Add Data toggle", muni === false);

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
