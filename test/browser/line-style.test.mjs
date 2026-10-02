#!/usr/bin/env node
// test/browser/line-style.test.mjs
//
// Behavior test for per-feature line style (properties._lineStyle on Lines and
// Routes — docs/feature-appearance-plan.md Phase 3). Drawn lines/routes render
// in three style layers over one source (solid keeps "lines-layer" /
// "routes-layer"; plus "-dashed" / "-dotted"), because MapLibre's
// line-dasharray cannot be data-driven. That is a map-layer-lifecycle change
// whose regressions are silent (a dashed feature that hit-testing forgot is
// simply unclickable), so it lives here.
//
// What this checks:
//   - all six layers exist, dasharray/line-cap are on the right ones
//   - every feature renders in exactly the layer its style says (filters total)
//   - opacity / width / offset paint is identical on all three layers
//   - dotted and dashed actually render gaps (pixel sample), solid does not
//   - dashed/dotted lines and routes can be clicked (vertex edit), right-clicked
//     (feature menu), vertex-dragged (and stay styled during the drag), and
//     box-selected
//   - _lineStyle survives session reload, undo, merge (line + route, route
//     primary), split and duplicate (which now copies every appearance override)
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/line-style.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";
import { writeFileSync } from "node:fs";

const { chromium } = loadPlaywright("test/browser/line-style.test.mjs");
const SHOT_DIR = process.env.LINE_STYLE_SHOT_DIR || null;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (!pass && detail !== undefined ? "  — " + JSON.stringify(detail) : ""));
}

const W = -104.81, E = -104.77;
const LAT = { L0: 38.814, L1: 38.810, L2: 38.806, R0: 38.802, R1: 38.798 };

async function loadFixture(page) {
  await page.evaluate(([W, E, LAT]) => {
    var st = App.cache.collectState("full");
    st.labels = []; st.points = []; st.polygons = [];
    st.sectionColors = { point: null, line: null, route: null, polygon: null, label: null };
    function ln(name, id, lat, style) {
      var p = { name: name, lineIdx: id, waypoints: 2, color: "#ff0000", attributes: {}, _lineWidth: 3 };
      if (style) p._lineStyle = style;
      return { type: "Feature", properties: p, geometry: { type: "LineString", coordinates: [[W, lat], [E, lat]] } };
    }
    function rt(name, id, lat, style) {
      var p = { name: name, routeIdx: id, waypoints: [[W, lat], [E, lat]], color: "#ff0000", attributes: {}, _lineWidth: 3 };
      if (style) p._lineStyle = style;
      return { type: "Feature", properties: p, geometry: { type: "LineString", coordinates: [[W, lat], [(W + E) / 2, lat], [E, lat]] } };
    }
    st.lines = [ln("Solid", 1, LAT.L0, ""), ln("Dashed", 2, LAT.L1, "dashed"), ln("Dotted", 3, LAT.L2, "dotted")];
    st.routes = [rt("RDashed", 1, LAT.R0, "dashed"), rt("RDotted", 2, LAT.R1, "dotted")];
    App.cache.applyState(st);
    App.refreshFeaturePanel();
  }, [W, E, LAT]);
}

const px = (page, lng, lat) => page.evaluate(([lng, lat]) => {
  var p = App.map.project([lng, lat]); var r = App.map.getCanvasContainer().getBoundingClientRect();
  return [r.left + p.x, r.top + p.y];
}, [lng, lat]);

// name of every rendered feature per style layer
const layerContents = (page) => page.evaluate(() => {
  var out = {};
  App.lineStyleLayerIds().forEach(function (id) {
    var names = App.map.queryRenderedFeatures({ layers: [id] }).map(function (f) { return f.properties.name; });
    out[id] = Array.from(new Set(names)).sort();
  });
  return out;
});

const selection = (page) => page.evaluate(() => App.getSelectedFeatures().map((s) => s.type + ":" + s.index).sort().join(","));
const editing = (page) => page.evaluate(() => App._editing ? App._editing.featureType + ":" + App._editing.featureIndex : "");

async function resetUI(page) {
  await page.keyboard.press("Escape");
  await page.evaluate(() => { App.exitEditMode && App.exitEditMode(); App.clearSelection && App.clearSelection(); App.closeContextMenu && App.closeContextMenu(); });
  await page.waitForTimeout(80);
}

// Fraction of "red" pixels along one row of a screenshot clip.
async function redFraction(page, pngBuf) {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch("data:image/png;base64," + b64)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let best = 0;
    for (let y = 0; y < c.height; y++) {
      let red = 0;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] > 180 && d[i + 1] < 120 && d[i + 2] < 120) red++;
      }
      best = Math.max(best, red / c.width);
    }
    return best;
  }, pngBuf.toString("base64"));
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
    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && App.map && App.map.loaded() && App.cache", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());
    await page.evaluate(() => App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }));
    await loadFixture(page);
    await page.waitForTimeout(400);

    // ---- Layers ----
    const layers = await page.evaluate(() => App.lineStyleLayerIds().map((id) => {
      const L = App.map.getLayer(id);
      return { id, ok: !!L, dash: L ? App.map.getPaintProperty(id, "line-dasharray") : null,
        cap: L ? App.map.getLayoutProperty(id, "line-cap") : null };
    }));
    check("all six style layers exist", layers.length === 6 && layers.every((l) => l.ok), layers);
    check("solid layers have no dasharray; dashed/dotted do; only dotted is round-capped",
      layers.every((l) => (/dashed|dotted/.test(l.id) ? Array.isArray(l.dash) : l.dash == null) &&
        ((/dotted/.test(l.id)) ? l.cap === "round" : l.cap !== "round")), layers);
    const order = await page.evaluate(() => {
      const ids = App.map.getStyle().layers.map((l) => l.id);
      return ["line", "route"].map((t) => App.lineStyleLayerIds(t).map((id) => ids.indexOf(id)));
    });
    check("each type's three layers are adjacent (same z-slot)", order.every((a) => a[1] === a[0] + 1 && a[2] === a[1] + 1), order);

    const lc = await layerContents(page);
    check("features render in the layer matching their _lineStyle", JSON.stringify(lc) === JSON.stringify({
      "lines-layer": ["Solid"], "lines-layer-dashed": ["Dashed"], "lines-layer-dotted": ["Dotted"],
      "routes-layer": [], "routes-layer-dashed": ["RDashed"], "routes-layer-dotted": ["RDotted"] }), lc);

    // unknown / "solid" values fall into the solid layer (filters are total)
    await page.evaluate(() => { App.lines[0].properties._lineStyle = "bogus"; App.renderLineLayers(); });
    await page.waitForTimeout(150);
    check("an unknown _lineStyle value still renders (solid layer)", (await layerContents(page))["lines-layer"].includes("Solid"));
    await page.evaluate(() => { App.lines[0].properties._lineStyle = "solid"; App.renderLineLayers(); });
    await page.waitForTimeout(150);
    check("\"solid\" renders in the solid layer", (await layerContents(page))["lines-layer"].includes("Solid"));
    await page.evaluate(() => { delete App.lines[0].properties._lineStyle; App.renderLineLayers(); });

    // ---- Paint parity ----
    await page.evaluate(() => { App.featureSettings.lineOpacity = 70; App.applyFeatureOpacity("all"); App.applyLineWidth("all"); });
    const paint = await page.evaluate(() => ["line", "route"].map((t) => App.lineStyleLayerIds(t).map((id) =>
      JSON.stringify([App.map.getPaintProperty(id, "line-opacity"), App.map.getPaintProperty(id, "line-width"),
        App.map.getPaintProperty(id, "line-offset"), App.map.getPaintProperty(id, "line-color")]))));
    check("opacity/width/offset/color paint identical across a type's three layers",
      paint.every((a) => a[0] === a[1] && a[1] === a[2]) && paint[0][0].includes("0.7"), paint);
    await page.evaluate(() => { App.featureSettings.lineOpacity = 100; App.applyFeatureOpacity("all"); });

    // ---- Pixel check: dotted/dashed have gaps, solid does not ----
    await page.mouse.move(5, 890);
    await page.waitForTimeout(400);
    const frac = {};
    for (const k of ["L0", "L1", "L2", "R1"]) {
      const a = await px(page, W + 0.006, LAT[k]), b = await px(page, E - 0.006, LAT[k]);
      const buf = await page.screenshot({ clip: { x: a[0], y: a[1] - 6, width: b[0] - a[0], height: 12 } });
      frac[k] = Math.round((await redFraction(page, buf)) * 100) / 100;
    }
    check("solid line is continuous (red fraction > 0.95)", frac.L0 > 0.95, frac);
    check("dashed line has gaps (0.3 < red fraction < 0.9)", frac.L1 > 0.3 && frac.L1 < 0.9, frac);
    check("dotted line renders dots with gaps (0.1 < red fraction < 0.75)", frac.L2 > 0.1 && frac.L2 < 0.75 && frac.R1 > 0.1 && frac.R1 < 0.75, frac);
    if (SHOT_DIR) {
      const a = await px(page, W - 0.003, LAT.L0 + 0.002), b = await px(page, E + 0.003, LAT.R1 - 0.002);
      writeFileSync(SHOT_DIR + "/line-styles.png", await page.screenshot({ clip: { x: a[0], y: a[1], width: b[0] - a[0], height: b[1] - a[1] } }));
    }

    // ---- Click → vertex edit / selection ----
    const targets = [["line", 1, "L1"], ["line", 2, "L2"], ["route", 0, "R0"], ["route", 1, "R1"]];
    for (const [t, i, k] of targets) {
      await resetUI(page);
      const p = await px(page, -104.783, LAT[k]);
      await page.mouse.click(p[0], p[1]);
      await page.waitForTimeout(150);
      check("click selects + enters vertex edit on " + k + " (" + t + " " + i + ")",
        (await editing(page)) === t + ":" + i && (await selection(page)) === t + ":" + i,
        { editing: await editing(page), sel: await selection(page) });
    }

    // ---- Right-click → feature menu ----
    for (const [t, i, k] of targets) {
      await resetUI(page);
      const p = await px(page, -104.783, LAT[k]);
      await page.mouse.click(p[0], p[1], { button: "right" });
      await page.waitForTimeout(150);
      const menu = await page.evaluate(() => { const m = document.getElementById("fp-context-menu"); return m ? m.textContent : ""; });
      check("right-click opens the feature menu on " + k, /Attributes/.test(menu) && /Duplicate/.test(menu),
        { menu, sel: await selection(page) });
      check("right-click targets " + k, (await selection(page)) === t + ":" + i, await selection(page));
    }

    // ---- Vertex drag (stays styled mid-drag) ----
    for (const [t, i, k] of [["line", 1, "L1"], ["route", 1, "R1"]]) {
      await resetUI(page);
      const mid = await px(page, -104.783, LAT[k]);
      await page.mouse.click(mid[0], mid[1]);
      await page.waitForTimeout(150);
      const v = await px(page, E, LAT[k]);
      await page.mouse.move(v[0], v[1]);
      await page.mouse.down();
      await page.mouse.move(v[0] + 10, v[1] + 15, { steps: 3 });
      await page.mouse.move(v[0] + 20, v[1] + 30, { steps: 3 });
      await page.waitForTimeout(100);
      const lid = t === "line" ? (k === "L1" ? "lines-layer-dashed" : "") : "routes-layer-dotted";
      const midDrag = await page.evaluate((lid) => App.map.queryRenderedFeatures({ layers: [lid] }).length > 0, lid);
      await page.mouse.up();
      await page.waitForFunction(([t, i, E]) => {
        const f = (t === "line" ? App.lines : App.routes)[i];
        const c = t === "line" ? f.geometry.coordinates[1] : f.properties.waypoints[1];
        return Math.abs(c[0] - E) > 1e-4;
      }, [t, i, E], { timeout: 15000 }).catch(() => {});
      const after = await page.evaluate(([t, i]) => {
        const f = (t === "line" ? App.lines : App.routes)[i];
        return { style: f.properties._lineStyle, end: t === "line" ? f.geometry.coordinates[1] : f.properties.waypoints[1] };
      }, [t, i]);
      check("vertex drag moves " + k + "'s end vertex", Math.abs(after.end[0] - E) > 1e-4, after);
      check(k + " stays in its style layer during the drag and keeps _lineStyle after", midDrag && after.style === (k === "L1" ? "dashed" : "dotted"), { midDrag, after });
    }
    // restore geometry for the remaining checks
    await resetUI(page);
    await loadFixture(page);
    await page.waitForTimeout(300);

    // ---- Box select ----
    await resetUI(page);
    await page.click('.tool-btn[data-mode="box-select"]');
    for (const [t, i, k] of targets) {
      const a = await px(page, -104.786, LAT[k] + 0.0012), b = await px(page, -104.780, LAT[k] - 0.0012);
      await page.mouse.move(a[0], a[1]); await page.mouse.down();
      await page.mouse.move(b[0], b[1], { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(120);
      check("box select picks " + k, (await selection(page)) === t + ":" + i, await selection(page));
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await resetUI(page);

    // ---- Setter + undo ----
    const und = await page.evaluate(() => {
      const r = [];
      App.setFeatureLineStyle("line", 0, "dotted"); r.push(App.lines[0].properties._lineStyle);
      App.undo.undo(); r.push(App.lines[0].properties._lineStyle === undefined);
      App.setFeatureLineStyle("route", 0, "solid"); r.push(App.routes[0].properties._lineStyle === undefined);
      App.undo.undo(); r.push(App.routes[0].properties._lineStyle);
      App.undo.redo(); r.push(App.routes[0].properties._lineStyle === undefined);
      App.undo.undo(); r.push(App.routes[0].properties._lineStyle);
      r.push(App.setFeatureLineStyle("polygon", 0, "dashed"));
      return r;
    });
    check("App.setFeatureLineStyle sets/clears and undo/redo restore it",
      JSON.stringify(und) === JSON.stringify(["dotted", true, true, "dashed", true, "dashed", false]), und);
    await page.waitForTimeout(150);
    check("after undo the layers match the restored styles", (await layerContents(page))["routes-layer-dashed"].includes("RDashed"));

    // ---- Duplicate ----
    const dup = await page.evaluate(() => {
      const src = App.lines[2];
      src.properties._opacity = 0.4; src.properties._offset = 3; src.properties._offsetManual = true; src.properties._bufferRadius = 0.3;
      src.properties._mergedFrom = { version: 1 };
      App.duplicateLine(2);
      const c = App.lines[App.lines.length - 1].properties;
      delete src.properties._mergedFrom;
      App.duplicateRoute(0);
      const rc = App.routes[App.routes.length - 1].properties;
      return { style: c._lineStyle, op: c._opacity, off: c._offset, man: c._offsetManual, buf: c._bufferRadius, w: c._lineWidth,
        color: c.color, merged: "_mergedFrom" in c, rstyle: rc._lineStyle, nl: App.lines.length, nr: App.routes.length };
    });
    check("Duplicate copies _lineStyle and every appearance override, never _mergedFrom",
      dup.style === "dotted" && dup.op === 0.4 && dup.off === 3 && dup.man === true && dup.buf === 0.3 && dup.w === 3 &&
      dup.color === "#ff0000" && !dup.merged && dup.rstyle === "dashed", dup);
    await page.evaluate(() => { App.undo.undo(); App.undo.undo(); App.undo.undo(); });

    // ---- Split ----
    const sp = await page.evaluate(() => {
      const r = App.split.run("line", 1, [{ segIndex: 0, t: 0.5 }], { service: "none" });
      return { ok: r.ok, styles: (r.indices || []).map((i) => App.lines[i].properties._lineStyle) };
    });
    check("split pieces keep _lineStyle", sp.ok && sp.styles.length === 2 && sp.styles.every((s) => s === "dashed"), sp);
    await page.evaluate(() => App.undo.undo());

    // ---- Merge (line + route, dotted route primary → line survivor takes its style) ----
    const mg = await page.evaluate(async () => {
      const r = await App.merge.run("linemix", [{ type: "line", index: 0 }, { type: "route", index: 1 }], { type: "route", index: 1 });
      return { ok: r.ok, t: r.survivorType, style: r.ok ? App.lines[r.survivorIndex].properties._lineStyle : null, err: r.errors };
    });
    check("line + route merge with a dotted route primary yields a dotted line", mg.ok && mg.t === "line" && mg.style === "dotted", mg);
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: ["lines-layer-dotted"] }).some((f) => f.properties.name === "RDotted") &&
      !App.map.queryRenderedFeatures({ layers: ["routes-layer-dotted"] }).length, null, { timeout: 5000 }).catch(() => {});
    const lcm = await layerContents(page);
    check("merged survivor renders in lines-layer-dotted and the route is gone",
      lcm["lines-layer-dotted"].includes("RDotted") && lcm["routes-layer-dotted"].length === 0, lcm);
    await page.evaluate(() => App.undo.undo());

    // ---- Session reload ----
    await page.evaluate(() => { App.cache.save(); });
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && App.map && App.map.loaded() && App.cache", { timeout: 30000 });
    await page.evaluate(() => App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }));
    await page.waitForTimeout(600);
    const re = await page.evaluate(() => ({ l: App.lines.map((f) => f.properties._lineStyle || ""), r: App.routes.map((f) => f.properties._lineStyle || "") }));
    check("_lineStyle survives a session reload", JSON.stringify(re) === JSON.stringify({ l: ["", "dashed", "dotted"], r: ["dashed", "dotted"] }), re);
    const lc2 = await layerContents(page);
    check("after reload features render in their style layers",
      lc2["lines-layer-dashed"].includes("Dashed") && lc2["lines-layer-dotted"].includes("Dotted") && lc2["routes-layer-dotted"].includes("RDotted"), lc2);

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
