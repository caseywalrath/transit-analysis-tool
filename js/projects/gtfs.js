// js/projects/gtfs.js
// GTFS Feed Viewer: loads a GTFS ZIP, renders shapes + stops as reference
// map layers with hover/click popups, and provides a popup CSV table viewer
// for all feed files.
// Depends on: JSZip (CDN), PapaParse (CDN), maplibregl (CDN), App namespace.

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Module-local state ----
  var _gtfsData    = null;   // Map<filename, { headers: [], rows: [] }>
  var _selectedFile = null;  // currently active file in the directory list
  var _initialized  = false;
  var _showRoutes   = true;
  var _showStops    = true;
  var _shapesFC     = null;  // stored shapes FeatureCollection for full-geometry lookup
  var _hoverPopup   = null;  // maplibregl.Popup for hover tooltips
  var _clickPopup   = null;  // maplibregl.Popup for click details
  var _layerListeners = [];  // [{ event, layerId, handler }] for explicit map.off() on tear-down

  // GTFS files in preferred display order
  var FILE_ORDER = [
    "agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt",
    "calendar.txt", "calendar_dates.txt", "shapes.txt", "frequencies.txt",
    "transfers.txt", "fare_attributes.txt", "fare_rules.txt",
    "feed_info.txt", "attributions.txt"
  ];

  // Files classified as Required in the GTFS spec
  var REQUIRED = {
    "agency.txt": true, "stops.txt": true, "routes.txt": true,
    "trips.txt": true, "stop_times.txt": true,
    "calendar.txt": true, "calendar_dates.txt": true
  };

  // GTFS route_type integer → human-readable label
  var ROUTE_TYPE_LABELS = {
    0: "Tram/Streetcar", 1: "Subway/Metro", 2: "Rail", 3: "Bus",
    4: "Ferry", 5: "Cable Car", 6: "Aerial Tramway", 7: "Funicular",
    11: "Trolleybus", 12: "Monorail"
  };

  // location_type mappings for stop click popup
  var LOCATION_TYPE_LABELS = {
    "0": "Stop", "1": "Station", "2": "Entrance/Exit",
    "3": "Generic Node", "4": "Boarding Area"
  };

  // wheelchair_boarding mappings
  var WHEELCHAIR_LABELS = {
    "1": "Accessible", "2": "Not accessible"
  };

  // ---- Popup guard (analysis popup, not map popups) ----
  function isPopupVisible() {
    return App.popup && App.popup.isOpen() &&
           App.popup.currentModuleId() === "gtfs";
  }

  // ---- MapLibre popup helpers ----

  function ensurePopups() {
    if (!_hoverPopup)
      _hoverPopup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, maxWidth: "280px"
      });
    if (!_clickPopup)
      _clickPopup = new maplibregl.Popup({
        closeButton: true, closeOnClick: true, maxWidth: "320px"
      });
  }

  function removePopups() {
    if (_hoverPopup) _hoverPopup.remove();
    if (_clickPopup) _clickPopup.remove();
  }

  // ---- ZIP / CSV parsing ----

  async function loadGTFSFile(file) {
    App.setStatus("Reading GTFS feed\u2026");
    try {
      var zip = await JSZip.loadAsync(file);
    } catch (e) {
      App.setStatus("GTFS error: not a valid ZIP file.");
      return;
    }

    var data = new Map();
    var entries = [];

    // Collect all .txt files (handles top-level or inside a folder)
    zip.forEach(function (path, entry) {
      if (entry.dir) return;
      var name = path.split("/").pop(); // strip any subfolder prefix
      if (name.endsWith(".txt")) entries.push({ name: name, entry: entry });
    });

    if (!entries.length) {
      App.setStatus("GTFS error: no .txt files found in ZIP.");
      return;
    }

    // Require at least one GTFS-spec required file before treating this as a feed.
    var hasRequired = entries.some(function (e) { return REQUIRED[e.name]; });
    if (!hasRequired) {
      App.setStatus("GTFS error: ZIP contains no required GTFS files (stops, routes, trips, stop_times, calendar, calendar_dates, or agency).");
      return;
    }

    App.setStatus("Parsing GTFS files\u2026");
    for (var i = 0; i < entries.length; i++) {
      var name  = entries[i].name;
      var entry = entries[i].entry;
      try {
        var text   = await entry.async("string");
        var parsed = Papa.parse(text.trim(), {
          header:         true,
          skipEmptyLines: true,
          dynamicTyping:  false
        });
        data.set(name, {
          headers: parsed.meta.fields || [],
          rows:    parsed.data
        });
      } catch (e) {
        console.warn("GTFS: could not parse", name, e);
      }
    }

    applyGtfsData(data);
    App.setStatus("GTFS loaded: " + data.size + " file(s).");
  }

  // Post-parse step shared by file-upload and restore-from-session paths.
  function applyGtfsData(dataMap) {
    _gtfsData = dataMap;
    _selectedFile = null;

    addMapLayers();
    updateDropdownUI();

    if (isPopupVisible()) {
      renderFileList();
      showSelectPrompt();
    }

    if (typeof App.notifyProject === "function") App.notifyProject();
  }

  // Restore GTFS feed from a previously serialized state-file payload.
  // serialized: { "stops.txt": { headers: [...], rows: [...] }, ... }
  function restoreGTFSFromData(serialized) {
    if (!serialized || typeof serialized !== "object") return;
    var dataMap = new Map();
    Object.keys(serialized).forEach(function (k) {
      dataMap.set(k, serialized[k]);
    });
    if (dataMap.size === 0) return;
    applyGtfsData(dataMap);
    App.setStatus("GTFS restored: " + dataMap.size + " file(s).");
  }

  // Serialize the current _gtfsData Map to a plain JSON-friendly object.
  // Returns null when no feed is loaded.
  function serializeGTFSData() {
    if (!_gtfsData || _gtfsData.size === 0) return null;
    var out = {};
    _gtfsData.forEach(function (val, key) { out[key] = val; });
    return out;
  }

  function clearGTFS() {
    _gtfsData = null;
    _selectedFile = null;
    removeMapLayers(); // also removes popups
    updateDropdownUI();
    if (isPopupVisible()) {
      renderFileList();
      showSelectPrompt();
      var mc = document.getElementById("gtfsMapControls");
      if (mc) mc.style.display = "none";
    }
    App.setStatus("GTFS feed cleared.");

    if (typeof App.notifyProject === "function") App.notifyProject();
  }

  // ---- Route lookup (shape_id → route info) ----
  // Built from trips.txt + routes.txt when available. Merged into shape
  // feature properties at load time so hover requires no runtime join.

  function buildRouteLookup(data) {
    var lookup = new Map();
    if (!data.has("trips.txt") || !data.has("routes.txt")) return lookup;

    var routeById = new Map();
    data.get("routes.txt").rows.forEach(function (r) {
      if (r.route_id) routeById.set(r.route_id, r);
    });

    data.get("trips.txt").rows.forEach(function (r) {
      var sid = r.shape_id;
      if (!sid || lookup.has(sid)) return; // use first match per shape
      var route = routeById.get(r.route_id);
      if (!route) return;
      lookup.set(sid, {
        route_id:         route.route_id         || "",
        route_short_name: route.route_short_name  || "",
        route_long_name:  route.route_long_name   || "",
        route_desc:       route.route_desc        || "",
        route_type:       route.route_type        || "",
        route_color:      route.route_color       || "",
        route_text_color: route.route_text_color  || "",
        agency_id:        route.agency_id         || "",
        trip_headsign:    r.trip_headsign         || ""
      });
    });

    return lookup;
  }

  // ---- Map layers ----

  function firstUserLayer() {
    var map = App.map;
    var candidates = ["points-layer", "lines-layer", "routes-layer", "polygons-fill"];
    for (var i = 0; i < candidates.length; i++) {
      if (map.getLayer(candidates[i])) return candidates[i];
    }
    return undefined;
  }

  function addMapLayers() {
    var map = App.map;
    if (!map) return;

    removeMapLayers();

    var before = firstUserLayer();

    // Build route lookup for shapes (empty Map if trips/routes not present)
    var routeLookup = _gtfsData ? buildRouteLookup(_gtfsData) : new Map();

    // --- shapes.txt → route geometry ---
    if (_gtfsData && _gtfsData.has("shapes.txt")) {
      var shapesFC = buildShapesGeoJSON(_gtfsData.get("shapes.txt").rows, routeLookup);
      _shapesFC = shapesFC;
      map.addSource("gtfs-shapes", { type: "geojson", data: shapesFC });
      map.addLayer({
        id:     "gtfs-shapes-layer",
        type:   "line",
        source: "gtfs-shapes",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": [
            "case",
            ["all",
              ["has", "route_color"],
              ["!=", ["get", "route_color"], ""],
              ["!=", ["downcase", ["get", "route_color"]], "ffffff"]
            ],
            ["concat", "#", ["get", "route_color"]],
            "#718096"
          ],
          "line-width":   2,
          "line-opacity": 0.65,
          "line-dasharray": [4, 2]
        }
      }, before);
      map.setLayoutProperty("gtfs-shapes-layer", "visibility",
        _showRoutes ? "visible" : "none");
    }

    // --- stops.txt → stop circles ---
    if (_gtfsData && _gtfsData.has("stops.txt")) {
      var stopsFC = buildStopsGeoJSON(_gtfsData.get("stops.txt").rows);
      map.addSource("gtfs-stops", { type: "geojson", data: stopsFC });
      map.addLayer({
        id:     "gtfs-stops-layer",
        type:   "circle",
        source: "gtfs-stops",
        paint: {
          "circle-radius":       4,
          "circle-color":        "#ffffff",
          "circle-stroke-color": "#718096",
          "circle-stroke-width": 1.5,
          "circle-opacity":      0.85
        }
      }, before);
      map.setLayoutProperty("gtfs-stops-layer", "visibility",
        _showStops ? "visible" : "none");
    }

    wireHoverEvents();
  }

  function removeMapLayers() {
    var map = App.map;
    if (!map) return;
    removePopups();
    _shapesFC = null;
    // MapLibre does NOT auto-detach layer-bound listeners when a layer is
    // removed; explicitly map.off() everything wireHoverEvents() registered.
    for (var i = 0; i < _layerListeners.length; i++) {
      var rec = _layerListeners[i];
      map.off(rec.event, rec.layerId, rec.handler);
    }
    _layerListeners = [];
    ["gtfs-shapes-layer", "gtfs-stops-layer"].forEach(function (id) {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    ["gtfs-shapes", "gtfs-stops"].forEach(function (id) {
      if (map.getSource(id)) map.removeSource(id);
    });
  }

  function setRouteLayerVisibility(visible) {
    _showRoutes = visible;
    var map = App.map;
    if (map && map.getLayer("gtfs-shapes-layer")) {
      map.setLayoutProperty("gtfs-shapes-layer", "visibility",
        visible ? "visible" : "none");
    }
  }

  function setStopLayerVisibility(visible) {
    _showStops = visible;
    var map = App.map;
    if (map && map.getLayer("gtfs-stops-layer")) {
      map.setLayoutProperty("gtfs-stops-layer", "visibility",
        visible ? "visible" : "none");
    }
  }

  // ---- GTFS → Feature copy helpers ----

  var ROUTE_TYPE_TO_LINE_MODE = {
    0: "Streetcar",
    1: "Light Rail",
    2: "Commuter Rail",
    3: "Bus",
    5: "Streetcar",
    7: "Light Rail",
    11: "Bus"
  };

  function copyShapeToLine(props) {
    var shapeId = props.shape_id;
    if (!shapeId || !_shapesFC) return;

    var fullFeature = null;
    for (var i = 0; i < _shapesFC.features.length; i++) {
      if (_shapesFC.features[i].properties.shape_id === shapeId) {
        fullFeature = _shapesFC.features[i];
        break;
      }
    }
    if (!fullFeature) return;

    var coords = fullFeature.geometry.coordinates;
    var name = props.route_short_name || props.route_long_name || shapeId;
    var routeType = parseInt(props.route_type, 10);
    var lineMode = ROUTE_TYPE_TO_LINE_MODE[routeType] || null;

    var color = null;
    var rc = (props.route_color || "").replace(/^#/, "");
    if (rc && rc.toLowerCase() !== "ffffff" && rc.length === 6) {
      color = "#" + rc;
    }

    var attrs = {};
    if (lineMode) attrs.mode = lineMode;
    var notesParts = [];
    if (props.route_id) notesParts.push("route_id: " + props.route_id);
    if (shapeId) notesParts.push("shape_id: " + shapeId);
    if (notesParts.length) attrs.notes = notesParts.join(", ");

    if (typeof App.addLineFromCoords === "function") {
      App.addLineFromCoords(coords, {
        name: name,
        color: color,
        attributes: attrs
      });
    }
  }

  function copyStopToPoint(props, lngLat) {
    var lon = parseFloat(props.stop_lon) || lngLat.lng;
    var lat = parseFloat(props.stop_lat) || lngLat.lat;
    var name = props.stop_name || props.stop_code || props.stop_id || "Point";
    var attrs = {};
    if (props.stop_id) attrs.stopId = String(props.stop_id);

    if (typeof App.addPointWithOpts === "function") {
      App.addPointWithOpts(lon, lat, {
        name: name,
        attributes: attrs
      });
    }
  }

  // ---- Hover / click event wiring ----
  // Layer-bound listeners are NOT auto-detached when removeLayer() runs, so
  // every handler we register here is recorded in _layerListeners and
  // detached by removeMapLayers() before the layer is torn down. Without
  // that, repeated GTFS load/clear cycles accumulate duplicate handlers
  // (and old _gtfsData / _shapesFC closures stay reachable).

  function wireHoverEvents() {
    var map = App.map;
    if (!map) return;

    function addListener(event, layerId, handler) {
      map.on(event, layerId, handler);
      _layerListeners.push({ event: event, layerId: layerId, handler: handler });
    }

    // Query a small box around the cursor so stacked / near-parallel features
    // are all captured (the single-pixel e.features only catches the topmost),
    // deduped by a stable key.
    function featuresNear(e, layerId, keyFn) {
      var T = 5; // px tolerance
      var p = e.point;
      var box = [[p.x - T, p.y - T], [p.x + T, p.y + T]];
      var raw = map.queryRenderedFeatures(box, { layers: [layerId] });
      var seen = {}, out = [];
      raw.forEach(function (f) {
        var k = keyFn(f.properties);
        if (k == null || seen[k]) return;
        seen[k] = 1;
        out.push(f);
      });
      return out;
    }

    function keyFor(props, isStop) {
      return isStop ? props.stop_id : props.shape_id;
    }

    function shapeName(props) {
      return props.route_short_name || props.route_long_name || props.shape_id || "";
    }

    function stopName(props) {
      return props.stop_name || props.stop_code || props.stop_id || "";
    }

    var layers = [
      { id: "gtfs-shapes-layer", isStop: false },
      { id: "gtfs-stops-layer",  isStop: true  }
    ];

    layers.forEach(function (layer) {
      if (!map.getLayer(layer.id)) return;
      var layerId = layer.id;
      var isStop  = layer.isStop;

      addListener("mouseenter", layerId, function () {
        if (!App.drawMode) map.getCanvas().style.cursor = "pointer";
      });

      addListener("mousemove", layerId, function (e) {
        var feats = featuresNear(e, layerId, function (p) { return keyFor(p, isStop); });
        if (!feats.length) return;
        if (!App.drawMode) map.getCanvas().style.cursor = "pointer";
        ensurePopups();
        _hoverPopup
          .setLngLat(e.lngLat)
          .setHTML(buildHoverHTML(feats, isStop))
          .addTo(map);
      });

      addListener("mouseleave", layerId, function () {
        map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
        if (_hoverPopup) _hoverPopup.remove();
      });

      addListener("click", layerId, function (e) {
        if (!e.features || !e.features.length) return;
        if (_hoverPopup) _hoverPopup.remove();
        ensurePopups();
        _clickPopup
          .setLngLat(e.lngLat)
          .setHTML(buildClickHTML(e.features[0].properties, isStop))
          .addTo(map);
      });

      addListener("contextmenu", layerId, function (e) {
        var feats = featuresNear(e, layerId, function (p) { return keyFor(p, isStop); });
        if (!feats.length) return;
        e.originalEvent.preventDefault();
        if (_hoverPopup) _hoverPopup.remove();

        var lngLat = e.lngLat;
        var multiple = feats.length > 1;
        var flagged = isStop ? {} : flagDuplicateShapes(feats);
        var options = [];

        feats.forEach(function (f, idx) {
          var props = f.properties;
          if (isStop) {
            options.push({
              label: multiple ? "Copy As Point: " + stopName(props) : "Copy As Point",
              action: function () { copyStopToPoint(props, lngLat); }
            });
          } else {
            var label = "Copy As Line";
            if (multiple) {
              var headsign = shapeHeadsign(props);
              label += ": " + shapeName(props) +
                       (headsign ? " → " + headsign : "") +
                       (flagged[idx] ? " [" + props.shape_id + "]" : "");
            }
            options.push({
              label: label,
              action: function () { copyShapeToLine(props); }
            });
          }
        });

        if (typeof App.showContextMenu === "function") {
          App.showContextMenu(
            e.originalEvent.clientX,
            e.originalEvent.clientY,
            options
          );
        }
      });
    });
  }

  // ---- Popup HTML builders ----

  // Shared shape-label helpers (used by hover tooltip + right-click menu).
  function shapeNameOf(props) {
    return props.route_short_name || props.route_long_name || props.shape_id || "";
  }
  function shapeHeadsign(props) {
    return (props.trip_headsign || "").trim();
  }
  // Given the overlapping feature array, return a set (object) of indexes whose
  // name + headsign collides with another entry — those need a shape_id suffix
  // so the listed entries stay distinguishable even without a headsign.
  function flagDuplicateShapes(feats) {
    var counts = {}, keys = [];
    for (var i = 0; i < feats.length; i++) {
      var p = feats[i].properties;
      var k = shapeNameOf(p) + " → " + shapeHeadsign(p);
      keys[i] = k;
      counts[k] = (counts[k] || 0) + 1;
    }
    var flagged = {};
    for (var j = 0; j < feats.length; j++) {
      if (counts[keys[j]] > 1) flagged[j] = true;
    }
    return flagged;
  }

  function buildHoverEntry(props, isStop, showShapeId) {
    var html = "";
    if (isStop) {
      var name = props.stop_name || props.stop_code || props.stop_id || "";
      html += "<b>" + escHtml(name) + "</b>";
      if (props.stop_name && props.stop_id) {
        html += '<br><span style="color:var(--muted)">stop_id: ' +
                escHtml(props.stop_id) + "</span>";
      }
    } else {
      var routeLabel = shapeNameOf(props);
      var headsign   = shapeHeadsign(props);
      var typeLabel  = ROUTE_TYPE_LABELS[parseInt(props.route_type, 10)] || "";
      html += "<b>" + escHtml(routeLabel) + "</b>";
      if (headsign) {
        html += '<br><span style="color:var(--muted)">→ ' + escHtml(headsign) + "</span>";
      }
      if (typeLabel) {
        html += '<br><span style="color:var(--muted)">' + escHtml(typeLabel) + "</span>";
      }
      if (showShapeId && props.shape_id) {
        html += '<br><span style="color:var(--muted)">shape_id: ' +
                escHtml(props.shape_id) + "</span>";
      }
    }
    return html;
  }

  // Accepts an array of features so overlapping routes/stops are all listed.
  function buildHoverHTML(feats, isStop) {
    var list = Array.isArray(feats) ? feats : [{ properties: feats }];
    var flagged = isStop ? {} : flagDuplicateShapes(list);
    var html = '<div class="gtfs-hover">';
    for (var i = 0; i < list.length; i++) {
      if (i > 0) {
        html += '<div style="border-top:1px solid var(--border);margin:4px 0"></div>';
      }
      html += buildHoverEntry(list[i].properties, isStop, !!flagged[i]);
    }
    html += "</div>";
    return html;
  }

  function detailRow(label, val) {
    if (val == null || val === "") return "";
    return '<div class="gtfs-detail-row">' +
           '<span class="gtfs-detail-key">' + escHtml(label) + ':</span> ' +
           '<span class="gtfs-detail-val">' + escHtml(String(val)) + '</span>' +
           '</div>';
  }

  function buildClickHTML(props, isStop) {
    var html = '<div class="gtfs-detail">';

    if (isStop) {
      var title = props.stop_name || props.stop_id || "Stop";
      html += '<div class="gtfs-detail-title">' + escHtml(title) + '</div>';
      html += detailRow("stop_id",   props.stop_id);
      html += detailRow("stop_code", props.stop_code);
      html += detailRow("desc",      props.stop_desc);
      var ltLabel = LOCATION_TYPE_LABELS[String(props.location_type)] || "";
      if (ltLabel) html += detailRow("type", ltLabel);
      var wlLabel = WHEELCHAIR_LABELS[String(props.wheelchair_boarding)] || "";
      if (wlLabel) html += detailRow("wheelchair", wlLabel);
      html += detailRow("parent_station", props.parent_station);
      html += detailRow("zone_id",        props.zone_id);
    } else {
      // Build title with optional color swatch
      var routeName = props.route_short_name || props.route_long_name || props.shape_id || "Route";
      var titleHtml = '<div class="gtfs-detail-title">';
      var color = (props.route_color || "").replace(/^#/, "");
      if (color && color.toLowerCase() !== "ffffff" && color.length === 6) {
        titleHtml += '<span class="gtfs-route-swatch" style="background:#' +
                     escHtml(color) + '"></span>';
      }
      titleHtml += escHtml(routeName) + "</div>";
      html += titleHtml;

      html += detailRow("route_id",    props.route_id);
      html += detailRow("short_name",  props.route_short_name);
      html += detailRow("long_name",   props.route_long_name);
      html += detailRow("desc",        props.route_desc);
      var rtLabel = ROUTE_TYPE_LABELS[parseInt(props.route_type, 10)] || props.route_type || "";
      if (rtLabel) html += detailRow("mode", rtLabel);
      html += detailRow("agency_id",   props.agency_id);
      html += detailRow("shape_id",    props.shape_id);
    }

    html += "</div>";
    return html;
  }

  // ---- GeoJSON builders ----

  function buildShapesGeoJSON(rows, routeLookup) {
    // Group points by shape_id, sort by sequence, build LineStrings
    var groups = {};
    for (var i = 0; i < rows.length; i++) {
      var r   = rows[i];
      var id  = r.shape_id;
      var lat = parseFloat(r.shape_pt_lat);
      var lon = parseFloat(r.shape_pt_lon);
      var seq = parseInt(r.shape_pt_sequence, 10);
      if (!id || isNaN(lat) || isNaN(lon) || isNaN(seq)) continue;
      if (!groups[id]) groups[id] = [];
      groups[id].push([seq, lon, lat]);
    }

    var features = [];
    var ids = Object.keys(groups);
    for (var j = 0; j < ids.length; j++) {
      var sid  = ids[j];
      var pts  = groups[sid];
      pts.sort(function (a, b) { return a[0] - b[0]; });
      var coords = pts.map(function (p) { return [p[1], p[2]]; });
      if (coords.length < 2) continue;

      // Merge route info from lookup (empty object if not found)
      var routeInfo = (routeLookup && routeLookup.get(sid)) || {};
      var props = Object.assign({ shape_id: sid }, routeInfo);

      features.push({
        type: "Feature",
        properties: props,
        geometry: { type: "LineString", coordinates: coords }
      });
    }
    return { type: "FeatureCollection", features: features };
  }

  function buildStopsGeoJSON(rows) {
    var features = [];
    for (var i = 0; i < rows.length; i++) {
      var r   = rows[i];
      var lat = parseFloat(r.stop_lat);
      var lon = parseFloat(r.stop_lon);
      if (isNaN(lat) || isNaN(lon)) continue;
      // Only include actual stops (location_type 0 or absent)
      var lt = r.location_type;
      if (lt && lt !== "0" && lt !== "") continue;
      features.push({
        type: "Feature",
        properties: r,
        geometry: { type: "Point", coordinates: [lon, lat] }
      });
    }
    return { type: "FeatureCollection", features: features };
  }

  // ---- Dropdown UI ----

  function updateDropdownUI() {
    var loadBtn  = document.getElementById("gtfs-load-btn");
    var clearBtn = document.getElementById("gtfs-clear-btn");
    if (!loadBtn || !clearBtn) return;
    var hasData = _gtfsData && _gtfsData.size > 0;
    clearBtn.style.display = hasData ? "" : "none";
  }

  // ---- Popup rendering (analysis popup, not map popups) ----

  function renderFileList() {
    var list = document.getElementById("gtfsFileList");
    if (!list) return;

    if (!_gtfsData || _gtfsData.size === 0) {
      // Standardized empty/onboarding state (shared .rf-info-box look).
      list.innerHTML =
        '<div class="gtfs-empty-state rf-info-box">' +
        '<p><strong>Load a GTFS feed to begin.</strong></p>' +
        '<p class="rf-state-action">Use Add\u00a0Data\u00a0(+) \u2192 GTFS to load a feed (.zip).</p>' +
        '</div>';
      var mc = document.getElementById("gtfsMapControls");
      if (mc) mc.style.display = "none";
      return;
    }

    // Build ordered file list
    var known   = FILE_ORDER.filter(function (f) { return _gtfsData.has(f); });
    var unknown = [];
    _gtfsData.forEach(function (_, f) {
      if (FILE_ORDER.indexOf(f) === -1) unknown.push(f);
    });
    var allFiles = known.concat(unknown.sort());

    list.innerHTML = "";
    for (var i = 0; i < allFiles.length; i++) {
      var fname    = allFiles[i];
      var fileData = _gtfsData.get(fname);
      var isReq    = !!REQUIRED[fname];
      var active   = fname === _selectedFile ? " gtfs-file-active" : "";

      var btn = document.createElement("button");
      btn.className = "gtfs-file-item" + active;
      btn.innerHTML =
        '<span class="gtfs-file-name">' + App.escapeHTML(fname) + '</span>' +
        '<span class="gtfs-file-badge' + (isReq ? ' req' : '') + '">' +
          (isReq ? "REQ" : "OPT") +
        '</span>';
      btn.title = fileData.rows.length + " rows";

      (function (f) {
        btn.addEventListener("click", function () {
          _selectedFile = f;
          renderFileList();
          renderTable(f);
        });
      })(fname);

      list.appendChild(btn);
    }

    // Show map controls
    var mc = document.getElementById("gtfsMapControls");
    if (mc) mc.style.display = "";
  }

  function showSelectPrompt() {
    var prompt  = document.getElementById("gtfsSelectPrompt");
    var wrapper = document.getElementById("gtfsTableWrapper");
    var title   = document.getElementById("gtfsTableTitle");
    var meta    = document.getElementById("gtfsTableMeta");
    if (prompt)  prompt.style.display  = "";
    if (wrapper) wrapper.style.display = "none";
    if (title)   title.style.display   = "none";
    if (meta)    meta.style.display    = "none";
  }

  var TABLE_ROW_LIMIT = 500;

  function renderTable(fname) {
    var fileData = _gtfsData && _gtfsData.get(fname);
    if (!fileData) return;

    var prompt  = document.getElementById("gtfsSelectPrompt");
    var wrapper = document.getElementById("gtfsTableWrapper");
    var title   = document.getElementById("gtfsTableTitle");
    var thead   = document.getElementById("gtfsTableHead");
    var tbody   = document.getElementById("gtfsTableBody");
    var meta    = document.getElementById("gtfsTableMeta");
    if (!wrapper || !thead || !tbody) return;

    if (prompt)  prompt.style.display  = "none";
    if (title) { title.textContent = fname; title.style.display = ""; }

    var headers = fileData.headers;
    var rows    = fileData.rows;
    var shown   = Math.min(rows.length, TABLE_ROW_LIMIT);

    var thHtml = "<tr>";
    for (var h = 0; h < headers.length; h++) {
      thHtml += "<th>" + escHtml(headers[h]) + "</th>";
    }
    thHtml += "</tr>";
    thead.innerHTML = thHtml;

    var tbHtml = "";
    for (var r = 0; r < shown; r++) {
      tbHtml += "<tr>";
      for (var c = 0; c < headers.length; c++) {
        var val = rows[r][headers[c]];
        tbHtml += "<td>" + escHtml(val == null ? "" : String(val)) + "</td>";
      }
      tbHtml += "</tr>";
    }
    if (rows.length > TABLE_ROW_LIMIT) {
      tbHtml +=
        '<tr class="gtfs-table-truncated"><td colspan="' + headers.length + '">' +
        "Showing " + TABLE_ROW_LIMIT + " of " + rows.length.toLocaleString() + " rows" +
        "</td></tr>";
    }
    tbody.innerHTML = tbHtml;
    wrapper.style.display = "";

    if (meta) {
      meta.textContent =
        rows.length.toLocaleString() + " row" + (rows.length !== 1 ? "s" : "") +
        ", " + headers.length + " column" + (headers.length !== 1 ? "s" : "");
      meta.style.display = "";
    }
  }

  // Thin alias on App.escapeHTML so the 11 existing callsites in this module
  // keep working while escaping is centralized in utils.js.
  function escHtml(s) { return App.escapeHTML(s); }

  // ---- Module lifecycle ----

  function init(core) {
    _initialized = true;

    var showRoutes = document.getElementById("gtfsShowRoutes");
    if (showRoutes) {
      showRoutes.checked = _showRoutes;
      showRoutes.addEventListener("change", function () {
        setRouteLayerVisibility(this.checked);
      });
    }

    var showStops = document.getElementById("gtfsShowStops");
    if (showStops) {
      showStops.checked = _showStops;
      showStops.addEventListener("change", function () {
        setStopLayerVisibility(this.checked);
      });
    }

    var clearBtn = document.getElementById("gtfsClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        clearGTFS();
      });
    }
  }

  function onOpen(core) {
    var showRoutes = document.getElementById("gtfsShowRoutes");
    if (showRoutes) showRoutes.checked = _showRoutes;
    var showStops = document.getElementById("gtfsShowStops");
    if (showStops) showStops.checked = _showStops;

    renderFileList();

    if (_selectedFile && _gtfsData && _gtfsData.has(_selectedFile)) {
      renderTable(_selectedFile);
    } else {
      showSelectPrompt();
    }
  }

  // ---- Wire Add Data dropdown buttons ----

  var _fileInput = document.getElementById("gtfs-file-input");
  var _dropdown  = document.getElementById("add-data-dropdown");
  var _loadBtn   = document.getElementById("gtfs-load-btn");
  var _clearBtn  = document.getElementById("gtfs-clear-btn");

  if (_loadBtn && _fileInput) {
    _loadBtn.addEventListener("click", function () {
      if (_dropdown) _dropdown.style.display = "none";
      _fileInput.value = "";
      _fileInput.click();
    });
  }

  if (_clearBtn) {
    _clearBtn.addEventListener("click", function () {
      if (_dropdown) _dropdown.style.display = "none";
      clearGTFS();
    });
  }

  if (_fileInput) {
    _fileInput.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      this.value = "";
      loadGTFSFile(file);
    });
  }

  // ---- Expose on App namespace ----
  App.gtfsData     = _gtfsData;   // null until loaded (static snapshot — see note below)
  App.getGTFSData      = function () { return _gtfsData; };
  App.getGTFSShapesFC  = function () { return _shapesFC; };
  App.loadGTFSFile = loadGTFSFile;
  App.clearGTFS    = clearGTFS;
  App.restoreGTFSFromData = restoreGTFSFromData;
  App.serializeGTFSData   = serializeGTFSData;
  App.setGtfsLayersVisible = function (visible) {
    if (typeof setRouteLayerVisibility === "function") setRouteLayerVisibility(visible);
    if (typeof setStopLayerVisibility  === "function") setStopLayerVisibility(visible);
  };

  // ---- Register analysis module ----
  App.registerModule({
    id:         "gtfs",
    name:       "GTFS Feed Attributes",
    enabled:    true,
    popupWidth: 1000,
    popupHTML:  "projects/gtfs-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function () {},
    update:  async function (core) {},
    clear:   function () { clearGTFS(); }
  });

})();
