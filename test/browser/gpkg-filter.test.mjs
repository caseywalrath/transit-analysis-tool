#!/usr/bin/env node
// test/browser/gpkg-filter.test.mjs
//
// Browser behavior test for GeoPackage layer filters, fill transparency and
// duplicate views (js/core/gpkg-filter.js, gpkg-filter-ui.js, gpkg-layers.js,
// gpkg-table.js). Drives the real app with test/fixtures/sample.gpkg:
//
//   - a filter set with the layer's drawer narrows the map, the badge and the table
//   - the table's "Show matching on map" filters an unfiltered layer
//   - a boolean column filters by its text form
//   - fill transparency leaves the outline alone
//   - a duplicate shares its original's source, with its own color, filter and name
//   - removing the original keeps the duplicate drawn
//   - filters, fill, the duplicate and its name come back after a reload
//   - no uncaught page errors occurred (checked last)
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see
// test/browser/README.md (NODE_PATH points at a Playwright install).

import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gpkg-filter.test.mjs");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "sample.gpkg");
const WIDGET = '.floating-widget[data-widget-id="gpkg-table"]';
const PTS = "sample.gpkg · pts_utm";
const POLYS = "sample.gpkg · polys_utm";
const POLYS2 = "sample.gpkg · polys_utm (2)";
const TWO_ONLY = "sample.gpkg · Two only";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}
// A check that throws is recorded as a failure, and the checks after it still run.
async function step(name, fn) {
  try {
    const [pass, detail] = await fn();
    check(name, pass, detail);
  } catch (e) {
    check(name, false, "threw: " + e.message);
  }
}

// Polls observable state from Node. waitForFunction cannot poll an async
// predicate: its promise is always truthy, so it would resolve at once.
async function pollValue(page, fn, arg, pred, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg);
    if (pred(value) || Date.now() >= deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Page-side lookups, installed after every page load. Entries are found by
// their Layers-panel label, which is exact, so "polys_utm" never matches
// "polys_utm (2)".
async function installHelpers(page) {
  await page.evaluate(() => {
    const H = {};
    H.entry = (label) => App.gpkgReferenceEntries().find((e) => e.label === label) || null;
    H.id = (label) => { const e = H.entry(label); return e ? e.styleKey.replace(/^gpkg-/, "") : null; };
    H.row = (label) => Array.from(document.querySelectorAll("#fp-tab-layers .lp-row"))
      .find((r) => { const l = r.querySelector(".lp-row-label"); return !!l && (l.title || l.textContent) === label; }) || null;
    H.badge = (label) => { const e = H.entry(label); return e ? e.badge().text : null; };
    H.caret = (label) => { const r = H.row(label); return r ? r.querySelector(".lp-caret") : null; };
    H.drawer = (label) => { const r = H.row(label); return r ? r.closest(".lp-style-group") : null; };
    H.panelLabels = () => Array.from(document.querySelectorAll("#fp-tab-layers .lp-row-label"))
      .map((l) => l.title || l.textContent).filter((s) => s.indexOf("sample.gpkg") === 0);
    // Opens the row's ⋯ menu and clicks one item, as a user would.
    H.menuClick = (label, item) => {
      const row = H.row(label);
      if (!row) throw new Error("no Layers row for " + label);
      row.querySelector(".lp-row-menu").click();
      const btn = Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === item);
      if (!btn) throw new Error("no menu item '" + item + "' for " + label);
      btn.click();
    };
    H.snapshot = () => App.gpkgReferenceEntries().map((e) => {
      const st = App.gpkgGetLayerState(e.styleKey.replace(/^gpkg-/, ""));
      return { label: e.label, badge: e.badge().text, fillAlpha: st.fillAlpha, filter: st.filter };
    });
    window.__t = H;
  });
}

async function load(page, url) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction("window.App && App.map && App.map.loaded() && App.gpkgStore", { timeout: 30000 });
  await installHelpers(page);
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
    await pollValue(page, () => App.gpkgReferenceEntries().length, undefined, (n) => n === 2);
    const ptsId = await page.evaluate((l) => window.__t.id(l), PTS);
    const polysId = await page.evaluate((l) => window.__t.id(l), POLYS);
    await page.evaluate(() => document.querySelector('.fp-tab-btn[data-fptab="layers"]').click());

    await step("1. pts_utm imports with 3 features", async () => {
      const v = await page.evaluate((label) => {
        const e = window.__t.entry(label);
        return e ? { badge: e.badge().text, features: App.gpkgGetLayerState(window.__t.id(label)).featureCount } : null;
      }, PTS);
      return [!!v && v.badge === "3" && v.features === 3, JSON.stringify(v)];
    });

    // The filter is set with the drawer's own controls, the real commit path.
    // Each commit re-renders the Layers panel, so every step queries again.
    await page.evaluate((label) => {
      if (window.__t.caret(label).getAttribute("aria-expanded") !== "true") window.__t.caret(label).click();
    }, PTS);
    await page.evaluate((label) => {
      const s = window.__t.drawer(label).querySelector(".gp-filter-field");
      s.value = "name";
      s.dispatchEvent(new Event("change"));
    }, PTS);
    await page.evaluate((label) => {
      const s = window.__t.drawer(label).querySelector(".gp-filter-op");
      s.value = "eq";
      s.dispatchEvent(new Event("change"));
    }, PTS);
    await page.evaluate((label) => {
      const v = window.__t.drawer(label).querySelector(".gp-filter-value");
      v.value = "east";
      v.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, PTS);

    await step("2. filter name is east → badge '1 of 3' and one rendered point", async () => {
      // Centered on the point at zoom 15, so all three points are on screen and
      // only the filter can hide two of them.
      await page.evaluate((label) => {
        const bb = window.__t.entry(label).bbox();
        App.map.easeTo({ center: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], zoom: 15, duration: 0 });
      }, PTS);
      const names = await pollValue(page, (label) => {
        const e = window.__t.entry(label);
        return App.map.queryRenderedFeatures({ layers: e.layers.map((L) => L.id) }).map((f) => f.properties.name);
      }, PTS, (v) => v.length > 0);
      const badge = await page.evaluate((label) => window.__t.badge(label), PTS);
      const distinct = Array.from(new Set(names));
      return [badge === "1 of 3" && JSON.stringify(distinct) === '["east"]',
        JSON.stringify({ badge, names: distinct })];
    });

    await step("3. filter survives reopening the drawer", async () => {
      await page.evaluate((label) => window.__t.caret(label).click(), PTS); // close
      await page.evaluate((label) => window.__t.caret(label).click(), PTS); // reopen
      const v = await page.evaluate((label) => {
        const sel = window.__t.drawer(label).querySelector(".gp-filter-cond select.gp-filter-field");
        return { field: sel ? sel.value : null, badge: window.__t.badge(label),
          open: window.__t.caret(label).getAttribute("aria-expanded") };
      }, PTS);
      return [v.field === "name" && v.badge === "1 of 3" && v.open === "true", JSON.stringify(v)];
    });

    await step("4. table lists only the matching row and the note names the filter", async () => {
      await page.evaluate((label) => window.__t.menuClick(label, "View attribute table"), PTS);
      const v = await pollValue(page, (w) => {
        const el = document.querySelector(w);
        if (!el) return null;
        const rows = Array.from(el.querySelectorAll("tbody tr"));
        return { rows: rows.length, text: rows.map((r) => r.textContent).join("|"),
          count: (el.querySelector(".gp-table-count") || {}).textContent || "" };
      }, WIDGET, (x) => x && x.rows === 1);
      return [!!v && v.rows === 1 && v.text.indexOf("east") >= 0 && v.count.indexOf("map filter: name is east") >= 0,
        JSON.stringify(v)];
    });

    await step("5. Show matching on map with 'nor' on an unfiltered layer → badge '1 of 3'", async () => {
      await page.evaluate((id) => App.gpkgSetLayerFilter(id, null), ptsId);
      await page.evaluate((label) => window.__t.menuClick(label, "View attribute table"), PTS);
      await pollValue(page, (w) => { const el = document.querySelector(w); return el ? el.querySelectorAll("tbody tr").length : 0; },
        WIDGET, (n) => n === 3);
      await page.fill(WIDGET + " .gp-table-filter", "nor");
      // The apply button enables on the table's debounced redraw.
      await page.waitForFunction(() => { const b = document.querySelector(".gp-table-apply"); return !!b && !b.disabled; },
        null, { timeout: 5000 });
      await page.click(WIDGET + " .gp-table-apply");
      const badge = await pollValue(page, (label) => window.__t.badge(label), PTS, (v) => v === "1 of 3");
      return [badge === "1 of 3", "badge " + badge];
    });

    await step("6. boolean column filters by its text form (flag is true → '2 of 3')", async () => {
      await page.evaluate((id) => App.gpkgSetLayerFilter(id, { conditions: [{ field: "flag", op: "eq", value: "true" }] }), ptsId);
      const badge = await pollValue(page, (label) => window.__t.badge(label), PTS, (v) => v === "2 of 3");
      return [badge === "2 of 3", "badge " + badge];
    });

    await step("7. Fill 0% sets fill-color alpha 0 on polys_utm; outline color unchanged", async () => {
      const ids = await page.evaluate((label) => {
        const e = window.__t.entry(label);
        const fill = e.layers.find((L) => L.op === "fill-opacity");
        const line = e.layers.find((L) => L.op === "line-opacity");
        return { fillId: fill.id, lineId: line.id, lineBefore: App.map.getPaintProperty(line.id, "line-color") };
      }, POLYS);
      await page.evaluate((id) => App.gpkgSetFillAlpha(id, 0), polysId);
      const v = await page.evaluate((x) => ({ fill: App.map.getPaintProperty(x.fillId, "fill-color"),
        line: App.map.getPaintProperty(x.lineId, "line-color") }), ids);
      return [String(v.fill).endsWith(",0)") && v.line === ids.lineBefore, JSON.stringify({ ids, v })];
    });

    await step("8. Duplicate polys_utm → second row, same source id, different color", async () => {
      await page.evaluate((label) => window.__t.menuClick(label, "Duplicate layer"), POLYS);
      const v = await pollValue(page, (a) => {
        const o = window.__t.entry(a.orig), d = window.__t.entry(a.dup);
        if (!o || !d) return null;
        const src = (e) => App.map.getLayer(e.layers[0].id).source;
        const outline = (e) => App.map.getPaintProperty(e.layers.find((L) => L.op === "line-opacity").id, "line-color");
        return { sameSource: src(o) === src(d), colorsDiffer: outline(o) !== outline(d) };
      }, { orig: POLYS, dup: POLYS2 }, (x) => !!x);
      return [!!v && v.sameSource && v.colorsDiffer, JSON.stringify(v)];
    });

    const dupId = await page.evaluate((l) => window.__t.id(l), POLYS2);

    await step("9. filters on the original and the duplicate are independent (each '1 of 2')", async () => {
      await page.evaluate((a) => {
        App.gpkgSetLayerFilter(a.oid, { conditions: [{ field: "label", op: "eq", value: "holed" }] });
        App.gpkgSetLayerFilter(a.did, { conditions: [{ field: "label", op: "eq", value: "two" }] });
      }, { oid: polysId, did: dupId });
      const v = await pollValue(page, (a) => ({
        orig: window.__t.badge(a.o), dup: window.__t.badge(a.d),
        fOrig: JSON.stringify(App.gpkgGetLayerState(a.oid).filter),
        fDup: JSON.stringify(App.gpkgGetLayerState(a.did).filter)
      }), { o: POLYS, d: POLYS2, oid: polysId, did: dupId },
        (x) => x.orig === "1 of 2" && x.dup === "1 of 2");
      return [v.orig === "1 of 2" && v.dup === "1 of 2" && v.fOrig.indexOf('"holed"') >= 0 && v.fDup.indexOf('"two"') >= 0,
        JSON.stringify(v)];
    });

    await step("10. removing the original keeps the duplicate's source and features drawn", async () => {
      await page.evaluate((label) => window.__t.entry(label).clear(), POLYS);
      const info = await page.evaluate((label) => {
        const d = window.__t.entry(label);
        const bb = d.bbox();
        App.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { duration: 0, padding: 80 });
        const src = App.map.getLayer(d.layers[0].id).source;
        return { sourceExists: !!App.map.getSource(src), originalGone: window.__t.entry("sample.gpkg · polys_utm") === null };
      }, POLYS2);
      const drawn = await pollValue(page, (label) => {
        const d = window.__t.entry(label);
        return App.map.queryRenderedFeatures({ layers: d.layers.map((L) => L.id) }).length;
      }, POLYS2, (n) => n > 0);
      return [info.sourceExists && info.originalGone && drawn > 0,
        JSON.stringify({ info, drawn })];
    });

    await step("11. Rename the duplicate to 'Two only' → row label ends with 'Two only'", async () => {
      await page.evaluate(() => { window.prompt = () => "Two only"; });
      await page.evaluate((label) => window.__t.menuClick(label, "Rename…"), POLYS2);
      const labels = await pollValue(page, () => window.__t.panelLabels(), undefined,
        (ls) => ls.indexOf(TWO_ONLY) >= 0);
      return [labels.indexOf(TWO_ONLY) >= 0 && labels.indexOf(POLYS2) < 0, JSON.stringify(labels)];
    });

    const twoId = await page.evaluate((l) => window.__t.id(l), TWO_ONLY);

    await step("12. Zoom to layer with a filter that matches nothing sets the status text", async () => {
      await page.evaluate((id) => App.gpkgSetLayerFilter(id, { conditions: [{ field: "label", op: "eq", value: "zzz" }] }), twoId);
      await page.evaluate(() => App.setStatus(""));
      await page.evaluate((label) => window.__t.menuClick(label, "Zoom to layer"), TWO_ONLY);
      const text = await pollValue(page, () => document.getElementById("status").textContent,
        undefined, (s) => s.indexOf("No features match this layer's filter") === 0);
      return [text.indexOf("No features match this layer's filter") === 0, JSON.stringify(text)];
    });

    await step("13. reload restores filters, fill, the duplicate and its name", async () => {
      await page.evaluate((id) => App.gpkgSetLayerFilter(id, { conditions: [{ field: "label", op: "eq", value: "two" }] }), twoId);
      // The store write is debounced, so wait for the view to land in IndexedDB.
      await pollValue(page, async () => {
        const r = (await App.gpkgStore.list())[0];
        return !!(r && r.views && r.views.some((v) => v.label === "Two only" && v.table === "polys_utm" && v.filter));
      }, undefined, (ok) => ok);
      const before = await page.evaluate(() => window.__t.snapshot());
      await load(page, url);
      await pollValue(page, () => App.gpkgReferenceEntries().length, undefined, (n) => n === before.length);
      const after = await page.evaluate(() => window.__t.snapshot());
      const dup = before.find((x) => x.label === TWO_ONLY);
      return [before.length === 2 && !!dup && dup.fillAlpha === 0 && dup.badge === "1 of 2" &&
        JSON.stringify(after) === JSON.stringify(before),
        JSON.stringify({ before, after })];
    });

    await page.evaluate(() => App.gpkgClearAll());

    check("14. no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
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
