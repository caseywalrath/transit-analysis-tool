// js/core/gpkg-import.js — read-only GeoPackage (.gpkg) viewer.
//
// Opens a GeoPackage with sql.js (SQLite compiled to WebAssembly, loaded from
// the CDN only the first time a .gpkg is opened — it is ~700 KB), decodes each
// vector table with window.GeoPackage, and draws it as a Reference / Imported
// layer in the Layers panel. Nothing becomes a drawn feature and nothing is
// saved with the session: these layers are for looking at someone else's
// output (e.g. a walkshed traced by another tool), not for editing.
//
// Exports: App.importGeoPackage(file), App.clearGeoPackages(),
// App.geoPackageImports() (read-only summary, used by tests),
// App.openGeoPackageTable(importId, tableName).

(function () {
  var App = window.App;

  // Pinned with the CDN rule in CLAUDE.md; the browser harness vendors both files.
  var SQLJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";
  var SQLJS_SCRIPT = SQLJS_BASE + "sql-wasm.js";

  var MAX_FILE_BYTES = 200 * 1024 * 1024;  // sql.js holds the whole file in memory
  var WARN_FILE_BYTES = 50 * 1024 * 1024;
  var MAX_FEATURES_PER_TABLE = 250000;
  var MAX_ATTRIBUTE_ROWS = 20000;          // non-spatial tables, table viewer only
  var TABLE_VIEW_ROWS = 500;               // rows the table viewer renders at once

  // Data encodings (exempt from chrome tokens). Layers with a time/cost field
  // run near → far as green → red, matching the walkshed reading.
  var RAMP = ["#1a9850", "#91cf60", "#fee08b", "#fc8d59", "#d73027"];
  var NO_VALUE_COLOR = "#9aa0a6";
  var SOLID = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2"];

  var _sqlPromise = null;
  var _imports = [];        // [{ id, fileName, layers: [...], tables: [...] }]
  var _seq = 0;
  var _solidIdx = 0;
  var _popup = null;
  var _clickWired = false;
  var TABLE_WIDGET_ID = "gpkg-table";

  // ---- sql.js loading ----

  function loadSqlJs() {
    if (_sqlPromise) return _sqlPromise;
    _sqlPromise = new Promise(function (resolve, reject) {
      if (typeof window.initSqlJs === "function") return resolve();
      var s = document.createElement("script");
      s.src = SQLJS_SCRIPT;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        reject(new Error("Could not load the GeoPackage reader. Check your internet connection and try again."));
      };
      document.head.appendChild(s);
    }).then(function () {
      return window.initSqlJs({ locateFile: function (f) { return SQLJS_BASE + f; } });
    });
    // A failed load must not stick — let the next attempt retry.
    _sqlPromise.catch(function () { _sqlPromise = null; });
    return _sqlPromise;
  }

  // ---- Reading ----

  function queryAll(db, sql, params, limit) {
    var stmt = db.prepare(sql);
    var rows = [];
    try {
      if (params) stmt.bind(params);
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
        if (limit && rows.length >= limit) break;
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  function tableColumns(db, table) {
    return queryAll(db, 'PRAGMA table_info("' + table.replace(/"/g, '""') + '")')
      .map(function (r) { return r.name; });
  }

  function countRows(db, table) {
    var r = queryAll(db, 'SELECT COUNT(*) AS n FROM "' + table.replace(/"/g, '""') + '"');
    return r.length ? Number(r[0].n) : 0;
  }

  function cleanValue(v) {
    if (v instanceof Uint8Array) return window.GeoPackage.formatValue(v);
    return v;
  }

  // Parse the whole file into plain JS (the database is closed before any map
  // work starts). Returns { tables: [...], skipped: [{ name, reason }] }.
  function readGeoPackage(SQL, bytes) {
    var GP = window.GeoPackage;
    var db = new SQL.Database(bytes);
    try {
      var contents;
      try {
        contents = queryAll(db, "SELECT table_name, data_type, identifier FROM gpkg_contents");
      } catch (e) {
        throw new Error("This file is not a GeoPackage (it has no gpkg_contents table).");
      }
      var geomCols = {};
      try {
        queryAll(db, "SELECT table_name, column_name, geometry_type_name, srs_id FROM gpkg_geometry_columns")
          .forEach(function (r) { geomCols[r.table_name] = r; });
      } catch (e) { /* attributes-only package */ }
      var srsById = {};
      try {
        queryAll(db, "SELECT srs_id, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys")
          .forEach(function (r) {
            srsById[r.srs_id] = { srsId: Number(r.srs_id), organization: r.organization,
                                  organizationCoordsysId: r.organization_coordsys_id };
          });
      } catch (e) { /* missing SRS table — only srs_id 0 is accepted below */ }

      var tables = [], skipped = [];
      contents.forEach(function (c) {
        var name = c.table_name;
        var kind = String(c.data_type || "").toLowerCase();
        if (kind === "features" && geomCols[name]) {
          var gc = geomCols[name];
          var srs = srsById[gc.srs_id] || (Number(gc.srs_id) === 0 ? { srsId: 0 } : null);
          if (!GP.isLonLatSrs(srs)) {
            var srsLabel = srs && srs.organization ? srs.organization + ":" + srs.organizationCoordsysId : "srs_id " + gc.srs_id;
            skipped.push({ name: name, reason: "uses " + srsLabel + "; only longitude/latitude (EPSG:4326) layers can be shown" });
            return;
          }
          tables.push(readFeatureTable(db, name, gc.column_name, skipped));
        } else if (kind === "attributes" || (kind === "features" && !geomCols[name])) {
          var cols = tableColumns(db, name);
          var total = countRows(db, name);
          var rows = queryAll(db, 'SELECT * FROM "' + name.replace(/"/g, '""') + '"', null, MAX_ATTRIBUTE_ROWS)
            .map(function (r) { var o = {}; cols.forEach(function (k) { o[k] = cleanValue(r[k]); }); return o; });
          tables.push({ name: name, spatial: false, columns: cols, rows: rows, total: total });
        } else {
          skipped.push({ name: name, reason: kind === "tiles" ? "raster tiles are not supported" : "unsupported table type \"" + kind + "\"" });
        }
      });
      return { tables: tables.filter(Boolean), skipped: skipped };
    } finally {
      db.close();
    }
  }

  function readFeatureTable(db, name, geomColumn, skipped) {
    var GP = window.GeoPackage;
    var allCols = tableColumns(db, name);
    var cols = allCols.filter(function (c) { return c !== geomColumn; });
    var total = countRows(db, name);
    var raw = queryAll(db, 'SELECT * FROM "' + name.replace(/"/g, '""') + '"', null, MAX_FEATURES_PER_TABLE);
    var rows = [], features = { point: [], line: [], polygon: [] };
    var bad = 0, empty = 0;
    raw.forEach(function (r) {
      var props = {};
      cols.forEach(function (k) { props[k] = cleanValue(r[k]); });
      var rowIdx = rows.length;
      rows.push(props);
      var cell = r[geomColumn];
      if (!cell) { empty++; return; }
      var parsed;
      try { parsed = GP.parseGeometry(cell); } catch (e) { bad++; return; }
      if (!parsed.geometry) { empty++; return; }
      GP.flattenGeometry(parsed.geometry).forEach(function (g) {
        var k = GP.geometryKind(g);
        if (!k) return;
        var p = Object.assign({}, props, { _gpkgRow: rowIdx });
        features[k].push({ type: "Feature", geometry: g, properties: p });
      });
    });
    if (bad) skipped.push({ name: name, reason: bad + " geometr" + (bad === 1 ? "y" : "ies") + " could not be read" });
    return { name: name, spatial: true, columns: cols, rows: rows, total: total,
             features: features, emptyCount: empty, truncated: total > raw.length };
  }

  // ---- Map layers ----

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "layer";
  }

  // Lowest drawn-feature layer, so imported layers sit under everything the
  // user draws (same rule as the GTFS and walk-network reference layers).
  function firstUserLayer() {
    var map = App.map;
    var candidates = ["polygons-fill", "buffers-fill", "line-buffers-fill", "route-buffers-fill",
                      "lines-layer", "routes-layer", "points-layer"];
    var ids = map.getStyle().layers.map(function (l) { return l.id; });
    var best = -1;
    candidates.forEach(function (c) {
      var i = ids.indexOf(c);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    });
    return best >= 0 ? ids[best] : undefined;
  }

  function colorExpr(colorInfo, solid) {
    if (!colorInfo) return solid;
    var lo = colorInfo.min, hi = colorInfo.max;
    var value = ["get", "_gpkgColor"];
    var ramp;
    if (hi <= lo) {
      ramp = RAMP[0];
    } else {
      ramp = ["interpolate", ["linear"], value];
      RAMP.forEach(function (c, i) { ramp.push(lo + (hi - lo) * i / (RAMP.length - 1), c); });
    }
    return ["case", ["==", ["typeof", value], "number"], ramp, NO_VALUE_COLOR];
  }

  function addLayerToMap(layer) {
    var map = App.map;
    var fc = { type: "FeatureCollection", features: layer.features };
    map.addSource(layer.sourceId, { type: "geojson", data: fc });
    var before = firstUserLayer();
    var color = colorExpr(layer.color, layer.solid);
    if (layer.kind === "point") {
      map.addLayer({ id: layer.layerIds[0], type: "circle", source: layer.sourceId, paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 4.5, 18, 7],
        "circle-color": color,
        "circle-stroke-width": 0.8,
        "circle-stroke-color": "#ffffff",
        "circle-opacity": 0.9,
        "circle-stroke-opacity": 0.9
      } }, before);
    } else if (layer.kind === "line") {
      map.addLayer({ id: layer.layerIds[0], type: "line", source: layer.sourceId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 15, 3, 18, 5],
          "line-opacity": 0.9
        } }, before);
    } else {
      map.addLayer({ id: layer.layerIds[0], type: "fill", source: layer.sourceId, paint: {
        "fill-color": color, "fill-opacity": 0.35
      } }, before);
      map.addLayer({ id: layer.layerIds[1], type: "line", source: layer.sourceId, paint: {
        "line-color": color, "line-width": 1.5, "line-opacity": 0.9
      } }, before);
    }
    layer.layerIds.forEach(function (id) {
      map.on("mouseenter", id, onEnter);
      map.on("mouseleave", id, onLeave);
    });
  }

  function removeLayerFromMap(layer) {
    var map = App.map;
    if (!map) return;
    layer.layerIds.forEach(function (id) {
      map.off("mouseenter", id, onEnter);
      map.off("mouseleave", id, onLeave);
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(layer.sourceId)) map.removeSource(layer.sourceId);
  }

  function onEnter() { if (!App.drawMode) App.map.getCanvas().style.cursor = "pointer"; }
  function onLeave() { App.map.getCanvas().style.cursor = App.drawMode ? "crosshair" : ""; }

  function allLayerIds() {
    var ids = [];
    _imports.forEach(function (imp) {
      imp.layers.forEach(function (l) { ids = ids.concat(l.layerIds); });
    });
    return ids;
  }

  function findLayerById(layerId) {
    for (var i = 0; i < _imports.length; i++) {
      for (var j = 0; j < _imports[i].layers.length; j++) {
        var l = _imports[i].layers[j];
        if (l.layerIds.indexOf(layerId) >= 0) return { imp: _imports[i], layer: l };
      }
    }
    return null;
  }

  // ---- Click popup ----

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function propsTableHTML(table, row) {
    var html = '<table class="gpkg-props">';
    table.columns.forEach(function (c) {
      html += "<tr><th>" + esc(c) + "</th><td>" + esc(window.GeoPackage.formatValue(row[c])) + "</td></tr>";
    });
    return html + "</table>";
  }

  function wireClick() {
    if (_clickWired) return;
    _clickWired = true;
    App.map.on("click", function (e) {
      if (App.drawMode) return;
      var ids = allLayerIds().filter(function (id) {
        return App.map.getLayer(id) && App.map.getLayoutProperty(id, "visibility") !== "none";
      });
      if (!ids.length) return;
      var T = 5;
      var box = [[e.point.x - T, e.point.y - T], [e.point.x + T, e.point.y + T]];
      var hits = App.map.queryRenderedFeatures(box, { layers: ids });
      if (!hits.length) return;
      // One entry per source row (a polygon's fill and outline both hit), max 3.
      var seen = {}, items = [];
      hits.forEach(function (f) {
        var found = findLayerById(f.layer.id);
        if (!found) return;
        var key = found.layer.sourceId + ":" + f.properties._gpkgRow;
        if (seen[key] || items.length >= 3) return;
        seen[key] = 1;
        items.push({ found: found, row: f.properties._gpkgRow });
      });
      if (!items.length) return;
      showPopup(e.lngLat, items, hits.length);
    });
  }

  function showPopup(lngLat, items, hitCount) {
    if (!_popup) _popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "340px", className: "gpkg-popup" });
    var html = "";
    items.forEach(function (it) {
      var table = it.found.layer.table;
      var row = table.rows[it.row] || {};
      html += '<div class="gpkg-popup-item"><div class="gpkg-popup-title">' + esc(table.name) +
              '<span class="gpkg-popup-sub"> row ' + (it.row + 1) + "</span></div>" + propsTableHTML(table, row) + "</div>";
    });
    if (hitCount > items.length) {
      html += '<div class="gpkg-popup-more">More features overlap here — zoom in to pick one.</div>';
    }
    _popup.setLngLat(lngLat).setHTML(html).addTo(App.map);
  }

  // ---- Table viewer ----

  function findTable(importId, tableName) {
    var imp = _imports.filter(function (i) { return i.id === importId; })[0];
    if (!imp) return null;
    var t = imp.tables.filter(function (x) { return x.name === tableName; })[0];
    return t ? { imp: imp, table: t } : null;
  }

  // Zoom to a feature row of a spatial table and show its popup.
  function zoomToRow(imp, table, rowIdx) {
    var feats = [];
    imp.layers.forEach(function (l) {
      if (l.table !== table) return;
      l.features.forEach(function (f) { if (f.properties._gpkgRow === rowIdx) feats.push(f); });
    });
    if (!feats.length || typeof turf === "undefined") {
      App.setStatus("That row has no geometry to zoom to.");
      return;
    }
    var bb = turf.bbox({ type: "FeatureCollection", features: feats });
    var center = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    // Keep the target (and its popup) clear of the table viewer, which
    // floats over the bottom of the map.
    var w = document.querySelector('.floating-widget[data-widget-id="' + TABLE_WIDGET_ID + '"]');
    var mapH = App.map.getContainer().clientHeight;
    var bottom = w ? Math.min(w.offsetHeight + 40, Math.max(0, mapH - 260)) : 80;
    var padding = { top: 240, bottom: bottom, left: 80, right: 80 };
    if (bb[0] === bb[2] && bb[1] === bb[3]) {
      App.map.easeTo({ center: center, zoom: Math.max(App.map.getZoom(), 17), padding: padding, duration: 500 });
    } else {
      App.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: padding, maxZoom: 18, duration: 500 });
    }
    // fitBounds/easeTo padding persists on the camera; reset it once the move
    // ends so later zooms and the Layers panel's "Zoom to layer" are unaffected.
    App.map.once("moveend", function () { App.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); });
    var layerOfRow = imp.layers.filter(function (l) { return l.table === table; })[0];
    showPopup({ lng: center[0], lat: center[1] }, [{ found: { imp: imp, layer: layerOfRow }, row: rowIdx }], 1);
  }

  async function openTable(importId, tableName) {
    var hit = findTable(importId, tableName);
    if (!hit) return;
    var imp = hit.imp, table = hit.table;
    App.popup.removeFloatingWidget(TABLE_WIDGET_ID);
    await App.popup.showFloatingWidget(TABLE_WIDGET_ID, null, {
      position: "bottom-left", width: 560, title: esc(table.name + " — " + imp.fileName)
    });
    var widget = document.querySelector('.floating-widget[data-widget-id="' + TABLE_WIDGET_ID + '"]');
    if (!widget) return;
    widget.classList.add("gpkg-table-widget");
    var body = widget.querySelector(".floating-widget-body");
    body.innerHTML =
      '<div class="gpkg-table-tools">' +
        '<input type="search" class="gpkg-table-filter" placeholder="Filter rows (any column)" aria-label="Filter rows">' +
        '<span class="gpkg-table-count"></span>' +
      "</div>" +
      '<div class="gpkg-table-scroll"><table class="gpkg-table' + (table.spatial ? " gpkg-table-spatial" : "") + '"><thead></thead><tbody></tbody></table></div>' +
      (table.spatial ? '<div class="gpkg-table-hint">Click a row to zoom to it.</div>' : "");
    var thead = body.querySelector("thead"), tbody = body.querySelector("tbody");
    var countEl = body.querySelector(".gpkg-table-count");
    var filterEl = body.querySelector(".gpkg-table-filter");
    thead.innerHTML = "<tr><th>#</th>" + table.columns.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";

    var fmt = window.GeoPackage.formatValue;
    function draw() {
      var q = filterEl.value.trim().toLowerCase();
      var matches = [];
      for (var i = 0; i < table.rows.length; i++) {
        if (q) {
          var r = table.rows[i], ok = false;
          for (var c = 0; c < table.columns.length && !ok; c++) {
            if (fmt(r[table.columns[c]]).toLowerCase().indexOf(q) >= 0) ok = true;
          }
          if (!ok) continue;
        }
        matches.push(i);
      }
      var shown = matches.slice(0, TABLE_VIEW_ROWS);
      tbody.innerHTML = shown.map(function (i) {
        var r = table.rows[i];
        return '<tr data-row="' + i + '"><td>' + (i + 1) + "</td>" +
          table.columns.map(function (c) { return "<td>" + esc(fmt(r[c])) + "</td>"; }).join("") + "</tr>";
      }).join("");
      var note = matches.length.toLocaleString() + (q ? " matching" : "") + " row" + (matches.length === 1 ? "" : "s");
      if (shown.length < matches.length) note += " · showing first " + shown.length.toLocaleString();
      if (table.total > table.rows.length) note += " · file has " + table.total.toLocaleString() + ", only " + table.rows.length.toLocaleString() + " loaded";
      countEl.textContent = note;
    }
    filterEl.addEventListener("input", draw);
    // Keep typing in the filter from triggering map/app keyboard shortcuts.
    filterEl.addEventListener("keydown", function (e) { e.stopPropagation(); });
    if (table.spatial) {
      tbody.addEventListener("click", function (e) {
        var tr = e.target.closest("tr[data-row]");
        if (!tr) return;
        Array.prototype.forEach.call(tbody.querySelectorAll("tr.gpkg-row-active"), function (x) { x.classList.remove("gpkg-row-active"); });
        tr.classList.add("gpkg-row-active");
        zoomToRow(imp, table, Number(tr.getAttribute("data-row")));
      });
    }
    draw();
  }

  // ---- Layers panel registration ----

  function layerBadge(layer) {
    var n = layer.features.length;
    var title = n.toLocaleString() + " feature" + (n === 1 ? "" : "s") + " from " + layer.fileName;
    if (layer.color) {
      title += " · colored by " + layer.color.field + " (" + window.GeoPackage.formatValue(layer.color.min) +
               " green → " + window.GeoPackage.formatValue(layer.color.max) + " red; gray = no value)";
    }
    return { text: n.toLocaleString(), title: title };
  }

  function registerPanelEntry(imp, layer) {
    if (typeof App.registerReferenceLayer !== "function") return;
    var ops = layer.kind === "point" ? [{ id: layer.layerIds[0], op: "circle-opacity" }]
            : layer.kind === "line" ? [{ id: layer.layerIds[0], op: "line-opacity" }]
            : [{ id: layer.layerIds[0], op: "fill-opacity" }, { id: layer.layerIds[1], op: "line-opacity" }];
    var entry = {
      id: layer.layerIds[0],
      label: layer.label,
      layers: ops,
      clear: function () { removeLayer(imp.id, layer.layerIds[0]); },
      badge: function () { return layerBadge(layer); },
      menuItems: function () {
        var items = [{ label: "View attribute table", action: function () { openTable(imp.id, layer.table.name); } }];
        imp.tables.forEach(function (t) {
          if (!t.spatial) items.push({ label: "View table: " + t.name, action: function () { openTable(imp.id, t.name); } });
        });
        return items;
      }
    };
    if (imp.layers.length > 1) {
      entry.extraActions = [{ label: "Remove all layers from " + imp.fileName,
        status: "Removed " + imp.fileName, run: function () { removeImport(imp.id); } }];
    }
    App.registerReferenceLayer(entry);
  }

  // ---- Remove ----

  function removeLayer(importId, layerId) {
    var imp = _imports.filter(function (i) { return i.id === importId; })[0];
    if (!imp) return;
    imp.layers = imp.layers.filter(function (l) {
      if (l.layerIds[0] !== layerId) return true;
      removeLayerFromMap(l);
      if (typeof App.unregisterReferenceLayer === "function") App.unregisterReferenceLayer(l.layerIds[0]);
      return false;
    });
    if (!imp.layers.length) dropImport(imp);
    if (_popup) _popup.remove();
  }

  function removeImport(importId) {
    var imp = _imports.filter(function (i) { return i.id === importId; })[0];
    if (!imp) return;
    imp.layers.forEach(function (l) {
      removeLayerFromMap(l);
      if (typeof App.unregisterReferenceLayer === "function") App.unregisterReferenceLayer(l.layerIds[0]);
    });
    imp.layers = [];
    dropImport(imp);
    if (_popup) _popup.remove();
  }

  function dropImport(imp) {
    _imports = _imports.filter(function (i) { return i !== imp; });
    var w = document.querySelector('.floating-widget[data-widget-id="' + TABLE_WIDGET_ID + '"]');
    if (w && App.popup) App.popup.removeFloatingWidget(TABLE_WIDGET_ID);
  }

  function clearGeoPackages() {
    _imports.slice().forEach(function (imp) { removeImport(imp.id); });
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
  }

  // ---- Import entry point ----

  function readFileBytes(file) {
    if (typeof file.arrayBuffer === "function") {
      return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error || new Error("Could not read the file.")); };
      r.readAsArrayBuffer(file);
    });
  }

  async function importGeoPackage(file) {
    if (!file) return null;
    if (file.size > MAX_FILE_BYTES) {
      alert("This GeoPackage is " + Math.round(file.size / 1048576) + " MB. The browser viewer can open files up to " +
            Math.round(MAX_FILE_BYTES / 1048576) + " MB.");
      return null;
    }
    if (file.size > WARN_FILE_BYTES &&
        !confirm("This GeoPackage is " + Math.round(file.size / 1048576) + " MB. Large files may be slow to open. Continue?")) {
      return null;
    }
    App.setStatus("Opening " + file.name + "…");
    var parsed;
    try {
      var results = await Promise.all([loadSqlJs(), readFileBytes(file)]);
      parsed = readGeoPackage(results[0], results[1]);
    } catch (err) {
      App.setStatus("Could not open " + file.name);
      alert("Could not open " + file.name + ":\n" + (err && err.message ? err.message : err));
      return null;
    }

    var imp = { id: "gpkg" + (++_seq), fileName: file.name, layers: [], tables: parsed.tables };
    parsed.tables.forEach(function (t) {
      if (!t.spatial) return;
      var kinds = ["point", "line", "polygon"].filter(function (k) { return t.features[k].length > 0; });
      kinds.forEach(function (k) {
        var feats = t.features[k];
        var color = window.GeoPackage.pickColorField(t.columns, feats.map(function (f) { return f.properties; }));
        if (color) {
          feats.forEach(function (f) { f.properties._gpkgColor = window.GeoPackage.numericValue(f.properties[color.field]); });
        }
        var base = "gpkg-" + _seq + "-" + slug(t.name) + (kinds.length > 1 ? "-" + k : "");
        imp.layers.push({
          table: t, kind: k, features: feats, color: color, fileName: file.name,
          solid: SOLID[(_solidIdx++) % SOLID.length],
          label: t.name + (kinds.length > 1 ? " (" + k + "s)" : ""),
          sourceId: base + "-src",
          layerIds: k === "polygon" ? [base + "-fill", base + "-line"] : [base]
        });
      });
    });

    var bboxFeats = [];
    imp.layers.forEach(function (l) { bboxFeats = bboxFeats.concat(l.features); });
    var bb = (bboxFeats.length && typeof turf !== "undefined") ? turf.bbox({ type: "FeatureCollection", features: bboxFeats }) : null;
    if (bb && !window.GeoPackage.bboxLooksLonLat(bb)) {
      alert(file.name + " says it uses longitude/latitude, but its coordinates are outside that range. " +
            "It is probably in a projected coordinate system; re-export it as EPSG:4326 to view it here.");
      App.setStatus("Could not open " + file.name);
      return null;
    }

    if (!imp.layers.length && !imp.tables.length) {
      var why = parsed.skipped.map(function (s) { return "• " + s.name + ": " + s.reason; }).join("\n");
      alert(file.name + " has no layers this viewer can show." + (why ? "\n\n" + why : ""));
      App.setStatus("Nothing to show from " + file.name);
      return null;
    }

    _imports.push(imp);
    // Add in reverse so the file's first table ends up on top, like QGIS.
    imp.layers.slice().reverse().forEach(function (l) {
      addLayerToMap(l);
      registerPanelEntry(imp, l);
    });
    wireClick();

    if (bb) {
      if (bb[0] === bb[2] && bb[1] === bb[3]) {
        App.map.easeTo({ center: [bb[0], bb[1]], zoom: Math.max(App.map.getZoom(), 15), duration: 600 });
      } else {
        App.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 600 });
      }
    }

    // Make the result visible: switch the right panel to the Layers tab.
    var layersTab = document.querySelector('.fp-tab-btn[data-fptab="layers"]');
    if (layersTab && imp.layers.length) layersTab.click();
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
    if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();

    var nFeat = bboxFeats.length;
    var msg = "Opened " + file.name + ": " + imp.layers.length + " layer" + (imp.layers.length === 1 ? "" : "s") +
              ", " + nFeat.toLocaleString() + " feature" + (nFeat === 1 ? "" : "s");
    var tablesOnly = imp.tables.filter(function (t) { return !t.spatial; }).length;
    if (tablesOnly) msg += ", " + tablesOnly + " table" + (tablesOnly === 1 ? "" : "s") + " (open from a layer's ⋯ menu)";
    var emptyTables = imp.tables.filter(function (t) { return t.spatial && !t.features.point.length && !t.features.line.length && !t.features.polygon.length; });
    if (emptyTables.length) msg += "; empty: " + emptyTables.map(function (t) { return t.name; }).join(", ");
    if (parsed.skipped.length) msg += "; skipped: " + parsed.skipped.map(function (s) { return s.name; }).join(", ");
    App.setStatus(msg);
    if (parsed.skipped.length) {
      console.warn("GeoPackage: skipped tables", parsed.skipped);
    }
    if (!imp.layers.length && imp.tables.length) {
      // Attributes only: nothing for the Layers panel to host, so open the first table directly.
      openTable(imp.id, imp.tables[0].name);
    }
    return imp.id;
  }

  // Read-only summary for tests and debugging.
  function geoPackageImports() {
    return _imports.map(function (imp) {
      return {
        id: imp.id,
        fileName: imp.fileName,
        layers: imp.layers.map(function (l) {
          return { label: l.label, kind: l.kind, layerIds: l.layerIds.slice(), sourceId: l.sourceId,
                   featureCount: l.features.length, colorField: l.color ? l.color.field : null };
        }),
        tables: imp.tables.map(function (t) { return { name: t.name, spatial: t.spatial, rows: t.rows.length, total: t.total }; })
      };
    });
  }

  App.importGeoPackage = importGeoPackage;
  App.clearGeoPackages = clearGeoPackages;
  App.geoPackageImports = geoPackageImports;
  App.openGeoPackageTable = openTable;
})();
