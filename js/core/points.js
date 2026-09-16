// js/core/points.js
// Point feature + buffer management, map layer rendering.
// Depends on: App.map (map.js), turf (CDN).
// Exports: points, buffers, addPoint, clearPoints, undoLastPoint,
//          renderPointLayers, bufferUnionPolygon, getUnion, bboxStringFromFeature

(function () {
  var App = window.App = window.App || {};

  var points = [];
  var buffers = [];
  var bufferRadiusMiles = 0.5; // user-defined; 0 = no buffers

  function pointsGeoJSON() {
    return {
      type: "FeatureCollection",
      features: points.filter(function (p) { return !p.properties.hidden; }).map(function (p) {
        var props = {};
        for (var k in p.properties) { if (Object.prototype.hasOwnProperty.call(p.properties, k)) props[k] = p.properties[k]; }
        props.resolvedColor = App.resolveFeatureColor("point", p);
        return { type: "Feature", properties: props, geometry: p.geometry };
      })
    };
  }
  function buffersGeoJSON() { return { type: "FeatureCollection", features: buffers.filter(Boolean) }; }

  function updateCoordsPanel() {
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function renderPointLayers() {
    var map = App.map;
    var pointColor = (App.sectionColors && App.sectionColors.point) || "#2b6cb0";
    var ptsSrc = "points-src";
    var ptsLayer = "points-layer";
    var bufSrc = "buffers";
    var bufFillLayer = "buffers-fill";
    var bufLineLayer = "buffers-line";

    if (!map.getSource(bufSrc)) {
      map.addSource(bufSrc, { type: "geojson", data: buffersGeoJSON() });
      map.addLayer({
        id: bufFillLayer,
        type: "fill",
        source: bufSrc,
        paint: { "fill-color": pointColor, "fill-opacity": 0.08 }
      });
      map.addLayer({
        id: bufLineLayer,
        type: "line",
        source: bufSrc,
        paint: { "line-color": pointColor, "line-width": 2, "line-opacity": 0.4 }
      });
    } else {
      map.getSource(bufSrc).setData(buffersGeoJSON());
      map.setPaintProperty(bufFillLayer, "fill-color", pointColor);
      map.setPaintProperty(bufLineLayer, "line-color", pointColor);
    }

    if (!map.getSource(ptsSrc)) {
      map.addSource(ptsSrc, { type: "geojson", data: pointsGeoJSON() });
      map.addLayer({
        id: ptsLayer,
        type: "circle",
        source: ptsSrc,
        paint: {
          "circle-radius": 6,
          "circle-stroke-width": 2,
          "circle-color": ["get", "resolvedColor"],
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource(ptsSrc).setData(pointsGeoJSON());
    }

    updateCoordsPanel();
  }

  function addPoint(lon, lat) {
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var idx = points.length + 1;
    var feature = {
      type: "Feature",
      properties: { name: "Point " + idx, pointIdx: idx, color: "" },
      geometry: { type: "Point", coordinates: [lon, lat] }
    };
    points.push(feature);
    rebuildBuffers(bufferRadiusMiles);
    // If the attributes popup is already open (on some other feature), follow
    // it to this newly-drawn point. Never auto-open it if it wasn't open.
    if (typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen() &&
        typeof App.openAttrPopup === "function") {
      App.openAttrPopup("point", points.length - 1, feature);
    }
  }

  function addPointWithOpts(lon, lat, opts) {
    opts = opts || {};
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var idx = points.length + 1;
    var feature = {
      type: "Feature",
      properties: {
        name: opts.name || ("Point " + idx),
        pointIdx: idx,
        color: ""
      },
      geometry: { type: "Point", coordinates: [lon, lat] }
    };
    if (opts.attributes) {
      feature.properties.attributes = opts.attributes;
    }
    points.push(feature);
    rebuildBuffers(bufferRadiusMiles);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    App.setStatus(feature.properties.name + " added");
  }

  // Rebuild all buffers from current points at the given radius.
  // If radius is 0, buffers are cleared (points remain on the map).
  function rebuildBuffers(radiusMiles) {
    if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
    bufferRadiusMiles = radiusMiles;
    buffers.length = 0;
    buffers.length = points.length;
    for (var i = 0; i < points.length; i++) {
      if (points[i].properties.hidden) continue;

      // Walkshed study area: if this point is flagged serviceAreaType === "walkshed"
      // and the Walkshed module has a valid cached polygon for it, use that polygon
      // as the buffer (regardless of the circular radius). Falls back to the circle
      // when no network/walkshed is available. See js/projects/walkshed.js.
      var attrs = points[i].properties.attributes || {};
      var ws = (attrs.serviceAreaType === "walkshed" && typeof App.getPointWalkshed === "function")
        ? App.getPointWalkshed(points[i].properties.pointIdx)
        : null;
      if (ws && ws.geometry) {
        buffers[i] = {
          type: "Feature",
          geometry: ws.geometry,
          properties: { pointIdx: points[i].properties.pointIdx, walkshed: true }
        };
        continue;
      }

      var r = (points[i].properties._bufferRadius != null)
        ? points[i].properties._bufferRadius
        : radiusMiles;
      if (r > 0) {
        var coords = points[i].geometry.coordinates;
        var pt = turf.point(coords);
        var circle = turf.circle(pt, r, { units: "miles", steps: 64 });
        buffers[i] = {
          type: circle.type,
          geometry: circle.geometry,
          properties: { pointIdx: points[i].properties.pointIdx }
        };
      }
    }
    renderPointLayers();
  }

  // Rebuild buffers at the current radius (no argument needed). Used by the
  // Walkshed module after it computes/flags walksheds so the buffer union picks
  // them up without the caller needing to know the current radius.
  function refreshBuffers() { rebuildBuffers(bufferRadiusMiles); }

  function bufferUnionPolygon() {
    var u = null;
    for (var i = 0; i < buffers.length; i++) {
      if (!buffers[i]) continue;
      if (!u) { u = buffers[i]; continue; }
      try { u = turf.union(u, buffers[i]); } catch (e) { /* skip invalid */ }
    }
    return u;
  }

  function bboxStringFromFeature(feat) { return turf.bbox(feat).join(","); }

  function movePoint(index, lng, lat) {
    if (index < 0 || index >= points.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    points[index].geometry.coordinates = [lng, lat];
    rebuildBuffers(bufferRadiusMiles);
  }

  function removePoint(index) {
    if (index < 0 || index >= points.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    points.splice(index, 1);
    rebuildBuffers(bufferRadiusMiles);
  }

  function clearPoints() {
    points.length = 0;
    buffers.length = 0;
    renderPointLayers();
  }

  function undoLastPoint() {
    if (points.length === 0) return;
    points.pop();
    rebuildBuffers(bufferRadiusMiles);
  }

  function duplicatePoint(index) {
    if (index < 0 || index >= points.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var src = points[index];
    var idx = points.length + 1;
    var copy = {
      type: "Feature",
      properties: {
        name: "Point " + idx,
        pointIdx: idx,
        color: src.properties.color || "",
        hidden: false
      },
      geometry: {
        type: "Point",
        coordinates: [src.geometry.coordinates[0] + 0.002, src.geometry.coordinates[1]]
      }
    };
    if (src.properties.attributes) {
      copy.properties.attributes = JSON.parse(JSON.stringify(src.properties.attributes));
    }
    points.push(copy);
    rebuildBuffers(bufferRadiusMiles);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  /* ---- Expose on App namespace ---- */

  App.points = points;
  App.buffers = buffers;
  App.addPoint = addPoint;
  App.addPointWithOpts = addPointWithOpts;
  App.rebuildBuffers = rebuildBuffers;
  App.refreshBuffers = refreshBuffers;
  App.movePoint = movePoint;
  App.removePoint = removePoint;
  App.clearPoints = clearPoints;
  App.duplicatePoint = duplicatePoint;
  App.undoLastPoint = undoLastPoint;
  App.renderPointLayers = renderPointLayers;
  App.bufferUnionPolygon = bufferUnionPolygon;
  App.bboxStringFromFeature = bboxStringFromFeature;
  App.getUnion = bufferUnionPolygon;
})();
