// js/core/cache.js
// Session cache: save/restore/reset via localStorage.
// JSON import/export via file download/upload.
// Depends on: App.points, App.lines, App.routes, App.polygons,
//             App.rebuildBuffers, App.rebuildLineBuffers, App.rebuildRouteBuffers,
//             App.renderPolygonLayers, App.clearRoutes, App.refreshFeaturePanel.
// Exports: App.cache

(function () {
  var App = window.App = window.App || {};

  var STORAGE_KEY = "mat-session";
  var SCHEMA_VERSION = 3;

  // ---- Schema migration ----
  function migrateV1toV2(state) {
    if (state.stations) { state.points = state.stations; delete state.stations; }
    if (state.stationLineWidth != null) { state.pointLineWidth = state.stationLineWidth; delete state.stationLineWidth; }
    if (Array.isArray(state.points)) {
      state.points.forEach(function (f) {
        if (f.properties && f.properties.stationIdx != null) {
          f.properties.pointIdx = f.properties.stationIdx;
          delete f.properties.stationIdx;
        }
      });
    }
    state.version = 2;
    return state;
  }

  // v3 adds optional lodesData + gtfsData keys for full-session state files.
  // v2 files are a strict subset: no structural change is required; bump the
  // version marker and return.
  function migrateV2toV3(state) {
    state.version = 3;
    return state;
  }

  function migrateToCurrent(state) {
    if (!state) return state;
    if (state.version === 1) state = migrateV1toV2(state);
    if (state.version === 2) state = migrateV2toV3(state);
    return state;
  }
  var _saveTimer = null;
  var DEBOUNCE_MS = 500;
  var _viewOnly = false;

  // ---- Module state registry ----
  // Analysis modules register collect/apply hooks to persist their own state.
  // collect(mode) returns a serializable object; mode is "light" (localStorage)
  // or "full" (file export, may include geometry).
  // apply(data) restores state from a previously collected object.

  var _moduleHandlers = [];

  // ---- Collect current state into a serialisable object ----
  // mode: "light" (default, for localStorage — skips heavy geometry)
  //       "full"  (for file export — includes geos for choropleth restore)

  function collectState(mode) {
    var _fss = (typeof App.getFeatureSortState === "function") ? App.getFeatureSortState() : null;
    var state = {
      version: SCHEMA_VERSION,
      points: App.points.slice(),
      lines: App.lines.slice(),
      routes: App.routes.slice(),
      polygons:  App.polygons.slice(),
      labels:    App.labels    ? App.labels.slice()    : [],
      textBoxes: App.textBoxes ? App.textBoxes.slice() : [],
      bufferRadius:      (App.featureSettings && App.featureSettings.bufferRadius      != null) ? App.featureSettings.bufferRadius      : 0,
      lineBufferRadius:  (App.featureSettings && App.featureSettings.lineBufferRadius  != null) ? App.featureSettings.lineBufferRadius  : 0,
      routeBufferRadius: (App.featureSettings && App.featureSettings.routeBufferRadius != null) ? App.featureSettings.routeBufferRadius : 0,
      pointLineWidth:    (App.featureSettings && App.featureSettings.pointLineWidth    != null) ? App.featureSettings.pointLineWidth    : 1,
      lineLineWidth:     (App.featureSettings && App.featureSettings.lineLineWidth     != null) ? App.featureSettings.lineLineWidth     : 1,
      routeLineWidth:    (App.featureSettings && App.featureSettings.routeLineWidth    != null) ? App.featureSettings.routeLineWidth    : 1,
      polygonLineWidth:  (App.featureSettings && App.featureSettings.polygonLineWidth  != null) ? App.featureSettings.polygonLineWidth  : 1,
      bufferLineWidth:   (App.featureSettings && App.featureSettings.bufferLineWidth   != null) ? App.featureSettings.bufferLineWidth   : 1,
      pointOpacity:      (App.featureSettings && App.featureSettings.pointOpacity      != null) ? App.featureSettings.pointOpacity      : 100,
      lineOpacity:       (App.featureSettings && App.featureSettings.lineOpacity       != null) ? App.featureSettings.lineOpacity       : 100,
      routeOpacity:      (App.featureSettings && App.featureSettings.routeOpacity      != null) ? App.featureSettings.routeOpacity      : 100,
      polygonOpacity:    (App.featureSettings && App.featureSettings.polygonOpacity    != null) ? App.featureSettings.polygonOpacity    : 50,
      bufferOpacity:     (App.featureSettings && App.featureSettings.bufferOpacity     != null) ? App.featureSettings.bufferOpacity     : 50,
      featureSortMode:   _fss ? _fss.mode       : "name",
      featureSortAsc:    _fss ? _fss.asc        : true,
      featureShowGroups: _fss ? _fss.showGroups : true,
      offsetOverlap: !!document.getElementById("offsetOverlap").checked,
      lodesFileNames: App.lodesFileNames || [],
      projFileName: App.projFileName || "",
      projYear: App.projYear || null,
      mapCenter: App.map ? [App.map.getCenter().lng, App.map.getCenter().lat] : null,
      mapZoom: App.map ? App.map.getZoom() : null
    };

    // Checkbox selections are now managed by the buffer-summary module
    // via cache.registerModule("buffer-summary"). Kept for backward compat on restore.
    // Note: geoLevel and year are also in state.moduleState["buffer-summary"].

    // Module state (TPI, RF, buffer-summary, etc.)
    state.moduleState = {};
    for (var mi = 0; mi < _moduleHandlers.length; mi++) {
      var mh = _moduleHandlers[mi];
      if (typeof mh.handlers.collect === "function") {
        try {
          state.moduleState[mh.id] = mh.handlers.collect(mode || "light");
        } catch (e) {
          console.warn("Cache: module collect failed for", mh.id, e);
        }
      }
    }

    return state;
  }

  // ---- Apply a state object to the app (shared by restore + import) ----

  function applyState(state) {
    // 0. Defense in depth — the import callers and restore() already pre-validate,
    // but throwing here protects against a future caller that forgets to.
    // We must reject BEFORE clearing the live arrays.
    var validationErr = validateSessionState(state);
    if (validationErr) throw new Error(validationErr);

    // 1. Clear all feature arrays unconditionally (in-place to preserve closure refs)
    App.points.length = 0;
    App.lines.length = 0;
    App.routes.length = 0;
    App.polygons.length = 0;
    if (App.labels)    App.labels.length    = 0;
    if (App.textBoxes) App.textBoxes.length = 0;

    // 2. Push features
    if (Array.isArray(state.points)) {
      for (var i = 0; i < state.points.length; i++) App.points.push(state.points[i]);
    }
    if (Array.isArray(state.lines)) {
      for (var j = 0; j < state.lines.length; j++) App.lines.push(state.lines[j]);
    }
    if (Array.isArray(state.routes)) {
      for (var r = 0; r < state.routes.length; r++) App.routes.push(state.routes[r]);
    }
    if (Array.isArray(state.polygons)) {
      for (var k = 0; k < state.polygons.length; k++) App.polygons.push(state.polygons[k]);
    }
    if (App.labels && Array.isArray(state.labels)) {
      for (var li = 0; li < state.labels.length; li++) App.labels.push(state.labels[li]);
    }
    if (App.textBoxes && Array.isArray(state.textBoxes)) {
      for (var ti = 0; ti < state.textBoxes.length; ti++) App.textBoxes.push(state.textBoxes[ti]);
    }

    // 3. Restore feature settings into App.featureSettings
    if (App.featureSettings) {
      var fs = App.featureSettings;
      if (state.bufferRadius      != null) fs.bufferRadius      = state.bufferRadius;
      if (state.lineBufferRadius  != null) fs.lineBufferRadius  = state.lineBufferRadius;
      if (state.routeBufferRadius != null) fs.routeBufferRadius = state.routeBufferRadius;
      if (state.pointLineWidth    != null) fs.pointLineWidth    = state.pointLineWidth;
      if (state.lineLineWidth     != null) fs.lineLineWidth     = state.lineLineWidth;
      if (state.routeLineWidth    != null) fs.routeLineWidth    = state.routeLineWidth;
      if (state.polygonLineWidth  != null) fs.polygonLineWidth  = state.polygonLineWidth;
      if (state.bufferLineWidth   != null) fs.bufferLineWidth   = state.bufferLineWidth;
      // Opacity — default gracefully for old sessions without these fields
      fs.pointOpacity   = (state.pointOpacity   != null) ? state.pointOpacity   : 100;
      fs.lineOpacity    = (state.lineOpacity     != null) ? state.lineOpacity    : 100;
      fs.routeOpacity   = (state.routeOpacity    != null) ? state.routeOpacity   : 100;
      fs.polygonOpacity = (state.polygonOpacity  != null) ? state.polygonOpacity : 50;
      fs.bufferOpacity  = (state.bufferOpacity   != null) ? state.bufferOpacity  : 50;
    }

    // 3a. Restore Features list sort state (additive fields — the setter
    // no-ops on anything absent, so an old session without them keeps the
    // module's own defaults).
    if (typeof App.restoreFeatureSortState === "function") {
      App.restoreFeatureSortState({
        mode: state.featureSortMode,
        asc: state.featureSortAsc,
        showGroups: state.featureShowGroups
      });
    }

    // 3b. Restore offset toggle (actual offset computed after render via auto-recompute hook)
    var offsetEl = document.getElementById("offsetOverlap");
    if (offsetEl && state.offsetOverlap) {
      offsetEl.checked = true;
    }

    // 4. Rebuild derived buffers and re-render map layers
    var pointRadius  = (App.featureSettings && App.featureSettings.bufferRadius      != null) ? App.featureSettings.bufferRadius      : 0;
    var lineRadius   = (App.featureSettings && App.featureSettings.lineBufferRadius  != null) ? App.featureSettings.lineBufferRadius  : 0;
    var routeRadius  = (App.featureSettings && App.featureSettings.routeBufferRadius != null) ? App.featureSettings.routeBufferRadius : 0;
    App.rebuildBuffers(pointRadius);
    App.rebuildLineBuffers(lineRadius);
    App.rebuildRouteBuffers(routeRadius);
    App.renderPolygonLayers();

    // 4b. Apply line widths and opacity (after layers exist)
    if (typeof App.applyLineWidth        === "function") App.applyLineWidth("all");
    if (typeof App.applyBufferLineWidth  === "function") App.applyBufferLineWidth();
    if (typeof App.applyFeatureOpacity   === "function") App.applyFeatureOpacity("all");
    if (typeof App.renderLabelMarkers    === "function") App.renderLabelMarkers();
    if (typeof App.renderTextBoxMarkers  === "function") App.renderTextBoxMarkers();

    // 4b. Restore map position (if saved)
    if (state.mapCenter && state.mapZoom != null && App.map) {
      App.map.jumpTo({ center: state.mapCenter, zoom: state.mapZoom });
    }

    // 5. Restore checkbox selections — checkboxes now live in buffer-summary popup
    // (lazy-loaded, not in DOM at restore time). Migrate into moduleState so the
    // buffer-summary module's apply() handler picks them up.
    if (!state.moduleState) state.moduleState = {};
    if (!state.moduleState["buffer-summary"]) {
      state.moduleState["buffer-summary"] = {
        geoLevel: state.geoLevel || "bg",
        year: state.year || "2024",
        apportionByArea: true
      };
    }
    // Migrate checkedVars from top-level into buffer-summary module state
    if (Array.isArray(state.checkedVars) && !state.moduleState["buffer-summary"].checkedVars) {
      state.moduleState["buffer-summary"].checkedVars = state.checkedVars;
    }

    // 7. LODES filename hint (data is NOT cached — too large)
    // Support both new array format (lodesFileNames) and old string format (lodesFileName)
    var lodesHints = state.lodesFileNames ||
      (state.lodesFileName ? [state.lodesFileName] : []);
    if (lodesHints.length > 0) {
      var lodesInfoEl = document.getElementById("lodesInfo");
      if (lodesInfoEl) {
        lodesInfoEl.textContent =
          "Previously loaded: " + lodesHints.join(", ") + " \u2014 re-upload to use";
      }
    }

    // 8. Projection filename hint (data is NOT cached — small CSV, re-upload is fast)
    if (state.projFileName) {
      var projInfoEl = document.getElementById("projInfo");
      if (projInfoEl) {
        projInfoEl.textContent = "Previously loaded: " + state.projFileName + " \u2014 re-upload to use";
      }
    }
    if (state.projYear) {
      var projYearEl = document.getElementById("projYear");
      if (projYearEl) projYearEl.value = state.projYear;
      App.projYear = state.projYear;
    }

    // 9. Module state (TPI, RF, etc.) — optional field, skip if absent
    if (state.moduleState) {
      for (var mi = 0; mi < _moduleHandlers.length; mi++) {
        var mh = _moduleHandlers[mi];
        var moduleData = state.moduleState[mh.id];
        if (moduleData && typeof mh.handlers.apply === "function") {
          try {
            mh.handlers.apply(moduleData);
          } catch (e) {
            console.warn("Cache: module apply failed for", mh.id, e);
          }
        }
      }
    }
  }

  // ---- Save (debounced) ----

  function save() {
    if (_viewOnly) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      try {
        var json = JSON.stringify(collectState());
        localStorage.setItem(STORAGE_KEY, json);
      } catch (e) {
        console.warn("Cache save failed:", e);
        if (typeof App.setStatus === "function") {
          App.setStatus("Autosave disabled — storage error or quota exceeded.");
        }
      }
    }, DEBOUNCE_MS);
  }

  // ---- Restore ----
  // Returns true if cached data was found and applied.

  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;

      var state = JSON.parse(raw);
      if (!state) return false;
      var validationErr = validateSessionState(state);
      if (validationErr) {
        console.warn("Cache restore: ignoring stored state — " + validationErr);
        return false;
      }

      applyState(state);

      return (App.points.length > 0 || App.lines.length > 0 ||
              App.routes.length > 0 || App.polygons.length > 0 ||
              (App.labels && App.labels.length > 0));
    } catch (e) {
      console.warn("Cache restore failed:", e);
      return false;
    }
  }

  // ---- Auto-save on map movement (pan/zoom) ----
  if (App.map) {
    App.map.on("moveend", function () { save(); });
  }

  // ---- Reset: clear cache and all app state ----

  function reset() {
    // 1. Clear localStorage
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn("Cache clear failed:", e);
    }

    // 1b. Clear the shared census fetch cache (geos + ACS values).
    if (App.censusCache && typeof App.censusCache.clear === "function") {
      App.censusCache.clear();
    }

    // 2. Clear all features
    if (typeof App.exitEditMode === "function") App.exitEditMode();
    App.clearPoints();
    App.clearLines();
    App.clearRoutes();
    App.clearPolygons();
    if (typeof App.clearLabels === "function") App.clearLabels();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();

    // 3. Reset feature settings to defaults
    if (App.featureSettings) {
      App.featureSettings.bufferRadius      = 0;
      App.featureSettings.lineBufferRadius  = 0;
      App.featureSettings.routeBufferRadius = 0;
      App.featureSettings.pointLineWidth    = 1;
      App.featureSettings.lineLineWidth     = 1;
      App.featureSettings.routeLineWidth    = 1;
      App.featureSettings.polygonLineWidth  = 1;
      App.featureSettings.bufferLineWidth   = 1;
      App.featureSettings.pointOpacity      = 100;
      App.featureSettings.lineOpacity       = 100;
      App.featureSettings.routeOpacity      = 100;
      App.featureSettings.polygonOpacity    = 50;
      App.featureSettings.bufferOpacity     = 50;
    }
    if (typeof App.applyLineWidth       === "function") App.applyLineWidth("all");
    if (typeof App.applyBufferLineWidth === "function") App.applyBufferLineWidth();
    if (typeof App.applyFeatureOpacity  === "function") App.applyFeatureOpacity("all");

    // 4. Clear LODES state
    if (typeof App.clearLodesData === "function") {
      App.clearLodesData();
    }

    // 4b. Clear projection state
    if (typeof App.clearProjectionsData === "function") {
      App.clearProjectionsData();
    }

    // 5. Uncheck all variable checkboxes (LODES checkbox lives inside #varSelect now).
    var boxes = document.querySelectorAll('#varSelect input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;

    // 6. Reset buffer-summary popup state (if popup DOM exists)
    var basGeoEl = document.getElementById("basGeoLevel");
    if (basGeoEl) basGeoEl.value = "bg";
    var basYearEl = document.getElementById("basYearSelect");
    if (basYearEl) basYearEl.value = "2024";
    var basApportionEl = document.getElementById("basApportionByArea");
    if (basApportionEl) basApportionEl.checked = true;

    // 7. Update status
    App.setStatus("Session reset");
  }

  // ---- Validate imported state ----
  // Returns null when valid, or a descriptive error string identifying the
  // offending element. Used by importFromFile, importFullState, and restore()
  // BEFORE applyState mutates any live App arrays.

  var MAX_FEATURES_PER_ARRAY = 5000;

  function isPlainObject(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x);
  }
  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }
  function isCoordPair(c) {
    return Array.isArray(c) && c.length >= 2 &&
           isFiniteNumber(c[0]) && isFiniteNumber(c[1]);
  }

  function validateFeature(f, arrName, idx) {
    var loc = arrName + "[" + idx + "]";
    if (!isPlainObject(f)) return loc + ": not a plain object.";
    if (f.type !== "Feature") return loc + ".type must be \"Feature\".";
    if (!isPlainObject(f.properties)) return loc + ".properties must be an object.";
    if (!isPlainObject(f.geometry)) return loc + ".geometry must be an object.";
    var g = f.geometry;
    if (typeof g.type !== "string") return loc + ".geometry.type must be a string.";
    if (!Array.isArray(g.coordinates)) return loc + ".geometry.coordinates must be an array.";

    if (g.type === "Point") {
      if (!isCoordPair(g.coordinates)) {
        return loc + ".geometry.coordinates must be [lon, lat] of finite numbers.";
      }
    } else if (g.type === "LineString") {
      if (g.coordinates.length < 2) {
        return loc + ".geometry: LineString needs at least 2 coordinate pairs.";
      }
      for (var i = 0; i < g.coordinates.length; i++) {
        if (!isCoordPair(g.coordinates[i])) {
          return loc + ".geometry.coordinates[" + i + "] must be [lon, lat] of finite numbers.";
        }
      }
    } else if (g.type === "Polygon") {
      if (g.coordinates.length < 1) {
        return loc + ".geometry: Polygon needs at least one ring.";
      }
      for (var r = 0; r < g.coordinates.length; r++) {
        var ring = g.coordinates[r];
        if (!Array.isArray(ring) || ring.length < 3) {
          return loc + ".geometry.coordinates[" + r + "] must be a ring of at least 3 points.";
        }
        for (var p = 0; p < ring.length; p++) {
          if (!isCoordPair(ring[p])) {
            return loc + ".geometry.coordinates[" + r + "][" + p + "] must be [lon, lat] of finite numbers.";
          }
        }
      }
    } else {
      return loc + ".geometry.type \"" + g.type + "\" is not supported (Point, LineString, Polygon).";
    }
    return null;
  }

  function validateFeatureArray(state, name) {
    if (state[name] == null) return null;
    if (!Array.isArray(state[name])) return "Invalid " + name + " data — not an array.";
    if (state[name].length > MAX_FEATURES_PER_ARRAY) {
      return name + " has " + state[name].length + " features; max " +
             MAX_FEATURES_PER_ARRAY + " supported.";
    }
    for (var i = 0; i < state[name].length; i++) {
      var err = validateFeature(state[name][i], name, i);
      if (err) return err;
    }
    return null;
  }

  function validateSessionState(state) {
    if (!isPlainObject(state)) return "File does not contain a valid JSON object.";
    migrateToCurrent(state);
    if (state.version !== SCHEMA_VERSION) {
      return "Unsupported file version (expected " + SCHEMA_VERSION +
             ", got " + (state.version || "none") + ").";
    }

    var arrs = ["points", "lines", "routes", "polygons"];
    for (var i = 0; i < arrs.length; i++) {
      var err = validateFeatureArray(state, arrs[i]);
      if (err) return err;
    }

    // Labels / textBoxes are simpler marker objects (not GeoJSON features);
    // only check that they are arrays within bounds. The renderers tolerate
    // shape drift via the existing per-marker null checks.
    var simpleArrs = ["labels", "textBoxes"];
    for (var j = 0; j < simpleArrs.length; j++) {
      var sn = simpleArrs[j];
      if (state[sn] != null) {
        if (!Array.isArray(state[sn])) return "Invalid " + sn + " data — not an array.";
        if (state[sn].length > MAX_FEATURES_PER_ARRAY) {
          return sn + " has " + state[sn].length + " items; max " +
                 MAX_FEATURES_PER_ARRAY + " supported.";
        }
      }
    }

    // moduleState (optional). Top-level must be a plain object; per-module
    // payloads must each be objects or null. Each module's apply() handler is
    // already wrapped in try/catch, so deeper shape checks aren't required here.
    if (state.moduleState != null) {
      if (!isPlainObject(state.moduleState)) {
        return "moduleState must be an object.";
      }
      var keys = Object.keys(state.moduleState);
      for (var mi = 0; mi < keys.length; mi++) {
        var v = state.moduleState[keys[mi]];
        if (v != null && !isPlainObject(v)) {
          return "moduleState[\"" + keys[mi] + "\"] must be an object or null.";
        }
      }
    }

    // Map state (light check — not safety-critical, but a clear error beats
    // a silent fall-through to App.map.jumpTo({ center: "x" })).
    if (state.mapCenter != null) {
      if (!Array.isArray(state.mapCenter) || state.mapCenter.length !== 2 ||
          !isFiniteNumber(state.mapCenter[0]) || !isFiniteNumber(state.mapCenter[1])) {
        return "mapCenter must be a [lon, lat] pair of finite numbers.";
      }
    }
    if (state.mapZoom != null && !isFiniteNumber(state.mapZoom)) {
      return "mapZoom must be a finite number.";
    }

    return null; // null = valid
  }

  // Keep the old name for any internal caller; both point at the same logic.
  function validateState(state) { return validateSessionState(state); }
  App.validateSessionState = validateSessionState;

  // ---- Export to JSON file ----

  function exportToFile(scope) {
    try {
      var state = collectState("full");
      if (scope === "visible") {
        // Filter this call's own copy of the collected state — collectState()
        // itself is untouched, so the localStorage autosave path (and
        // exportFullState/Save State) keep including hidden features as always.
        var arrs = getExportArrays(scope);
        state.points    = arrs.points;
        state.lines     = arrs.lines;
        state.routes    = arrs.routes;
        state.polygons  = arrs.polygons;
        state.labels    = arrs.labels;
        state.textBoxes = arrs.textBoxes;
      }
      var json = JSON.stringify(state, null, 2);
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);

      var now = new Date();
      var filename = "analysis" + _scopeSuffix(scope) + "-" + now.getFullYear() + "-" +
        String(now.getMonth() + 1).padStart(2, "0") + "-" +
        String(now.getDate()).padStart(2, "0") + ".json";

      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      App.setStatus("Exported " + filename);
    } catch (e) {
      console.warn("Export failed:", e);
      App.setStatus("Export failed: " + (e.message || e));
    }
  }

  // ---- Recent Projects (IndexedDB) ----
  // Persists FileSystemFileHandle objects so users can re-open recently
  // saved/loaded state files in one click on Chromium-based browsers.
  // FileSystemFileHandle objects are structured-cloneable into IDB.
  // Firefox/Safari don't support the File System Access API, so the recents
  // store stays empty there and the UI section hides itself.

  var IDB_NAME    = "mat-recents";
  var IDB_VERSION = 1;
  var IDB_STORE   = "projects";
  var MAX_RECENTS = 8;

  function _idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  function _idbTx(mode) {
    return _idbOpen().then(function (db) {
      return { db: db, store: db.transaction(IDB_STORE, mode).objectStore(IDB_STORE) };
    });
  }

  function _idbRequest(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  async function listRecents() {
    try {
      var ctx = await _idbTx("readonly");
      var all = await _idbRequest(ctx.store.getAll());
      ctx.db.close();
      // Newest first
      all.sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
      return all;
    } catch (e) {
      return [];
    }
  }

  async function removeRecent(id) {
    try {
      var ctx = await _idbTx("readwrite");
      await _idbRequest(ctx.store.delete(id));
      ctx.db.close();
    } catch (e) {
      console.warn("Remove recent failed:", e);
    }
  }

  async function clearRecents() {
    try {
      var ctx = await _idbTx("readwrite");
      await _idbRequest(ctx.store.clear());
      ctx.db.close();
    } catch (e) {
      console.warn("Clear recents failed:", e);
    }
  }

  // Dedupe: if an existing entry points at the same file handle, remove it
  // first so the newly-added entry becomes the most-recent one.
  async function _dedupeByHandle(store, handle) {
    var all = await _idbRequest(store.getAll());
    for (var i = 0; i < all.length; i++) {
      var entry = all[i];
      if (!entry || !entry.handle) continue;
      try {
        if (typeof entry.handle.isSameEntry === "function" &&
            await entry.handle.isSameEntry(handle)) {
          await _idbRequest(store.delete(entry.id));
        }
      } catch (e) { /* ignore */ }
    }
  }

  async function addRecent(handle, meta) {
    if (!handle) return;
    try {
      // Step 1: Read all entries in a short readonly tx, close immediately.
      var ctx = await _idbTx("readonly");
      var existing = await _idbRequest(ctx.store.getAll());
      ctx.db.close();

      // Step 2: isSameEntry() checks outside any IDB transaction.
      // IDB transactions auto-commit when no IDB requests are pending, so
      // mixing a File System Access API await (isSameEntry) inside a tx
      // invalidates it — all subsequent IDB calls would throw TransactionInactiveError.
      var toDelete = [];
      for (var i = 0; i < existing.length; i++) {
        var entry = existing[i];
        if (!entry || !entry.handle) continue;
        try {
          if (typeof entry.handle.isSameEntry === "function" &&
              await entry.handle.isSameEntry(handle)) {
            toDelete.push(entry.id);
          }
        } catch (e) { /* ignore */ }
      }

      // Step 3: Fresh readwrite tx for all writes (no non-IDB awaits inside).
      var wctx = await _idbTx("readwrite");
      for (var j = 0; j < toDelete.length; j++) {
        await _idbRequest(wctx.store.delete(toDelete[j]));
      }
      await _idbRequest(wctx.store.add({
        handle:  handle,
        name:    handle.name || (meta && meta.name) || "state.json",
        savedAt: Date.now(),
        source:  (meta && meta.source) || "save"
      }));

      // Evict oldest entries beyond MAX_RECENTS
      var all = await _idbRequest(wctx.store.getAll());
      all.sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0); }); // oldest first
      while (all.length > MAX_RECENTS) {
        var oldest = all.shift();
        await _idbRequest(wctx.store.delete(oldest.id));
      }
      wctx.db.close();

      if (typeof App.onRecentsChanged === "function") App.onRecentsChanged();
    } catch (e) {
      console.warn("Add recent failed:", e);
    }
  }

  // Re-open a recent project: request permission, read the file, apply it.
  // Removes the entry and surfaces a clear error if the file was moved or
  // deleted, or if permission was denied.
  async function openRecent(id) {
    var entry = null;
    try {
      var ctx = await _idbTx("readonly");
      entry = await _idbRequest(ctx.store.get(id));
      ctx.db.close();
    } catch (e) { /* ignore */ }
    if (!entry || !entry.handle) {
      alert("Could not open this recent project (missing handle).");
      await removeRecent(id);
      if (typeof App.onRecentsChanged === "function") App.onRecentsChanged();
      return;
    }

    var handle = entry.handle;
    try {
      var perm = await handle.queryPermission({ mode: "read" });
      if (perm !== "granted") {
        perm = await handle.requestPermission({ mode: "read" });
      }
      if (perm !== "granted") {
        alert("Permission to read '" + entry.name + "' was denied.");
        return;
      }
      var file = await handle.getFile();
      importFullState(file, handle);
    } catch (e) {
      console.warn("Open recent failed:", e);
      var msg = "Could not open '" + entry.name + "'.";
      if (e && (e.name === "NotFoundError" || /not found/i.test(String(e.message)))) {
        msg += " The file may have been moved, renamed, or deleted.";
      } else if (e && e.message) {
        msg += " " + e.message;
      }
      if (confirm(msg + "\n\nRemove this entry from Recent Projects?")) {
        await removeRecent(id);
        if (typeof App.onRecentsChanged === "function") App.onRecentsChanged();
      }
    }
  }

  // ---- Export full session state (features + LODES + GTFS) ----
  // Produces a self-contained JSON file so a refresh can restore all uploaded
  // data in one step. Schema version 3 adds lodesData + gtfsData keys; v2
  // sessions (features only) still import cleanly since those keys are guarded.

  async function exportFullState() {
    try {
      var state = collectState("full");
      state.version = 3;
      state.exportType = "full-state";
      state.lodesData = (typeof App.serializeLodesData === "function")
        ? App.serializeLodesData() : null;
      state.gtfsData  = (typeof App.serializeGTFSData  === "function")
        ? App.serializeGTFSData()  : null;

      var json = JSON.stringify(state);
      if (json.length > 50 * 1024 * 1024) {
        var sizeMB = (json.length / 1024 / 1024).toFixed(1);
        if (!confirm("Save file is " + sizeMB + " MB. Continue?")) return;
      }

      var defaultName = "session-state-" + _dateStamp() + ".json";
      var blob = new Blob([json], { type: "application/json" });

      // Chrome / Edge: native OS Save As dialog (user picks directory + filename)
      if (typeof window.showSaveFilePicker === "function") {
        var handle;
        try {
          handle = await window.showSaveFilePicker({
            suggestedName: defaultName,
            types: [{ description: "JSON Session File", accept: { "application/json": [".json"] } }]
          });
        } catch (e) {
          if (e.name === "AbortError") return;   // user hit Cancel
          throw e;
        }
        var writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        App.setStatus("Saved state to " + handle.name);
        addRecent(handle, { source: "save" });

      } else {
        // Firefox / Safari fallback: prompt for name, anchor-download to default folder
        var entered = window.prompt("Save state as:", defaultName.replace(/\.json$/i, ""));
        if (entered === null) return;
        var filename = (String(entered).trim() || defaultName).replace(/\.json$/i, "") + ".json";
        _triggerDownload(blob, filename);
        App.setStatus("Saved state to " + filename);
      }
    } catch (e) {
      console.warn("Save state failed:", e);
      App.setStatus("Save state failed: " + (e.message || e));
    }
  }

  // ---- Import full session state ----

  function importFullState(file, handle) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var state = JSON.parse(e.target.result);
        var err = validateState(state);
        if (err) {
          App.setStatus("Load state failed");
          alert("Load state failed: " + err);
          return;
        }

        var hasExisting = (App.points.length > 0 || App.lines.length > 0 ||
                           App.routes.length > 0 || App.polygons.length > 0);
        if (hasExisting) {
          if (!confirm("Load state will replace all current features, settings, and uploaded data. Continue?")) {
            return;
          }
        }

        if (typeof App.exitEditMode === "function") App.exitEditMode();

        applyState(state);
        save();

        // v3 additions: LODES + GTFS payloads. Guarded so v2 files still load.
        if (state.lodesData && typeof App.restoreLodesFromData === "function") {
          try {
            App.restoreLodesFromData(state.lodesData.entries, state.lodesData.meta);
          } catch (lodesErr) {
            console.warn("LODES restore failed:", lodesErr);
          }
        }
        if (state.gtfsData && typeof App.restoreGTFSFromData === "function") {
          try {
            App.restoreGTFSFromData(state.gtfsData);
          } catch (gtfsErr) {
            console.warn("GTFS restore failed:", gtfsErr);
          }
        }

        if (typeof App._syncDisplaySliders === "function") App._syncDisplaySliders();
        if (typeof App.notifyProject === "function") App.notifyProject();

        var nFeatures = App.points.length + App.lines.length +
          App.routes.length + App.polygons.length +
          (App.labels ? App.labels.length : 0);
        App.setStatus("Loaded state (" + nFeatures + " feature" + (nFeatures !== 1 ? "s" : "") + ")");

        if (handle) addRecent(handle, { source: "load" });
      } catch (parseErr) {
        App.setStatus("Load state failed");
        alert("Load state failed: " + (parseErr && parseErr.message ?
          parseErr.message :
          "the file does not contain valid JSON."));
      }
    };

    reader.onerror = function () {
      App.setStatus("Load state failed");
      alert("Load state failed: could not read file.");
    };

    reader.readAsText(file);
  }

  // ---- Import from JSON file ----

  function importFromFile(file) {
    var reader = new FileReader();

    reader.onload = function (e) {
      try {
        var state = JSON.parse(e.target.result);
        var err = validateState(state);
        if (err) {
          App.setStatus("Import failed");
          alert("Import failed: " + err);
          return;
        }

        // Confirm if replacing existing features
        var hasExisting = (App.points.length > 0 || App.lines.length > 0 ||
                           App.routes.length > 0 || App.polygons.length > 0);
        if (hasExisting) {
          if (!confirm("Import will replace all current features and settings. Continue?")) {
            return;
          }
        }

        // Exit edit mode if active (handles would reference stale features)
        if (typeof App.exitEditMode === "function") App.exitEditMode();

        applyState(state);
        save(); // persist imported state to localStorage

        if (typeof App._syncDisplaySliders === "function") App._syncDisplaySliders();
        if (typeof App.notifyProject === "function") App.notifyProject();

        var nFeatures = App.points.length + App.lines.length + App.routes.length + App.polygons.length + (App.labels ? App.labels.length : 0);
        App.setStatus("Imported " + nFeatures + " feature" + (nFeatures !== 1 ? "s" : ""));
      } catch (parseErr) {
        App.setStatus("Import failed");
        alert("Import failed: " + (parseErr && parseErr.message ?
          parseErr.message :
          "the file does not contain valid JSON."));
      }
    };

    reader.onerror = function () {
      App.setStatus("Import failed");
      alert("Import failed: could not read file.");
    };

    reader.readAsText(file);
  }

  // ---- Shared download helper ----

  function _triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function _dateStamp() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  // Suffix inserted into export filenames when scope is "visible", so
  // exporting All then Visible-only back to back doesn't overwrite one file
  // with the other.
  function _scopeSuffix(scope) {
    return scope === "visible" ? "-visible" : "";
  }

  // ---- Export scope: All vs Visible only ----
  // Used by every feature-data export (JSON, CSV, KML, SHP) to optionally
  // drop features hidden via the eye icon (Feature Panel or Layers panel —
  // same `properties.hidden` flag either way). Does not affect session
  // save/restore (collectState) or Share Link/Save State, which always
  // operate on the full, true data set.
  function getExportArrays(scope) {
    var visible = scope === "visible";
    function filt(arr) {
      return visible ? arr.filter(function (f) { return !f.properties.hidden; }) : arr.slice();
    }
    return {
      points:    filt(App.points),
      lines:     filt(App.lines),
      routes:    filt(App.routes),
      polygons:  filt(App.polygons),
      labels:    App.labels    ? filt(App.labels)    : [],
      textBoxes: App.textBoxes ? filt(App.textBoxes) : []
    };
  }

  // ---- Export: JSON (Features only) ----

  function exportFeaturesOnly(scope) {
    try {
      var arrs = getExportArrays(scope);
      var state = {
        version: SCHEMA_VERSION,
        exportType: "features",
        points: arrs.points,
        lines: arrs.lines,
        routes: arrs.routes,
        polygons: arrs.polygons,
        labels: arrs.labels,
        bufferRadius:      (App.featureSettings && App.featureSettings.bufferRadius      != null) ? App.featureSettings.bufferRadius      : 0.5,
        lineBufferRadius:  (App.featureSettings && App.featureSettings.lineBufferRadius  != null) ? App.featureSettings.lineBufferRadius  : 0.5,
        routeBufferRadius: (App.featureSettings && App.featureSettings.routeBufferRadius != null) ? App.featureSettings.routeBufferRadius : 0.5
      };
      var json = JSON.stringify(state, null, 2);
      var blob = new Blob([json], { type: "application/json" });
      var filename = "features" + _scopeSuffix(scope) + "-" + _dateStamp() + ".json";
      _triggerDownload(blob, filename);
      App.setStatus("Exported " + filename);
    } catch (e) {
      console.warn("Export failed:", e);
      App.setStatus("Export failed: " + (e.message || e));
    }
  }

  // ---- Export: CSV ----

  var CSV_ATTR_COLS = [
    "group", "routeGroup", "direction", "mode", "serviceId", "avgSpeed",
    "service", "lineMode", "notes", "stopId", "pointGroup", "lineGroup",
    "polygonGroup", "labelGroup"
  ];

  function _featureToCSVRow(feat, typeName) {
    var geom = feat.geometry || {};
    var props = feat.properties || {};
    var attrs = props.attributes || {};
    var coords = geom.coordinates || [];
    var lon = "", lat = "";
    if (geom.type === "Point" && coords.length >= 2) {
      lon = coords[0]; lat = coords[1];
    } else if (coords.length > 0) {
      var first = coords;
      while (Array.isArray(first[0])) first = first[0];
      if (first.length >= 2) { lon = first[0]; lat = first[1]; }
    }
    var row = {
      type: typeName,
      name: props.name || "",
      color: props.color || "",
      geometry_type: geom.type || "",
      coordinates: JSON.stringify(coords),
      longitude: lon,
      latitude: lat
    };
    for (var i = 0; i < CSV_ATTR_COLS.length; i++) {
      var key = CSV_ATTR_COLS[i];
      var val = attrs[key];
      if (val == null) {
        row[key] = "";
      } else if (typeof val === "object") {
        row[key] = JSON.stringify(val);
      } else {
        row[key] = String(val);
      }
    }
    return row;
  }

  function exportCSV(scope) {
    try {
      var hadSource = App.points.length + App.lines.length + App.routes.length +
        App.polygons.length + (App.labels ? App.labels.length : 0) > 0;
      var arrs = getExportArrays(scope);
      var rows = [];
      for (var si = 0; si < arrs.points.length; si++) rows.push(_featureToCSVRow(arrs.points[si], "point"));
      for (var li = 0; li < arrs.lines.length; li++) rows.push(_featureToCSVRow(arrs.lines[li], "line"));
      for (var ri = 0; ri < arrs.routes.length; ri++) rows.push(_featureToCSVRow(arrs.routes[ri], "route"));
      for (var pi = 0; pi < arrs.polygons.length; pi++) rows.push(_featureToCSVRow(arrs.polygons[pi], "polygon"));
      for (var lb = 0; lb < arrs.labels.length; lb++) rows.push(_featureToCSVRow(arrs.labels[lb], "label"));
      if (rows.length === 0) {
        App.setStatus(hadSource && scope === "visible"
          ? "Nothing to export — all features are hidden."
          : "Nothing to export — no features drawn.");
        return;
      }
      var csv = Papa.unparse(rows);
      var blob = new Blob([csv], { type: "text/csv" });
      var filename = "features" + _scopeSuffix(scope) + "-" + _dateStamp() + ".csv";
      _triggerDownload(blob, filename);
      App.setStatus("Exported " + filename);
    } catch (e) {
      console.warn("CSV export failed:", e);
      App.setStatus("CSV export failed: " + (e.message || e));
    }
  }

  // ---- Export: KML ----

  function _hexToKmlColor(hex) {
    // Convert #RRGGBB to KML aaBBGGRR (fully opaque)
    hex = (hex || "#3182ce").replace("#", "");
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = hex.substring(0, 2), g = hex.substring(2, 4), b = hex.substring(4, 6);
    return "ff" + b + g + r;
  }

  function _coordsToKmlString(coords) {
    // coords is [lon,lat] or [[lon,lat],...] or [[[lon,lat],...]]
    if (typeof coords[0] === "number") {
      return coords[0] + "," + coords[1] + ",0";
    }
    var flat = coords;
    // Unwrap one level for polygons (outer ring)
    if (Array.isArray(flat[0]) && Array.isArray(flat[0][0])) flat = flat[0];
    var parts = [];
    for (var i = 0; i < flat.length; i++) {
      parts.push(flat[i][0] + "," + flat[i][1] + ",0");
    }
    return parts.join(" ");
  }

  function _xmlEscape(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function _buildPlacemark(feat, typeName) {
    var props = feat.properties || {};
    var attrs = props.attributes || {};
    var geom = feat.geometry || {};
    var name = props.name || typeName;
    var color = _hexToKmlColor(props.color);
    var kml = "    <Placemark>\n";
    kml += "      <name>" + _xmlEscape(name) + "</name>\n";
    kml += "      <Style><IconStyle><color>" + color + "</color></IconStyle>";
    kml += "<LineStyle><color>" + color + "</color><width>3</width></LineStyle>";
    kml += "<PolyStyle><color>" + color.substring(0, 2) + "80" + color.substring(4) + "</color></PolyStyle></Style>\n";

    // ExtendedData for attributes
    var attrKeys = Object.keys(attrs);
    if (attrKeys.length > 0 || typeName) {
      kml += "      <ExtendedData>\n";
      kml += "        <Data name=\"type\"><value>" + _xmlEscape(typeName) + "</value></Data>\n";
      for (var i = 0; i < attrKeys.length; i++) {
        var v = attrs[attrKeys[i]];
        if (v != null && v !== "") {
          kml += "        <Data name=\"" + _xmlEscape(attrKeys[i]) + "\"><value>" + _xmlEscape(v) + "</value></Data>\n";
        }
      }
      kml += "      </ExtendedData>\n";
    }

    // Geometry
    if (geom.type === "Point") {
      kml += "      <Point><coordinates>" + _coordsToKmlString(geom.coordinates) + "</coordinates></Point>\n";
    } else if (geom.type === "LineString") {
      kml += "      <LineString><coordinates>" + _coordsToKmlString(geom.coordinates) + "</coordinates></LineString>\n";
    } else if (geom.type === "Polygon") {
      kml += "      <Polygon><outerBoundaryIs><LinearRing><coordinates>" +
        _coordsToKmlString(geom.coordinates) +
        "</coordinates></LinearRing></outerBoundaryIs></Polygon>\n";
    }
    kml += "    </Placemark>\n";
    return kml;
  }

  function exportKML(scope) {
    try {
      var hadSource = App.points.length + App.lines.length + App.routes.length +
        App.polygons.length + (App.labels ? App.labels.length : 0) > 0;
      var arrs = getExportArrays(scope);
      var kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n';
      kml += "  <name>Micro Analysis Tool Export</name>\n";

      var groups = [
        { name: "Points", items: arrs.points, type: "point" },
        { name: "Lines", items: arrs.lines, type: "line" },
        { name: "Routes", items: arrs.routes, type: "route" },
        { name: "Polygons", items: arrs.polygons, type: "polygon" }
      ];
      if (arrs.labels.length > 0) {
        groups.push({ name: "Labels", items: arrs.labels, type: "label" });
      }

      var totalCount = 0;
      for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        if (g.items.length === 0) continue;
        totalCount += g.items.length;
        kml += "  <Folder>\n    <name>" + g.name + "</name>\n";
        for (var fi = 0; fi < g.items.length; fi++) {
          kml += _buildPlacemark(g.items[fi], g.type);
        }
        kml += "  </Folder>\n";
      }

      kml += "</Document>\n</kml>";

      if (totalCount === 0) {
        App.setStatus(hadSource && scope === "visible"
          ? "Nothing to export — all features are hidden."
          : "Nothing to export — no features drawn.");
        return;
      }

      var blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
      var filename = "features" + _scopeSuffix(scope) + "-" + _dateStamp() + ".kml";
      _triggerDownload(blob, filename);
      App.setStatus("Exported " + filename);
    } catch (e) {
      console.warn("KML export failed:", e);
      App.setStatus("KML export failed: " + (e.message || e));
    }
  }

  // ---- Export: Shapefile (SHP) — self-contained binary writer ----
  // Uses JSZip v3 (already loaded globally). No external shp-write dependency.

  var SHP_PRJ_WGS84 =
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

  // SHP shape type constants
  var SHP_NULL = 0, SHP_POINT = 1, SHP_POLYLINE = 3, SHP_POLYGON = 5;

  function _featureProps(feat, typeName) {
    var props = feat.properties || {};
    var attrs = props.attributes || {};
    var out = { name: (props.name || "").substring(0, 50), type: typeName, color: props.color || "" };
    for (var i = 0; i < CSV_ATTR_COLS.length; i++) {
      var key = CSV_ATTR_COLS[i];
      var val = attrs[key];
      var dbfKey = key.substring(0, 10);
      out[dbfKey] = (val != null) ? String(val).substring(0, 254) : "";
    }
    return out;
  }

  // Collect coordinate rings from a geometry. Returns array of arrays of [x,y].
  // For Point: [[x,y]]. For LineString: [coords]. For Polygon: rings.
  // For Multi* types: flattens into parts array.
  function _extractParts(geometry) {
    var type = geometry.type;
    var coords = geometry.coordinates;
    if (type === "Point")              return [[coords]];
    if (type === "MultiPoint")         return coords.map(function (c) { return [c]; });
    if (type === "LineString")         return [coords];
    if (type === "MultiLineString")    return coords;
    if (type === "Polygon")            return coords;
    if (type === "MultiPolygon") {
      var parts = [];
      for (var i = 0; i < coords.length; i++) {
        for (var j = 0; j < coords[i].length; j++) parts.push(coords[i][j]);
      }
      return parts;
    }
    return [];
  }

  // Compute bounding box from an array of features
  function _bbox(features) {
    var xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (var fi = 0; fi < features.length; fi++) {
      var parts = _extractParts(features[fi].geometry);
      for (var pi = 0; pi < parts.length; pi++) {
        for (var ci = 0; ci < parts[pi].length; ci++) {
          var x = parts[pi][ci][0], y = parts[pi][ci][1];
          if (x < xmin) xmin = x; if (x > xmax) xmax = x;
          if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
      }
    }
    if (xmin === Infinity) { xmin = ymin = xmax = ymax = 0; }
    return { xmin: xmin, ymin: ymin, xmax: xmax, ymax: ymax };
  }

  // Ensure polygon ring is clockwise (exterior) per SHP spec.
  // Shapefile spec: exterior rings are clockwise, holes are counter-clockwise.
  function _ensureClockwise(ring) {
    var area = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      area += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
    }
    // area > 0 → clockwise in screen coords, but since Y is latitude (up = positive),
    // positive signed area means counter-clockwise geographically → need to reverse
    if (area > 0) ring.reverse();
    return ring;
  }

  // Write SHP + SHX binary for a set of features of the same shape type.
  // shapeType: SHP_POINT, SHP_POLYLINE, or SHP_POLYGON
  function _writeSHPSHX(features, shapeType) {
    // First pass: compute record content sizes
    var recordContentSizes = [];
    for (var fi = 0; fi < features.length; fi++) {
      var parts = _extractParts(features[fi].geometry);
      if (shapeType === SHP_POINT) {
        // Shape type (4) + X (8) + Y (8) = 20 bytes
        recordContentSizes.push(20);
      } else {
        // Shape type (4) + bbox (32) + numParts (4) + numPoints (4) + parts array + points
        var totalPts = 0;
        for (var pi = 0; pi < parts.length; pi++) {
          if (shapeType === SHP_POLYGON) _ensureClockwise(parts[pi]);
          totalPts += parts[pi].length;
        }
        recordContentSizes.push(4 + 32 + 4 + 4 + parts.length * 4 + totalPts * 16);
      }
    }

    // Calculate file sizes
    var shpFileBodySize = 0;
    for (var ri = 0; ri < recordContentSizes.length; ri++) {
      shpFileBodySize += 8 + recordContentSizes[ri]; // 8 = record header
    }
    var shpFileLength = 100 + shpFileBodySize; // in bytes
    var shxFileLength = 100 + features.length * 8;

    var shpBuf = new ArrayBuffer(shpFileLength);
    var shxBuf = new ArrayBuffer(shxFileLength);
    var shpView = new DataView(shpBuf);
    var shxView = new DataView(shxBuf);

    var box = _bbox(features);

    // Write file headers (100 bytes each) for both SHP and SHX
    function writeHeader(view, fileLengthBytes) {
      view.setInt32(0, 9994, false);                   // file code (big-endian)
      // bytes 4-23: unused (zeros)
      view.setInt32(24, fileLengthBytes / 2, false);   // file length in 16-bit words (big-endian)
      view.setInt32(28, 1000, true);                   // version (little-endian)
      view.setInt32(32, shapeType, true);               // shape type
      view.setFloat64(36, box.xmin, true);
      view.setFloat64(44, box.ymin, true);
      view.setFloat64(52, box.xmax, true);
      view.setFloat64(60, box.ymax, true);
      // bytes 68-99: zmin/zmax/mmin/mmax = 0 (2D only)
    }
    writeHeader(shpView, shpFileLength);
    writeHeader(shxView, shxFileLength);

    // Write records
    var shpOffset = 100; // current byte offset in SHP file
    for (var fi2 = 0; fi2 < features.length; fi2++) {
      var contentSize = recordContentSizes[fi2];
      var parts2 = _extractParts(features[fi2].geometry);

      // SHX index entry: offset and content length in 16-bit words (big-endian)
      shxView.setInt32(100 + fi2 * 8, shpOffset / 2, false);
      shxView.setInt32(100 + fi2 * 8 + 4, contentSize / 2, false);

      // SHP record header: record number (1-based) and content length in 16-bit words (big-endian)
      shpView.setInt32(shpOffset, fi2 + 1, false);
      shpView.setInt32(shpOffset + 4, contentSize / 2, false);
      shpOffset += 8;

      // SHP record content
      shpView.setInt32(shpOffset, shapeType, true);
      shpOffset += 4;

      if (shapeType === SHP_POINT) {
        var pt = features[fi2].geometry.coordinates;
        shpView.setFloat64(shpOffset, pt[0], true); shpOffset += 8;
        shpView.setFloat64(shpOffset, pt[1], true); shpOffset += 8;
      } else {
        // Bounding box for this record
        var recBox = _bbox([features[fi2]]);
        shpView.setFloat64(shpOffset, recBox.xmin, true); shpOffset += 8;
        shpView.setFloat64(shpOffset, recBox.ymin, true); shpOffset += 8;
        shpView.setFloat64(shpOffset, recBox.xmax, true); shpOffset += 8;
        shpView.setFloat64(shpOffset, recBox.ymax, true); shpOffset += 8;

        var numParts = parts2.length;
        var totalPoints = 0;
        for (var pp = 0; pp < numParts; pp++) totalPoints += parts2[pp].length;

        shpView.setInt32(shpOffset, numParts, true); shpOffset += 4;
        shpView.setInt32(shpOffset, totalPoints, true); shpOffset += 4;

        // Parts index array (offset into points array for each part)
        var ptIdx = 0;
        for (var pp2 = 0; pp2 < numParts; pp2++) {
          shpView.setInt32(shpOffset, ptIdx, true); shpOffset += 4;
          ptIdx += parts2[pp2].length;
        }

        // Points (x, y pairs)
        for (var pp3 = 0; pp3 < numParts; pp3++) {
          for (var ci2 = 0; ci2 < parts2[pp3].length; ci2++) {
            shpView.setFloat64(shpOffset, parts2[pp3][ci2][0], true); shpOffset += 8;
            shpView.setFloat64(shpOffset, parts2[pp3][ci2][1], true); shpOffset += 8;
          }
        }
      }
    }

    return { shp: shpBuf, shx: shxBuf };
  }

  // Write a DBF file for a set of features with given property objects.
  function _writeDBF(propsList) {
    if (!propsList.length) return new ArrayBuffer(0);

    // Determine fields from first record's keys
    var keys = Object.keys(propsList[0]);
    var fields = [];
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      // Determine max value length for field width
      var maxLen = 10;
      for (var ri = 0; ri < propsList.length; ri++) {
        var v = propsList[ri][k];
        var vLen = (v != null) ? String(v).length : 0;
        if (vLen > maxLen) maxLen = vLen;
      }
      if (maxLen > 254) maxLen = 254;
      fields.push({ name: k.substring(0, 10), width: maxLen });
    }

    var numRecords = propsList.length;
    var numFields = fields.length;
    var headerSize = 32 + numFields * 32 + 1; // 1 for header terminator (0x0D)
    var recordWidth = 1; // 1 byte for deletion flag
    for (var fi = 0; fi < numFields; fi++) recordWidth += fields[fi].width;
    var fileSize = headerSize + numRecords * recordWidth + 1; // +1 for EOF marker (0x1A)

    var buf = new ArrayBuffer(fileSize);
    var view = new DataView(buf);
    var bytes = new Uint8Array(buf);

    // DBF header
    view.setUint8(0, 3);                          // version: dBASE III
    var now = new Date();
    view.setUint8(1, now.getFullYear() - 1900);   // year
    view.setUint8(2, now.getMonth() + 1);          // month
    view.setUint8(3, now.getDate());               // day
    view.setInt32(4, numRecords, true);             // number of records
    view.setInt16(8, headerSize, true);             // header size
    view.setInt16(10, recordWidth, true);           // record size

    // Field descriptors (32 bytes each)
    for (var fi2 = 0; fi2 < numFields; fi2++) {
      var fdOffset = 32 + fi2 * 32;
      var nameBytes = [];
      for (var ni = 0; ni < 11; ni++) {
        nameBytes.push(ni < fields[fi2].name.length ? fields[fi2].name.charCodeAt(ni) : 0);
      }
      for (var ni2 = 0; ni2 < 11; ni2++) bytes[fdOffset + ni2] = nameBytes[ni2];
      bytes[fdOffset + 11] = 67;  // field type 'C' (character)
      view.setUint8(fdOffset + 16, fields[fi2].width);  // field length
    }

    // Header terminator
    bytes[headerSize - 1] = 0x0D;

    // Records
    for (var ri2 = 0; ri2 < numRecords; ri2++) {
      var recOffset = headerSize + ri2 * recordWidth;
      bytes[recOffset] = 0x20; // deletion flag: space = not deleted
      var fieldOffset = recOffset + 1;
      for (var fi3 = 0; fi3 < numFields; fi3++) {
        var val = propsList[ri2][keys[fi3]];
        var str = (val != null) ? String(val) : "";
        // Right-pad with spaces to field width
        while (str.length < fields[fi3].width) str += " ";
        str = str.substring(0, fields[fi3].width);
        for (var si = 0; si < str.length; si++) {
          bytes[fieldOffset + si] = str.charCodeAt(si) & 0xFF;
        }
        fieldOffset += fields[fi3].width;
      }
    }

    // EOF marker
    bytes[fileSize - 1] = 0x1A;

    return buf;
  }

  function exportSHP(scope) {
    if (typeof JSZip === "undefined") {
      alert("JSZip library not loaded. Please check your internet connection and reload.");
      return;
    }
    try {
      var hadSource = App.points.length + App.lines.length + App.routes.length + App.polygons.length > 0;
      var arrs = getExportArrays(scope);
      var points = [], polylines = [], polys = [];
      var pointProps = [], polylineProps = [], polyProps = [];

      for (var si = 0; si < arrs.points.length; si++) {
        var s = arrs.points[si];
        if (!s.geometry) continue;
        points.push({ geometry: s.geometry, properties: s.properties });
        pointProps.push(_featureProps(s, "point"));
      }
      for (var li = 0; li < arrs.lines.length; li++) {
        var l = arrs.lines[li];
        if (!l.geometry) continue;
        polylines.push({ geometry: l.geometry, properties: l.properties });
        polylineProps.push(_featureProps(l, "line"));
      }
      for (var ri = 0; ri < arrs.routes.length; ri++) {
        var r = arrs.routes[ri];
        if (!r.geometry) continue;
        polylines.push({ geometry: r.geometry, properties: r.properties });
        polylineProps.push(_featureProps(r, "route"));
      }
      for (var pi = 0; pi < arrs.polygons.length; pi++) {
        var p = arrs.polygons[pi];
        if (!p.geometry) continue;
        polys.push({ geometry: p.geometry, properties: p.properties });
        polyProps.push(_featureProps(p, "polygon"));
      }

      if (points.length + polylines.length + polys.length === 0) {
        App.setStatus(hadSource && scope === "visible"
          ? "Nothing to export — all features are hidden."
          : "Nothing to export — no features drawn.");
        return;
      }

      var zip = new JSZip();

      // Write each geometry-type layer as a set of .shp/.shx/.dbf/.prj files
      if (points.length) {
        var ptFiles = _writeSHPSHX(points, SHP_POINT);
        zip.file("points.shp", ptFiles.shp);
        zip.file("points.shx", ptFiles.shx);
        zip.file("points.dbf", _writeDBF(pointProps));
        zip.file("points.prj", SHP_PRJ_WGS84);
      }
      if (polylines.length) {
        var lnFiles = _writeSHPSHX(polylines, SHP_POLYLINE);
        zip.file("lines_routes.shp", lnFiles.shp);
        zip.file("lines_routes.shx", lnFiles.shx);
        zip.file("lines_routes.dbf", _writeDBF(polylineProps));
        zip.file("lines_routes.prj", SHP_PRJ_WGS84);
      }
      if (polys.length) {
        var pgFiles = _writeSHPSHX(polys, SHP_POLYGON);
        zip.file("polygons.shp", pgFiles.shp);
        zip.file("polygons.shx", pgFiles.shx);
        zip.file("polygons.dbf", _writeDBF(polyProps));
        zip.file("polygons.prj", SHP_PRJ_WGS84);
      }

      var filename = "features" + _scopeSuffix(scope) + "-" + _dateStamp() + ".zip";
      App.setStatus("Generating shapefile...");

      zip.generateAsync({ type: "blob" }).then(function (blob) {
        _triggerDownload(blob, filename);
        App.setStatus("Exported " + filename);
      }).catch(function (err) {
        console.error("SHP export failed:", err);
        App.setStatus("SHP export failed: " + (err.message || err));
      });
    } catch (e) {
      console.error("SHP export failed:", e);
      App.setStatus("SHP export failed: " + (e.message || e));
    }
  }

  // ---- Import helpers ----

  var MAX_FILE_SIZE = 50 * 1024 * 1024;   // 50 MB hard limit
  var WARN_FILE_SIZE = 10 * 1024 * 1024;   // 10 MB soft warning

  function _checkFileSize(file) {
    if (file.size > MAX_FILE_SIZE) {
      alert("File too large (" + Math.round(file.size / 1024 / 1024) + " MB). Maximum is 50 MB.");
      return false;
    }
    if (file.size > WARN_FILE_SIZE) {
      if (!confirm("This file is " + Math.round(file.size / 1024 / 1024) + " MB. Large files may be slow. Continue?")) {
        return false;
      }
    }
    return true;
  }

  function _confirmReplace() {
    var hasExisting = (App.points.length > 0 || App.lines.length > 0 ||
                       App.routes.length > 0 || App.polygons.length > 0);
    if (hasExisting) {
      return confirm("Import will replace all current features. Continue?");
    }
    return true;
  }

  function _applyImportedFeatures(pts, lines, polygons, labels) {
    if (typeof App.exitEditMode === "function") App.exitEditMode();

    // Build minimal state for applyState
    var state = {
      version: SCHEMA_VERSION,
      points: pts || [],
      lines: lines || [],
      routes: [],
      polygons: polygons || [],
      labels: labels || [],
      bufferRadius:      (App.featureSettings && App.featureSettings.bufferRadius      != null) ? App.featureSettings.bufferRadius      : 0.5,
      lineBufferRadius:  (App.featureSettings && App.featureSettings.lineBufferRadius  != null) ? App.featureSettings.lineBufferRadius  : 0.5,
      routeBufferRadius: (App.featureSettings && App.featureSettings.routeBufferRadius != null) ? App.featureSettings.routeBufferRadius : 0.5
    };
    applyState(state);
    save();
    if (typeof App.notifyProject === "function") App.notifyProject();

    var n = state.points.length + state.lines.length + state.polygons.length + state.labels.length;
    App.setStatus("Imported " + n + " feature" + (n !== 1 ? "s" : ""));
  }

  function _makeFeature(geomType, coordinates, name, color, attrs) {
    var feat = {
      type: "Feature",
      geometry: { type: geomType, coordinates: coordinates },
      properties: { name: name || "", color: color || "" }
    };
    if (attrs && Object.keys(attrs).length > 0) {
      feat.properties.attributes = attrs;
    }
    return feat;
  }

  // ---- Import: CSV ----

  function importCSV(file) {
    if (!_checkFileSize(file)) return;

    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var result = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
        var rows = result.data || [];
        var headers = result.meta && result.meta.fields ? result.meta.fields : [];

        if (rows.length === 0) {
          alert("CSV file is empty or has no data rows.");
          return;
        }

        // Detect columns
        var hasGeomType = headers.indexOf("geometry_type") >= 0;
        var hasCoords = headers.indexOf("coordinates") >= 0;
        var hasLatLon = headers.indexOf("latitude") >= 0 && headers.indexOf("longitude") >= 0;

        if (!hasCoords && !hasLatLon) {
          alert("CSV must have either a 'coordinates' column or 'latitude' + 'longitude' columns.");
          return;
        }

        if (!_confirmReplace()) return;

        var ptFeats = [], lineFeats = [], polygonFeats = [], labelFeats = [];
        var errors = 0;

        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var geomType = hasGeomType ? (row.geometry_type || "").trim() : "";
          var typeName = (row.type || "").toLowerCase().trim();
          var name = row.name || "";
          var color = row.color || "";

          var coords = null;
          if (hasCoords && row.coordinates) {
            try {
              coords = JSON.parse(row.coordinates);
            } catch (pe) {
              errors++;
              continue;
            }
          } else if (hasLatLon) {
            var lat = parseFloat(row.latitude);
            var lon = parseFloat(row.longitude);
            if (isFinite(lat) && isFinite(lon)) {
              coords = [lon, lat];
              if (!geomType) geomType = "Point";
            } else {
              errors++;
              continue;
            }
          }

          if (!coords) { errors++; continue; }

          // Collect known attribute columns
          var attrs = {};
          for (var ai = 0; ai < CSV_ATTR_COLS.length; ai++) {
            var key = CSV_ATTR_COLS[ai];
            if (row[key] != null && row[key] !== "") attrs[key] = row[key];
          }

          // Determine feature type from geometry_type or type column
          var gType = geomType || "Point";
          var feat = _makeFeature(gType, coords, name, color, attrs);

          if (gType === "Point" || typeName === "point" || typeName === "station") {
            feat.geometry.type = "Point";
            ptFeats.push(feat);
          } else if (gType === "LineString" || typeName === "line" || typeName === "route") {
            feat.geometry.type = "LineString";
            lineFeats.push(feat);
          } else if (gType === "Polygon" || typeName === "polygon") {
            feat.geometry.type = "Polygon";
            polygonFeats.push(feat);
          } else if (typeName === "label") {
            labelFeats.push(feat);
          } else {
            // Fallback: point if coords is simple pair, else line
            if (typeof coords[0] === "number" && !Array.isArray(coords[0])) {
              feat.geometry.type = "Point";
              ptFeats.push(feat);
            } else {
              feat.geometry.type = "LineString";
              lineFeats.push(feat);
            }
          }
        }

        var total = ptFeats.length + lineFeats.length + polygonFeats.length + labelFeats.length;
        if (total === 0) {
          alert("No valid features found in CSV." + (errors > 0 ? " (" + errors + " rows had errors)" : ""));
          return;
        }

        _applyImportedFeatures(ptFeats, lineFeats, polygonFeats, labelFeats);
        if (errors > 0) App.setStatus("Imported " + total + " features (" + errors + " rows skipped)");
      } catch (err) {
        App.setStatus("CSV import failed");
        alert("CSV import failed: " + (err.message || err));
      }
    };
    reader.onerror = function () {
      alert("Could not read file.");
    };
    reader.readAsText(file);
  }

  // ---- Import: KML ----

  function _kmlColorToHex(kmlColor) {
    // KML color is aaBBGGRR — convert to #RRGGBB
    if (!kmlColor || kmlColor.length < 8) return "";
    var rr = kmlColor.substring(6, 8);
    var gg = kmlColor.substring(4, 6);
    var bb = kmlColor.substring(2, 4);
    return "#" + rr + gg + bb;
  }

  function _parseKmlCoords(text) {
    // KML coordinates: "lon,lat,alt lon,lat,alt ..."
    var pairs = text.trim().split(/\s+/);
    var coords = [];
    for (var i = 0; i < pairs.length; i++) {
      var parts = pairs[i].split(",");
      if (parts.length >= 2) {
        var lon = parseFloat(parts[0]);
        var lat = parseFloat(parts[1]);
        if (isFinite(lon) && isFinite(lat)) coords.push([lon, lat]);
      }
    }
    return coords;
  }

  function _processKmlDoc(doc) {
    var placemarks = doc.getElementsByTagName("Placemark");
    var ptFeats = [], lineFeats = [], polygonFeats = [];

    for (var i = 0; i < placemarks.length; i++) {
      var pm = placemarks[i];
      var nameEl = pm.getElementsByTagName("name")[0];
      var name = nameEl ? nameEl.textContent.trim() : "Feature " + (i + 1);

      // Extract color from inline Style
      var color = "";
      var styleEl = pm.getElementsByTagName("Style")[0];
      if (styleEl) {
        var colorEls = styleEl.getElementsByTagName("color");
        if (colorEls.length > 0) color = _kmlColorToHex(colorEls[0].textContent.trim());
      }

      // Extract attributes from ExtendedData
      var attrs = {};
      var extData = pm.getElementsByTagName("ExtendedData")[0];
      if (extData) {
        var dataEls = extData.getElementsByTagName("Data");
        for (var d = 0; d < dataEls.length; d++) {
          var dName = dataEls[d].getAttribute("name");
          var valEl = dataEls[d].getElementsByTagName("value")[0];
          if (dName && valEl && dName !== "type") {
            attrs[dName] = valEl.textContent.trim();
          }
        }
      }

      // Detect geometry type
      var ptEl = pm.getElementsByTagName("Point")[0];
      var lsEl = pm.getElementsByTagName("LineString")[0];
      var pgEl = pm.getElementsByTagName("Polygon")[0];

      if (ptEl) {
        var ptCoordEl = ptEl.getElementsByTagName("coordinates")[0];
        if (ptCoordEl) {
          var pts = _parseKmlCoords(ptCoordEl.textContent);
          if (pts.length > 0) {
            ptFeats.push(_makeFeature("Point", pts[0], name, color, attrs));
          }
        }
      } else if (lsEl) {
        var lsCoordEl = lsEl.getElementsByTagName("coordinates")[0];
        if (lsCoordEl) {
          var lineCoords = _parseKmlCoords(lsCoordEl.textContent);
          if (lineCoords.length >= 2) {
            lineFeats.push(_makeFeature("LineString", lineCoords, name, color, attrs));
          }
        }
      } else if (pgEl) {
        var outerBound = pgEl.getElementsByTagName("outerBoundaryIs")[0];
        var ring = outerBound ? outerBound.getElementsByTagName("coordinates")[0] :
                   pgEl.getElementsByTagName("coordinates")[0];
        if (ring) {
          var polyCoords = _parseKmlCoords(ring.textContent);
          if (polyCoords.length >= 3) {
            // Ensure ring is closed
            var first = polyCoords[0], last = polyCoords[polyCoords.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
              polyCoords.push([first[0], first[1]]);
            }
            polygonFeats.push(_makeFeature("Polygon", [polyCoords], name, color, attrs));
          }
        }
      }
    }

    return { points: ptFeats, lines: lineFeats, polygons: polygonFeats };
  }

  function importKML(file) {
    if (!_checkFileSize(file)) return;
    var ext = (file.name.split(".").pop() || "").toLowerCase();

    if (ext === "kmz") {
      // KMZ is a zip file containing doc.kml
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          if (typeof JSZip === "undefined") {
            alert("JSZip library not loaded. Cannot read KMZ files. Try a .kml file instead.");
            return;
          }
          JSZip.loadAsync(e.target.result).then(function (zip) {
            var kmlFile = null;
            zip.forEach(function (path, entry) {
              if (!kmlFile && /\.kml$/i.test(path)) kmlFile = entry;
            });
            if (!kmlFile) {
              alert("No .kml file found inside the KMZ archive.");
              return;
            }
            kmlFile.async("text").then(function (kmlText) {
              _finishKMLImport(kmlText);
            });
          }).catch(function (err) {
            alert("Could not read KMZ file: " + (err.message || err));
          });
        } catch (err) {
          alert("KMZ import failed: " + (err.message || err));
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      var textReader = new FileReader();
      textReader.onload = function (e) {
        _finishKMLImport(e.target.result);
      };
      textReader.onerror = function () { alert("Could not read file."); };
      textReader.readAsText(file);
    }
  }

  function _finishKMLImport(kmlText) {
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(kmlText, "text/xml");

      var parseError = doc.getElementsByTagName("parsererror");
      if (parseError.length > 0) {
        alert("Invalid KML file: XML parse error.");
        return;
      }

      var result = _processKmlDoc(doc);
      var total = result.points.length + result.lines.length + result.polygons.length;

      if (total === 0) {
        alert("No valid features found in KML file.");
        return;
      }

      if (!_confirmReplace()) return;
      _applyImportedFeatures(result.points, result.lines, result.polygons, []);
    } catch (err) {
      App.setStatus("KML import failed");
      alert("KML import failed: " + (err.message || err));
    }
  }

  // ---- Import: Shapefile (SHP / ZIP) ----

  function importSHP(file) {
    if (!_checkFileSize(file)) return;

    var ext = (file.name.split(".").pop() || "").toLowerCase();
    var reader = new FileReader();

    reader.onload = function (e) {
      var buffer = e.target.result;
      if (ext === "zip") {
        _importSHPFromZip(buffer, file);
      } else if (ext === "shp") {
        _parseSHPBuffers(buffer, null);
      } else {
        alert("Expected a .shp or .zip file.");
      }
    };
    reader.onerror = function () { alert("Could not read file."); };
    reader.readAsArrayBuffer(file);
  }

  function _importSHPFromZip(zipBuffer, file) {
    if (typeof JSZip === "undefined") {
      alert("JSZip library not loaded. Cannot read ZIP files. Please check your internet connection and reload.");
      return;
    }

    JSZip.loadAsync(zipBuffer).then(function (zip) {
      var shpEntry = null, dbfEntry = null, prjEntry = null;
      var gtfsLike = false;
      var GTFS_RE = /(^|\/)(agency|stops|routes|trips|stop_times|calendar|calendar_dates)\.txt$/i;

      zip.forEach(function (path, entry) {
        var lower = path.toLowerCase();
        if (/\.shp$/.test(lower) && !shpEntry) shpEntry = entry;
        if (/\.dbf$/.test(lower) && !dbfEntry) dbfEntry = entry;
        if (/\.prj$/.test(lower) && !prjEntry) prjEntry = entry;
        if (GTFS_RE.test(path)) gtfsLike = true;
      });

      if (!shpEntry) {
        // A GTFS feed is also a .zip of .txt files (no .shp). Hand it to the
        // GTFS loader instead of failing as a malformed shapefile.
        if (gtfsLike && file && typeof App.loadGTFSFile === "function") {
          App.loadGTFSFile(file);
          return;
        }
        alert("No .shp file found in the ZIP archive.");
        return;
      }

      var promises = [shpEntry.async("arraybuffer")];
      promises.push(dbfEntry ? dbfEntry.async("arraybuffer") : Promise.resolve(null));
      promises.push(prjEntry ? prjEntry.async("text") : Promise.resolve(null));

      Promise.all(promises).then(function (results) {
        var shpBuf = results[0];
        var dbfBuf = results[1];
        var prjText = results[2];

        // Warn if projection may not be WGS84
        if (prjText && prjText.indexOf("GCS_WGS_1984") < 0 && prjText.indexOf("4326") < 0 &&
            prjText.indexOf("WGS 84") < 0 && prjText.indexOf("WGS_84") < 0 && prjText.indexOf("WGS84") < 0) {
          if (!confirm("This shapefile may not use WGS84 (EPSG:4326) coordinates. " +
                       "Features may appear in the wrong location. Continue anyway?")) {
            return;
          }
        }

        _parseSHPBuffers(shpBuf, dbfBuf);
      }).catch(function (err) {
        alert("Error reading ZIP contents: " + (err.message || err));
      });
    }).catch(function (err) {
      alert("Could not read ZIP file: " + (err.message || err));
    });
  }

  function _parseSHPBuffers(shpBuf, dbfBuf) {
    if (typeof shapefile === "undefined") {
      alert("Shapefile library not loaded. Please check your internet connection and reload.");
      return;
    }

    shapefile.read(shpBuf, dbfBuf).then(function (geojson) {
      if (!geojson || !geojson.features || geojson.features.length === 0) {
        alert("Shapefile contains no features.");
        return;
      }

      if (!_confirmReplace()) return;

      var ptFeats = [], lineFeats = [], polygonFeats = [];

      for (var i = 0; i < geojson.features.length; i++) {
        var feat = geojson.features[i];
        var geom = feat.geometry;
        var props = feat.properties || {};

        var name = props.name || props.NAME || props.Name || props.label || props.LABEL ||
                   props.id || props.ID || ("Feature " + (i + 1));

        // Copy all properties as attributes
        var attrs = {};
        var propKeys = Object.keys(props);
        for (var k = 0; k < propKeys.length; k++) {
          var pk = propKeys[k];
          var pv = props[pk];
          if (pv != null && pv !== "" && pk.toLowerCase() !== "name") {
            attrs[pk] = String(pv);
          }
        }

        if (!geom) continue;

        if (geom.type === "Point") {
          ptFeats.push(_makeFeature("Point", geom.coordinates, String(name), "", attrs));
        } else if (geom.type === "MultiPoint") {
          for (var mp = 0; mp < geom.coordinates.length; mp++) {
            ptFeats.push(_makeFeature("Point", geom.coordinates[mp], String(name) + " " + (mp + 1), "", attrs));
          }
        } else if (geom.type === "LineString") {
          lineFeats.push(_makeFeature("LineString", geom.coordinates, String(name), "", attrs));
        } else if (geom.type === "MultiLineString") {
          for (var ml = 0; ml < geom.coordinates.length; ml++) {
            lineFeats.push(_makeFeature("LineString", geom.coordinates[ml], String(name) + " " + (ml + 1), "", attrs));
          }
        } else if (geom.type === "Polygon") {
          polygonFeats.push(_makeFeature("Polygon", geom.coordinates, String(name), "", attrs));
        } else if (geom.type === "MultiPolygon") {
          for (var mg = 0; mg < geom.coordinates.length; mg++) {
            polygonFeats.push(_makeFeature("Polygon", geom.coordinates[mg], String(name) + " " + (mg + 1), "", attrs));
          }
        }
      }

      var total = ptFeats.length + lineFeats.length + polygonFeats.length;
      if (total === 0) {
        alert("No supported geometry types found in shapefile.");
        return;
      }

      _applyImportedFeatures(ptFeats, lineFeats, polygonFeats, []);
    }).catch(function (err) {
      alert("Shapefile import failed: " + (err.message || err));
    });
  }

  // ---- Share link: compress full state into URL hash ----

  function exportShareLink() {
    try {
      var state = collectState("full");
      // Strip analysis-module results to keep the URL short. Drawn features,
      // feature attributes, buffers, and map view are preserved; the recipient
      // can re-run any analysis module themselves.
      delete state.moduleState;
      var json = JSON.stringify(state);
      var compressed = pako.deflate(json, { level: 9 });
      var binary = "";
      for (var i = 0; i < compressed.length; i++) {
        binary += String.fromCharCode(compressed[i]);
      }
      var b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      var url = window.location.origin + window.location.pathname + "#share=" + b64;
      navigator.clipboard.writeText(url).then(function () {
        App.setStatus("Share link copied to clipboard");
      }).catch(function () {
        prompt("Copy this share link:", url);
      });
    } catch (e) {
      App.setStatus("Share link failed: " + (e.message || e));
    }
  }

  // ---- Load shared session from URL hash (called on startup) ----

  function loadShareLink() {
    var match = window.location.hash.match(/^#share=([A-Za-z0-9\-_]+)/);
    if (!match) return false;
    try {
      var b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var json = pako.inflate(bytes, { to: "string" });
      var state = JSON.parse(json);
      var err = validateState(state);
      if (err) { console.warn("Share link invalid:", err); return false; }
      applyState(state);
      _viewOnly = true;
      document.body.classList.add("view-only-mode");
      var banner = document.getElementById("view-only-banner");
      if (banner) banner.style.display = "block";
      App.setStatus("Viewing shared session");
      return true;
    } catch (e) {
      console.warn("Failed to load share link:", e);
      return false;
    }
  }

  // ---- Expose on App namespace ----

  App.cache = {
    save: save,
    restore: restore,
    reset: reset,
    exportToFile: exportToFile,
    exportFeaturesOnly: exportFeaturesOnly,
    exportShareLink: exportShareLink,
    loadShareLink: loadShareLink,
    exportCSV: exportCSV,
    exportKML: exportKML,
    exportSHP: exportSHP,
    importFromFile: importFromFile,
    importCSV: importCSV,
    importKML: importKML,
    importSHP: importSHP,
    exportFullState: exportFullState,
    importFullState: importFullState,
    listRecents:     listRecents,
    openRecent:      openRecent,
    removeRecent:    removeRecent,
    clearRecents:    clearRecents,
    collectState: collectState,
    applyState: applyState,
    STORAGE_KEY: STORAGE_KEY,
    registerModule: function (id, handlers) {
      _moduleHandlers.push({ id: id, handlers: handlers });
    }
  };
})();
