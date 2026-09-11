// js/core/lines.js
// Line drawing and management, map layer rendering.
// Depends on: App.map (map.js).
// Exports: lines, handleLineClick, clearLines, undoLastLine,
//          cancelLineDrawing, renderLineLayers

(function () {
  var App = window.App = window.App || {};

  var lines = [];               // Saved GeoJSON LineString features
  var lineBuffers = [];         // Buffer polygons, one per saved line
  var lineBufferRadiusMiles = 0.5;
  var currentCoords = [];       // Coordinates of the line currently being drawn
  var previewCoord = null;      // [lng, lat] or null — cursor position during drawing (rubber-band)
  var SNAP_PIXELS = 15;         // Click must be within this many pixels of last waypoint to save

  /* ---- Line buffer functions ---- */

  function rebuildLineBuffers(radiusMiles) {
    if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
    lineBufferRadiusMiles = radiusMiles;
    lineBuffers.length = 0;
    lineBuffers.length = lines.length;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].properties.hidden) continue;
      var r = (lines[i].properties._bufferRadius != null)
        ? lines[i].properties._bufferRadius
        : radiusMiles;
      if (r > 0) {
        var buf = turf.buffer(lines[i], r, { units: "miles", steps: 64 });
        lineBuffers[i] = { type: buf.type, geometry: buf.geometry, properties: { lineIdx: lines[i].properties.lineIdx, resolvedColor: App.resolveFeatureColor("line", lines[i]) } };
      }
    }
    renderLineLayers();
  }

  function lineBufferUnionPolygon() {
    var u = null;
    for (var i = 0; i < lineBuffers.length; i++) {
      if (!lineBuffers[i]) continue;
      if (!u) { u = lineBuffers[i]; continue; }
      try { u = turf.union(u, lineBuffers[i]); } catch (e) { /* skip invalid */ }
    }
    return u;
  }

  function lineBuffersGeoJSON() {
    return { type: "FeatureCollection", features: lineBuffers.filter(Boolean) };
  }

  /* ---- GeoJSON helpers ---- */

  function linesGeoJSON() {
    return {
      type: "FeatureCollection",
      features: lines.filter(function (l) { return !l.properties.hidden; }).map(function (l) {
        var props = {};
        for (var k in l.properties) { if (Object.prototype.hasOwnProperty.call(l.properties, k)) props[k] = l.properties[k]; }
        props.resolvedColor = App.resolveFeatureColor("line", l);
        return { type: "Feature", properties: props, geometry: l.geometry };
      })
    };
  }

  function currentLineGeoJSON() {
    var coords = currentCoords.slice();
    if (previewCoord && coords.length >= 1) coords.push(previewCoord);
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
      features: currentCoords.map(function (c, i) {
        return {
          type: "Feature",
          properties: { idx: i + 1 },
          geometry: { type: "Point", coordinates: c }
        };
      })
    };
  }

  function savedVerticesGeoJSON() {
    var features = [];
    var sel = App._selected;
    lines.forEach(function (line, arrayIndex) {
      if (line.properties.hidden) return;
      if (!sel || sel.type !== "line" || sel.index !== arrayIndex) return;
      var lineResolvedColor = App.resolveFeatureColor("line", line);
      line.geometry.coordinates.forEach(function (c, i) {
        features.push({
          type: "Feature",
          properties: { lineIdx: line.properties.lineIdx, waypointIdx: i + 1, resolvedColor: lineResolvedColor },
          geometry: { type: "Point", coordinates: c }
        });
      });
    });
    return { type: "FeatureCollection", features: features };
  }

  /* ---- Sidebar panel update ---- */

  function updateLinesPanel() {
    var drawingEl = document.getElementById("lineDrawing");
    if (drawingEl) {
      if (currentCoords.length > 0) {
        drawingEl.textContent = "Drawing: " + currentCoords.length +
          " waypoint" + (currentCoords.length !== 1 ? "s" : "") +
          " placed — click last point again to save";
      } else {
        drawingEl.textContent = "";
      }
    }
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  /* ---- Map layer rendering ---- */

  function renderLineLayers() {
    var map = App.map;

    // Line buffers (blue fill, rendered below the red line geometry)
    if (!map.getSource("line-buffers")) {
      map.addSource("line-buffers", { type: "geojson", data: lineBuffersGeoJSON() });
      map.addLayer({
        id: "line-buffers-fill",
        type: "fill",
        source: "line-buffers",
        paint: { "fill-color": ["get", "resolvedColor"], "fill-opacity": 0.08 }
      });
      map.addLayer({
        id: "line-buffers-line",
        type: "line",
        source: "line-buffers",
        paint: { "line-color": ["get", "resolvedColor"], "line-width": 2, "line-opacity": 0.4 }
      });
    } else {
      map.getSource("line-buffers").setData(lineBuffersGeoJSON());
    }

    // Saved lines (solid)
    if (!map.getSource("lines")) {
      map.addSource("lines", { type: "geojson", data: linesGeoJSON() });
      map.addLayer({
        id: "lines-layer",
        type: "line",
        source: "lines",
        paint: { "line-color": ["get", "resolvedColor"], "line-width": 3, "line-opacity": 0.8, "line-offset": ["coalesce", ["get", "_offset"], 0] }
      });
    } else {
      map.getSource("lines").setData(linesGeoJSON());
    }

    // Saved line vertices (small dots)
    if (!map.getSource("lines-vertices")) {
      map.addSource("lines-vertices", { type: "geojson", data: savedVerticesGeoJSON() });
      map.addLayer({
        id: "lines-vertices-layer",
        type: "circle",
        source: "lines-vertices",
        paint: {
          "circle-radius": 3,
          "circle-color": ["get", "resolvedColor"],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource("lines-vertices").setData(savedVerticesGeoJSON());
    }

    // In-progress line (dashed)
    if (!map.getSource("lines-drawing")) {
      map.addSource("lines-drawing", { type: "geojson", data: currentLineGeoJSON() });
      map.addLayer({
        id: "lines-drawing-layer",
        type: "line",
        source: "lines-drawing",
        paint: { "line-color": "#e53e3e", "line-width": 2, "line-opacity": 0.6, "line-dasharray": [3, 2] }
      });
    } else {
      map.getSource("lines-drawing").setData(currentLineGeoJSON());
    }

    // In-progress waypoints (clickable-sized dots)
    if (!map.getSource("lines-waypoints")) {
      map.addSource("lines-waypoints", { type: "geojson", data: currentWaypointsGeoJSON() });
      map.addLayer({
        id: "lines-waypoints-layer",
        type: "circle",
        source: "lines-waypoints",
        paint: {
          "circle-radius": 6,
          "circle-color": "#e53e3e",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource("lines-waypoints").setData(currentWaypointsGeoJSON());
    }

    updateLinesPanel();

    // Auto-recompute overlap offsets if toggle is on
    var oCb = document.getElementById("offsetOverlap");
    if (oCb && oCb.checked && typeof App.computeOverlapOffsets === "function") {
      App.computeOverlapOffsets();
    }
  }

  /* ---- Rubber-band preview (updates drawing source only) ---- */

  function setLinePreview(lngLat) {
    previewCoord = lngLat ? [lngLat.lng, lngLat.lat] : null;
    var src = App.map.getSource("lines-drawing");
    if (src) src.setData(currentLineGeoJSON());
  }

  /* ---- Click logic ---- */

  function isNearLastWaypoint(lngLat) {
    if (currentCoords.length === 0) return false;
    var last = currentCoords[currentCoords.length - 1];
    var lastPx = App.map.project(last);
    var clickPx = App.map.project([lngLat.lng, lngLat.lat]);
    var dx = lastPx.x - clickPx.x;
    var dy = lastPx.y - clickPx.y;
    return Math.sqrt(dx * dx + dy * dy) < SNAP_PIXELS;
  }

  function handleLineClick(lngLat) {
    // If drawing and click is near last waypoint → save
    if (currentCoords.length >= 2 && isNearLastWaypoint(lngLat)) {
      saveLine();
      return;
    }

    // Otherwise add a waypoint
    currentCoords.push([lngLat.lng, lngLat.lat]);
    renderLineLayers();

    if (currentCoords.length === 1) {
      App.setStatus("Line started — click to add waypoints, click last point or press Enter to finish");
    } else {
      App.setStatus(currentCoords.length + " waypoints — click last point or press Enter to finish");
    }
  }

  function saveLine() {
    if (currentCoords.length < 2) {
      currentCoords.length = 0;
      previewCoord = null;
      renderLineLayers();
      return;
    }

    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var idx = lines.length + 1;
    var nWaypoints = currentCoords.length;
    var feature = {
      type: "Feature",
      properties: { name: "Line " + idx, lineIdx: idx, waypoints: nWaypoints, color: "", colorSeq: App._nextColorSeq() },
      geometry: { type: "LineString", coordinates: currentCoords.slice() }
    };
    lines.push(feature);

    currentCoords.length = 0;
    previewCoord = null;
    rebuildLineBuffers(lineBufferRadiusMiles);
    App.setStatus("Line " + idx + " saved (" + nWaypoints + " waypoints)");
    if (typeof App.exitDrawMode === "function") App.exitDrawMode();
    // If the attributes popup is already open (on some other feature), follow
    // it to this newly-drawn line. Never auto-open it if it wasn't open.
    if (typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen() &&
        typeof App.openAttrPopup === "function") {
      App.openAttrPopup("line", lines.length - 1, feature);
    }
  }

  function addLineFromCoords(coords, opts) {
    if (!coords || coords.length < 2) return;
    opts = opts || {};
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var idx = lines.length + 1;
    var feature = {
      type: "Feature",
      properties: {
        name: opts.name || ("Line " + idx),
        lineIdx: idx,
        waypoints: coords.length,
        color: opts.color || "",
        colorSeq: App._nextColorSeq()
      },
      geometry: { type: "LineString", coordinates: coords.slice() }
    };
    if (opts.attributes) {
      feature.properties.attributes = opts.attributes;
    }
    lines.push(feature);
    rebuildLineBuffers(lineBufferRadiusMiles);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    App.setStatus(feature.properties.name + " added (" + coords.length + " waypoints)");
  }

  function cancelLineDrawing() {
    if (currentCoords.length === 0 && !previewCoord) return;
    currentCoords.length = 0;
    previewCoord = null;
    renderLineLayers();
  }

  function removeLine(index) {
    if (index < 0 || index >= lines.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    lines.splice(index, 1);
    rebuildLineBuffers(lineBufferRadiusMiles);
  }

  function clearLines() {
    if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
    lines.length = 0;
    currentCoords.length = 0;
    previewCoord = null;
    lineBuffers.splice(0);
    renderLineLayers();
  }

  function undoLastLine() {
    if (currentCoords.length === 0) return;
    currentCoords.pop();
    renderLineLayers();
    if (currentCoords.length === 0) {
      App.setStatus("Line drawing cancelled");
    } else {
      App.setStatus(currentCoords.length + " waypoints — click last point to save");
    }
    if (App.undo) App.undo.updateButtons();
  }

  /* ---- Vertex editing support ---- */

  function updateLineVertex(lineIndex, vertexIndex, lng, lat) {
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    var coords = lines[lineIndex].geometry.coordinates;
    if (vertexIndex < 0 || vertexIndex >= coords.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    coords[vertexIndex] = [lng, lat];
    rebuildLineBuffers(lineBufferRadiusMiles);
  }

  function duplicateLine(index) {
    if (index < 0 || index >= lines.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var src = lines[index];
    var idx = lines.length + 1;
    var offsetCoords = src.geometry.coordinates.map(function (c) {
      return [c[0] + 0.002, c[1]];
    });
    var copy = {
      type: "Feature",
      properties: {
        name: "Line " + idx,
        lineIdx: idx,
        waypoints: src.properties.waypoints,
        color: src.properties.color || "",
        hidden: false
      },
      geometry: { type: "LineString", coordinates: offsetCoords }
    };
    if (src.properties.attributes) {
      copy.properties.attributes = JSON.parse(JSON.stringify(src.properties.attributes));
    }
    lines.push(copy);
    rebuildLineBuffers(lineBufferRadiusMiles);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  /* ---- Expose on App namespace ---- */

  App.lines = lines;
  App.lineBuffers = lineBuffers;
  App.rebuildLineBuffers = rebuildLineBuffers;
  App.lineBufferUnionPolygon = lineBufferUnionPolygon;
  App.handleLineClick = handleLineClick;
  App.saveLine = saveLine;
  App.addLineFromCoords = addLineFromCoords;
  App.duplicateLine = duplicateLine;
  App.removeLine = removeLine;
  App.clearLines = clearLines;
  App.undoLastLine = undoLastLine;
  App.cancelLineDrawing = cancelLineDrawing;
  App.renderLineLayers = renderLineLayers;
  App.setLinePreview = setLinePreview;
  App.updateLineVertex = updateLineVertex;
  App._lineDrawingInProgress = function () { return currentCoords.length > 0; };
  App.refreshSavedVertices = function () {
    var src = App.map && App.map.getSource("lines-vertices");
    if (src) src.setData(savedVerticesGeoJSON());
  };
})();
