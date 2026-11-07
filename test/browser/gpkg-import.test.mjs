#!/usr/bin/env node
// test/browser/gpkg-import.test.mjs
//
// Behavior test for the GeoPackage reader (js/core/gpkg-reader.js) and loader
// (js/core/gpkg-layers.js) against the committed fixture
// test/fixtures/sample.gpkg (built by test/fixtures/make-gpkg-fixture.py, which
// lists the exact coordinates of every row). Drives the real app in headless
// Chromium through the App._gpkgTest hook and asserts:
//
//   - the supported and unsupported layers are classified as the plan says
//   - projected UTM points come out as WGS 84 longitude/latitude
//   - WGS 84 lines keep their coordinates exactly, little- and big-endian
//   - polygon and multipolygon shapes survive reprojection
//   - Z coordinates are dropped, empty and NULL geometries are counted
//   - attribute conversion: BOOLEAN, JSON text, NULL keys omitted
//   - a file that is not a GeoPackage is rejected with the plain message
//   - a failed sql.js load is retried on the next call
//   - the Add Data picker lists every table, adds the checked ones, and Escape
//     and focus behave as the dialog contract says
//   - a tiles-only file (no metadata geometry table) lists its layer as unsupported
//   - geometry column names match case-insensitively; composite keys stay
//     attributes; a text key stays an attribute and the row index is the id
//
// The hook exists only when window.__MAT_TEST__ is set before the page
// scripts run, so it is set from an init script. Shared plumbing lives in
// test/browser/harness.mjs. USAGE: see test/browser/README.md (NODE_PATH points
// at a Playwright install).

import { fileURLToPath } from "node:url";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gpkg-import.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const SUPPORTED = ["empty_geom", "lines_wgs", "mixed_z", "polys_utm", "pts_utm", "undef_ok"];

// Every [x, y] pair in a GeoJSON geometry, however deeply nested.
function allPositions(c) {
  if (typeof c[0] === "number") return [c];
  return c.reduce((acc, part) => acc.concat(allPositions(part)), []);
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(() => { window.__MAT_TEST__ = true; });
    await routeVendoredAssets(context, port, () => false);

    const page = await context.newPage();
    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App._gpkgTest", { timeout: 30000 });

    // Everything runs in the page; Node only compares the plain JSON it returns.
    const summary = await page.evaluate(async () => {
      const T = App._gpkgTest;
      const bytes = await (await fetch("/test/fixtures/sample.gpkg")).arrayBuffer();
      const libs = await T.loadLibs();
      const db = T.openDb(libs, bytes);
      let notGpkg = null;
      try { T.openDb(libs, new Uint8Array([1, 2, 3]).buffer); } catch (e) { notGpkg = e.message; }
      try {
        const inspected = T.inspect(libs, db);
        const reads = {};
        for (const l of inspected.layers) {
          if (l.supported) reads[l.table] = T.readLayer(libs, db, l);
        }
        return {
          layers: inspected.layers.map((l) => ({ table: l.table, supported: l.supported, reason: l.reason, count: l.count })),
          reads: reads,
          notGpkg: notGpkg
        };
      } finally {
        db.close();
      }
    });

    const layers = summary.layers;
    const byTable = {};
    layers.forEach((l) => { byTable[l.table] = l; });
    const reads = summary.reads;
    const feat = (table, pred) => (reads[table] ? reads[table].featureCollection.features : []).filter(pred);
    const byLabel = (table, label, key) => feat(table, (f) => f.properties[key || "label"] === label)[0] || null;
    const byId = (table, id) => feat(table, (f) => f.id === id)[0] || null;

    // ---- 1. Supported layers ----
    const supportedNames = layers.filter((l) => l.supported).map((l) => l.table).sort();
    check("1. supported layers are exactly pts_utm, lines_wgs, polys_utm, mixed_z, empty_geom, undef_ok",
      JSON.stringify(supportedNames) === JSON.stringify(SUPPORTED),
      "actual " + JSON.stringify(supportedNames));

    // ---- 2. Unsupported layers and reasons ----
    const reasons = {
      weird_srs: byTable.weird_srs && byTable.weird_srs.reason,
      undef_bad: byTable.undef_bad && byTable.undef_bad.reason,
      notes: byTable.notes && byTable.notes.reason,
      tiles_tbl: byTable.tiles_tbl && byTable.tiles_tbl.reason
    };
    const reasonsOk = byTable.weird_srs && byTable.weird_srs.supported === false &&
      typeof reasons.weird_srs === "string" && reasons.weird_srs.indexOf("Unknown projection") === 0 &&
      reasons.undef_bad === "Undefined projection and coordinates are not longitude/latitude" &&
      reasons.notes === "Table has no geometry" &&
      reasons.tiles_tbl === "Raster tiles are not supported";
    check("2. unsupported layers: weird_srs, undef_bad, notes, tiles_tbl have the plan's reasons",
      reasonsOk, JSON.stringify(reasons));

    // ---- 3. pts_utm reprojection ----
    const center = byLabel("pts_utm", "center", "name");
    const ptsCount = reads.pts_utm ? reads.pts_utm.featureCollection.features.length : -1;
    const c = center && center.geometry.coordinates;
    const ptsOk = ptsCount === 3 && c &&
      Math.abs(c[0] + 105.0) < 1e-4 && Math.abs(c[1] - 39.7499) < 1e-4;
    check("3. pts_utm has 3 features; center is within 1e-4 of [-105.0000, 39.7499]",
      !!ptsOk, "features " + ptsCount + ", center " + JSON.stringify(c));

    // ---- 4. lines_wgs exact coordinates (big-endian blob) ----
    const be = byLabel("lines_wgs", "be");
    const beExpected = [[-105.1, 39.6], [-105.0, 39.65], [-104.95, 39.7]];
    check("4. lines_wgs row be coordinates equal the fixture exactly",
      !!be && be.geometry.type === "LineString" && JSON.stringify(be.geometry.coordinates) === JSON.stringify(beExpected),
      be ? JSON.stringify(be.geometry.coordinates) : "row missing");

    // ---- 5. polys_utm shapes ----
    const row1 = byId("polys_utm", 1);
    const row2 = byId("polys_utm", 2);
    const polyOk = !!row1 && row1.geometry.type === "Polygon" && row1.geometry.coordinates.length === 2 &&
      !!row2 && row2.geometry.type === "MultiPolygon" && row2.geometry.coordinates.length === 2;
    check("5. polys_utm row 1 is a Polygon with 2 rings; row 2 is a MultiPolygon with 2 polygons",
      polyOk, JSON.stringify({ row1: row1 && row1.geometry.type, row2: row2 && row2.geometry.type }));

    // ---- 6. mixed_z drops Z ----
    const pointZ = byLabel("mixed_z", "pointz");
    check("6. mixed_z point has exactly 2 coordinates",
      !!pointZ && pointZ.geometry.type === "Point" && pointZ.geometry.coordinates.length === 2,
      pointZ ? JSON.stringify(pointZ.geometry.coordinates) : "row missing");

    // ---- 7. empty and NULL geometries are counted, not drawn ----
    const emptyRead = reads.empty_geom;
    const emptyOk = !!emptyRead && emptyRead.featureCollection.features.length === 0 &&
      emptyRead.skipped.empty === 1 && emptyRead.skipped.nullGeom === 1;
    check("7. empty_geom: 0 features, skipped.empty 1, skipped.nullGeom 1",
      emptyOk, emptyRead ? JSON.stringify(emptyRead.skipped) + ", features " + emptyRead.featureCollection.features.length : "not read");

    // ---- 8. attribute conversion on the center point ----
    const props = center ? center.properties : null;
    check("8. pts_utm center: flag is true, no note key, info is the JSON text",
      !!props && props.flag === true && !("note" in props) && props.info === '{"a":1,"b":[2,3]}',
      props ? JSON.stringify(props) : "row missing");

    // ---- 9. non-GeoPackage input ----
    check("9. a non-GeoPackage buffer is rejected with \"This file is not a GeoPackage.\"",
      summary.notGpkg === "This file is not a GeoPackage.", "actual " + JSON.stringify(summary.notGpkg));

    // ---- 10. polys_utm stays inside the expected area ----
    const polyPositions = feat("polys_utm", () => true)
      .reduce((acc, f) => acc.concat(allPositions(f.geometry.coordinates)), []);
    const polyBad = polyPositions.filter((p) => !(p[0] >= -106 && p[0] <= -104 && p[1] >= 39 && p[1] <= 41));
    check("10. every polys_utm coordinate is within lon -106..-104, lat 39..41",
      polyPositions.length > 0 && polyBad.length === 0,
      polyPositions.length + " positions, " + polyBad.length + " outside");

    // ---- 11. nothing was dropped as invalid, unsupported or a collection ----
    let dropped = 0;
    Object.keys(reads).forEach((t) => {
      const s = reads[t].skipped;
      dropped += s.invalid + s.unsupported + s.collection;
    });
    check("11. supported layers skipped no features as invalid, unsupported or collection",
      dropped === 0, "total " + dropped);

    // ---- 12. a failed library load is retried on the next call ----
    const retryContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    let retry = null;
    try {
      await retryContext.addInitScript(() => { window.__MAT_TEST__ = true; });
      let wasmAborted = false;
      await routeVendoredAssets(retryContext, port, async (route, reqUrl) => {
        if (reqUrl === "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm" && !wasmAborted) {
          wasmAborted = true;
          await route.abort();
          return true;
        }
        return false;
      });
      const retryPage = await retryContext.newPage();
      await retryPage.goto(url, { waitUntil: "load" });
      await retryPage.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App._gpkgTest", { timeout: 30000 });
      retry = await retryPage.evaluate(async () => {
        const T = App._gpkgTest;
        let first = null;
        try { await T.loadLibs(); } catch (e) { first = e.message; }
        let second = null;
        try {
          const libs = await T.loadLibs();
          second = typeof libs.SQL.Database === "function" && typeof libs.proj4 === "function";
        } catch (e) { second = e.message; }
        return { first: first, second: second };
      });
    } finally {
      await retryContext.close().catch(() => {});
    }
    const LIBS_ERROR = "Could not load the GeoPackage reader. Check your internet connection and try again.";
    check("12. after one aborted WASM fetch, loadLibs rejects once and then resolves with SQL and proj4",
      !!retry && retry.first === LIBS_ERROR && retry.second === true,
      JSON.stringify(retry));

    // ---- 13. a tiles-only file has no gpkg_geometry_columns or gpkg_spatial_ref_sys ----
    const tilesOnly = await page.evaluate(async () => {
      const T = App._gpkgTest;
      const libs = await T.loadLibs();
      const src = new libs.SQL.Database();
      // exec, not run: run executes only the first statement of a string.
      src.exec("CREATE TABLE gpkg_contents(table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, description TEXT, last_change TEXT, min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER); INSERT INTO gpkg_contents(table_name, data_type) VALUES ('t1','tiles');");
      const bytes = src.export();
      const db = T.openDb(libs, bytes.buffer);
      try {
        return T.inspect(libs, db).layers.map((l) => ({ table: l.table, supported: l.supported, reason: l.reason }));
      } finally {
        db.close();
      }
    });
    check("13. tiles-only file: one layer, unsupported, reason \"Raster tiles are not supported\"",
      tilesOnly.length === 1 && tilesOnly[0].supported === false && tilesOnly[0].reason === "Raster tiles are not supported",
      JSON.stringify(tilesOnly));

    // ---- 14 and 15. geometry column name case, composite key, text key ----
    const keyed = await page.evaluate(async () => {
      const T = App._gpkgTest;
      const libs = await T.loadLibs();
      // GeoPackage point blob for (-105, 39.75): "GP", version 0, flags 1 (little-endian
      // header, no envelope, not empty), int32 srs_id 0, then little-endian WKB Point.
      const blob = new Uint8Array(29);
      const dv = new DataView(blob.buffer);
      blob[0] = 0x47; blob[1] = 0x50; blob[2] = 0; blob[3] = 1;
      dv.setInt32(4, 0, true);
      blob[8] = 1;
      dv.setUint32(9, 1, true);
      dv.setFloat64(13, -105, true);
      dv.setFloat64(21, 39.75, true);
      const src = new libs.SQL.Database();
      src.exec(`
        CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id INTEGER, definition TEXT, description TEXT);
        INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84"]', '');
        CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, description TEXT, last_change TEXT, min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER);
        CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);
        CREATE TABLE ck (a INTEGER, b INTEGER, geom BLOB, PRIMARY KEY(a, b));
        CREATE TABLE tk (code TEXT PRIMARY KEY, geom BLOB);
        INSERT INTO gpkg_contents VALUES ('ck', 'features', 'ck', '', '2026-01-01T00:00:00Z', -105, 39.75, -105, 39.75, 4326);
        INSERT INTO gpkg_contents VALUES ('tk', 'features', 'tk', '', '2026-01-01T00:00:00Z', -105, 39.75, -105, 39.75, 4326);
        INSERT INTO gpkg_geometry_columns VALUES ('ck', 'Geom', 'POINT', 4326, 0, 0);
        INSERT INTO gpkg_geometry_columns VALUES ('tk', 'geom', 'POINT', 4326, 0, 0);
      `);
      src.run("INSERT INTO ck VALUES (?, ?, ?)", [1, 2, blob]);
      src.run("INSERT INTO tk VALUES (?, ?)", ["X1", blob]);
      const bytes = src.export();
      const db = T.openDb(libs, bytes.buffer);
      try {
        const inspected = T.inspect(libs, db);
        const feats = {};
        const supported = {};
        inspected.layers.forEach((l) => { supported[l.table] = l.supported; });
        for (const l of inspected.layers) {
          if (l.supported) feats[l.table] = T.readLayer(libs, db, l).featureCollection.features;
        }
        return { supported: supported, feats: feats };
      } finally {
        db.close();
      }
    });
    const ckFeats = keyed.feats.ck || [];
    const tkFeats = keyed.feats.tk || [];
    check("14. case-insensitive geometry column and composite key: layer supported, 1 feature, a=1 and b=2 kept, feature.id 0",
      keyed.supported.ck === true && ckFeats.length === 1 && ckFeats[0].id === 0 &&
      ckFeats[0].properties.a === 1 && ckFeats[0].properties.b === 2,
      JSON.stringify({ supported: keyed.supported.ck, features: ckFeats.length, id: ckFeats[0] && ckFeats[0].id, props: ckFeats[0] && ckFeats[0].properties }));
    check("15. text primary key: layer supported, feature.id 0, properties.code is \"X1\"",
      keyed.supported.tk === true && tkFeats.length === 1 && tkFeats[0].id === 0 &&
      tkFeats[0].properties.code === "X1",
      JSON.stringify({ supported: keyed.supported.tk, features: tkFeats.length, id: tkFeats[0] && tkFeats[0].id, props: tkFeats[0] && tkFeats[0].properties }));

    // ---- Map layers and the Layers panel ----
    // A drawn point first, so the checks can prove imports never touch drawn
    // features and sit below them in the layer stack.
    await page.evaluate(() => {
      App.points.push({ type: "Feature", geometry: { type: "Point", coordinates: [-105, 39.75] }, properties: { name: "Drawn" } });
      App.renderPointLayers();
    });
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    const added = await page.evaluate(async () => {
      const t = App._gpkgTest;
      const libs = await t.loadLibs();
      const buf = await (await fetch("/test/fixtures/sample.gpkg")).arrayBuffer();
      const db = t.openDb(libs, buf);
      try {
        const layers = t.inspect(libs, db).layers;
        const byName = (n) => layers.find((l) => l.table === n);
        const ids = {};
        ["polys_utm", "pts_utm", "mixed_z"].forEach((n) => {
          ids[n] = t.addLayerToMap(t.readLayer(libs, db, byName(n)).featureCollection,
            { fileName: "sample.gpkg", layerName: n });
        });
        // The same layer again: must get its own id, source and row.
        ids.again = t.addLayerToMap(t.readLayer(libs, db, byName("pts_utm")).featureCollection,
          { fileName: "sample.gpkg", layerName: "pts_utm" });
        return ids;
      } finally { db.close(); }
    });
    const state = () => page.evaluate((ids) => {
      const m = App.map;
      const styleIds = m.getStyle().layers.map((l) => l.id);
      const out = { styleIds: styleIds.filter((s) => s.startsWith("gpkg-")), drawn: App.points.length,
        pointsIdx: styleIds.indexOf("points-layer"), rows: {}, sources: {} };
      Object.keys(ids).forEach((k) => {
        out.sources[k] = !!m.getSource("gpkg-src-" + ids[k]);
      });
      out.rows = Array.from(document.querySelectorAll("#fp-tab-layers .lp-row-label")).map((e) => e.textContent)
        .filter((s) => s.indexOf("sample.gpkg") === 0);
      out.maxGpkgIdx = Math.max.apply(null, out.styleIds.map((s) => styleIds.indexOf(s)));
      return out;
    }, added);
    let s1 = await state();
    const p = added.polys_utm, m = added.mixed_z;
    check("16. polygon layer gets fill + outline, mixed layer gets line + point, all below drawn points",
      s1.styleIds.includes("gpkg-" + p + "-fill") && s1.styleIds.includes("gpkg-" + p + "-outline") &&
      !s1.styleIds.includes("gpkg-" + p + "-point") &&
      s1.styleIds.includes("gpkg-" + m + "-line") && s1.styleIds.includes("gpkg-" + m + "-point") &&
      s1.pointsIdx > s1.maxGpkgIdx, JSON.stringify(s1.styleIds) + " points@" + s1.pointsIdx);
    check("17. four imports get four distinct ids, sources and Reference rows",
      new Set(Object.values(added)).size === 4 && Object.values(s1.sources).every(Boolean) && s1.rows.length === 4,
      JSON.stringify({ added, rows: s1.rows }));

    const label = "sample.gpkg · polys_utm";
    const vis = await page.evaluate(({ label, p }) => {
      document.querySelector('#fp-tab-layers button[aria-label="Hide ' + label + '"]').click();
      const v = App.map.getLayoutProperty("gpkg-" + p + "-fill", "visibility");
      document.querySelector('#fp-tab-layers button[aria-label="Show ' + label + '"]').click();
      return [v, App.map.getLayoutProperty("gpkg-" + p + "-fill", "visibility")];
    }, { label, p });
    check("18. the row's eye hides and shows the layer", vis[0] === "none" && vis[1] !== "none", JSON.stringify(vis));

    const color = await page.evaluate(({ p }) => {
      App.setLayerStyle("gpkg-" + p, { color: "#123456" });
      return [App.map.getPaintProperty("gpkg-" + p + "-fill", "fill-color"),
        App.map.getPaintProperty("gpkg-" + p + "-outline", "line-color")];
    }, { p });
    // The fill keeps its transparency in the color itself (see FILL_ALPHA).
    check("19. a color set through App.setLayerStyle repaints fill and outline",
      color[0] === "rgba(18,52,86,0.35)" && color[1] === "#123456", JSON.stringify(color));
    const extra = await page.evaluate(({ p }) => ({
      emptyId: App._gpkgTest.addLayerToMap({ type: "FeatureCollection", features: [] }, { fileName: "x", layerName: "y" }),
      opacities: [App.map.getPaintProperty("gpkg-" + p + "-fill", "fill-opacity"),
        App.map.getPaintProperty("gpkg-" + p + "-outline", "line-opacity")]
    }), { p });
    check("19b. an empty collection is not imported; fill and outline opacity start at 1 so the row slider reads 100%",
      extra.emptyId === null && extra.opacities[0] === 1 && extra.opacities[1] === 1, JSON.stringify(extra));

    await page.evaluate((l) => {
      document.querySelector('#fp-tab-layers button[aria-label="More actions for ' + l + '"]').click();
    }, label);
    await page.locator("#fp-context-menu").waitFor({ state: "visible", timeout: 5000 });
    const menu = await page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
    await page.evaluate(() => {
      Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === "Remove layer").click();
    });
    const s2 = await state();
    check("20. ⋯ menu has Zoom to layer and Remove layer; Remove deletes source, layers and row only",
      menu.includes("Zoom to layer") && menu.includes("Remove layer") &&
      !s2.sources.polys_utm && !s2.styleIds.some((x) => x.startsWith("gpkg-" + p + "-")) &&
      s2.rows.length === 3 && s2.sources.pts_utm && s2.drawn === 1,
      JSON.stringify({ menu, s2 }));

    await page.evaluate(() => { window.confirm = () => true; document.getElementById("clear").click(); });
    const s3 = await state();
    check("21. toolbar Clear removes every GeoPackage layer",
      s3.styleIds.length === 0 && Object.values(s3.sources).every((x) => !x) && s3.rows.length === 0 &&
      (await page.evaluate(() => App.gpkgLoaded())) === false, JSON.stringify(s3));

    // ---- Add Data → GeoPackage → layer picker (#gp-dialog) ----
    // Runs after check 21, so the page starts with no GeoPackage layers. The
    // file goes in through the hidden Add Data input, the same path the menu uses.
    const GPKG_FIXTURE = fileURLToPath(new URL("../fixtures/sample.gpkg", import.meta.url));
    const openPicker = async () => {
      await page.evaluate(() => { document.getElementById("ad-gpkg-file").value = ""; });
      await page.setInputFiles("#ad-gpkg-file", GPKG_FIXTURE);
      return page.locator("#gp-dialog").waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
    };
    const pickerRows = () => page.evaluate(() => Array.from(document.querySelectorAll("#gp-layer-list label.gp-row")).map((row) => {
      const box = row.querySelector("input[type=checkbox]");
      return { name: row.querySelector(".gp-name").textContent, disabled: box.disabled, checked: box.checked };
    }));
    const gpkgRowLabels = () => page.evaluate(() => Array.from(document.querySelectorAll("#fp-tab-layers .lp-row-label"))
      .map((e) => e.textContent).filter((s) => s.indexOf("sample.gpkg") === 0));

    // ---- 22. Opening the picker lists every table; only supported rows start checked ----
    const opened22 = await openPicker();
    const rows22 = opened22 ? await pickerRows() : [];
    const disabled22 = rows22.filter((r) => r.disabled).map((r) => r.name);
    const enabled22 = rows22.filter((r) => !r.disabled);
    check("22. setInputFiles opens the picker: 10 rows, 4 disabled, the 6 supported rows start checked",
      opened22 && rows22.length === 10 && disabled22.length === 4 &&
      enabled22.length === 6 && enabled22.every((r) => r.checked),
      "rows " + rows22.length + ", disabled " + JSON.stringify(disabled22));

    // ---- 23. Add follows the checked rows ----
    const enabledBoxes = page.locator("#gp-layer-list label.gp-row:not(.gp-row-disabled) input[type=checkbox]");
    const enabledTotal = await enabledBoxes.count();
    for (let i = 0; i < enabledTotal; i++) await enabledBoxes.nth(i).click();
    const addAfterUncheckAll = await page.locator("#gp-add").isDisabled();
    await page.locator("#gp-layer-list label.gp-row", { hasText: "pts_utm" }).locator("input[type=checkbox]").click();
    const addAfterOne = await page.locator("#gp-add").isEnabled();
    const checkedNames23 = (await pickerRows()).filter((r) => r.checked).map((r) => r.name);
    check("23. unchecking every enabled row disables Add; checking only pts_utm enables it",
      addAfterUncheckAll && addAfterOne && JSON.stringify(checkedNames23) === JSON.stringify(["pts_utm"]),
      JSON.stringify({ addAfterUncheckAll, addAfterOne, checkedNames23 }));

    // ---- 24. Add reads the checked layer and adds exactly one Layers row ----
    const rowsBefore24 = (await gpkgRowLabels()).length;
    await page.locator("#gp-add").click();
    const closed24 = await page.locator("#gp-dialog").waitFor({ state: "hidden", timeout: 15000 }).then(() => true, () => false);
    await page.waitForFunction(() => (document.getElementById("status").textContent || "").indexOf("Added") === 0,
      null, { timeout: 15000 }).catch(() => {});
    const statusText24 = await page.locator("#status").textContent();
    const rows24 = await gpkgRowLabels();
    check("24. Add closes the picker, adds one Layers row \"sample.gpkg · pts_utm\", status starts \"Added 1 GeoPackage layer\"",
      closed24 && rowsBefore24 === 0 && JSON.stringify(rows24) === JSON.stringify(["sample.gpkg · pts_utm"]) &&
      statusText24.indexOf("Added 1 GeoPackage layer") === 0,
      JSON.stringify({ closed24, rowsBefore24, rows24, statusText24 }));

    // ---- 25. Escape closes a reopened picker and adds nothing ----
    const opened25 = await openPicker();
    await page.keyboard.press("Escape");
    const closed25 = await page.locator("#gp-dialog").waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false);
    const rows25 = (await gpkgRowLabels()).length;
    check("25. Escape closes a reopened picker and adds nothing: still 1 sample.gpkg row",
      opened25 && closed25 && rows25 === 1, JSON.stringify({ opened25, closed25, rows25 }));

    // ---- 26. Focus lands on the first enabled checkbox when the picker opens ----
    const opened26 = await openPicker();
    const focus26 = await page.evaluate(() => {
      const first = document.querySelector("#gp-layer-list input[type=checkbox]:not([disabled])");
      return { isFirst: !!first && document.activeElement === first, activeTag: document.activeElement && document.activeElement.tagName };
    });
    check("26. right after the picker opens, focus is on the first enabled checkbox",
      opened26 && focus26.isFirst, JSON.stringify({ opened26, focus26 }));
    await page.keyboard.press("Escape");
    await page.locator("#gp-dialog").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await page.evaluate(() => App.gpkgClearAll());

    // ---- Click a GeoPackage feature to see its attributes ----
    // Polygon import first, point import above it. The point "center" sits in
    // the polygon's hole; `spot` is inside the polygon's solid part.
    const geo = await page.evaluate(async () => {
      App.points.length = 0;
      App.renderPointLayers();
      const t = App._gpkgTest;
      const libs = await t.loadLibs();
      const db = t.openDb(libs, await (await fetch("/test/fixtures/sample.gpkg")).arrayBuffer());
      try {
        const layers = t.inspect(libs, db).layers;
        const read = (n) => t.readLayer(libs, db, layers.find((l) => l.table === n)).featureCollection;
        const polys = read("polys_utm");
        const pts = read("pts_utm");
        t.addLayerToMap(polys, { fileName: "sample.gpkg", layerName: "polys_utm" });
        t.addLayerToMap(pts, { fileName: "sample.gpkg", layerName: "pts_utm" });
        const ring = polys.features[0].geometry.coordinates[0];
        const xs = ring.map((c) => c[0]), ys = ring.map((c) => c[1]);
        const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        App.map.jumpTo({ center: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], zoom: 14 });
        const center = pts.features.find((f) => f.properties.name === "center").geometry.coordinates;
        return { spot: [bb[0] + (bb[2] - bb[0]) * 0.1, bb[1] + (bb[3] - bb[1]) * 0.5], center };
      } finally { db.close(); }
    });
    await page.waitForFunction(() => App.map.loaded() && !App.map.isMoving(), null, { timeout: 10000 });
    async function clickAt(lngLat) {
      const px = await page.evaluate((ll) => {
        const p = App.map.project(ll);
        const r = App.map.getCanvas().getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y };
      }, lngLat);
      await page.mouse.click(px.x, px.y);
      await page.waitForTimeout(0);
    }
    const popupState = () => page.evaluate(() => {
      const el = document.querySelector(".gp-popup");
      return el ? { title: el.querySelector(".gp-popup-title").textContent, nested: !!el.querySelector(".gp-popup-nested"),
        keys: Array.from(el.querySelectorAll("dt")).map((d) => d.textContent) } : null;
    });
    const closePopup = () => page.evaluate(() => {
      const b = document.querySelector(".gp-popup-wrap .maplibregl-popup-close-button");
      if (b) b.click();
    });

    await clickAt(geo.spot);
    await page.waitForFunction(() => !!document.querySelector(".gp-popup"), null, { timeout: 5000 }).catch(() => {});
    const pPoly = await popupState();
    check("27. clicking a GeoPackage polygon opens its attribute popup",
      !!pPoly && pPoly.title === "sample.gpkg · polys_utm", JSON.stringify(pPoly));
    // Popup left open on purpose: the next click must move it to the point.

    await clickAt(geo.center);
    await page.waitForFunction(() => {
      const t = document.querySelector(".gp-popup .gp-popup-title");
      return t && t.textContent.indexOf("pts_utm") >= 0;
    }, null, { timeout: 5000 }).catch(() => {});
    const pPt = await popupState();
    check("28. with the popup open, clicking a point above the polygon moves it there; JSON text shows as a nested list",
      !!pPt && pPt.title === "sample.gpkg · pts_utm" && pPt.nested &&
      pPt.keys.includes("name") && pPt.keys.includes("info") && !pPt.keys.includes("note"), JSON.stringify(pPt));
    await closePopup();

    // A drawn point on top of the polygon: the click selects it, no popup.
    await page.evaluate((ll) => {
      App.points.push({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties: { name: "Drawn", pointIdx: 9001 } });
      App.renderPointLayers();
    }, geo.spot);
    await page.waitForFunction(() => !App.map.isMoving(), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    await clickAt(geo.spot);
    await page.waitForTimeout(300);
    const sel29 = await page.evaluate(() => ({
      popup: !!document.querySelector(".gp-popup"),
      selected: (App.getSelectedFeatures ? App.getSelectedFeatures() : []).map((s) => s.type + ":" + s.index)
    }));
    check("29. a drawn point above a GeoPackage polygon takes the click: selected, no popup",
      !sel29.popup && sel29.selected.length === 1 && sel29.selected[0] === "point:0", JSON.stringify(sel29));
    await page.keyboard.press("Escape");

    // Point tool active: the click draws, the popup stays shut.
    const before30 = await page.evaluate(() => App.points.length);
    await page.locator('.tool-btn[data-mode="point"]').click();
    await clickAt([geo.spot[0], geo.spot[1] + 0.001]);
    await page.waitForTimeout(300);
    const after30 = await page.evaluate(() => ({ n: App.points.length, popup: !!document.querySelector(".gp-popup") }));
    check("30. with the point tool active, clicking a GeoPackage polygon draws a point and opens no popup",
      after30.n === before30 + 1 && !after30.popup, JSON.stringify({ before30, after30 }));
    await page.locator('.tool-btn[data-mode="point"]').click();
    await page.evaluate(() => App.gpkgClearAll());

    // ---- Copy to drawn features ----
    const copyLabel = "sample.gpkg · polys_utm";
    const pre = await page.evaluate(async () => {
      const t = App._gpkgTest;
      const libs = await t.loadLibs();
      const db = t.openDb(libs, await (await fetch("/test/fixtures/sample.gpkg")).arrayBuffer());
      try {
        const layer = t.inspect(libs, db).layers.find((l) => l.table === "polys_utm");
        t.addLayerToMap(t.readLayer(libs, db, layer).featureCollection, { fileName: "sample.gpkg", layerName: "polys_utm" });
      } finally { db.close(); }
      return { points: App.points.length, polygons: App.polygons.length };
    });
    await page.evaluate((l) => {
      document.querySelector('#fp-tab-layers button[aria-label="More actions for ' + l + '"]').click();
    }, copyLabel);
    await page.locator("#fp-context-menu").waitFor({ state: "visible", timeout: 5000 });
    const copyMenu = await page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
    await page.evaluate(() => {
      Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === "Copy to drawn features").click();
    });
    const post = await page.evaluate(() => ({
      points: App.points.length, polygons: App.polygons.length,
      last: App.polygons.slice(-3).map((f) => ({ name: f.properties.name, attrs: f.properties.attributes || null, id: f.properties[App.FEATURE_ID_PROP.polygon] || null })),
      stillImported: App.gpkgLoaded()
    }));
    // polys_utm has a Polygon and a 2-part MultiPolygon: 3 drawn polygons.
    check("31. Copy to drawn features adds 3 polygons, keeps the existing drawn features and the import",
      copyMenu.includes("Copy to drawn features") && post.points === pre.points &&
      post.polygons === pre.polygons + 3 && post.stillImported, JSON.stringify({ copyMenu, pre, post }));
    check("32. copied polygons carry the layer's attributes and get feature ids",
      post.last.every((f) => f.attrs && f.attrs.label && f.id), JSON.stringify(post.last));
    // Copies must not share coordinate arrays with the import: edit one in
    // place, copy again, and the second copy must still have the original.
    const alias = await page.evaluate((l) => {
      const before = JSON.stringify(App.polygons[App.polygons.length - 3].geometry.coordinates[0][0]);
      App.polygons[App.polygons.length - 3].geometry.coordinates[0][0][0] += 1;
      const entry = App.gpkgReferenceEntries().find((e) => e.label === l);
      entry.menuItems()[0].action();
      const again = JSON.stringify(App.polygons[App.polygons.length - 3].geometry.coordinates[0][0]);
      App.undo.undo();
      return { before, again };
    }, copyLabel);
    check("33b. editing a copied polygon does not change what the next copy gets",
      alias.before === alias.again, JSON.stringify(alias));
    await page.evaluate(() => App.undo.undo());
    const undone = await page.evaluate(() => ({ points: App.points.length, polygons: App.polygons.length }));
    check("33. one Undo removes the whole copy",
      undone.points === pre.points && undone.polygons === pre.polygons, JSON.stringify({ pre, undone }));
    await page.evaluate(() => App.gpkgClearAll());
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
