#!/usr/bin/env node
// test/browser/hidden-features.test.mjs
//
// Behavior test for hidden features in analysis checklists
// (docs/hidden-features-analysis-plan.md). Phase 2: Feature Area Analysis.
// Census/TIGERweb are unreachable in the sandbox (the harness aborts remote
// hosts), so runs are asserted on status/progress text, not on results.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/hidden-features.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/hidden-features.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const ROW = (n) => `#basFeatureChecklist .rf-feature-check-row:nth-child(${n})`;

async function rowState(page, n) {
  return page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const cb = row.querySelector("input[type=checkbox]");
    return { disabled: cb.disabled, checked: cb.checked, muted: row.classList.contains("ac-hidden"),
      tag: !!row.querySelector(".ac-hidden-tag"), title: row.title || "" };
  }, ROW(n));
}

// Status text lives in #basStatus; the progress line in #basResultsProgress.
async function statusText(page) {
  return page.evaluate(() => (document.getElementById("basStatus") || {}).textContent || "");
}
async function isStale(page) {
  return page.evaluate(() => !!document.querySelector("#basStatus.rf-status-stale"));
}
async function waitFor(page, fn, timeout = 20000) {
  try { await page.waitForFunction(fn, null, { timeout }); return true; } catch (e) { return false; }
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    // Stub TIGERweb (one big block group) and the ACS API so a run completes.
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
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });

    // Two points; one variable ticked so a run can start.
    await page.evaluate(() => {
      App.addPoint(-104.9, 39.7);
      App.addPoint(-104.8, 39.75);
    });
    await page.evaluate(() => App.openModulePopup("buffer-summary"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.waitForSelector("#basFeatureChecklist .rf-feature-check-row");
    await page.evaluate(() => {
      const v = document.querySelector('#varSelect input[type="checkbox"]');
      v.checked = true; v.dispatchEvent(new Event("change", { bubbles: true }));
    });

    check("Include hidden toggle present and off by default",
      await page.evaluate(() => { const t = document.getElementById("basIncludeHidden"); return !!t && !t.checked; }));

    let r1 = await rowState(page, 1);
    check("visible row enabled, not muted", !r1.disabled && !r1.muted && !r1.tag);

    // ---- Hide point 1 while the popup is open ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));
    r1 = await rowState(page, 1);
    check("hiding a feature grays its row without reopening",
      r1.disabled && r1.muted && r1.tag && r1.title.includes("Include hidden"), JSON.stringify(r1));
    check("hidden row keeps its checked state (default: checked)", r1.checked === true);

    // ---- Uncheck state preserved across hide/show ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false));
    await page.evaluate(() => document.querySelector("#basFeatureChecklist input[type=checkbox]").click());
    check("unchecked visible row is unchecked", !(await rowState(page, 1)).checked);
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));
    check("hidden + previously unchecked stays unchecked", !(await rowState(page, 1)).checked);
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false));
    let r1b = await rowState(page, 1);
    check("showing it again restores enabled + previous (unchecked) state",
      !r1b.disabled && !r1b.muted && !r1b.tag && !r1b.checked, JSON.stringify(r1b));
    await page.evaluate(() => document.querySelector("#basFeatureChecklist input[type=checkbox]").click()); // re-check

    // ---- Select all / Clear ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));
    await page.evaluate(() => document.getElementById("basFeatureSelectNone").click());
    await page.evaluate(() => document.getElementById("basFeatureSelectAll").click());
    const sa = [await rowState(page, 1), await rowState(page, 2)];
    check("Select all ticks enabled boxes only (hidden stays cleared)", !sa[0].checked && sa[1].checked, JSON.stringify(sa));
    await page.evaluate(() => document.getElementById("basFeatureSelectNone").click());
    check("Clear clears every box", !(await rowState(page, 1)).checked && !(await rowState(page, 2)).checked);

    // ---- Hidden-only selection, toggle off: new message ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false));
    await page.evaluate(() => document.getElementById("basFeatureSelectAll").click());
    await page.evaluate(() => document.querySelectorAll("#basFeatureChecklist input[type=checkbox]")[1].click()); // uncheck #2
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));   // only #1 left checked, now hidden
    await page.evaluate(() => document.getElementById("basRun").click());
    check("toggle off, hidden-only selection shows the hidden message",
      await waitFor(page, () => (document.getElementById("basStatus") || {}).textContent.includes("Selected features are hidden")),
      await statusText(page));

    // ---- Toggle on: run gets past the buffer step ----
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());
    check("toggle on enables the hidden row (still tagged)",
      await (async () => { const s = await rowState(page, 1); return !s.disabled && s.tag && !s.muted; })());
    await page.evaluate(() => document.getElementById("basRun").click());
    check("toggle on: run passes the buffer step (no hidden/no-buffers error)",
      await waitFor(page, () => {
        const t = (document.getElementById("basStatus") || {}).textContent || "";
        const p = (document.getElementById("basResultsProgress") || {}).textContent || "";
        return !t.includes("Selected features are hidden") && !t.includes("No buffers") && (p.length > 0 || t.length > 0);
      }), await statusText(page));
    check("toggle on: run completes (Done)",
      await waitFor(page, () => (document.getElementById("basStatus") || {}).textContent.includes("Done"), 30000),
      await statusText(page));
    check("results notes disclose hidden features",
      await page.evaluate(() => document.getElementById("basResultsNotes").textContent.includes("Includes 1 feature hidden on the map.")));
    check("fresh results are not stale", !(await isStale(page)));

    // ---- Staleness ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 1 }], true)); // not selected in the run
    await new Promise((r) => setTimeout(r, 300));
    check("hiding an unselected feature does NOT mark results stale", !(await isStale(page)));
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 1 }], false));
    await new Promise((r) => setTimeout(r, 300));
    check("showing an unselected feature does NOT mark results stale", !(await isStale(page)));
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false)); // in the run's selection
    check("changing hidden state of a selected feature marks results stale",
      await waitFor(page, () => !!document.querySelector("#basStatus.rf-status-stale"), 5000));
    await page.evaluate(() => document.getElementById("basRun").click());
    check("re-run clears stale",
      await waitFor(page, () => (document.getElementById("basStatus") || {}).textContent.includes("Done") &&
        !document.querySelector("#basStatus.rf-status-stale"), 30000));
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());   // toggle off after a run
    check("changing the toggle after a run marks results stale",
      await waitFor(page, () => !!document.querySelector("#basStatus.rf-status-stale"), 5000));
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());   // back on for persistence

    // ---- Persistence of the toggle ----
    await page.evaluate(() => App.cache.save());
    await waitFor(page, () => { // save is debounced; wait for the payload to land
      const raw = localStorage.getItem("mat-session");
      return !!raw && JSON.parse(raw).moduleState["buffer-summary"].includeHidden === true;
    }, 10000);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });
    await page.evaluate(() => App.openModulePopup("buffer-summary"));
    await page.waitForSelector("#basIncludeHidden");
    check("toggle survives a reload",
      await page.evaluate(() => document.getElementById("basIncludeHidden").checked));
    // untick for the next section
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());
    check("toggle can be turned off again and persists in the cache payload",
      await waitFor(page, () => { const raw = localStorage.getItem("mat-session");
        return !!raw && JSON.parse(raw).moduleState["buffer-summary"].includeHidden === false; }, 10000));

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
