// js/core/gpkg-layers.js
// GeoPackage loader: lazy-loads sql.js and proj4, opens a .gpkg with sql.js, and
// turns each feature table into WGS 84 GeoJSON through window.GpkgReader.
// The libraries are fetched only when a GeoPackage is opened, so users who never
// open one pay nothing at startup. Format and projection rules:
// docs/gpkg-import-plan.md, "Reading a GeoPackage" and "Projection resolution".
// Nothing here touches the DOM beyond injecting the two library script tags, and
// GpkgReader is referenced only inside functions so the file loads on its own.

(function () {
  "use strict";
  var App = window.App;

  var SQL_JS_BASE = "https://unpkg.com/sql.js@1.10.3/dist/";
  var SQL_JS_URL = SQL_JS_BASE + "sql-wasm.js";
  var PROJ4_URL = "https://unpkg.com/proj4@2.11.0/dist/proj4.js";

  var LIBS_ERROR = "Could not load the GeoPackage reader. Check your internet connection and try again.";
  var NOT_GPKG = "This file is not a GeoPackage.";

  // Set only after a successful load. A failed attempt leaves it null so the
  // next open tries again instead of reusing a broken library handle.
  var _libsCache = null;
  // Shares one in-flight load between callers, so two opens made close together
  // do not inject the scripts twice.
  var _libsPending = null;

  // Quotes a SQL identifier. Table names come from the file itself, so a double
  // quote inside a name is doubled rather than trusted to be absent.
  function _q(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  // Runs a query and returns its rows as objects keyed by column name. Values
  // are bound, never concatenated into the SQL, and the statement is always freed.
  function _query(db, sql, params) {
    var stmt = db.prepare(sql);
    var out = [];
    try {
      if (params && params.length) stmt.bind(params);
      while (stmt.step()) out.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return out;
  }

  function _loadScript(src) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement("script");
      tag.src = src;
      tag.onload = function () { resolve(); };
      tag.onerror = function () { reject(new Error(LIBS_ERROR)); };
      document.head.appendChild(tag);
    });
  }

  // Injects only the libraries that are missing, so a second load after a
  // successful one adds no duplicate tags.
  function _fetchLibs() {
    var steps = Promise.resolve();
    if (typeof window.initSqlJs !== "function") {
      steps = steps.then(function () { return _loadScript(SQL_JS_URL); });
    }
    if (typeof window.proj4 !== "function") {
      steps = steps.then(function () { return _loadScript(PROJ4_URL); });
    }
    return steps.then(function () {
      // A script can finish loading and still leave its global undefined (a
      // replaced or blocked file). That counts as a failed load.
      if (typeof window.initSqlJs !== "function" || typeof window.proj4 !== "function") {
        throw new Error(LIBS_ERROR);
      }
      return _fetchWasm();
    }).then(function (wasmBinary) {
      return window.initSqlJs({
        wasmBinary: wasmBinary,
        locateFile: function (f) { return SQL_JS_BASE + f; }
      });
    }).then(function (SQL) {
      return { SQL: SQL, proj4: window.proj4 };
    });
  }

  // sql.js's own WASM fetch drops a network error and never settles, so the
  // bytes are fetched here, where a failure rejects and the loader can report it.
  function _fetchWasm() {
    return fetch(SQL_JS_BASE + "sql-wasm.wasm").then(function (res) {
      if (!res.ok) throw new Error(LIBS_ERROR);
      return res.arrayBuffer();
    });
  }

  // Resolves { SQL, proj4 }. Any failure, including sql.js rejecting its WASM
  // load, becomes the same user-facing message.
  function _loadLibs() {
    if (_libsCache) return Promise.resolve(_libsCache);
    if (_libsPending) return _libsPending;
    _libsPending = _fetchLibs().then(function (libs) {
      _libsCache = libs;
      _libsPending = null;
      return libs;
    }, function () {
      _libsCache = null;
      _libsPending = null;
      // sql.js caches its first init promise globally, so a failed WASM fetch
      // would otherwise fail every later attempt in the same page.
      try { window.initSqlJsPromise = undefined; } catch (e) { /* read-only global: nothing to reset */ }
      throw new Error(LIBS_ERROR);
    });
    return _libsPending;
  }

  // Opens the file bytes and checks for a gpkg_contents table. On any failure the
  // database is closed here, since the caller never receives it.
  function _openDb(libs, arrayBuffer) {
    var db = null;
    try {
      db = new libs.SQL.Database(new Uint8Array(arrayBuffer));
      var found = _query(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = ?", ["gpkg_contents"]);
      if (!found.length || !found[0].n) throw new Error(NOT_GPKG);
    } catch (e) {
      if (db) {
        try { db.close(); } catch (closeErr) { /* the handle is already unusable */ }
      }
      throw new Error(NOT_GPKG);
    }
    return db;
  }

  // SQLite identifiers are case-insensitive, so the lookup must be too.
  function _tableExists(db, name) {
    var rows = _query(db,
      "SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE", [name]);
    return rows[0].n > 0;
  }

  function _isNum(v) {
    return typeof v === "number";
  }

  // A [lon, lat] pair with finite numbers inside the WGS 84 ranges.
  function _lonLatOk(p) {
    if (!p || typeof p[0] !== "number" || typeof p[1] !== "number") return false;
    if (!isFinite(p[0]) || !isFinite(p[1])) return false;
    return p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
  }

  // A proj4 definition is usable when it converts the envelope corners to lon/lat.
  // With no envelope, one transform of [0, 0] still shows proj4 accepts the
  // definition; a definition proj4 cannot parse throws.
  // GeoPackage geometries are always stored x = easting/longitude, y =
  // northing/latitude, whatever the CRS's official axis order. proj4 honors
  // AXIS clauses in WKT and would swap x/y for a north-first CRS, so they are
  // stripped. The swapped result can still land inside the lon/lat ranges, so
  // the corner check below would not catch it.
  function _projDef(projection) {
    if (projection.kind !== "wkt") return projection.def;
    return String(projection.def).replace(/,\s*AXIS\s*\[[^\]]*\]/gi, "");
  }

  function _wktAccepted(libs, projection, envelope) {
    try {
      var converter = libs.proj4(_projDef(projection), "EPSG:4326");
      if (!envelope) {
        converter.forward([0, 0]);
        return true;
      }
      var corners = [
        [envelope.minX, envelope.minY], [envelope.maxX, envelope.minY],
        [envelope.maxX, envelope.maxY], [envelope.minX, envelope.maxY]
      ];
      for (var i = 0; i < corners.length; i++) {
        if (!_lonLatOk(converter.forward(corners[i]))) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // One feature table's status. Every failure reason is decided here so the
  // picker can show it verbatim.
  function _inspectRow(libs, db, r) {
    var layer = {
      table: r.table_name, geomColumn: null, geomType: null, srsRow: null,
      envelope: null, projection: null, count: 0, supported: false, reason: null
    };
    if (r.data_type === "tiles") {
      layer.reason = "Raster tiles are not supported";
      return layer;
    }
    if (r.data_type !== "features") {
      layer.reason = "Table has no geometry";
      return layer;
    }
    if (r.column_name === null || r.column_name === undefined) {
      layer.reason = "Missing geometry column information";
      return layer;
    }
    layer.geomColumn = r.column_name;
    layer.geomType = r.geometry_type_name;
    if (!_tableExists(db, r.table_name)) {
      layer.reason = "Table is missing from the file";
      return layer;
    }

    // A missing srs row is passed to resolveProjection as null, which it handles.
    // Broken files can lack the whole srs table, so it is queried only when present.
    layer.srsRow = null;
    if (_tableExists(db, "gpkg_spatial_ref_sys")) {
      var srsRows = _query(db, "SELECT * FROM gpkg_spatial_ref_sys WHERE srs_id = ?", [r.srs_id]);
      layer.srsRow = srsRows.length ? srsRows[0] : null;
    }

    if (_isNum(r.min_x) && _isNum(r.min_y) && _isNum(r.max_x) && _isNum(r.max_y)) {
      layer.envelope = { minX: r.min_x, minY: r.min_y, maxX: r.max_x, maxY: r.max_y };
    }
    layer.projection = window.GpkgReader.resolveProjection(layer.srsRow, layer.envelope);

    var proj = layer.projection;
    if (proj.kind === "unsupported") {
      layer.reason = proj.error;
      return layer;
    }
    if (proj.kind === "wkt" && !_wktAccepted(libs, proj, layer.envelope)) {
      layer.reason = "Unknown projection (" + proj.label.replace(" (from file)", "") + ")";
      return layer;
    }

    layer.count = _query(db, "SELECT count(*) AS n FROM " + _q(r.table_name), [])[0].n;
    layer.supported = true;
    return layer;
  }

  // Lists every gpkg_contents row, ordered by table name, with feature tables
  // joined to their geometry column. Synchronous: sql.js is synchronous.
  // A valid file may omit gpkg_geometry_columns (tiles-only or attributes-only),
  // so without it the geometry fields are NULL rather than a failed query.
  // One layer that throws is reported as unsupported and never aborts the file.
  function _inspect(libs, db) {
    var sql;
    if (_tableExists(db, "gpkg_geometry_columns")) {
      sql = "SELECT c.table_name AS table_name, c.data_type AS data_type, " +
        "c.min_x AS min_x, c.min_y AS min_y, c.max_x AS max_x, c.max_y AS max_y, " +
        "g.column_name AS column_name, g.geometry_type_name AS geometry_type_name, " +
        "g.srs_id AS srs_id " +
        "FROM gpkg_contents c LEFT JOIN gpkg_geometry_columns g ON g.table_name = c.table_name COLLATE NOCASE " +
        "ORDER BY c.table_name";
    } else {
      sql = "SELECT c.table_name AS table_name, c.data_type AS data_type, " +
        "c.min_x AS min_x, c.min_y AS min_y, c.max_x AS max_x, c.max_y AS max_y, " +
        "NULL AS column_name, NULL AS geometry_type_name, NULL AS srs_id " +
        "FROM gpkg_contents c ORDER BY c.table_name";
    }
    var rows = _query(db, sql, []);
    var layers = [];
    for (var i = 0; i < rows.length; i++) {
      try {
        layers.push(_inspectRow(libs, db, rows[i]));
      } catch (e) {
        layers.push({
          table: rows[i].table_name, geomColumn: null, geomType: null, srsRow: null,
          envelope: null, projection: null, count: 0, supported: false,
          reason: "Could not read this layer (" + e.message + ")"
        });
      }
    }
    return { layers: layers };
  }

  // True when every ring or line in the list has at least minPoints points and
  // all its points are valid lon/lat. An empty list is not drawable.
  function _chainsOk(chains, minPoints) {
    if (!chains.length) return false;
    for (var i = 0; i < chains.length; i++) {
      if (chains[i].length < minPoints) return false;
      for (var j = 0; j < chains[i].length; j++) {
        if (!_lonLatOk(chains[i][j])) return false;
      }
    }
    return true;
  }

  // Rejects anything MapLibre would choke on or that is too small to draw: a
  // coordinate that is not a finite lon/lat pair, a ring under 4 points, or a
  // line under 2 points. Walks every coordinate once.
  function _geometryIsDrawable(g) {
    if (!g || !g.coordinates) return false;
    var c = g.coordinates;
    if (g.type === "Point") return _lonLatOk(c);
    if (g.type === "MultiPoint") return _chainsOk([c], 1);
    if (g.type === "LineString") return _chainsOk([c], 2);
    if (g.type === "MultiLineString") return _chainsOk(c, 2);
    if (g.type === "Polygon") return _chainsOk(c, 4);
    if (g.type === "MultiPolygon") {
      if (!c.length) return false;
      for (var i = 0; i < c.length; i++) {
        if (!_chainsOk(c[i], 4)) return false;
      }
      return true;
    }
    return false;
  }

  // Converts one row to a feature, or returns null and counts why it was dropped.
  // A row that throws anywhere (bad blob, transform failure) is counted as invalid
  // and never stops the layer.
  // Only an integer key can become feature.id. A text key stays in the attributes,
  // and a non-finite number is rejected because it cannot serve as a stable id.
  function _isIntegerKey(v) {
    return typeof v === "number" && isFinite(v) && Math.floor(v) === v;
  }

  // columns has the key flagged pk and is used when the key becomes the id;
  // attrColumns has no pk flags and is used otherwise, so the key stays visible.
  function _featureFromRow(columns, attrColumns, values, geomIdx, pkIdx, rowIndex, fn, skipped) {
    var gv = geomIdx >= 0 ? values[geomIdx] : null;
    if (gv === null || gv === undefined) {
      skipped.nullGeom++;
      return null;
    }
    var parsed;
    try {
      parsed = window.GpkgReader.parseGeometryBlob(gv);
    } catch (e) {
      skipped.invalid++;
      return null;
    }
    if (parsed.empty) { skipped.empty++; return null; }
    if (parsed.skipped === "collection") { skipped.collection++; return null; }
    if (parsed.skipped === "unsupported") { skipped.unsupported++; return null; }

    var geometry;
    try {
      geometry = window.GpkgReader.transformGeometry(parsed.geometry, fn);
    } catch (e) {
      skipped.invalid++;
      return null;
    }
    if (!_geometryIsDrawable(geometry)) {
      skipped.invalid++;
      return null;
    }

    var keyIsId = pkIdx >= 0 && _isIntegerKey(values[pkIdx]);
    return {
      type: "Feature",
      id: keyIsId ? values[pkIdx] : rowIndex,
      geometry: geometry,
      properties: window.GpkgReader.rowToProperties(keyIsId ? columns : attrColumns, values)
    };
  }

  // Reads one feature table into a WGS 84 FeatureCollection. Synchronous. The
  // table is walked row by row with a prepared statement; db is not closed here.
  // onProgress(done, total) is optional: it runs every 1,000 rows and once at the end.
  function _readLayer(libs, db, layer, onProgress) {
    if (!layer.supported) throw new Error("Layer is not supported (" + layer.reason + ")");

    var raw = _query(db, "PRAGMA table_info(" + _q(layer.table) + ")", []);
    var columns = [];
    var attrColumns = [];
    var geomIdx = -1;
    var pkCount = 0;
    var pkCandidate = -1;
    // SQLite identifiers are case-insensitive, so the geometry column matches that way too.
    var wantGeom = String(layer.geomColumn).toLowerCase();
    for (var i = 0; i < raw.length; i++) {
      var name = raw[i].name;
      var isGeom = String(name).toLowerCase() === wantGeom;
      columns.push({ name: name, type: raw[i].type, pk: false, isGeom: isGeom });
      attrColumns.push({ name: name, type: raw[i].type, pk: false, isGeom: isGeom });
      if (isGeom && geomIdx < 0) geomIdx = i;
      if (raw[i].pk > 0) { pkCount++; pkCandidate = i; }
    }
    // A composite key (two or more pk columns) has no single id, so every key
    // column stays in the attributes and rows are numbered by position instead.
    var pkIdx = pkCount === 1 ? pkCandidate : -1;
    if (pkIdx >= 0) columns[pkIdx].pk = true;

    // The converter is built once per layer. A definition proj4 cannot parse
    // stops the layer here, before any statement is prepared.
    var fn;
    if (layer.projection.kind === "none") {
      fn = function (c) { return [c[0], c[1]]; };
    } else {
      var converter;
      try {
        converter = libs.proj4(_projDef(layer.projection), "EPSG:4326");
      } catch (e) {
        throw new Error("Unknown projection (" + layer.projection.label.replace(" (from file)", "") + ")");
      }
      fn = function (c) { return converter.forward(c); };
    }

    // The row count was taken during inspection, so the table is not counted twice.
    var total = layer.count;
    var skipped = { empty: 0, nullGeom: 0, collection: 0, unsupported: 0, invalid: 0 };
    var features = [];
    var stmt = db.prepare("SELECT * FROM " + _q(layer.table));
    try {
      var rowIndex = 0;
      while (stmt.step()) {
        var feature = _featureFromRow(columns, attrColumns, stmt.get(), geomIdx, pkIdx, rowIndex, fn, skipped);
        if (feature) features.push(feature);
        rowIndex++;
        if (onProgress && rowIndex % 1000 === 0) onProgress(rowIndex, total);
      }
    } finally {
      stmt.free();
    }
    if (onProgress) onProgress(total, total);

    return {
      featureCollection: { type: "FeatureCollection", features: features },
      skipped: skipped
    };
  }

  // ---- Map layers and registry ------------------------------------------
  // Each imported GeoPackage layer is one GeoJSON source plus one MapLibre
  // layer per geometry kind present, drawn below the drawn-feature layers.
  // They are reference layers: never part of App.points/lines/routes/polygons,
  // never hit-tested by the drawn-feature helpers, never in session JSON.

  // Distinct, mid-saturation colors that read on both light and dark basemaps.
  var COLORS = ["#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#2563eb", "#dc2626", "#0d9488"];

  // The fill's transparency lives in its color, not in fill-opacity: the
  // Layers panel's one opacity slider writes the same value to every layer of
  // a row, so fill-opacity and the outline's line-opacity must both start at 1
  // for 100% to mean "as imported".
  var FILL_ALPHA = 0.35;

  var _registry = [];   // in import order
  var _counter = 0;     // per page load, so ids are never reused within a session

  function _nextColor() {
    var used = {};
    _registry.forEach(function (r) { used[r.color] = true; });
    for (var i = 0; i < COLORS.length; i++) if (!used[COLORS[i]]) return COLORS[i];
    return COLORS[_registry.length % COLORS.length];
  }

  function _geomKinds(fc) {
    var k = { polygon: false, line: false, point: false };
    for (var i = 0; i < fc.features.length; i++) {
      var t = fc.features[i].geometry.type;
      if (t === "Polygon" || t === "MultiPolygon") k.polygon = true;
      else if (t === "LineString" || t === "MultiLineString") k.line = true;
      else k.point = true;
    }
    return k;
  }

  function _styleKey(id) { return "gpkg-" + id; }

  // The color drawer writes App.layerStyles[styleKey] through App.setLayerStyle;
  // this repainter is the only place that turns it into paint properties.
  function _repaint(rec) {
    var map = App.map;
    var colors = App.resolveLayerColors(rec.styleKey);
    var c = (colors && colors[0]) || rec.color;
    rec.layers.forEach(function (L) {
      if (!map.getLayer(L.id)) return;
      if (L.kind === "fill") map.setPaintProperty(L.id, "fill-color", window.LayerPalette.withAlpha(c, FILL_ALPHA));
      else if (L.kind === "outline" || L.kind === "line") map.setPaintProperty(L.id, "line-color", c);
      else map.setPaintProperty(L.id, "circle-color", c);
    });
  }

  // Adds one layer's features to the map and the registry. Returns the import
  // id, or null when the collection has no features.
  // meta: { fileName, layerName, color? }. Layers are added bottom-to-top
  // (fill, outline, line, point), each directly below the drawn features, so
  // the first one is the lowest: applyBandOrder in layers-panel.js relies on that.
  function _addLayerToMap(featureCollection, meta) {
    // Nothing drawable (every row empty, NULL or skipped): no source, no
    // registry entry, so no invisible import the panel cannot show or remove.
    if (!featureCollection.features.length) return null;
    var map = App.map;
    var id = "gpkg" + (++_counter);
    var sourceId = "gpkg-src-" + id;
    var kinds = _geomKinds(featureCollection);
    var color = meta.color || _nextColor();
    var styleKey = _styleKey(id);

    map.addSource(sourceId, { type: "geojson", data: featureCollection });
    var layers = [];
    var before = App.firstUserLayer();
    var polyFilter = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
    var lineFilter = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
    var pointFilter = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
    function add(kind, op, def) {
      def.id = "gpkg-" + id + "-" + kind;
      def.source = sourceId;
      map.addLayer(def, before);
      layers.push({ id: def.id, op: op, kind: kind });
    }
    if (kinds.polygon) {
      add("fill", "fill-opacity", { type: "fill", filter: polyFilter,
        paint: { "fill-color": window.LayerPalette.withAlpha(color, FILL_ALPHA), "fill-opacity": 1 } });
      add("outline", "line-opacity", { type: "line", filter: polyFilter,
        paint: { "line-color": color, "line-width": 1, "line-opacity": 1 } });
    }
    if (kinds.line) {
      add("line", "line-opacity", { type: "line", filter: lineFilter,
        paint: { "line-color": color, "line-width": 2, "line-opacity": 1 } });
    }
    if (kinds.point) {
      add("point", "circle-opacity", { type: "circle", filter: pointFilter,
        paint: { "circle-color": color, "circle-radius": 4, "circle-opacity": 1,
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 } });
    }

    var rec = {
      id: id, fileName: meta.fileName, layerName: meta.layerName, geomKinds: kinds,
      featureCount: featureCollection.features.length, color: color,
      sourceId: sourceId, styleKey: styleKey, layers: layers
    };
    _registry.push(rec);

    // A fresh import starts at its own color: a style left in App.layerStyles
    // under this key (ids restart at gpkg1 each page load) belongs to an
    // earlier, unrelated import.
    delete App.layerStyles[styleKey];
    App.registerLayerStyle(styleKey, { label: meta.layerName, kind: "solid", defaultColors: [color] },
      function () { _repaint(rec); });

    _afterChange();
    return id;
  }

  // updateAddDataClearIcons already refreshes the Layers panel.
  function _afterChange() {
    if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();
    else if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
  }

  function _find(id) {
    for (var i = 0; i < _registry.length; i++) if (_registry[i].id === id) return i;
    return -1;
  }

  function _removeOne(rec) {
    var map = App.map;
    // Layers before the source: MapLibre refuses to remove a source in use.
    for (var i = rec.layers.length - 1; i >= 0; i--) {
      if (map.getLayer(rec.layers[i].id)) map.removeLayer(rec.layers[i].id);
    }
    if (map.getSource(rec.sourceId)) map.removeSource(rec.sourceId);
    App.unregisterLayerStyle(rec.styleKey);
  }

  App.gpkgRemoveLayer = function (id) {
    var i = _find(id);
    if (i < 0) return;
    _removeOne(_registry[i]);
    _registry.splice(i, 1);
    _afterChange();
  };

  App.gpkgClearAll = function () {
    if (!_registry.length) return;
    _registry.forEach(_removeOne);
    _registry = [];
    _afterChange();
  };

  App.gpkgLoaded = function () { return _registry.length > 0; };

  App.gpkgVisible = function () {
    var map = App.map;
    return _registry.some(function (r) {
      return r.layers.some(function (L) {
        return map.getLayer(L.id) && map.getLayoutProperty(L.id, "visibility") !== "none";
      });
    });
  };

  App.gpkgSetVisible = function (v) {
    var map = App.map;
    _registry.forEach(function (r) {
      r.layers.forEach(function (L) {
        if (map.getLayer(L.id)) map.setLayoutProperty(L.id, "visibility", v ? "visible" : "none");
      });
    });
    _afterChange();
  };

  // Layers-panel manifest entries, newest first. Same shape as the static
  // REFERENCE entries in layers-panel.js, so the panel builds the rows,
  // visibility, opacity, reorder, Zoom to layer and Remove with no special case.
  App.gpkgReferenceEntries = function () {
    return _registry.slice().reverse().map(function (r) {
      return {
        id: r.styleKey,
        label: r.fileName + " · " + r.layerName,
        layers: r.layers.map(function (L) { return { id: L.id, op: L.op }; }),
        styleKey: r.styleKey,
        clear: function () { App.gpkgRemoveLayer(r.id); },
        badge: function () {
          return { text: r.featureCount.toLocaleString(), title: r.featureCount.toLocaleString() + " features" };
        }
      };
    });
  };

  // Test hook for the browser harness. The guard keeps it out of normal page
  // loads; App is checked so a page without the app shell does not throw here.
  if (typeof window !== "undefined" && window.__MAT_TEST__ && App) {
    App._gpkgTest = {
      loadLibs: _loadLibs,
      openDb: _openDb,
      inspect: _inspect,
      readLayer: _readLayer,
      addLayerToMap: _addLayerToMap
    };
  }
})();
