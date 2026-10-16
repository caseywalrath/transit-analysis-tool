#!/usr/bin/env node
// test/browser/point-icons.test.mjs
//
// Behavior test for Point icon styles (js/core/point-icons.js). Dots stay the
// original circle layer ("points-layer"); every other icon renders in a symbol
// layer ("points-icon-layer") directly above it. That is a map-layer-lifecycle
// change whose regressions are silent (an icon point that hit-testing forgot is
// simply unclickable), the same class of bug as line styles.
//
// What this checks:
//   - both layers exist, are adjacent, and every point renders in exactly the
//     layer its resolved icon says; overlapping icons are not collision-hidden
//   - the cascade: per-point _pointIcon > type default (featureSettings.pointIcon)
//     > dot; a type-default change clears per-point overrides (last action
//     wins); undo/redo restore both halves
//   - pixels: a square icon is drawn in the point's color; a pin's tip sits on
//     its coordinate (body above it); Size and opacity reach the icon layer
//   - click / right-click select icon points; dragging keeps the grab offset
//     (a pin grabbed by its head does not jump) and stays an icon mid-drag
//   - selecting an icon point highlights with hl-icon, a dot with hl-circle
//   - UI: the Appearance popover's Icon row + picker, Layers > Style defaults
//     Icon row, and the Features-list row icon
//   - duplicate copies _pointIcon; icons and the type default survive a reload;
//     a missing image is re-registered on demand
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/point-icons.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";
import { writeFileSync } from "node:fs";

const { chromium } = loadPlaywright("test/browser/point-icons.test.mjs");
const SHOT_DIR = process.env.POINT_ICONS_SHOT_DIR || null;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (!pass && detail !== undefined ? "  — " + JSON.stringify(detail) : ""));
}

const LAT = 38.806;
const LNG0 = -104.80;          // point i sits at LNG0 + i * STEP
const STEP = 0.004;            // ~35px apart at zoom 14, so icons never touch

async function loadFixture(page, specs) {
  await page.evaluate(([LNG0, STEP, LAT, specs]) => {
    var st = App.cache.collectState("full");
    st.lines = []; st.routes = []; st.polygons = []; st.labels = [];
    st.sectionColors = { point: null, line: null, route: null, polygon: null, label: null };
    st.pointIcon = "dot";
    st.points = specs.map(function (s, i) {
      var p = { name: s.name, pointIdx: i + 1, color: s.color || "", attributes: {} };
      if (s.icon) p._pointIcon = s.icon;
      if (s.size != null) p._lineWidth = s.size;
      return { type: "Feature", properties: p, geometry: { type: "Point", coordinates: [LNG0 + i * STEP, LAT] } };
    });
    App.cache.applyState(st);
    App.refreshFeaturePanel();
  }, [LNG0, STEP, LAT, specs]);
}

const px = (page, lng, lat) => page.evaluate(([lng, lat]) => {
  var p = App.map.project([lng, lat]); var r = App.map.getCanvasContainer().getBoundingClientRect();
  return [r.left + p.x, r.top + p.y];
}, [lng, lat]);
const ptPx = (page, i) => px(page, LNG0 + i * STEP, LAT);

const layerNames = (page, layer) => page.evaluate((layer) => {
  var names = App.map.queryRenderedFeatures({ layers: [layer] }).map((f) => f.properties.name);
  return Array.from(new Set(names)).sort();
}, layer);

const sel = (page) => page.evaluate(() => App.getSelectedFeatures().map((s) => s.type + ":" + s.index).sort().join(","));
const icons = (page) => page.evaluate(() => App.points.map((p) => p.properties._pointIcon || ""));

async function resetUI(page) {
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    App.closeAppearancePopup && App.closeAppearancePopup();
    App.closePointIconPicker && App.closePointIconPicker();
    App.exitEditMode && App.exitEditMode();
    App.clearSelection && App.clearSelection();
    App.closeContextMenu && App.closeContextMenu();
  });
  await page.waitForTimeout(80);
}

// Bounding box + count of pixels near `rgb` inside a screenshot clip.
async function colorBox(page, clip, rgb) {
  const buf = await page.screenshot({ clip });
  return page.evaluate(async ([b64, rgb]) => {
    const blob = await (await fetch("data:image/png;base64," + b64)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(d[i] - rgb[0]) < 40 && Math.abs(d[i + 1] - rgb[1]) < 40 && Math.abs(d[i + 2] - rgb[2]) < 40) {
        n++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    return { n, minX, minY, maxX, maxY };
  }, [buf.toString("base64"), rgb]);
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
    await page.evaluate(() => App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }));

    // 0 dot, 1 pin, 2 red square, 3 bus, 4 hospital, 5 dot (explicit override), 6 sized pin
    await loadFixture(page, [
      { name: "Dot" }, { name: "Pin", icon: "pin" }, { name: "Square", icon: "square", color: "#e53e3e" },
      { name: "Bus", icon: "bus" }, { name: "Hospital", icon: "hospital" }, { name: "DotOver", icon: "dot" },
      { name: "BigPin", icon: "pin", size: 2 }
    ]);
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: ["points-icon-layer"] }).length >= 5, null, { timeout: 15000 });

    // ---- Layers ----
    const lay = await page.evaluate(() => {
      const ids = App.map.getStyle().layers.map((l) => l.id);
      return { dot: ids.indexOf("points-layer"), icon: ids.indexOf("points-icon-layer"),
        ids: App.pointLayerIds(), allowOverlap: App.map.getLayoutProperty("points-icon-layer", "icon-allow-overlap"),
        ignore: App.map.getLayoutProperty("points-icon-layer", "icon-ignore-placement") };
    });
    check("both point layers exist and sit adjacent (same z-slot)", lay.dot >= 0 && lay.icon === lay.dot + 1, lay);
    check("App.pointLayerIds lists the icon layer first", JSON.stringify(lay.ids) === JSON.stringify(["points-icon-layer", "points-layer"]), lay.ids);
    check("icon layer allows overlap and ignores placement", lay.allowOverlap === true && lay.ignore === true, lay);
    check("dots render in points-layer only", JSON.stringify(await layerNames(page, "points-layer")) === JSON.stringify(["Dot", "DotOver"]), await layerNames(page, "points-layer"));
    check("icons render in points-icon-layer only",
      JSON.stringify(await layerNames(page, "points-icon-layer")) === JSON.stringify(["BigPin", "Bus", "Hospital", "Pin", "Square"]), await layerNames(page, "points-icon-layer"));

    // an unknown stored icon id behaves as a dot, never vanishes
    await page.evaluate(() => { App.points[0].properties._pointIcon = "bogus"; App.renderPointLayers(); });
    await page.waitForTimeout(200);
    check("an unknown _pointIcon value still renders (as a dot)", (await layerNames(page, "points-layer")).includes("Dot"));
    await page.evaluate(() => { delete App.points[0].properties._pointIcon; App.renderPointLayers(); });

    // ---- Overlap is not collision-hidden ----
    await page.evaluate(([LNG0, LAT]) => {
      App.addPointWithOpts(LNG0 + 3 * 0.004, LAT, { name: "Stacked1" });
      App.addPointWithOpts(LNG0 + 3 * 0.004, LAT, { name: "Stacked2" });
      App.points[App.points.length - 2].properties._pointIcon = "shelter";
      App.points[App.points.length - 1].properties._pointIcon = "shelter";
      App.renderPointLayers();
    }, [LNG0, LAT]);
    await page.waitForFunction(() => {
      const n = App.map.queryRenderedFeatures({ layers: ["points-icon-layer"] }).filter((f) => /^Stacked/.test(f.properties.name)).length;
      return n === 2;
    }, null, { timeout: 8000 }).catch(() => {});
    const stacked = await page.evaluate(() => App.map.queryRenderedFeatures({ layers: ["points-icon-layer"] }).filter((f) => /^Stacked/.test(f.properties.name)).length);
    check("two icons on the same spot both render (no collision hiding)", stacked === 2, stacked);
    await page.evaluate(() => { App.undo.undo(); App.undo.undo(); });   // each add pushed one undo step
    await page.waitForTimeout(200);

    // ---- Paint / layout parity ----
    await page.evaluate(() => { App.featureSettings.pointOpacity = 70; App.featureSettings.pointLineWidth = 1.5; App.applyFeatureOpacity("all"); App.applyLineWidth("all"); });
    const pp = await page.evaluate(() => ({
      op: JSON.stringify(App.map.getPaintProperty("points-icon-layer", "icon-opacity")),
      sz: JSON.stringify(App.map.getLayoutProperty("points-icon-layer", "icon-size")),
      cop: JSON.stringify(App.map.getPaintProperty("points-layer", "circle-opacity"))
    }));
    check("type opacity reaches the icon layer (same expression as the dot layer)", pp.op === pp.cop && pp.op.includes("0.7"), pp);
    check("type Size reaches the icon layer, with the per-point _lineWidth override", pp.sz.includes("_lineWidth") && pp.sz.includes("1.5"), pp);
    await page.evaluate(() => { App.featureSettings.pointOpacity = 100; App.featureSettings.pointLineWidth = 1; App.applyFeatureOpacity("all"); App.applyLineWidth("all"); });
    await page.waitForTimeout(300);

    // ---- Pixels: color + pin anchoring + Size ----
    await page.mouse.move(5, 890);
    await page.waitForTimeout(400);
    const sq = await ptPx(page, 2);
    const sqBox = await colorBox(page, { x: sq[0] - 20, y: sq[1] - 20, width: 40, height: 40 }, [229, 62, 62]);
    check("square icon is drawn in the point's color", sqBox.n > 250 && sqBox.maxX - sqBox.minX >= 17, sqBox);
    const pn = await ptPx(page, 1);
    const pinBox = await colorBox(page, { x: pn[0] - 20, y: pn[1] - 44, width: 40, height: 58 }, [43, 108, 176]);
    // clip top = pn.y - 44, so pn.y is clip row 44. The coloured tip is a thin wedge whose last
    // pixels blend into the white ring, so allow a few px; the head top must be ~28-30px above.
    check("a pin's tip sits on its coordinate (body above it)", Math.abs(pinBox.maxY - 44) <= 5 && pinBox.minY < 44 - 18 && pinBox.n > 150, pinBox);
    const bp = await ptPx(page, 6);
    const bigBox = await colorBox(page, { x: bp[0] - 36, y: bp[1] - 74, width: 72, height: 90 }, [43, 108, 176]);
    check("per-point Size (_lineWidth 2) doubles the icon", (bigBox.maxY - bigBox.minY) > (pinBox.maxY - pinBox.minY) * 1.7, { bigBox, pinBox });
    if (SHOT_DIR) {
      const a = await ptPx(page, 0), b = await ptPx(page, 6);
      writeFileSync(SHOT_DIR + "/point-icons.png", await page.screenshot({ clip: { x: a[0] - 30, y: a[1] - 80, width: b[0] - a[0] + 60, height: 110 } }));
    }

    // ---- Click selects; right-click opens the menu ----
    for (const [i, nm] of [[1, "pin"], [2, "square"], [3, "bus"]]) {
      await resetUI(page);
      const c = await ptPx(page, i);
      const off = i === 1 ? -12 : 0;      // aim at a pin's head, well above its coordinate
      await page.mouse.click(c[0], c[1] + off);
      await page.waitForTimeout(150);
      check("click selects the " + nm + " icon point", (await sel(page)) === "point:" + i, await sel(page));
      await resetUI(page);
      await page.mouse.click(c[0], c[1] + off, { button: "right" });
      await page.waitForTimeout(150);
      const menu = await page.evaluate(() => { const m = document.getElementById("fp-context-menu"); return m ? m.textContent : ""; });
      check("right-click opens the feature menu on the " + nm + " icon point", /Attributes/.test(menu) && (await sel(page)) === "point:" + i, { menu, sel: await sel(page) });
    }

    // ---- Highlight ----
    await resetUI(page);
    await page.mouse.move(5, 890);          // keep a hover off the points: it adds its own highlight
    await page.waitForTimeout(200);
    await page.evaluate(() => App.selectFeature("point", 1));
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: ["hl-icon"] }).length > 0, null, { timeout: 8000 }).catch(() => {});
    const hlPin = await page.evaluate(() => ({ icon: App.map.queryRenderedFeatures({ layers: ["hl-icon"] }).length, circle: App.map.queryRenderedFeatures({ layers: ["hl-circle"] }).length }));
    check("a selected icon point highlights with hl-icon, not hl-circle", hlPin.icon > 0 && hlPin.circle === 0, hlPin);
    await page.evaluate(() => App.selectFeature("point", 0));
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: ["hl-circle"] }).length > 0 &&
      App.map.queryRenderedFeatures({ layers: ["hl-icon"] }).length === 0, null, { timeout: 8000 }).catch(() => {});
    const hlDot = await page.evaluate(() => ({ icon: App.map.queryRenderedFeatures({ layers: ["hl-icon"] }).length, circle: App.map.queryRenderedFeatures({ layers: ["hl-circle"] }).length }));
    check("a selected dot still highlights with hl-circle only", hlDot.circle > 0 && hlDot.icon === 0, hlDot);

    // ---- Drag: grab offset kept for a pin; mid-drag still an icon ----
    await resetUI(page);
    const pinC = await ptPx(page, 1);
    await page.mouse.click(pinC[0], pinC[1] - 12);                       // select it (grab by the head)
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => App.map.project(App.points[1].geometry.coordinates));
    await page.mouse.move(pinC[0], pinC[1] - 12);
    await page.mouse.down();
    await page.mouse.move(pinC[0] + 30, pinC[1] - 12 + 20, { steps: 4 });
    await page.waitForTimeout(150);
    const midDrag = await page.evaluate(() => App.map.queryRenderedFeatures({ layers: ["points-icon-layer"] }).some((f) => f.properties.name === "Pin"));
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => App.map.project(App.points[1].geometry.coordinates));
    check("dragging a pin by its head moves it by the mouse delta (no jump)",
      Math.abs((after.x - before.x) - 30) <= 1.5 && Math.abs((after.y - before.y) - 20) <= 1.5, { dx: after.x - before.x, dy: after.y - before.y });
    check("the pin stays an icon (not a dot) during the drag", midDrag);
    await page.evaluate(() => App.undo.undo());
    await resetUI(page);
    // a dragged dot keeps the original behaviour (coordinate follows the cursor exactly)
    const dotC = await ptPx(page, 0);
    await page.mouse.click(dotC[0], dotC[1]);
    await page.waitForTimeout(120);
    await page.mouse.move(dotC[0] + 2, dotC[1] + 1);                    // grab 2px off-centre
    await page.mouse.down();
    await page.mouse.move(dotC[0] + 32, dotC[1] + 21, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const dotAfter = await page.evaluate(() => App.map.project(App.points[0].geometry.coordinates));
    check("a dragged dot's coordinate follows the cursor exactly (unchanged behaviour)",
      Math.abs(dotAfter.x - (dotC[0] + 32 - (await page.evaluate(() => App.map.getCanvasContainer().getBoundingClientRect().left)))) <= 1.5, dotAfter);
    await page.evaluate(() => App.undo.undo());
    await resetUI(page);

    // ---- Setters, cascade, undo ----
    const cas = await page.evaluate(() => {
      const r = {};
      App.setTypePointIcon("rail");
      r.afterType = [App.featureSettings.pointIcon, App.points.map((p) => p.properties._pointIcon || "").join("|"), App.resolvePointIcon(App.points[0])];
      App.setFeaturePointIcon(0, "star");
      r.override = [App.points[0].properties._pointIcon, App.resolvePointIcon(App.points[0]), App.resolvePointIcon(App.points[1])];
      App.setFeaturePointIcon(0, null);
      r.cleared = [App.points[0].properties._pointIcon === undefined, App.resolvePointIcon(App.points[0])];
      App.setFeaturePointIcon(0, "nope");
      r.bogus = App.points[0].properties._pointIcon === undefined;
      App.undo.undo();   // undo the (no-op) bogus? it must not have pushed; this undoes the clear
      r.undoClear = App.points[0].properties._pointIcon;
      App.undo.undo();   // undo the override
      App.undo.undo();   // undo the type default
      r.undoType = [App.featureSettings.pointIcon, App.points.map((p) => p.properties._pointIcon || "").join("|")];
      App.undo.redo();
      r.redoType = [App.featureSettings.pointIcon, App.points.map((p) => p.properties._pointIcon || "").join("|")];
      App.undo.undo();
      return r;
    });
    check("type default change clears every per-point override (last action wins)",
      cas.afterType[0] === "rail" && cas.afterType[1] === "||||||" && cas.afterType[2] === "rail", cas.afterType);
    check("per-point override beats the type default; others follow it",
      cas.override[0] === "star" && cas.override[1] === "star" && cas.override[2] === "rail", cas.override);
    check("clearing the override returns to the type default", cas.cleared[0] === true && cas.cleared[1] === "rail", cas.cleared);
    check("an unknown icon id clears instead of storing garbage", cas.bogus === true, cas.bogus);
    check("undo restores the override", cas.undoClear === "star", cas.undoClear);
    check("undo restores the type default AND the cleared overrides",
      cas.undoType[0] === "dot" && cas.undoType[1] === "|pin|square|bus|hospital|dot|pin", cas.undoType);
    check("redo re-applies the type default", cas.redoType[0] === "rail" && cas.redoType[1] === "||||||", cas.redoType);
    check("(undo again) the fixture is back", JSON.stringify(await icons(page)) === JSON.stringify(["", "pin", "square", "bus", "hospital", "dot", "pin"]), await icons(page));
    await page.waitForTimeout(300);

    // ---- Appearance popover: Icon row + picker ----
    await page.locator('.fp-item[data-feature-type="point"][data-feature-index="0"] .fp-type-icon').click();
    await page.locator("#fp-appearance-popover .fa-icon-row").waitFor({ state: "visible", timeout: 5000 });
    check("Appearance popover has an Icon row for a point", true);
    const rowInherited = await page.evaluate(() => document.querySelector("#fp-appearance-popover .fa-icon-row").classList.contains("lp-inherited"));
    check("Icon row is muted while following the default", rowInherited);
    await page.locator("#fp-appearance-popover .fa-icon-row .pi-current").click();
    await page.locator("#fp-icon-picker").waitFor({ state: "visible", timeout: 5000 });
    const tiles = await page.evaluate(() => ({ tiles: document.querySelectorAll("#fp-icon-picker .pi-tile").length, icons: PointIcons.ICONS.length }));
    check("picker lists every registry icon", tiles.tiles === tiles.icons && tiles.icons > 25, tiles);
    await page.locator('#fp-icon-picker .pi-tile[data-icon="ferry"]').click();
    await page.waitForFunction(() => App.points[0].properties._pointIcon === "ferry", null, { timeout: 5000 }).catch(() => {});
    check("picking a tile sets _pointIcon", (await icons(page))[0] === "ferry", await icons(page));
    check("picker closes after a pick and the popover stays open",
      await page.evaluate(() => !document.getElementById("fp-icon-picker") && !!document.getElementById("fp-appearance-popover")));
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: ["points-icon-layer"] }).some((f) => f.properties.name === "Dot"), null, { timeout: 5000 }).catch(() => {});
    check("the point now renders in the icon layer", (await layerNames(page, "points-icon-layer")).includes("Dot"));
    check("Icon row is no longer muted", await page.evaluate(() => !document.querySelector("#fp-appearance-popover .fa-icon-row").classList.contains("lp-inherited")));
    // Escape closes only the picker while it is open
    await page.locator("#fp-appearance-popover .fa-icon-row .pi-current").click();
    await page.locator("#fp-icon-picker").waitFor({ state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape");
    check("Escape closes the picker first, leaving the popover",
      await page.evaluate(() => !document.getElementById("fp-icon-picker") && !!document.getElementById("fp-appearance-popover")));
    await page.locator("#fp-appearance-popover .fa-icon-row .lp-style-clear").click();
    await page.waitForFunction(() => App.points[0].properties._pointIcon === undefined, null, { timeout: 5000 }).catch(() => {});
    check("× clears the override", (await icons(page))[0] === "", await icons(page));
    // Reset all clears the icon too
    await page.evaluate(() => App.setFeaturePointIcon(0, "star"));
    await page.waitForTimeout(150);
    await page.locator("#fp-appearance-popover .fa-reset").click();
    await page.waitForFunction(() => App.points[0].properties._pointIcon === undefined, null, { timeout: 5000 }).catch(() => {});
    check("Reset all clears the icon override", (await icons(page))[0] === "", await icons(page));
    await resetUI(page);

    // ---- Features-list row icon ----
    await page.evaluate(() => App.setFeaturePointIcon(0, "bus"));
    await page.waitForTimeout(250);
    const rowHasCanvas = await page.evaluate(() => !!document.querySelector('.fp-item[data-feature-type="point"][data-feature-index="0"] .fp-type-icon canvas.pi-preview'));
    check("Features list shows the icon in the row's type button", rowHasCanvas);
    await page.evaluate(() => App.setFeaturePointIcon(0, null));

    // ---- Layers > Style defaults ----
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    await page.waitForFunction(() => document.querySelector("#fp-tab-layers .lp-style-header"), null, { timeout: 10000 });
    await page.evaluate(() => {
      Array.from(document.querySelectorAll("#fp-tab-layers .lp-style-header")).find((h) => /Points/.test(h.textContent)).click();
    });
    // (per-feature drawers also carry Icon rows, so address the type default by its aria-label)
    const DEF_BTN = '#fp-tab-layers .pi-current[aria-label="Change default icon for Points"]';
    await page.locator(DEF_BTN).waitFor({ state: "visible", timeout: 5000 });
    check("Style defaults > Points has an Icon row", true);
    await page.locator(DEF_BTN).click();
    await page.locator('#fp-icon-picker .pi-tile[data-icon="rail-metro"]').click();
    await page.waitForFunction(() => App.featureSettings.pointIcon === "rail-metro", null, { timeout: 5000 }).catch(() => {});
    check("picking sets the type default and clears per-point overrides",
      (await page.evaluate(() => App.featureSettings.pointIcon)) === "rail-metro" && (await icons(page)).every((v) => v === ""), await icons(page));
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: ["points-layer"] }).length === 0 &&
      App.map.queryRenderedFeatures({ layers: ["points-icon-layer"] }).length >= 5, null, { timeout: 8000 }).catch(() => {});
    check("every point now renders as an icon", (await layerNames(page, "points-layer")).length === 0);
    check("the drawer preview shows the icon (an <image>, not the circle)",
      await page.evaluate(() => { const h = Array.from(document.querySelectorAll("#fp-tab-layers .lp-style-header")).find((x) => /Points/.test(x.textContent)); return !!h.querySelector("svg image") && !h.querySelector("svg circle"); }));
    await page.locator('#fp-tab-layers .lp-style-clear[aria-label="Reset Points icon to Dot"]').click();
    await page.waitForFunction(() => App.featureSettings.pointIcon === "dot", null, { timeout: 5000 }).catch(() => {});
    check("× on the Icon row returns the default to Dot", (await page.evaluate(() => App.featureSettings.pointIcon)) === "dot");
    await page.locator('.fp-tab-btn[data-fptab="features"]').click();
    await page.waitForTimeout(150);

    // ---- Duplicate ----
    const dup = await page.evaluate(() => { App.setFeaturePointIcon(3, "bus"); App.duplicatePoint(3); return App.points[App.points.length - 1].properties._pointIcon; });
    check("Duplicate copies _pointIcon", dup === "bus", dup);
    await page.evaluate(() => { App.undo.undo(); App.undo.undo(); });

    // ---- Missing image is re-registered on demand ----
    const reg = await page.evaluate(async () => {
      const name = "pi:bus:2b6cb0";
      App.points[3].properties._pointIcon = "bus"; App.renderPointLayers();
      const had = App.map.hasImage(name);
      App.map.removeImage(name);
      const gone = !App.map.hasImage(name);
      App.map.triggerRepaint();
      await new Promise((r) => setTimeout(r, 600));
      return { had, gone, back: App.map.hasImage(name) };
    });
    check("a removed icon image is re-registered by the styleimagemissing handler", reg.had && reg.gone && reg.back, reg);
    await page.evaluate(() => { App.points[3].properties._pointIcon = "bus"; });

    // ---- Session reload ----
    await page.evaluate(() => { App.setTypePointIcon("star"); App.setFeaturePointIcon(2, "school"); App.cache.save(); });
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && App.map && App.map.loaded() && App.cache", { timeout: 30000 });
    await page.evaluate(() => App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }));
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: ["points-icon-layer"] }).length >= 5, null, { timeout: 15000 }).catch(() => {});
    const re = await page.evaluate(() => ({ def: App.featureSettings.pointIcon, own: App.points.map((p) => p.properties._pointIcon || "")[2], n: App.points.length }));
    check("the type default and a per-point icon survive a reload", re.def === "star" && re.own === "school", re);
    check("after reload the icons render", (await layerNames(page, "points-icon-layer")).length >= 5, await layerNames(page, "points-icon-layer"));

    // An old session with no pointIcon field loads as Dot.
    const old = await page.evaluate(() => {
      const st = JSON.parse(JSON.stringify(App.cache.collectState("full")));
      delete st.pointIcon;
      App.cache.applyState(st);
      return App.featureSettings.pointIcon;
    });
    check("a session saved before point icons existed loads with the Dot default", old === "dot", old);

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
