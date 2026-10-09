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

  // ---- Stop selection state (docs/gtfs-stop-selection-plan.md Phase 2) ----
  // The selection is a list of stop_id strings kept SEPARATELY from the loaded
  // feed (D7): it survives loading another ZIP and a page reload. Everything
  // else (highlight, counts, export) is derived from it plus the loaded feed.
  var _selectedStops  = [];                 // ordered stop_id strings
  var _selectedLookup = Object.create(null); // stop_id -> true
  var _stopsFC        = null;               // drawn-stops FeatureCollection (location_type 0/blank)
  var _feedFileName   = "";                 // ZIP name of the feed the list was last used with
  var _feedStopIdSet  = null;               // lazy Set of every stop_id in stops.txt
  var SEL_LAYER       = "gtfs-stops-selected";

  // ---- Route browser state (Phase 1 of docs/gtfs-route-browser-plan.md) ----
  var _routeIndex    = null;      // result of buildRouteIndex, or null when no shapes
  var _hiddenRoutes  = {};        // routeKey -> true
  var _hiddenShapes  = {};        // shape_id -> true
  var _pendingHidden = null;      // { routes: [], shapes: [] } from a restored session
  var UNASSIGNED_KEY = "__unassigned__";
  var HL_CASING = "gtfs-shapes-hl-casing";
  var HL_LAYER  = "gtfs-shapes-hl";

  // ---- Pure browse helpers (no DOM / map / turf; golden-tested) ----

  // Natural, case-insensitive comparison: "2" < "10", "A2" < "A10".
  function naturalCompare(a, b) {
    a = a == null ? "" : String(a).toLowerCase();
    b = b == null ? "" : String(b).toLowerCase();
    var re = /(\d+)|(\D+)/g;
    var pa = a.match(re) || [], pb = b.match(re) || [];
    var n = Math.min(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = pa[i], y = pb[i];
      var xd = /^\d/.test(x), yd = /^\d/.test(y);
      if (xd && yd) {
        var d = parseInt(x, 10) - parseInt(y, 10);
        if (d !== 0) return d < 0 ? -1 : 1;
        if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    if (pa.length !== pb.length) return pa.length < pb.length ? -1 : 1;
    return 0;
  }

  // Equirectangular polyline length in miles.
  function lineLengthMi(coords) {
    var R = 3958.7613, rad = Math.PI / 180, sum = 0;
    for (var i = 1; i < coords.length; i++) {
      var a = coords[i - 1], b = coords[i];
      var dLat = (b[1] - a[1]) * rad;
      var dLon = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
      sum += Math.sqrt(dLat * dLat + dLon * dLon) * R;
    }
    return sum;
  }

  function normColor(c) {
    c = String(c == null ? "" : c).replace(/^#/, "");
    return (c.length === 6 && /^[0-9a-fA-F]{6}$/.test(c) && c.toLowerCase() !== "ffffff")
      ? "#" + c.toLowerCase() : "";
  }

  function routeSortName(r) { return r.short || r.long || r.route_id || ""; }

  // Build the browsable route index.
  // Returns [{ routeKey, route_id, short, long, type, color ("#rrggbb" or ""),
  //   agency_id, shapes: [{ shape_id, lengthMi, tripCount, headsigns: [] }],
  //   tripCount }], routes naturally sorted (short, else long, else route_id),
  // shapes sorted tripCount desc then length desc. Shapes with no known route
  // (no trips / no routes row) go under a synthetic "Unassigned shapes" route
  // (routeKey "__unassigned__") that always sorts last. Routes with no drawn
  // shape are omitted. Trips referencing a shape not in shapesFC are ignored.
  function buildRouteIndex(shapesFC, tripsRows, routesRows) {
    var feats = (shapesFC && shapesFC.features) || [];
    var shapeLen = {}, shapeOrder = [];
    feats.forEach(function (f) {
      var sid = f.properties && f.properties.shape_id;
      if (sid == null || sid in shapeLen) return;
      shapeLen[sid] = lineLengthMi(f.geometry.coordinates);
      shapeOrder.push(sid);
    });
    var routeById = {};
    (routesRows || []).forEach(function (r) {
      if (r && r.route_id) routeById[r.route_id] = r;
    });
    // routeKey -> shape_id -> { tripCount, headsigns{} }
    var acc = {}, assigned = {};
    (tripsRows || []).forEach(function (t) {
      var sid = t && t.shape_id;
      if (!sid || !(sid in shapeLen)) return;
      var rid = t.route_id;
      if (!rid || !routeById[rid]) return;
      var byShape = acc[rid] || (acc[rid] = {});
      var rec = byShape[sid] || (byShape[sid] = { tripCount: 0, headsigns: {} });
      rec.tripCount++;
      var h = (t.trip_headsign || "").trim();
      if (h) rec.headsigns[h] = true;
      assigned[sid] = true;
    });
    function shapeRows(byShape) {
      var rows = Object.keys(byShape).map(function (sid) {
        return { shape_id: sid, lengthMi: shapeLen[sid], tripCount: byShape[sid].tripCount,
                 headsigns: Object.keys(byShape[sid].headsigns).sort(naturalCompare) };
      });
      rows.sort(function (a, b) {
        return (b.tripCount - a.tripCount) || (b.lengthMi - a.lengthMi) ||
               naturalCompare(a.shape_id, b.shape_id);
      });
      return rows;
    }
    function total(rows) { return rows.reduce(function (s, r) { return s + r.tripCount; }, 0); }

    var out = Object.keys(acc).map(function (rid) {
      var r = routeById[rid], shapes = shapeRows(acc[rid]);
      return { routeKey: rid, route_id: rid, short: r.route_short_name || "", long: r.route_long_name || "",
               type: r.route_type || "", color: normColor(r.route_color), agency_id: r.agency_id || "",
               shapes: shapes, tripCount: total(shapes) };
    });
    out.sort(function (a, b) {
      return naturalCompare(routeSortName(a), routeSortName(b)) || naturalCompare(a.route_id, b.route_id);
    });
    var unassigned = shapeOrder.filter(function (sid) { return !assigned[sid]; });
    if (unassigned.length) {
      var by = {};
      unassigned.forEach(function (sid) { by[sid] = { tripCount: 0, headsigns: {} }; });
      out.push({ routeKey: UNASSIGNED_KEY, route_id: "", short: "", long: "Unassigned shapes", type: "",
                 color: "", agency_id: "", shapes: shapeRows(by), tripCount: 0 });
    }
    return out;
  }

  // Case-insensitive substring match on short/long name, route_id or any shape_id.
  // Blank query returns the whole index.
  function filterRoutes(index, query) {
    var q = String(query == null ? "" : query).trim().toLowerCase();
    if (!q) return (index || []).slice();
    return (index || []).filter(function (r) {
      if ((r.short || "").toLowerCase().indexOf(q) !== -1) return true;
      if ((r.long || "").toLowerCase().indexOf(q) !== -1) return true;
      if ((r.route_id || "").toLowerCase().indexOf(q) !== -1) return true;
      return (r.shapes || []).some(function (s) {
        return String(s.shape_id).toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  // Most trips; tie -> longest; tie -> natural shape_id. null when no shapes.
  function representativeShape(route) {
    var best = null;
    ((route && route.shapes) || []).forEach(function (s) {
      if (!best || s.tripCount > best.tripCount ||
          (s.tripCount === best.tripCount && (s.lengthMi > best.lengthMi ||
            (s.lengthMi === best.lengthMi && naturalCompare(s.shape_id, best.shape_id) < 0)))) best = s;
    });
    return best;
  }

  // MapLibre filter showing every shape except hidden routes/shapes; null when
  // nothing is hidden. Inputs are arrays or plain {key:true} objects/Sets of
  // route keys / shape_ids. The unassigned route ("__unassigned__") matches
  // shapes with no route_id property.
  function toList(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x.slice();
    if (typeof x.forEach === "function" && typeof x.size === "number") {
      var o = []; x.forEach(function (v) { o.push(v); }); return o;
    }
    return Object.keys(x).filter(function (k) { return x[k]; });
  }
  function buildVisibilityFilter(hiddenRoutes, hiddenShapes) {
    var routes = toList(hiddenRoutes).map(function (k) { return k === UNASSIGNED_KEY ? "" : String(k); }).sort();
    var shapes = toList(hiddenShapes).map(String).sort();
    var clauses = [];
    if (routes.length) clauses.push(["!", ["in", ["coalesce", ["get", "route_id"], ""], ["literal", routes]]]);
    if (shapes.length) clauses.push(["!", ["in", ["coalesce", ["get", "shape_id"], ""], ["literal", shapes]]]);
    if (!clauses.length) return null;
    return clauses.length === 1 ? clauses[0] : ["all"].concat(clauses);
  }

  // shape_id -> "Outbound" | "Inbound" | "" for one route's trips: GTFS
  // direction_id 0 -> Outbound, 1 -> Inbound, only when EVERY trip of that
  // route on that shape carries the same valid value; otherwise "" (blank —
  // the user sets it). Plan Phase 3 "Copy all as grouped Service".
  function shapeDirections(tripsRows, routeId) {
    var seen = {};   // sid -> "0" | "1" | "?" (mixed / missing)
    (tripsRows || []).forEach(function (t) {
      if (!t || !t.shape_id || String(t.route_id) !== String(routeId)) return;
      var d = String(t.direction_id == null ? "" : t.direction_id).trim();
      if (d !== "0" && d !== "1") d = "?";
      var sid = t.shape_id;
      if (!(sid in seen)) seen[sid] = d;
      else if (seen[sid] !== d) seen[sid] = "?";
    });
    var out = {};
    Object.keys(seen).forEach(function (sid) {
      out[sid] = seen[sid] === "0" ? "Outbound" : seen[sid] === "1" ? "Inbound" : "";
    });
    return out;
  }

  // base, or "base (2)", "base (3)" … — the first not in existingIds (array).
  function uniqueServiceId(base, existingIds) {
    var used = {};
    (existingIds || []).forEach(function (k) { if (k != null) used[String(k).trim()] = true; });
    base = String(base || "Service").trim() || "Service";
    if (!used[base]) return base;
    for (var n = 2; ; n++) {
      if (!used[base + " (" + n + ")"]) return base + " (" + n + ")";
    }
  }

  // ---- Stop-list helpers (docs/gtfs-stop-selection-plan.md Phase 1) ----
  // Pure: no DOM/map/turf. Import/export of a stop_id selection.

  // Small RFC 4180 reader: rows of fields. Handles quoted fields, "" escapes,
  // commas/newlines inside quotes, CRLF/LF/CR. A trailing newline at EOF does
  // not create an extra empty record. (App.parseCSV needs Papa + a header row,
  // so it is not used here.)
  function readCSVRecords(text) {
    var recs = [], rec = [], f = "", q = false, i = 0, n = text.length, c;
    while (i < n) {
      c = text.charAt(i);
      if (q) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { f += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        f += c; i++; continue;
      }
      if (c === '"') { q = true; i++; }
      else if (c === ",") { rec.push(f); f = ""; i++; }
      else if (c === "\r" || c === "\n") {
        if (c === "\r" && text.charAt(i + 1) === "\n") i++;
        rec.push(f); recs.push(rec); rec = []; f = ""; i++;
      } else { f += c; i++; }
    }
    if (f !== "" || rec.length) { rec.push(f); recs.push(rec); }
    return recs;
  }

  function csvField(v) {
    var s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function parseStopIdList(text) {
    var out = { ids: [], headerFound: false, blanks: 0, duplicates: 0 };
    text = String(text === null || text === undefined ? "" : text).replace(/^\uFEFF/, "");
    var recs = readCSVRecords(text), col = 0, start = 0, i, seen = {};
    // First non-empty record decides header vs headerless.
    var first = -1;
    for (i = 0; i < recs.length; i++) {
      if (recs[i].join("").trim() !== "") { first = i; break; }
    }
    if (first >= 0) {
      for (var j = 0; j < recs[first].length; j++) {
        if (recs[first][j].trim().toLowerCase() === "stop_id") {
          out.headerFound = true; col = j; start = first + 1; break;
        }
      }
    }
    for (i = start; i < recs.length; i++) {
      var id = (recs[i][col] || "").trim();
      if (!id) { out.blanks++; continue; }
      if (seen.hasOwnProperty(id)) { out.duplicates++; continue; }
      seen[id] = true;
      out.ids.push(id);
    }
    return out;
  }

  function reconcile(ids, feedStopIds) {
    var lookup = {}, i, list = feedStopIds || [];
    if (typeof Set !== "undefined" && list instanceof Set) list.forEach(function (v) { lookup[v] = true; });
    else for (i = 0; i < list.length; i++) lookup[list[i]] = true;
    var res = { present: [], missing: [] };
    ids = ids || [];
    for (i = 0; i < ids.length; i++) {
      (lookup.hasOwnProperty(ids[i]) ? res.present : res.missing).push(ids[i]);
    }
    return res;
  }

  var STOP_LIST_COLS = ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station"];

  function stopListCSV(ids, stopsRows, feedFile) {
    var want = {}, i, seenRow = {}, k;
    ids = ids || [];
    for (i = 0; i < ids.length; i++) want[ids[i]] = true;
    var lines = [STOP_LIST_COLS.concat(["in_feed", "feed_file"]).join(",")];
    var ff = feedFile || "";
    var found = {};
    stopsRows = stopsRows || [];
    for (i = 0; i < stopsRows.length; i++) {
      var r = stopsRows[i], sid = r && r.stop_id !== undefined && r.stop_id !== null ? String(r.stop_id).trim() : "";
      if (!sid || !want.hasOwnProperty(sid) || seenRow.hasOwnProperty(sid)) continue;
      seenRow[sid] = true; found[sid] = true;
      var cells = [];
      for (k = 0; k < STOP_LIST_COLS.length; k++) cells.push(csvField(r[STOP_LIST_COLS[k]]));
      cells.push("1", csvField(ff));
      lines.push(cells.join(","));
    }
    var emitted = {};
    for (i = 0; i < ids.length; i++) {
      if (found.hasOwnProperty(ids[i]) || emitted.hasOwnProperty(ids[i])) continue;
      emitted[ids[i]] = true;
      var m = [csvField(ids[i])];
      for (k = 1; k < STOP_LIST_COLS.length; k++) m.push("");
      m.push("0", csvField(ff));
      lines.push(m.join(","));
    }
    return lines.join("\n");
  }

  App.gtfsStopList = {
    parseStopIdList: parseStopIdList,
    reconcile: reconcile,
    stopListCSV: stopListCSV
  };

  App.gtfsBrowse = {
    shapeDirections: shapeDirections,
    uniqueServiceId: uniqueServiceId,
    naturalCompare: naturalCompare,
    buildRouteIndex: buildRouteIndex,
    filterRoutes: filterRoutes,
    representativeShape: representativeShape,
    buildVisibilityFilter: buildVisibilityFilter,
    UNASSIGNED_KEY: UNASSIGNED_KEY
  };

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

    _pendingHidden = null; // a fresh upload never inherits a session's hidden sets
    _feedFileName = file.name || "";
    applyGtfsData(data);
    changed(); // feed name changed + re-apply highlight/counts; the stop list itself is kept (D8)
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
    applyPendingHidden();
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
    _routeIndex = null;
    _hiddenRoutes = {};
    _hiddenShapes = {};
    _pendingHidden = null;
    _feedFileName = "";
    _selectedStops = [];
    _selectedLookup = Object.create(null);
    removeMapLayers(); // also removes popups
    updateDropdownUI();
    changed();
    if (isPopupVisible()) {
      renderFileList();
      showSelectPrompt();
      var mc = document.getElementById("gtfsMapControls");
      if (mc) mc.style.display = "none";
    }
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
    App.setStatus("GTFS feed cleared.");
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

  // Colors resolve through the layer color cascade
  // (docs/layer-color-customization-plan.md). Only the fallback color
  // changes — a feed that ships its own route_color keeps using it
  // regardless of the palette, and circle-color stays the fixed white fill
  // of a hollow marker (not a data encoding).
  function gtfsShapesColorExpr() {
    var colors = App.resolveLayerColors && App.resolveLayerColors("gtfs-shapes");
    var fallback = (colors && colors[0]) || "#718096";
    return [
      "case",
      ["all",
        ["has", "route_color"],
        ["!=", ["get", "route_color"], ""],
        ["!=", ["downcase", ["get", "route_color"]], "ffffff"]
      ],
      ["concat", "#", ["get", "route_color"]],
      fallback
    ];
  }
  function gtfsStopsStrokeColor() {
    var colors = App.resolveLayerColors && App.resolveLayerColors("gtfs-stops");
    return (colors && colors[0]) || "#718096";
  }

  // Re-applies paint properties for whichever GTFS layers are currently on
  // the map, without touching _gtfsData or rebuilding features, so a
  // palette change is instant. No-op when a feed hasn't been loaded.
  function repaintGtfsLayers() {
    var map = App.map;
    if (!map) return;
    if (map.getLayer("gtfs-shapes-layer")) {
      map.setPaintProperty("gtfs-shapes-layer", "line-color", gtfsShapesColorExpr());
    }
    if (map.getLayer("gtfs-stops-layer")) {
      map.setPaintProperty("gtfs-stops-layer", "circle-stroke-color", gtfsStopsStrokeColor());
    }
  }
  if (typeof App.registerLayerRepainter === "function") {
    App.registerLayerRepainter("gtfs-shapes", repaintGtfsLayers);
    App.registerLayerRepainter("gtfs-stops", repaintGtfsLayers);
  }

  function addMapLayers() {
    var map = App.map;
    if (!map) return;

    removeMapLayers();
    _routeIndex = null;
    _hiddenRoutes = {};
    _hiddenShapes = {};
    _feedStopIdSet = null;

    var before = firstUserLayer();

    // Build route lookup for shapes (empty Map if trips/routes not present)
    var routeLookup = _gtfsData ? buildRouteLookup(_gtfsData) : new Map();

    // --- shapes.txt → route geometry ---
    if (_gtfsData && _gtfsData.has("shapes.txt")) {
      var shapesFC = buildShapesGeoJSON(_gtfsData.get("shapes.txt").rows, routeLookup);
      _shapesFC = shapesFC;
      _routeIndex = buildRouteIndex(shapesFC,
        _gtfsData.has("trips.txt") ? _gtfsData.get("trips.txt").rows : [],
        _gtfsData.has("routes.txt") ? _gtfsData.get("routes.txt").rows : []);
      map.addSource("gtfs-shapes", { type: "geojson", data: shapesFC });
      map.addLayer({
        id:     "gtfs-shapes-layer",
        type:   "line",
        source: "gtfs-shapes",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": gtfsShapesColorExpr(),
          "line-width":   2,
          "line-opacity": 0.65,
          "line-dasharray": [4, 2]
        }
      }, before);
      // Highlight overlay (white casing + route-colored line), above the base
      // shapes, below drawn features. Matches nothing until gtfsHighlight().
      var none = ["==", ["get", "shape_id"], "\u0000none"];
      map.addLayer({
        id: HL_CASING, type: "line", source: "gtfs-shapes", filter: none,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.85 }
      }, before);
      map.addLayer({
        id: HL_LAYER, type: "line", source: "gtfs-shapes", filter: none,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": map.getPaintProperty("gtfs-shapes-layer", "line-color"),
                 "line-width": 6, "line-opacity": 0.9 }
      }, before);
      [HL_CASING, HL_LAYER].forEach(function (id) {
        map.setLayoutProperty(id, "visibility", _showRoutes ? "visible" : "none");
      });
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
          "circle-stroke-color": gtfsStopsStrokeColor(),
          "circle-stroke-width": 1.5,
          "circle-opacity":      0.85
        }
      }, before);
      map.setLayoutProperty("gtfs-stops-layer", "visibility",
        _showStops ? "visible" : "none");
      _stopsFC = stopsFC;
      // Selected-stop highlight: same source, directly above the stops layer
      // (added with the same `before`, so it stacks just over it), filled blue
      // with a white outline, slightly larger than the stop circle (D15).
      map.addLayer({
        id:     SEL_LAYER,
        type:   "circle",
        source: "gtfs-stops",
        filter: selectedStopsFilter(),
        paint: {
          "circle-radius":       6,
          "circle-color":        "#2b6cb0",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-opacity":      0.85
        }
      }, before);
      syncHighlightStyle();
    }

    wireHoverEvents();
  }

  function removeMapLayers() {
    var map = App.map;
    if (!map) return;
    removePopups();
    _shapesFC = null;
    _stopsFC = null;
    // MapLibre does NOT auto-detach layer-bound listeners when a layer is
    // removed; explicitly map.off() everything wireHoverEvents() registered.
    for (var i = 0; i < _layerListeners.length; i++) {
      var rec = _layerListeners[i];
      map.off(rec.event, rec.layerId, rec.handler);
    }
    _layerListeners = [];
    [HL_LAYER, HL_CASING, "gtfs-shapes-layer", SEL_LAYER, "gtfs-stops-layer"].forEach(function (id) {
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
      [HL_CASING, HL_LAYER, "gtfs-shapes-layer"].forEach(function (id) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      });
    }
  }

  function setStopLayerVisibility(visible) {
    _showStops = visible;
    var map = App.map;
    if (map && map.getLayer("gtfs-stops-layer")) {
      map.setLayoutProperty("gtfs-stops-layer", "visibility",
        visible ? "visible" : "none");
    }
    syncHighlightStyle();
    refreshSelectionBar();
  }

  // ---- Stop selection: highlight, mutations, API ----

  function selectedStopsFilter() {
    // Empty list -> a filter that never matches (same trick as the route highlight).
    if (!_selectedStops.length) return ["==", ["get", "stop_id"], "\u0000none"];
    return ["in", ["get", "stop_id"], ["literal", _selectedStops.slice()]];
  }

  // Mirror the stops layer's current visibility and circle-opacity (the Layers
  // panel sets these directly on the map layer) onto the highlight layer.
  function syncHighlightStyle() {
    var map = App.map;
    if (!map || !map.getLayer(SEL_LAYER) || !map.getLayer("gtfs-stops-layer")) return;
    map.setLayoutProperty(SEL_LAYER, "visibility",
      map.getLayoutProperty("gtfs-stops-layer", "visibility") === "none" ? "none" : "visible");
    var op = map.getPaintProperty("gtfs-stops-layer", "circle-opacity");
    if (typeof op === "number") map.setPaintProperty(SEL_LAYER, "circle-opacity", op);
  }

  function refreshSelectionBar() {
    if (App.boxSelect && typeof App.boxSelect.refreshBar === "function") App.boxSelect.refreshBar();
  }

  // The ONE place every selection mutation ends up.
  function changed() {
    var map = App.map;
    if (map && map.getLayer(SEL_LAYER)) {
      map.setFilter(SEL_LAYER, selectedStopsFilter());
      syncHighlightStyle();
    }
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
    refreshSelectionBar();
  }

  function cleanIds(ids) {
    var out = [], seen = Object.create(null);
    (ids || []).forEach(function (v) {
      if (v === null || v === undefined) return;
      var s = String(v).trim();
      if (!s || seen[s]) return;
      seen[s] = true; out.push(s);
    });
    return out;
  }

  function stopsRows() {
    return (_gtfsData && _gtfsData.has("stops.txt")) ? _gtfsData.get("stops.txt").rows : [];
  }

  // Every stop_id in stops.txt (incl. stations), so "in feed" agrees with the
  // exported CSV's in_feed column.
  function feedStopIds() {
    if (_feedStopIdSet) return _feedStopIdSet;
    var s = new Set();
    stopsRows().forEach(function (r) {
      var id = r && r.stop_id != null ? String(r.stop_id).trim() : "";
      if (id) s.add(id);
    });
    _feedStopIdSet = s;
    return s;
  }

  function setSelection(ids) {
    _selectedStops = cleanIds(ids);
    _selectedLookup = Object.create(null);
    _selectedStops.forEach(function (id) { _selectedLookup[id] = true; });
    changed();
  }

  // Same Blob + anchor approach as cache.js's private _triggerDownload.
  function downloadText(text, filename, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function dateStamp() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  App.gtfsStops = {
    ids: function () { return _selectedStops.slice(); },
    count: function () {
      var feed = feedStopIds(), n = 0;
      if (_gtfsData) _selectedStops.forEach(function (id) { if (feed.has(id)) n++; });
      return { total: _selectedStops.length, inFeed: n };
    },
    has: function (id) { return !!_selectedLookup[String(id)]; },
    set: function (ids) { setSelection(ids); },
    add: function (ids) { setSelection(_selectedStops.concat(ids || [])); },
    remove: function (ids) {
      var drop = Object.create(null);
      (ids || []).forEach(function (v) { drop[String(v).trim()] = true; });
      setSelection(_selectedStops.filter(function (id) { return !drop[id]; }));
    },
    clear: function () { setSelection([]); },
    feedFileName: function () { return _feedFileName; },
    isAvailable: function () {
      var map = App.map;
      if (!_gtfsData || !_stopsFC || !map || !map.getLayer("gtfs-stops-layer")) {
        return { ok: false, reason: "Load a GTFS feed first" };
      }
      if (map.getLayoutProperty("gtfs-stops-layer", "visibility") === "none") {
        return { ok: false, reason: "The GTFS stops layer is hidden" };
      }
      return { ok: true, reason: "" };
    },
    // Drawn stops only (what a box select can hit).
    candidates: function () {
      if (!_stopsFC) return [];
      return _stopsFC.features.map(function (f) {
        return { key: String(f.properties.stop_id), coord: f.geometry.coordinates };
      });
    },
    zoomTo: function () {
      var map = App.map;
      if (!map || !_stopsFC) return;
      var w = 180, s = 90, e = -180, n = -90, any = false;
      _stopsFC.features.forEach(function (f) {
        if (!_selectedLookup[String(f.properties.stop_id)]) return;
        var c = f.geometry.coordinates; any = true;
        if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
        if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
      });
      if (any) map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 17 });
      else App.setStatus("No selected stops are in this feed.");
    },
    exportCSV: function () {
      if (!_selectedStops.length) { App.setStatus("No GTFS stops selected"); return; }
      var csv = App.gtfsStopList.stopListCSV(_selectedStops, stopsRows(), _feedFileName);
      var base = (_feedFileName || "feed").replace(/\.zip$/i, "").replace(/[^\w.\-]+/g, "_");
      downloadText(csv, "gtfs-stops-selected-" + base + "-" + dateStamp() + ".csv", "text/csv");
      var c = App.gtfsStops.count();
      App.setStatus("Exported " + c.total + " selected GTFS stops" +
        (_gtfsData && c.total > c.inFeed ? " (" + (c.total - c.inFeed) + " not in this feed)" : ""));
    },
    importFromFile: function (file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var p = App.gtfsStopList.parseStopIdList(String(reader.result || ""));
        setSelection(p.ids);
        var parts = ["Selected " + p.ids.length + (p.ids.length === 1 ? " stop" : " stops")];
        if (_gtfsData) {
          var missing = App.gtfsStops.count();
          missing = missing.total - missing.inFeed;
          if (missing) parts.push(missing + " not in this feed");
        }
        if (p.duplicates) parts.push(p.duplicates + (p.duplicates === 1 ? " duplicate" : " duplicates") + " ignored");
        App.setStatus(parts.join(" · "));
      };
      reader.onerror = function () { App.setStatus("Could not read the stop list file."); };
      reader.readAsText(file);
    }
  };

  // Box-select target (docs/gtfs-stop-selection-plan.md Phase 3). box-select.js
  // loads earlier, so the registry already exists here.
  if (App.boxSelect && typeof App.boxSelect.registerTarget === "function") {
    App.boxSelect.registerTarget({
      id: "gtfs-stops",
      label: "GTFS stops",
      noun: ["stop", "stops"],
      statusNoun: ["GTFS stop", "GTFS stops"],
      isAvailable: App.gtfsStops.isAvailable,
      candidates: App.gtfsStops.candidates,
      getKeys: App.gtfsStops.ids,
      setKeys: App.gtfsStops.set,
      countNote: function () {
        var c = App.gtfsStops.count();
        return _gtfsData && c.total > c.inFeed ? (c.total - c.inFeed) + " not in this feed" : "";
      }
    });
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

  // Copies one shape as an editable Line; returns the new line's array index,
  // or -1 when nothing was created. opts (optional): { multi: true } appends
  // " – <shape_id>" to the name; { group } sets attributes.group;
  // { serviceId, direction } set those attributes (grouped-Service copy).
  function copyShapeToLine(props, opts) {
    opts = opts || {};
    var shapeId = props.shape_id;
    if (!shapeId || !_shapesFC) return -1;

    var fullFeature = null;
    for (var i = 0; i < _shapesFC.features.length; i++) {
      if (_shapesFC.features[i].properties.shape_id === shapeId) {
        fullFeature = _shapesFC.features[i];
        break;
      }
    }
    if (!fullFeature) return -1;

    var coords = fullFeature.geometry.coordinates;
    var name = props.route_short_name || props.route_long_name || shapeId;
    if (opts.multi && name !== shapeId) name += " \u2013 " + shapeId;
    var routeType = parseInt(props.route_type, 10);
    var lineMode = ROUTE_TYPE_TO_LINE_MODE[routeType] || null;

    var color = null;
    var rc = (props.route_color || "").replace(/^#/, "");
    if (rc && rc.toLowerCase() !== "ffffff" && rc.length === 6) {
      color = "#" + rc;
    }

    var attrs = {};
    if (lineMode) attrs.mode = lineMode;
    if (opts.group) attrs.group = opts.group;
    if (opts.serviceId) attrs.serviceId = opts.serviceId;
    if (opts.direction) attrs.direction = opts.direction;
    var notesParts = [];
    if (props.route_id) notesParts.push("route_id: " + props.route_id);
    if (shapeId) notesParts.push("shape_id: " + shapeId);
    if (notesParts.length) attrs.notes = notesParts.join(", ");

    if (typeof App.addLineFromCoords !== "function") return -1;
    var before = App.lines ? App.lines.length : 0;
    App.addLineFromCoords(coords, {
      name: name,
      color: color,
      attributes: attrs
    });
    return (App.lines && App.lines.length > before) ? App.lines.length - 1 : -1;
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
        var options = [];

        if (isStop) {
          feats.forEach(function (f) {
            var props = f.properties;
            options.push({
              label: multiple ? "Copy As Point: " + stopName(props) : "Copy As Point",
              action: function () { copyStopToPoint(props, lngLat); }
            });
            var sid = String(props.stop_id);
            var sel = App.gtfsStops.has(sid);
            options.push({
              label: (sel ? "Remove from stop selection" : "Add to stop selection") +
                     (multiple ? ": " + stopName(props) : ""),
              action: function () { if (sel) App.gtfsStops.remove([sid]); else App.gtfsStops.add([sid]); }
            });
          });
        } else {
          // Group shapes by route (first-seen order), most trips first within
          // a route; a route heading appears only when 2+ routes are present.
          var groups = [], byRoute = {};
          feats.forEach(function (f) {
            var rk = f.properties.route_id || "";
            if (!byRoute[rk]) { byRoute[rk] = { name: shapeName(f.properties), items: [] }; groups.push(byRoute[rk]); }
            byRoute[rk].items.push({ props: f.properties, trips: shapeTripCount(f.properties.shape_id) });
          });
          groups.forEach(function (g) {
            g.items.sort(function (a, b) { return (b.trips || 0) - (a.trips || 0); });
            if (groups.length > 1) options.push({ divider: true, label: g.name });
            g.items.forEach(function (it) {
              var props = it.props, label = "Copy as line";
              if (multiple) {
                var nm = shapeName(props);
                label += ": " + (nm === props.shape_id ? nm : nm + " \u00b7 " + props.shape_id) +
                         (it.trips ? " \u00b7 " + it.trips + (it.trips === 1 ? " trip" : " trips") : "");
              }
              options.push({
                label: label,
                action: function () { copyShapeToLine(props); },
                // Preview-highlight on hover; restore the Layers-panel pin
                // (or clear) when the pointer leaves or the menu closes.
                onHover: function (entering) {
                  if (entering) App.gtfsHighlight({ shapeId: props.shape_id });
                  else if (typeof App.gtfsRestoreHighlight === "function") App.gtfsRestoreHighlight();
                  else App.gtfsHighlight(null);
                }
              });
            });
          });
        }

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
  function shapeTripCount(shapeId) {
    if (!_routeIndex) return 0;
    var n = 0;
    _routeIndex.forEach(function (r) {
      r.shapes.forEach(function (sh) { if (sh.shape_id === shapeId) n += sh.tripCount; });
    });
    return n;
  }
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

  // `document` is absent in the golden-test sandbox (pure helpers only).
  var _hasDoc    = typeof document !== "undefined";
  var _fileInput = _hasDoc ? document.getElementById("gtfs-file-input") : null;
  var _dropdown  = _hasDoc ? document.getElementById("add-data-dropdown") : null;
  var _loadBtn   = _hasDoc ? document.getElementById("gtfs-load-btn") : null;
  var _clearBtn  = _hasDoc ? document.getElementById("gtfs-clear-btn") : null;

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
  App.gtfsData     = _gtfsData;   // null until loaded
  App.loadGTFSFile = loadGTFSFile;
  App.clearGTFS    = clearGTFS;
  App.restoreGTFSFromData = restoreGTFSFromData;
  App.serializeGTFSData   = serializeGTFSData;
  App.setGtfsLayersVisible = function (visible) {
    if (typeof setRouteLayerVisibility === "function") setRouteLayerVisibility(visible);
    if (typeof setStopLayerVisibility  === "function") setStopLayerVisibility(visible);
  };


  // ---- Route browser public API ----

  function findIndexRoute(routeId) {
    if (!_routeIndex) return null;
    for (var i = 0; i < _routeIndex.length; i++) {
      if (_routeIndex[i].routeKey === routeId || _routeIndex[i].route_id === routeId) return _routeIndex[i];
    }
    return null;
  }
  function routeDisplayName(r) { return r.short || r.long || r.route_id || ""; }
  function shapeFeature(shapeId) {
    if (!_shapesFC) return null;
    for (var i = 0; i < _shapesFC.features.length; i++) {
      if (_shapesFC.features[i].properties.shape_id === shapeId) return _shapesFC.features[i];
    }
    return null;
  }
  function afterVisibilityChange() {
    var map = App.map;
    if (map && map.getLayer("gtfs-shapes-layer")) {
      map.setFilter("gtfs-shapes-layer", buildVisibilityFilter(_hiddenRoutes, _hiddenShapes));
    }
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }
  function applyPendingHidden() {
    var p = _pendingHidden;
    _pendingHidden = null;
    if (!p || !_routeIndex) return;
    var shapeIds = {};
    _routeIndex.forEach(function (r) { r.shapes.forEach(function (s) { shapeIds[s.shape_id] = true; }); });
    (p.routes || []).forEach(function (k) { if (findIndexRoute(k)) _hiddenRoutes[k] = true; });
    (p.shapes || []).forEach(function (k) { if (shapeIds[k]) _hiddenShapes[k] = true; });
    afterVisibilityChange();
  }

  App.gtfsRouteIndex = function () { return _routeIndex; };
  App.gtfsHiddenState = function () {
    return { routes: Object.keys(_hiddenRoutes), shapes: Object.keys(_hiddenShapes) };
  };
  App.gtfsSetRouteHidden = function (routeId, hidden) {
    if (!_routeIndex) return;
    if (hidden) _hiddenRoutes[routeId] = true; else delete _hiddenRoutes[routeId];
    afterVisibilityChange();
  };
  App.gtfsSetShapeHidden = function (shapeId, hidden) {
    if (!_routeIndex) return;
    if (hidden) _hiddenShapes[shapeId] = true; else delete _hiddenShapes[shapeId];
    afterVisibilityChange();
  };
  // routeIds = array of routeKeys to keep visible; null/undefined = show all.
  App.gtfsShowOnly = function (routeIds) {
    if (!_routeIndex) return;
    _hiddenRoutes = {}; _hiddenShapes = {};
    if (routeIds) {
      var keep = {};
      routeIds.forEach(function (k) { keep[k] = true; });
      _routeIndex.forEach(function (r) { if (!keep[r.routeKey]) _hiddenRoutes[r.routeKey] = true; });
    }
    afterVisibilityChange();
  };
  App.gtfsShowAll = function () { App.gtfsShowOnly(null); };

  // target = { routeId } | { shapeId } | null (clears the highlight).
  App.gtfsHighlight = function (target) {
    var map = App.map;
    if (!map || !map.getLayer(HL_LAYER)) return;
    var f = ["==", ["get", "shape_id"], "\u0000none"];
    if (target && target.shapeId != null) {
      f = ["==", ["get", "shape_id"], String(target.shapeId)];
    } else if (target && target.routeId != null) {
      f = target.routeId === UNASSIGNED_KEY
        ? ["==", ["coalesce", ["get", "route_id"], ""], ""]
        : ["==", ["coalesce", ["get", "route_id"], ""], String(target.routeId)];
    }
    map.setFilter(HL_CASING, f);
    map.setFilter(HL_LAYER, f);
  };

  App.gtfsZoomTo = function (target) {
    var map = App.map;
    if (!map || !_shapesFC || !target) return;
    var ids = null;
    if (target.shapeId != null) ids = [String(target.shapeId)];
    else if (target.routeId != null) {
      var r = findIndexRoute(target.routeId);
      if (r) ids = r.shapes.map(function (s) { return s.shape_id; });
    }
    if (!ids) return;
    var w = 180, s = 90, e = -180, n = -90, any = false;
    ids.forEach(function (id) {
      var f = shapeFeature(id);
      if (!f) return;
      f.geometry.coordinates.forEach(function (c) {
        any = true;
        if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
        if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
      });
    });
    if (any) map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 16 });
  };

  // opts = { routeId, mode: "representative"|"each"|"shape"|"service", shapeId }.
  // "service" copies every shape like "each" and also groups them as ONE
  // transit Service: shared attributes.serviceId (route name, made unique)
  // and a per-shape direction from GTFS direction_id when unambiguous.
  // Returns the array indices (into App.lines) of the created lines.
  App.gtfsCopy = function (opts) {
    opts = opts || {};
    var created = [];
    var route = opts.routeId != null ? findIndexRoute(opts.routeId) : null;
    var shapes = [];
    var asService = opts.mode === "service";
    if (opts.mode === "shape") {
      if (opts.shapeId != null) shapes = [String(opts.shapeId)];
    } else if (route) {
      if (opts.mode === "each" || asService) shapes = route.shapes.map(function (s) { return s.shape_id; });
      else { var rep = representativeShape(route); if (rep) shapes = [rep.shape_id]; }
    }
    var multi = (opts.mode === "each" || asService) && shapes.length > 1;
    var named = route && route.routeKey !== UNASSIGNED_KEY;
    var group = (multi || asService) && named ? routeDisplayName(route) : "";
    var serviceId = "", dirs = {};
    if (asService && named) {
      var existing = [];
      (App.routes || []).concat(App.lines || []).forEach(function (f) {
        var a = f && f.properties && f.properties.attributes;
        if (a && a.serviceId) existing.push(a.serviceId);
      });
      serviceId = uniqueServiceId(routeDisplayName(route), existing);
      var tripRows = (_gtfsData && _gtfsData.has("trips.txt")) ? _gtfsData.get("trips.txt").rows : [];
      dirs = shapeDirections(tripRows, route.route_id);
    }
    function copyAll() {
      shapes.forEach(function (sid) {
        var f = shapeFeature(sid);
        if (!f) return;
        var idx = copyShapeToLine(f.properties, { multi: multi, group: group,
          serviceId: serviceId, direction: serviceId ? (dirs[sid] || "") : "" });
        if (idx >= 0) created.push(idx);
      });
    }
    // Several lines in one go are ONE undo step.
    if (shapes.length > 1 && App.undo && typeof App.undo.batch === "function") App.undo.batch(copyAll);
    else copyAll();
    return created;
  };

  if (App.cache && typeof App.cache.registerModule === "function") {
    App.cache.registerModule("gtfs-browse", {
      collect: function () {
        // Stops + feedFile are collected whether or not a feed is loaded (D7).
        var out = _routeIndex ? App.gtfsHiddenState() : {};
        out.stops = _selectedStops.slice();
        out.feedFile = _feedFileName;
        return out;
      },
      apply: function (data) {
        // The feed itself is restored later (restoreGTFSFromData consumes this).
        if (data && (data.routes || data.shapes)) _pendingHidden = { routes: data.routes || [], shapes: data.shapes || [] };
        // The stop list doesn't depend on a feed being present: restore now.
        // (Not via changed(): this runs inside cache.restore; just redraw.)
        if (data && Array.isArray(data.stops)) {
          _selectedStops = cleanIds(data.stops);
          _selectedLookup = Object.create(null);
          _selectedStops.forEach(function (id) { _selectedLookup[id] = true; });
        }
        if (data && typeof data.feedFile === "string") _feedFileName = data.feedFile;
        var map = App.map;
        if (map && map.getLayer(SEL_LAYER)) map.setFilter(SEL_LAYER, selectedStopsFilter());
        if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
        refreshSelectionBar();
      }
    });
  }

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
