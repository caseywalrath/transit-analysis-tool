// js/core/routes.js
// Route drawing: waypoint-based lines snapped to the street network via OSRM.
// Depends on: App.map (map.js), turf.
// Exports: routes, routeBuffers, handleRouteClick, setRoutePreview,
//          rebuildRouteBuffers, routeBufferUnionPolygon,
//          removeRoute, clearRoutes, undoLastRoute, cancelRouteDrawing,
//          renderRouteLayers, updateRouteWaypoint

(function () {
  var App = window.App = window.App || {};

  var OSRM_URLS = [
    "https://router.project-osrm.org/route/v1/driving/",
    "https://routing.openstreetmap.de/routed-car/route/v1/driving/"
  ];
  var OSRM_TIMEOUT_MS = 5000;
  var ROUTE_COLOR = "#319795"; // teal
  var SNAP_PIXELS = 15;

  var routes = [];
  var routeBuffers = [];
  var routeBufferRadiusMiles = 0.5;

  // Current drawing state
  var currentWaypoints = [];     // user click points (committed)
  var currentRouteCoords = [];   // resolved street geometry from OSRM (flattened)
  var previewCoord = null;       // cursor [lng, lat] for straight-line preview

  // Debounced snapped preview state
  var previewSnappedCoords = null; // routed coords from last waypoint to cursor (null = use straight line)
  var _previewTimer = null;        // setTimeout handle
  var _previewController = null;   // AbortController for in-flight preview fetch
  var _previewGen = 0;             // discard stale preview results

  // Generation counter to discard stale async fetch results
  var _fetchGen = 0;

  /* ---- OSRM fetch with cascading fallback ---- */

  // Try a single OSRM server with a timeout
  async function fetchRouteSingle(waypoints, serverUrl) {
    var coords = waypoints.map(function (wp) { return wp[0] + "," + wp[1]; }).join(";");
    var url = serverUrl + coords + "?overview=full&geometries=geojson";
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, OSRM_TIMEOUT_MS);
    try {
      var res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error("OSRM HTTP " + res.status);
      var data = await res.json();
      if (data.code !== "Ok" || !data.routes || data.routes.length === 0) return null;
      return data.routes[0].geometry.coordinates;
    } catch (e) {
      clearTimeout(timer);
      throw e; // let caller try next server
    }
  }

  // Main route fetch: local routing first, then cascade through OSRM servers
  async function fetchRoute(waypoints) {
    if (waypoints.length < 2) return null;

    // Priority 1: local road network
    if (typeof App.findLocalRoute === "function" && App.roadNetworkLoaded && App.roadNetworkLoaded()) {
      var local = App.findLocalRoute(waypoints);
      if (local) return local;
      // Fall through to servers if local routing failed (e.g. outside coverage)
    }

    // Priority 2: cascade through OSRM servers
    for (var i = 0; i < OSRM_URLS.length; i++) {
      try {
        var result = await fetchRouteSingle(waypoints, OSRM_URLS[i]);
        if (result) return result;
      } catch (e) {
        console.warn("OSRM server " + (i + 1) + " failed:", e.message || e);
        // Continue to next server
      }
    }

    // Priority 3: all failed
    App.setStatus("Server routing unavailable \u2014 using straight line");
    return null;
  }

  /* ---- Buffer functions ---- */

  function rebuildRouteBuffers(radiusMiles) {
    if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
    routeBufferRadiusMiles = radiusMiles;
    routeBuffers.length = 0;
    routeBuffers.length = routes.length;
    for (var i = 0; i < routes.length; i++) {
      if (routes[i].properties.hidden) continue;
      var r = (routes[i].properties._bufferRadius != null)
        ? routes[i].properties._bufferRadius
        : radiusMiles;
      if (r > 0) {
        var buf = turf.buffer(routes[i], r, { units: "miles", steps: 64 });
        routeBuffers[i] = { type: buf.type, geometry: buf.geometry, properties: { routeIdx: routes[i].properties.routeIdx, resolvedColor: App.resolveFeatureColor("route", routes[i]) } };
      }
    }
    renderRouteLayers();
  }

  function routeBufferUnionPolygon() {
    var u = null;
    for (var i = 0; i < routeBuffers.length; i++) {
      if (!routeBuffers[i]) continue;
      if (!u) { u = routeBuffers[i]; continue; }
      try { u = turf.union(u, routeBuffers[i]); } catch (e) { /* skip invalid */ }
    }
    return u;
  }

  function routeBuffersGeoJSON() {
    return { type: "FeatureCollection", features: routeBuffers.filter(Boolean) };
  }

  /* ---- GeoJSON helpers ---- */

  function routesGeoJSON() {
    return {
      type: "FeatureCollection",
      features: routes.filter(function (r) { return !r.properties.hidden; }).map(function (r) {
        var props = {};
        for (var k in r.properties) { if (Object.prototype.hasOwnProperty.call(r.properties, k)) props[k] = r.properties[k]; }
        props.resolvedColor = App.resolveFeatureColor("route", r);
        return { type: "Feature", properties: props, geometry: r.geometry };
      })
    };
  }

  // In-progress drawing: resolved route coords + preview segment to cursor.
  // If previewSnappedCoords is available (debounced fetch returned), that snapped
  // segment is shown. Otherwise falls back to a straight dashed line to the cursor.
  function currentDrawingGeoJSON() {
    var coords = currentRouteCoords.slice();

    if (previewCoord && currentWaypoints.length >= 1) {
      if (coords.length < 2) {
        // Only 1 waypoint so far — show snapped or straight line from it to cursor
        if (previewSnappedCoords && previewSnappedCoords.length >= 2) {
          coords = previewSnappedCoords;
        } else {
          coords = [currentWaypoints[currentWaypoints.length - 1], previewCoord];
        }
      } else {
        // Extend resolved route with snapped or straight preview segment.
        // Skip the first point of the snapped segment to avoid duplicating the junction.
        if (previewSnappedCoords && previewSnappedCoords.length >= 2) {
          coords = coords.concat(previewSnappedCoords.slice(1));
        } else {
          coords = coords.concat([previewCoord]);
        }
      }
    }

    if (coords.length < 2) {
      return { type: "FeatureCollection", features: [] };
    }
    return {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords }
      }]
    };
  }

  function currentWaypointsGeoJSON() {
    return {
      type: "FeatureCollection",
      features: currentWaypoints.map(function (c, i) {
        return {
          type: "Feature",
          properties: { idx: i + 1 },
          geometry: { type: "Point", coordinates: c }
        };
      })
    };
  }

  // Saved-route waypoints (small dots on the map).
  function savedWaypointsGeoJSON() {
    var features = [];
    var sel = App._selected;
    routes.forEach(function (route, arrayIndex) {
      if (route.properties.hidden) return;
      if (!sel || sel.type !== "route" || sel.index !== arrayIndex) return;
      var routeResolvedColor = App.resolveFeatureColor("route", route);
      (route.properties.waypoints || []).forEach(function (wp, i) {
        features.push({
          type: "Feature",
          properties: { routeIdx: route.properties.routeIdx, waypointIdx: i + 1, resolvedColor: routeResolvedColor },
          geometry: { type: "Point", coordinates: wp }
        });
      });
    });
    return { type: "FeatureCollection", features: features };
  }

  /* ---- Map layer rendering ---- */

  function renderRouteLayers() {
    var map = App.map;

    // Route buffers (teal fill, rendered below the route line)
    if (!map.getSource("route-buffers")) {
      map.addSource("route-buffers", { type: "geojson", data: routeBuffersGeoJSON() });
      map.addLayer({
        id: "route-buffers-fill",
        type: "fill",
        source: "route-buffers",
        paint: { "fill-color": ["get", "resolvedColor"], "fill-opacity": 0.08 }
      });
      map.addLayer({
        id: "route-buffers-line",
        type: "line",
        source: "route-buffers",
        paint: { "line-color": ["get", "resolvedColor"], "line-width": 2, "line-opacity": 0.4 }
      });
    } else {
      map.getSource("route-buffers").setData(routeBuffersGeoJSON());
    }

    // Saved routes (solid teal line)
    if (!map.getSource("routes")) {
      map.addSource("routes", { type: "geojson", data: routesGeoJSON() });
      map.addLayer({
        id: "routes-layer",
        type: "line",
        source: "routes",
        paint: { "line-color": ["get", "resolvedColor"], "line-width": 3, "line-opacity": 0.8, "line-offset": ["coalesce", ["get", "_offset"], 0] }
      });
    } else {
      map.getSource("routes").setData(routesGeoJSON());
    }

    // Saved route waypoints (small dots)
    if (!map.getSource("routes-waypoints-saved")) {
      map.addSource("routes-waypoints-saved", { type: "geojson", data: savedWaypointsGeoJSON() });
      map.addLayer({
        id: "routes-waypoints-saved-layer",
        type: "circle",
        source: "routes-waypoints-saved",
        paint: {
          "circle-radius": 3,
          "circle-color": ["get", "resolvedColor"],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource("routes-waypoints-saved").setData(savedWaypointsGeoJSON());
    }

    // In-progress route (dashed)
    if (!map.getSource("routes-drawing")) {
      map.addSource("routes-drawing", { type: "geojson", data: currentDrawingGeoJSON() });
      map.addLayer({
        id: "routes-drawing-layer",
        type: "line",
        source: "routes-drawing",
        paint: {
          "line-color": ROUTE_COLOR,
          "line-width": 2,
          "line-opacity": 0.7,
          "line-dasharray": [3, 2]
        }
      });
    } else {
      map.getSource("routes-drawing").setData(currentDrawingGeoJSON());
    }

    // In-progress waypoints (clickable-sized dots)
    if (!map.getSource("routes-waypoints")) {
      map.addSource("routes-waypoints", { type: "geojson", data: currentWaypointsGeoJSON() });
      map.addLayer({
        id: "routes-waypoints-layer",
        type: "circle",
        source: "routes-waypoints",
        paint: {
          "circle-radius": 6,
          "circle-color": ROUTE_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource("routes-waypoints").setData(currentWaypointsGeoJSON());
    }

    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();

    // Auto-recompute overlap offsets if toggle is on
    var oCb = document.getElementById("offsetOverlap");
    if (oCb && oCb.checked && typeof App.computeOverlapOffsets === "function") {
      App.computeOverlapOffsets();
    }
  }

  /* ---- Preview state cleanup ---- */

  function clearPreviewState() {
    clearTimeout(_previewTimer);
    _previewTimer = null;
    if (_previewController) {
      _previewController.abort();
      _previewController = null;
    }
    previewSnappedCoords = null;
    previewCoord = null;
  }

  /* ---- Rubber-band preview with throttled street snapping (1 fetch/sec max) ---- */

  function doPreviewFetch() {
    var from = currentWaypoints[currentWaypoints.length - 1];
    var to = previewCoord;
    if (!from || !to) return;

    // Priority 1: local road network — instant, no server needed
    if (typeof App.findLocalRoute === "function" && App.roadNetworkLoaded && App.roadNetworkLoaded()) {
      var local = App.findLocalRoute([from, to]);
      if (local) {
        previewSnappedCoords = local;
        var drawSrc = App.map.getSource("routes-drawing");
        if (drawSrc) drawSrc.setData(currentDrawingGeoJSON());
        return;
      }
      // Fall through to server if outside local coverage
    }

    // Priority 2: first available OSRM server (don't cascade for preview — too slow)
    if (_previewController) {
      _previewController.abort();
      _previewController = null;
    }

    var gen = ++_previewGen;
    var controller = new AbortController();
    _previewController = controller;

    // Try each server sequentially until one works
    (async function () {
      for (var i = 0; i < OSRM_URLS.length; i++) {
        if (gen !== _previewGen) return; // stale
        var coordStr = from[0] + "," + from[1] + ";" + to[0] + "," + to[1];
        var timer = setTimeout(function () { controller.abort(); }, OSRM_TIMEOUT_MS);
        try {
          var res = await fetch(OSRM_URLS[i] + coordStr + "?overview=full&geometries=geojson", { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error("OSRM HTTP " + res.status);
          var data = await res.json();
          if (gen !== _previewGen) return;
          _previewController = null;
          if (data.code === "Ok" && data.routes && data.routes.length > 0) {
            previewSnappedCoords = data.routes[0].geometry.coordinates;
            var src = App.map.getSource("routes-drawing");
            if (src) src.setData(currentDrawingGeoJSON());
          }
          return; // success — stop trying
        } catch (e) {
          clearTimeout(timer);
          if (e.name === "AbortError") return; // user-initiated cancel
          // Try next server
        }
      }
      _previewController = null;
    })();
  }

  function setRoutePreview(lngLat) {
    previewCoord = lngLat ? [lngLat.lng, lngLat.lat] : null;

    // Don't clear previewSnappedCoords here — let the most recent snapped
    // preview persist on the map until the next throttled fetch replaces it.
    // This avoids the flicker of clearing → straight line → snapped.

    // Update drawing source (uses snapped preview if available, else straight line).
    var src = App.map.getSource("routes-drawing");
    if (src) src.setData(currentDrawingGeoJSON());

    // No waypoints yet, or cursor left the map — clean up fully.
    if (!previewCoord || currentWaypoints.length === 0) {
      previewSnappedCoords = null;
      clearTimeout(_previewTimer);
      _previewTimer = null;
      if (_previewController) {
        _previewController.abort();
        _previewController = null;
      }
      return;
    }

    // Local road network: snap immediately (Dijkstra is fast), no throttle needed
    if (typeof App.roadNetworkLoaded === "function" && App.roadNetworkLoaded()) {
      doPreviewFetch();
      return;
    }

    // Server routing: throttle to 1 fetch/sec max.
    // When it fires it reads the CURRENT previewCoord, not a stale capture.
    if (!_previewTimer) {
      _previewTimer = setTimeout(function () {
        _previewTimer = null;
        doPreviewFetch();
      }, 1000);
    }
  }

  /* ---- Snap-to-close detection ---- */

  function isNearLastWaypoint(lngLat) {
    if (currentWaypoints.length === 0) return false;
    var last = currentWaypoints[currentWaypoints.length - 1];
    var lastPx = App.map.project(last);
    var clickPx = App.map.project([lngLat.lng, lngLat.lat]);
    var dx = lastPx.x - clickPx.x;
    var dy = lastPx.y - clickPx.y;
    return Math.sqrt(dx * dx + dy * dy) < SNAP_PIXELS;
  }

  /* ---- Click handling ---- */

  async function handleRouteClick(lngLat) {
    // Snap-to-close: clicking near last waypoint saves the route
    if (currentWaypoints.length >= 2 && isNearLastWaypoint(lngLat)) {
      await saveRoute();
      return;
    }

    currentWaypoints.push([lngLat.lng, lngLat.lat]);

    // Clear the snapped preview — it referenced the previous last waypoint.
    // A fresh preview will build up on the next mousemove.
    clearPreviewState();

    if (currentWaypoints.length === 1) {
      // First waypoint — nothing to route yet
      renderRouteLayers();
      App.setStatus("Route started \u2014 click to add waypoints, click last point or press Enter to finish");
      return;
    }

    // Fetch route for all current waypoints. Use a generation counter to
    // discard results from fetches that were overtaken by a later click.
    var gen = ++_fetchGen;
    var snapshot = currentWaypoints.slice();

    App.setStatus("Routing\u2026");
    var coords = await fetchRoute(snapshot);

    if (gen !== _fetchGen) return; // stale result, a newer click happened

    currentRouteCoords = coords || snapshot;
    App.setStatus(currentWaypoints.length + " waypoints \u2014 click last point or press Enter to finish");
    renderRouteLayers();
  }

  /* ---- Save route ---- */

  async function saveRoute() {
    if (currentWaypoints.length < 2) {
      cancelRouteDrawing();
      return;
    }

    var coords = currentRouteCoords;
    if (coords.length < 2) {
      // No resolved geometry yet (rapid click) — fetch now
      App.setStatus("Routing\u2026");
      var fetched = await fetchRoute(currentWaypoints);
      coords = fetched || currentWaypoints.slice();
    }

    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var idx = routes.length + 1;
    var feature = {
      type: "Feature",
      properties: {
        name: "Route " + idx,
        routeIdx: idx,
        waypoints: currentWaypoints.slice(),
        color: "",
        colorSeq: App._nextColorSeq()
      },
      geometry: { type: "LineString", coordinates: coords }
    };
    routes.push(feature);

    var nWp = currentWaypoints.length;
    currentWaypoints = [];
    currentRouteCoords = [];
    clearPreviewState();
    rebuildRouteBuffers(routeBufferRadiusMiles);
    App.setStatus("Route " + idx + " saved (" + nWp + " waypoints)");
    if (typeof App.exitDrawMode === "function") App.exitDrawMode();
    // If the attributes popup is already open (on some other feature), follow
    // it to this newly-drawn route. Never auto-open it if it wasn't open.
    if (typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen() &&
        typeof App.openAttrPopup === "function") {
      App.openAttrPopup("route", routes.length - 1, feature);
    }
  }

  /* ---- Cancel / remove / clear / undo ---- */

  function cancelRouteDrawing() {
    if (currentWaypoints.length === 0 && !previewCoord) return;
    currentWaypoints = [];
    currentRouteCoords = [];
    clearPreviewState();
    renderRouteLayers();
  }

  function removeRoute(index) {
    if (index < 0 || index >= routes.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    routes.splice(index, 1);
    rebuildRouteBuffers(routeBufferRadiusMiles);
  }

  function clearRoutes() {
    if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
    routes.length = 0;
    currentWaypoints = [];
    currentRouteCoords = [];
    clearPreviewState();
    routeBuffers.splice(0);
    renderRouteLayers();
  }

  function undoLastRoute() {
    if (currentWaypoints.length === 0) return;
    currentWaypoints.pop();
    if (currentWaypoints.length >= 2) {
      var gen = ++_fetchGen;
      var snapshot = currentWaypoints.slice();
      App.setStatus("Routing\u2026");
      fetchRoute(snapshot).then(function (coords) {
        if (gen !== _fetchGen) return;
        currentRouteCoords = coords || snapshot;
        renderRouteLayers();
        App.setStatus(currentWaypoints.length + " waypoints \u2014 click last point or press Enter to finish");
      });
    } else {
      currentRouteCoords = [];
      renderRouteLayers();
      if (currentWaypoints.length === 0) {
        App.setStatus("Route drawing cancelled");
      } else {
        App.setStatus("Route started \u2014 click to add waypoints, click last point or press Enter to finish");
      }
    }
    if (App.undo) App.undo.updateButtons();
  }

  /* ---- Vertex editing support ---- */

  // Re-routes the entire route after a waypoint is moved.
  // Called from editing.js on drag release.
  async function updateRouteWaypoint(routeIdx, wpIdx, lng, lat) {
    if (routeIdx < 0 || routeIdx >= routes.length) return;
    var route = routes[routeIdx];
    var waypoints = route.properties.waypoints;
    if (wpIdx < 0 || wpIdx >= waypoints.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();

    waypoints[wpIdx] = [lng, lat];

    if (waypoints.length >= 2) {
      App.setStatus("Re-routing\u2026");
      var coords = await fetchRoute(waypoints);
      route.geometry.coordinates = coords || waypoints.slice();
    } else {
      route.geometry.coordinates = waypoints.slice();
    }

    rebuildRouteBuffers(routeBufferRadiusMiles);
    App.setStatus("Route updated");
  }

  /* ---- Insert a new waypoint into an existing route ---- */

  async function insertRouteWaypoint(routeIdx, insertIdx, lng, lat) {
    if (routeIdx < 0 || routeIdx >= routes.length) return;
    var route = routes[routeIdx];
    route.properties.waypoints.splice(insertIdx, 0, [lng, lat]);

    if (route.properties.waypoints.length >= 2) {
      App.setStatus("Re-routing\u2026");
      var coords = await fetchRoute(route.properties.waypoints);
      route.geometry.coordinates = coords || route.properties.waypoints.slice();
    } else {
      route.geometry.coordinates = route.properties.waypoints.slice();
    }

    rebuildRouteBuffers(routeBufferRadiusMiles);
    renderRouteLayers();
    if (typeof App.showEditVertices === "function") App.showEditVertices("route", routeIdx);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (typeof App.cache !== "undefined") App.cache.save();
    App.setStatus("Route updated");
  }

  /* ---- Re-route an existing route with its current waypoints ---- */

  async function rerouteFeature(routeIdx) {
    if (routeIdx < 0 || routeIdx >= routes.length) return;
    var route = routes[routeIdx];
    var waypoints = route.properties.waypoints;

    if (waypoints.length >= 2) {
      App.setStatus("Re-routing\u2026");
      var coords = await fetchRoute(waypoints);
      route.geometry.coordinates = coords || waypoints.slice();
    } else {
      route.geometry.coordinates = waypoints.slice();
    }

    rebuildRouteBuffers(routeBufferRadiusMiles);
    renderRouteLayers();
    App.setStatus("Route updated");
  }

  function duplicateRoute(index) {
    if (index < 0 || index >= routes.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var src = routes[index];
    var idx = routes.length + 1;
    var offsetCoords = src.geometry.coordinates.map(function (c) {
      return [c[0] + 0.002, c[1]];
    });
    var offsetWaypoints = (src.properties.waypoints || []).map(function (w) {
      return [w[0] + 0.002, w[1]];
    });
    var copy = {
      type: "Feature",
      properties: {
        name: "Route " + idx,
        routeIdx: idx,
        waypoints: offsetWaypoints,
        color: src.properties.color || "",
        hidden: false
      },
      geometry: { type: "LineString", coordinates: offsetCoords }
    };
    if (src.properties.attributes) {
      copy.properties.attributes = JSON.parse(JSON.stringify(src.properties.attributes));
    }
    routes.push(copy);
    rebuildRouteBuffers(routeBufferRadiusMiles);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  /* ---- Expose on App namespace ---- */

  App.routes = routes;
  App.routeBuffers = routeBuffers;
  App.rebuildRouteBuffers = rebuildRouteBuffers;
  App.routeBufferUnionPolygon = routeBufferUnionPolygon;
  App.handleRouteClick = handleRouteClick;
  App.saveRoute = saveRoute;
  App.setRoutePreview = setRoutePreview;
  App.duplicateRoute = duplicateRoute;
  App.removeRoute = removeRoute;
  App.clearRoutes = clearRoutes;
  App.undoLastRoute = undoLastRoute;
  App.cancelRouteDrawing = cancelRouteDrawing;
  App.renderRouteLayers = renderRouteLayers;
  App.updateRouteWaypoint = updateRouteWaypoint;
  App._routeDrawingInProgress = function () { return currentWaypoints.length > 0; };
  App.insertRouteWaypoint = insertRouteWaypoint;
  App.rerouteFeature = rerouteFeature;
  App.refreshSavedWaypoints = function () {
    var src = App.map && App.map.getSource("routes-waypoints-saved");
    if (src) src.setData(savedWaypointsGeoJSON());
  };
})();
