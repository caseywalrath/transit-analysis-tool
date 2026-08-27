// js/core/layers-panel.js
// "Layers" tab on the right feature panel. A unified manager for everything on
// the map: drawn features (nested by user group), reference/imported layers
// (GTFS, OSM, muni boundaries), analysis choropleths (TPI, Corridor Scoring,
// Ridership), and the basemap. Visibility + opacity + basemap, constrained
// drag-reorder within the Reference/Analysis bands, and a per-row ⋯ menu
// (zoom to, open module, remove, rename group).
// Depends on: App.map, App.collectDrawnFeatures, App.UNIVERSAL_GROUP_KEY,
//             App.rerenderForType, App.openColorPicker, App._openFpSlider,
//             App.applyFeatureOpacity, App.getBasemaps, App.switchBasemap,
//             App.cache, App.refreshFeaturePanel.
(function () {
  var App = window.App = window.App || {};

  var EYE_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 13 1 13a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>' +
    '<line x1="1" y1="1" x2="23" y2="23"/></svg>';
  var OPACITY_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2"><circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>';

  // ---- Reference + analysis layer manifest ----
  // Each entry: { id (presence/detect key), label, layers:[{id, op}] }.
  function callIf(fn) { return function () { if (typeof App[fn] === "function") App[fn].apply(App, arguments); }; }

  var REFERENCE = [
    { id: "muni-boundaries-line", label: "Municipal boundaries", layers: [{ id: "muni-boundaries-line", op: "line-opacity" }],
      clear: function () { if (typeof App.toggleMuniBoundaries === "function") App.toggleMuniBoundaries(false); } },
    { id: "road-dl-area-line",    label: "Road download area",   layers: [{ id: "road-dl-area-line", op: "line-opacity" }],
      clear: callIf("clearRoadDownloadArea") },
    { id: "gtfs-shapes-layer",    label: "GTFS routes",          layers: [{ id: "gtfs-shapes-layer", op: "line-opacity" }],
      clear: callIf("clearGTFS") },
    { id: "gtfs-stops-layer",     label: "GTFS stops",           layers: [{ id: "gtfs-stops-layer", op: "circle-opacity" }],
      clear: callIf("clearGTFS") },
    { id: "osm-points-layer",     label: "OSM points",           layers: [{ id: "osm-points-layer", op: "circle-opacity" }],
      clear: function () { if (typeof App.osmToggleCategory === "function") App.osmToggleCategory("bus_stops"); } },
    { id: "osm-lines-layer",      label: "OSM lines",            layers: [{ id: "osm-lines-layer", op: "line-opacity" }],
      clear: function () { if (typeof App.osmToggleCategory === "function") App.osmToggleCategory("transit_routes"); } },
    { id: "osm-poi-layer",        label: "OSM points of interest", layers: [{ id: "osm-poi-layer", op: "circle-opacity" }],
      clear: callIf("clearOsmPois") }
  ];
  var ANALYSIS = [
    { id: "bas-choropleth-fill", label: "Feature Area Analysis", moduleId: "buffer-summary",
      layers: [{ id: "bas-choropleth-fill", op: "fill-opacity" }, { id: "bas-choropleth-line", op: "line-opacity" }] },
    { id: "tpi-choropleth-fill", label: "Transit Propensity", moduleId: "transit-propensity",
      layers: [{ id: "tpi-choropleth-fill", op: "fill-opacity" }, { id: "tpi-choropleth-line", op: "line-opacity" }] },
    { id: "corridor-scoring-routes-layer", label: "Corridor Scoring", moduleId: "corridor-scoring",
      layers: [{ id: "corridor-scoring-routes-layer", op: "line-opacity" }] },
    { id: "rf-choropleth-fill", label: "Ridership Forecast", moduleId: "ridership-forecasting",
      layers: [{ id: "rf-choropleth-fill", op: "fill-opacity" }, { id: "rf-choropleth-line", op: "line-opacity" }, { id: "rf-corridor-cdi-layer", op: "line-opacity" }] },
    { id: "ts-travelshed-fill", label: "Transit Travelshed", moduleId: "transit-travelshed",
      layers: [{ id: "ts-travelshed-fill", op: "fill-opacity" }, { id: "ts-travelshed-line", op: "line-opacity" }] },
    // Added after an audit found five map-rendering surfaces were never
    // registered here, so their output was invisible to this panel — no
    // show/hide, no opacity, no reorder. Entries only render when the layer is
    // actually on the map (see entryPresent), so listing them all is safe.
    { id: "transit-coverage-coverage-layer", label: "Transit Coverage", moduleId: "transit-coverage",
      layers: [{ id: "transit-coverage-coverage-layer", op: "fill-opacity" },
               { id: "transit-coverage-threshold-layer", op: "fill-opacity" },
               { id: "transit-coverage-area-layer", op: "line-opacity" }] },
    { id: "walkshed-fill", label: "Walkshed", moduleId: "walkshed",
      layers: [{ id: "walkshed-fill", op: "fill-opacity" },
               { id: "walkshed-line", op: "line-opacity" },
               { id: "walkshed-seg", op: "line-opacity" }] },
    { id: "tvi-impacted-fill", label: "Title VI service change", moduleId: "title-vi",
      layers: [{ id: "tvi-impacted-fill", op: "fill-opacity" },
               { id: "tvi-impacted-outline", op: "line-opacity" },
               { id: "tvi-gain-fill", op: "fill-opacity" },
               { id: "tvi-gain-outline", op: "line-opacity" }] },
    { id: "lbar-sites-layer", label: "FTA land-use sites", moduleId: "fta-small-starts",
      layers: [{ id: "lbar-sites-layer", op: "circle-opacity" }] },
    // Not a module of its own — census.js renders this for whichever analysis
    // last fetched geographies, so it gets no moduleId.
    { id: "census-geos-fill", label: "Census geographies",
      layers: [{ id: "census-geos-fill", op: "fill-opacity" },
               { id: "census-geos-line", op: "line-opacity" }] }
  ];

  // Per-session band ordering (panel order = map order, top of list = top of map).
  var _refOrder = REFERENCE.map(function (e) { return e.id; });
  var _analysisOrder = ANALYSIS.map(function (e) { return e.id; });

  function orderedPresent(entries, order) {
    var byId = {};
    entries.forEach(function (e) { byId[e.id] = e; });
    return order.map(function (id) { return byId[id]; })
                .filter(function (e) { return e && entryPresent(e); });
  }

  var DRAWN_TYPES = [
    { type: "point",   label: "Points"   },
    { type: "line",    label: "Lines"    },
    { type: "route",   label: "Routes"   },
    { type: "polygon", label: "Polygons" }
  ];

  // ---- Map helpers ----
  function entryPresent(entry) {
    var map = App.map;
    return !!map && entry.layers.some(function (L) { return map.getLayer(L.id); });
  }
  function entryVisible(entry) {
    var map = App.map;
    for (var i = 0; i < entry.layers.length; i++) {
      var L = entry.layers[i];
      if (map.getLayer(L.id)) return map.getLayoutProperty(L.id, "visibility") !== "none";
    }
    return false;
  }
  function setEntryVisible(entry, vis) {
    var map = App.map;
    entry.layers.forEach(function (L) {
      if (map.getLayer(L.id)) map.setLayoutProperty(L.id, "visibility", vis ? "visible" : "none");
    });
  }
  function entryOpacity(entry) {
    var map = App.map;
    for (var i = 0; i < entry.layers.length; i++) {
      var L = entry.layers[i];
      if (map.getLayer(L.id)) {
        var v = map.getPaintProperty(L.id, L.op);
        return (typeof v === "number") ? v : 1;
      }
    }
    return 1;
  }
  function setEntryOpacity(entry, frac) {
    var map = App.map;
    entry.layers.forEach(function (L) {
      if (map.getLayer(L.id)) map.setPaintProperty(L.id, L.op, frac);
    });
  }

  var MENU_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">' +
    '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
  var GRIP_SVG =
    '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">' +
    '<circle cx="3" cy="3" r="1.1"/><circle cx="7" cy="3" r="1.1"/><circle cx="3" cy="7" r="1.1"/>' +
    '<circle cx="7" cy="7" r="1.1"/><circle cx="3" cy="11" r="1.1"/><circle cx="7" cy="11" r="1.1"/></svg>';

  // Fit the map to a layer entry by reading its GeoJSON source data.
  function zoomToEntry(entry) {
    var map = App.map;
    for (var i = 0; i < entry.layers.length; i++) {
      var sl = map.getLayer(entry.layers[i].id);
      if (!sl) continue;
      var src = map.getSource(sl.source);
      var data = src && src._data;
      if (!data) continue;
      try {
        var bb = turf.bbox(data);
        if (bb && bb.every(function (n) { return isFinite(n); })) {
          if (bb[0] === bb[2] && bb[1] === bb[3]) {
            map.easeTo({ center: [bb[0], bb[1]], zoom: Math.max(map.getZoom(), 14), duration: 600 });
          } else {
            map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 40, duration: 600 });
          }
          return;
        }
      } catch (e) { /* fall through */ }
    }
    if (typeof App.setStatus === "function") App.setStatus("Could not determine layer extent.");
  }

  function zoomToFeatures(items) {
    if (!items.length || typeof turf === "undefined") return;
    var fc = { type: "FeatureCollection", features: items.map(function (it) { return it.feature; }) };
    try {
      var bb = turf.bbox(fc);
      App.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 600 });
    } catch (e) { /* ignore */ }
  }

  // Reorder a band's map layers to match panel order (top of list = top of map),
  // staying clamped within the band — the layer above the band keeps its place.
  function applyBandOrder(presentEntries) {
    var map = App.map;
    if (!presentEntries.length) return;
    var allIds = [];
    presentEntries.forEach(function (e) {
      e.layers.forEach(function (L) { if (map.getLayer(L.id)) allIds.push(L.id); });
    });
    var styleIds = map.getStyle().layers.map(function (l) { return l.id; });
    var maxIdx = -1;
    allIds.forEach(function (id) { var i = styleIds.indexOf(id); if (i > maxIdx) maxIdx = i; });
    var anchor = styleIds[maxIdx + 1]; // layer above the band (or undefined = top)
    var beforeId = anchor;
    presentEntries.forEach(function (entry) {
      entry.layers.forEach(function (L) {
        if (map.getLayer(L.id)) map.moveLayer(L.id, beforeId);
      });
      var bottom = entry.layers[0] && entry.layers[0].id;
      if (bottom && map.getLayer(bottom)) beforeId = bottom;
    });
  }

  // ---- Drag-to-reorder (within a single band) ----
  var _drag = null; // { band, id }

  function attachDrag(row, bandKey, entryId, order, getPresent) {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", function (e) {
      _drag = { band: bandKey, id: entryId };
      row.classList.add("lp-dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", function () {
      row.classList.remove("lp-dragging");
      _drag = null;
    });
    row.addEventListener("dragover", function (e) {
      if (!_drag || _drag.band !== bandKey || _drag.id === entryId) return;
      e.preventDefault();
      row.classList.add("lp-drop-target");
    });
    row.addEventListener("dragleave", function () { row.classList.remove("lp-drop-target"); });
    row.addEventListener("drop", function (e) {
      row.classList.remove("lp-drop-target");
      if (!_drag || _drag.band !== bandKey || _drag.id === entryId) return;
      e.preventDefault();
      var from = order.indexOf(_drag.id);
      var to = order.indexOf(entryId);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, _drag.id);
      applyBandOrder(getPresent());
      render();
    });
  }

  // ---- Generic row builder (reference / analysis) ----
  function buildLayerRow(entry, bandKey, order, getPresent) {
    var row = document.createElement("div");
    row.className = "lp-row lp-row-draggable";

    var grip = document.createElement("span");
    grip.className = "lp-grip";
    grip.innerHTML = GRIP_SVG;
    grip.title = "Drag to reorder";
    row.appendChild(grip);

    var vis = entryVisible(entry);
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "lp-row-btn" + (vis ? "" : " lp-eye-off");
    eye.innerHTML = vis ? EYE_SVG : EYE_OFF_SVG;
    eye.title = vis ? "Hide layer" : "Show layer";
    eye.setAttribute("aria-label", (vis ? "Hide " : "Show ") + entry.label);
    eye.addEventListener("click", function (e) {
      e.stopPropagation();
      setEntryVisible(entry, !entryVisible(entry));
      // Keep the Add Data dropdown eye icons in sync (single source of truth);
      // updateAddDataClearIcons() also re-renders this panel.
      if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();
      else render();
    });
    row.appendChild(eye);

    var name = document.createElement("span");
    name.className = "lp-row-label";
    name.textContent = entry.label;
    row.appendChild(name);

    var op = document.createElement("button");
    op.type = "button";
    op.className = "lp-row-btn lp-row-op";
    op.innerHTML = OPACITY_SVG;
    op.title = "Opacity";
    op.setAttribute("aria-label", "Change opacity for " + entry.label);
    op.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App._openFpSlider !== "function") return;
      App._openFpSlider(op, {
        value: Math.round(entryOpacity(entry) * 100),
        min: 0, max: 100, step: 5, unit: "%",
        onChange: function (v) { setEntryOpacity(entry, v / 100); }
      });
    });
    row.appendChild(op);

    var menu = document.createElement("button");
    menu.type = "button";
    menu.className = "lp-row-btn lp-row-menu";
    menu.innerHTML = MENU_SVG;
    menu.title = "More";
    menu.setAttribute("aria-label", "More actions for " + entry.label);
    menu.addEventListener("click", function (e) {
      e.stopPropagation();
      var opts = [{ label: "Zoom to layer", action: function () { zoomToEntry(entry); } }];
      if (entry.moduleId) {
        opts.push({ label: "Open module", action: function () {
          if (typeof App.openModulePopup === "function") App.openModulePopup(entry.moduleId);
        } });
      }
      if (typeof entry.clear === "function") {
        opts.push({ label: "Remove layer", action: function () {
          entry.clear();
          if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();
          render();
        } });
      }
      if (typeof App.showContextMenu === "function") {
        App.showContextMenu(e.clientX, e.clientY, opts);
      }
    });
    row.appendChild(menu);

    attachDrag(row, bandKey, entry.id, order, getPresent);
    return row;
  }

  // ---- Drawn features (nested by user group) ----
  function collectGroups() {
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    var key = App.UNIVERSAL_GROUP_KEY || "group";
    var groups = {}, ungrouped = [];
    all.forEach(function (it) {
      var a = it.feature.properties.attributes;
      var g = a && a[key];
      if (g) { (groups[g] = groups[g] || []).push(it); }
      else { ungrouped.push(it); }
    });
    return { groups: groups, ungrouped: ungrouped };
  }

  function setItemsHidden(items, hide) {
    var types = {};
    items.forEach(function (it) {
      if (hide) it.feature.properties.hidden = true;
      else delete it.feature.properties.hidden;
      types[it.type] = true;
    });
    Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  // Solo: show only the given items, hide every other drawn feature.
  function soloItems(items) {
    var keep = {};
    items.forEach(function (it) { keep[it.type + ":" + it.index] = true; });
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    var types = {};
    all.forEach(function (it) {
      if (keep[it.type + ":" + it.index]) delete it.feature.properties.hidden;
      else it.feature.properties.hidden = true;
      types[it.type] = true;
    });
    Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    render();
  }

  function showAllDrawn() {
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    var types = {};
    all.forEach(function (it) {
      if (it.feature.properties.hidden) { delete it.feature.properties.hidden; types[it.type] = true; }
    });
    Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    render();
  }

  function anyDrawnHidden() {
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    return all.some(function (it) { return !!it.feature.properties.hidden; });
  }

  function buildFeatureRow(it) {
    var row = document.createElement("div");
    row.className = "lp-row lp-row-sub";

    var hidden = !!it.feature.properties.hidden;
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "lp-row-btn" + (hidden ? " lp-eye-off" : "");
    eye.innerHTML = hidden ? EYE_OFF_SVG : EYE_SVG;
    eye.title = hidden ? "Show" : "Hide";
    eye.setAttribute("aria-label", (hidden ? "Show " : "Hide ") +
      (it.feature.properties.name || (it.type + " " + (it.index + 1))));
    eye.addEventListener("click", function (e) {
      e.stopPropagation();
      setItemsHidden([it], !it.feature.properties.hidden);
      render();
    });
    row.appendChild(eye);

    var color = it.feature.properties.color || App.getTypeDefaultColor(it.type);
    var sw = document.createElement("button");
    sw.type = "button";
    sw.className = "lp-swatch";
    sw.style.background = color;
    sw.title = "Change color";
    sw.setAttribute("aria-label", "Change color for " +
      (it.feature.properties.name || (it.type + " " + (it.index + 1))));
    sw.addEventListener("click", function (e) {
      e.stopPropagation();
      App.openColorPicker(sw, it.feature.properties.color || color, function (nc) {
        it.feature.properties.color = nc;
        sw.style.background = nc;
        App.rerenderForType(it.type);
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
      });
    });
    row.appendChild(sw);

    var name = document.createElement("span");
    name.className = "lp-row-label";
    name.textContent = it.feature.properties.name || (it.type + " " + (it.index + 1));
    row.appendChild(name);

    return row;
  }

  var _expandedGroups = {};

  function buildGroupBlock(groupName, items) {
    var block = document.createElement("div");
    block.className = "lp-group";

    var header = document.createElement("div");
    header.className = "lp-row lp-group-header";

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "lp-caret";
    var open = !!_expandedGroups[groupName];
    toggle.innerHTML = "&#9662;";
    toggle.classList.toggle("open", open);
    toggle.setAttribute("aria-label", "Toggle group " + groupName);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    header.appendChild(toggle);

    var allHidden = items.every(function (it) { return !!it.feature.properties.hidden; });
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "lp-row-btn" + (allHidden ? " lp-eye-off" : "");
    eye.innerHTML = allHidden ? EYE_OFF_SVG : EYE_SVG;
    eye.title = allHidden ? "Show all" : "Hide all";
    eye.setAttribute("aria-label", (allHidden ? "Show" : "Hide") + " group " + groupName);
    eye.addEventListener("click", function (e) {
      e.stopPropagation();
      setItemsHidden(items, !allHidden);
      render();
    });
    header.appendChild(eye);

    var firstColor = items[0].feature.properties.color || App.getTypeDefaultColor(items[0].type);
    var sw = document.createElement("button");
    sw.type = "button";
    sw.className = "lp-swatch";
    sw.style.background = firstColor;
    sw.title = "Change color for all in group";
    sw.setAttribute("aria-label", "Change color for group " + groupName);
    sw.addEventListener("click", function (e) {
      e.stopPropagation();
      App.openColorPicker(sw, firstColor, function (nc) {
        var types = {};
        items.forEach(function (it) { it.feature.properties.color = nc; types[it.type] = true; });
        sw.style.background = nc;
        Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        render();
      });
    });
    header.appendChild(sw);

    var name = document.createElement("span");
    name.className = "lp-row-label";
    name.textContent = groupName + " (" + items.length + ")";
    header.appendChild(name);

    var isUngrouped = (groupName === "Ungrouped");
    var menu = document.createElement("button");
    menu.type = "button";
    menu.className = "lp-row-btn lp-row-menu";
    menu.innerHTML = MENU_SVG;
    menu.title = "More";
    menu.setAttribute("aria-label", "More actions for group " + groupName);
    menu.addEventListener("click", function (e) {
      e.stopPropagation();
      var opts = [
        { label: "Zoom to group", action: function () { zoomToFeatures(items); } },
        { label: "Solo (hide other features)", action: function () { soloItems(items); } }
      ];
      if (anyDrawnHidden()) {
        opts.push({ label: "Show all features", action: function () { showAllDrawn(); } });
      }
      if (!isUngrouped) {
        opts.push({ label: "Rename group", action: function () { renameGroup(groupName, items); } });
      }
      if (typeof App.showContextMenu === "function") App.showContextMenu(e.clientX, e.clientY, opts);
    });
    header.appendChild(menu);

    var body = document.createElement("div");
    body.className = "lp-group-body";
    body.style.display = open ? "" : "none";
    items.forEach(function (it) { body.appendChild(buildFeatureRow(it)); });

    function toggleOpen(e) {
      if (e.target !== toggle && !toggle.contains(e.target) &&
          e.target !== name) return;
      e.stopPropagation();
      var isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "";
      toggle.classList.toggle("open", !isOpen);
      toggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
      if (isOpen) delete _expandedGroups[groupName];
      else _expandedGroups[groupName] = true;
    }
    header.addEventListener("click", toggleOpen);

    block.appendChild(header);
    block.appendChild(body);
    return block;
  }

  function renameGroup(oldName, items) {
    var nn = window.prompt("Rename group", oldName);
    if (nn == null) return;
    nn = nn.trim();
    if (!nn || nn === oldName) return;
    var key = App.UNIVERSAL_GROUP_KEY || "group";
    items.forEach(function (it) {
      if (!it.feature.properties.attributes) it.feature.properties.attributes = {};
      it.feature.properties.attributes[key] = nn;
    });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    render();
  }

  // ---- Band scaffolding ----
  function buildBand(title) {
    var band = document.createElement("div");
    band.className = "lp-band";
    var h = document.createElement("div");
    h.className = "lp-band-title";
    h.textContent = title;
    band.appendChild(h);
    return band;
  }

  function buildTypeOpacityRow(t) {
    var row = document.createElement("div");
    row.className = "lp-row lp-row-sub";
    var label = document.createElement("span");
    label.className = "lp-row-label lp-row-label-indent";
    label.textContent = t.label + " opacity";
    row.appendChild(label);

    var op = document.createElement("button");
    op.type = "button";
    op.className = "lp-row-btn lp-row-op";
    op.innerHTML = OPACITY_SVG;
    op.title = t.label + " opacity";
    op.setAttribute("aria-label", "Change " + t.label + " opacity");
    op.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App._openFpSlider !== "function") return;
      App._openFpSlider(op, {
        key: t.type + "Opacity",
        min: 0, max: 100, step: 5, unit: "%",
        onChange: function () { App.applyFeatureOpacity(t.type); }
      });
    });
    row.appendChild(op);
    return row;
  }

  // ---- Basemap row ----
  function buildBasemapBand() {
    var band = buildBand("Basemap");
    if (typeof App.getBasemaps !== "function") return band;
    var row = document.createElement("div");
    row.className = "lp-row";
    var sel = document.createElement("select");
    sel.className = "lp-basemap-select";
    var cur = (typeof App.getCurrentBasemapId === "function") ? App.getCurrentBasemapId() : null;
    App.getBasemaps().forEach(function (b) {
      var o = document.createElement("option");
      o.value = b.id; o.textContent = b.name;
      if (b.id === cur) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      if (typeof App.switchBasemap === "function") App.switchBasemap(sel.value);
    });
    row.appendChild(sel);
    band.appendChild(row);
    return band;
  }

  // ---- Render ----
  function render() {
    var host = document.getElementById("fp-tab-layers");
    if (!host) return;
    host.innerHTML = "";

    // Drawn
    var drawnBand = buildBand("Drawn");
    var gc = collectGroups();
    var groupNames = Object.keys(gc.groups).sort();
    var anyDrawn = groupNames.length || gc.ungrouped.length;
    if (anyDrawn) {
      groupNames.forEach(function (gn) {
        drawnBand.appendChild(buildGroupBlock(gn, gc.groups[gn]));
      });
      if (gc.ungrouped.length) {
        drawnBand.appendChild(buildGroupBlock("Ungrouped", gc.ungrouped));
      }
      // Per-geometry-type opacity (drawn features share one layer per type)
      DRAWN_TYPES.forEach(function (t) {
        var arr = App[t.type === "point" ? "points" : t.type + "s"];
        if (arr && arr.length) drawnBand.appendChild(buildTypeOpacityRow(t));
      });
    } else {
      var empty = document.createElement("div");
      empty.className = "lp-empty";
      empty.textContent = "No drawn features yet.";
      drawnBand.appendChild(empty);
    }
    host.appendChild(drawnBand);

    // Analysis overlays (only those currently on the map)
    var getAnalysis = function () { return orderedPresent(ANALYSIS, _analysisOrder); };
    var analysisPresent = getAnalysis();
    if (analysisPresent.length) {
      var aBand = buildBand("Analysis overlays");
      analysisPresent.forEach(function (e) {
        aBand.appendChild(buildLayerRow(e, "analysis", _analysisOrder, getAnalysis));
      });
      host.appendChild(aBand);
    }

    // Reference / imported (only those currently on the map)
    var getRef = function () { return orderedPresent(REFERENCE, _refOrder); };
    var refPresent = getRef();
    if (refPresent.length) {
      var rBand = buildBand("Reference / Imported");
      refPresent.forEach(function (e) {
        rBand.appendChild(buildLayerRow(e, "reference", _refOrder, getRef));
      });
      host.appendChild(rBand);
    }

    // Basemap
    host.appendChild(buildBasemapBand());
  }

  function refreshLayersPanel() {
    var host = document.getElementById("fp-tab-layers");
    // Only rebuild when the Layers tab is actually visible (cheap no-op otherwise).
    if (!host || host.style.display === "none") return;
    render();
  }

  App.refreshLayersPanel = refreshLayersPanel;
})();
