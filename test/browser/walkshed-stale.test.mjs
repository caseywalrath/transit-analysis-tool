#!/usr/bin/env node
// test/browser/walkshed-stale.test.mjs
//
// Walkshed results in stale detection (docs/layer-removal-plan.md task 3b).
// App.walkshedSignature() is folded into App.featureGeomSignature() and Feature
// Area Analysis's featureGeomSig() only when a point is flagged
// serviceAreaType "walkshed". Checks:
//   - a walkshed run on unflagged points leaves the signature byte-identical
//   - re-running Walkshed with a different budget marks Feature Area Analysis stale
//   - Walkshed Clear results (clearAll) marks it stale again after a fresh re-run
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/walkshed-stale.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/walkshed-stale.test.mjs");

// Same stub street grid as walkshed-flatten.test.mjs (sized so 15/30-min bands polygonize).
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
async function waitFor(page, fn, timeout = 20000, arg = null) {
  try { await page.waitForFunction(fn, arg, { timeout }); return true; } catch (e) { return false; }
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
      if (url.includes("tigerweb.geo.census.gov")) {
        const ring = [[-106, 38.5], [-103, 38.5], [-103, 41], [-106, 41], [-106, 38.5]];
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          type: "FeatureCollection", features: [{ type: "Feature", properties: { GEOID: "080010001001" },
            geometry: { type: "Polygon", coordinates: [ring] } }] }) });
        return true;
      }
      if (url.includes("api.census.gov")) {
        const get = decodeURIComponent((url.match(/[?&]get=([^&]*)/) || [])[1] || "");
        const vars = get.split(",").filter((v) => v !== "NAME");
        const hdr = ["NAME", ...vars, "state", "county", "tract", "block group"];
        const row = ["bg", ...vars.map(() => "100"), "08", "001", "000100", "1"];
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([hdr, row]) });
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

    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });
    await page.evaluate(() => {
      App.addPoint(-104.995 + 0.005 * 6.4, 39.735 + 0.005 * 6);
      App.addPoint(-104.995 + 0.005 * 6.6, 39.735 + 0.005 * 6);
    });
    // The first notifyProject after a network load bumps the network epoch once
    // (refreshNetworkConnectors' first signature), which would invalidate walksheds
    // computed before it. Real sessions notify long before a run; do the same here.
    await page.evaluate(() => App.notifyProject());

    const sig = () => page.evaluate(() => App.featureGeomSignature());
    const sig0 = await sig();
    check("no flagged points: signature has no walkshed part", !sig0.includes("#ws:"));

    // ---- Walkshed run on unflagged points ----
    const runWalkshed = async (minutes) => {
      await page.evaluate(() => App.openModulePopup("walkshed"));
      await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
      if (!(await page.locator("#wsMinutes").isVisible())) await page.locator(".module-inputs-header").first().click();
      await page.locator("#wsMinutes").fill(String(minutes));
      await page.locator("#wsMinutes2").fill("");
      await page.locator("#wsMinutes3").fill("");
      await page.evaluate(() => { window.__wsDone = false; });
      await page.locator("#wsComputeBtn").click();
      return waitFor(page, (m) => (document.getElementById("wsStatus") || {}).textContent.includes("Calculated") &&
        document.querySelector("#wsResultsTable") && document.querySelector("#wsResultsTable").textContent.includes(String(m)), 20000, minutes);
    };
    check("walkshed run (15 min) completes", await runWalkshed(15));
    check("unflagged walkshed run leaves the signature byte-identical", (await sig()) === sig0);

    // ---- Flag both points as walkshed study areas ----
    if (!(await page.locator("#wsUseStudyArea").isVisible())) await page.locator(".module-inputs-header").first().click().catch(() => {});
    await page.evaluate(() => document.getElementById("wsUseStudyArea").click());
    await waitFor(page, () => App.points.every((p) => p.properties.attributes && p.properties.attributes.serviceAreaType === "walkshed"), 5000);
    const sigFlag = await sig();
    check("flagged points: signature carries a walkshed part with both results",
      sigFlag.split("#ws:")[1].split(";").length === 2 && !sigFlag.split("#ws:")[1].split(";").some((p) => p.endsWith("=-")), sigFlag.slice(sigFlag.indexOf("#ws:")).slice(0, 160));
    check("walkshed signature is stable across calls", (await sig()) === sigFlag);
    check("App.walkshedSignature exposed", await page.evaluate(() => typeof App.walkshedSignature === "function"));

    // ---- Feature Area Analysis run ----
    const basStale = () => page.evaluate(() => !!document.querySelector("#basStatus.rf-status-stale"));
    const runBas = async () => {
      await page.evaluate(() => App.openModulePopup("buffer-summary"));
      await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
      await page.waitForSelector("#basFeatureChecklist .rf-feature-check-row");
      await page.evaluate(() => {
        const v = document.querySelector('#varSelect input[type="checkbox"]');
        if (!v.checked) { v.checked = true; v.dispatchEvent(new Event("change", { bubbles: true })); }
        document.getElementById("basRun").click();
      });
      return waitFor(page, () => (document.getElementById("basStatus") || {}).textContent.includes("Done") &&
        !document.querySelector("#basStatus.rf-status-stale"), 30000);
    };
    const openBas = async () => {
      await page.evaluate(() => App.openModulePopup("buffer-summary"));
      await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    };
    check("Feature Area Analysis run completes, not stale", await runBas());

    // ---- Re-run Walkshed with a different budget ----
    check("walkshed re-run (20 min) completes", await runWalkshed(20));
    check("re-run changes the walkshed signature", (await sig()) !== sigFlag);
    check("walkshed's own results are not left stale by its broadcast",
      await waitFor(page, () => !document.querySelector("#wsStatus.rf-status-stale") &&
        (document.getElementById("wsStatus") || {}).textContent.includes("Calculated"), 5000),
      await page.evaluate(() => document.getElementById("wsStatus").textContent));
    await openBas();
    check("flagged buffers use the new walkshed (bufs flagged walkshed)",
      await page.evaluate(() => App.buffers.filter((b) => b && b.properties && b.properties.walkshed).length === 2));
    check("budget change marks Feature Area Analysis stale", await waitFor(page, () => !!document.querySelector("#basStatus.rf-status-stale"), 5000));

    // ---- Fresh BAS run, then Walkshed Clear results ----
    check("Feature Area Analysis re-run clears stale", await runBas());
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    if (!(await page.locator("#wsClearResults").isVisible())) await page.locator(".module-inputs-header").first().click();
    await page.locator("#wsClearResults").click();
    check("clear drops the study-area walkshed buffers",
      await waitFor(page, () => !App.buffers.some((b) => b && b.properties && b.properties.walkshed), 5000));
    check("cleared walkshed signature marks points as falling back", (await sig()).split("#ws:")[1].split(";").every((p) => p.endsWith("=-")));
    await openBas();
    check("walkshed Clear marks Feature Area Analysis stale", await waitFor(page, () => !!document.querySelector("#basStatus.rf-status-stale"), 5000));

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
