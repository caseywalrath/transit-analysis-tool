// js/core/gpkg-layers.js
// GeoPackage loader: lazy-loads sql.js and proj4, opens a .gpkg with sql.js, and
// turns each feature table into WGS 84 GeoJSON through window.GpkgReader.
// The libraries are fetched only when a GeoPackage is opened, so users who never
// open one pay nothing at startup. Format and projection rules:
// docs/reference/layers-and-styling.md, "GeoPackage import".
// Nothing here touches the DOM beyond injecting the two library script tags, and
// GpkgReader is referenced only inside functions so the file loads on its own.

(function () {
  "use strict";
  var App = window.App;

  var SQL_JS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";
  var SQL_JS_URL = SQL_JS_BASE + "sql-wasm.js";
  var PROJ4_URL = "https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js";

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
    // Attribute tables, and feature tables with no geometry-column entry, open
    // in the table viewer instead of becoming map layers.
    var noGeom = r.column_name === null || r.column_name === undefined;
    if (r.data_type === "attributes" || (r.data_type === "features" && noGeom)) {
      if (!_tableExists(db, r.table_name)) {
        layer.reason = "Table is missing from the file";
        return layer;
      }
      layer.tableOnly = true;
      layer.count = _query(db, "SELECT count(*) AS n FROM " + _q(r.table_name), [])[0].n;
      layer.supported = true;
      return layer;
    }
    if (r.data_type !== "features") {
      layer.reason = "Not supported (" + (r.data_type || "unknown type") + ")";
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

  // Rows past this are counted but not loaded: the viewer is for looking, and
  // sql.js already holds the whole file in memory.
  var MAX_TABLE_ROWS = 20000;

  // Reads a table without geometry for the table viewer: every column, values
  // as stored (formatValue renders them, binary included).
  function _readTableRows(libs, db, layer) {
    var columns = _query(db, "PRAGMA table_info(" + _q(layer.table) + ")", []).map(function (c) { return c.name; });
    var rows = [];
    var stmt = db.prepare("SELECT * FROM " + _q(layer.table));
    try {
      while (rows.length < MAX_TABLE_ROWS && stmt.step()) {
        var v = stmt.get();
        var o = {};
        for (var i = 0; i < columns.length; i++) o[columns[i]] = v[i];
        rows.push(o);
      }
    } finally {
      stmt.free();
    }
    return { name: layer.table, columns: columns, rows: rows, total: layer.count };
  }

  // Reads one feature table into a WGS 84 FeatureCollection. Synchronous. The
  // table is walked row by row with a prepared statement; db is not closed here.
  // onProgress(done, total) is optional: it runs every 1,000 rows and once at the end.
  function _readLayer(libs, db, layer, onProgress) {
    if (!layer.supported) throw new Error("Layer is not supported (" + layer.reason + ")");
    if (layer.tableOnly) throw new Error("Table has no geometry; read it with _readTableRows");

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
      // Table column order (geometry and key excluded): the ramp picks the
      // first qualifying column in this order, not in row order.
      columns: attrColumns.filter(function (c) { return !c.isGeom && !c.pk; }).map(function (c) { return c.name; }),
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

  // ---- Time/cost color ramp ----
  // A layer with a travel-time or cost column (GpkgReader.pickColorField) is
  // colored by it, near → far as green → red, the way a walkshed reads; rows
  // without a value are gray. The value is copied into a private _gpkgColor
  // property (numeric text included) so the paint expression stays simple.
  // Data encodings, exempt from the chrome design tokens.
  var RAMP = ["#1a9850", "#91cf60", "#fee08b", "#fc8d59", "#d73027"];
  var NO_VALUE_COLOR = "#9aa0a6";
  var RAMP_PROP = "_gpkgColor";

  // Properties starting with this are the importer's own, never file data:
  // hidden from popups, the table viewer and copies to drawn features.
  function _isInternalKey(k) { return String(k).indexOf("_gpkg") === 0; }

  function _columnsOf(features) {
    var seen = {}, cols = [];
    for (var i = 0; i < features.length; i++) {
      var p = features[i].properties || {};
      for (var k in p) {
        if (Object.prototype.hasOwnProperty.call(p, k) && !seen[k] && !_isInternalKey(k)) {
          seen[k] = true;
          cols.push(k);
        }
      }
    }
    return cols;
  }

  function _pickRamp(featureCollection, columns) {
    var R = window.GpkgReader;
    if (!R || typeof R.pickColorField !== "function") return null;
    var feats = featureCollection.features;
    var info = R.pickColorField(columns || _columnsOf(feats), feats.map(function (f) { return f.properties || {}; }));
    if (!info) return null;
    feats.forEach(function (f) {
      f.properties = f.properties || {};
      f.properties[RAMP_PROP] = R.numericValue(f.properties[info.field]);
    });
    return info;
  }

  function _rampExpr(info, alpha) {
    var tone = function (c) { return alpha < 1 ? window.LayerPalette.withAlpha(c, alpha) : c; };
    var value = ["get", RAMP_PROP];
    var ramp;
    var stops = RAMP.map(function (c, i) { return info.min + (info.max - info.min) * i / (RAMP.length - 1); });
    // MapLibre rejects stops that are not strictly ascending, which a zero or
    // tiny range (next to huge values) produces: one color then.
    var ascending = stops.every(function (v, i) { return i === 0 || v > stops[i - 1]; });
    if (!ascending) {
      ramp = tone(RAMP[0]);
    } else {
      ramp = ["interpolate", ["linear"], value];
      RAMP.forEach(function (c, i) { ramp.push(stops[i], tone(c)); });
    }
    return ["case", ["==", ["typeof", value], "number"], ramp, tone(NO_VALUE_COLOR)];
  }

  // The paint color for one of a record's layers. A color the user picked in
  // the style drawer replaces the ramp; resetting it brings the ramp back.
  function _paintColor(rec, kind) {
    var ov = App.layerStyles && App.layerStyles[rec.styleKey];
    var alpha = kind === "fill" ? FILL_ALPHA : 1;
    if (rec.ramp && !(ov && ov.color)) return _rampExpr(rec.ramp, alpha);
    var colors = App.resolveLayerColors ? App.resolveLayerColors(rec.styleKey) : null;
    var c = (colors && colors[0]) || rec.color;
    return alpha < 1 ? window.LayerPalette.withAlpha(c, alpha) : c;
  }

  var PAINT_PROP = { fill: "fill-color", outline: "line-color", line: "line-color", point: "circle-color" };

  // The color drawer writes App.layerStyles[styleKey] through App.setLayerStyle;
  // this repainter is the only place that turns it into paint properties.
  function _repaint(rec) {
    var map = App.map;
    rec.layers.forEach(function (L) {
      if (map.getLayer(L.id)) map.setPaintProperty(L.id, PAINT_PROP[L.kind], _paintColor(rec, L.kind));
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
    _wireClick();
    var id = "gpkg" + (++_counter);
    var sourceId = "gpkg-src-" + id;
    var kinds = _geomKinds(featureCollection);
    var color = meta.color || _nextColor();
    var styleKey = _styleKey(id);

    var layers = [];
    var rec = {
      id: id, fileName: meta.fileName, layerName: meta.layerName, geomKinds: kinds,
      // Store key: name plus byte size, so two different files that share a
      // name never merge into one stored record.
      fileKey: meta.fileKey || meta.fileName,
      savedColor: color,
      featureCount: featureCollection.features.length, color: color,
      ramp: _pickRamp(featureCollection, meta.columns),
      sourceId: sourceId, styleKey: styleKey, layers: layers,
      // Kept only when the layer is small enough to copy to drawn features;
      // a large layer's geometry lives in the map source alone.
      data: _drawnPartCount(featureCollection) <= COPY_LIMIT ? featureCollection : null
    };
    try {
      // A fresh import starts at its own color: a style left in App.layerStyles
      // under this key (ids restart at gpkg1 each page load) belongs to an
      // earlier, unrelated import.
      delete App.layerStyles[styleKey];
      _addMapLayers(rec, featureCollection);
      App.registerLayerStyle(styleKey, { label: meta.layerName, kind: "solid", defaultColors: [color] },
        function () { _repaint(rec); _colorMaybeChanged(rec); });
    } catch (e) {
      // Undo whatever got onto the map, so a half-added import never draws
      // shapes that have no Layers-panel row to remove them.
      _removeOne(rec);
      throw e;
    }
    _registry.push(rec);
    _afterChange();
    return id;
  }

  function _addMapLayers(rec, featureCollection) {
    var map = App.map;
    var id = rec.id;
    var sourceId = rec.sourceId;
    var kinds = rec.geomKinds;
    var layers = rec.layers;
    map.addSource(sourceId, { type: "geojson", data: featureCollection });
    var before = App.firstUserLayer();
    var polyFilter = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
    var lineFilter = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
    var pointFilter = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
    function add(kind, op, def) {
      def.id = "gpkg-" + id + "-" + kind;
      def.source = sourceId;
      map.addLayer(def, before);
      layers.push({ id: def.id, op: op, kind: kind });
      map.on("mouseenter", def.id, _onEnter);
      map.on("mouseleave", def.id, _onLeave);
    }
    if (kinds.polygon) {
      add("fill", "fill-opacity", { type: "fill", filter: polyFilter,
        paint: { "fill-color": _paintColor(rec, "fill"), "fill-opacity": 1 } });
      add("outline", "line-opacity", { type: "line", filter: polyFilter,
        paint: { "line-color": _paintColor(rec, "outline"), "line-width": 1, "line-opacity": 1 } });
    }
    if (kinds.line) {
      add("line", "line-opacity", { type: "line", filter: lineFilter,
        paint: { "line-color": _paintColor(rec, "line"), "line-width": 2, "line-opacity": 1 } });
    }
    if (kinds.point) {
      add("point", "circle-opacity", { type: "circle", filter: pointFilter,
        paint: { "circle-color": _paintColor(rec, "point"), "circle-radius": 4, "circle-opacity": 1,
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 } });
    }
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
      map.off("mouseenter", rec.layers[i].id, _onEnter);
      map.off("mouseleave", rec.layers[i].id, _onLeave);
      if (map.getLayer(rec.layers[i].id)) map.removeLayer(rec.layers[i].id);
    }
    if (_popup && _popupImportId === rec.id) _popup.remove();
    if (map.getSource(rec.sourceId)) map.removeSource(rec.sourceId);
    App.unregisterLayerStyle(rec.styleKey);
  }

  App.gpkgRemoveLayer = function (id) {
    var i = _find(id);
    if (i < 0) return;
    var fileKey = _registry[i].fileKey;
    if (_openTableRecId === id) _closeTable();
    _removeOne(_registry[i]);
    _registry.splice(i, 1);
    // A file's tables go with its last layer: nothing else could reopen them.
    if (!_registry.some(function (r) { return r.fileKey === fileKey; })) {
      _tables = _tables.filter(function (t) { return t.fileKey !== fileKey; });
      _closeTableFor(fileKey);
    }
    _persist(fileKey);
    _afterChange();
  };

  App.gpkgClearAll = function () {
    _closePopup();
    // Cleared even when nothing is on screen: files not restored yet (offline
    // start, restore still loading) must not come back on the next refresh.
    if (App.gpkgStore && App.gpkgStore.supported()) App.gpkgStore.clear();
    _restoreGen++;
    _deferredPersist = {};
    _tables = [];
    _closeTableFor();
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
    if (!v) _closePopup();
    _registry.forEach(function (r) {
      r.layers.forEach(function (L) {
        if (map.getLayer(L.id)) map.setLayoutProperty(L.id, "visibility", v ? "visible" : "none");
      });
    });
    _afterChange();
  };

  // Above this many drawn features a copy would swamp the Features panel and
  // the attributes dock with one row per feature; the layer stays
  // reference-only. Counted in drawn features, i.e. after Multi* geometries
  // are split into one feature per part.
  var COPY_LIMIT = 2000;

  function _drawnPartCount(fc) {
    var n = 0;
    for (var i = 0; i < fc.features.length; i++) {
      var g = fc.features[i].geometry;
      n += /^Multi/.test(g.type) ? g.coordinates.length : 1;
    }
    return n;
  }

  function _copyMenuItems(rec) {
    if (!rec.data || !App.cache || typeof App.cache.appendGeoJSONFeatures !== "function") return [];
    return [{ label: "Copy to drawn features", action: function () {
      // The importer's own properties (the ramp value) are not file data.
      var r = App.cache.appendGeoJSONFeatures(rec.data.features.map(function (f) {
        var p = {};
        Object.keys(f.properties || {}).forEach(function (k) { if (!_isInternalKey(k)) p[k] = f.properties[k]; });
        return { type: "Feature", geometry: f.geometry, properties: p };
      }));
      if (r.error) {
        window.alert("Could not copy to drawn features: " + r.error);
        return;
      }
      _status("Copied " + r.added.toLocaleString() + " feature" + (r.added === 1 ? "" : "s") + " to drawn features");
    } }];
  }

  // ---- Tables and the attribute-table viewer --------------------------------
  // Tables without geometry have no Layers-panel row of their own: they open
  // from the ⋯ menu of any layer from the same file, and live as long as one
  // of that file's layers does. The viewer itself is js/core/gpkg-table.js.

  var _tables = [];   // { fileKey, fileName, name, columns, rows, total }
  var _openTableKey = null;   // fileKey of the table in the viewer, if any
  var _openTableRecId = null; // import id when the viewer shows a layer's own rows
  var TABLE_ZOOM_PADDING = { top: 240, left: 80, right: 80 };

  function _tablesOf(fileKey) {
    return _tables.filter(function (t) { return t.fileKey === fileKey; });
  }

  function _closeTable() {
    if (typeof App.gpkgCloseTable === "function") App.gpkgCloseTable();
    _openTableKey = null;
    _openTableRecId = null;
  }

  function _closeTableFor(fileKey) {
    if (_openTableKey !== null && (fileKey === undefined || _openTableKey === fileKey)) _closeTable();
  }

  function _openPlainTable(t) {
    if (typeof App.gpkgOpenTable !== "function") return;
    _openTableKey = t.fileKey;
    _openTableRecId = null;
    App.gpkgOpenTable({ title: t.name + " — " + t.fileName, columns: t.columns, rows: t.rows,
      total: t.total, onRowClick: null });
  }

  function _sourceFeatures(rec) {
    if (rec.data) return rec.data.features;
    var src = App.map.getSource(rec.sourceId);
    return (src && src._data && src._data.features) || [];
  }

  // Bottom padding keeps the target (and its popup) clear of the viewer,
  // which floats over the bottom of the map.
  function _zoomToFeature(rec, feature) {
    if (typeof turf === "undefined") return;
    var bb = turf.bbox(feature);
    var center = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    var w = document.querySelector('.floating-widget[data-widget-id="gpkg-table"]');
    var mapH = App.map.getContainer().clientHeight;
    var padding = {
      top: TABLE_ZOOM_PADDING.top, left: TABLE_ZOOM_PADDING.left, right: TABLE_ZOOM_PADDING.right,
      bottom: w ? Math.min(w.offsetHeight + 40, Math.max(0, mapH - 260)) : 80
    };
    if (bb[0] === bb[2] && bb[1] === bb[3]) {
      // An offset, not camera padding: easeTo keeps padding on the camera, and
      // clearing it afterwards makes the point jump.
      App.map.easeTo({ center: center, zoom: Math.max(App.map.getZoom(), 17),
        offset: [0, (padding.top - padding.bottom) / 2], duration: 500 });
    } else {
      App.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: padding, maxZoom: 18, duration: 500 });
    }
    _showPopup(rec, feature.properties, { lng: center[0], lat: center[1] });
  }

  function _openLayerTable(rec) {
    if (typeof App.gpkgOpenTable !== "function") return;
    var feats = _sourceFeatures(rec);
    _openTableKey = rec.fileKey;
    _openTableRecId = rec.id;
    App.gpkgOpenTable({
      title: rec.layerName + " — " + rec.fileName,
      columns: _columnsOf(feats),
      rows: feats.map(function (f) { return f.properties || {}; }),
      total: feats.length,
      // A removed layer's window is closed, but guard anyway: never fly to a
      // feature that is no longer drawn.
      onRowClick: function (i) { if (feats[i] && _find(rec.id) >= 0) _zoomToFeature(rec, feats[i]); }
    });
  }

  function _tableMenuItems(rec) {
    var items = [{ label: "View attribute table", action: function () { _openLayerTable(rec); } }];
    _tablesOf(rec.fileKey).forEach(function (t) {
      items.push({ label: "View table: " + t.name, action: function () { _openPlainTable(t); } });
    });
    return items;
  }

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
        menuItems: function () { return _tableMenuItems(r).concat(_copyMenuItems(r)); },
        badge: function () {
          var title = r.featureCount.toLocaleString() + " features";
          var ov = App.layerStyles && App.layerStyles[r.styleKey];
          if (r.ramp && !(ov && ov.color)) {
            var fmt = window.GpkgReader.formatValue;
            title += " · colored by " + r.ramp.field + " (" + fmt(r.ramp.min) + " green → " +
              fmt(r.ramp.max) + " red; gray = no value)";
          }
          return { text: r.featureCount.toLocaleString(), title: title };
        }
      };
    });
  };

  // ---- Click a feature to see its attributes ---------------------------------
  // The popup opens only when a GeoPackage layer is the topmost thing under the
  // pointer: drawn features, labels, GTFS and every other layer above it win,
  // and any active tool (drawing, measure, box select, split pick) suppresses
  // it. editing.js still treats the click as an empty-map click, so it clears
  // the drawn-feature selection: a GeoPackage layer can cover the whole study
  // area, and blocking that would leave no place to click to deselect.

  var _popup = null;
  var _popupImportId = null;
  var _clickWired = false;

  function _onEnter() {
    if (!App.drawMode) App.map.getCanvas().style.cursor = "pointer";
  }
  // Only undo a pointer this file set, so another layer's hover cursor (a
  // drawn line under the pointer, say) is left alone.
  function _onLeave() {
    var c = App.map.getCanvas();
    if (c.style.cursor === "pointer") c.style.cursor = App.drawMode ? "crosshair" : "";
  }

  function _layerRecord(layerId) {
    for (var i = 0; i < _registry.length; i++) {
      for (var j = 0; j < _registry[i].layers.length; j++) {
        if (_registry[i].layers[j].id === layerId) return _registry[i];
      }
    }
    return null;
  }

  // A TEXT value holding a JSON object or array is shown as a nested list;
  // anything else as plain text. Parsing happens only here, for display.
  function _parsedJson(v) {
    if (typeof v !== "string") return null;
    var t = v.trim();
    if (t.charAt(0) !== "{" && t.charAt(0) !== "[") return null;
    try {
      var o = JSON.parse(t);
      return (o && typeof o === "object") ? o : null;
    } catch (e) {
      return null;
    }
  }

  function _valueNode(v, depth) {
    if (v !== null && typeof v === "object" && depth < 6) {
      var ul = document.createElement("ul");
      ul.className = "gp-popup-nested";
      Object.keys(v).forEach(function (k) {
        var li = document.createElement("li");
        var key = document.createElement("span");
        key.className = "gp-popup-key";
        key.textContent = k + ": ";
        li.appendChild(key);
        li.appendChild(_valueNode(v[k], depth + 1));
        ul.appendChild(li);
      });
      return ul;
    }
    var span = document.createElement("span");
    span.className = "gp-popup-value";
    span.textContent = (v === null || v === undefined) ? "—" : (typeof v === "object" ? JSON.stringify(v) : String(v));
    return span;
  }

  function _popupContent(rec, props) {
    var root = document.createElement("div");
    root.className = "gp-popup";
    var title = document.createElement("div");
    title.className = "gp-popup-title";
    title.textContent = rec.fileName + " · " + rec.layerName;
    root.appendChild(title);
    var keys = Object.keys(props || {}).filter(function (k) { return !_isInternalKey(k); });
    if (!keys.length) {
      var none = document.createElement("div");
      none.className = "gp-popup-empty";
      none.textContent = "No attributes";
      root.appendChild(none);
      return root;
    }
    var dl = document.createElement("dl");
    dl.className = "gp-popup-list";
    keys.forEach(function (k) {
      var dt = document.createElement("dt");
      dt.textContent = k;
      var dd = document.createElement("dd");
      var parsed = _parsedJson(props[k]);
      dd.appendChild(_valueNode(parsed || props[k], 0));
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    root.appendChild(dl);
    return root;
  }

  // Reference layers that open their own popup or act on a click from their
  // own layer handler, whatever is drawn above them. When one is under the
  // pointer it keeps the click, so one click never opens two popups (or
  // toggles a street while showing GeoPackage attributes).
  var OWN_CLICK_PREFIXES = ["osm-", "walk-network", "network-joins", "gtfs-"];

  function _hasOwnClickLayer(hits) {
    for (var i = 0; i < hits.length; i++) {
      var lid = String(hits[i].layer && hits[i].layer.id);
      for (var j = 0; j < OWN_CLICK_PREFIXES.length; j++) {
        if (lid.indexOf(OWN_CLICK_PREFIXES[j]) === 0) return true;
      }
    }
    return false;
  }

  function _closePopup() {
    if (_popup) _popup.remove();
  }

  // The popup uses closeOnClick: false and closes here instead: MapLibre's own
  // close-on-click runs after this handler on the same click, so it would shut
  // a popup just moved to a second feature.
  // A click that lands on nothing is retried in a small box around the
  // pointer, so thin lines and small points do not need a pixel-perfect hit.
  // Anything directly under the pointer keeps priority.
  var CLICK_TOLERANCE_PX = 5;

  function _onMapClick(e) {
    if (App.drawMode || !_registry.length) { _closePopup(); return; }
    var tgt = e.originalEvent && e.originalEvent.target;
    if (tgt && tgt.closest && tgt.closest(".maplibregl-marker, .maplibregl-popup")) return;
    var hits = App.map.queryRenderedFeatures(e.point);
    if (!hits.length) {
      // Only GeoPackage features count in the retry: anything else in the box
      // is not under the pointer, and its own handler will not fire either.
      var T = CLICK_TOLERANCE_PX;
      hits = App.map.queryRenderedFeatures([[e.point.x - T, e.point.y - T], [e.point.x + T, e.point.y + T]])
        .filter(function (h) { return h.layer && String(h.layer.id).indexOf("gpkg-") === 0; });
    }
    var top = hits[0];
    var rec = (top && top.layer && String(top.layer.id).indexOf("gpkg-") === 0) ? _layerRecord(top.layer.id) : null;
    if (!rec || _hasOwnClickLayer(hits)) { _closePopup(); return; }
    _showPopup(rec, top.properties, e.lngLat);
  }

  function _showPopup(rec, props, lngLat) {
    if (!_popup) {
      _popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "320px", className: "gp-popup-wrap" });
    }
    _popupImportId = rec.id;
    _popup.setLngLat(lngLat).setDOMContent(_popupContent(rec, props)).addTo(App.map);
  }


  // Registered on the first import rather than at load: App.map may not exist
  // yet when this file loads, and nothing is clickable before an import.
  function _wireClick() {
    if (_clickWired) return;
    _clickWired = true;
    App.map.on("click", _onMapClick);
  }

  // ---- Open flow: file → layer picker → map --------------------------------

  var LARGE_FILE = 200 * 1024 * 1024;
  var _busy = false;

  function _status(msg) {
    if (typeof App.setStatus === "function") App.setStatus(msg);
  }

  function _el(id) { return document.getElementById(id); }

  function _plural(n, word) {
    return n.toLocaleString() + " " + word + (n === 1 ? "" : "s");
  }

  // Lets the browser paint between layers. sql.js reads synchronously, so
  // without this the progress text would only appear after the last layer.
  function _yield() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function _buildRows(layers) {
    var list = _el("gp-layer-list");
    list.innerHTML = "";
    layers.forEach(function (layer, i) {
      var row = document.createElement("label");
      row.className = "gp-row" + (layer.supported ? "" : " gp-row-disabled");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      // Tables start unchecked: files often carry bookkeeping tables (QGIS's
      // layer_styles, for one) that nobody means to open.
      cb.checked = layer.supported && !layer.tableOnly;
      cb.disabled = !layer.supported;
      cb.setAttribute("data-gp-index", String(i));
      row.appendChild(cb);
      var name = document.createElement("span");
      name.className = "gp-name";
      name.textContent = layer.table;
      row.appendChild(name);
      var meta = document.createElement("span");
      meta.className = "gp-meta";
      if (layer.tableOnly) {
        meta.textContent = "Table (no map layer) · " + _plural(layer.count, "row");
      } else if (layer.supported) {
        meta.textContent = [layer.geomType || "Geometry", _plural(layer.count, "feature"),
          layer.projection ? layer.projection.label : ""].filter(Boolean).join(" · ");
      } else {
        meta.textContent = "Not supported";
      }
      row.appendChild(meta);
      if (!layer.supported && layer.reason) {
        var reason = document.createElement("span");
        reason.className = "gp-reason";
        reason.textContent = layer.reason;
        row.appendChild(reason);
      }
      list.appendChild(row);
    });
  }

  function _checkedIndexes() {
    var out = [];
    var boxes = _el("gp-layer-list").querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked && !boxes[i].disabled) out.push(Number(boxes[i].getAttribute("data-gp-index")));
    }
    return out;
  }

  function _setControlsDisabled(dis) {
    var dlg = _el("gp-dialog");
    var inputs = dlg.querySelectorAll("input, button");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (dis) {
        el.setAttribute("data-gp-was-disabled", el.disabled ? "1" : "0");
        el.disabled = true;
      } else if (el.hasAttribute("data-gp-was-disabled")) {
        el.disabled = el.getAttribute("data-gp-was-disabled") === "1";
        el.removeAttribute("data-gp-was-disabled");
      }
    }
  }

  // Shows the picker and resolves to { indexes, finish } when the user clicks
  // Add, or null on Cancel/Escape. The dialog stays open while the caller
  // reads (so progress is visible); finish() closes it.
  function _pickLayers(fileName, layers) {
    return new Promise(function (resolve) {
      var dlg = _el("gp-dialog");
      var addBtn = _el("gp-add");
      var cancelBtn = _el("gp-cancel");
      var list = _el("gp-layer-list");
      var returnFocus = document.activeElement;
      var reading = false;

      _el("gp-file-name").textContent = fileName;
      _el("gp-file-name").title = fileName;
      _el("gp-progress").textContent = "";
      _buildRows(layers);
      function syncAdd() { addBtn.disabled = reading || _checkedIndexes().length === 0; }
      syncAdd();

      function close() {
        dlg.hidden = true;
        document.removeEventListener("keydown", onKey, true);
        list.removeEventListener("change", syncAdd);
        addBtn.removeEventListener("click", onAdd);
        cancelBtn.removeEventListener("click", onCancel);
        if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) {
          returnFocus.focus();
        }
      }
      function onCancel() {
        if (reading) return;
        close();
        resolve(null);
      }
      // Capture phase, so Escape closes only this dialog and never reaches the
      // attributes dock, an analysis panel or an active drawing tool.
      function onKey(e) {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
      function onAdd() {
        var idx = _checkedIndexes();
        if (!idx.length) return;
        reading = true;
        _setControlsDisabled(true);
        resolve({ indexes: idx, finish: function () { reading = false; _setControlsDisabled(false); close(); } });
      }

      list.addEventListener("change", syncAdd);
      addBtn.addEventListener("click", onAdd);
      cancelBtn.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey, true);
      dlg.hidden = false;
      var first = list.querySelector("input[type=checkbox]:not([disabled])");
      (first || cancelBtn).focus();
    });
  }

  function _readFile(file) {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("Could not read the file.")); };
      r.readAsArrayBuffer(file);
    });
  }

  function _summary(added, skipped, failed) {
    var parts = ["Added " + _plural(added, "GeoPackage layer")];
    var empty = skipped.empty + skipped.nullGeom;
    if (empty) parts.push(empty.toLocaleString() + (empty === 1 ? " empty geometry" : " empty geometries") + " skipped");
    if (skipped.collection) parts.push(_plural(skipped.collection, "geometry collection") + " skipped");
    if (skipped.unsupported) parts.push(_plural(skipped.unsupported, "unsupported shape") + " skipped");
    if (skipped.invalid) parts.push(_plural(skipped.invalid, "invalid shape") + " skipped");
    if (failed.length) parts.push("could not read " + failed.join(", "));
    return parts.join(" · ");
  }

  // Brings a fresh import into view: fit the map to the new layers and switch
  // the right panel to the Layers tab, where their rows are.
  function _showNewLayers(ids) {
    var feats = [];
    ids.forEach(function (id) {
      var i = _find(id);
      if (i >= 0) feats = feats.concat(_sourceFeatures(_registry[i]));
    });
    if (feats.length && typeof turf !== "undefined") {
      var bb = turf.bbox({ type: "FeatureCollection", features: feats });
      if (bb.every(isFinite)) {
        if (bb[0] === bb[2] && bb[1] === bb[3]) {
          App.map.easeTo({ center: [bb[0], bb[1]], zoom: Math.max(App.map.getZoom(), 15), duration: 600 });
        } else {
          App.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 600 });
        }
      }
    }
    var tab = document.querySelector('.fp-tab-btn[data-fptab="layers"]');
    if (tab) tab.click();
  }

  // Entry point from the Add Data menu and the general Import picker.
  App.gpkgOpenFile = function (file) {
    if (!file) return Promise.resolve();
    if (_busy) {
      _status("Still opening the previous GeoPackage. Try again when it has finished.");
      return Promise.resolve();
    }
    if (file.size > LARGE_FILE &&
        !window.confirm("This GeoPackage is " + Math.round(file.size / 1048576) + " MB. Opening it may take a while and use a lot of memory. Continue?")) {
      return Promise.resolve();
    }
    _busy = true;
    var db = null;
    var libs = null;
    _status("Opening " + file.name + "…");
    var bytes = null;
    var fileKey = null;
    return Promise.all([_loadLibs(), _readFile(file)]).then(function (res) {
      libs = res[0];
      bytes = res[1];
      fileKey = file.name + "|" + (bytes.byteLength || 0);
      db = _openDb(libs, res[1]);
      var layers = _inspect(libs, db).layers;
      if (!layers.length) throw new Error("This GeoPackage has no layers.");
      _status("");
      return _pickLayers(file.name, layers).then(function (choice) {
        if (!choice) return;
        var skipped = { empty: 0, nullGeom: 0, collection: 0, unsupported: 0, invalid: 0 };
        var added = 0;
        var addedIds = [];
        var newTables = [];
        var failed = [];
        var chain = Promise.resolve();
        choice.indexes.forEach(function (i, n) {
          var layer = layers[i];
          chain = chain.then(function () {
            var msg = "Reading " + layer.table + "… (" + (n + 1) + " of " + choice.indexes.length + ")";
            _el("gp-progress").textContent = msg;
            _status(msg);
            return _yield();
          }).then(function () {
            try {
              if (layer.tableOnly) {
                var t = _readTableRows(libs, db, layer);
                t.fileKey = fileKey;
                t.fileName = file.name;
                _tables = _tables.filter(function (x) { return !(x.fileKey === fileKey && x.name === t.name); });
                _tables.push(t);
                newTables.push(t);
                return;
              }
              var r = _readLayer(libs, db, layer);
              Object.keys(skipped).forEach(function (k) { skipped[k] += r.skipped[k] || 0; });
              var newId = _addLayerToMap(r.featureCollection, { fileName: file.name, fileKey: fileKey, layerName: layer.table, columns: r.columns });
              if (newId) { added++; addedIds.push(newId); }
            } catch (e) {
              failed.push(layer.table);
            }
          });
        });
        return chain.then(function () {
          choice.finish();
          var summary = _summary(added, skipped, failed);
          var onMapNow = _registry.some(function (r) { return r.fileKey === fileKey; });
          if (newTables.length) summary += " · " + _plural(newTables.length, "table") + (onMapNow ? " (open from a layer's ⋯ menu)" : "");
          _status(summary);
          var fileHasLayers = _registry.some(function (r) { return r.fileKey === fileKey; });
          if (added) {
            _saveFile(fileKey, bytes);
            _showNewLayers(addedIds);
          } else if (newTables.length && fileHasLayers) {
            // Tables added to a file already on the map: record them too.
            _persist(fileKey);
          } else if (newTables.length) {
            // No layer row could reopen these later, so they are not kept: the
            // first is shown now and the status says how to see the others.
            _tables = _tables.filter(function (t) { return t.fileKey !== fileKey; });
            _openPlainTable(newTables[0]);
            if (newTables.length > 1) {
              _status("Showing " + newTables[0].name + ". A file with no map layers shows one table at a time: open it again to view another.");
            }
          }
        }, function (e) {
          choice.finish();
          throw e;
        });
      });
    }).catch(function (e) {
      _status("");
      window.alert((e && e.message) || "Could not open this GeoPackage.");
    }).then(function () {
      if (db) { try { db.close(); } catch (e) { /* already closed */ } }
      _busy = false;
    });
  };

  // ---- Keep imports across a page refresh -------------------------------------
  // The store (js/core/gpkg-store.js) keeps each file's original bytes plus the
  // tables shown and their colors; restoring re-runs the same open → read →
  // add path as an upload, so a restored layer can never differ from one just
  // imported. Everything here is best-effort: the layers on screen are already
  // usable whether or not a write lands.

  // Per table: the import's own color (`base`, the reset target) and the
  // color on screen now (`color`, after any recolor).
  function _currentColor(r) {
    var c = App.resolveLayerColors(r.styleKey);
    return (c && c[0]) || r.color;
  }

  function _fileState(fileKey) {
    var layers = [], colors = {};
    _registry.forEach(function (r) {
      if (r.fileKey !== fileKey) return;
      if (layers.indexOf(r.layerName) < 0) layers.push(r.layerName);
      colors[r.layerName] = { base: r.color, color: _currentColor(r) };
    });
    // Tables are stored only alongside a layer; see gpkgRemoveLayer.
    if (layers.length) {
      _tablesOf(fileKey).forEach(function (t) { if (layers.indexOf(t.name) < 0) layers.push(t.name); });
    }
    return { layers: layers, colors: colors };
  }

  function _storeOk() { return !!(App.gpkgStore && App.gpkgStore.supported()); }

  function _saveFile(fileKey, bytes) {
    if (!_storeOk() || !bytes) return;
    if (bytes.byteLength > App.gpkgStore.MAX_BYTES) {
      _status("Added, but this file is too large to keep after a page refresh (limit " +
        Math.round(App.gpkgStore.MAX_BYTES / 1048576) + " MB)");
      return;
    }
    var st = _fileState(fileKey);
    _registry.forEach(function (r) { if (r.fileKey === fileKey) r.savedColor = _currentColor(r); });
    App.gpkgStore.save(fileKey, bytes, st.layers, st.colors).catch(function () { /* convenience only */ });
  }

  // Removing a file's last layer passes [] to update(), which deletes the record.
  function _persist(fileKey) {
    if (!_storeOk() || _addingRestored) return;
    // Mid-restore, the registry does not yet hold this file's later tables;
    // writing now would drop them from the record. Write once restore ends.
    if (_restoreActive) { _deferredPersist[fileKey] = true; return; }
    var st = _fileState(fileKey);
    App.gpkgStore.update(fileKey, st.layers, st.colors).catch(function () { /* convenience only */ });
  }

  // Every style change anywhere runs every repainter, so this writes only when
  // this layer's own color really changed, and only once a drag settles:
  // update() rewrites the whole record, file bytes included.
  var _persistTimers = {};
  function _colorMaybeChanged(rec) {
    if (_addingRestored) return;
    var c = _currentColor(rec);
    if (c === rec.savedColor) return;
    rec.savedColor = c;
    clearTimeout(_persistTimers[rec.fileKey]);
    _persistTimers[rec.fileKey] = setTimeout(function () { _persist(rec.fileKey); }, 400);
  }

  // _addingRestored: true only while a restored table is being added (its
  // own add and color set must not write back). _restoreGen: bumped by
  // gpkgClearAll so a running restore stops adding layers after a Clear.
  var _addingRestored = false;
  var _restoreActive = false;
  var _restoreGen = 0;
  var _deferredPersist = {};

  // The display name is the store key without its "|<size>" suffix.
  function _nameFromKey(key) {
    var i = String(key).lastIndexOf("|");
    return i > 0 ? key.slice(0, i) : key;
  }

  // Restores one table; a failure skips that table only.
  function _restoreTable(libs, db, layers, rec, table) {
    var layer = layers.filter(function (l) { return l.table === table && l.supported; })[0];
    if (!layer) return false;
    if (layer.tableOnly) {
      try {
        var t = _readTableRows(libs, db, layer);
        t.fileKey = rec.name;
        t.fileName = _nameFromKey(rec.name);
        _tables.push(t);
        return false;   // not a layer: the restored-layer count stays layers only
      } catch (e) {
        return false;
      }
    }
    _addingRestored = true;
    try {
      var r = _readLayer(libs, db, layer);
      var saved = (rec.colors && rec.colors[table]) || {};
      var base = typeof saved === "string" ? saved : saved.base;
      var id = _addLayerToMap(r.featureCollection,
        { fileName: _nameFromKey(rec.name), fileKey: rec.name, layerName: table, color: base, columns: r.columns });
      if (!id) return false;
      var reg = _registry[_find(id)];
      if (saved.color && saved.color !== reg.color) App.setLayerStyle(reg.styleKey, { color: saved.color });
      reg.savedColor = _currentColor(reg);
      return true;
    } catch (e) {
      return false;
    } finally {
      _addingRestored = false;
    }
  }

  // Called once at startup from app.js, after the session and GTFS restores.
  // Oldest file first, so the newest import ends up on top as it was, yielding
  // between tables so a large cache does not freeze the page. Resolves to the
  // number of layers restored. A file that no longer opens is dropped from the
  // store so it does not fail again on every refresh.
  App.restoreCachedGpkg = function () {
    if (!_storeOk() || _busy) return Promise.resolve(0);
    return App.gpkgStore.list().then(function (recs) {
      if (!recs.length || _busy || _registry.length) return 0;
      _busy = true;
      _restoreActive = true;
      var gen = ++_restoreGen;
      var restored = 0;
      return _loadLibs().then(function (libs) {
        var chain = Promise.resolve();
        recs.slice().reverse().forEach(function (rec) {
          chain = chain.then(function () {
            if (gen !== _restoreGen) return;
            var db;
            try {
              db = _openDb(libs, rec.bytes);
            } catch (e) {
              App.gpkgStore.remove(rec.name);
              return;
            }
            var layers;
            try { layers = _inspect(libs, db).layers; } catch (e) { layers = []; }
            var tables = rec.layers || [];
            var step = Promise.resolve();
            tables.forEach(function (table) {
              step = step.then(_yield).then(function () {
                if (gen !== _restoreGen) return;
                if (_restoreTable(libs, db, layers, rec, table)) restored++;
              });
            });
            return step.then(function () {
              try { db.close(); } catch (e) { /* already closed */ }
              // Tables are reachable only from a layer of the same file.
              if (!_registry.some(function (r) { return r.fileKey === rec.name; })) {
                _tables = _tables.filter(function (t) { return t.fileKey !== rec.name; });
              }
            });
          });
        });
        return chain.then(function () { return restored; });
      }, function () {
        // Offline at startup: keep the files for the next refresh.
        return 0;
      }).then(function (n) {
        _busy = false;
        _restoreActive = false;
        var keys = Object.keys(_deferredPersist);
        _deferredPersist = {};
        keys.forEach(_persist);
        if (n) _status("Restored " + _plural(n, "GeoPackage layer"));
        return n;
      });
    }).catch(function () {
      _busy = false;
      _restoreActive = false;
      _deferredPersist = {};
      return 0;
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
