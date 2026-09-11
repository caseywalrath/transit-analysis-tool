// js/core/editing.js
// Feature editing: point click-drag, line/polygon/route vertex editing.
// Depends on: App.map, App.points, App.lines, App.polygons, App.routes,
//             App.movePoint, App.updateLineVertex, App.updatePolygonVertex,
//             App.updateRouteWaypoint, App.insertRouteWaypoint, App.rerouteFeature,
//             App.renderPointLayers, App.renderLineLayers, App.renderPolygonLayers,
//             App.renderRouteLayers, App.refreshFeaturePanel.
// Exports: App._editing, App.exitEditMode, App._initEditing,
//          App.activateVertexEdit, App.deactivateVertexEdit, App.showEditVertices

(function () {
  var App = window.App = window.App || {};

  // ---- Edit state ----
  // null when idle. Otherwise one of:
  //   { type: "point-drag", index: N }
  //   { type: "vertex-edit", featureType: "line"|"route"|"polygon", featureIndex: N }
  //   { type: "vertex-drag", featureType: "line"|"route"|"polygon", featureIndex: N, vertexIndex: N }

  var editState = null;
  App._editing = null;

  var EDIT_COLOR = "#f6ad55"; // orange highlight
  var EDIT_SRC = "edit-vertices";
  var EDIT_LAYER = "edit-vertices-layer";

  // Context menu element (singleton)
  var _ctxMenu = null;

  // Live vertex-drag preview sources feed the same "*-layer" ids as the
  // normal render path, whose paint expressions read resolvedColor directly
  // (no coalesce fallback — see js/core/utils.js resolveFeatureColor). Since
  // these temp FeatureCollections bypass linesGeoJSON()/routesGeoJSON()/etc.
  // for a lightweight per-frame update, they must stamp resolvedColor
  // themselves or the dragged feature would go colorless mid-drag.
  function _withResolvedColor(featureType, arr) {
    return arr.map(function (f) {
      var props = {};
      for (var k in f.properties) { if (Object.prototype.hasOwnProperty.call(f.properties, k)) props[k] = f.properties[k]; }
      props.resolvedColor = App.resolveFeatureColor(featureType, f);
      return { type: "Feature", properties: props, geometry: f.geometry };
    });
  }

  // ---- Edit vertex layer management ----

  function editVerticesGeoJSON(featureType, featureIndex) {
    var features = [];
    if (featureType === "line") {
      var line = App.lines[featureIndex];
      if (!line) return { type: "FeatureCollection", features: [] };
      line.geometry.coordinates.forEach(function (c, i) {
        features.push({
          type: "Feature",
          properties: { vertexIdx: i },
          geometry: { type: "Point", coordinates: c }
        });
      });
    } else if (featureType === "route") {
      // Show handles only on the user's waypoints, not every street-snapped coordinate.
      var route = App.routes[featureIndex];
      if (!route) return { type: "FeatureCollection", features: [] };
      (route.properties.waypoints || []).forEach(function (wp, i) {
        features.push({
          type: "Feature",
          properties: { vertexIdx: i },
          geometry: { type: "Point", coordinates: wp }
        });
      });
    } else if (featureType === "polygon") {
      var poly = App.polygons[featureIndex];
      if (!poly) return { type: "FeatureCollection", features: [] };
      var ring = poly.geometry.coordinates[0];
      // Skip closing vertex (last === first)
      for (var i = 0; i < ring.length - 1; i++) {
        features.push({
          type: "Feature",
          properties: { vertexIdx: i },
          geometry: { type: "Point", coordinates: ring[i] }
        });
      }
    }
    return { type: "FeatureCollection", features: features };
  }

  function showEditVertices(featureType, featureIndex) {
    var map = App.map;
    var data = editVerticesGeoJSON(featureType, featureIndex);
    if (!map.getSource(EDIT_SRC)) {
      map.addSource(EDIT_SRC, { type: "geojson", data: data });
      map.addLayer({
        id: EDIT_LAYER,
        type: "circle",
        source: EDIT_SRC,
        paint: {
          "circle-radius": 7,
          "circle-color": EDIT_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff"
        }
      });
    } else {
      map.getSource(EDIT_SRC).setData(data);
    }
  }

  function hideEditVertices() {
    var map = App.map;
    if (map.getLayer(EDIT_LAYER)) map.removeLayer(EDIT_LAYER);
    if (map.getSource(EDIT_SRC)) map.removeSource(EDIT_SRC);
  }

  // ---- Feature index matching ----

  function findPointIndex(hitFeature) {
    var targetIdx = hitFeature.properties && hitFeature.properties.pointIdx;
    if (targetIdx != null) {
      for (var i = 0; i < App.points.length; i++) {
        if (App.points[i].properties.pointIdx == targetIdx) return i;
      }
    }
    // Fallback: match by coordinates
    var hitCoords = hitFeature.geometry.coordinates;
    for (var j = 0; j < App.points.length; j++) {
      var c = App.points[j].geometry.coordinates;
      if (Math.abs(c[0] - hitCoords[0]) < 1e-6 && Math.abs(c[1] - hitCoords[1]) < 1e-6) {
        return j;
      }
    }
    return -1;
  }

  function findLineIndex(hitFeature) {
    var targetIdx = hitFeature.properties && hitFeature.properties.lineIdx;
    if (targetIdx == null) return -1;
    for (var i = 0; i < App.lines.length; i++) {
      if (App.lines[i].properties.lineIdx == targetIdx) return i;
    }
    return -1;
  }

  function findRouteIndex(hitFeature) {
    var targetIdx = hitFeature.properties && hitFeature.properties.routeIdx;
    if (targetIdx == null) return -1;
    for (var i = 0; i < App.routes.length; i++) {
      if (App.routes[i].properties.routeIdx == targetIdx) return i;
    }
    return -1;
  }

  function findPolygonIndex(hitFeature) {
    var targetIdx = hitFeature.properties && hitFeature.properties.polyIdx;
    if (targetIdx == null) return -1;
    for (var i = 0; i < App.polygons.length; i++) {
      if (App.polygons[i].properties.polyIdx == targetIdx) return i;
    }
    return -1;
  }

  // ---- Index lookup by property value (for buffer hits) ----

  function findPointIndexByProp(pointIdx) {
    for (var i = 0; i < App.points.length; i++) {
      if (App.points[i].properties.pointIdx == pointIdx) return i;
    }
    return -1;
  }

  function findLineIndexByProp(lineIdx) {
    for (var i = 0; i < App.lines.length; i++) {
      if (App.lines[i].properties.lineIdx == lineIdx) return i;
    }
    return -1;
  }

  function findRouteIndexByProp(routeIdx) {
    for (var i = 0; i < App.routes.length; i++) {
      if (App.routes[i].properties.routeIdx == routeIdx) return i;
    }
    return -1;
  }

  // ---- Edit mode transitions ----

  // activateVertexEdit: sets editState + shows handles WITHOUT calling selectFeature.
  // Called internally and exposed on App for selection.js to call.
  App.activateVertexEdit = function (type, index) {
    if (editState && editState.type === "vertex-edit" &&
        editState.featureType === type && editState.featureIndex === index) return; // already active
    editState = { type: "vertex-edit", featureType: type, featureIndex: index };
    App._editing = editState;
    showEditVertices(type, index);
    App.map.getCanvas().style.cursor = "pointer";
    // Does NOT call selectFeature — caller is responsible
  };

  // deactivateVertexEdit: clears editState + hides handles WITHOUT calling clearSelection.
  App.deactivateVertexEdit = function () {
    if (!editState) return;
    editState = null;
    App._editing = null;
    hideEditVertices();
    if (!App.drawMode) App.map.getCanvas().style.cursor = "grab";
    // Does NOT call clearSelection — caller is responsible
  };

  function enterVertexEditMode(featureType, featureIndex) {
    App.activateVertexEdit(featureType, featureIndex);
    if (typeof App.selectFeature === "function") App.selectFeature(featureType, featureIndex);
    // selectFeature calls activateVertexEdit again, but the guard makes it a no-op
  }

  function exitEditMode() {
    App.deactivateVertexEdit();
    if (typeof App.clearSelection === "function") App.clearSelection();
    // clearSelection calls deactivateVertexEdit again, but the guard makes it a no-op
  }

  // ---- Insert vertex ----

  function insertVertex(featureType, featureIndex, lngLat) {
    var lng = lngLat.lng, lat = lngLat.lat;
    var clickPt = turf.point([lng, lat]);

    if (featureType === "line") {
      var line = App.lines[featureIndex];
      if (!line) return;
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      var nearest = turf.nearestPointOnLine(line, clickPt);
      var idx = nearest.properties.index + 1;
      line.geometry.coordinates.splice(idx, 0, [lng, lat]);
      var r = parseFloat(document.getElementById("lineBufferRadius").value) || 0.5;
      App.rebuildLineBuffers(r);
      App.renderLineLayers();
      showEditVertices("line", featureIndex);
      App.cache.save();

    } else if (featureType === "route") {
      var route = App.routes[featureIndex];
      if (!route) return;
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      var wps = route.properties.waypoints;
      var wpLine = turf.lineString(wps.length >= 2 ? wps : wps.concat(wps));
      var nearest2 = turf.nearestPointOnLine(wpLine, clickPt);
      var idx2 = nearest2.properties.index + 1;
      // insertRouteWaypoint handles async OSRM re-route, re-render, and cache save
      if (typeof App.insertRouteWaypoint === "function") {
        App.insertRouteWaypoint(featureIndex, idx2, lng, lat);
      }

    } else if (featureType === "polygon") {
      var poly = App.polygons[featureIndex];
      if (!poly) return;
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      var ring = poly.geometry.coordinates[0];
      // Build a closed line from the ring (including closing vertex) for nearest-point
      var ringLine = turf.lineString(ring.slice());
      var nearest3 = turf.nearestPointOnLine(ringLine, clickPt);
      var idx3 = nearest3.properties.index + 1;
      // idx3 can equal ring.length-1 (inserting before closing vertex — that's correct)
      ring.splice(idx3, 0, [lng, lat]);
      App.renderPolygonLayers();
      showEditVertices("polygon", featureIndex);
      App.cache.save();
    }
  }

  // ---- Context menu for vertex deletion ----

  function canDeleteVertex(featureType, featureIndex, vertexIdx) {
    if (featureType === "line") {
      var line = App.lines[featureIndex];
      return line && line.geometry.coordinates.length > 2;
    } else if (featureType === "route") {
      var route = App.routes[featureIndex];
      return route && route.properties.waypoints.length > 2;
    } else if (featureType === "polygon") {
      var poly = App.polygons[featureIndex];
      return poly && poly.geometry.coordinates[0].length > 4; // > 3 unique vertices
    }
    return false;
  }

  function deleteVertex(featureType, featureIndex, vertexIdx) {
    if (featureType === "line") {
      var line = App.lines[featureIndex];
      if (!line || line.geometry.coordinates.length <= 2) {
        App.setStatus("Cannot delete: line needs at least 2 points");
        return;
      }
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      line.geometry.coordinates.splice(vertexIdx, 1);
      var r = parseFloat(document.getElementById("lineBufferRadius").value) || 0.5;
      App.rebuildLineBuffers(r);
      App.renderLineLayers();
      showEditVertices("line", featureIndex);
      App.cache.save();

    } else if (featureType === "route") {
      var route = App.routes[featureIndex];
      if (!route || route.properties.waypoints.length <= 2) {
        App.setStatus("Cannot delete: route needs at least 2 waypoints");
        return;
      }
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      route.properties.waypoints.splice(vertexIdx, 1);
      // Re-route with updated waypoints
      if (typeof App.rerouteFeature === "function") {
        var _fi = featureIndex;
        App.rerouteFeature(_fi).then(function () {
          showEditVertices("route", _fi);
          if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
          App.cache.save();
        });
      }

    } else if (featureType === "polygon") {
      var poly = App.polygons[featureIndex];
      if (!poly) return;
      var ring = poly.geometry.coordinates[0];
      if (ring.length <= 4) {
        App.setStatus("Cannot delete: polygon needs at least 3 vertices");
        return;
      }
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      ring.splice(vertexIdx, 1);
      // Re-sync closing vertex (ring[last] must equal ring[0])
      ring[ring.length - 1] = ring[0].slice();
      App.renderPolygonLayers();
      showEditVertices("polygon", featureIndex);
      App.cache.save();
    }
  }

  function hideVertexCtxMenu() {
    if (_ctxMenu) _ctxMenu.style.display = "none";
  }

  function showVertexCtxMenu(x, y, featureType, featureIndex, vertexIdx) {
    if (!_ctxMenu) {
      _ctxMenu = document.createElement("div");
      _ctxMenu.id = "vertex-ctx-menu";
      document.body.appendChild(_ctxMenu);
    }

    var canDel = canDeleteVertex(featureType, featureIndex, vertexIdx);
    _ctxMenu.innerHTML = "<button id=\"vertex-ctx-delete\"" +
      (canDel ? "" : " disabled") + ">" +
      (canDel ? "Delete node" : "Delete node (minimum reached)") +
      "</button>";

    _ctxMenu.style.display = "block";
    _ctxMenu.style.left = x + "px";
    _ctxMenu.style.top  = y + "px";

    document.getElementById("vertex-ctx-delete").addEventListener("click", function () {
      hideVertexCtxMenu();
      if (canDel) deleteVertex(featureType, featureIndex, vertexIdx);
    });

    // Close menu on any next click outside
    setTimeout(function () {
      document.addEventListener("click", hideVertexCtxMenu, { capture: true, once: true });
    }, 0);
  }

  // ---- Safe queryRenderedFeatures helper ----

  function safeQuery(point, layerIds) {
    var map = App.map;
    var existing = [];
    for (var i = 0; i < layerIds.length; i++) {
      if (map.getLayer(layerIds[i])) existing.push(layerIds[i]);
    }
    if (existing.length === 0) return [];
    return map.queryRenderedFeatures(point, { layers: existing });
  }

  // ---- Initialization (called from app.js on map load) ----

  function init() {
    var map = App.map;

    // ---- Hover cursor management (when not in draw mode) ----
    map.on("mousemove", function (e) {
      if (App.drawMode) return;
      // Don't change cursor during active drags
      if (editState && (editState.type === "point-drag" || editState.type === "vertex-drag")) return;

      // Check edit vertex handles first (highest priority)
      if (editState && editState.type === "vertex-edit") {
        var editHits = safeQuery(e.point, [EDIT_LAYER]);
        if (editHits.length > 0) {
          map.getCanvas().style.cursor = "move";
          return;
        }
        // Check if cursor is over the currently-edited feature → show insert cursor
        var editFeatLayers = ["lines-layer", "routes-layer", "polygons-fill", "polygons-outlines"];
        var editFeatHits = safeQuery(e.point, editFeatLayers);
        if (editFeatHits.length > 0) {
          var ef = editFeatHits[0];
          var efLid = ef.layer.id;
          var efIdx = -1;
          if (efLid === "lines-layer" && editState.featureType === "line") efIdx = findLineIndex(ef);
          else if (efLid === "routes-layer" && editState.featureType === "route") efIdx = findRouteIndex(ef);
          else if ((efLid === "polygons-fill" || efLid === "polygons-outlines") && editState.featureType === "polygon") efIdx = findPolygonIndex(ef);
          if (efIdx === editState.featureIndex) {
            // Polygon: crosshair only on outline (edge), not fill interior
            if (editState.featureType === "polygon" && efLid === "polygons-fill") {
              map.getCanvas().style.cursor = "default";
            } else {
              map.getCanvas().style.cursor = "crosshair"; // indicates click-to-insert
            }
            return;
          }
        }
        map.getCanvas().style.cursor = "default";
        return;
      }

      // Check points — show "move" only if already selected, otherwise "pointer"
      var pointHits = safeQuery(e.point, ["points-layer"]);
      if (pointHits.length > 0) {
        var sIdx = findPointIndex(pointHits[0]);
        var isSelPoint = App._selected && App._selected.type === "point" && App._selected.index === sIdx;
        map.getCanvas().style.cursor = isSelPoint ? "move" : "pointer";
        if (sIdx >= 0 && typeof App.setHoveredFeature === "function") App.setHoveredFeature("point", sIdx, e.lngLat);
        return;
      }

      // Check lines, routes, and polygons
      var featureHits = safeQuery(e.point, ["lines-layer", "routes-layer", "polygons-fill"]);
      if (featureHits.length > 0) {
        map.getCanvas().style.cursor = "pointer";
        var hit = featureHits[0];
        var lid = hit.layer.id;
        if (lid === "lines-layer") {
          var lIdx = findLineIndex(hit);
          if (lIdx >= 0 && typeof App.setHoveredFeature === "function") App.setHoveredFeature("line", lIdx, e.lngLat);
        } else if (lid === "routes-layer") {
          var rIdx = findRouteIndex(hit);
          if (rIdx >= 0 && typeof App.setHoveredFeature === "function") App.setHoveredFeature("route", rIdx, e.lngLat);
        } else if (lid === "polygons-fill") {
          var pIdx = findPolygonIndex(hit);
          if (pIdx >= 0 && typeof App.setHoveredFeature === "function") App.setHoveredFeature("polygon", pIdx, e.lngLat);
        }
        return;
      }

      // Check buffer areas (point / line / route buffers)
      var bufferHits = safeQuery(e.point, ["buffers-fill", "line-buffers-fill", "route-buffers-fill"]);
      if (bufferHits.length > 0) {
        map.getCanvas().style.cursor = "pointer";
        var bHit = bufferHits[0];
        var bLid = bHit.layer.id;
        var bProps = bHit.properties || {};
        if (bLid === "buffers-fill" && bProps.pointIdx != null) {
          var bsIdx = findPointIndexByProp(bProps.pointIdx);
          if (bsIdx >= 0 && typeof App.setHoveredFeature === "function") App.setHoveredFeature("point", bsIdx, e.lngLat);
        } else if (bLid === "line-buffers-fill" && bProps.lineIdx != null) {
          var blIdx = findLineIndexByProp(bProps.lineIdx);
          if (blIdx >= 0 && typeof App.setHoveredFeature === "function") App.setHoveredFeature("line", blIdx, e.lngLat);
        } else if (bLid === "route-buffers-fill" && bProps.routeIdx != null) {
          var brIdx = findRouteIndexByProp(bProps.routeIdx);
          if (brIdx >= 0 && typeof App.setHoveredFeature === "function") App.setHoveredFeature("route", brIdx, e.lngLat);
        }
        return;
      }

      // No feature under cursor — clear hover
      if (typeof App.clearHover === "function") App.clearHover();
      map.getCanvas().style.cursor = "grab";
    });

    // ---- Mousedown: start point drag or vertex drag ----
    map.on("mousedown", function (e) {
      if (App.drawMode) return;
      if (e.originalEvent && e.originalEvent.button === 2) return; // right-click handled by contextmenu

      // Check for vertex handle drag first
      if (editState && editState.type === "vertex-edit") {
        var editHits = safeQuery(e.point, [EDIT_LAYER]);
        if (editHits.length > 0) {
          e.preventDefault();
          var vertexIdx = editHits[0].properties.vertexIdx;
          editState = {
            type: "vertex-drag",
            featureType: editState.featureType,
            featureIndex: editState.featureIndex,
            vertexIndex: vertexIdx
          };
          App._editing = editState;
          map.dragPan.disable();
          map.getCanvas().style.cursor = "grabbing";
          return;
        }
      }

      // Check for point drag — only allowed when point is already selected
      var pointHits = safeQuery(e.point, ["points-layer"]);
      if (pointHits.length > 0) {
        var ptIdx = findPointIndex(pointHits[0]);
        if (ptIdx >= 0 &&
            App._selected && App._selected.type === "point" && App._selected.index === ptIdx) {
          e.preventDefault();
          editState = { type: "point-drag", index: ptIdx };
          App._editing = editState;
          map.dragPan.disable();
          map.getCanvas().style.cursor = "grabbing";
        }
      }
    });

    // ---- Mousemove: handle active drags ----
    map.on("mousemove", function (e) {
      if (!editState) return;

      if (editState.type === "point-drag") {
        // Lightweight live update (no buffer rebuild)
        App.points[editState.index].geometry.coordinates = [e.lngLat.lng, e.lngLat.lat];
        var stSrc = map.getSource("points-src");
        if (stSrc) stSrc.setData({ type: "FeatureCollection", features: _withResolvedColor("point", App.points) });
        return;
      }

      if (editState.type === "vertex-drag") {
        var lng = e.lngLat.lng;
        var lat = e.lngLat.lat;
        if (editState.featureType === "line") {
          var line = App.lines[editState.featureIndex];
          if (line) {
            line.geometry.coordinates[editState.vertexIndex] = [lng, lat];
            var lineSrc = map.getSource("lines");
            if (lineSrc) lineSrc.setData({ type: "FeatureCollection", features: _withResolvedColor("line", App.lines) });
            // Also update saved line vertices
            var vertSrc = map.getSource("lines-vertices");
            if (vertSrc) {
              var vertFeatures = [];
              App.lines.forEach(function (l) {
                var lResolvedColor = App.resolveFeatureColor("line", l);
                l.geometry.coordinates.forEach(function (c, idx) {
                  vertFeatures.push({
                    type: "Feature",
                    properties: { lineIdx: l.properties.lineIdx, waypointIdx: idx + 1, resolvedColor: lResolvedColor },
                    geometry: { type: "Point", coordinates: c }
                  });
                });
              });
              vertSrc.setData({ type: "FeatureCollection", features: vertFeatures });
            }
          }
        } else if (editState.featureType === "route") {
          // Move the waypoint and show straight lines between all waypoints during drag.
          // The full street-snapped geometry is re-fetched from OSRM on mouseup.
          var route = App.routes[editState.featureIndex];
          if (route) {
            var wps = route.properties.waypoints;
            wps[editState.vertexIndex] = [lng, lat];
            // Temporarily display straight lines between waypoints while dragging
            route.geometry.coordinates = wps.slice();
            var routeSrc = map.getSource("routes");
            if (routeSrc) routeSrc.setData({ type: "FeatureCollection", features: _withResolvedColor("route", App.routes) });
            var routeWpSrc = map.getSource("routes-waypoints-saved");
            if (routeWpSrc) {
              var rwpFeatures = [];
              App.routes.forEach(function (r) {
                var rResolvedColor = App.resolveFeatureColor("route", r);
                (r.properties.waypoints || []).forEach(function (wp, wi) {
                  rwpFeatures.push({
                    type: "Feature",
                    properties: { routeIdx: r.properties.routeIdx, waypointIdx: wi + 1, resolvedColor: rResolvedColor },
                    geometry: { type: "Point", coordinates: wp }
                  });
                });
              });
              routeWpSrc.setData({ type: "FeatureCollection", features: rwpFeatures });
            }
          }
        } else if (editState.featureType === "polygon") {
          var poly = App.polygons[editState.featureIndex];
          if (poly) {
            var ring = poly.geometry.coordinates[0];
            ring[editState.vertexIndex] = [lng, lat];
            if (editState.vertexIndex === 0) ring[ring.length - 1] = [lng, lat];
            var polySrc = map.getSource("polygons");
            if (polySrc) polySrc.setData({ type: "FeatureCollection", features: _withResolvedColor("polygon", App.polygons) });
            var outSrc = map.getSource("polygons-outlines");
            if (outSrc) {
              outSrc.setData({
                type: "FeatureCollection",
                features: App.polygons.map(function (f) {
                  var props = {};
                  for (var k in f.properties) { if (Object.prototype.hasOwnProperty.call(f.properties, k)) props[k] = f.properties[k]; }
                  props.resolvedColor = App.resolveFeatureColor("polygon", f);
                  return {
                    type: "Feature",
                    properties: props,
                    geometry: { type: "LineString", coordinates: f.geometry.coordinates[0] }
                  };
                })
              });
            }
            var pvSrc = map.getSource("polygons-vertices");
            if (pvSrc) {
              var pvFeatures = [];
              App.polygons.forEach(function (p) {
                var pResolvedColor = App.resolveFeatureColor("polygon", p);
                var r = p.geometry.coordinates[0];
                for (var vi = 0; vi < r.length - 1; vi++) {
                  pvFeatures.push({
                    type: "Feature",
                    properties: { polyIdx: p.properties.polyIdx, vertexIdx: vi + 1, resolvedColor: pResolvedColor },
                    geometry: { type: "Point", coordinates: r[vi] }
                  });
                }
              });
              pvSrc.setData({ type: "FeatureCollection", features: pvFeatures });
            }
          }
        }
        // Update edit handle positions
        showEditVertices(editState.featureType, editState.featureIndex);
        return;
      }
    });

    // ---- Mouseup: finalize drags ----
    map.on("mouseup", function (e) {
      if (!editState) return;

      if (editState.type === "point-drag") {
        App.movePoint(editState.index, e.lngLat.lng, e.lngLat.lat);
        editState = null;
        App._editing = null;
        map.dragPan.enable();
        map.getCanvas().style.cursor = "move"; // still hovering over the (now-moved) point
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        if (typeof App.cache !== "undefined") App.cache.save();
        return;
      }

      if (editState.type === "vertex-drag") {
        // Finalize with full rebuild
        if (editState.featureType === "line") {
          App.updateLineVertex(editState.featureIndex, editState.vertexIndex, e.lngLat.lng, e.lngLat.lat);
        } else if (editState.featureType === "polygon") {
          App.updatePolygonVertex(editState.featureIndex, editState.vertexIndex, e.lngLat.lng, e.lngLat.lat);
        } else if (editState.featureType === "route") {
          // Async: re-route via OSRM after waypoint is moved. Chain post-update actions.
          var _fi = editState.featureIndex;
          var _vi = editState.vertexIndex;
          App.updateRouteWaypoint(_fi, _vi, e.lngLat.lng, e.lngLat.lat).then(function () {
            showEditVertices("route", _fi);
            if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
            if (typeof App.cache !== "undefined") App.cache.save();
          });
        }
        // Return to vertex-edit mode (keep handles shown)
        editState = {
          type: "vertex-edit",
          featureType: editState.featureType,
          featureIndex: editState.featureIndex
        };
        App._editing = editState;
        map.dragPan.enable();
        map.getCanvas().style.cursor = "move";
        showEditVertices(editState.featureType, editState.featureIndex);
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        if (typeof App.cache !== "undefined") App.cache.save();
        return;
      }
    });

    // ---- Click: enter/exit vertex edit mode, or insert vertex ----
    map.on("click", function (e) {
      if (App.drawMode) return;

      // If in vertex-edit mode
      if (editState && editState.type === "vertex-edit") {
        // Handle click on edit handles is done by mousedown; skip here
        var editHits = safeQuery(e.point, [EDIT_LAYER]);
        if (editHits.length > 0) return;

        // Check if click is on a line/route/polygon (same or different feature)
        var featureHits = safeQuery(e.point, ["lines-layer", "routes-layer", "polygons-fill", "polygons-outlines-layer"]);
        if (featureHits.length > 0) {
          var hit = featureHits[0];
          var layerId = hit.layer.id;

          if (layerId === "lines-layer") {
            var lineIdx = findLineIndex(hit);
            if (lineIdx >= 0) {
              if (lineIdx === editState.featureIndex && editState.featureType === "line") {
                insertVertex("line", lineIdx, e.lngLat);
              } else {
                exitEditMode();
                enterVertexEditMode("line", lineIdx);
              }
              return;
            }
          } else if (layerId === "routes-layer") {
            var routeIdx = findRouteIndex(hit);
            if (routeIdx >= 0) {
              if (routeIdx === editState.featureIndex && editState.featureType === "route") {
                insertVertex("route", routeIdx, e.lngLat);
              } else {
                exitEditMode();
                enterVertexEditMode("route", routeIdx);
              }
              return;
            }
          } else if (layerId === "polygons-outlines-layer") {
            // Click on polygon outline → insert vertex
            var polyIdxOut = findPolygonIndex(hit);
            if (polyIdxOut >= 0) {
              if (polyIdxOut === editState.featureIndex && editState.featureType === "polygon") {
                insertVertex("polygon", polyIdxOut, e.lngLat);
              } else {
                exitEditMode();
                enterVertexEditMode("polygon", polyIdxOut);
              }
              return;
            }
          } else if (layerId === "polygons-fill") {
            var polyIdxFill = findPolygonIndex(hit);
            if (polyIdxFill >= 0) {
              if (polyIdxFill !== editState.featureIndex || editState.featureType !== "polygon") {
                // Different polygon → switch
                exitEditMode();
                enterVertexEditMode("polygon", polyIdxFill);
              }
              // Same polygon interior → no-op (already in edit mode)
              return;
            }
          }
        }

        // Click on empty area → exit edit mode
        exitEditMode();
        return;
      }

      // Not in edit mode: point click → select; line/route/polygon click → enter vertex edit mode
      var pointHits = safeQuery(e.point, ["points-layer"]);
      if (pointHits.length > 0) {
        var sIdx = findPointIndex(pointHits[0]);
        if (sIdx >= 0 && typeof App.selectFeature === "function") App.selectFeature("point", sIdx);
        return;
      }

      var linePolyHits = safeQuery(e.point, ["lines-layer", "routes-layer", "polygons-fill"]);
      if (linePolyHits.length === 0) {
        // Check buffer areas — clicking a buffer locks the associated feature
        var bufHits = safeQuery(e.point, ["buffers-fill", "line-buffers-fill", "route-buffers-fill"]);
        if (bufHits.length > 0) {
          var bh = bufHits[0];
          var bhLid = bh.layer.id;
          var bhProps = bh.properties || {};
          if (bhLid === "buffers-fill" && bhProps.pointIdx != null) {
            var bsi = findPointIndexByProp(bhProps.pointIdx);
            if (bsi >= 0 && typeof App.selectFeature === "function") App.selectFeature("point", bsi);
          } else if (bhLid === "line-buffers-fill" && bhProps.lineIdx != null) {
            var bli = findLineIndexByProp(bhProps.lineIdx);
            if (bli >= 0 && typeof App.selectFeature === "function") App.selectFeature("line", bli);
          } else if (bhLid === "route-buffers-fill" && bhProps.routeIdx != null) {
            var bri = findRouteIndexByProp(bhProps.routeIdx);
            if (bri >= 0 && typeof App.selectFeature === "function") App.selectFeature("route", bri);
          }
          return;
        }
        // Click on truly empty area — clear selection
        if (typeof App.clearSelection === "function") App.clearSelection();
        return;
      }

      var hit2 = linePolyHits[0];
      var layerId2 = hit2.layer.id;
      if (layerId2 === "lines-layer") {
        var lineIdx2 = findLineIndex(hit2);
        if (lineIdx2 >= 0) enterVertexEditMode("line", lineIdx2);
      } else if (layerId2 === "routes-layer") {
        var routeIdx2 = findRouteIndex(hit2);
        if (routeIdx2 >= 0) enterVertexEditMode("route", routeIdx2);
      } else if (layerId2 === "polygons-fill") {
        var polyIdx2 = findPolygonIndex(hit2);
        if (polyIdx2 >= 0) enterVertexEditMode("polygon", polyIdx2);
      }
    });

    // ---- Right-click: vertex deletion (priority) or feature attributes ----
    map.on("contextmenu", function (e) {
      if (App.drawMode) return;

      // Priority 1: vertex handle hit during vertex-edit mode → delete vertex
      if (editState && editState.type === "vertex-edit") {
        var editHits = safeQuery(e.point, [EDIT_LAYER]);
        if (editHits.length > 0) {
          e.preventDefault();
          var vIdx = editHits[0].properties.vertexIdx;
          showVertexCtxMenu(
            e.originalEvent.clientX,
            e.originalEvent.clientY,
            editState.featureType,
            editState.featureIndex,
            vIdx
          );
          return;
        }
      }

      // Priority 2: feature hit → show attributes context menu
      var stHits = safeQuery(e.point, ["points-layer"]);
      var fHits  = safeQuery(e.point, ["lines-layer", "routes-layer", "polygons-fill"]);
      var hit    = (stHits.length ? stHits : fHits)[0];
      if (!hit) return;

      e.preventDefault();
      var layerId      = hit.layer.id;
      var featureType  = null;
      var featureIndex = -1;
      if      (layerId === "points-layer") { featureType = "point";  featureIndex = findPointIndex(hit); }
      else if (layerId === "lines-layer")    { featureType = "line";     featureIndex = findLineIndex(hit); }
      else if (layerId === "routes-layer")   { featureType = "route";    featureIndex = findRouteIndex(hit); }
      else if (layerId === "polygons-fill")  { featureType = "polygon";  featureIndex = findPolygonIndex(hit); }
      if (featureType === null || featureIndex < 0) return;

      if (typeof App.selectFeature === "function") App.selectFeature(featureType, featureIndex);

      var dataMap = { point: App.points, line: App.lines, route: App.routes, polygon: App.polygons };
      var feature = dataMap[featureType][featureIndex];

      if (typeof App.showContextMenu === "function") {
        var isHidden = !!feature.properties.hidden;
        App.showContextMenu(
          e.originalEvent.clientX,
          e.originalEvent.clientY,
          [
            { label: "Attributes", action: function () {
                if (typeof App.openAttrPopup === "function") App.openAttrPopup(featureType, featureIndex, feature);
            }},
            { label: "Duplicate", action: function () {
                var dupFns = { point: App.duplicatePoint, line: App.duplicateLine, route: App.duplicateRoute, polygon: App.duplicatePolygon };
                var fn = dupFns[featureType];
                if (typeof fn === "function") fn(featureIndex);
            }},
            { label: isHidden ? "Show" : "Hide", action: function () {
                feature.properties.hidden = !feature.properties.hidden;
                if (App.cache && typeof App.cache.save === "function") App.cache.save();
                if (typeof App.rerenderForType === "function") App.rerenderForType(featureType);
                if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
            }},
            { label: "Delete", action: function () {
                if (typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen()) {
                  var pf = typeof App.getAttrPopupFeature === "function" ? App.getAttrPopupFeature() : null;
                  if (pf && pf.featureType === featureType && pf.featureIndex === featureIndex) App.closeAttrPopup();
                }
                var removeFns = { point: App.removePoint, line: App.removeLine, route: App.removeRoute, polygon: App.removePolygon };
                var fn = removeFns[featureType];
                if (typeof fn === "function") fn(featureIndex);
                if (typeof App.onFeatureDelete === "function") App.onFeatureDelete();
            }}
          ]
        );
      }
    });
  }

  // ---- Expose on App namespace ----

  App._editing = null;
  App.exitEditMode = exitEditMode;
  App._initEditing = init;
  App.showEditVertices = showEditVertices; // exposed for routes.js async callbacks
})();
