#!/usr/bin/env node
// test/browser/buffer-merge.test.mjs
//
// "Dissolve overlaps" in the Layers panel's Buffers drawer
// (App.featureSettings.bufferMerge). It is display-only: overlapping buffers
// are drawn as one shape in two extra layers ("buffers-merged-fill/-line")
// while the per-feature buffer layers stay in the style at zero opacity,
// because hover/click hit-testing and the analysis-overlay anchor still read
// "buffers-fill". Regressions are silent (a transparent layer that stops
// being queryable just makes buffers unclickable), so this drives the real app.
//
// What this checks:
//   - off by default; an old session without the field loads as off
//   - with it off, the overlap of two translucent buffers is darker (the problem)
//   - the toggle in the drawer turns it on: overlap pixel == single-coverage
//     pixel, per-feature layers at 0 opacity but still queryable by click
//   - same-colored buffers fuse (one Feature per color), different colors don't
//   - moving a point re-dissolves the shape
//   - the setting survives undo, a session reload and the drawer's Reset;
//     Reset Session turns it off
//   - the analysis buffers (App.buffers) are untouched — still one per feature
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/buffer-merge.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/buffer-merge.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (!pass && detail !== undefined ? "  — " + JSON.stringify(detail) : ""));
}

// A and B are 0.8 mi apart with 0.5 mi buffers, so their circles overlap in a
// lens around the midpoint; C is far from both. The red line's buffer is a
// different color and sits well north of the points.
const LAT = 38.806;
const A = [-104.795, LAT], B = [-104.7787, LAT], C = [-104.74, LAT];
const MID = [(A[0] + B[0]) / 2, LAT];
const A_ONLY = [A[0] - 0.0058, LAT];      // ~0.3 mi west of A: inside A, outside B

async function loadFixture(page, merge) {
  await page.evaluate(([A, B, C, merge]) => {
    var st = App.cache.collectState("full");
    st.labels = []; st.polygons = []; st.routes = [];
    st.sectionColors = { point: null, line: null, route: null, polygon: null, label: null };
    function pt(name, id, c) {
      return { type: "Feature", properties: { name: name, pointIdx: id, color: "", attributes: {} },
        geometry: { type: "Point", coordinates: c } };
    }
    st.points = [pt("A", 1, A), pt("B", 2, B), pt("C", 3, C)];
    st.lines = [{ type: "Feature",
      properties: { name: "L", lineIdx: 1, waypoints: 2, color: "#ff0000", attributes: {} },
      geometry: { type: "LineString", coordinates: [[A[0], A[1] + 0.05], [C[0], C[1] + 0.05]] } }];
    st.bufferRadius = 0.5; st.lineBufferRadius = 0.5; st.routeBufferRadius = 0;
    st.bufferFillOpacity = 50; st.bufferLineOpacity = 0;
    if (merge === undefined) delete st.bufferMerge; else st.bufferMerge = merge;
    App.cache.applyState(st);
    App.refreshFeaturePanel();
  }, [A, B, C, merge]);
}

// Canvas readback of a WebGL map is blank (no preserveDrawingBuffer), so sample a real screenshot.
const rgbAt = async (page, lng, lat) => {
  const xy = await page.evaluate(([lng, lat]) => {
    var p = App.map.project([lng, lat]); var r = App.map.getCanvas().getBoundingClientRect();
    return [Math.round(r.left + p.x), Math.round(r.top + p.y)];
  }, [lng, lat]);
  const png = await page.screenshot();
  return page.evaluate(async ([b64, x, y]) => {
    const blob = await (await fetch("data:image/png;base64," + b64)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [png.toString("base64"), xy[0], xy[1]]);
};

// MapLibre only paints on a repaint; wait for it before sampling.
const settle = async (page) => {
  await page.evaluate(() => new Promise((res) => { App.map.once("idle", res); App.map.triggerRepaint(); }));
};

const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

const mergedData = (page) => page.evaluate(() => {
  var s = App.map.getSource("buffers-merged");
  return s ? s.serialize().data : null;
});
const mergedVisible = (page) => page.evaluate(() => {
  var m = App.map;
  return !!m.getLayer("buffers-merged-fill") && m.getLayoutProperty("buffers-merged-fill", "visibility") === "visible" &&
    m.getLayoutProperty("buffers-merged-line", "visibility") === "visible";
});
const paint = (page, id, prop) => page.evaluate(([id, prop]) => App.map.getPaintProperty(id, prop), [id, prop]);

// Rows of the Buffers drawer in the Layers tab.
async function openBuffersDrawer(page) {
  await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
  const group = page.locator("#fp-tab-layers .lp-style-group")
    .filter({ has: page.locator(".lp-style-header", { hasText: "Buffers" }) });
  const header = group.locator(".lp-style-header");
  await header.waitFor({ state: "visible", timeout: 10000 });
  const open = await header.locator(".lp-caret").getAttribute("aria-expanded");
  if (open !== "true") await header.click();
  return group;
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await routeVendoredAssets(context, port);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && App.map && App.map.loaded() && App.cache", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());
    await page.evaluate(() => App.map.jumpTo({ center: [-104.775, 38.806], zoom: 13 }));

    // ---- Off by default / old sessions ----
    await loadFixture(page, undefined);
    await page.waitForTimeout(400);
    check("a session without the field loads with Dissolve overlaps off", await page.evaluate(() => App.featureSettings.bufferMerge === false));
    check("merged layers are not visible when off", !(await mergedVisible(page)));
    check("per-feature buffer fill carries the fill opacity when off", (await paint(page, "buffers-fill", "fill-opacity")) === 0.5);

    await settle(page);
    const offOverlap = await rgbAt(page, MID[0], MID[1]);
    const offSingle = await rgbAt(page, A_ONLY[0], A_ONLY[1]);
    check("off: the overlap is visibly darker than a single buffer (the problem being solved)", !near(offOverlap, offSingle, 6), { offOverlap, offSingle });

    // ---- Toggle in the Buffers drawer ----
    const drawer = await openBuffersDrawer(page);
    const toggle = drawer.locator('input[type="checkbox"][aria-label="Dissolve overlaps"]');
    check("the Buffers drawer has a Dissolve overlaps checkbox, unchecked", (await toggle.count()) === 1 && !(await toggle.isChecked()));
    await toggle.click();
    await page.waitForFunction(() => App.featureSettings.bufferMerge === true, null, { timeout: 5000 }).catch(() => {});
    check("the checkbox turns the setting on", await page.evaluate(() => App.featureSettings.bufferMerge === true));
    check("merged layers are visible", await mergedVisible(page));

    await settle(page);
    const onOverlap = await rgbAt(page, MID[0], MID[1]);
    const onSingle = await rgbAt(page, A_ONLY[0], A_ONLY[1]);
    check("on: the overlap matches single coverage", near(onOverlap, onSingle, 3), { onOverlap, onSingle });

    check("per-feature buffer layers draw nothing but stay visible",
      (await paint(page, "buffers-fill", "fill-opacity")) === 0 && (await paint(page, "buffers-line", "line-opacity")) === 0 &&
      (await page.evaluate(() => App.map.getLayoutProperty("buffers-fill", "visibility"))) !== "none");

    const hit = await page.evaluate(([lng, lat]) => {
      var f = App.map.queryRenderedFeatures(App.map.project([lng, lat]), { layers: ["buffers-fill"] });
      return f.map((x) => x.properties.pointIdx);
    }, A_ONLY);
    check("a transparent per-feature buffer is still clickable (hit-testing intact)", hit.length === 1 && hit[0] === 1, hit);

    check("analysis buffers are untouched: one per feature",
      await page.evaluate(() => App.buffers.filter(Boolean).length === 3 && App.lineBuffers.filter(Boolean).length === 1));

    // ---- What the merged source holds ----
    let data = await mergedData(page);
    const byColor = {};
    ((data && data.features) || []).forEach((f) => { byColor[f.properties.color] = f; });
    const colors = Object.keys(byColor);
    check("one merged Feature per color (points, red line)", colors.length === 2 && colors.includes("#ff0000"), colors);
    const ptFeat = colors.filter((c) => c !== "#ff0000").map((c) => byColor[c])[0];
    check("A and B fuse into one part, C stays separate (MultiPolygon with 2 parts)",
      !!ptFeat && ptFeat.geometry.type === "MultiPolygon" && ptFeat.geometry.coordinates.length === 2,
      ptFeat && [ptFeat.geometry.type, ptFeat.geometry.coordinates.length]);

    // ---- Edits re-dissolve ----
    await page.evaluate(([x, y]) => App.movePoint(2, x, y), [-104.7787 + 0.0165, LAT]);   // C next to B
    await page.waitForFunction(() => {
      var s = App.map.getSource("buffers-merged"); if (!s) return false;
      var d = s.serialize().data;
      return d.features.some((f) => f.properties.color !== "#ff0000" && f.geometry.type === "Polygon");
    }, null, { timeout: 5000 }).catch(() => {});
    data = await mergedData(page);
    const pf = (data.features || []).filter((f) => f.properties.color !== "#ff0000")[0];
    check("moving a point re-dissolves the shape (now one connected Polygon)", !!pf && pf.geometry.type === "Polygon", pf && pf.geometry.type);

    // ---- Undo keeps the setting and the merged display ----
    await page.evaluate(() => App.undo.undo());          // undoes the move
    await page.waitForFunction(() => {
      var s = App.map.getSource("buffers-merged"); if (!s) return false;
      return s.serialize().data.features.some((f) => f.geometry.type === "MultiPolygon");
    }, null, { timeout: 5000 }).catch(() => {});
    check("undo restores the earlier merged shape and keeps the setting on",
      await page.evaluate(() => App.featureSettings.bufferMerge === true) &&
      (await mergedData(page)).features.some((f) => f.geometry.type === "MultiPolygon") && (await mergedVisible(page)));

    // ---- Session reload ----
    await page.evaluate(() => { App.cache.save(); });
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && App.map && App.map.loaded() && App.cache", { timeout: 30000 });
    await page.waitForFunction(() => App.featureSettings.bufferMerge === true && App.map.getSource("buffers-merged") &&
      App.map.getSource("buffers-merged").serialize().data.features.length === 2, null, { timeout: 8000 }).catch(() => {});
    check("after a reload the setting is on and the merged shapes are drawn",
      await page.evaluate(() => App.featureSettings.bufferMerge === true) && (await mergedVisible(page)) &&
      ((await mergedData(page)) || { features: [] }).features.length === 2);

    // ---- Drawer Reset, then Reset Session ----
    const drawer2 = await openBuffersDrawer(page);
    await drawer2.locator(".lp-style-reset").click();
    await page.waitForFunction(() => App.featureSettings.bufferMerge === false, null, { timeout: 5000 }).catch(() => {});
    check("the drawer's Reset turns it off and restores the per-feature layers",
      !(await mergedVisible(page)) && (await paint(page, "buffers-fill", "fill-opacity")) === 0.08);

    await page.evaluate(() => { App.featureSettings.bufferMerge = true; App.refreshMergedBuffers(); });
    check("(precondition) on again", await mergedVisible(page));
    await page.evaluate(() => App.cache.reset());
    await page.waitForTimeout(300);
    check("Reset Session turns it off", await page.evaluate(() => App.featureSettings.bufferMerge === false) && !(await mergedVisible(page)));

    check("no page errors", pageErrors.length === 0, pageErrors);
  } catch (e) {
    check("test ran to completion", false, String(e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    stopServer();
  }
  const passed = results.filter((r) => r.pass).length;
  console.log((passed === results.length ? "PASS" : "FAIL") + " — " + passed + "/" + results.length + " checks passed");
  process.exit(passed === results.length ? 0 : 1);
})();
