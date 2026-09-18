// js/core/road-network.js
// Offline road network: Overpass download, graph construction, Dijkstra pathfinding.
// Allows local street-snapped routing when OSRM servers are unavailable.
// Depends on: App.map (map.js), App.setStatus (utils.js), turf (CDN),
//             window.WalkCost (walk-cost.js, optional — crossing penalties,
//             see docs/walkshed-bands-and-crossing-penalties-plan.md Phase 5).
// Exports: roadNetworkLoaded, findLocalRoute, fetchRoadNetwork,
//          loadRoadNetworkFromFile, exportRoadNetwork, clearRoadNetwork,
//          computeWalkshed, computeWalkCostMap, polygonizeNodeSet,
//          nodeKeyToCoord, snapWalk, getRoadDownloadExtent,
//          fetchRoadNetworkForExtent, getWalkNetworkSegments,
//          setNetworkConnectors (docs/network-connectors-plan.md)

(function () {
  "use strict";
  var App = window.App;

  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var SNAP_MAX_KM = 0.5; // max snap distance to road network (500 m)
  var DOWNLOAD_EXPAND = 1.5;     // grow the map view by this factor (each side) before downloading roads
  var MAX_AREA_WARN_KM2 = 2000;  // warn before downloading an expanded area larger than this (~a large county)
  var RDL_SRC = "road-dl-area";       // map source for the downloaded-area outline
  var RDL_LAYER = "road-dl-area-line"; // map layer for the downloaded-area outline

  // ---- Private state ----

  var _roadGeoJSON = null;  // raw GeoJSON FeatureCollection (for export)
  var _graph = null;        // Map<nodeKey, [{node, weight, coords}]>
  var _segmentIndex = null; // Array of {startKey, endKey, startCoord, endCoord, pedBlocked, carBlocked, kind} per segment
  var _segGrid = null;      // Map<"gx,gy", int[]> of _segmentIndex indices — snap acceleration, see buildSegGrid()
  var _nodeTier = null;     // Map<nodeKey, "major"|"minor"> — crossing-penalty tier per intersection node, see buildNodeTierMap()
  var _featureCount = 0;
  var _networkEpoch = 0;    // bumped on every (re)build/clear — lets caches (e.g. walkshed) invalidate
  var _downloadedBboxPolygon = null; // turf Polygon of the last Overpass download extent (for the on-map outline)

  // ---- Network Connectors overlay state (docs/network-connectors-plan.md Phase 4) ----
  // Plain geometry only — road-network.js never reads App.lines or any attribute;
  // network-connectors.js owns collecting connector Lines and calls
  // App.setNetworkConnectors() with the result. Preserved across a base-network
  // reload so a fresh Overpass download re-applies the same overlay automatically.
  var _connectors = [];        // [{ id, coords: [[lng,lat], ...] }]
  var _connectorOpts = {};     // { snapToleranceKm }
  var _lastOverlayReport = null; // last applyConnectorOverlay() result, returned by setNetworkConnectors()

  // ---- Byte formatting helper ----

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  // ---- Node key helper ----

  function nodeKey(coord) {
    return coord[0].toFixed(6) + "," + coord[1].toFixed(6);
  }

  function keyToCoord(key) {
    var parts = key.split(",");
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  }

  // ---- Pedestrian / vehicle traversability by OSM highway class ----
  // The offline network is shared by two consumers: the driving route-snapper
  // (findLocalRoute) and the walking isochrone (computeWalkshed). Each edge and
  // segment is tagged with pedBlocked / carBlocked so each consumer traverses
  // only the classes appropriate to its mode — one download, two interpretations.

  // Classes a pedestrian may not use: limited-access highways and their ramps.
  var PED_FORBIDDEN_HWY = {
    motorway: 1, trunk: 1, motorway_link: 1, trunk_link: 1
  };
  // Pedestrian/bike-only classes a car may not use.
  var CAR_FORBIDDEN_HWY = {
    footway: 1, path: 1, steps: 1, pedestrian: 1, cycleway: 1
  };

  // An explicit foot=* tag overrides the class default in both directions
  // (e.g. a trunk road signed foot=yes is walkable; a service road foot=no is not).
  function isPedForbidden(hwy, foot) {
    if (foot === "yes" || foot === "designated" || foot === "permissive") return false;
    if (foot === "no") return true;
    return !!PED_FORBIDDEN_HWY[hwy];
  }

  function isCarForbidden(hwy) {
    return !!CAR_FORBIDDEN_HWY[hwy];
  }

  // ---- Graph construction ----

  // Pushes a bidirectional edge into an explicit graph Map. Extracted from
  // buildGraph() (which calls it with its local `graph`) so applyConnectorOverlay()
  // can push connector-derived edges into the live _graph the same way.
  function addGraphEdge(graph, fromKey, toKey, weight, coordPair, pedBlocked, carBlocked, hwy) {
    hwy = hwy || "";
    if (!graph.has(fromKey)) graph.set(fromKey, []);
    graph.get(fromKey).push({ node: toKey, weight: weight, coords: coordPair, pedBlocked: pedBlocked, carBlocked: carBlocked, hwy: hwy });
    if (!graph.has(toKey)) graph.set(toKey, []);
    graph.get(toKey).push({ node: fromKey, weight: weight, coords: coordPair.slice().reverse(), pedBlocked: pedBlocked, carBlocked: carBlocked, hwy: hwy });
  }

  // Crossing-penalty tier per intersection node (docs/walkshed-bands-and-
  // crossing-penalties-plan.md Phase 5). Walks the graph once: a node's own
  // adjacency-list length equals the number of segments incident to it (each
  // incident segment contributes exactly one directed edge in that node's own
  // array), so it's exactly the "how many edges meet here" count
  // window.WalkCost.nodeTier() needs. Nodes with no penalty (fewer than 3
  // incident edges) are omitted entirely rather than stored as null.
  function buildNodeTierMap(graph) {
    var map = new Map();
    if (!graph || typeof window.WalkCost === "undefined") return map;
    graph.forEach(function (edges, key) {
      var hwyList = edges.map(function (e) { return e.hwy || ""; });
      var tier = window.WalkCost.nodeTier(hwyList);
      if (tier) map.set(key, tier);
    });
    return map;
  }

  // Removes one edge fromKey -> toKey from _graph (the first matching entry).
  // Used when applying a connector overlay's removeSegIds — the base segment's
  // two directed edges are removed so the split/weld replacement edges
  // (added separately) are the only path through that point.
  function removeGraphEdge(fromKey, toKey) {
    var edges = _graph.get(fromKey);
    if (!edges) return;
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].node === toKey) { edges.splice(i, 1); break; }
    }
  }

  function buildGraph(geojson) {
    var graph = new Map();
    var segments = [];
    var features = geojson.features || [];

    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;

    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var geom = f.geometry;
      if (!geom) continue;

      // Classify this way once; every edge/segment derived from it inherits the flags.
      // Imported networks may lack a highway/foot tag — treat unknown classes as
      // traversable by both modes so legacy road-network files still route.
      var props = f.properties || {};
      var hwy = props.highway || "";
      var pedBlocked = isPedForbidden(hwy, props.foot);
      var carBlocked = isCarForbidden(hwy);
      // Sidewalk-data plan Phase 1: captured on segments only, never on graph
      // edges (docs/sidewalk-data-plan.md §2 "Stage A does not touch graph
      // edges") — a city network has hundreds of thousands of edges and
      // nothing reads these yet. Legacy imports lack them; default to "" / null.
      var sidewalk = props.sidewalk || "";
      var footway = props.footway || "";
      var wayId = props.wayId != null ? props.wayId : null;

      var coordArrays = [];
      if (geom.type === "LineString" && geom.coordinates && geom.coordinates.length >= 2) {
        coordArrays.push(geom.coordinates);
      } else if (geom.type === "MultiLineString" && geom.coordinates) {
        for (var m = 0; m < geom.coordinates.length; m++) {
          if (geom.coordinates[m].length >= 2) coordArrays.push(geom.coordinates[m]);
        }
      }

      for (var a = 0; a < coordArrays.length; a++) {
        var coords = coordArrays[a];
        for (var j = 0; j < coords.length - 1; j++) {
          var c1 = coords[j];
          var c2 = coords[j + 1];
          var k1 = nodeKey(c1);
          var k2 = nodeKey(c2);
          var dist = turf.distance(turf.point(c1), turf.point(c2), { units: "kilometers" });
          addGraphEdge(graph, k1, k2, dist, [c1, c2], pedBlocked, carBlocked, hwy);
          segments.push({
            startKey: k1,
            endKey: k2,
            startCoord: c1,
            endCoord: c2,
            pedBlocked: pedBlocked,
            carBlocked: carBlocked,
            hwy: hwy,
            sidewalk: sidewalk,
            footway: footway,
            wayId: wayId,
            kind: "base"
          });

          if (c1[0] < minLng) minLng = c1[0]; if (c1[0] > maxLng) maxLng = c1[0];
          if (c1[1] < minLat) minLat = c1[1]; if (c1[1] > maxLat) maxLat = c1[1];
          if (c2[0] < minLng) minLng = c2[0]; if (c2[0] > maxLng) maxLng = c2[0];
          if (c2[1] < minLat) minLat = c2[1]; if (c2[1] > maxLat) maxLat = c2[1];
        }
      }
    }

    _graph = graph;
    _segmentIndex = segments;
    _segGrid = buildSegGrid(segments, minLat, maxLat, minLng, maxLng);
    _nodeTier = buildNodeTierMap(_graph);
    _featureCount = features.length;
  }

  // Rebuilds the graph from the current base GeoJSON, re-applies the connector
  // overlay, and bumps the epoch exactly once. This is the single choke point
  // every base-network load AND every connector change routes through (see
  // docs/network-connectors-plan.md §3 "Rebuild orchestration"), so connectors
  // are never merged into _roadGeoJSON and always survive a wholesale base
  // replacement (a fresh Overpass download, a file import).
  function rebuildNetwork() {
    if (_roadGeoJSON) buildGraph(_roadGeoJSON);
    applyConnectorOverlay();
    _networkEpoch++;
  }

  // ---- Network Connectors overlay (docs/network-connectors-plan.md Phase 4) ----
  //
  // Welds/splits the current _connectors into the freshly-built base graph.
  // Runs immediately after buildGraph() inside rebuildNetwork(), before the
  // epoch bump, so every consumer keyed on _networkEpoch sees the overlaid
  // graph as a single atomic update. Never reads App.lines or any attribute —
  // network-connectors.js is the only caller, via App.setNetworkConnectors(),
  // and supplies plain { id, coords } geometry.
  function applyConnectorOverlay() {
    if (!_graph || !_segmentIndex) {
      _lastOverlayReport = { reason: "no-base-network" };
      return;
    }
    if (!_connectors.length) {
      _lastOverlayReport = { addEdges: 0, removeSegIds: 0, joins: [], orphans: [] };
      return;
    }

    var candidates = collectCandidateSegments(_connectors);
    var snapToleranceKm = (_connectorOpts && _connectorOpts.snapToleranceKm) || 0;
    var result = window.ConnectorGraph.planarizeConnectors(_connectors, candidates, {
      snapToleranceKm: snapToleranceKm,
      weldVertices: true,
      splitCrossings: true // Phase 5: mid-block crossings now join too (welding shipped in Phase 4)
    });

    // Remove the base segments that got split/welded — their two directed
    // graph edges are replaced entirely by result.addEdges below.
    var removeSet = new Set(result.removeSegIds);
    removeSet.forEach(function (idx) {
      var seg = _segmentIndex[idx];
      if (!seg) return;
      removeGraphEdge(seg.startKey, seg.endKey);
      removeGraphEdge(seg.endKey, seg.startKey);
    });

    var newSegmentIndex = [];
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    function trackBbox(c) {
      if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
    }
    for (var i = 0; i < _segmentIndex.length; i++) {
      if (removeSet.has(i)) continue;
      var kept = _segmentIndex[i];
      newSegmentIndex.push(kept);
      trackBbox(kept.startCoord); trackBbox(kept.endCoord);
    }

    // Connector-derived edges are walk-only: pedBlocked false so walksheds/
    // travelsheds traverse them, carBlocked true so App.findLocalRoute (driving)
    // never does — connectors must not affect drive routing.
    for (var e = 0; e < result.addEdges.length; e++) {
      var edge = result.addEdges[e];
      var a = edge.coords[0], b = edge.coords[1];
      var ka = nodeKey(a), kb = nodeKey(b);
      var distKm = turf.distance(turf.point(a), turf.point(b), { units: "kilometers" });
      addGraphEdge(_graph, ka, kb, distKm, [a, b], false, true);
      newSegmentIndex.push({
        startKey: ka, endKey: kb, startCoord: a, endCoord: b,
        pedBlocked: false, carBlocked: true, kind: "connector"
      });
      trackBbox(a); trackBbox(b);
    }

    _segmentIndex = newSegmentIndex;
    _segGrid = buildSegGrid(_segmentIndex, minLat, maxLat, minLng, maxLng);
    _nodeTier = buildNodeTierMap(_graph);

    _lastOverlayReport = {
      addEdges: result.addEdges.length,
      removeSegIds: result.removeSegIds.length,
      joins: result.joins,
      orphans: result.orphans
    };
  }

  // Candidate base segments near the connectors, queried from _segGrid: for
  // each connector sub-segment, the cell range it touches (same gxMin..gxMax /
  // gyMin..gyMax the segment's own grid insertion in buildSegGrid used),
  // expanded by 1 cell in every direction so a connector endpoint near a cell
  // boundary still finds neighbors just across it. Deduped by segment index.
  function collectCandidateSegments(connectors) {
    var idxSet = new Set();
    for (var ci = 0; ci < connectors.length; ci++) {
      var coords = connectors[ci].coords;
      for (var j = 0; j < coords.length - 1; j++) {
        var cellA = gridCellOf(coords[j][0], coords[j][1]);
        var cellB = gridCellOf(coords[j + 1][0], coords[j + 1][1]);
        var gxMin = Math.min(cellA[0], cellB[0]) - 1, gxMax = Math.max(cellA[0], cellB[0]) + 1;
        var gyMin = Math.min(cellA[1], cellB[1]) - 1, gyMax = Math.max(cellA[1], cellB[1]) + 1;
        for (var gx = gxMin; gx <= gxMax; gx++) {
          for (var gy = gyMin; gy <= gyMax; gy++) {
            var bucket = _segGrid.get(gridKey(gx, gy));
            if (!bucket) continue;
            for (var bi = 0; bi < bucket.length; bi++) idxSet.add(bucket[bi]);
          }
        }
      }
    }
    var candidates = [];
    idxSet.forEach(function (idx) {
      var seg = _segmentIndex[idx];
      candidates.push({ segId: idx, coords: [seg.startCoord, seg.endCoord], pedBlocked: seg.pedBlocked });
    });
    return candidates;
  }

  // ---- Spatial grid over segments (snap acceleration) ----
  //
  // snapToNetwork() is called once per stop/origin and previously scanned
  // EVERY segment in the network (turf.lineString + turf.nearestPointOnLine
  // per segment) to find the nearest one. On a city-scale Overpass download
  // (tens of thousands of segments once footways/paths are included) that is
  // 1-3 seconds PER CALL — the actual bottleneck behind "Walking from stop
  // x/y" crawling, not the flood itself (which capped-radius floods already
  // shrank). A uniform grid keyed by ~0.5 km cells (matching SNAP_MAX_KM, the
  // hard rejection radius) lets snapToNetwork query only the segments near
  // the point instead of all of them. (_segGrid itself is declared in the
  // Private state block above.)

  // Cell size in degrees, derived from the network's own bbox mid-latitude so
  // a cell is close to a real 0.5 km square regardless of where the network
  // is (longitude degrees shrink toward the poles; latitude degrees don't).
  var _gridLatDeg = 0.5 / 110.574;
  var _gridLngDeg = 0.5 / 111.32; // recomputed per network from mid-latitude below

  function gridCellOf(lng, lat) {
    return [Math.floor(lng / _gridLngDeg), Math.floor(lat / _gridLatDeg)];
  }

  function gridKey(gx, gy) { return gx + "," + gy; }

  function buildSegGrid(segments, minLat, maxLat, minLng, maxLng) {
    var grid = new Map();
    if (!segments.length) return grid;

    var midLat = (minLat + maxLat) / 2;
    _gridLatDeg = 0.5 / 110.574;
    _gridLngDeg = 0.5 / (111.32 * Math.cos(midLat * Math.PI / 180));

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var lngA = seg.startCoord[0], latA = seg.startCoord[1];
      var lngB = seg.endCoord[0], latB = seg.endCoord[1];
      var cellA = gridCellOf(lngA, latA);
      var cellB = gridCellOf(lngB, latB);
      var gxMin = Math.min(cellA[0], cellB[0]), gxMax = Math.max(cellA[0], cellB[0]);
      var gyMin = Math.min(cellA[1], cellB[1]), gyMax = Math.max(cellA[1], cellB[1]);

      for (var gx = gxMin; gx <= gxMax; gx++) {
        for (var gy = gyMin; gy <= gyMax; gy++) {
          var key = gridKey(gx, gy);
          var bucket = grid.get(key);
          if (!bucket) { bucket = []; grid.set(key, bucket); }
          bucket.push(i);
        }
      }
    }
    return grid;
  }

  // ---- Snap to network ----

  // Nearest point on segment A-B to the query point, all in local km space
  // (equirectangular projection around the query point — accurate at the
  // sub-km scale SNAP_MAX_KM operates at, with no turf feature allocation).
  // The query point is the local origin (0,0), so the standard point-segment
  // projection formula collapses to just A/B/t. Returns { distKm, lng, lat }.
  function nearestOnSegmentKm(queryLng, queryLat, kmPerDegLng, kmPerDegLat, aLng, aLat, bLng, bLat) {
    var ax = (aLng - queryLng) * kmPerDegLng, ay = (aLat - queryLat) * kmPerDegLat;
    var bx = (bLng - queryLng) * kmPerDegLng, by = (bLat - queryLat) * kmPerDegLat;
    var dx = bx - ax, dy = by - ay;
    var t;
    if (dx === 0 && dy === 0) {
      t = 0;
    } else {
      t = -(ax * dx + ay * dy) / (dx * dx + dy * dy);
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    var nx = ax + t * dx, ny = ay + t * dy;
    return {
      distKm: Math.sqrt(nx * nx + ny * ny),
      lng: queryLng + nx / kmPerDegLng,
      lat: queryLat + ny / kmPerDegLat
    };
  }

  //   mode: "walk" | "drive" | undefined. Restricts the snap to segments the
  //   mode can actually traverse (walk excludes motorways; drive excludes
  //   footways). Undefined falls back to all segments (legacy / mode-agnostic
  //   callers).
  //
  // Queries only the 3x3 grid-cell neighborhood around the point (~1.5 km sq,
  // cells sized to SNAP_MAX_KM — see the "Spatial grid over segments" comment
  // above buildSegGrid()) instead of scanning every segment in the network.
  // That neighborhood always covers the full SNAP_MAX_KM rejection radius
  // (a segment further than one cell outside the query's own cell is always
  // >= SNAP_MAX_KM away), so results match a full scan; an empty neighborhood
  // means nothing is within range, same as today's null return.
  function snapToNetwork(lngLat, mode) {
    if (!_segmentIndex || _segmentIndex.length === 0 || !_segGrid) return null;

    var blockedField = null;
    if (mode === "walk") blockedField = "pedBlocked";
    else if (mode === "drive") blockedField = "carBlocked";

    var queryLng = lngLat[0], queryLat = lngLat[1];
    var kmPerDegLat = 110.574;
    var kmPerDegLng = 111.32 * Math.cos(queryLat * Math.PI / 180);

    var cell = gridCellOf(queryLng, queryLat);
    var gx0 = cell[0], gy0 = cell[1];

    var seen = new Set(); // a segment can span multiple cells; dedupe
    var bestDist = Infinity;
    var bestSeg = null;
    var bestLng = null, bestLat = null;

    for (var gx = gx0 - 1; gx <= gx0 + 1; gx++) {
      for (var gy = gy0 - 1; gy <= gy0 + 1; gy++) {
        var bucket = _segGrid.get(gridKey(gx, gy));
        if (!bucket) continue;
        for (var bi = 0; bi < bucket.length; bi++) {
          var idx = bucket[bi];
          if (seen.has(idx)) continue;
          seen.add(idx);

          var seg = _segmentIndex[idx];
          if (blockedField && seg[blockedField]) continue; // skip segments this mode can't use

          var np = nearestOnSegmentKm(queryLng, queryLat, kmPerDegLng, kmPerDegLat,
            seg.startCoord[0], seg.startCoord[1], seg.endCoord[0], seg.endCoord[1]);
          if (np.distKm < bestDist) {
            bestDist = np.distKm;
            bestSeg = seg;
            bestLng = np.lng;
            bestLat = np.lat;
          }
        }
      }
    }

    if (!bestSeg || bestDist > SNAP_MAX_KM) return null;

    var snappedCoord = [bestLng, bestLat];

    // Insert the snapped point into the graph temporarily by connecting it to both segment endpoints
    return {
      coord: snappedCoord,
      key: nodeKey(snappedCoord),
      segStartKey: bestSeg.startKey,
      segEndKey: bestSeg.endKey,
      segStartCoord: bestSeg.startCoord,
      segEndCoord: bestSeg.endCoord,
      dist: bestDist
    };
  }

  // ---- Dijkstra shortest path ----

  // Simple binary min-heap for the priority queue
  function MinHeap() {
    this.data = [];
  }
  MinHeap.prototype.push = function (item) {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  };
  MinHeap.prototype.pop = function () {
    var top = this.data[0];
    var last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  };
  MinHeap.prototype.size = function () { return this.data.length; };
  MinHeap.prototype._bubbleUp = function (i) {
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (this.data[i].dist < this.data[parent].dist) {
        var tmp = this.data[i]; this.data[i] = this.data[parent]; this.data[parent] = tmp;
        i = parent;
      } else break;
    }
  };
  MinHeap.prototype._sinkDown = function (i) {
    var n = this.data.length;
    while (true) {
      var left = 2 * i + 1, right = 2 * i + 2, smallest = i;
      if (left < n && this.data[left].dist < this.data[smallest].dist) smallest = left;
      if (right < n && this.data[right].dist < this.data[smallest].dist) smallest = right;
      if (smallest === i) break;
      var tmp = this.data[i]; this.data[i] = this.data[smallest]; this.data[smallest] = tmp;
      i = smallest;
    }
  };

  function dijkstra(startKey, endKey) {
    if (!_graph || !_graph.has(startKey) || !_graph.has(endKey)) return null;
    if (startKey === endKey) return [keyToCoord(startKey)];

    var dist = new Map();
    var prev = new Map();
    var heap = new MinHeap();

    dist.set(startKey, 0);
    heap.push({ node: startKey, dist: 0 });

    while (heap.size() > 0) {
      var current = heap.pop();
      if (current.dist > (dist.get(current.node) || Infinity)) continue;
      if (current.node === endKey) break;

      var neighbors = _graph.get(current.node);
      if (!neighbors) continue;

      for (var i = 0; i < neighbors.length; i++) {
        var nb = neighbors[i];
        if (nb.carBlocked) continue; // driving router never routes over pedestrian-only ways
        var newDist = current.dist + nb.weight;
        if (newDist < (dist.get(nb.node) || Infinity)) {
          dist.set(nb.node, newDist);
          prev.set(nb.node, { from: current.node, coords: nb.coords });
          heap.push({ node: nb.node, dist: newDist });
        }
      }
    }

    if (!prev.has(endKey) && startKey !== endKey) return null;

    // Reconstruct path
    var path = [];
    var cur = endKey;
    while (cur !== startKey) {
      var step = prev.get(cur);
      if (!step) return null;
      // step.coords goes from step.from → cur
      // Add the endpoint (cur's coord)
      path.unshift(keyToCoord(cur));
      cur = step.from;
    }
    path.unshift(keyToCoord(startKey));
    return path;
  }

  // ---- Public route finder ----

  function findLocalRoute(waypoints) {
    if (!_graph || waypoints.length < 2) return null;

    // Temporarily inject snap nodes into graph
    var tempEdges = []; // track what we add so we can clean up

    function injectSnapNode(snap) {
      var k = snap.key;
      if (_graph.has(k)) return; // already a real node

      _graph.set(k, []);

      // Connect snapped point to both segment endpoints
      var d1 = turf.distance(turf.point(snap.coord), turf.point(snap.segStartCoord), { units: "kilometers" });
      var d2 = turf.distance(turf.point(snap.coord), turf.point(snap.segEndCoord), { units: "kilometers" });

      _graph.get(k).push({ node: snap.segStartKey, weight: d1, coords: [snap.coord, snap.segStartCoord] });
      _graph.get(k).push({ node: snap.segEndKey, weight: d2, coords: [snap.coord, snap.segEndCoord] });

      if (_graph.has(snap.segStartKey)) {
        _graph.get(snap.segStartKey).push({ node: k, weight: d1, coords: [snap.segStartCoord, snap.coord] });
        tempEdges.push({ mapKey: snap.segStartKey, node: k });
      }
      if (_graph.has(snap.segEndKey)) {
        _graph.get(snap.segEndKey).push({ node: k, weight: d2, coords: [snap.segEndCoord, snap.coord] });
        tempEdges.push({ mapKey: snap.segEndKey, node: k });
      }

      tempEdges.push({ mapKey: k, isNew: true });
    }

    function cleanupTempNodes() {
      for (var i = 0; i < tempEdges.length; i++) {
        var te = tempEdges[i];
        if (te.isNew) {
          _graph.delete(te.mapKey);
        } else {
          // Remove the edge pointing to the temp node
          var edges = _graph.get(te.mapKey);
          if (edges) {
            for (var j = edges.length - 1; j >= 0; j--) {
              if (edges[j].node === te.node) { edges.splice(j, 1); break; }
            }
          }
        }
      }
    }

    var allCoords = [];

    try {
      for (var i = 0; i < waypoints.length - 1; i++) {
        var fromWp = waypoints[i];
        var toWp = waypoints[i + 1];

        var snapFrom = snapToNetwork(fromWp, "drive");
        var snapTo = snapToNetwork(toWp, "drive");

        if (!snapFrom || !snapTo) return null; // waypoint outside network coverage

        injectSnapNode(snapFrom);
        injectSnapNode(snapTo);

        var path = dijkstra(snapFrom.key, snapTo.key);
        if (!path || path.length < 2) return null; // no route found

        // Append path, dedup junction point
        if (allCoords.length > 0) {
          path = path.slice(1); // skip first point (same as last of previous segment)
        }
        allCoords = allCoords.concat(path);
      }
    } finally {
      cleanupTempNodes();
    }

    return allCoords.length >= 2 ? allCoords : null;
  }

  // ---- Overpass download ----

  // Shared streamed Overpass fetch + graph build, extracted so any caller can
  // download roads for a caller-supplied extent (not just the current map view).
  //   bounds        : { s, w, n, e } — Overpass query bbox (south, west, north, east)
  //   extentPolygon : Feature<Polygon> — recorded as the downloaded extent (drives
  //                   the dashed on-map outline and App.getRoadDownloadExtent()).
  // This REPLACES the loaded network wholesale (same as fetchRoadNetwork today)
  // and bumps _networkEpoch via buildGraph(), so all module caches (walkshed,
  // travelshed) invalidate automatically. Returns Promise<boolean> (true = loaded).
  async function fetchNetworkForBounds(bounds, extentPolygon) {
    // Guard against very large downloads. Overpass file size is unknowable up front,
    // so gate on the extent area (km\u00b2): warn and let the user cancel above the threshold.
    var areaKm2 = turf.area(extentPolygon) / 1e6;
    if (areaKm2 > MAX_AREA_WARN_KM2) {
      var proceed = window.confirm(
        "This will download roads for ~" + Math.round(areaKm2).toLocaleString() + " km\u00b2.\n\n" +
        "That may be a large, slow download and Overpass can time out on very big areas. Continue?");
      if (!proceed) {
        App.setStatus("Road network download cancelled");
        return false;
      }
    }

    // Pull vehicle roads AND pedestrian-specific ways (footway/path/steps/etc.)
    // so walksheds follow real walking connections. Each class is later tagged
    // pedBlocked/carBlocked in buildGraph so drive-routing and walking each use
    // only the appropriate subset.
    var query = '[out:json][timeout:60];(' +
      'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|' +
      'residential|unclassified|service|motorway_link|trunk_link|' +
      'primary_link|secondary_link|tertiary_link|' +
      'living_street|pedestrian|footway|path|steps|cycleway)$"](' +
      bounds.s + ',' + bounds.w + ',' + bounds.n + ',' + bounds.e + ');' +
      ');out geom;';

    App.setStatus("Downloading road network\u2026");

    try {
      var resp = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      });

      if (!resp.ok) throw new Error("Overpass API error: " + resp.status);

      // Stream the response to track download progress
      var contentLength = parseInt(resp.headers.get("Content-Length") || "0", 10);
      var reader = resp.body.getReader();
      var receivedBytes = 0;
      var chunks = [];
      var lastUpdate = 0;

      while (true) {
        var result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
        receivedBytes += result.value.length;

        // Throttle status updates to every 200ms
        var now = Date.now();
        if (now - lastUpdate > 200) {
          lastUpdate = now;
          var msg = "Downloading road network\u2026 " + formatBytes(receivedBytes);
          if (contentLength > 0) {
            msg += " / " + formatBytes(contentLength) +
              " (" + Math.round((receivedBytes / contentLength) * 100) + "%)";
          }
          App.setStatus(msg);
        }
      }

      // Parse the downloaded data
      App.setStatus("Parsing road network (" + formatBytes(receivedBytes) + ")\u2026");
      var combined = new Uint8Array(receivedBytes);
      var offset = 0;
      for (var c = 0; c < chunks.length; c++) {
        combined.set(chunks[c], offset);
        offset += chunks[c].length;
      }
      var data = JSON.parse(new TextDecoder().decode(combined));
      var elements = data.elements || [];

      if (elements.length === 0) {
        App.setStatus("No roads found in this area");
        return false;
      }

      // Convert Overpass JSON to GeoJSON with progress updates
      var features = [];
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
        var coords = el.geometry.map(function (g) { return [g.lon, g.lat]; });
        features.push({
          type: "Feature",
          properties: {
            highway: (el.tags || {}).highway || "",
            name: (el.tags || {}).name || "",
            oneway: (el.tags || {}).oneway || "",
            foot: (el.tags || {}).foot || "",
            // Sidewalk-data plan (docs/sidewalk-data-plan.md) Phase 1: out geom;
            // already returns every tag and the element id, so reading these
            // three adds nothing to the download — parse-side only.
            sidewalk: (el.tags || {}).sidewalk || "",
            footway: (el.tags || {}).footway || "",
            crossing: (el.tags || {}).crossing || "",
            wayId: el.id
          },
          geometry: { type: "LineString", coordinates: coords }
        });

        // Update status every 500 elements and yield to keep UI responsive
        if (i % 500 === 0 && i > 0) {
          App.setStatus("Building routing graph (" +
            (i + 1).toLocaleString() + " / " + elements.length.toLocaleString() + " ways)\u2026");
          await new Promise(function (r) { setTimeout(r, 0); });
        }
      }

      var geojson = { type: "FeatureCollection", features: features };

      // Build graph + re-apply the connector overlay (synchronous — fast for
      // regional networks), bumping the epoch exactly once.
      _roadGeoJSON = geojson;
      rebuildNetwork();
      _downloadedBboxPolygon = extentPolygon; // record the fetched extent for the on-map outline

      updateUI();
      App.setStatus(_featureCount.toLocaleString() + " road segments loaded \u2014 local routing enabled");
      return true;
    } catch (e) {
      App.setStatus("Road network download failed: " + (e.message || e));
      return false;
    }
  }

  async function fetchRoadNetwork() {
    if (!App.map) return;

    // Prevent double-clicks
    var btn = document.getElementById("road-net-download");
    if (btn) btn.disabled = true;

    try {
      // Expand the current view by DOWNLOAD_EXPAND on each side (about the view centroid)
      // so roads just beyond the visible edge are included (routes/walksheds near the edge
      // otherwise hit missing streets). transformScale(1.5) grows width & height \u00d71.5.
      var b = App.map.getBounds();
      var viewPoly = turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      var scaled = turf.transformScale(viewPoly, DOWNLOAD_EXPAND);
      var eb = turf.bbox(scaled); // [west, south, east, north]
      var west = eb[0], south = clampLat(eb[1]), east = eb[2], north = clampLat(eb[3]);

      await fetchNetworkForBounds({ s: south, w: west, n: north, e: east }, scaled);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- File import / export ----

  function loadRoadNetworkFromFile(file) {
    App.setStatus("Loading road network from file\u2026");
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var geojson = JSON.parse(e.target.result);
        if (!geojson.features || geojson.features.length === 0) {
          App.setStatus("No features found in file");
          return;
        }
        _roadGeoJSON = geojson;
        rebuildNetwork();
        _downloadedBboxPolygon = null; // imported file has no "download area" — draw no outline
        updateUI();
        App.setStatus(_featureCount.toLocaleString() + " road segments loaded from " + file.name);
      } catch (err) {
        App.setStatus("Failed to parse road network: " + (err.message || err));
      }
    };
    reader.readAsText(file);
  }

  function exportRoadNetwork() {
    if (!_roadGeoJSON) {
      App.setStatus("No road network to export");
      return;
    }
    var blob = new Blob([JSON.stringify(_roadGeoJSON)], { type: "application/geo+json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "road-network-" + new Date().toISOString().slice(0, 10) + ".geojson";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function clearRoadNetwork() {
    _roadGeoJSON = null;
    _graph = null;
    _segmentIndex = null;
    _segGrid = null;
    _nodeTier = null;
    _featureCount = 0;
    _networkEpoch++;
    _downloadedBboxPolygon = null;
    _lastOverlayReport = null; // _connectors/_connectorOpts persist — reapplied on next load
    updateUI();
  }

  // ---- UI helpers ----

  function clampLat(v) { return Math.max(-90, Math.min(90, v)); }

  // Draw / update / remove the subtle rectangle showing the last downloaded extent.
  // Mirrors the Municipal Boundaries border style (dashed line) in a distinct fuchsia.
  // Driven from updateUI() so download / import / clear all stay in sync.
  function renderDownloadArea() {
    var map = App.map;
    if (!map) return;
    if (!_downloadedBboxPolygon) {
      if (map.getLayer(RDL_LAYER)) map.removeLayer(RDL_LAYER);
      if (map.getSource(RDL_SRC)) map.removeSource(RDL_SRC);
      return;
    }
    var fc = { type: "FeatureCollection", features: [_downloadedBboxPolygon] };
    if (!map.getSource(RDL_SRC)) {
      map.addSource(RDL_SRC, { type: "geojson", data: fc });
      map.addLayer({
        id: RDL_LAYER,
        type: "line",
        source: RDL_SRC,
        paint: {
          "line-color": "#c026d3",
          "line-width": 1.5,
          "line-dasharray": [4, 3],
          "line-opacity": 0.85
        }
      });
    } else {
      map.getSource(RDL_SRC).setData(fc);
    }
  }

  function updateUI() {
    var loaded = !!_graph;

    // Show/hide export button in Export dropdown
    var exportBtn = document.getElementById("export-road-net");
    if (exportBtn) exportBtn.style.display = loaded ? "" : "none";

    // Reconcile the on-map downloaded-area outline with current state.
    renderDownloadArea();

    // Reconcile the discreet walk-network reference layer (network-connectors.js).
    if (typeof App.refreshWalkNetworkLayer === "function") App.refreshWalkNetworkLayer();
  }

  // ---- Walkshed (network isochrone) ----

  // Budget-limited flood Dijkstra: settle every node whose cumulative distance
  // from startKey is <= budgetKm. Unlike dijkstra() there is no endKey early-exit;
  // we prune any relaxation that would exceed the budget so the search stays local.
  //   penaltyKm : optional { major, minor } km values (docs/walkshed-bands-and-
  //               crossing-penalties-plan.md Phase 5) — added to newDist when
  //               arriving at a node classified in _nodeTier, so the budget
  //               check below correctly prunes an over-budget crossing. null/
  //               absent = no penalty, byte-identical to pre-Phase-5 behavior.
  // Returns a Map<nodeKey, distKm> of all settled nodes within budget.
  function floodDijkstra(startKey, budgetKm, penaltyKm) {
    var dist = new Map();
    var heap = new MinHeap();

    dist.set(startKey, 0);
    heap.push({ node: startKey, dist: 0 });

    while (heap.size() > 0) {
      var current = heap.pop();
      if (current.dist > (dist.get(current.node) || Infinity)) continue; // stale

      var neighbors = _graph.get(current.node);
      if (!neighbors) continue;

      for (var i = 0; i < neighbors.length; i++) {
        var nb = neighbors[i];
        if (nb.pedBlocked) continue; // pedestrians can't walk motorways/trunk roads
        var newDist = current.dist + nb.weight;
        if (penaltyKm) {
          var tier = _nodeTier.get(nb.node);
          if (tier) newDist += (tier === "major" ? penaltyKm.major : penaltyKm.minor);
        }
        if (newDist > budgetKm) continue; // beyond walk budget — don't settle
        if (newDist < (dist.get(nb.node) || Infinity)) {
          dist.set(nb.node, newDist);
          heap.push({ node: nb.node, dist: newDist });
        }
      }
    }
    return dist;
  }

  // Build a walkshed polygon from reachable node coordinates.
  // v1: concave hull with an auto-relax loop (grow maxEdge until turf.concave
  // returns non-null), falling back to convex hull, then a small buffer for
  // degenerate (<3 node) cases so downstream turf.union/intersect always have
  // a valid Polygon/MultiPolygon to work with.
  function buildWalkshedPolygon(coords, maxEdgeKm) {
    if (!coords || coords.length === 0) return null;
    var pts = [];
    for (var i = 0; i < coords.length; i++) pts.push(turf.point(coords[i]));
    var fc = turf.featureCollection(pts);

    if (coords.length < 3) {
      try { return turf.buffer(fc, 0.03, { units: "kilometers" }); } catch (e) { return null; }
    }

    var maxEdge = maxEdgeKm && maxEdgeKm > 0 ? maxEdgeKm : 0.3;
    for (var attempt = 0; attempt < 8; attempt++) {
      var hull = null;
      try { hull = turf.concave(fc, { maxEdge: maxEdge, units: "kilometers" }); } catch (e) { hull = null; }
      if (hull) return hull;
      maxEdge *= 1.8;
    }
    try { return turf.convex(fc); } catch (e2) { return null; }
  }

  // Budget-limited flood from an arbitrary walk origin, shared by every walk-
  // isochrone consumer (Walkshed module, Transit Travelshed engine). Injects a
  // temp origin node, floods, and cleans up the temp node — all inside this one
  // synchronous call (mirrors findLocalRoute's inject/cleanup pattern). Callers
  // may await-yield BETWEEN calls, never during: the graph mutation is not
  // async-safe.
  //   lngLat   : [lng, lat] origin
  //   budgetKm : maximum network walking distance in km
  //   opts     : optional { crossingPenaltyKm: {major, minor} } — threaded to
  //              floodDijkstra (docs/walkshed-bands-and-crossing-penalties-plan.md
  //              Phase 5). Absent/no crossingPenaltyKm = no penalty, unchanged
  //              behavior — computeWalkCostMap deliberately never passes this.
  // Returns null when no network is loaded or the origin is outside walkable
  // coverage (snap > SNAP_MAX_KM). Otherwise { distMap: Map<nodeKey,distKm>,
  // snap, computeMs, snapMs, floodMs }. snapMs/floodMs split the total so
  // callers doing many of these (e.g. Transit Travelshed's per-stop floods)
  // can diagnose whether time is going to snapping or to the Dijkstra flood
  // itself — see the "Spatial grid over segments" comment above buildSegGrid().
  function runWalkFlood(lngLat, budgetKm, opts) {
    if (!_graph || !(budgetKm > 0)) return null;

    var t0 = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();

    var snap = snapToNetwork(lngLat, "walk");

    var tSnap = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();

    if (!snap) return null; // origin outside walkable network coverage

    // Temp origin-node injection (mirrors findLocalRoute's pattern).
    var tempEdges = [];

    function injectSnapNode(s) {
      var k = s.key;
      if (_graph.has(k)) return; // already a real node
      _graph.set(k, []);
      var d1 = turf.distance(turf.point(s.coord), turf.point(s.segStartCoord), { units: "kilometers" });
      var d2 = turf.distance(turf.point(s.coord), turf.point(s.segEndCoord), { units: "kilometers" });
      _graph.get(k).push({ node: s.segStartKey, weight: d1, coords: [s.coord, s.segStartCoord] });
      _graph.get(k).push({ node: s.segEndKey, weight: d2, coords: [s.coord, s.segEndCoord] });
      if (_graph.has(s.segStartKey)) {
        _graph.get(s.segStartKey).push({ node: k, weight: d1, coords: [s.segStartCoord, s.coord] });
        tempEdges.push({ mapKey: s.segStartKey, node: k });
      }
      if (_graph.has(s.segEndKey)) {
        _graph.get(s.segEndKey).push({ node: k, weight: d2, coords: [s.segEndCoord, s.coord] });
        tempEdges.push({ mapKey: s.segEndKey, node: k });
      }
      tempEdges.push({ mapKey: k, isNew: true });
    }

    function cleanupTempNodes() {
      for (var i = 0; i < tempEdges.length; i++) {
        var te = tempEdges[i];
        if (te.isNew) {
          _graph.delete(te.mapKey);
        } else {
          var edges = _graph.get(te.mapKey);
          if (edges) {
            for (var j = edges.length - 1; j >= 0; j--) {
              if (edges[j].node === te.node) { edges.splice(j, 1); break; }
            }
          }
        }
      }
    }

    var distMap;
    try {
      injectSnapNode(snap);
      distMap = floodDijkstra(snap.key, budgetKm, opts && opts.crossingPenaltyKm);
    } finally {
      cleanupTempNodes();
    }

    var t1 = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();

    return {
      distMap: distMap,
      snap: snap,
      computeMs: Math.round(t1 - t0),
      snapMs: Math.round(tSnap - t0),
      floodMs: Math.round(t1 - tSnap)
    };
  }

  // Compute a network walkshed (walking isochrone) from an arbitrary origin.
  //   lngLat   : [lng, lat] origin
  //   budgetKm : maximum network walking distance in km (= speedKmh * minutes/60)
  //   options  : { maxEdge,       — advanced concave-hull edge length (km)
  //               budgetsKm,     — OPTIONAL ascending array of km values; when
  //                                 present, floods once at max(budgetsKm) and
  //                                 returns one nested polygon per entry (see
  //                                 `polygons` below). Absent = today's behavior,
  //                                 byte-identical — see
  //                                 docs/walkshed-bands-and-crossing-penalties-plan.md
  //                                 Phase 2.
  //               crossingPenaltyKm } — OPTIONAL { major, minor } km values,
  //                                 threaded to the flood (Phase 5). Absent/zero
  //                                 = no penalty, byte-identical to pre-Phase-5
  //                                 output — this is a hard backward-compat
  //                                 requirement, verified pixel-identical at 0.
  // Returns null when no network is loaded or the origin is outside coverage
  // (snap > SNAP_MAX_KM). Otherwise { polygon, reachableSegments, reachableCount,
  // snap, computeMs }. Built on top of runWalkFlood — the graph mutation stays
  // atomic there; polygon/segment assembly below never touches the graph.
  // When options.budgetsKm is present the return additionally carries
  // `polygons: [{budgetKm, polygon, nodeCount}]` (ascending, one entry per
  // budgetsKm value — a degenerate/sparse band still gets an entry with
  // polygon: null, never dropped); polygon/reachableSegments/reachableCount
  // remain the LARGEST budget's values, unchanged in meaning.
  function computeWalkshed(lngLat, budgetKm, options) {
    options = options || {};

    var flood = runWalkFlood(lngLat, budgetKm, options);
    if (!flood) return null;
    var distMap = flood.distMap;
    var snap = flood.snap;

    // Reachable node coordinates (includes the injected origin).
    var coords = [];
    distMap.forEach(function (d, key) { coords.push(keyToCoord(key)); });

    // Reachable street segments: both endpoints settled within budget.
    var segFeatures = [];
    for (var si = 0; si < _segmentIndex.length; si++) {
      var seg = _segmentIndex[si];
      if (seg.pedBlocked) continue; // don't draw motorways/trunk as reachable walking streets
      if (distMap.has(seg.startKey) && distMap.has(seg.endKey)) {
        segFeatures.push(turf.lineString([seg.startCoord, seg.endCoord]));
      }
    }
    // Origin connector stubs (snap point → its bracketing segment endpoints)
    // so the reachable-segments layer visibly ties back to the origin.
    if (distMap.has(snap.segStartKey)) segFeatures.push(turf.lineString([snap.coord, snap.segStartCoord]));
    if (distMap.has(snap.segEndKey)) segFeatures.push(turf.lineString([snap.coord, snap.segEndCoord]));

    var polygon = buildWalkshedPolygon(coords, options.maxEdge);

    var result = {
      polygon: polygon,
      reachableSegments: turf.featureCollection(segFeatures),
      reachableCount: distMap.size,
      snap: snap,
      computeMs: flood.computeMs,
      snapMs: flood.snapMs,
      floodMs: flood.floodMs
    };

    if (options.budgetsKm && options.budgetsKm.length) {
      var polygons = [];
      for (var bi = 0; bi < options.budgetsKm.length; bi++) {
        var b = options.budgetsKm[bi];
        var bandCoords = [];
        distMap.forEach(function (d, key) { if (d <= b) bandCoords.push(keyToCoord(key)); });
        polygons.push({
          budgetKm: b,
          polygon: buildWalkshedPolygon(bandCoords, options.maxEdge),
          nodeCount: bandCoords.length
        });
      }
      result.polygons = polygons;
    }

    return result;
  }

  // Same flood as computeWalkshed, but returns the raw per-node cost map instead
  // of a polygon — the primitive the Transit Travelshed engine needs to compute
  // "time to reach this stop from any other cost map" without re-flooding.
  //   Returns null when no network / origin off-network. Otherwise
  //   { distMap: Map<nodeKey,distKm>, snap, accessNodes: [{nodeKey, extraKm} x2],
  //     computeMs }.
  // accessNodes: the straight-line km from the snap coord to each bracketing
  // segment endpoint — lets a caller compute "time to reach the snap point from
  // any other cost map" as min(map[k1]+e1, map[k2]+e2) x walkMinPerKm, with no
  // turf and no O(nodes) map intersection per stop pair.
  function computeWalkCostMap(lngLat, budgetKm) {
    var flood = runWalkFlood(lngLat, budgetKm);
    if (!flood) return null;
    var snap = flood.snap;
    var accessNodes = [
      { nodeKey: snap.segStartKey, extraKm: turf.distance(turf.point(snap.coord), turf.point(snap.segStartCoord), { units: "kilometers" }) },
      { nodeKey: snap.segEndKey,   extraKm: turf.distance(turf.point(snap.coord), turf.point(snap.segEndCoord),   { units: "kilometers" }) }
    ];
    return {
      distMap: flood.distMap,
      snap: snap,
      accessNodes: accessNodes,
      computeMs: flood.computeMs,
      snapMs: flood.snapMs,
      floodMs: flood.floodMs
    };
  }

  // ---- Walk network segment accessor (js/core/network-connectors.js) ----

  // Plain-array (not turf FeatureCollection) view of every walkable segment in
  // the graph, for the discreet reference layer network-connectors.js renders.
  // kind is "base" (from the OSM download/import) or "connector" (from the
  // Phase 4 overlay — see applyConnectorOverlay()). Cached by _networkEpoch
  // since a city network has tens of thousands of segments and this is called
  // on every layer refresh.
  var _walkSegCache = null;   // { epoch, segments }
  function getWalkNetworkSegments() {
    if (_walkSegCache && _walkSegCache.epoch === _networkEpoch) return _walkSegCache.segments;
    var segments = [];
    if (_segmentIndex) {
      for (var i = 0; i < _segmentIndex.length; i++) {
        var seg = _segmentIndex[i];
        if (seg.pedBlocked) continue;
        segments.push({
          coords: [seg.startCoord, seg.endCoord],
          kind: seg.kind || "base",
          sidewalk: seg.sidewalk || "",
          footway: seg.footway || "",
          hwy: seg.hwy || "",
          wayId: seg.wayId != null ? seg.wayId : null
        });
      }
    }
    _walkSegCache = { epoch: _networkEpoch, segments: segments };
    return segments;
  }

  // ---- Expose on App namespace ----

  App.roadNetworkLoaded = function () { return !!_graph; };
  App.roadNetworkEpoch = function () { return _networkEpoch; };
  App.findLocalRoute = findLocalRoute;
  App.fetchRoadNetwork = fetchRoadNetwork;
  App.loadRoadNetworkFromFile = loadRoadNetworkFromFile;
  App.exportRoadNetwork = exportRoadNetwork;
  App.clearRoadNetwork = clearRoadNetwork;
  App.computeWalkshed = computeWalkshed;
  // Remove only the downloaded-area outline (leaves the road graph intact) — used by the Layers panel.
  App.clearRoadDownloadArea = function () { _downloadedBboxPolygon = null; updateUI(); };
  App.getWalkNetworkSegments = getWalkNetworkSegments;

  // ---- Network Connectors adapter (js/core/network-connectors.js) ----
  // Stores plain connector geometry + opts and triggers a full rebuildNetwork()
  // (buildGraph -> applyConnectorOverlay -> one epoch bump). Returns the overlay
  // report ({ addEdges, removeSegIds, joins, orphans } or { reason }). Never
  // reads App.lines or attributes — network-connectors.js does that translation.
  App.setNetworkConnectors = function (connectors, opts) {
    _connectors = connectors || [];
    _connectorOpts = opts || {};
    rebuildNetwork();
    return _lastOverlayReport;
  };
  // Raw accessor for the last overlay report — lets network-connectors.js stay in
  // sync even when a base-network reload (which also re-runs applyConnectorOverlay
  // via rebuildNetwork()) happens without going through setNetworkConnectors().
  App.getLastConnectorOverlayReport = function () { return _lastOverlayReport; };

  // ---- Transit Travelshed primitives (js/core/travelshed.js + transit-travelshed.js) ----

  App.computeWalkCostMap = computeWalkCostMap;
  App.polygonizeNodeSet  = function (coords, maxEdgeKm) { return buildWalkshedPolygon(coords, maxEdgeKm); };
  App.nodeKeyToCoord     = keyToCoord;
  App.snapWalk           = function (lngLat) { return snapToNetwork(lngLat, "walk"); };
  App.getRoadDownloadExtent = function () { return _downloadedBboxPolygon; }; // Feature<Polygon>|null

  // Caller-supplied-extent download (e.g. Transit Travelshed's scoped prompt-to-
  // download). This REPLACES the loaded network wholesale (same as
  // fetchRoadNetwork today) and bumps _networkEpoch, so all module caches
  // (walkshed, travelshed) invalidate automatically. Returns Promise<boolean>.
  App.fetchRoadNetworkForExtent = async function (extentPolygon) {
    var bb = turf.bbox(extentPolygon); // [w, s, e, n]
    return fetchNetworkForBounds({ s: bb[1], w: bb[0], n: bb[3], e: bb[2] }, turf.bboxPolygon(bb));
  };

})();
