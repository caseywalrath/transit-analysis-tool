#!/usr/bin/env node
// test/browser/gpkg-table.test.mjs
//
// Behavior test for the attribute-table window (js/core/gpkg-table.js).
// Drives the real app in headless Chromium and asserts:
//
//   - the window draws at most 500 rows, with the count line and the file-size note
//   - the filter matches any column and the count switches to "matching rows"
//   - a row click reports its row index and marks that row active
//   - keys typed in the filter do not reach the app's shortcuts
//   - a second open replaces the window and hides the row-click hint; close removes it
//   - no uncaught page errors occurred
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see
// test/browser/README.md (NODE_PATH points at a Playwright install).

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gpkg-table.test.mjs");

const WIDGET = '.floating-widget[data-widget-id="gpkg-table"]';

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
    await routeVendoredAssets(context, port, () => false);

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && App.popup && App.gpkgOpenTable", { timeout: 30000 });

    // Open with 600 synthetic rows out of a file of 700.
    await page.evaluate(async () => {
      const rows = [];
      for (let i = 0; i < 600; i++) rows.push({ id: i, name: "row " + i, secs: i * 1.5 });
      window.__gpkgClicks = [];
      await App.gpkgOpenTable({
        title: "Test table — test.gpkg",
        columns: ["id", "name", "secs"],
        rows: rows,
        total: 700,
        onRowClick: function (i) { window.__gpkgClicks.push(i); }
      });
    });

    // ---- 1. Window exists with 500 body rows ----
    const bodyRows1 = await page.locator(WIDGET + " tbody tr").count();
    const windows1 = await page.locator(WIDGET).count();
    check("window exists with 500 body rows",
      windows1 === 1 && bodyRows1 === 500, "windows=" + windows1 + " rows=" + bodyRows1);

    // ---- 2. Count text ----
    const count2 = await page.locator(WIDGET + " .gp-table-count").textContent();
    check("count text reads 600 rows, showing first 500, file has 700",
      count2 === "600 rows · showing first 500 · file has 700, only 600 loaded", JSON.stringify(count2));

    // ---- 3. Filter ----
    await page.fill(WIDGET + " .gp-table-filter", "row 59");
    // The filter waits for typing to pause before redrawing.
    await page.waitForFunction((w) => {
      const c = document.querySelector(w + " .gp-table-count");
      return c && c.textContent.indexOf("matching") >= 0;
    }, WIDGET, { timeout: 3000 }).catch(() => {});
    const bodyRows3 = await page.locator(WIDGET + " tbody tr").count();
    const count3 = await page.locator(WIDGET + " .gp-table-count").textContent();
    check("filter 'row 59' leaves 11 rows with a matching-rows count",
      bodyRows3 === 11 && count3.startsWith("11 matching rows"), "rows=" + bodyRows3 + " count=" + JSON.stringify(count3));

    // ---- 4. Row click ----
    const second = page.locator(WIDGET + " tbody tr").nth(1);
    const secondIdx = await second.getAttribute("data-row");
    await second.click();
    const s4 = await page.evaluate(() => ({
      clicks: window.__gpkgClicks,
      active: Array.prototype.map.call(
        document.querySelectorAll('.floating-widget[data-widget-id="gpkg-table"] tr.gp-row-active'),
        function (tr) { return tr.getAttribute("data-row"); })
    }));
    check("clicking the second visible row calls onRowClick with its index and marks it active",
      secondIdx === "590" && JSON.stringify(s4.clicks) === "[590]" &&
      JSON.stringify(s4.active) === '["590"]',
      "clicked=" + secondIdx + " clicks=" + JSON.stringify(s4.clicks) + " active=" + JSON.stringify(s4.active));

    // ---- 5. Keys in the filter stay out of app shortcuts ----
    const drawBefore = await page.evaluate(() => App.drawMode);
    await page.focus(WIDGET + " .gp-table-filter");
    await page.keyboard.press("p");
    const drawAfter = await page.evaluate(() => App.drawMode);
    const filterValue = await page.inputValue(WIDGET + " .gp-table-filter");
    check("pressing p in the filter does not change App.drawMode",
      drawBefore === drawAfter && filterValue === "row 59p",
      "before=" + drawBefore + " after=" + drawAfter + " filter=" + JSON.stringify(filterValue));

    // ---- 6. Second open without a row click ----
    await page.evaluate(async () => {
      await App.gpkgOpenTable({ title: "Second table", columns: ["id"], rows: [{ id: 1 }], total: 1, onRowClick: null });
    });
    const hints6 = await page.locator(WIDGET + " .gp-table-hint").count();
    const windows6 = await page.locator(WIDGET).count();
    check("second open with onRowClick null shows no hint and leaves one window",
      hints6 === 0 && windows6 === 1, "hints=" + hints6 + " windows=" + windows6);

    // ---- 7. Close ----
    await page.evaluate(() => App.gpkgCloseTable());
    const windows7 = await page.locator(WIDGET).count();
    check("gpkgCloseTable removes the window", windows7 === 0, "windows=" + windows7);

    // ---- 8. No page errors ----
    check("no uncaught page errors occurred",
      pageErrors.length === 0, pageErrors.length ? "errors=" + pageErrors.join(" | ").slice(0, 300) : "");
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
