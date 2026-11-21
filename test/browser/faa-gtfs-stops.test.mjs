#!/usr/bin/env node
// test/browser/faa-gtfs-stops.test.mjs
//
// Behavior test for the "GTFS stop selection" row in Feature Area Analysis
// (js/projects/buffer-summary.js), against the real app in headless Chromium and the mini
// fixture (test/fixtures/gtfs/mini). TIGERweb and the ACS API are stubbed the way
// hidden-features.test.mjs does, so a run completes; the study area is read by wrapping
// App.fetchTigerwebGeos, which receives the run's union.
//
//   - the row is absent without a feed, disabled with no stops, and its count follows the selection
//   - a run with only the GTFS row ticked uses a study area of plain circles at the buffer distance
//   - the results note and the by-geography CSV say how many stops were included
//   - changing the selection marks shown results stale; the checkbox is saved with the session
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/faa-gtfs-stops.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/faa-gtfs-stops.test.mjs");

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

const ROW = "#basFeatureChecklist input[data-type=gtfs]";

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await routeVendoredAssets(context, port, (route, url) => {
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
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    const labelText = () => page.evaluate((sel) => {
      const cb = document.querySelector(sel);
      return cb ? cb.closest(".rf-feature-check-row").textContent.trim() : null;
    }, ROW);
    const waitFor = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 }).then(() => true, () => false);

    await page.evaluate(() => App.openModulePopup("buffer-summary"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.waitForSelector("#basFeatureChecklist");
    check("1. no feed loaded: the GTFS row is absent", await page.locator(ROW).count() === 0);

    // Loading the feed while the panel is open adds the row at once.
    await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      return App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
    }, mini);
    await waitFor((sel) => !!document.querySelector(sel), ROW);
    const state2 = await page.evaluate((sel) => { const cb = document.querySelector(sel); return cb && { disabled: cb.disabled, checked: cb.checked }; }, ROW);
    const label2 = await labelText();
    check("2. feed loaded, no stops selected: row present, disabled, unchecked, says so",
      !!state2 && state2.disabled && !state2.checked && /no stops selected/.test(label2 || ""), JSON.stringify(state2) + " " + label2);

    // Selecting stops updates the open panel's label.
    await page.evaluate(() => App.gtfsStops.set(["S1", "R2"]));
    await waitFor((sel) => { const cb = document.querySelector(sel); return !!cb && !cb.disabled; }, ROW);
    const state3 = await page.evaluate((sel) => { const cb = document.querySelector(sel); return { disabled: cb.disabled, checked: cb.checked }; }, ROW);
    const label3 = await labelText();
    check("3. selecting 2 stops: label reads 2 stops, row enabled and ticked by default",
      /GTFS stop selection \(2 stops\)/.test(label3 || "") && !state3.disabled && state3.checked, JSON.stringify(state3) + " " + label3);
    check("4. the row's tooltip says Use Display Buffers does not apply",
      await page.evaluate((sel) => document.querySelector(sel).closest(".rf-feature-check-row").title.includes("Use Display Buffers does not apply"), ROW));

    await page.screenshot({ path: "/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/a6/shots/faa-gtfs-row-light.png" });
    await page.evaluate(() => document.body.classList.add("dark-mode"));
    await page.screenshot({ path: "/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/a6/shots/faa-gtfs-row-dark.png" });
    await page.evaluate(() => document.body.classList.remove("dark-mode"));

    // Run with only the GTFS row (nothing drawn); capture the union the run sends to TIGERweb.
    await page.evaluate(() => {
      window.__union = null;
      const orig = App.fetchTigerwebGeos;
      App.fetchTigerwebGeos = function (level, union) { window.__union = union; return orig.apply(this, arguments); };
      const v = document.querySelector('#varSelect input[type="checkbox"]');
      v.checked = true; v.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("basBufferMiles").value = "0.5";
      document.getElementById("basBufferMiles").dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("basRun").click();
    });
    const done = await waitFor(() => document.getElementById("basStatus").textContent.includes("Done"));
    check("5. a run with only the GTFS row ticked completes", done, await page.evaluate(() => document.getElementById("basStatus").textContent));
    const geo = await page.evaluate(() => {
      const u = window.__union;
      if (!u) return null;
      const s1 = turf.point([-104.99, 39.74]), r2 = turf.point([-104.67, 39.85]);
      return { s1: turf.booleanPointInPolygon(s1, u), r2: turf.booleanPointInPolygon(r2, u),
        areaSqMi: turf.area(u) / 2589988.110336 };
    });
    check("6. the study area contains both stop points", !!geo && geo.s1 && geo.r2, JSON.stringify(geo));
    const expected = 2 * Math.PI * 0.25;
    check("7. its area is about two 0.5 mi circles (within 5 %)",
      !!geo && Math.abs(geo.areaSqMi - expected) / expected < 0.05, geo ? geo.areaSqMi.toFixed(3) + " vs " + expected.toFixed(3) : "no union");
    const notes = await page.evaluate(() => document.getElementById("basResultsNotes").textContent);
    check("8. the results note says 'Includes 2 GTFS stops (stop selection).'", notes.includes("Includes 2 GTFS stops (stop selection)."), notes.slice(0, 200));

    const dl = page.waitForEvent("download", { timeout: 10000 });
    await page.evaluate(() => document.getElementById("basExportGeoCsv").click());
    const csvPath = await (await dl).path();
    const csv = readFileSync(csvPath, "utf8");
    check("9. the by-geography CSV carries a '# Includes 2 GTFS stops' line", csv.split("\n").some((l) => l === "# Includes 2 GTFS stops (stop selection)."), csv.slice(0, 200));

    // Selection change marks the shown results stale.
    const staleBefore = await page.evaluate(() => !!document.querySelector("#basStatus.rf-status-stale"));
    await page.evaluate(() => App.gtfsStops.add(["S2"]));
    const stale = await waitFor(() => !!document.querySelector("#basStatus.rf-status-stale"));
    check("10. changing the stop selection marks the results stale (and the label follows)",
      !staleBefore && stale && /\(3 stops\)/.test(await labelText() || ""), "before " + staleBefore + ", after " + stale);

    // Session round trip of the checkbox.
    await page.evaluate(() => { const cb = document.querySelector("#basFeatureChecklist input[data-type=gtfs]"); cb.click(); });
    const saved = await page.evaluate(() => App.cache.collectState("full").moduleState["buffer-summary"].gtfsStops);
    check("11. unticking the row is saved as gtfsStops:false", saved === false, String(saved));
    const roundTrip = await page.evaluate(() => {
      const st = App.cache.collectState("full");
      st.moduleState["buffer-summary"].gtfsStops = true;
      App.cache.applyState(st);
      return App.cache.collectState("full").moduleState["buffer-summary"].gtfsStops;
    });
    check("12. applying a session with gtfsStops:true restores it", roundTrip === true, String(roundTrip));
    const legacy = await page.evaluate(() => {
      const st = App.cache.collectState("full");
      st.moduleState["buffer-summary"].gtfsStops = false;
      App.cache.applyState(st);
      const st2 = App.cache.collectState("full");
      delete st2.moduleState["buffer-summary"].gtfsStops;
      App.cache.applyState(st2);
      return App.cache.collectState("full").moduleState["buffer-summary"].gtfsStops;
    });
    check("13. a session without gtfsStops loads as true", legacy === true, String(legacy));

    check("14. no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
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
