// js/app.js
// Startup: wires core modules together, loads active project panel,
// contains summary runners and core event bindings.
// Depends on: all core modules (utils, map, points, census, lodes).
// Exports: registerProject

(function () {
  var App = window.App;

  // ---- Draw mode ----

  App.drawMode = null; // null | "point" | "line" | "route" | "polygon" | "label" | "measure"

  // ---- Variable checkbox UI ----
  // The variable checkbox list is built at runtime by buffer-summary.js from
  // VAR_META in utils.js (single source of truth). There is no sidebar Data
  // Inputs panel — the checkboxes live inside the Feature Area Analysis popup.

  // ---- Module registry (replaces single-project system) ----

  var _modules = new Map(); // Map<id, moduleConfig>

  App.registerModule = function (config) {
    _modules.set(config.id, config);
  };

  // Backward-compat alias so existing project files still work during migration
  App.registerProject = App.registerModule;

  // ---- Shared module-state UI (stale banner + empty/onboarding state) ----
  // Standardizes the two cross-cutting popup patterns so every analysis module
  // looks/behaves the same:
  //   (1) Stale banner with a working "Re-run" button.
  //   (2) Friendly empty-state / first-open onboarding hint.
  // Reuses the shared (despite the rf- prefix) .rf-status / .rf-info-box classes.
  //
  // opts = {
  //   statusEl,            // .rf-status pill element OR its id string
  //   emptyEl,             // .rf-info-box element OR its id string
  //   empty:  bool,        // true => show emptyEl + hint, hide pill (wins over all)
  //   hint:   string | { need, action },  // empty-state / onboarding copy
  //   stale:  bool,        // true => stale pill with Re-run button
  //   status: { kind, message },          // explicit pill: kind = running|done|error
  //   onRerun: function    // wired to the Re-run button (used when stale)
  // }
  // Resolves id strings via getElementById and no-ops on missing elements, so it
  // is safe to call from update() while the popup is closed.
  App.renderModuleState = function (opts) {
    opts = opts || {};
    var statusEl = typeof opts.statusEl === "string"
      ? document.getElementById(opts.statusEl) : opts.statusEl;
    var emptyEl = typeof opts.emptyEl === "string"
      ? document.getElementById(opts.emptyEl) : opts.emptyEl;

    function hide(el) { if (el) el.style.display = "none"; }

    // --- Empty / onboarding state wins ---
    if (opts.empty) {
      hide(statusEl);
      if (emptyEl) {
        emptyEl.style.display = "";
        emptyEl.classList.add("rf-info-box");
        var hint = opts.hint;
        if (hint && typeof hint === "object") {
          emptyEl.innerHTML =
            '<p><strong>' + _escHtml(hint.need || "") + '</strong></p>' +
            (hint.action ? '<p class="rf-state-action">' + _escHtml(hint.action) + '</p>' : "");
        } else if (typeof hint === "string" && hint) {
          emptyEl.innerHTML = '<p>' + hint + '</p>';
        }
        // If no hint passed, leave whatever static markup the popup HTML shipped.
      }
      return;
    }

    if (emptyEl) hide(emptyEl);
    if (!statusEl) return;

    // --- Explicit status pill (neutral / running / done / error) ---
    if (opts.status) {
      _paintStatus(statusEl, opts.status.kind || "", opts.status.message || "", null);
      return;
    }

    // --- Stale pill with Re-run button ---
    if (opts.stale) {
      _paintStatus(
        statusEl, "stale",
        "Inputs changed — re-run to update.",
        typeof opts.onRerun === "function" ? opts.onRerun : null
      );
      return;
    }

    // --- Nothing to show ---
    hide(statusEl);
  };

  function _paintStatus(statusEl, kind, message, onRerun) {
    statusEl.style.display = "";
    statusEl.className = "rf-status" +
      (kind === "done"    ? " rf-status-done"    :
       kind === "stale"   ? " rf-status-stale"   :
       kind === "error"   ? " rf-status-error"   :
       kind === "running" ? " rf-status-running" : "");

    // The popup HTML ships a <span id="...StatusText"> inside the pill; keep using
    // it when present so existing id references stay valid. Otherwise build one.
    var textEl = statusEl.querySelector("[id$='StatusText'], .rf-status-text");
    if (!textEl) {
      statusEl.innerHTML = "";
      textEl = document.createElement("span");
      textEl.className = "rf-status-text";
      statusEl.appendChild(textEl);
    }
    textEl.textContent = message || "";

    // Drop any prior Re-run button, then add a fresh one if requested.
    var oldBtn = statusEl.querySelector(".rf-status-rerun");
    if (oldBtn) oldBtn.parentNode.removeChild(oldBtn);
    if (onRerun) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rf-status-rerun";
      btn.textContent = "Re-run";
      btn.addEventListener("click", onRerun);
      statusEl.appendChild(btn);
    }
  }

  function _escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- Shared collapsible module inputs ----
  // Sibling of renderModuleState: the other cross-cutting popup pattern.
  //
  // WHY: a module's settings column is only interesting until you run it. In a
  // narrow/stacked panel (see the @container rule in style.css) the settings sit
  // ABOVE the results, so leaving them expanded pushes the answer below the fold.
  // Collapsing them on a successful run hands the panel back to the results.
  //
  // The collapsed header still carries a one-line summary of what was actually
  // run, so a collapsed panel can always answer "what am I looking at" without
  // being reopened.
  //
  // TERMINOLOGY (a convention, not enforced by this code — see CLAUDE.md):
  //   Inputs   — required selections; live in the settings column; collapse here.
  //   Settings — optional/expert tuning; live behind a button, modal or <details>.
  //
  // opts = {
  //   hostEl,     // the module's .rf-settings-col element OR its id string
  //   collapsed,  // bool — desired state; omit to leave the current state alone
  //   summary,    // string shown in the header when collapsed
  //   label,      // header label, default "Inputs"
  //   onToggle    // optional callback(collapsedBool) when the user clicks
  // }
  // On first call the host's existing children are moved into a body wrapper and
  // a clickable header is prepended. Moving nodes preserves event listeners and
  // element ids, so modules need no markup changes. Later calls only update the
  // summary/state. No-ops on a missing host, so it is safe to call while the
  // popup is closed.
  App.renderModuleInputs = function (opts) {
    opts = opts || {};
    var host = typeof opts.hostEl === "string"
      ? document.getElementById(opts.hostEl) : opts.hostEl;
    if (!host) return null;

    var body = host.querySelector(":scope > .module-inputs-body");

    // First call: build the header and move the existing content into a body.
    if (!body) {
      host.classList.add("module-inputs");

      body = document.createElement("div");
      body.className = "module-inputs-body";
      while (host.firstChild) body.appendChild(host.firstChild);

      var header = document.createElement("button");
      header.type = "button";
      header.className = "module-inputs-header";
      header.setAttribute("aria-label", "Toggle analysis inputs");

      var caret = document.createElement("span");
      caret.className = "lp-caret module-inputs-caret";
      caret.innerHTML = "&#9662;";

      var label = document.createElement("span");
      label.className = "module-inputs-label";

      var summary = document.createElement("span");
      summary.className = "module-inputs-summary";

      header.appendChild(caret);
      header.appendChild(label);
      header.appendChild(summary);

      header.addEventListener("click", function () {
        var nowCollapsed = !host.classList.contains("module-inputs-collapsed");
        _setInputsCollapsed(host, nowCollapsed);
        if (typeof opts.onToggle === "function") opts.onToggle(nowCollapsed);
      });

      host.appendChild(header);
      host.appendChild(body);
    }

    var labelEl = host.querySelector(":scope > .module-inputs-header .module-inputs-label");
    var sumEl = host.querySelector(":scope > .module-inputs-header .module-inputs-summary");
    if (labelEl) labelEl.textContent = opts.label || "Inputs";
    if (sumEl) sumEl.textContent = opts.summary || "";

    if (typeof opts.collapsed === "boolean") _setInputsCollapsed(host, opts.collapsed);
    return host;
  };

  function _setInputsCollapsed(host, collapsed) {
    // The caret rotation is driven purely by this class in CSS (down = expanded,
    // right = collapsed), so there is no second piece of state to keep in sync.
    host.classList.toggle("module-inputs-collapsed", collapsed);
    var header = host.querySelector(":scope > .module-inputs-header");
    if (header) header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  // Override bufferUnionPolygon to include line and route buffers alongside point buffers.
  // Must happen before any user interaction; census.js and lodes.js call this at runtime.
  var _pointUnion = App.bufferUnionPolygon;
  App.bufferUnionPolygon = function () {
    var su = _pointUnion();
    var lu = App.lineBufferUnionPolygon ? App.lineBufferUnionPolygon() : null;
    var ru = App.routeBufferUnionPolygon ? App.routeBufferUnionPolygon() : null;
    var pu = App.polygonUnionPolygon ? App.polygonUnionPolygon() : null;
    var combined = su || null;
    if (lu) combined = combined ? turf.union(combined, lu) : lu;
    if (ru) combined = combined ? turf.union(combined, ru) : ru;
    if (pu) combined = combined ? turf.union(combined, pu) : pu;
    return combined;
  };

  // Build a core API object for passing to project hooks.
  // Rebuilt each call so values like lodesData are always current.
  function buildCore() {
    return {
      points: App.points,
      buffers: App.buffers,
      routes: App.routes,
      routeBuffers: App.routeBuffers,
      map: App.map,
      lodesData: App.lodesData,
      lodesFileName: App.lodesFileName,
      getUnion: function () { return App.bufferUnionPolygon(); },
      fetchTigerwebGeos: App.fetchTigerwebGeos,
      fetchACSValues: App.fetchACSValues,
      fetchACSCountyValues: App.fetchACSCountyValues,
      aggregateWithinUnion: App.aggregateWithinUnion,
      computeAcsValueOnly: App.computeAcsValueOnly,
      computeEmploymentServedOnly: App.computeEmploymentServedOnly,
      fetchBlocksInternalPointsInUnion: App.fetchBlocksInternalPointsInUnion,
      utils: {
        setStatus: App.setStatus,
        parseCSV: App.parseCSV,
        toNumberSafe: App.toNumberSafe,
        normalizeTractGEOID: App.normalizeTractGEOID,
        guessHeader: App.guessHeader,
        fillSelect: App.fillSelect,
        enableSelect: App.enableSelect,
        formatValue: App.formatValue,
        getMeta: App.getMeta,
        setAggUI: App.setAggUI
      }
    };
  }

  // Notify all registered modules that data has changed.
  // Called sequentially to avoid overwhelming Census API.
  async function notifyProject() {
    var core = buildCore();
    for (var entry of _modules.values()) {
      if (typeof entry.update === "function") {
        await entry.update(core);
      }
    }
    // Keep the Layers tab current when features/analysis layers change.
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
  }
  App.notifyProject = notifyProject;

  // Clear all module state (choropleths, legends, results).
  // Called by Clear and Reset Session buttons.
  function clearModules() {
    for (var entry of _modules.values()) {
      if (typeof entry.clear === "function") {
        entry.clear();
      }
    }
  }

  // Note: runSummary(), MANDATORY_VARS, expandGroups, and aggDescription live
  // in js/projects/buffer-summary.js. Variable metadata, checkbox groups, and
  // percentage denominators are all driven by VAR_META in js/core/utils.js.

  // ---- Build Analysis sidebar panel HTML ----

  function buildAnalysisButtonsHTML() {
    var html = '<div class="analysis-module-list">';
    var generalIds = ["buffer-summary", "walkshed"];
    var rendered = {};

    function renderEntry(entry) {
      var isEnabled = entry.enabled !== false;
      var disabledAttr = isEnabled ? '' : ' disabled';
      return '<button class="analysis-module-btn"' +
              ' data-module-id="' + entry.id + '"' + disabledAttr + '>' +
              (entry.name || entry.id) +
              (isEnabled ? '' : ' <span class="coming-soon">(coming soon)</span>') +
              '</button>';
    }

    var generalHtml = "";
    generalIds.forEach(function (id) {
      var entry = _modules.get(id);
      if (!entry || entry.system === true) return;
      rendered[id] = true;
      generalHtml += renderEntry(entry);
    });
    if (generalHtml) {
      html += '<div class="add-data-heading">General</div>' + generalHtml;
    }

    // All other non-system analyses belong to Transit Planning. Sorting by the
    // visible module name keeps the menu stable as modules are registered in
    // script-load order and automatically includes future modules.
    var transitEntries = [];
    for (var entry of _modules.values()) {
      if (entry.system === true || rendered[entry.id]) continue;
      transitEntries.push(entry);
    }
    transitEntries.sort(function (a, b) {
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
    if (transitEntries.length) {
      html += '<div class="add-data-heading">Transit Planning</div>';
      transitEntries.forEach(function (entry) { html += renderEntry(entry); });
    }
    html += '</div>';
    return html;
  }

  // ---- Feature delete hook (called by features.js) ----

  // ---- Overlap offset computation ----

  var _computingOffsets = false;
  var OVERLAP_PROXIMITY_MI = 0.015; // ~80ft — same-street detection
  var OFFSET_PX = 3;

  App.computeOverlapOffsets = function () {
    if (_computingOffsets) return;
    _computingOffsets = true;
    try {
      var features = [];
      // Only include features without a manual offset override — manually-offset
      // features keep their value and are excluded from auto computation.
      (App.lines || []).forEach(function (f, i) {
        if (!f.properties.hidden && !f.properties._offsetManual) features.push({ src: "line", idx: i, feature: f });
      });
      (App.routes || []).forEach(function (f, i) {
        if (!f.properties.hidden && !f.properties._offsetManual) features.push({ src: "route", idx: i, feature: f });
      });

      // Clear all auto-managed offsets first (manual ones are already excluded)
      for (var k = 0; k < features.length; k++) {
        if (features[k].feature.properties) features[k].feature.properties._offset = 0;
      }

      if (features.length < 2) { _pushOffsetSources(); _computingOffsets = false; return; }

      // Build tiny proximity buffers
      var miniBufs = [];
      for (var i = 0; i < features.length; i++) {
        try {
          miniBufs.push(turf.buffer(features[i].feature, OVERLAP_PROXIMITY_MI, { units: "miles", steps: 4 }));
        } catch (e) { miniBufs.push(null); }
      }

      // Pairwise overlap detection
      var adj = [];
      for (var i = 0; i < features.length; i++) adj.push([]);
      for (var i = 0; i < features.length; i++) {
        if (!miniBufs[i]) continue;
        for (var j = i + 1; j < features.length; j++) {
          if (!miniBufs[j]) continue;
          try {
            if (turf.booleanIntersects(miniBufs[i], miniBufs[j])) {
              adj[i].push(j);
              adj[j].push(i);
            }
          } catch (e) { /* skip */ }
        }
      }

      // BFS connected components → assign spread offsets
      var visited = [];
      for (var i = 0; i < features.length; i++) visited.push(false);

      for (var i = 0; i < features.length; i++) {
        if (visited[i] || adj[i].length === 0) continue;
        var group = [];
        var queue = [i];
        visited[i] = true;
        while (queue.length > 0) {
          var cur = queue.shift();
          group.push(cur);
          for (var ni = 0; ni < adj[cur].length; ni++) {
            var nb = adj[cur][ni];
            if (!visited[nb]) { visited[nb] = true; queue.push(nb); }
          }
        }
        var n = group.length;
        for (var gi = 0; gi < n; gi++) {
          var offset = (gi - (n - 1) / 2) * OFFSET_PX;
          features[group[gi]].feature.properties._offset = offset;
        }
      }

      _pushOffsetSources();
    } finally {
      _computingOffsets = false;
    }
  };

  App.clearOverlapOffsets = function () {
    if (_computingOffsets) return;
    _computingOffsets = true;
    try {
      // Preserve manual per-feature offsets when the global toggle is turned off.
      (App.lines || []).forEach(function (f) {
        if (f.properties && !f.properties._offsetManual) f.properties._offset = 0;
      });
      (App.routes || []).forEach(function (f) {
        if (f.properties && !f.properties._offsetManual) f.properties._offset = 0;
      });
      _pushOffsetSources();
    } finally {
      _computingOffsets = false;
    }
  };

  function _pushOffsetSources() {
    var map = App.map;
    if (!map) return;
    var ls = map.getSource("lines");
    if (ls) ls.setData({ type: "FeatureCollection", features: (App.lines || []).filter(function (f) { return !f.properties.hidden; }) });
    var rs = map.getSource("routes");
    if (rs) rs.setData({ type: "FeatureCollection", features: (App.routes || []).filter(function (f) { return !f.properties.hidden; }) });
  }

  // ---- Feature deletion hook ----

  App.onFeatureDelete = function () {
    if (typeof App.exitEditMode === "function") App.exitEditMode();
    if (typeof App.clearSelection === "function") App.clearSelection();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    notifyProject();
    if (typeof App.cache !== "undefined") App.cache.save();
  };

  // ---- Feature Settings: centralized state + apply helpers ----

  App.featureSettings = {
    pointOpacity:      100,
    lineOpacity:       100,
    routeOpacity:      100,
    polygonOpacity:    50,
    bufferOpacity:     50,
    bufferRadius:      0,
    lineBufferRadius:  0,
    routeBufferRadius: 0,
    pointLineWidth:    1,
    lineLineWidth:     1,
    routeLineWidth:    1,
    polygonLineWidth:  1,
    bufferLineWidth:   1
  };

  function _safeSetPaint(layerId, prop, val) {
    if (App.map && App.map.getLayer(layerId)) {
      App.map.setPaintProperty(layerId, prop, val);
    }
  }

  function _polyOpacityValues(S) {
    if (S <= 50) {
      var t = S / 50;
      return { fill: 0.15 * t, border: 0.8 * t };
    }
    var t = (S - 50) / 50;
    return { fill: 0.15 + 0.85 * t, border: 0.8 + 0.2 * t };
  }

  function _bufOpacityValues(S) {
    if (S <= 50) {
      var t = S / 50;
      return { fill: 0.08 * t, border: 0.4 * t };
    }
    var t = (S - 50) / 50;
    return { fill: 0.08 + 0.92 * t, border: 0.4 + 0.6 * t };
  }

  App._polyOpacityValues = _polyOpacityValues;

  App.applyFeatureOpacity = function (type) {
    var fs = App.featureSettings;
    if (type === "point" || type === "all") {
      var op = fs.pointOpacity / 100;
      var opExpr = ["case", ["has", "_opacity"], ["get", "_opacity"], op];
      _safeSetPaint("points-layer", "circle-opacity", opExpr);
      _safeSetPaint("points-layer", "circle-stroke-opacity", opExpr);
    }
    if (type === "line" || type === "all") {
      _safeSetPaint("lines-layer", "line-opacity",
        ["case", ["has", "_opacity"], ["get", "_opacity"], fs.lineOpacity / 100]);
    }
    if (type === "route" || type === "all") {
      _safeSetPaint("routes-layer", "line-opacity",
        ["case", ["has", "_opacity"], ["get", "_opacity"], fs.routeOpacity / 100]);
    }
    if (type === "polygon" || type === "all") {
      var pc = _polyOpacityValues(fs.polygonOpacity);
      _safeSetPaint("polygons-fill", "fill-opacity",
        ["case", ["has", "_fillOpacity"], ["get", "_fillOpacity"], pc.fill]);
      _safeSetPaint("polygons-outlines-layer", "line-opacity",
        ["case", ["has", "_borderOpacity"], ["get", "_borderOpacity"], pc.border]);
    }
    if (type === "buffer" || type === "all") {
      var bc = _bufOpacityValues(fs.bufferOpacity);
      _safeSetPaint("buffers-fill", "fill-opacity", bc.fill);
      _safeSetPaint("buffers-line", "line-opacity", bc.border);
      _safeSetPaint("line-buffers-fill", "fill-opacity", bc.fill);
      _safeSetPaint("line-buffers-line", "line-opacity", bc.border);
      _safeSetPaint("route-buffers-fill", "fill-opacity", bc.fill);
      _safeSetPaint("route-buffers-line", "line-opacity", bc.border);
    }
  };

  App.applyLineWidth = function (type) {
    var fs = App.featureSettings;
    if (type === "point" || type === "all") {
      _safeSetPaint("points-layer", "circle-radius",
        ["case", ["has", "_lineWidth"], ["*", 6, ["get", "_lineWidth"]], 6 * fs.pointLineWidth]);
      _safeSetPaint("points-layer", "circle-stroke-width",
        ["case", ["has", "_lineWidth"], ["*", 2, ["get", "_lineWidth"]], 2 * fs.pointLineWidth]);
    }
    if (type === "line" || type === "all") {
      _safeSetPaint("lines-layer", "line-width",
        ["case", ["has", "_lineWidth"], ["*", 3, ["get", "_lineWidth"]], 3 * fs.lineLineWidth]);
    }
    if (type === "route" || type === "all") {
      _safeSetPaint("routes-layer", "line-width",
        ["case", ["has", "_lineWidth"], ["*", 3, ["get", "_lineWidth"]], 3 * fs.routeLineWidth]);
    }
    if (type === "polygon" || type === "all") {
      _safeSetPaint("polygons-outlines-layer", "line-width",
        ["case", ["has", "_lineWidth"], ["*", 3, ["get", "_lineWidth"]], 3 * fs.polygonLineWidth]);
    }
  };

  App.applyBufferLineWidth = function () {
    var w = App.featureSettings.bufferLineWidth;
    _safeSetPaint("buffers-line", "line-width", 2 * w);
    _safeSetPaint("line-buffers-line", "line-width", 2 * w);
    _safeSetPaint("route-buffers-line", "line-width", 2 * w);
  };

  // ---- Map load: wire everything ----

  App.map.on("load", async function () {
    App.setStatus("Ready");
    App.renderPointLayers();
    App.renderLineLayers();
    App.renderRouteLayers();
    App.renderPolygonLayers();
    if (typeof App.renderLabelMarkers === "function") App.renderLabelMarkers();

    // Initialize measure tool layers
    if (typeof App.initMeasureLayers === "function") App.initMeasureLayers();

    // Initialize feature editing (point drag, vertex editing)
    if (typeof App._initEditing === "function") App._initEditing();

    // Initialize hover/selection highlight layers
    if (typeof App.initHighlightLayers === "function") App.initHighlightLayers();

    // ---- Sidebar disabled (scaffolding kept for future use) ----
    // Panels formerly registered here have been relocated:
    // - Census checkboxes → Feature Area Analysis popup (buffer-summary.js)
    // - LODES → Add Data dropdown (index.html)
    // - Analysis modules → Analysis toolbar dropdown (below)

    // Wire popup system
    App.popup.wire(_modules, buildCore);

    // Public opener for the Attribute Summary "system" module (registered with
    // system: true so it does NOT appear in the Analysis dropdown).
    App.openAttributeSummary = function () {
      App.popup.open("attribute-summary", _modules, buildCore);
    };

    // Wire the entry buttons in Feature Settings
    var asBtn = document.getElementById("open-attribute-summary");
    if (asBtn) {
      asBtn.addEventListener("click", function () {
        if (typeof App.openAttributeSummary === "function") App.openAttributeSummary();
      });
    }

    App.openDisplaySettings = function () {
      App.popup.open("display-settings", _modules, buildCore);
    };
    var dsBtn = document.getElementById("open-display-settings");
    if (dsBtn) {
      dsBtn.addEventListener("click", function () {
        if (typeof App.openDisplaySettings === "function") App.openDisplaySettings();
      });
    }

    // Open a registered module's popup by id (used by the Layers panel ⋯ menu)
    App.openModulePopup = function (id) {
      if (App.popup && typeof App.popup.open === "function") {
        App.popup.open(id, _modules, buildCore);
      }
    };

    // Populate Analysis toolbar dropdown with module buttons
    var analysisDropdown = document.getElementById("analysis-dropdown");
    if (analysisDropdown && _modules.size > 0) {
      analysisDropdown.innerHTML = buildAnalysisButtonsHTML();
      analysisDropdown.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-module-id]");
        if (!btn || btn.disabled) return;
        analysisDropdown.style.display = "none";
        App.popup.open(btn.getAttribute("data-module-id"), _modules, buildCore);
      });
    }

    // ---- Toolbar: draw mode buttons ----
    var toolBtns = document.querySelectorAll(".tool-btn");
    toolBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var prevMode = App.drawMode;
        var clickedMode = btn.getAttribute("data-mode");

        // Toggle: clicking the active button deselects it
        if (App.drawMode === clickedMode) {
          App.drawMode = null;
          btn.classList.remove("active");
        } else {
          App.drawMode = clickedMode;
          toolBtns.forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
        }

        // Cancel in-progress drawing when leaving a draw mode
        if (prevMode === "line" && App.drawMode !== "line") {
          App.cancelLineDrawing();
        }
        if (prevMode === "route" && App.drawMode !== "route") {
          App.cancelRouteDrawing();
        }
        if (prevMode === "polygon" && App.drawMode !== "polygon") {
          App.cancelPolygonDrawing();
        }
        if (prevMode === "measure" && App.drawMode !== "measure") {
          if (typeof App.clearMeasure === "function") App.clearMeasure();
        }

        // Clear any lingering preview coordinates
        if (typeof App.setLinePreview === "function") App.setLinePreview(null);
        if (typeof App.setRoutePreview === "function") App.setRoutePreview(null);
        if (typeof App.setPolygonPreview === "function") App.setPolygonPreview(null);
        if (typeof App.setMeasurePreview === "function") App.setMeasurePreview(null);

        // Clear feature selection when entering a draw mode
        if (App.drawMode && typeof App.clearSelection === "function") App.clearSelection();

        // Update cursor for draw mode
        if (App.drawMode) {
          App.map.getCanvas().style.cursor = "crosshair";
        } else {
          App.map.getCanvas().style.cursor = "grab";
        }

        App.setStatus(App.drawMode
          ? App.drawMode.charAt(0).toUpperCase() + App.drawMode.slice(1) + " mode"
          : "Ready");
      });
    });

    // Exit draw mode (called by save functions after completing a line/route/polygon)
    App.exitDrawMode = function () {
      App.drawMode = null;
      document.querySelectorAll(".tool-btn").forEach(function (b) {
        b.classList.remove("active");
      });
      App.map.getCanvas().style.cursor = "grab";
    };

    // Finish (commit) the in-progress line/route/polygon — the same commit path as
    // snap-to-close, exposed so the Enter shortcut can reuse it. saveRoute is async.
    App.finishDrawing = function () {
      var mode = App.drawMode;
      function after() {
        if (App.undo) App.undo.updateButtons();
        notifyProject();
        if (typeof App.cache !== "undefined") App.cache.save();
      }
      if (mode === "line" && typeof App.saveLine === "function") {
        App.saveLine(); after();
      } else if (mode === "polygon" && typeof App.savePolygon === "function") {
        App.savePolygon(); after();
      } else if (mode === "route" && typeof App.saveRoute === "function") {
        var p = App.saveRoute();
        (p && typeof p.then === "function") ? p.then(after) : after();
      }
    };

    // Variable checkbox Select All / Clear All — now wired in buffer-summary.js init()

    // Dark mode toggle
    var _darkBtn = document.getElementById("darkmode-btn");
    var _DARK_KEY = "mat-dark-mode";
    if (_darkBtn) {
      _darkBtn.setAttribute("aria-pressed", document.body.classList.contains("dark-mode") ? "true" : "false");
      _darkBtn.addEventListener("click", function () {
        var isDark = document.body.classList.toggle("dark-mode");
        _darkBtn.setAttribute("aria-pressed", isDark ? "true" : "false");
        localStorage.setItem(_DARK_KEY, isDark ? "1" : "0");
        // Resolve via the map's registry rather than hardcoding the CARTO
        // ids — those basemaps are absent when no CARTO key is configured.
        if (typeof App.switchBasemap === "function" &&
            typeof App.getThemeBasemapId === "function") {
          App.switchBasemap(App.getThemeBasemapId(isDark));
        }
      });
    }
    // Restore basemap to match dark mode preference (class set by the first script in <body>).
    if (document.body.classList.contains("dark-mode") &&
        typeof App.switchBasemap === "function" &&
        typeof App.getThemeBasemapId === "function") {
      App.switchBasemap(App.getThemeBasemapId(true));
    }

    // Present mode
    App.setPresentMode = function (enabled) {
      var isEnabled = !!enabled;
      document.body.classList.toggle("present-mode", isEnabled);
      var presentBtn = document.getElementById("present-btn");
      if (presentBtn) presentBtn.setAttribute("aria-pressed", isEnabled ? "true" : "false");
      App.map.resize();
      document.dispatchEvent(new CustomEvent("mat:present-mode-change", {
        detail: { enabled: isEnabled }
      }));
    };

    document.getElementById("present-btn").addEventListener("click", function () {
      App.setPresentMode(true);
    });
    document.getElementById("present-exit").addEventListener("click", function () {
      App.setPresentMode(false);
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("present-mode")) {
        App.setPresentMode(false);
        return;
      }
      if (e.key === "Escape" && App.drawMode === "measure") {
        if (typeof App.clearMeasure === "function") App.clearMeasure();
        App.exitDrawMode();
        App.setStatus("Ready");
        return;
      }
      if (e.key === "Escape" && App.popup.isOpen()) {
        App.popup.close();
      }
      var tag = e.target.tagName;
      // Ctrl+Z / Cmd+Z = Undo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
        document.getElementById("undo-btn").click();
        e.preventDefault();
        return;
      }
      // Ctrl+Shift+Z / Cmd+Shift+Z = Redo
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "z" || e.key === "Z")) {
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
        document.getElementById("redo-btn").click();
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
        var ed = App._editing;
        if (ed && ed.type === "vertex-edit") {
          var ft = ed.featureType, fi = ed.featureIndex;
          App.exitEditMode();
          if (ft === "line")         App.removeLine(fi);
          else if (ft === "route")   App.removeRoute(fi);
          else if (ft === "polygon") App.removePolygon(fi);
          if (typeof App.onFeatureDelete === "function") App.onFeatureDelete();
          e.preventDefault();
        }
      }
    });

    // Draw-tool shortcuts (S/L/R/P/M/T/B) + Enter-to-finish. Kept as a separate
    // listener so it stays isolated from the Escape/Ctrl+Z/Delete handler above.
    var TOOL_KEYS = {
      s: "point", l: "line", r: "route", p: "polygon",
      b: "label", t: "textbox", m: "measure"
    };
    document.addEventListener("keydown", function (e) {
      // Never hijack typing, dropdown navigation, or modifier combos (Ctrl+Z etc.).
      var tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Enter finishes an in-progress line / route / polygon.
      if (e.key === "Enter") {
        if (App.drawMode === "line" || App.drawMode === "route" || App.drawMode === "polygon") {
          App.finishDrawing();
          e.preventDefault();
        }
        return;
      }

      // Single-key tool toggles. Skip while a module popup is open (the map is
      // behind it, so switching draw mode would be surprising).
      if (App.popup && App.popup.isOpen()) return;
      var mode = TOOL_KEYS[(e.key || "").toLowerCase()];
      if (mode) {
        var btn = document.querySelector('.tool-btn[data-mode="' + mode + '"]');
        if (btn) { btn.click(); e.preventDefault(); }
      }
    });

    // ---- Feature Settings slider popover ----

    var BUFFER_RADIUS_STEPS = [0, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    var _fpActiveBtn = null;

    function _closeFpSlider() {
      var pop = document.getElementById("fp-slider-popover");
      if (pop) pop.style.display = "none";
      if (_fpActiveBtn) { _fpActiveBtn.classList.remove("fp-sib-active"); _fpActiveBtn = null; }
    }

    function _valueToIdx(val, values) {
      var bestIdx = 0, bestDist = Infinity;
      for (var i = 0; i < values.length; i++) {
        var d = Math.abs(values[i] - val);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return bestIdx;
    }

    function _openFpSlider(btn, cfg) {
      // Toggle off if same button clicked again
      if (_fpActiveBtn === btn) { _closeFpSlider(); return; }
      _closeFpSlider();

      var pop = document.getElementById("fp-slider-popover");
      if (!pop) return;
      var slider = document.getElementById("fp-slider-input");
      var valEl  = document.getElementById("fp-slider-value");
      var unitEl = document.getElementById("fp-slider-unit");
      if (!slider || !valEl) return;

      var initVal = (cfg.value != null) ? cfg.value : (cfg.key ? App.featureSettings[cfg.key] : 0);
      if (unitEl) unitEl.textContent = cfg.unit || "";

      if (cfg.values) {
        slider.min  = 0;
        slider.max  = cfg.values.length - 1;
        slider.step = 1;
        var initIdx = _valueToIdx(initVal, cfg.values);
        slider.value = initIdx;
        valEl.textContent = _fmtSlider(cfg.values[initIdx], cfg);
        slider.oninput = function () {
          var v = cfg.values[parseInt(this.value)];
          if (cfg.key) App.featureSettings[cfg.key] = v;
          valEl.textContent = _fmtSlider(v, cfg);
          cfg.onChange(v);
          if (cfg.key && typeof App.cache !== "undefined") App.cache.save();
        };
      } else {
        slider.min   = cfg.min;
        slider.max   = cfg.max;
        slider.step  = cfg.step;
        slider.value = initVal;
        valEl.textContent = _fmtSlider(initVal, cfg);
        slider.oninput = function () {
          var v = parseFloat(this.value);
          if (cfg.key) App.featureSettings[cfg.key] = v;
          valEl.textContent = _fmtSlider(v, cfg);
          cfg.onChange(v);
          if (cfg.key && typeof App.cache !== "undefined") App.cache.save();
        };
      }

      // Position popover below (or above) the icon
      var rect = btn.getBoundingClientRect();
      var popW = 44, popH = 160;
      var left = rect.left + rect.width / 2 - popW / 2;
      var top  = rect.bottom + 6;
      if (top + popH > window.innerHeight - 8) top = rect.top - popH - 6;
      left = Math.max(4, Math.min(left, window.innerWidth - popW - 4));
      pop.style.left    = Math.round(left) + "px";
      pop.style.top     = Math.round(top)  + "px";
      pop.style.display = "flex";

      btn.classList.add("fp-sib-active");
      _fpActiveBtn = btn;
    }

    function _fmtSlider(v, cfg) {
      if (cfg.values) return parseFloat(v.toFixed(3)).toString();
      if (cfg.step < 1) return parseFloat(v).toFixed(1);
      return Math.round(v).toString();
    }

    // Close on outside mousedown (not click — avoids missing fast drags)
    document.addEventListener("mousedown", function (e) {
      if (!_fpActiveBtn) return;
      var pop = document.getElementById("fp-slider-popover");
      if (!pop) return;
      if (!pop.contains(e.target) && e.target !== _fpActiveBtn && !_fpActiveBtn.contains(e.target)) {
        _closeFpSlider();
      }
    }, true);

    // Expose slider infrastructure for per-feature overrides in feature-attributes.js
    App._openFpSlider      = _openFpSlider;
    App._closeFpSlider     = _closeFpSlider;
    App.BUFFER_RADIUS_STEPS = BUFFER_RADIUS_STEPS;

    // Offset overlapping lines/routes toggle
    document.getElementById("offsetOverlap").addEventListener("change", function () {
      if (this.checked) {
        App.computeOverlapOffsets();
      } else {
        App.clearOverlapOffsets();
      }
      if (typeof App.cache !== "undefined") App.cache.save();
    });

    // Map click: dispatch based on draw mode
    App.map.on("click", function (e) {
      if (App.drawMode === "point") {
        App.addPoint(e.lngLat.lng, e.lngLat.lat);
        notifyProject();
        if (typeof App.cache !== "undefined") App.cache.save();
      } else if (App.drawMode === "line") {
        App.handleLineClick(e.lngLat);
        if (App.undo) App.undo.updateButtons();
        notifyProject();
        if (typeof App.cache !== "undefined") App.cache.save();
      } else if (App.drawMode === "route") {
        App.handleRouteClick(e.lngLat).then(function () {
          if (App.undo) App.undo.updateButtons();
          notifyProject();
          if (typeof App.cache !== "undefined") App.cache.save();
        });
      } else if (App.drawMode === "polygon") {
        App.handlePolygonClick(e.lngLat);
        if (App.undo) App.undo.updateButtons();
        notifyProject();
        if (typeof App.cache !== "undefined") App.cache.save();
      } else if (App.drawMode === "label") {
        App.addLabel(e.lngLat.lng, e.lngLat.lat);
        App.drawMode = null;
        var _lb = document.querySelector('[data-mode="label"]');
        if (_lb) _lb.classList.remove("active");
        notifyProject();
        if (typeof App.cache !== "undefined") App.cache.save();
      } else if (App.drawMode === "measure") {
        App.handleMeasureClick(e.lngLat);
      }
    });

    // Map mousemove: rubber-band preview for line/route/polygon drawing
    App.map.on("mousemove", function (e) {
      if (App.drawMode === "line") {
        App.setLinePreview(e.lngLat);
      } else if (App.drawMode === "route") {
        App.setRoutePreview(e.lngLat);
      } else if (App.drawMode === "polygon") {
        App.setPolygonPreview(e.lngLat);
      } else if (App.drawMode === "measure") {
        App.setMeasurePreview(e.lngLat);
      }
    });

    // Clear all features
    document.getElementById("clear").addEventListener("click", function () {
      if (!confirm("Clear all features?")) return;
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      if (typeof App.exitEditMode === "function") App.exitEditMode();
      App.clearPoints();
      App.clearLines();
      App.clearRoutes();
      App.clearPolygons();
      if (typeof App.clearLabels    === "function") App.clearLabels();
      if (typeof App.clearTextBoxes === "function") App.clearTextBoxes();
      if (typeof App.clearRoadNetwork === "function") App.clearRoadNetwork();
      if (typeof App.osmClearLayers === "function") App.osmClearLayers();
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
      if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
      document.getElementById("nGeos").textContent = "0";
      document.getElementById("summaryStatus").style.display = "none";
      App.setStatus("Cleared");
      if (typeof App.clearPresentOverlays === "function") App.clearPresentOverlays();
      clearModules();
      notifyProject();
      if (typeof App.cache !== "undefined") App.cache.save();
    });

    // Undo — remove last waypoint if drawing, otherwise pop undo stack
    document.getElementById("undo-btn").addEventListener("click", function () {
      if (App.drawMode === "line" && App._lineDrawingInProgress && App._lineDrawingInProgress()) {
        App.undoLastLine();
        return;
      }
      if (App.drawMode === "route" && App._routeDrawingInProgress && App._routeDrawingInProgress()) {
        App.undoLastRoute();
        return;
      }
      if (App.drawMode === "polygon" && App._polygonDrawingInProgress && App._polygonDrawingInProgress()) {
        App.undoLastPolygon();
        return;
      }
      if (App.drawMode === "measure" && App._measureDrawingInProgress && App._measureDrawingInProgress()) {
        App.undoLastMeasurePoint();
        return;
      }
      App.undo.undo();
      notifyProject();
    });

    // Redo
    document.getElementById("redo-btn").addEventListener("click", function () {
      App.undo.redo();
      notifyProject();
    });

    // ---- LODES handlers (Add Data dropdown → LODES popup) ----
    var lodesFileInput = document.getElementById("lodesFile");
    var lodesPopup = document.getElementById("lodes-popup");

    // Build state checkbox list once
    var LODES_STATES = [
      { name: "Alabama", abbr: "al" }, { name: "Alaska", abbr: "ak" },
      { name: "Arizona", abbr: "az" }, { name: "Arkansas", abbr: "ar" },
      { name: "California", abbr: "ca" }, { name: "Colorado", abbr: "co" },
      { name: "Connecticut", abbr: "ct" }, { name: "Delaware", abbr: "de" },
      { name: "District of Columbia", abbr: "dc" }, { name: "Florida", abbr: "fl" },
      { name: "Georgia", abbr: "ga" }, { name: "Hawaii", abbr: "hi" },
      { name: "Idaho", abbr: "id" }, { name: "Illinois", abbr: "il" },
      { name: "Indiana", abbr: "in" }, { name: "Iowa", abbr: "ia" },
      { name: "Kansas", abbr: "ks" }, { name: "Kentucky", abbr: "ky" },
      { name: "Louisiana", abbr: "la" }, { name: "Maine", abbr: "me" },
      { name: "Maryland", abbr: "md" }, { name: "Massachusetts", abbr: "ma" },
      { name: "Michigan", abbr: "mi" }, { name: "Minnesota", abbr: "mn" },
      { name: "Mississippi", abbr: "ms" }, { name: "Missouri", abbr: "mo" },
      { name: "Montana", abbr: "mt" }, { name: "Nebraska", abbr: "ne" },
      { name: "Nevada", abbr: "nv" }, { name: "New Hampshire", abbr: "nh" },
      { name: "New Jersey", abbr: "nj" }, { name: "New Mexico", abbr: "nm" },
      { name: "New York", abbr: "ny" }, { name: "North Carolina", abbr: "nc" },
      { name: "North Dakota", abbr: "nd" }, { name: "Ohio", abbr: "oh" },
      { name: "Oklahoma", abbr: "ok" }, { name: "Oregon", abbr: "or" },
      { name: "Pennsylvania", abbr: "pa" }, { name: "Rhode Island", abbr: "ri" },
      { name: "South Carolina", abbr: "sc" }, { name: "South Dakota", abbr: "sd" },
      { name: "Tennessee", abbr: "tn" }, { name: "Texas", abbr: "tx" },
      { name: "Utah", abbr: "ut" }, { name: "Vermont", abbr: "vt" },
      { name: "Virginia", abbr: "va" }, { name: "Washington", abbr: "wa" },
      { name: "West Virginia", abbr: "wv" }, { name: "Wisconsin", abbr: "wi" },
      { name: "Wyoming", abbr: "wy" }
    ];
    var lodesStateList = document.getElementById("lodes-state-list");
    if (lodesStateList) {
      LODES_STATES.forEach(function (s) {
        var lbl = document.createElement("label");
        lbl.className = "lodes-state-item";
        var rb = document.createElement("input");
        rb.type = "radio";
        rb.name = "lodes-state";
        rb.value = s.abbr;
        lbl.appendChild(rb);
        lbl.appendChild(document.createTextNode(" " + s.name));
        lodesStateList.appendChild(lbl);
      });
    }

    // Open/close LODES popup
    document.getElementById("lodes-employment-btn").addEventListener("click", function () {
      addDataDropdown.style.display = "none";
      lodesPopup.style.display = lodesPopup.style.display === "none" ? "block" : "none";
    });
    document.getElementById("lodes-popup-close").addEventListener("click", function () {
      lodesPopup.style.display = "none";
    });

    // Download
    document.getElementById("lodes-popup-download").addEventListener("click", function () {
      var selected = lodesStateList ? lodesStateList.querySelector("input[type=radio]:checked") : null;
      if (!selected) { App.setStatus("No state selected."); return; }
      var abbr = selected.value;
      var year = "2023";
      var url = "https://lehd.ces.census.gov/data/lodes/LODES8/" + abbr + "/wac/" + abbr + "_wac_S000_JT00_" + year + ".csv.gz";
      App.startDownload(url, abbr + "_wac_S000_JT00_" + year + ".csv.gz");
      App.setStatus("Downloading " + abbr.toUpperCase() + " LODES data\u2026");
    });

    // Add to Map
    document.getElementById("lodes-popup-add").addEventListener("click", function () {
      lodesFileInput.value = "";
      lodesFileInput.click();
    });

    lodesFileInput.addEventListener("change", async function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      this.value = "";
      try {
        var jobsMap = await App.parseLodesFromUploadedFile(file);
        App.mergeLodesFile(jobsMap, file.name);
        App.setStatus("LODES loaded (" + file.name + ")");
        updateAddDataClearIcons();
        notifyProject();
        if (typeof App.cache !== "undefined") App.cache.save();
      } catch (err) {
        App.setStatus("LODES error: " + String(err && err.message ? err.message : err));
      }
    });

    // PPACG Projection UI has moved to the Ridership Forecasting Projections tab.

    // Reset session button: clear everything AND localStorage
    var resetBtn = document.getElementById("reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (!confirm("Reset session? This clears all features, settings, and saved data. This cannot be undone.")) return;
        if (typeof App.cache !== "undefined") App.cache.reset();
        if (typeof App.clearRoadNetwork === "function") App.clearRoadNetwork();
        if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
        if (typeof App.clearPresentOverlays === "function") App.clearPresentOverlays();
        if (typeof App._syncDisplaySliders === "function") App._syncDisplaySliders();
        clearModules();
        notifyProject();
      });
    }

    // ---- Import / Export / Add Data (toolbar buttons) ----
    var importFileInput = document.getElementById("fp-import-file");
    var exportDropdown = document.getElementById("export-dropdown");
    var addDataDropdown = document.getElementById("add-data-dropdown");

    // Export scope toggle (All vs Visible only) — read by the format handler below.
    var exportScope = "all";
    var exportScopeRow = document.getElementById("export-scope-row");
    if (exportScopeRow) {
      // Prevent the document-level "close all dropdowns" click listener (below)
      // from closing this dropdown before the user can pick a format button.
      exportScopeRow.addEventListener("click", function (e) { e.stopPropagation(); });
      exportScopeRow.addEventListener("change", function (e) {
        if (e.target && e.target.name === "export-scope") exportScope = e.target.value;
      });
    }

    // Import file button (inside Add Data dropdown) → open file picker
    document.getElementById("import-file-btn").addEventListener("click", function () {
      addDataDropdown.style.display = "none";
      importFileInput.value = "";
      importFileInput.click();
    });

    // Municipal Boundaries toggle
    var _muniBoundariesActive = false;
    document.getElementById("muni-boundaries-btn").addEventListener("click", function () {
      addDataDropdown.style.display = "none";
      _muniBoundariesActive = !_muniBoundariesActive;
      this.classList.toggle("add-data-active", _muniBoundariesActive);
      if (typeof App.toggleMuniBoundaries === "function") App.toggleMuniBoundaries(_muniBoundariesActive);
    });

    // ---- Add Data clear + eye icons ----
    var _CLRSVG = '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="5.5" r="4.5"/><line x1="3.5" y1="3.5" x2="7.5" y2="7.5"/><line x1="7.5" y1="3.5" x2="3.5" y2="7.5"/></svg>';
    var _EYESVG_OPEN   = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 6s2.5-4 5-4 5 4 5 4-2.5 4-5 4-5-4-5-4z"/><circle cx="6" cy="6" r="1.5"/></svg>';
    var _EYESVG_CLOSED = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 6s2.5-4 5-4 5 4 5 4-2.5 4-5 4-5-4-5-4z"/><circle cx="6" cy="6" r="1.5"/><line x1="2" y1="10" x2="10" y2="2"/></svg>';

    var _adClrCfgs = [
      {
        btnId: "gtfs-load-btn",
        isLoaded: function () {
          return !!(App.map && typeof App.map.getLayer === "function" && App.map.getLayer("gtfs-shapes-layer"));
        },
        clear: function () {
          if (typeof App.clearGTFS === "function") App.clearGTFS();
        },
        hasEye: true,
        isVisible: function () {
          return !!(App.map.getLayer("gtfs-shapes-layer") &&
            App.map.getLayoutProperty("gtfs-shapes-layer", "visibility") !== "none");
        },
        setVisible: function (v) {
          if (typeof App.setGtfsLayersVisible === "function") App.setGtfsLayersVisible(v);
        }
      },
      {
        btnId: "lodes-employment-btn",
        isLoaded: function () { return !!App.lodesData; },
        clear: function () {
          if (typeof App.clearLodesData === "function") App.clearLodesData();
        }
      },
      {
        osmCat: "bus_stops",
        isLoaded: function () {
          return typeof App.osmActiveCategory === "function" && App.osmActiveCategory() === "bus_stops";
        },
        clear: function () {
          if (typeof App.osmToggleCategory === "function") App.osmToggleCategory("bus_stops");
        },
        hasEye: true,
        isVisible: function () {
          return !!(App.map.getLayer("osm-points-layer") &&
            App.map.getLayoutProperty("osm-points-layer", "visibility") !== "none");
        },
        setVisible: function (v) {
          if (App.map.getLayer("osm-points-layer"))
            App.map.setLayoutProperty("osm-points-layer", "visibility", v ? "visible" : "none");
        }
      },
      {
        osmCat: "transit_routes",
        isLoaded: function () {
          return typeof App.osmActiveCategory === "function" && App.osmActiveCategory() === "transit_routes";
        },
        clear: function () {
          if (typeof App.osmToggleCategory === "function") App.osmToggleCategory("transit_routes");
        },
        hasEye: true,
        isVisible: function () {
          return !!(App.map.getLayer("osm-lines-layer") &&
            App.map.getLayoutProperty("osm-lines-layer", "visibility") !== "none");
        },
        setVisible: function (v) {
          if (App.map.getLayer("osm-lines-layer"))
            App.map.setLayoutProperty("osm-lines-layer", "visibility", v ? "visible" : "none");
        }
      },
      {
        btnId: "osm-poi-btn",
        isLoaded: function () {
          return typeof App.osmPoiLoaded === "function" && App.osmPoiLoaded();
        },
        clear: function () {
          if (typeof App.clearOsmPois === "function") App.clearOsmPois();
        },
        hasEye: true,
        isVisible: function () {
          return !!(App.map.getLayer("osm-poi-layer") &&
            App.map.getLayoutProperty("osm-poi-layer", "visibility") !== "none");
        },
        setVisible: function (v) {
          if (typeof App.setOsmPoiLayerVisible === "function") App.setOsmPoiLayerVisible(v);
        }
      },
      {
        btnId: "road-net-download",
        isLoaded: function () {
          return typeof App.roadNetworkLoaded === "function" && App.roadNetworkLoaded();
        },
        clear: function () {
          if (typeof App.clearRoadNetwork === "function") App.clearRoadNetwork();
        }
      },
      {
        btnId: "muni-boundaries-btn",
        isLoaded: function () { return _muniBoundariesActive; },
        clear: function () {
          _muniBoundariesActive = false;
          var b = document.getElementById("muni-boundaries-btn");
          if (b) b.classList.remove("add-data-active");
          if (typeof App.toggleMuniBoundaries === "function") App.toggleMuniBoundaries(false);
        },
        hasEye: true,
        isVisible: function () {
          return !!(App.map.getLayer("muni-boundaries-line") &&
            App.map.getLayoutProperty("muni-boundaries-line", "visibility") !== "none");
        },
        setVisible: function (v) {
          if (typeof App.setMuniBoundariesLayerVisible === "function") App.setMuniBoundariesLayerVisible(v);
        }
      }
    ];

    _adClrCfgs.forEach(function (cfg) {
      var btn = cfg.btnId
        ? document.getElementById(cfg.btnId)
        : addDataDropdown.querySelector("button[data-osm='" + cfg.osmCat + "']");
      if (!btn) return;

      // Eye icon (left of clear) — only for items with a persistent map layer
      if (cfg.hasEye) {
        var eyeSpan = document.createElement("span");
        eyeSpan.className = "add-data-eye";
        eyeSpan.style.display = "none";
        eyeSpan.addEventListener("click", function (e) {
          e.stopPropagation();
          cfg.setVisible(!cfg.isVisible());
          updateAddDataClearIcons();
        });
        btn.appendChild(eyeSpan);
        cfg._eyeSpan = eyeSpan;
      }

      // Clear icon (right)
      var span = document.createElement("span");
      span.className = "add-data-clr";
      span.innerHTML = _CLRSVG;
      span.style.display = "none";
      span.addEventListener("click", function (e) {
        e.stopPropagation();
        cfg.clear();
        updateAddDataClearIcons();
        notifyProject();
        if (typeof App.cache !== "undefined") App.cache.save();
      });
      btn.appendChild(span);
      cfg._span = span;
    });

    function updateAddDataClearIcons() {
      _adClrCfgs.forEach(function (cfg) {
        var loaded = cfg.isLoaded();
        if (cfg._span) cfg._span.style.display = loaded ? "inline-flex" : "none";
        if (cfg._eyeSpan) {
          cfg._eyeSpan.style.display = loaded ? "inline-flex" : "none";
          if (loaded) cfg._eyeSpan.innerHTML = cfg.isVisible() ? _EYESVG_OPEN : _EYESVG_CLOSED;
        }
      });
      // Keep the Layers panel in sync when reference layers load/clear/toggle.
      if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
    }
    App.updateAddDataClearIcons = updateAddDataClearIcons;

    // Route imported file by extension
    importFileInput.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var ext = (file.name.split(".").pop() || "").toLowerCase();
      if (ext === "geojson") {
        if (typeof App.loadRoadNetworkFromFile === "function") App.loadRoadNetworkFromFile(file);
        return;
      }
      if (typeof App.cache === "undefined") return;
      if (ext === "json") {
        App.cache.importFromFile(file);
      } else if (ext === "csv") {
        App.cache.importCSV(file);
      } else if (ext === "kml" || ext === "kmz") {
        App.cache.importKML(file);
      } else if (ext === "shp" || ext === "zip") {
        App.cache.importSHP(file);
      } else {
        alert("Unsupported file format: ." + ext + "\nSupported: .json, .csv, .kml, .shp, .zip");
      }
    });

    // Analysis button → toggle dropdown
    document.getElementById("analysis-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      exportDropdown.style.display = "none";
      if (addDataDropdown) addDataDropdown.style.display = "none";
      if (saveStateDropdown) saveStateDropdown.style.display = "none";
      var isOpen = analysisDropdown.style.display !== "none";
      analysisDropdown.style.display = isOpen ? "none" : "block";
    });

    // Export button → toggle dropdown
    document.getElementById("export-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (addDataDropdown) addDataDropdown.style.display = "none";
      if (analysisDropdown) analysisDropdown.style.display = "none";
      if (saveStateDropdown) saveStateDropdown.style.display = "none";
      var isOpen = exportDropdown.style.display !== "none";
      exportDropdown.style.display = isOpen ? "none" : "block";
    });

    // Export dropdown item click
    exportDropdown.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-format]");
      if (!btn) return;
      exportDropdown.style.display = "none";
      var fmt = btn.getAttribute("data-format");
      if (fmt === "road-network") {
        if (typeof App.exportRoadNetwork === "function") App.exportRoadNetwork();
        return;
      }
      if (typeof App.cache === "undefined") return;
      if (fmt === "json-features") App.cache.exportFeaturesOnly(exportScope);
      else if (fmt === "json-all") App.cache.exportToFile(exportScope);
      else if (fmt === "csv") App.cache.exportCSV(exportScope);
      else if (fmt === "kml") App.cache.exportKML(exportScope);
      else if (fmt === "shp") App.cache.exportSHP(exportScope);
      else if (fmt === "share-link") App.cache.exportShareLink();
    });

    // ---- Add Data dropdown ----
    document.getElementById("add-data-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      exportDropdown.style.display = "none";
      if (analysisDropdown) analysisDropdown.style.display = "none";
      if (saveStateDropdown) saveStateDropdown.style.display = "none";
      var isOpen = addDataDropdown.style.display !== "none";
      addDataDropdown.style.display = isOpen ? "none" : "block";
      // Highlight active category
      if (!isOpen) {
        var active = typeof App.osmActiveCategory === "function" ? App.osmActiveCategory() : null;
        addDataDropdown.querySelectorAll("button[data-osm]").forEach(function (btn) {
          btn.classList.toggle("add-data-active", btn.getAttribute("data-osm") === active);
        });
        updateAddDataClearIcons();
      }
    });

    addDataDropdown.addEventListener("click", function (e) {
      // Road network download
      if (e.target.id === "road-net-download") {
        addDataDropdown.style.display = "none";
        if (typeof App.fetchRoadNetwork === "function") App.fetchRoadNetwork();
        return;
      }
      // OSM layer buttons
      var btn = e.target.closest("button[data-osm]");
      if (!btn) return;
      addDataDropdown.style.display = "none";
      var cat = btn.getAttribute("data-osm");
      if (typeof App.osmToggleCategory === "function") App.osmToggleCategory(cat);
    });

    // ---- Save / Load State dropdown ----
    var saveStateBtn       = document.getElementById("save-state-btn");
    var saveStateDropdown  = document.getElementById("save-state-dropdown");
    var saveStateFileInput = document.getElementById("save-state-file-input");
    var saveStateRecents   = document.getElementById("save-state-recents");

    var _hasFSA = typeof window.showOpenFilePicker === "function";

    function _formatRecentDate(ts) {
      if (!ts) return "";
      var d = new Date(ts);
      var now = Date.now();
      var diffHours = (now - ts) / 3600000;
      if (diffHours < 24) {
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      }
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }

    function renderRecents() {
      if (!saveStateRecents) return;
      if (!_hasFSA || !App.cache || typeof App.cache.listRecents !== "function") {
        saveStateRecents.style.display = "none";
        return;
      }
      App.cache.listRecents().then(function (entries) {
        if (!entries || entries.length === 0) {
          saveStateRecents.style.display = "none";
          saveStateRecents.innerHTML = "";
          return;
        }
        var html = '<div class="save-state-recents-header">RECENT PROJECTS</div>';
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          var nameEsc = String(e.name).replace(/[&<>"']/g, function (c) {
            return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
          });
          html +=
            '<div class="save-state-recent-item" data-id="' + e.id + '" title="' + nameEsc + '">' +
              '<span class="save-state-recent-name">' + nameEsc + '</span>' +
              '<span class="save-state-recent-date">' + _formatRecentDate(e.savedAt) + '</span>' +
              '<button class="save-state-recent-remove" data-id="' + e.id + '" title="Remove from list" aria-label="Remove">&times;</button>' +
            '</div>';
        }
        saveStateRecents.innerHTML = html;
        saveStateRecents.style.display = "block";
      });
    }

    // Let cache.js notify us when recents change (after add/remove from elsewhere)
    App.onRecentsChanged = renderRecents;

    if (saveStateBtn && saveStateDropdown) {
      saveStateBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        exportDropdown.style.display = "none";
        addDataDropdown.style.display = "none";
        if (analysisDropdown) analysisDropdown.style.display = "none";
        var isOpen = saveStateDropdown.style.display !== "none";
        saveStateDropdown.style.display = isOpen ? "none" : "block";
        if (!isOpen) renderRecents();
      });

      var saveBtn = document.getElementById("save-state-save");
      if (saveBtn) {
        saveBtn.addEventListener("click", function () {
          saveStateDropdown.style.display = "none";
          if (App.cache && typeof App.cache.exportFullState === "function") {
            App.cache.exportFullState();
          }
        });
      }

      var loadBtn = document.getElementById("save-state-load");
      if (loadBtn) {
        loadBtn.addEventListener("click", async function () {
          saveStateDropdown.style.display = "none";
          if (_hasFSA) {
            try {
              var handles = await window.showOpenFilePicker({
                types: [{ description: "JSON Session File", accept: { "application/json": [".json"] } }],
                multiple: false
              });
              var handle = handles && handles[0];
              if (!handle) return;
              var file = await handle.getFile();
              App.cache.importFullState(file, handle);
            } catch (err) {
              if (err && err.name === "AbortError") return;
              console.warn("Load state failed:", err);
              App.setStatus("Load state failed: " + (err.message || err));
            }
          } else if (saveStateFileInput) {
            saveStateFileInput.value = "";
            saveStateFileInput.click();
          }
        });
      }

      // Fallback hidden input (used on Firefox/Safari only)
      if (saveStateFileInput) {
        saveStateFileInput.addEventListener("change", function (e) {
          var file = e.target.files && e.target.files[0];
          if (!file) return;
          if (App.cache && typeof App.cache.importFullState === "function") {
            App.cache.importFullState(file);
          }
        });
      }

      // Recent Projects: open / remove handlers (event delegation)
      if (saveStateRecents) {
        saveStateRecents.addEventListener("click", function (e) {
          e.stopPropagation();
          var removeBtn = e.target.closest(".save-state-recent-remove");
          if (removeBtn) {
            var rid = parseInt(removeBtn.getAttribute("data-id"), 10);
            if (!isNaN(rid) && App.cache && typeof App.cache.removeRecent === "function") {
              App.cache.removeRecent(rid).then(renderRecents);
            }
            return;
          }
          var item = e.target.closest(".save-state-recent-item");
          if (item) {
            var id = parseInt(item.getAttribute("data-id"), 10);
            if (!isNaN(id) && App.cache && typeof App.cache.openRecent === "function") {
              saveStateDropdown.style.display = "none";
              App.cache.openRecent(id);
            }
          }
        });
      }
    }

    // Close dropdowns on outside click or Escape
    var searchResults = document.getElementById("search-results");
    document.addEventListener("click", function () {
      exportDropdown.style.display = "none";
      addDataDropdown.style.display = "none";
      if (analysisDropdown) analysisDropdown.style.display = "none";
      if (saveStateDropdown) saveStateDropdown.style.display = "none";
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        exportDropdown.style.display = "none";
        addDataDropdown.style.display = "none";
        if (analysisDropdown) analysisDropdown.style.display = "none";
        if (saveStateDropdown) saveStateDropdown.style.display = "none";
        if (searchResults) searchResults.style.display = "none";
        if (typeof _closeFpSlider === "function") _closeFpSlider();
      }
    });

    // ---- Whole-row click for feature checklists (UI only) ----
    // Every module builds its checklist rows the same way:
    //   div.rf-feature-check-row > input[type=checkbox] + label + span.badge
    // The checkbox and the label already handle their own clicks, but the row's
    // padding and the type badge did not, so a click just beside the name did
    // nothing. Rather than edit ten near-identical addRow() builders, one
    // delegated listener covers every module — current and future. It toggles
    // the row's checkbox and dispatches a real "change" event, so each module's
    // existing handler (markStale, etc.) runs exactly as if the box was clicked.
    document.addEventListener("click", function (e) {
      var row = e.target.closest && e.target.closest(".rf-feature-check-row");
      if (!row) return;
      if (e.target.tagName === "INPUT") return;          // the box itself
      var cb = row.querySelector('input[type="checkbox"]');
      if (!cb || cb.disabled) return;
      var lbl = e.target.closest("label");
      if (lbl) {
        // Skip labels that already toggle on their own: most modules attach a
        // handler that calls preventDefault() (which has run by the time this
        // bubbles to document), and a for=/wrapping label toggles natively.
        if (e.defaultPrevented || lbl.htmlFor || lbl.contains(cb)) return;
      }
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Checkbox change listeners — now wired in buffer-summary.js init()

    // Wrap render/rebuild functions to re-apply opacity + line width after layers are recreated
    (function () {
      function _wrapRender(fnName, applyFn) {
        var orig = App[fnName];
        if (typeof orig !== "function") return;
        App[fnName] = function () {
          orig.apply(this, arguments);
          applyFn();
        };
      }
      _wrapRender("rebuildBuffers",     function () { App.applyFeatureOpacity("buffer"); App.applyBufferLineWidth(); });
      _wrapRender("rebuildLineBuffers", function () { App.applyFeatureOpacity("buffer"); App.applyBufferLineWidth(); });
      _wrapRender("rebuildRouteBuffers",function () { App.applyFeatureOpacity("buffer"); App.applyBufferLineWidth(); });
      _wrapRender("renderPointLayers",  function () { App.applyFeatureOpacity("point");  App.applyLineWidth("point"); });
      _wrapRender("renderLineLayers",   function () { App.applyFeatureOpacity("line");   App.applyLineWidth("line"); });
      _wrapRender("renderRouteLayers",  function () { App.applyFeatureOpacity("route");  App.applyLineWidth("route"); });
      _wrapRender("renderPolygonLayers",function () { App.applyFeatureOpacity("polygon"); App.applyLineWidth("polygon"); });
    })();

    // Restore session: shared link takes priority over localStorage
    var _sharedLoaded = typeof App.cache !== "undefined" && App.cache.loadShareLink();
    if (_sharedLoaded) {
      notifyProject();
    } else if (typeof App.cache !== "undefined" && App.cache.restore()) {
      App.setStatus("Session restored");
      notifyProject();
    }
    if (typeof App._syncDisplaySliders === "function") App._syncDisplaySliders();

    // "Start fresh" link in view-only banner
    var _viewOnlyFreshBtn = document.getElementById("view-only-start-fresh");
    if (_viewOnlyFreshBtn) {
      _viewOnlyFreshBtn.addEventListener("click", function (e) {
        e.preventDefault();
        window.location.hash = "";
        window.location.reload();
      });
    }
  });
})();
