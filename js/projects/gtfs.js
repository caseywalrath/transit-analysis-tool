// js/projects/gtfs.js
// GTFS Feed Viewer + route browser engine: loads a GTFS ZIP, renders shapes and
// stops as reference layers, CSV table viewer, copy-to-feature helpers.
// Pure browse helpers (top of file) are golden-tested and must not touch DOM/map.
// Detail: docs/reference/modules/gtfs.md

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Module-local state ----
  var _gtfsData    = null;   // Map<filename, { headers: [], rows: [] }>; stop_times has rows: null, columnar: true (rows live in _feed.st)
  var _feed        = null;   // GtfsSchedule feed built from the same tables
  var _feedBlob    = null;   // the original ZIP, kept for session files; null after an old-format session restore
  var _selectedFile = null;  // currently active file in the directory list
  var _initialized  = false;
  var _showRoutes   = true;
  var _showStops    = true;
  var _shapesFC     = null;  // stored shapes FeatureCollection for full-geometry lookup
  var _hoverPopup   = null;  // maplibregl.Popup for hover tooltips (clicks open the attributes dock)
  var _layerListeners = [];  // [{ event, layerId, handler }] for explicit map.off() on tear-down
  // Told about every change to what GTFS analyses read (feed, date, hidden routes, day parts, stop list),
  // so an analysis with a Run button can mark its results stale.
  var _inputListeners = [];

  // ---- Stop selection state (docs/archive/gtfs-stop-selection-plan.md Phase 2) ----
  // The selection is a list of stop_id strings kept SEPARATELY from the loaded
  // feed (D7): it survives loading another ZIP and a page reload. Everything
  // else (highlight, counts, export) is derived from it plus the loaded feed.
  var _selectedStops  = [];                 // ordered stop_id strings
  var _selectedLookup = Object.create(null); // stop_id -> true
  var _stopsFC        = null;               // drawn-stops FeatureCollection (location_type 0/blank)
  var _feedFileName   = "";                 // ZIP name of the feed the list was last used with
  var _feedStopIdSet  = null;               // lazy Set of every stop_id in stops.txt
  var SEL_LAYER       = "gtfs-stops-selected";

  // ---- Route browser state (design: docs/archive/gtfs-route-browser-plan.md) ----
  var _routeIndex    = null;      // result of buildRouteIndex, or null when no shapes
  var _hiddenRoutes  = {};        // routeKey -> true
  var _hiddenShapes  = {};        // shape_id -> true
  var _pendingHidden = null;      // { routes: [], shapes: [] } from a restored session
  var _loadSeq = 0;               // bumped by every load and clear, so a slower, older load can tell it was superseded
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
  // the user sets it). Used by the "service" copy mode.
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

  // ---- Stop-list helpers (docs/archive/gtfs-stop-selection-plan.md Phase 1) ----
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
  }

  function removePopups() {
    if (_hoverPopup) _hoverPopup.remove();
    if (typeof App.getDockViewKey === "function" && /^gtfs:/.test(App.getDockViewKey() || "") &&
        typeof App.closeAttrDock === "function") App.closeAttrDock({ keepSelection: true });
  }

  // ---- ZIP / CSV parsing ----

  // opts.restored: the ZIP came from the IndexedDB copy of the last session
  // (restoreCachedGTFS below), not from the user. A restored load keeps the hidden
  // route/shape sets the session restore queued, and is not written back to the
  // store. Resolves true when the feed is on the map, false otherwise (bad ZIP, or
  // a newer load/clear superseded this one while it was parsing).
  async function loadGTFSFile(file, opts) {
    var restored = !!(opts && opts.restored);
    var seq = ++_loadSeq;
    App.setStatus(restored ? "Restoring GTFS feed\u2026" : "Reading GTFS feed\u2026");
    try {
      var zip = await JSZip.loadAsync(file);
    } catch (e) {
      App.setStatus("GTFS error: not a valid ZIP file.");
      return false;
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
      return false;
    }

    // Require at least one GTFS-spec required file before treating this as a feed.
    var hasRequired = entries.some(function (e) { return REQUIRED[e.name]; });
    if (!hasRequired) {
      App.setStatus("GTFS error: ZIP contains no required GTFS files (stops, routes, trips, stop_times, calendar, calendar_dates, or agency).");
      return false;
    }

    App.setStatus("Parsing GTFS files\u2026");
    var S = window.GtfsSchedule;
    var tables = {}, stStore = null;
    for (var i = 0; i < entries.length; i++) {
      var name  = entries[i].name;
      var entry = entries[i].entry;
      try {
        var text = await entry.async("string");
        if (seq !== _loadSeq) return false;
        if (name === "shapes.txt") {
          data.set(name, await parseShapesAsync(text));
        } else if (name === "stop_times.txt") {
          var stHeaders = [];
          var b = new S.StopTimesBuilder();
          await streamText(text, new S.CsvStream(function (h) { stHeaders = h; b.header(h); }, function (v) { b.row(v); }));
          text = null;
          stStore = b.finish();
          data.set(name, { headers: stHeaders, rows: null, rowCount: stStore.rowCount, columnar: true });
        } else {
          var t = await parseTableAsync(text);
          tables[name] = t;
          data.set(name, t);
        }
      } catch (e) {
        console.warn("GTFS: could not parse", name, e);
      }
      if (seq !== _loadSeq) return false;
    }

    // A newer load, or a Remove layer, happened while this one was parsing.
    if (seq !== _loadSeq) return false;

    if (!(opts && opts.keepHidden) && !restored) { _pendingHidden = null; _pendingDate = null; } // a fresh upload never inherits a session's hidden sets or date
    _feedFileName = file.name || "";
    _feedBlob = file;
    _feed = S.buildFeed(tables, stStore);
    applyGtfsData(data);
    if (restored || (opts && opts.keepHidden)) applyPendingHidden();
    initAnalysisDate();
    changed(); // feed name changed + re-apply highlight/counts; the stop list itself is kept (D8)
    if (restored) {
      App.setStatus("GTFS feed restored from last session: " + _feedFileName + " (" + data.size + " file(s)).");
    } else {
      App.setStatus("GTFS loaded: " + data.size + " file(s).");
      persistFeed(file, seq);
    }
    return true;
  }

  // Large tables (stop_times, shapes) would block the page for over a second if
  // parsed in one call, so text is fed to the parser a slice at a time and the
  // page gets a turn whenever a slice run has taken more than ~40 ms.
  var SLICE_CHARS = 1 << 18;
  function yieldToPage() { return new Promise(function (r) { setTimeout(r, 0); }); }
  async function streamText(text, cs) {
    var last = Date.now();
    for (var i = 0; i < text.length; i += SLICE_CHARS) {
      cs.write(text.slice(i, i + SLICE_CHARS));
      if (Date.now() - last > 40) { await yieldToPage(); last = Date.now(); }
    }
    cs.end();
  }
  // shapes.txt is grouped straight into per-shape point lists: on a large feed
  // its row objects were the biggest memory cost after stop_times. Only the
  // first rows are kept as objects, for the table viewer.
  async function parseShapesAsync(text) {
    var headers = [], preview = [], groups = {}, count = 0, c = null;
    await streamText(text, new window.GtfsSchedule.CsvStream(function (h) {
      headers = h;
      c = { id: h.indexOf("shape_id"), lat: h.indexOf("shape_pt_lat"), lon: h.indexOf("shape_pt_lon"), seq: h.indexOf("shape_pt_sequence") };
    }, function (v) {
      count++;
      if (preview.length < TABLE_ROW_LIMIT) {
        var o = {};
        for (var k = 0; k < headers.length; k++) o[headers[k]] = v[k];
        preview.push(o);
      }
      if (c.id < 0 || c.lat < 0 || c.lon < 0 || c.seq < 0) return;
      addShapePoint(groups, v[c.id], v[c.lat], v[c.lon], v[c.seq]);
    }));
    return { headers: headers, rows: null, rowCount: count, columnar: true, preview: preview, groups: groups };
  }

  async function parseTableAsync(text) {
    var headers = [], rows = [];
    await streamText(text, new window.GtfsSchedule.CsvStream(function (h) { headers = h; }, function (v) {
      var o = {};
      for (var k = 0; k < headers.length; k++) o[headers[k]] = v[k];
      rows.push(o);
    }));
    return { headers: headers, rows: rows };
  }

  // Keep the ZIP in IndexedDB (js/core/gtfs-store.js) so a page refresh brings
  // the feed back. Deferred one tick: nothing downstream waits on it. Skipped
  // when a newer load or a Remove layer has happened since, so a dismissed feed
  // can never be written back after its clear.
  function persistFeed(file, seq) {
    if (!file || !file.name || typeof file.arrayBuffer !== "function") return;
    if (!App.gtfsStore || !App.gtfsStore.supported()) return;
    setTimeout(function () {
      file.arrayBuffer().then(function (buf) {
        if (seq !== _loadSeq) return;
        return App.gtfsStore.save(file.name, buf);
      }).catch(function () { /* optimization only */ });
    }, 0);
  }

  // Bring back the feed that was loaded when the page was last open. Called once
  // at startup from app.js, after cache.restore() so the stop selection and the
  // queued hidden sets are already in place. Resolves true when a feed was
  // restored. Re-parses the original ZIP through loadGTFSFile(), the same path as
  // an upload. A feed that arrived some other way first (a session file, or the
  // user picking a ZIP while this was reading) wins and this does nothing.
  async function restoreCachedGTFS() {
    if (_gtfsData) return false;
    if (!App.gtfsStore || !App.gtfsStore.supported()) return false;
    var startSeq = _loadSeq;
    var rec = await App.gtfsStore.latest();
    if (!rec || !rec.bytes) return false;
    if (_gtfsData || _loadSeq !== startSeq) return false;
    var file = new File([rec.bytes], rec.name, { type: "application/zip" });
    var ok = await loadGTFSFile(file, { restored: true });
    // Unreadable copy and nothing else touched the feed meanwhile: drop it so it
    // does not fail again on every refresh.
    if (!ok && !_gtfsData && _loadSeq === startSeq + 1) App.gtfsStore.clear();
    return ok;
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
  // Session files saved before the ZIP was embedded carry the parsed tables;
  // they still open, by rebuilding the same store an upload would.
  function restoreGTFSFromData(serialized) {
    if (!serialized || typeof serialized !== "object") return;
    var S = window.GtfsSchedule;
    var dataMap = new Map(), tables = {}, stStore = null;
    Object.keys(serialized).forEach(function (k) {
      var t = serialized[k];
      if (!t || !Array.isArray(t.rows)) return;
      var headers = t.headers || [];
      if (k === "stop_times.txt") {
        var b = new S.StopTimesBuilder();
        b.header(headers);
        t.rows.forEach(function (r) {
          b.row(headers.map(function (h) { return r[h] == null ? "" : String(r[h]); }));
        });
        stStore = b.finish();
        dataMap.set(k, { headers: headers, rows: null, rowCount: stStore.rowCount, columnar: true });
      } else {
        tables[k] = { headers: headers, rows: t.rows };
        dataMap.set(k, tables[k]);
      }
    });
    if (dataMap.size === 0) return;
    _loadSeq++;
    _feedBlob = null;
    _feed = S.buildFeed(tables, stStore);
    applyGtfsData(dataMap);
    applyPendingHidden();
    initAnalysisDate();
    changed();
    App.setStatus("GTFS restored: " + dataMap.size + " file(s).");
  }

  // The parsed tables as plain objects (the pre-ZIP session shape). No longer
  // written to session files; kept for callers that inspect the loaded feed.
  // stop_times rows are rebuilt from the columns on each call, so it is slow on
  // a large feed.
  function serializeGTFSData() {
    if (!_gtfsData || _gtfsData.size === 0) return null;
    var out = {};
    _gtfsData.forEach(function (val, key) {
      if (!val.columnar) { out[key] = val; return; }
      if (key === "shapes.txt") { out[key] = { headers: ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], rows: shapeRowsFromFC() }; return; }
      out[key] = { headers: STOP_TIMES_COLUMNS.slice(), rows: stopTimesPreviewRows(Infinity) };
    });
    return out;
  }

  function shapeRowsFromFC() {
    var out = [];
    ((_shapesFC && _shapesFC.features) || []).forEach(function (f) {
      f.geometry.coordinates.forEach(function (c, i) {
        out.push({ shape_id: f.properties.shape_id, shape_pt_lat: String(c[1]), shape_pt_lon: String(c[0]), shape_pt_sequence: String(i + 1) });
      });
    });
    return out;
  }

  // Session payload: the original ZIP as base64 (several times smaller than the
  // parsed tables). Null when no feed is loaded or it came from an old session
  // file that had no ZIP to keep.
  function serializeGTFSZip() {
    if (!_gtfsData || !_feedBlob) return Promise.resolve(null);
    var blob = _feedBlob, name = _feedFileName;
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || ""), comma = s.indexOf(",");
        resolve(comma >= 0 ? { name: name, base64: s.slice(comma + 1) } : null);
      };
      fr.onerror = function () { resolve(null); };
      fr.readAsDataURL(blob);
    });
  }

  // Loads a feed from a session file's embedded ZIP through the upload path, so
  // it is identical to an upload; the session's hidden sets are kept.
  function restoreGTFSFromZip(payload) {
    if (!payload || typeof payload.base64 !== "string") return Promise.resolve(false);
    var bin;
    try { bin = atob(payload.base64); } catch (e) { return Promise.reject(new Error("the GTFS feed in this session file is damaged")); }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var file = new File([bytes], payload.name || "feed.zip", { type: "application/zip" });
    return loadGTFSFile(file, { keepHidden: true });
  }

  // ---- Day to analyze ----
  // One exact service date shared by every GTFS analysis. Kept here because it
  // only means something while a feed is loaded; open panels subscribe through
  // App.gtfsAnalysisDate.onChange.
  var _analysisDate = null;
  var _pendingDate = null;   // from a restored session, applied once the feed is in
  var _dateListeners = [];

  function fireDateChange() {
    _dateListeners.slice().forEach(function (fn) {
      try { fn(_analysisDate); } catch (e) { console.warn("GTFS date listener failed:", e); }
    });
    renderDateControls();
    if (isPopupVisible()) renderOverview();
  }

  // Keeps a session's date when the feed covers it; otherwise starts on the
  // feed's busiest weekday so a first look shows full service, not a holiday.
  function initAnalysisDate() {
    var S = window.GtfsSchedule, range = _feed ? S.dateRange(_feed) : null;
    var want = _pendingDate;
    _pendingDate = null;
    if (!range) _analysisDate = null;
    else if (want && want >= range.start && want <= range.end) _analysisDate = want;
    else _analysisDate = S.busiestDate(_feed, "weekday") || range.start;
    fireDateChange();
  }

  function setAnalysisDate(date) {
    if (typeof date !== "string" || !/^\d{8}$/.test(date) || !_feed) return false;
    var range = window.GtfsSchedule.dateRange(_feed);
    if (!range || date < range.start || date > range.end) return false;
    if (date === _analysisDate) return true;
    _analysisDate = date;
    fireDateChange();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    return true;
  }

  function isoOf(d) { return d ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; }

  function describeDate(d) {
    if (!d || !_feed) return "";
    var S = window.GtfsSchedule, info = S.dayType(_feed, d);
    var n = S.tripsOnDate(_feed, d).trips.length;
    var dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
    var label = dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    return label + " · " + n.toLocaleString() + " trip" + (n === 1 ? "" : "s") +
      (info.exception ? " · special service (holiday or added service)" : "");
  }

  function renderDateControls() {
    if (typeof document === "undefined") return;
    var wrap = document.getElementById("gtfsDateControls");
    if (!wrap) return;
    var range = _feed ? window.GtfsSchedule.dateRange(_feed) : null;
    wrap.style.display = range ? "" : "none";
    if (!range) return;
    var input = document.getElementById("gtfsAnalysisDate");
    if (input) {
      input.min = isoOf(range.start);
      input.max = isoOf(range.end);
      input.value = isoOf(_analysisDate);
    }
    var desc = document.getElementById("gtfsAnalysisDateDesc");
    if (desc) desc.textContent = describeDate(_analysisDate);
    var rng = document.getElementById("gtfsAnalysisDateRange");
    if (rng) rng.textContent = "Feed runs " + isoOf(range.start) + " to " + isoOf(range.end) + ".";
  }

  function clearGTFS() {
    _loadSeq++; // cancels any load still parsing
    // Clearing is an explicit "remove this" action (Remove layer, Clear all
    // features, Reset Session), so the stored copy goes too — otherwise the next
    // refresh would resurrect the feed the user just dismissed.
    if (App.gtfsStore) App.gtfsStore.clear();
    _gtfsData = null;
    _selectedFile = null;
    _routeIndex = null;
    _hiddenRoutes = {};
    _hiddenShapes = {};
    _pendingHidden = null;
    _feedFileName = "";
    _feed = null;
    _feedBlob = null;
    _analysisDate = null;
    _pendingDate = null;
    fireDateChange();
    _selectedStops = [];
    _selectedLookup = Object.create(null);
    removeMapLayers(); // also removes popups
    updateDropdownUI();
    changed();
    if (isPopupVisible()) {
      renderOverview();
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
  // (docs/archive/layer-color-customization-plan.md). Only the fallback color
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
      var shEntry = _gtfsData.get("shapes.txt");
      var shapesFC = buildShapesGeoJSON(shEntry.columnar ? shEntry : shEntry.rows, routeLookup);
      // The grouped points now live in the features; drop them (memory).
      if (shEntry.columnar) shEntry.groups = null;
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
    fireInputsChange();
  }

  function fireInputsChange() {
    _inputListeners.slice().forEach(function (fn) {
      try { fn(); } catch (e) { console.error("GTFS input listener failed", e); }
    });
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

  // Box-select target (docs/archive/gtfs-stop-selection-plan.md Phase 3). box-select.js
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
  // { serviceId, direction, service, runTime } set those attributes (grouped-Service copy).
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
    if (opts.service) attrs.service = JSON.parse(JSON.stringify(opts.service));
    if (typeof opts.runTime === "number") attrs.runTime = opts.runTime;
    if (typeof opts.avgSpeed === "number") attrs.avgSpeed = opts.avgSpeed;
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
        if (!App.drawMode) map.getCanvas().style.cursor = "default";
      });

      addListener("mousemove", layerId, function (e) {
        var feats = featuresNear(e, layerId, function (p) { return keyFor(p, isStop); });
        if (!feats.length) return;
        if (!App.drawMode) map.getCanvas().style.cursor = "default";
        ensurePopups();
        _hoverPopup
          .setLngLat(e.lngLat)
          .setHTML(buildHoverHTML(feats, isStop))
          .addTo(map);
      });

      addListener("mouseleave", layerId, function () {
        map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "default";
        if (_hoverPopup) _hoverPopup.remove();
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
            if (!byRoute[rk]) { byRoute[rk] = { name: shapeName(f.properties), routeId: rk, items: [] }; groups.push(byRoute[rk]); }
            byRoute[rk].items.push({ props: f.properties, trips: shapeTripCount(f.properties.shape_id) });
          });
          groups.forEach(function (g) {
            g.items.sort(function (a, b) { return (b.trips || 0) - (a.trips || 0); });
            if (groups.length > 1) options.push({ divider: true, label: g.name });
            // Offered only when the feed has a timetable for this route; a route
            // without one has nothing more to copy than its lines.
            if (g.routeId && App.gtfsHasSchedule(g.routeId)) {
              options.push({
                label: "Copy route as Service with schedule" + (groups.length > 1 ? "" : ": " + g.name),
                action: function () {
                  var made = App.gtfsCopy({ routeId: g.routeId, mode: "service" }) || [];
                  if (made.length && typeof App.selectFeature === "function") App.selectFeature("line", made[0]);
                  if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
                  if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
                  if (made.note && typeof App.gtfsShowCopyNote === "function") App.gtfsShowCopyNote(made.note);
                }
              });
            }
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

  // ---- GeoJSON builders ----

  function addShapePoint(groups, id, latText, lonText, seqText) {
    var lat = parseFloat(latText);
    var lon = parseFloat(lonText);
    var seq = parseInt(seqText, 10);
    if (!id || isNaN(lat) || isNaN(lon) || isNaN(seq)) return;
    if (!groups[id]) groups[id] = [];
    groups[id].push([seq, lon, lat]);
  }

  // rows: shapes.txt row objects, or { groups } already built while parsing.
  function buildShapesGeoJSON(rows, routeLookup) {
    // Group points by shape_id, sort by sequence, build LineStrings
    var groups = {};
    if (rows && rows.groups) groups = rows.groups;
    else for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      addShapePoint(groups, r.shape_id, r.shape_pt_lat, r.shape_pt_lon, r.shape_pt_sequence);
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
      btn.title = (fileData.columnar ? fileData.rowCount : fileData.rows.length) + " rows";

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

  // stop_times is held as compact columns rather than row objects (memory), so
  // the viewer shows the columns the app keeps, rebuilt for the first rows only.
  var STOP_TIMES_COLUMNS = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "timepoint"];
  function stopTimesPreviewRows(limit) {
    var st = _feed && _feed.st, out = [];
    if (!st) return out;
    var S = window.GtfsSchedule, n = Math.min(limit, st.rowCount);
    for (var i = 0; i < n; i++) {
      out.push({
        trip_id: st.tripIds[st.trip[i]], arrival_time: S.formatTime(st.arr[i]),
        departure_time: S.formatTime(st.dep[i]), stop_id: st.stopIds[st.stop[i]],
        stop_sequence: String(st.seq[i]), timepoint: st.tp[i] === 255 ? "" : String(st.tp[i])
      });
    }
    return out;
  }

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
    var total   = rows ? rows.length : fileData.rowCount;
    if (fileData.columnar && fileData.preview) {
      rows = fileData.preview;
    } else if (fileData.columnar) {
      headers = STOP_TIMES_COLUMNS;
      rows = stopTimesPreviewRows(TABLE_ROW_LIMIT);
    }
    var shown   = Math.min(total, TABLE_ROW_LIMIT);

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
    if (total > TABLE_ROW_LIMIT) {
      tbHtml +=
        '<tr class="gtfs-table-truncated"><td colspan="' + headers.length + '">' +
        "Showing " + TABLE_ROW_LIMIT + " of " + total.toLocaleString() + " rows" +
        "</td></tr>";
    }
    tbody.innerHTML = tbHtml;
    wrapper.style.display = "";

    if (meta) {
      meta.textContent =
        total.toLocaleString() + " row" + (total !== 1 ? "s" : "") +
        ", " + headers.length + " column" + (headers.length !== 1 ? "s" : "") +
        (fileData.columnar && !fileData.preview ? " (the columns the app uses, in trip and stop order)" : "");
      meta.style.display = "";
    }
  }

  // Thin alias; escaping is centralized in App.escapeHTML (utils.js).
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

    var dateInput = document.getElementById("gtfsAnalysisDate");
    if (dateInput) {
      dateInput.addEventListener("change", function () {
        var v = String(this.value || "").replace(/-/g, "");
        if (!setAnalysisDate(v)) renderDateControls();
      });
    }

    wireOverview();

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
    renderDateControls();
    renderOverview();
    switchTab();

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
  App.restoreCachedGTFS = restoreCachedGTFS;
  App.clearGTFS    = clearGTFS;
  App.restoreGTFSFromData = restoreGTFSFromData;
  App.restoreGTFSFromZip  = restoreGTFSFromZip;
  App.serializeGTFSZip    = serializeGTFSZip;
  App.serializeGTFSData   = serializeGTFSData;
  App.gtfsSchedule = function () { return _feed; };
  App.gtfsAnalysisDate = {
    get: function () { return _analysisDate; },
    set: setAnalysisDate,
    onChange: function (fn) {
      if (typeof fn !== "function") return function () {};
      _dateListeners.push(fn);
      return function () { var i = _dateListeners.indexOf(fn); if (i >= 0) _dateListeners.splice(i, 1); };
    }
  };
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
    refreshDetails();
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

  // ---- Day parts: one setting for copied headway bands and every headway report ----

  var _dayParts = null;   // null = GtfsSchedule.DEFAULT_DAY_PARTS

  function dayParts() { return _dayParts || window.GtfsSchedule.DEFAULT_DAY_PARTS; }

  // starts: one "HH:MM" per default part, the first fixed at 00:00 (so every trip falls in a part),
  // strictly increasing. Ids and labels stay the defaults: reports find peak/off-peak by id.
  function partsFromStarts(starts) {
    var D = window.GtfsSchedule.DEFAULT_DAY_PARTS;
    if (!Array.isArray(starts) || starts.length !== D.length || starts[0] !== "00:00") return null;
    var prev = -1, out = [];
    for (var i = 0; i < D.length; i++) {
      var m = /^(\d{2}):(\d{2})$/.exec(String(starts[i]));
      if (!m || +m[1] > 23 || +m[2] > 59) return null;
      var mins = +m[1] * 60 + +m[2];
      if (mins <= prev) return null;
      prev = mins;
      out.push({ id: D[i].id, label: D[i].label, start: starts[i] });
    }
    return out;
  }

  function isDefaultParts(parts) {
    var D = window.GtfsSchedule.DEFAULT_DAY_PARTS;
    return parts.every(function (p, i) { return p.start === D[i].start; });
  }

  App.gtfsDayParts = {
    get: function () { return dayParts().map(function (p) { return { id: p.id, label: p.label, start: p.start }; }); },
    // Returns false (and changes nothing) for an invalid list.
    set: function (starts) {
      var parts = partsFromStarts(starts);
      if (!parts) return false;
      _dayParts = isDefaultParts(parts) ? null : parts;
      afterDetailsInputChange();
      if (App.cache && typeof App.cache.save === "function") App.cache.save();
      return true;
    },
    reset: function () { return App.gtfsDayParts.set(window.GtfsSchedule.DEFAULT_DAY_PARTS.map(function (p) { return p.start; })); },
    isDefault: function () { return !_dayParts; }
  };

  // ---- Stop and route details (read-only views in the attributes dock) ----

  var STOP_LAYER = "gtfs-stops-layer", SHAPE_LAYER = "gtfs-shapes-layer";

  // Route ids the schedule figures count. Hidden routes drop out unless includeHidden, so the
  // details agree with what the map shows. Null = every route (nothing hidden).
  function scheduleRouteIds(includeHidden) {
    if (includeHidden || !_feed) return null;
    var hidden = Object.keys(_hiddenRoutes);
    if (!hidden.length) return null;
    // Every timetable route except the hidden ones: routes without a drawn shape are not in the
    // route index, but are never hidden.
    return Object.keys(_feed._routes).filter(function (id) { return !_hiddenRoutes[id]; });
  }

  function routeRow(routeId) {
    var t = _feed && _feed.tables && _feed.tables["routes.txt"];
    var rows = (t && t.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].route_id || "").trim() === routeId) return rows[i];
    }
    return null;
  }

  // A key/value table of every field of one CSV row, in file order, with friendly
  // labels added for coded fields.
  function fieldTable(el, row, friendly) {
    var tbl = document.createElement("table");
    tbl.className = "gtfs-fields";
    var body = document.createElement("tbody");
    function add(k, v, cls) {
      var tr = document.createElement("tr");
      if (cls) tr.className = cls;
      var th = document.createElement("th"); th.scope = "row"; th.textContent = k;
      var td = document.createElement("td"); td.textContent = v;
      tr.appendChild(th); tr.appendChild(td); body.appendChild(tr);
    }
    (friendly || []).forEach(function (f) { if (f[1]) add(f[0], f[1], "gtfs-fields-friendly"); });
    Object.keys(row || {}).forEach(function (k) {
      var v = row[k] == null ? "" : String(row[k]).trim();
      if (v !== "") add(k, v);
    });
    tbl.appendChild(body);
    el.appendChild(tbl);
  }

  function emptyNote(el, text) {
    var d = document.createElement("div");
    d.className = "ad-empty";
    d.textContent = text;
    el.appendChild(d);
  }

  function renderStopDetails(el, stopId) {
    var row = stopRow(stopId);
    if (!row) { emptyNote(el, "This stop is not in stops.txt."); return; }
    // Same rule as GtfsSchedule.stopAccessibility, for one stop (that call walks the whole feed).
    var s = _feed && _feed._stops[stopId], wl = "";
    if (s) {
      var v = s.wheelchair, inherited = false;
      if (v !== "1" && v !== "2" && s.parent && _feed._stops[s.parent]) { v = _feed._stops[s.parent].wheelchair; inherited = true; }
      if (v === "1" || v === "2") wl = WHEELCHAIR_LABELS[v] + (inherited ? " (from its station)" : "");
    }
    fieldTable(el, row, [
      ["Type", LOCATION_TYPE_LABELS[String(row.location_type || "0").trim() || "0"] || ""],
      ["Wheelchair", wl]
    ]);
  }

  function renderRouteDetails(el, routeKey) {
    var r = findIndexRoute(routeKey);
    var row = r && r.route_id ? routeRow(r.route_id) : null;
    if (!r) { emptyNote(el, "This route is no longer in the feed."); return; }
    var mode = ROUTE_TYPE_LABELS[parseInt(r.type, 10)] || "";
    fieldTable(el, row || { route_id: r.route_id }, [
      ["Mode", mode],
      ["Shapes", String(r.shapes.length)]
    ]);
  }

  // Filled in by the details tab renderers below; each takes (el, id, state).
  var _stopTabs = [
    { id: "details", label: "Details", render: function (el, id) { renderStopDetails(el, id); } }
  ];
  var _routeTabs = [
    { id: "details", label: "Details", render: function (el, id) { renderRouteDetails(el, id); } }
  ];

  // Per-view switches (show hidden routes, sort order) that survive instant refreshes.
  var _viewState = {};

  function viewTabs(list, id, key) {
    var state = _viewState[key] || (_viewState[key] = {});
    return list.map(function (t) {
      return { id: t.id, label: t.label, render: function (el) { t.render(el, id, state, refreshDetails); } };
    });
  }

  function stopView(stopId) {
    var row = stopRow(stopId) || {};
    var name = String(row.stop_name || "").trim() || stopId;
    var code = String(row.stop_code || "").trim();
    var key = "gtfs:stop:" + stopId;
    var lon = parseFloat(row.stop_lon), lat = parseFloat(row.stop_lat);
    var placed = isFinite(lon) && isFinite(lat);
    var toolbar = [];
    if (placed) {
      toolbar.push({ label: "Zoom to", action: function () {
        if (App.map) App.map.easeTo({ center: [lon, lat], zoom: Math.max(App.map.getZoom(), 16) });
      } });
      toolbar.push({ label: "Copy as Point", action: function () {
        copyStopToPoint(Object.assign({ stop_id: stopId }, row), { lng: lon, lat: lat });
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
      } });
    }
    toolbar.push({ label: App.gtfsStops.has(stopId) ? "Remove from stop selection" : "Add to stop selection", action: function () {
      if (App.gtfsStops.has(stopId)) App.gtfsStops.remove([stopId]); else App.gtfsStops.add([stopId]);
      refreshDetails();
    } });
    return {
      key: key,
      title: name,
      typeText: "GTFS stop · " + (code ? "#" + code : stopId),
      tabs: viewTabs(_stopTabs, stopId, key),
      toolbar: toolbar
    };
  }

  // shapeId names the clicked shape; it matters for shapes without a route, which all share one key.
  function routeView(routeKey, shapeId) {
    var r = findIndexRoute(routeKey);
    var unassigned = routeKey === UNASSIGNED_KEY;
    var key = "gtfs:route:" + routeKey + (unassigned && shapeId ? "|" + shapeId : "");
    var color = r && r.color ? r.color : null;
    var mode = ROUTE_TYPE_LABELS[parseInt(r ? r.type : "", 10)] || "route";
    var toolbar = [
      { label: "Zoom to", action: function () {
        App.gtfsZoomTo(unassigned && shapeId ? { shapeId: shapeId } : { routeId: routeKey });
      } }
    ];
    if (r && !unassigned && App.gtfsHasSchedule(routeKey)) {
      toolbar.push({ label: "Copy as Service with schedule", action: function () {
        var made = App.gtfsCopy({ routeId: routeKey, mode: "service" }) || [];
        if (made.length && typeof App.selectFeature === "function") App.selectFeature("line", made[0]);
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
        if (made.note && typeof App.gtfsShowCopyNote === "function") App.gtfsShowCopyNote(made.note);
      } });
    }
    var typeText = unassigned
      ? "GTFS shape" + (shapeId ? " · " + shapeId : "") + " · no route"
      : "GTFS " + mode.toLowerCase() + (r && r.long && r.short ? " · " + r.long : "");
    return {
      key: key,
      title: r ? routeDisplayName(r) : String(routeKey),
      typeText: typeText,
      color: color,
      tabs: viewTabs(_routeTabs, routeKey, key),
      toolbar: toolbar,
      onClose: function () {
        if (typeof App.gtfsRestoreHighlight === "function") App.gtfsRestoreHighlight();
        else App.gtfsHighlight(null);
      }
    };
  }

  var _openTarget = null;   // what the open GTFS view shows, for in-place redraws

  function viewFor(target) {
    if (!target) return null;
    if (target.kind === "stop") return stopView(String(target.stopId));
    if (target.kind === "route") return routeView(target.routeId, target.shapeId);
    return null;
  }

  // The GTFS stop (preferred) or route under a map point, or null.
  App.gtfsPickAt = function (point) {
    var map = App.map;
    if (!map || !point) return null;
    var T = 5, box = [[point.x - T, point.y - T], [point.x + T, point.y + T]];
    if (map.getLayer(STOP_LAYER)) {
      var st = map.queryRenderedFeatures(box, { layers: [STOP_LAYER] });
      for (var i = 0; i < st.length; i++) {
        if (st[i].properties && st[i].properties.stop_id != null) return { kind: "stop", stopId: String(st[i].properties.stop_id) };
      }
    }
    if (map.getLayer(SHAPE_LAYER)) {
      var sh = map.queryRenderedFeatures(box, { layers: [SHAPE_LAYER] });
      if (sh.length) {
        var p = sh[0].properties || {};
        return { kind: "route", routeId: p.route_id ? String(p.route_id) : UNASSIGNED_KEY, shapeId: p.shape_id };
      }
    }
    return null;
  };

  // Gesture entry point: opens the dock on a GTFS stop or route.
  App.gtfsOpenDetails = function (target) {
    var view = viewFor(target);
    if (!view || typeof App.openDockView !== "function") return;
    if (_hoverPopup) _hoverPopup.remove();
    App.openDockView(view);
    _openTarget = target;
    if (target.kind === "route") {
      App.gtfsHighlight(target.routeId === UNASSIGNED_KEY && target.shapeId ? { shapeId: target.shapeId } : { routeId: target.routeId });
    }
  };

  // Schedule-only figures never go stale: any change to their inputs redraws them at once.
  function refreshDetails() {
    fireInputsChange();
    var key = typeof App.getDockViewKey === "function" ? App.getDockViewKey() : null;
    if (!key || key.indexOf("gtfs:") !== 0 || !_openTarget) return;
    var view = viewFor(_openTarget);
    if (view && view.key === key) App.refreshDockView({ view: view });
  }

  function afterDetailsInputChange() {
    refreshDetails();
    if (isPopupVisible() && typeof renderOverview === "function") renderOverview();
  }

  _dateListeners.push(function () { refreshDetails(); });

  // ---- Details tabs and feed overview ----

  function clockText(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "—";
    var mins = Math.floor(Math.round(sec) / 60), over = mins >= 1440;
    if (over) mins -= 1440;
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + (over ? " (+1)" : "");
  }

  function minutesText(sec) {
    return typeof sec !== "number" || !isFinite(sec) ? "—" : Math.round(sec / 60) + " min";
  }

  function distanceText(m) {
    if (typeof m !== "number" || !isFinite(m)) return "—";
    var ft = m * 3.28084;
    return ft < 1000 ? Math.round(ft) + " ft" : (m / 1609.344).toFixed(2) + " mi";
  }

  function stopName(id) {
    var row = stopRow(id);
    var n = row ? String(row.stop_name || "").trim() : "";
    return n || id;
  }

  function routeName(routeId) {
    var r = findIndexRoute(routeId);
    return r ? routeDisplayName(r) : routeId;
  }

  function dirText(d) { return d === "0" ? "Direction 0" : d === "1" ? "Direction 1" : "No direction"; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A table whose cells are plain text. numCols: indexes of right-aligned numeric columns.
  function textTable(cls, heads, numCols) {
    var tbl = el("table", "gtfs-dt-table" + (cls ? " " + cls : ""));
    var tr = el("tr");
    heads.forEach(function (h, i) {
      var th = el("th", numCols.indexOf(i) >= 0 ? "num" : "", h);
      th.scope = "col";
      tr.appendChild(th);
    });
    var thead = el("thead");
    thead.appendChild(tr);
    var body = el("tbody");
    tbl.appendChild(thead);
    tbl.appendChild(body);
    tbl.addRow = function (cells, title) {
      var r = el("tr");
      if (title) r.title = title;
      cells.forEach(function (c, i) { r.appendChild(el("td", numCols.indexOf(i) >= 0 ? "num" : "", c)); });
      body.appendChild(r);
    };
    return tbl;
  }

  function partsTable(parts, countHead) {
    var t = textTable("", ["Part", "From", countHead, "Every"], [1, 2, 3]);
    parts.forEach(function (p) { t.addRow([p.label, p.start, String(p.departures != null ? p.departures : p.trips), minutesText(p.headwaySec)]); });
    return t;
  }

  function everyLine(o) {
    return "Peak every " + minutesText(o.peakHeadwaySec) + " · Off-peak every " + minutesText(o.offPeakHeadwaySec);
  }

  var TRIP_ROW_LIMIT = 200;

  function renderStopTrips(box, id, state, refresh) {
    var S = window.GtfsSchedule, date = App.gtfsAnalysisDate.get();
    if (!_feed || !date) { emptyNote(box, "Load a GTFS feed with stop_times.txt to see trips."); return; }
    var mode = state.mode === "arr" ? "arr" : "dep";
    var sort = state.sort === "route" ? "route" : "time";

    var ctl = el("div", "gtfs-dt-controls");
    [["dep", "Departures"], ["arr", "Arrivals"]].forEach(function (m) {
      var b = el("button", "gtfs-dt-seg rf-btn-sm" + (mode === m[0] ? " active" : ""), m[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", mode === m[0] ? "true" : "false");
      b.addEventListener("click", function () { state.mode = m[0]; state.showAll = false; refresh(); });
      ctl.appendChild(b);
    });
    var sel = el("select", "rf-select gtfs-dt-sort");
    sel.setAttribute("aria-label", "Sort trips");
    [["time", "By time"], ["route", "By route"]].forEach(function (o) {
      var op = el("option", "", o[1]);
      op.value = o[0];
      if (o[0] === sort) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener("change", function () { state.sort = sel.value; refresh(); });
    ctl.appendChild(sel);
    if (scheduleRouteIds(false)) {
      var lab = el("label", "gtfs-dt-hidden");
      var cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!state.includeHidden;
      cb.addEventListener("change", function () { state.includeHidden = cb.checked; state.showAll = false; refresh(); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" Show hidden routes"));
      ctl.appendChild(lab);
    }
    box.appendChild(ctl);

    var routeIds = scheduleRouteIds(!!state.includeHidden);
    var sum = S.stopSummary(_feed, date, id, { routeIds: routeIds, dayParts: dayParts() });
    var summary = el("div", "gtfs-dt-summary");
    summary.appendChild(el("div", "", describeDate(date).split(" · ")[0]));
    if (!sum.departures) {
      summary.appendChild(el("div", "", "No departures on this day."));
    } else {
      summary.appendChild(el("div", "", sum.departures + " departure" + (sum.departures === 1 ? "" : "s") +
        " · first " + clockText(sum.span.first) + " · last " + clockText(sum.span.last)));
      summary.appendChild(el("div", "", everyLine(sum)));
      summary.appendChild(partsTable(sum.parts, "Departures"));
      var chips = el("div", "gtfs-dt-chips");
      sum.routes.forEach(function (r) {
        chips.appendChild(el("span", "gtfs-dt-chip", routeName(r.routeId) + " · " + r.departures));
      });
      summary.appendChild(chips);
    }
    box.appendChild(summary);

    var items = [];
    S.stopDepartures(_feed, date, id, { routeIds: routeIds }).forEach(function (r) {
      var t = mode === "dep" ? (!r.last && r.dep >= 0 ? r.dep : -1) : r.arr;
      if (t >= 0) items.push({ t: t, route: routeName(r.routeId), row: r });
    });
    items.sort(function (a, b) {
      var c = sort === "route" ? naturalCompare(a.route, b.route) : 0;
      return c || a.t - b.t || (a.row.tripId < b.row.tripId ? -1 : a.row.tripId > b.row.tripId ? 1 : 0);
    });
    if (items.length) {
      var tbl = textTable("gtfs-dt-trips", ["Time", "Route", "To"], []);
      var shown = state.showAll ? items : items.slice(0, TRIP_ROW_LIMIT);
      shown.forEach(function (it) {
        var to = it.row.headsign;
        if (!to) {
          var sts = S.tripStopTimes(_feed, it.row.tripId);
          to = sts.length ? stopName(sts[sts.length - 1].stopId) : "—";
        }
        tbl.addRow([clockText(it.t), it.route, to], it.row.tripId);
      });
      box.appendChild(tbl);
      if (shown.length < items.length) {
        var more = el("button", "rf-btn-sm", "Show all " + items.length);
        more.type = "button";
        more.addEventListener("click", function () { state.showAll = true; refresh(); });
        box.appendChild(more);
      }
    } else if (mode === "arr") {
      emptyNote(box, "No arrivals on this day.");
    }
    emptyNote(box, "Times are from the timetable for the day to analyze. Change the day in GTFS Feed Attributes.");
  }

  function renderStopSpacing(box, id) {
    var date = App.gtfsAnalysisDate.get();
    if (!_feed || !date) { emptyNote(box, "Load a GTFS feed with stop_times.txt to see spacing."); return; }
    var rows = window.GtfsSchedule.stopSpacing(_feed, date, id, { routeIds: scheduleRouteIds(false) });
    if (!rows.length) { emptyNote(box, "No route stops here on this day."); return; }
    var tbl = textTable("", ["Route", "Direction", "Previous stop", "Next stop"], []);
    function side(stopId, m) { return stopId ? stopName(stopId) + " · " + distanceText(m) : "—"; }
    rows.forEach(function (r) {
      tbl.addRow([routeName(r.routeId), dirText(r.directionId), side(r.prevStopId, r.prevMeters), side(r.nextStopId, r.nextMeters)]);
    });
    box.appendChild(tbl);
    emptyNote(box, "Straight-line distance to the neighbouring stops on each route's most common pattern.");
  }

  // Walk distance the coverage analyses use around a stop, by mode.
  var COVERAGE_MILES = { bus: 0.25, rail: 0.5 };
  var FREQUENT_PEAK_SEC = 15 * 60;

  function milesText(mi) { return mi === 0.25 ? "¼ mi" : mi === 0.5 ? "½ mi" : mi + " mi"; }

  // Residents within radiusMi of a point, from 2020 census blocks (POP100 at each block's internal
  // point). Block groups around the circle only name which blocks to download; the distance test decides.
  async function countResidents(lat, lon, radiusMi) {
    var circle = turf.circle([lon, lat], radiusMi, { steps: 64, units: "miles" });
    var geos = await App.fetchTigerwebGeos("bg", circle);
    var blocks = await App.fetchBlockPopulations(geos);
    var total = 0;
    blocks.forEach(function (b) {
      if (window.ServiceEquity.distanceMi(lat, lon, b.lat, b.lon) <= radiusMi) total += b.pop;
    });
    return total;
  }

  function renderStopCoverage(box, id, state, refresh) {
    var S = window.GtfsSchedule, date = App.gtfsAnalysisDate.get();
    if (!_feed || !date) { emptyNote(box, "Load a GTFS feed with stop_times.txt to see coverage."); return; }
    var routeIds = scheduleRouteIds(false), parts = dayParts();
    // A station has no departures of its own (its platforms do), so the summary supplies the routes
    // and the table row supplies the same trips and headway as the Trips tab.
    var sum = S.stopSummary(_feed, date, id, { routeIds: routeIds, dayParts: parts });
    var rows = S.stopServiceTable(_feed, date, { routeIds: routeIds, dayParts: parts, stopIds: [id] });
    var row = rows.length ? rows[0] : null;
    var rail = sum.routes.some(function (r) {
      var rr = routeRow(r.routeId);
      return window.AnalysisNetwork.modeOf(rr ? rr.route_type : "") === "rail";
    });
    var radius = rail ? COVERAGE_MILES.rail : COVERAGE_MILES.bus;
    var peak = row && typeof row.peakHeadwaySec === "number" ? row.peakHeadwaySec : null;

    var tbl = el("table", "gtfs-fields");
    var body = el("tbody");
    function add(k, v) {
      var tr = el("tr");
      tr.appendChild(el("th", "", k));
      tr.appendChild(el("td", "", v));
      body.appendChild(tr);
    }
    add("Mode", rail ? "Rail" : "Bus");
    add("Walk distance", milesText(radius));
    add("Trips on this day", String(row ? row.trips : 0));
    add("Peak headway", peak === null ? "—" : minutesText(peak));
    add("Frequent (peak headway ≤ 15 min)", peak !== null && peak <= FREQUENT_PEAK_SEC ? "Yes" : "No");
    tbl.appendChild(body);
    box.appendChild(tbl);

    // The count belongs to one radius; a date change that flips the mode makes it stale, so it is dropped.
    var cov = state.coverage;
    if (cov && cov.radiusMi !== radius) cov = state.coverage = null;
    var busy = !!cov && cov.status === "busy";
    var btn = el("button", "rf-btn-sm", "Count residents");
    btn.type = "button";
    btn.disabled = busy;
    btn.addEventListener("click", function () {
      var s = _feed && _feed._stops[id];
      if (!s || typeof s.lat !== "number" || typeof s.lon !== "number") {
        state.coverage = { radiusMi: radius, status: "error", text: "This stop has no coordinates." };
        refresh();
        return;
      }
      var mine = state.coverage = { radiusMi: radius, status: "busy" };
      refresh();
      countResidents(s.lat, s.lon, radius).then(function (n) {
        if (state.coverage !== mine) return;
        state.coverage = { radiusMi: radius, status: "done", count: n };
      }, function (err) {
        if (state.coverage !== mine) return;
        state.coverage = { radiusMi: radius, status: "error", text: (err && err.message) || "Census download failed." };
      }).then(refresh);
    });
    box.appendChild(btn);

    var out = el("div", "gtfs-dt-summary");
    out.setAttribute("data-coverage-result", cov ? cov.status : "idle");
    if (cov && cov.status === "busy") out.textContent = "Counting…";
    else if (cov && cov.status === "done") {
      out.textContent = "About " + cov.count.toLocaleString("en-US") + " residents live within " +
        milesText(radius) + " (2020 census blocks).";
    } else if (cov && cov.status === "error") out.textContent = "Could not count residents: " + cov.text;
    box.appendChild(out);
    emptyNote(box, "Rail stops use a ½ mi walk and bus stops ¼ mi. Counting downloads census blocks from the Census Bureau only when you press the button.");
  }

  // The route's timetable for the day to analyze, or null after writing the reason into box.
  function routeTimetable(box, routeKey) {
    var r = findIndexRoute(routeKey), date = App.gtfsAnalysisDate.get();
    if (!_feed || !date || !r || !r.route_id) { emptyNote(box, "No timetable for these shapes."); return null; }
    var sched = window.GtfsSchedule.routeSchedule(_feed, date, r.route_id, { dayParts: dayParts() });
    if (!sched.trips) { emptyNote(box, "This route does not run on this day."); return null; }
    return { route: r, date: date, sched: sched };
  }

  function directionHeading(d) {
    var hs = d.patterns.length ? d.patterns[0].headsign : "";
    return el("h4", "gtfs-dt-head", dirText(d.directionId) + (hs ? " · to " + hs : "") +
      " (" + d.trips + " trip" + (d.trips === 1 ? "" : "s") + ")");
  }

  function renderRouteStops(box, routeKey) {
    var tt = routeTimetable(box, routeKey);
    if (!tt) return;
    tt.sched.directions.forEach(function (d) {
      box.appendChild(directionHeading(d));
      var ol = el("ol", "gtfs-dt-stops");
      (d.patterns.length ? d.patterns[0].stops : []).forEach(function (sid) {
        var li = el("li");
        var b = el("button", "gtfs-dt-link", stopName(sid));
        b.type = "button";
        b.addEventListener("click", function () { App.gtfsOpenDetails({ kind: "stop", stopId: sid }); });
        li.appendChild(b);
        li.appendChild(el("span", "gtfs-dt-id", " " + sid));
        ol.appendChild(li);
      });
      box.appendChild(ol);
      if (d.patterns.length > 1) emptyNote(box, "Showing the most common of " + d.patterns.length + " stop patterns.");
    });
  }

  function renderRouteSchedule(box, routeKey) {
    var tt = routeTimetable(box, routeKey);
    if (!tt) return;
    var S = window.GtfsSchedule;
    box.appendChild(el("div", "gtfs-dt-summary", describeDate(tt.date).split(" · ")[0]));
    tt.sched.directions.forEach(function (d) {
      box.appendChild(directionHeading(d));
      var sum = el("div", "gtfs-dt-summary");
      sum.appendChild(el("div", "", d.trips + " trip" + (d.trips === 1 ? "" : "s") +
        (d.span ? " · first " + clockText(d.span.first) + " · last " + clockText(d.span.last) : "") +
        " · " + (d.runningSec / 3600).toFixed(1) + " running hours"));
      sum.appendChild(el("div", "", everyLine(d)));
      sum.appendChild(partsTable(d.parts, "Trips"));
      box.appendChild(sum);
      var pt = textTable("", ["Trips", "Stops", "To"], [0, 1]);
      d.patterns.forEach(function (p) {
        var to = p.headsign || (p.stops.length ? stopName(p.stops[p.stops.length - 1]) : "—");
        pt.addRow([String(p.trips), String(p.stops.length), to]);
      });
      box.appendChild(pt);
    });
    box.appendChild(el("h4", "gtfs-dt-head", "By day type"));
    var reps = representativeDates();
    var dt = textTable("", ["Day", "Date", "Trips"], [2]);
    [["weekday", "Weekday"], ["saturday", "Saturday"], ["sunday", "Sunday"]].forEach(function (t) {
      var date = reps[t[0]];
      var n = date ? S.tripsOnDate(_feed, date, { routeIds: [tt.route.route_id] }).trips.length : 0;
      dt.addRow([t[1], date ? isoOf(date) : "—", String(n)]);
    });
    box.appendChild(dt);
    emptyNote(box, "Headways are the median gap between departures in each part of the day. Edit the parts of the day in GTFS Feed Attributes.");
  }

  _stopTabs.push(
    { id: "trips", label: "Trips", render: renderStopTrips },
    { id: "spacing", label: "Spacing", render: renderStopSpacing },
    { id: "coverage", label: "Coverage", render: renderStopCoverage }
  );
  _routeTabs.push(
    { id: "stops", label: "Stops", render: renderRouteStops },
    { id: "schedule", label: "Schedule", render: renderRouteSchedule }
  );

  // A tab from another module on the route details view. Its render gets the schedule route_id (not the
  // route browser key) and redraws instantly like the built-in tabs.
  App.gtfsAddRouteTab = function (tab) {
    if (!tab || !tab.id || typeof tab.render !== "function") return;
    _routeTabs.push({ id: tab.id, label: tab.label || tab.id, render: function (el, id, state, refresh) {
      tab.render(el, scheduleRouteId(id), state, refresh);
    } });
    refreshDetails();
  };
  // Stop-view twin of gtfsAddRouteTab: render(el, stopId, state, refresh) with the schedule stop_id.
  App.gtfsAddStopTab = function (tab) {
    if (!tab || !tab.id || typeof tab.render !== "function") return;
    _stopTabs.push({ id: tab.id, label: tab.label || tab.id, render: function (el, id, state, refresh) {
      tab.render(el, id, state, refresh);
    } });
    refreshDetails();
  };
  App.gtfsRefreshDetails = function () { refreshDetails(); };

  // ---- Feed attributes panel: Overview tab ----

  var _popupTab = "overview";

  // Panel tab switch, kept in the closure across opens.
  function switchTab(id) {
    if (id) _popupTab = id;
    Array.prototype.forEach.call(document.querySelectorAll(".gtfs-ptab"), function (b) {
      var on = b.getAttribute("data-tab") === _popupTab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".gtfs-ptab-pane"), function (p) {
      p.hidden = p.getAttribute("data-tab") !== _popupTab;
    });
  }

  function wireOverview() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".gtfs-ptab"));
    tabs.forEach(function (b, i) {
      b.addEventListener("click", function () { switchTab(b.getAttribute("data-tab")); });
      b.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var other = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        switchTab(other.getAttribute("data-tab"));
        other.focus();
      });
    });
    switchTab();
    var reset = document.getElementById("gtfsDayPartsReset");
    if (reset) reset.addEventListener("click", function () {
      var msg = document.getElementById("gtfsDayPartsMsg");
      if (msg) msg.textContent = "";
      App.gtfsDayParts.reset();
    });
  }

  function localToday() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  function renderDayPartRows() {
    var box = document.getElementById("gtfsDayPartsRows");
    if (!box) return;
    // Mid-edit redraws (after a valid change) must not replace the input being typed in.
    var cur = App.gtfsDayParts.get(), inputs = box.querySelectorAll(".gtfs-dp-input");
    var same = inputs.length === cur.length && cur.every(function (p, i) { return inputs[i].value === p.start; });
    var note = box.querySelector(".gtfs-dp-note");
    if (same && box.contains(document.activeElement)) {
      if (note) note.hidden = App.gtfsDayParts.isDefault();
      return;
    }
    box.textContent = "";
    App.gtfsDayParts.get().forEach(function (p, i) {
      var row = el("div", "gtfs-dp-row");
      var lab = el("label", "gtfs-dp-label", p.label);
      var inp = el("input", "rf-select gtfs-dp-input");
      inp.type = "time";
      inp.step = "300";
      inp.value = p.start;
      inp.id = "gtfsDayPart" + i;
      lab.htmlFor = inp.id;
      if (i === 0) inp.disabled = true;
      inp.addEventListener("change", onDayPartChange);
      row.appendChild(lab);
      row.appendChild(inp);
      box.appendChild(row);
    });
    var n = el("div", "gtfs-date-desc gtfs-dp-note", "Copied Services and every headway report use these parts.");
    n.hidden = App.gtfsDayParts.isDefault();
    box.appendChild(n);
  }

  function onDayPartChange() {
    var msg = document.getElementById("gtfsDayPartsMsg");
    var values = Array.prototype.map.call(document.querySelectorAll("#gtfsDayPartsRows .gtfs-dp-input"), function (i) { return i.value; });
    if (App.gtfsDayParts.set(values)) {
      if (msg) msg.textContent = "";
    } else {
      if (msg) msg.textContent = "Each part must start after the one before. Times are 24-hour.";
      renderDayPartRows();
    }
  }

  function renderOverview() {
    if (typeof document === "undefined") return;
    var body = document.getElementById("gtfsOverviewBody");
    if (!body) return;
    var empty = document.getElementById("gtfsOverviewEmpty");
    var parts = document.getElementById("gtfsDayParts");
    body.textContent = "";
    if (!_feed) {
      if (empty) empty.style.display = "";
      if (parts) parts.style.display = "none";
      renderDateControls();
      return;
    }
    if (empty) empty.style.display = "none";
    if (parts) parts.style.display = "";

    var ov = window.GtfsSchedule.feedOverview(_feed, { today: localToday(), dates: representativeDates() });
    body.appendChild(el("div", "gtfs-ov-agency", ov.agencies.map(function (a) { return a.name; }).filter(Boolean).join(", ")));
    if (ov.range) {
      var line = el("div", "gtfs-ov-range", "Service " + isoOf(ov.range.start) + " to " + isoOf(ov.range.end) + " ");
      if (ov.daysLeft != null) {
        var n = Math.abs(ov.daysLeft);
        var txt = ov.daysLeft < 0 ? "expired " + n + " day" + (n === 1 ? "" : "s") + " ago"
          : ov.daysLeft === 0 ? "expires today" : "expires in " + n + " day" + (n === 1 ? "" : "s");
        line.appendChild(el("span", "gtfs-ov-expiry" + (ov.daysLeft < 0 ? " gtfs-ov-bad" : ov.daysLeft < 30 ? " gtfs-ov-warn" : ""), txt));
      }
      body.appendChild(line);
    }
    var grid = el("div", "gtfs-ov-stats");
    [["Routes", ov.routes], ["Stops", ov.stops], ["Stations", ov.stations], ["Trips", ov.trips]].forEach(function (s) {
      var c = el("div", "gtfs-ov-stat");
      c.appendChild(el("div", "gtfs-ov-num", s[1].toLocaleString()));
      c.appendChild(el("div", "gtfs-ov-label", s[0]));
      grid.appendChild(c);
    });
    body.appendChild(grid);
    var labels = { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday" };
    var tbl = textTable("", ["Day", "Date", "Trips"], [2]);
    ov.dayTypes.forEach(function (t) { tbl.addRow([labels[t.type] || t.type, isoOf(t.date), t.trips.toLocaleString()]); });
    body.appendChild(tbl);

    renderDayPartRows();
    renderDateControls();
  }

  // ---- Copy a route as a Service with its timetable ----

  var _repDatesCache = null;   // { feed, date, value }: busiestDate walks a whole year, so keep the answer

  // One date per day type: the analysis date when it is an ordinary day of that type, else the busiest
  // such date in the feed. Null for a type the feed never runs.
  function representativeDates() {
    if (!_feed) return { weekday: null, saturday: null, sunday: null };
    if (_repDatesCache && _repDatesCache.feed === _feed && _repDatesCache.date === _analysisDate) {
      return _repDatesCache.value;
    }
    var S = window.GtfsSchedule, info = _analysisDate ? S.dayType(_feed, _analysisDate) : null, out = {};
    ["weekday", "saturday", "sunday"].forEach(function (type) {
      out[type] = (info && info.dayType === type && !info.exception) ? _analysisDate : S.busiestDate(_feed, type);
    });
    _repDatesCache = { feed: _feed, date: _analysisDate, value: out };
    return out;
  }

  App.gtfsRepresentativeDates = function () { return representativeDates(); };
  App.gtfsScopeRouteIds = function (includeHidden) { return scheduleRouteIds(includeHidden); };
  App.gtfsOnInputsChange = function (fn) {
    if (typeof fn !== "function") return function () {};
    _inputListeners.push(fn);
    return function () { var i = _inputListeners.indexOf(fn); if (i >= 0) _inputListeners.splice(i, 1); };
  };

  function scheduleRouteId(routeKey) {
    var r = findIndexRoute(routeKey);
    return r ? r.route_id : String(routeKey == null ? "" : routeKey);
  }

  // True when the loaded feed has timetable trips for this route on a representative date; without it
  // a service copy keeps the plain geometry-only behaviour.
  App.gtfsHasSchedule = function (routeKey) {
    if (!_feed) return false;
    var id = scheduleRouteId(routeKey);
    if (!id) return false;
    var S = window.GtfsSchedule, dates = representativeDates();
    return ["weekday", "saturday", "sunday"].some(function (type) {
      return !!dates[type] && S.tripsOnDate(_feed, dates[type], { routeIds: [id] }).trips.length > 0;
    });
  };

  function metersBetween(lon1, lat1, lon2, lat2) {
    var rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  var _stopRowsFeed = null, _stopRowsById = null;
  function stopRow(stopId) {
    if (_stopRowsFeed !== _feed) {
      _stopRowsFeed = _feed;
      _stopRowsById = Object.create(null);
      var t = _feed && _feed.tables && _feed.tables["stops.txt"];
      ((t && t.rows) || []).forEach(function (r) {
        var id = typeof r.stop_id === "string" ? r.stop_id.trim() : "";
        if (id && !_stopRowsById[id]) _stopRowsById[id] = r;
      });
    }
    return _stopRowsById[stopId] || null;
  }

  // Direction for a copied shape: from direction_id when the plan has several shapes; a single shape has
  // no opposite to pair with, so it is a Loop when it ends where it starts, else Both.
  function copiedDirection(planShape, onlyOne, shapeCoords) {
    if (onlyOne) {
      var a = shapeCoords[0], b = shapeCoords[shapeCoords.length - 1];
      return metersBetween(a[0], a[1], b[0], b[1]) <= 100 ? "Loop" : "Both";
    }
    return planShape.directionId === "0" ? "Outbound" : planShape.directionId === "1" ? "Inbound" : "";
  }

  // Route Costing defaults to its speed mode, which ignores Run time; a speed of
  // shape length / run time gives the same one-way time in either mode, so the
  // copy costs without manual setup.
  function impliedSpeed(coords, runTime) {
    if (!(runTime > 0) || typeof turf === "undefined") return undefined;
    var mi;
    try { mi = turf.length(turf.lineString(coords), { units: "miles" }); } catch (e) { return undefined; }
    var mph = Math.round(mi / (runTime / 60) * 10) / 10;
    return mph > 0 ? mph : undefined;
  }

  function copyServiceWithSchedule(opts) {
    var S = window.GtfsSchedule;
    var route = findIndexRoute(opts.routeId);
    var routeId = scheduleRouteId(opts.routeId);
    var displayName = route ? routeDisplayName(route) : routeId;
    var plan = S.serviceCopyPlan(_feed, { routeId: routeId, dates: representativeDates(), dayParts: dayParts() });

    var usable = [], missing = [];
    plan.shapes.forEach(function (ps) { (shapeFeature(ps.shapeId) ? usable : missing).push(ps); });

    var created = [];
    created.stops = { created: 0, reused: 0, skipped: 0 };
    if (usable.length === 0) {
      created.note = (S.reconciliationNote(plan, displayName) + "\n" +
        "Nothing was copied: no trip on the sampled days uses a shape that is on the map.").replace(/^\n/, "");
      return created;
    }

    var existing = [];
    (App.routes || []).concat(App.lines || []).forEach(function (f) {
      var a = f && f.properties && f.properties.attributes;
      if (a && a.serviceId) existing.push(a.serviceId);
    });
    var serviceId = uniqueServiceId(displayName, existing);
    var multi = usable.length > 1;
    var lineByShape = {};

    function copyAll() {
      usable.forEach(function (ps) {
        var f = shapeFeature(ps.shapeId);
        var idx = copyShapeToLine(f.properties, {
          multi: multi, group: displayName, serviceId: serviceId,
          direction: copiedDirection(ps, !multi, f.geometry.coordinates),
          service: ps.service, runTime: ps.runTime === null ? undefined : ps.runTime,
          avgSpeed: impliedSpeed(f.geometry.coordinates, ps.runTime)
        });
        if (idx < 0) return;
        created.push(idx);
        lineByShape[ps.shapeId] = idx;
      });
      if (opts.stops !== false && created.length) copyServiceStops(usable, lineByShape, displayName, created.stops);
    }
    if (App.undo && typeof App.undo.batch === "function") App.undo.batch(copyAll); else copyAll();

    // Trips on shapes that are not drawn were never copied, so the trip check would say nothing true.
    var notePlan = plan;
    if (missing.length) notePlan = Object.assign({}, plan, { shapes: usable, reconciliation: [] });
    var lines = [S.reconciliationNote(notePlan, displayName)];
    if (missing.length) {
      lines.push("Not copied, shape is not on the map: " + missing.map(function (m) { return m.shapeId; }).join(", ") +
        ". The trip check was skipped.");
    }
    if (opts.stops !== false) {
      var st = created.stops;
      lines.push(st.created + " stops copied, " + st.reused + " already on the map" +
        (st.skipped ? ", " + st.skipped + " skipped (no coordinates)" : "") + ".");
    }
    created.note = lines.join("\n");
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    return created;
  }

  // Points for the stops the copied shapes serve. A stop already on the map (same stopId, within 2 m)
  // is reused and only gains the new lines in its associatedRoutes.
  function copyServiceStops(planShapes, lineByShape, displayName, tally) {
    var order = [], serving = Object.create(null);
    planShapes.forEach(function (ps) {
      if (lineByShape[ps.shapeId] === undefined) return;
      ps.stops.forEach(function (sid) {
        if (!serving[sid]) { serving[sid] = []; order.push(sid); }
        if (serving[sid].indexOf(ps.shapeId) < 0) serving[sid].push(ps.shapeId);
      });
    });
    order.forEach(function (sid) {
      var rec = _feed._stops[sid];
      if (!rec || typeof rec.lat !== "number" || typeof rec.lon !== "number") { tally.skipped++; return; }
      var links = serving[sid].map(function (shapeId) {
        var line = App.lines[lineByShape[shapeId]];
        return { featureType: "line", featureId: line.properties.lineIdx, name: line.properties.name };
      });
      var found = null;
      (App.points || []).some(function (p) {
        var a = p.properties && p.properties.attributes;
        if (!a || a.stopId !== sid) return false;
        var c = p.geometry.coordinates;
        if (metersBetween(c[0], c[1], rec.lon, rec.lat) > 2) return false;
        found = p;
        return true;
      });
      if (found) {
        var a = found.properties.attributes;
        var list = Array.isArray(a.associatedRoutes) ? a.associatedRoutes.slice() : [];
        links.forEach(function (l) {
          var dup = list.some(function (r) { return r.featureType === l.featureType && r.featureId === l.featureId; });
          if (!dup) list.push(l);
        });
        a.associatedRoutes = list;
        tally.reused++;
        return;
      }
      var row = stopRow(sid), nm = row && typeof row.stop_name === "string" ? row.stop_name.trim() : "";
      App.addPointWithOpts(rec.lon, rec.lat, {
        name: nm || sid,
        attributes: { stopId: sid, group: displayName + " stops", associatedRoutes: links }
      });
      tally.created++;
    });
    if (tally.reused && typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  // opts = { routeId, mode: "representative"|"each"|"shape"|"service", shapeId }.
  // "service" copies every shape like "each" and also groups them as ONE
  // transit Service: shared attributes.serviceId (route name, made unique)
  // and a per-shape direction from GTFS direction_id when unambiguous.
  // Returns the array indices (into App.lines) of the created lines.
  App.gtfsCopy = function (opts) {
    opts = opts || {};
    if (opts.mode === "service" && opts.routeId != null && App.gtfsHasSchedule(opts.routeId)) {
      return copyServiceWithSchedule(opts);
    }
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
        if (_analysisDate) out.analysisDate = _analysisDate;
        if (_dayParts) out.dayParts = _dayParts.map(function (p) { return p.start; });
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
        // Queued even when a feed is loaded: a session file's own feed usually
        // replaces it right after, and initAnalysisDate reads the queue.
        if (data && typeof data.analysisDate === "string" && /^\d{8}$/.test(data.analysisDate)) {
          _pendingDate = data.analysisDate;
          if (_feed) setAnalysisDate(data.analysisDate);
        }
        // A session without the key uses the standard parts; a bad list is ignored.
        _dayParts = data && data.dayParts ? partsFromStarts(data.dayParts) : null;
        if (_dayParts && isDefaultParts(_dayParts)) _dayParts = null;
        afterDetailsInputChange();
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
