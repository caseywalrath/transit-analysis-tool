#!/usr/bin/env node
// test/browser/layers-delete-feature.test.mjs
//
// A drawn feature's right-click menu in the Layers panel offers Delete, which
// shares App.deleteFeature with the Features list (undo snapshot, post-delete
// refresh, save). Checks: the point is gone, both lists update, and Undo
// restores it.
//
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/layers-delete-feature.test.mjs");

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
    page.on("dialog", (d) => d.accept());

    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForFunction("typeof App.deleteFeature === 'function'", { timeout: 10000 });

    await page.evaluate(() => {
      App.addPoint(-104.99, 39.74);
      App.points[0].properties.name = "Del Me";
      App.addPoint(-104.98, 39.75);
      App.points[1].properties.name = "Keep Me";
    });
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    const rowSel = '#fp-tab-layers .lp-feature .lp-row-label';
    // Drawn features sit in collapsed group blocks; expand every one.
    await page.waitForFunction(() => document.querySelector("#fp-tab-layers .lp-group-header .lp-caret, #fp-tab-layers .lp-feature"), { timeout: 10000 });
    await page.evaluate(() => {
      document.querySelectorAll('#fp-tab-layers .lp-group-header .lp-caret[aria-expanded="false"]').forEach((b) => b.click());
    });
    await page.locator(rowSel, { hasText: "Del Me" }).waitFor({ state: "visible", timeout: 10000 });
    const count = () => page.evaluate(() => App.points.length);
    check("two points before delete", (await count()) === 2);

    await page.locator(rowSel, { hasText: "Del Me" }).click({ button: "right" });
    await page.locator("#fp-context-menu").waitFor({ state: "visible", timeout: 5000 });
    const items = await page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
    check("menu offers Delete last", items[items.length - 1] === "Delete", JSON.stringify(items));
    await page.locator("#fp-context-menu button", { hasText: /^Delete$/ }).click();

    await page.waitForFunction(() => App.points.length === 1, { timeout: 5000 }).catch(() => {});
    check("App.points is shorter", (await count()) === 1);
    check("the right point was removed", await page.evaluate(() => App.points[0].properties.name === "Keep Me"));
    await page.waitForFunction(() => !Array.from(document.querySelectorAll("#fp-tab-layers .lp-row-label")).some((e) => e.textContent === "Del Me"), { timeout: 5000 }).catch(() => {});
    check("Layers row is gone", await page.evaluate(() => !Array.from(document.querySelectorAll("#fp-tab-layers .lp-row-label")).some((e) => e.textContent === "Del Me")));
    check("Features list updated", await page.evaluate(() => !(document.getElementById("fp-features") || { textContent: "" }).textContent.includes("Del Me")));

    await page.evaluate(() => App.undo.undo());
    await page.waitForFunction(() => App.points.length === 2, { timeout: 5000 }).catch(() => {});
    check("Undo restores the point", await page.evaluate(() => App.points.length === 2 && App.points.some((p) => p.properties.name === "Del Me")));

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
