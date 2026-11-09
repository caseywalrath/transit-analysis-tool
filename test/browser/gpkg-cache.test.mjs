#!/usr/bin/env node
// test/browser/gpkg-cache.test.mjs
//
// Imported GeoPackage layers must survive a page refresh, through the real
// startup path (app.js → App.restoreCachedGpkg), the same way gtfs-cache
// checks the GTFS feed:
//
//   - import two layers through the real picker, reload: both come back,
//     with their colors, and no extra layers
//   - a recolored layer keeps its new color across a reload
//   - a layer's filter and fill transparency come back after a reload
//   - Remove layer on one: after a reload only the other comes back
//   - removing a file's last layer deletes its stored copy
//   - toolbar Clear empties the store
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see
// test/browser/README.md (NODE_PATH points at a Playwright install).

import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gpkg-cache.test.mjs");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "sample.gpkg");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

// Imports as listed by the Layers-panel manifest: label and paint color of
// the first layer (fill for polygons, circle for points).
const imports = (page) => page.evaluate(() => (App.gpkgReferenceEntries ? App.gpkgReferenceEntries() : []).map((e) => {
  const L = e.layers[0];
  const prop = L.op === "fill-opacity" ? "fill-color" : L.op === "circle-opacity" ? "circle-color" : "line-color";
  return { label: e.label, color: App.map.getPaintProperty(L.id, prop), styleKey: e.styleKey };
}));
const stored = (page) => page.evaluate(async () => (await App.gpkgStore.list()).map((r) => ({ name: r.name, layers: r.layers, colors: r.colors })));

async function waitImports(page, n, timeout = 20000) {
  await page.waitForFunction((k) => App.gpkgReferenceEntries && App.gpkgReferenceEntries().length === k, n, { timeout }).catch(() => {});
  return imports(page);
}
async function waitStored(page, pred, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await stored(page);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}
async function load(page, url) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction("window.App && App.map && App.map.loaded() && App.gpkgStore", { timeout: 30000 });
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
    await load(page, url);
    await page.evaluate(() => App.gpkgStore.clear());

    // Import pts_utm and polys_utm through the real picker.
    await page.setInputFiles("#ad-gpkg-file", FIXTURE);
    await page.waitForFunction(() => !document.getElementById("gp-dialog").hidden, null, { timeout: 20000 });
    await page.evaluate(() => {
      document.querySelectorAll("#gp-layer-list label.gp-row").forEach((row) => {
        const cb = row.querySelector("input");
        const name = row.querySelector(".gp-name").textContent;
        if (!cb.disabled && cb.checked !== (name === "pts_utm" || name === "polys_utm")) cb.click();
      });
      document.getElementById("gp-add").click();
    });
    const first = await waitImports(page, 2);
    const savedFirst = await waitStored(page, (s) => s.length === 1 && s[0].layers.length === 2);
    check("1. importing two layers stores the file once with both tables",
      savedFirst.length === 1 && savedFirst[0].name.indexOf("sample.gpkg|") === 0 &&
      savedFirst[0].layers.slice().sort().join() === "polys_utm,pts_utm", JSON.stringify(savedFirst));

    await load(page, url);
    const back = await waitImports(page, 2);
    const byLabel = (list) => Object.fromEntries(list.map((x) => [x.label, x.color]));
    check("2. after a reload both layers come back with the same colors and order",
      back.length === 2 && JSON.stringify(back.map((x) => x.label)) === JSON.stringify(first.map((x) => x.label)) &&
      JSON.stringify(byLabel(back)) === JSON.stringify(byLabel(first)), JSON.stringify({ first, back }));

    // Recolor the point layer, then reload.
    const ptKey = back.find((x) => x.label.endsWith("pts_utm")).styleKey;
    await page.evaluate((k) => App.setLayerStyle(k, { color: "#123456" }), ptKey);
    await waitStored(page, (s) => s[0] && s[0].colors.pts_utm && s[0].colors.pts_utm.color === "#123456");
    await load(page, url);
    const recolored = await waitImports(page, 2);
    const pt = recolored.find((x) => x.label.endsWith("pts_utm"));
    check("3. a recolored layer keeps its color across a reload", pt && pt.color === "#123456", JSON.stringify(recolored));
    // Reset must still go back to the import's own color, not the recolor.
    const reset = await page.evaluate((k) => {
      App.clearLayerStyle(k);
      const e = App.gpkgReferenceEntries().find((x) => x.styleKey === k);
      return App.map.getPaintProperty(e.layers[0].id, "circle-color");
    }, pt.styleKey);
    const firstPt = first.find((x) => x.label.endsWith("pts_utm")).color;
    check("3b. after a reload, resetting a recolored layer returns to its original color",
      reset === firstPt, JSON.stringify({ reset, firstPt }));
    await page.evaluate((k) => App.setLayerStyle(k, { color: "#123456" }), pt.styleKey);

    // A filter and a fill transparency set on a layer come back after a reload.
    const polyId = await page.evaluate(() => {
      const e = App.gpkgReferenceEntries().find((x) => x.label.endsWith("polys_utm"));
      const id = e.styleKey.replace(/^gpkg-/, "");
      App.gpkgSetLayerFilter(id, { conditions: [{ field: "label", op: "eq", value: "holed" }] });
      App.gpkgSetFillAlpha(id, 0);
      return id;
    });
    // Polled from here: waitForFunction treats an async predicate's promise as truthy.
    for (let t = 0; t < 50; t++) {
      const ok = await page.evaluate(async () => {
        const r = (await App.gpkgStore.list())[0];
        const v = r && r.views && r.views.find((x) => x.table === "polys_utm");
        return !!(v && v.filter && v.fillAlpha === 0);
      });
      if (ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await load(page, url);
    await waitImports(page, 2);
    const polyState = await page.evaluate(() => {
      const e = App.gpkgReferenceEntries().find((x) => x.label.endsWith("polys_utm"));
      const st = App.gpkgGetLayerState(e.styleKey.replace(/^gpkg-/, ""));
      return { filter: st && st.filter, fillAlpha: st && st.fillAlpha, matchCount: st && st.matchCount, badge: e.badge().text };
    });
    check("3c. a layer's filter and fill transparency come back after a reload",
      polyState.fillAlpha === 0 && polyState.matchCount === 1 && polyState.badge === "1 of 2" &&
      JSON.stringify(polyState.filter) === '{"conditions":[{"field":"label","op":"eq","value":"holed"}]}',
      JSON.stringify({ polyId, polyState }));

    // Remove the polygon layer through the Layers panel.
    await page.evaluate(() => {
      const e = App.gpkgReferenceEntries().find((x) => x.label.endsWith("polys_utm"));
      e.clear();
    });
    await waitStored(page, (s) => s[0] && s[0].layers.length === 1);
    await load(page, url);
    const afterRemove = await waitImports(page, 1);
    // Give a wrongly restored second layer time to appear.
    await page.waitForTimeout(500);
    const afterRemove2 = await imports(page);
    check("4. after Remove layer and a reload only the other layer comes back",
      afterRemove2.length === 1 && afterRemove2[0].label === "sample.gpkg · pts_utm", JSON.stringify({ afterRemove, afterRemove2 }));

    await page.evaluate(() => App.gpkgReferenceEntries()[0].clear());
    const gone = await waitStored(page, (s) => s.length === 0);
    check("5. removing a file's last layer deletes its stored copy", gone.length === 0, JSON.stringify(gone));

    // Re-import, then toolbar Clear.
    await page.evaluate(() => { document.getElementById("ad-gpkg-file").value = ""; });
    await page.setInputFiles("#ad-gpkg-file", FIXTURE);
    await page.waitForFunction(() => !document.getElementById("gp-dialog").hidden, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("gp-add").click());
    await waitStored(page, (s) => s.length === 1);
    await page.evaluate(() => { window.confirm = () => true; document.getElementById("clear").click(); });
    const cleared = await waitStored(page, (s) => s.length === 0);
    await load(page, url);
    await page.waitForTimeout(500);
    const afterClear = await imports(page);
    check("6. toolbar Clear empties the store; nothing comes back after a reload",
      cleared.length === 0 && afterClear.length === 0, JSON.stringify({ cleared, afterClear }));

    // A table without geometry is stored with its file and back after a reload.
    await page.evaluate(() => { document.getElementById("ad-gpkg-file").value = ""; });
    await page.setInputFiles("#ad-gpkg-file", FIXTURE);
    await page.waitForFunction(() => !document.getElementById("gp-dialog").hidden, null, { timeout: 20000 });
    await page.evaluate(() => {
      document.querySelectorAll("#gp-layer-list label.gp-row").forEach((row) => {
        const cb = row.querySelector("input");
        const name = row.querySelector(".gp-name").textContent;
        if (!cb.disabled && cb.checked !== (name === "pts_utm" || name === "notes")) cb.click();
      });
      document.getElementById("gp-add").click();
    });
    const storedT = await waitStored(page, (s) => s.length === 1 && s[0].layers.includes("notes"));
    await load(page, url);
    await waitImports(page, 1);
    const menuT = await page.evaluate(() => {
      const e = App.gpkgReferenceEntries()[0];
      return e ? e.menuItems().map((m) => m.label) : [];
    });
    check("6b. a table without geometry is stored with its file and offered again after a reload",
      storedT.length === 1 && menuT.includes("View table: notes"), JSON.stringify({ storedT, menuT }));
    await page.evaluate(() => App.gpkgClearAll());

    check("7. no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
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
