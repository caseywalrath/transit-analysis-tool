#!/usr/bin/env node
// test/browser/gpkg-import.test.mjs
//
// GeoPackage viewer (js/core/gpkg-import.js): a .gpkg picked in Spatial Data
// must open as read-only Reference / Imported layers — never drawn features —
// with click popups, a table viewer, per-layer and per-file Remove, and Clear
// all support. The sample file is built in the page with the same sql.js the
// app loads (vendored by harness.mjs), so no binary fixture is committed.
//
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gpkg-import.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

// Runs in the page: builds a GeoPackage with a point table (seconds), a line
// table, a polygon table, an empty table, a projected table (must be skipped)
// and a non-spatial attributes table. Returns the file bytes as an array.
async function buildSampleGpkg() {
  const SQLJS = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";
  if (typeof window.initSqlJs !== "function") {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = SQLJS + "sql-wasm.js"; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const SQL = await window.initSqlJs({ locateFile: (f) => SQLJS + f });
  const db = new SQL.Database();

  function blob(srs, wkbParts) {
    const bytes = [];
    const dv = new DataView(new ArrayBuffer(8));
    const u32 = (v) => { dv.setUint32(0, v, true); for (let i = 0; i < 4; i++) bytes.push(dv.getUint8(i)); };
    const f64 = (v) => { dv.setFloat64(0, v, true); for (let i = 0; i < 8; i++) bytes.push(dv.getUint8(i)); };
    bytes.push(0x47, 0x50, 0, 1); // "GP", version 0, little-endian, no envelope
    dv.setInt32(0, srs, true); for (let i = 0; i < 4; i++) bytes.push(dv.getUint8(i));
    wkbParts({ u32, f64, byte: (b) => bytes.push(b) });
    return new Uint8Array(bytes);
  }
  const point = (srs, x, y) => blob(srs, (w) => { w.byte(1); w.u32(1); w.f64(x); w.f64(y); });
  const line = (srs, cs) => blob(srs, (w) => { w.byte(1); w.u32(2); w.u32(cs.length); cs.forEach((c) => { w.f64(c[0]); w.f64(c[1]); }); });
  const poly = (srs, ring) => blob(srs, (w) => { w.byte(1); w.u32(3); w.u32(1); w.u32(ring.length); ring.forEach((c) => { w.f64(c[0]); w.f64(c[1]); }); });

  db.run(`CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id INTEGER, definition TEXT, description TEXT);
    INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84', 4326, 'EPSG', 4326, '', ''), ('State Plane', 2232, 'EPSG', 2232, '', '');
    CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, srs_id INTEGER);
    CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);
    CREATE TABLE nodes (fid INTEGER PRIMARY KEY, geom BLOB, node_id TEXT, seconds REAL);
    CREATE TABLE edges (fid INTEGER PRIMARY KEY, geom BLOB, way_id TEXT, length_ft REAL);
    CREATE TABLE zones (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
    CREATE TABLE frontier (fid INTEGER PRIMARY KEY, geom BLOB, node_id TEXT);
    CREATE TABLE projected (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
    CREATE TABLE notes (fid INTEGER PRIMARY KEY, origin_id TEXT, status TEXT);
    INSERT INTO gpkg_contents VALUES ('nodes','features','nodes',4326), ('edges','features','edges',4326),
      ('zones','features','zones',4326), ('frontier','features','frontier',4326),
      ('projected','features','projected',2232), ('notes','attributes','notes',0);
    INSERT INTO gpkg_geometry_columns VALUES ('nodes','geom','POINT',4326,0,0), ('edges','geom','LINESTRING',4326,0,0),
      ('zones','geom','POLYGON',4326,0,0), ('frontier','geom','POINT',4326,0,0), ('projected','geom','POINT',2232,0,0);
    INSERT INTO notes VALUES (1, 'origin-1', 'verified'), (2, 'origin-2', 'pending');`);
  // Centered on the default map view (js/core/map.js) so features render.
  const lng0 = -104.9903, lat0 = 39.7392;
  const ins = db.prepare("INSERT INTO nodes (geom, node_id, seconds) VALUES (?, ?, ?)");
  for (let i = 0; i < 5; i++) ins.run([point(4326, lng0 + i * 0.01, lat0), "n" + i, i * 60]);
  ins.free();
  db.run("INSERT INTO edges (geom, way_id, length_ft) VALUES (?, 'w1', 2700.5), (?, 'w2', 1300)",
    [line(4326, [[lng0, lat0 + 0.02], [lng0 + 0.04, lat0 + 0.02]]), line(4326, [[lng0, lat0 - 0.02], [lng0 + 0.02, lat0 - 0.03]])]);
  db.run("INSERT INTO zones (geom, name) VALUES (?, 'Zone A')",
    [poly(4326, [[lng0 - 0.05, lat0 - 0.05], [lng0 - 0.03, lat0 - 0.05], [lng0 - 0.03, lat0 - 0.03], [lng0 - 0.05, lat0 - 0.05]])]);
  db.run("INSERT INTO projected (geom, name) VALUES (?, 'far away')", [point(2232, 3140000, 1690000)]);
  const bytes = db.export();
  db.close();
  return Array.from(bytes);
}

async function rowMenu(page, label) {
  await page.evaluate((l) => {
    document.querySelector('#fp-tab-layers button[aria-label="More actions for ' + l + '"]').click();
  }, label);
  await page.locator("#fp-context-menu").waitFor({ state: "visible", timeout: 5000 });
  return page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
}
async function clickMenuItem(page, text) {
  await page.evaluate((t) => {
    Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === t).click();
  }, text);
}
const panelLabels = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('#fp-tab-layers button[aria-label^="More actions for "]'))
    .map((b) => b.getAttribute("aria-label").replace("More actions for ", "")));

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await routeVendoredAssets(context, port);
    const page = await context.newPage();
    const pageErrors = [], dialogs = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForFunction("typeof App.importGeoPackage === 'function'", { timeout: 10000 });

    const bytes = Buffer.from(await page.evaluate(buildSampleGpkg));
    const file = { name: "sample.gpkg", mimeType: "application/geopackage+sqlite3", buffer: bytes };

    // ---- Open through the real Spatial Data file input ----
    await page.setInputFiles("#fp-import-file", file);
    await page.waitForFunction("App.geoPackageImports().length === 1", { timeout: 20000 });
    const imp = (await page.evaluate(() => App.geoPackageImports()))[0];
    const byLabel = Object.fromEntries(imp.layers.map((l) => [l.label, l]));
    check("three map layers (points, lines, polygons)", imp.layers.length === 3, imp.layers.map((l) => l.label).join(","));
    check("nodes is a point layer with 5 features colored by seconds",
      byLabel.nodes && byLabel.nodes.kind === "point" && byLabel.nodes.featureCount === 5 && byLabel.nodes.colorField === "seconds",
      JSON.stringify(byLabel.nodes));
    check("edges is a line layer with 2 features", byLabel.edges && byLabel.edges.kind === "line" && byLabel.edges.featureCount === 2);
    check("zones is a polygon layer with fill + outline", byLabel.zones && byLabel.zones.kind === "polygon" && byLabel.zones.layerIds.length === 2);
    check("projected table is skipped, not drawn", !imp.layers.some((l) => l.label === "projected") &&
      !imp.tables.some((t) => t.name === "projected"));
    check("empty table and attributes table are kept for the table viewer",
      imp.tables.some((t) => t.name === "frontier" && t.rows === 0) && imp.tables.some((t) => t.name === "notes" && !t.spatial && t.rows === 2));

    const mapState = await page.evaluate((ids) => ids.map((id) => !!App.map.getLayer(id)), imp.layers.flatMap((l) => l.layerIds));
    check("every layer id is on the map", mapState.every(Boolean), JSON.stringify(mapState));
    const drawn = await page.evaluate(() => App.points.length + App.lines.length + App.polygons.length);
    check("no drawn features were created", drawn === 0, "drawn=" + drawn);
    const status = await page.evaluate(() => (document.getElementById("status") || {}).textContent || "");
    check("status reports layers, features and skipped table", /3 layers/.test(status) && /8 features/.test(status) && /skipped: projected/.test(status), status);
    const below = await page.evaluate(() => {
      const ids = App.map.getStyle().layers.map((l) => l.id);
      const g = ids.indexOf(App.geoPackageImports()[0].layers[0].layerIds[0]);
      const p = ids.indexOf("points-layer");
      return { g, p };
    });
    check("imported layers sit under the drawn feature layers", below.p < 0 || below.g < below.p, JSON.stringify(below));

    // ---- Layers panel rows ----
    await page.waitForFunction(() => document.querySelector('#fp-tab-layers button[aria-label="More actions for nodes"]'), { timeout: 5000 });
    const labels = await panelLabels(page);
    check("Layers panel lists nodes, edges and zones", ["nodes", "edges", "zones"].every((l) => labels.includes(l)), labels.join(","));
    check("file's first table is on top of the band", labels.indexOf("nodes") < labels.indexOf("zones"), labels.join(","));

    // ---- Click popup ----
    await page.evaluate(() => App.map.jumpTo({ center: [-104.9903 + 0.02, 39.7392], zoom: 15 }));
    await page.waitForFunction(() => App.map.queryRenderedFeatures({ layers: [App.geoPackageImports()[0].layers[0].layerIds[0]] }).length > 0, { timeout: 10000 });
    const pt = await page.evaluate(() => {
      const p = App.map.project([-104.9903 + 0.02, 39.7392]);
      const r = App.map.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.click(pt.x, pt.y);
    await page.locator(".gpkg-popup").waitFor({ state: "visible", timeout: 5000 });
    const popupText = await page.locator(".gpkg-popup").innerText();
    check("clicking a node shows its attributes", /nodes/.test(popupText) && /n2/.test(popupText) && /120/.test(popupText), popupText.replace(/\s+/g, " "));
    check("popup hides internal _gpkg fields", !/_gpkg/.test(popupText));

    // ---- Table viewer from the ⋯ menu ----
    const items = await rowMenu(page, "nodes");
    check("⋯ menu offers the attribute table and the non-spatial table",
      items.includes("View attribute table") && items.includes("View table: notes"), items.join(" | "));
    check("⋯ menu offers removing the whole file", items.includes("Remove all layers from sample.gpkg"), items.join(" | "));
    await clickMenuItem(page, "View attribute table");
    await page.locator(".gpkg-table-widget .gpkg-table tbody tr").first().waitFor({ state: "visible", timeout: 5000 });
    const nRows = await page.locator(".gpkg-table-widget .gpkg-table tbody tr").count();
    check("table viewer lists all node rows", nRows === 5, "rows=" + nRows);
    await page.locator(".gpkg-table-filter").fill("n3");
    const filtered = await page.locator(".gpkg-table-widget .gpkg-table tbody tr").count();
    check("table filter narrows rows", filtered === 1, "rows=" + filtered);
    await page.locator(".gpkg-table-widget .gpkg-table tbody tr").first().click();
    await page.waitForFunction(() => {
      const c = App.map.getCenter();
      return Math.abs(c.lng - (-104.9903 + 0.03)) < 0.01;
    }, { timeout: 5000 }).then(() => check("clicking a row zooms to that feature", true))
      .catch(async () => check("clicking a row zooms to that feature", false, JSON.stringify(await page.evaluate(() => App.map.getCenter()))));
    await page.waitForTimeout(700);
    const padding = await page.evaluate(() => App.map.getPadding());
    check("camera padding is reset after the row zoom", padding.top === 0 && padding.bottom === 0, JSON.stringify(padding));
    const notes = await page.evaluate(async () => {
      await App.openGeoPackageTable(App.geoPackageImports()[0].id, "notes");
      return Array.from(document.querySelectorAll(".gpkg-table-widget tbody tr")).map((r) => r.innerText);
    });
    check("non-spatial table opens in the viewer", notes.length === 2 && /verified/.test(notes[0]), JSON.stringify(notes));

    // ---- Remove one layer, then the rest of the file ----
    await page.keyboard.press("Escape");
    await rowMenu(page, "edges");
    await clickMenuItem(page, "Remove layer");
    await page.waitForFunction(() => App.geoPackageImports()[0].layers.length === 2, { timeout: 5000 });
    const afterOne = await page.evaluate(() => ({
      edgesOnMap: App.map.getStyle().layers.some((l) => /edges/.test(l.id)),
      sources: Object.keys(App.map.getStyle().sources).filter((s) => /^gpkg-/.test(s))
    }));
    check("Remove layer drops only that layer and its source", !afterOne.edgesOnMap && afterOne.sources.length === 2, JSON.stringify(afterOne));
    check("removed layer leaves the Layers panel", !(await panelLabels(page)).includes("edges"));

    await rowMenu(page, "nodes");
    await clickMenuItem(page, "Remove all layers from sample.gpkg");
    await page.waitForFunction(() => App.geoPackageImports().length === 0, { timeout: 5000 });
    const leftover = await page.evaluate(() => App.map.getStyle().layers.filter((l) => /^gpkg-/.test(l.id)).length);
    check("Remove all layers from the file clears every layer", leftover === 0, "left=" + leftover);
    check("table viewer closes with the file", (await page.locator(".gpkg-table-widget").count()) === 0);

    // ---- Clear all removes imported layers too ----
    await page.setInputFiles("#fp-import-file", file);
    await page.waitForFunction("App.geoPackageImports().length === 1", { timeout: 20000 });
    await page.locator("#clear").click();
    await page.waitForFunction(() => App.geoPackageImports().length === 0, { timeout: 5000 })
      .then(() => check("Clear all removes GeoPackage layers", true))
      .catch(() => check("Clear all removes GeoPackage layers", false));
    const leftover2 = await page.evaluate(() => App.map.getStyle().layers.filter((l) => /^gpkg-/.test(l.id)).length);
    check("no gpkg map layers remain after Clear all", leftover2 === 0, "left=" + leftover2);

    // ---- A file that is not a GeoPackage fails cleanly ----
    dialogs.length = 0;
    await page.setInputFiles("#fp-import-file", { name: "broken.gpkg", mimeType: "application/octet-stream", buffer: Buffer.from("not a database at all") });
    await page.waitForFunction(() => /Could not open broken\.gpkg/.test((document.getElementById("status") || {}).textContent || ""), { timeout: 10000 })
      .catch(() => {});
    check("a non-GeoPackage file shows an error and adds nothing",
      dialogs.some((d) => /Could not open broken\.gpkg/.test(d)) && (await page.evaluate(() => App.geoPackageImports().length)) === 0,
      JSON.stringify(dialogs));

    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (err) {
    check("test ran to completion", false, err && err.stack ? err.stack.split("\n").slice(0, 3).join(" ") : String(err));
  } finally {
    if (browser) await browser.close();
    stopServer();
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? `FAIL — ${failed}/${results.length} checks failed` : `PASS — ${results.length}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
