// js/core/polygons.js
// Polygon drawing and management, map layer rendering.
// Depends on: App.map (map.js).
// Exports: polygons, handlePolygonClick, clearPolygons, undoLastPolygon,
//          cancelPolygonDrawing, renderPolygonLayers

(function () {
  var App = window.App = window.App || {};

  var polygons = [];       // Saved GeoJSON Polygon features
  var currentCoords = [];  // Vertices of the polygon being drawn
  var previewCoord = null; // [lng, lat] or null — cursor position during drawing (rubber-band)
  var SNAP_PIXELS = 15;

  /* ---- GeoJSON helpers ---- */

  function polygonsGeoJSON() {
    return {
      type: "FeatureCollection",
      features: polygons.filter(function (p) { return !p.properties.hidden; }).map(function (p) {
        var props = {};
        for (var k in p.properties) { if (Object.prototype.hasOwnProperty.call(p.properties, k)) props[k] = p.properties[k]; }
        props.resolvedColor = App.resolveFeatureColor("polygon", p);
        return { type: "Feature", properties: props, geometry: p.geometry };
      })
    };
  }

  function polygonOutlinesGeoJSON() {
    return {
      type: "FeatureCollection",
      features: polygons.filter(function (p) { return !p.properties.hidden; }).map(function (f) {
        var props = {};
        for (var k in f.properties) { if (Object.prototype.hasOwnProperty.call(f.properties, k)) props[k] = f.properties[k]; }
        props.resolvedColor = App.resolveFeatureColor("polygon", f);
        return {
          type: "Feature",
          properties: props,
          geometry: {
            type: "LineString",
            coordinates: f.geometry.coordinates[0]
          }
        };
      })
    };
  }

  function savedVerticesGeoJSON() {
    var features = [];
    polygons.forEach(function (poly) {
      if (poly.properties.hidden) return;
      var polyResolvedColor = App.resolveFeatureColor("polygon", poly);
      // Skip the closing coordinate (last === first)
      var ring = poly.geometry.coordinates[0];
      for (var i = 0; i < ring.length - 1; i++) {
        features.push({
          type: "Feature",
          properties: { polyIdx: poly.properties.polyIdx, vertexIdx: i + 1, resolvedColor: polyResolvedColor },
          geometry: { type: "Point", coordinates: ring[i] }
        });
      }
    });
    return { type: "FeatureCollection", features: features };
  }

  // In-progress drawing: show as a closed outline once we have >= 3 points,
  // otherwise show the open path so far. Includes rubber-band preview to cursor.
  function currentDrawingGeoJSON() {
    var coords = currentCoords.slice();
    if (previewCoord && coords.length >= 1) coords.push(previewCoord);
    if (coords.length < 2) {
      return { type: "FeatureCollection", features: [] };
    }
    if (coords.length >= 3) {
      coords.push(coords[0]); // close the ring visually
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

  /* ---- Panel update ---- */

  function updatePolygonPanel() {
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  /* ---- Map layer rendering ---- */

  var COLOR = "#38a169"; // green

  function renderPolygonLayers() {
    var map = App.map;

    // Saved polygon fills
    if (!map.getSource("polygons")) {
      map.addSource("polygons", { type: "geojson", data: polygonsGeoJSON() });
      map.addLayer({
        id: "polygons-fill",
        type: "fill",
        source: "polygons",
        paint: { "fill-color": ["get", "resolvedColor"], "fill-opacity": 0.15 }
      });
    } else {
      map.getSource("polygons").setData(polygonsGeoJSON());
    }

    // Saved polygon outlines
    if (!map.getSource("polygons-outlines")) {
      map.addSource("polygons-outlines", { type: "geojson", data: polygonOutlinesGeoJSON() });
      map.addLayer({
        id: "polygons-outlines-layer",
        type: "line",
        source: "polygons-outlines",
        paint: { "line-color": ["get", "resolvedColor"], "line-width": 3, "line-opacity": 0.8 }
      });
    } else {
      map.getSource("polygons-outlines").setData(polygonOutlinesGeoJSON());
    }

    // Saved polygon vertices
    if (!map.getSource("polygons-vertices")) {
      map.addSource("polygons-vertices", { type: "geojson", data: savedVerticesGeoJSON() });
      map.addLayer({
        id: "polygons-vertices-layer",
        type: "circle",
        source: "polygons-vertices",
        paint: {
          "circle-radius": 3,
          "circle-color": ["get", "resolvedColor"],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource("polygons-vertices").setData(savedVerticesGeoJSON());
    }

    // In-progress outline (dashed)
    if (!map.getSource("polygons-drawing")) {
      map.addSource("polygons-drawing", { type: "geojson", data: currentDrawingGeoJSON() });
      map.addLayer({
        id: "polygons-drawing-layer",
        type: "line",
        source: "polygons-drawing",
        paint: { "line-color": COLOR, "line-width": 2, "line-opacity": 0.5, "line-dasharray": [3, 2] }
      });
    } else {
      map.getSource("polygons-drawing").setData(currentDrawingGeoJSON());
    }

    // In-progress waypoints
    if (!map.getSource("polygons-waypoints")) {
      map.addSource("polygons-waypoints", { type: "geojson", data: currentWaypointsGeoJSON() });
      map.addLayer({
        id: "polygons-waypoints-layer",
        type: "circle",
        source: "polygons-waypoints",
        paint: {
          "circle-radius": 6,
          "circle-color": COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource("polygons-waypoints").setData(currentWaypointsGeoJSON());
    }

    updatePolygonPanel();
  }

  /* ---- Rubber-band preview (updates drawing source only) ---- */

  function setPolygonPreview(lngLat) {
    previewCoord = lngLat ? [lngLat.lng, lngLat.lat] : null;
    var src = App.map.getSource("polygons-drawing");
    if (src) src.setData(currentDrawingGeoJSON());
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

  function handlePolygonClick(lngLat) {
    // Need at least 3 vertices before closing
    if (currentCoords.length >= 3 && isNearLastWaypoint(lngLat)) {
      savePolygon();
      return;
    }

    currentCoords.push([lngLat.lng, lngLat.lat]);
    renderPolygonLayers();

    if (currentCoords.length === 1) {
      App.setStatus("Polygon started — click to add vertices, click last point or press Enter to finish");
    } else if (currentCoords.length === 2) {
      App.setStatus("2 vertices — need at least 3 to close polygon");
    } else {
      App.setStatus(currentCoords.length + " vertices — click last point or press Enter to finish");
    }
  }

  function savePolygon() {
    if (currentCoords.length < 3) {
      currentCoords.length = 0;
      previewCoord = null;
      renderPolygonLayers();
      return;
    }

    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var idx = polygons.length + 1;
    var nVertices = currentCoords.length;
    var ring = currentCoords.slice();
    ring.push(ring[0]); // close the ring

    var polyColor = (App.sectionColors && App.sectionColors.polygon) || App.POLYGON_DEFAULT_COLOR || "#b0c4de";
    var feature = {
      type: "Feature",
      properties: { name: "Polygon " + idx, polyIdx: idx, vertices: nVertices, color: polyColor },
      geometry: { type: "Polygon", coordinates: [ring] }
    };
    polygons.push(feature);

    currentCoords.length = 0;
    previewCoord = null;
    renderPolygonLayers();
    App.setStatus("Polygon " + idx + " saved (" + nVertices + " vertices)");
    if (typeof App.exitDrawMode === "function") App.exitDrawMode();
    // If the attributes popup is already open (on some other feature), follow
    // it to this newly-drawn polygon. Never auto-open it if it wasn't open.
    if (typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen() &&
        typeof App.openAttrPopup === "function") {
      App.openAttrPopup("polygon", polygons.length - 1, feature);
    }
  }

  function cancelPolygonDrawing() {
    if (currentCoords.length === 0 && !previewCoord) return;
    currentCoords.length = 0;
    previewCoord = null;
    renderPolygonLayers();
  }

  function removePolygon(index) {
    if (index < 0 || index >= polygons.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    polygons.splice(index, 1);
    renderPolygonLayers();
  }

  function clearPolygons() {
    polygons.length = 0;
    currentCoords.length = 0;
    previewCoord = null;
    renderPolygonLayers();
  }

  function undoLastPolygon() {
    if (currentCoords.length === 0) return;
    currentCoords.pop();
    renderPolygonLayers();
    if (currentCoords.length === 0) {
      App.setStatus("Polygon drawing cancelled");
    } else if (currentCoords.length < 3) {
      App.setStatus(currentCoords.length + " vertices — need at least 3 to close polygon");
    } else {
      App.setStatus(currentCoords.length + " vertices — click last point or press Enter to finish");
    }
    if (App.undo) App.undo.updateButtons();
  }

  /* ---- Vertex editing support ---- */

  function updatePolygonVertex(polyIndex, vertexIndex, lng, lat) {
    if (polyIndex < 0 || polyIndex >= polygons.length) return;
    var ring = polygons[polyIndex].geometry.coordinates[0];
    if (vertexIndex < 0 || vertexIndex >= ring.length - 1) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    ring[vertexIndex] = [lng, lat];
    // If editing vertex 0, also update the closing vertex
    if (vertexIndex === 0) {
      ring[ring.length - 1] = [lng, lat];
    }
    renderPolygonLayers();
  }

  /* ---- Union polygon for spatial analysis ---- */

  function polygonUnionPolygon() {
    if (polygons.length === 0) return null;
    var u = polygons[0];
    for (var i = 1; i < polygons.length; i++) u = turf.union(u, polygons[i]);
    return u;
  }

  function duplicatePolygon(index) {
    if (index < 0 || index >= polygons.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var src = polygons[index];
    var idx = polygons.length + 1;
    var offsetRing = src.geometry.coordinates[0].map(function (c) {
      return [c[0] + 0.002, c[1]];
    });
    var copy = {
      type: "Feature",
      properties: {
        name: "Polygon " + idx,
        polyIdx: idx,
        vertices: src.properties.vertices,
        color: src.properties.color || "",
        hidden: false
      },
      geometry: { type: "Polygon", coordinates: [offsetRing] }
    };
    if (src.properties.attributes) {
      copy.properties.attributes = JSON.parse(JSON.stringify(src.properties.attributes));
    }
    polygons.push(copy);
    renderPolygonLayers();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  /* ---- Expose on App namespace ---- */

  App.polygons = polygons;
  App.polygonUnionPolygon = polygonUnionPolygon;
  App.handlePolygonClick = handlePolygonClick;
  App.savePolygon = savePolygon;
  App.duplicatePolygon = duplicatePolygon;
  App.removePolygon = removePolygon;
  App.clearPolygons = clearPolygons;
  App.undoLastPolygon = undoLastPolygon;
  App.cancelPolygonDrawing = cancelPolygonDrawing;
  App.renderPolygonLayers = renderPolygonLayers;
  App.setPolygonPreview = setPolygonPreview;
  App.updatePolygonVertex = updatePolygonVertex;
  App._polygonDrawingInProgress = function () { return currentCoords.length > 0; };
})();
