// js/core/osm.js
// OpenStreetMap data pull via Overpass API.
// Fetches bus stops, transit routes, or POIs within the current map viewport
// and renders them as non-editable reference layers.
// Depends on: App.map (map.js), App.setStatus (utils.js).

(function () {
  "use strict";
  var App = window.App;

  // ---- Constants ----

  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var PT_SOURCE = "osm-points";
  var PT_LAYER  = "osm-points-layer";
  var LN_SOURCE = "osm-lines";
  var LN_LAYER  = "osm-lines-layer";
  var MIN_ZOOM  = 10;
  var DEBOUNCE_MS = 2000;
  var MAX_ELEMENTS = 2000;

  var QUERIES = {
    bus_stops: function (bb) {
      return '[out:json][timeout:30];(' +
        'node["highway"="bus_stop"](' + bb + ');' +
        'node["public_transport"="platform"]["bus"="yes"](' + bb + ');' +
        ');out body;';
    },
    transit_routes: function (bb) {
      return '[out:json][timeout:30];(' +
        'relation["route"="bus"](' + bb + ');' +
        'relation["route"="tram"](' + bb + ');' +
        'relation["route"="trolleybus"](' + bb + ');' +
        'relation["route"="light_rail"](' + bb + ');' +
        ');out geom;';
    },
    pois: function (bb) {
      return '[out:json][timeout:30];(' +
        'node["amenity"](' + bb + ');' +
        ');out body;>;out skel qt;';
    }
  };

  var LABELS = {
    bus_stops: "bus stops",
    transit_routes: "transit routes",
    pois: "points of interest"
  };

  // Tags to skip in the "all tags" detail view
  var SKIP_TAGS = { _osm_id: 1, _osm_type: 1 };

  // Preferred display order for hover summary
  var HOVER_KEYS_LINE  = ["name", "ref", "operator", "network", "route"];
  var HOVER_KEYS_POINT = ["name", "ref", "operator", "amenity"];

  // ---- Private state ----

  var _activeCategory = null;
  var _moveHandler = null;
  var _debounceTimer = null;
  var _loading = false;
  var _hoverPopup = null;  // maplibregl.Popup for hover tooltip
  var _clickPopup = null;  // maplibregl.Popup for click detail

  // ---- Overpass bbox from map ----

  function getBbox() {
    var b = App.map.getBounds();
    // Overpass uses south,west,north,east
    return b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast();
  }

  // ---- Overpass JSON → GeoJSON ----

  function overpassToGeoJSON(data) {
    var points = [];
    var lines = [];
    var elements = data.elements || [];

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var props = el.tags || {};
      props._osm_id = el.id;
      props._osm_type = el.type;

      if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
        points.push({
          type: "Feature",
          properties: props,
          geometry: { type: "Point", coordinates: [el.lon, el.lat] }
        });
      } else if (el.type === "way" && el.geometry && el.geometry.length >= 2) {
        var coords = el.geometry.map(function (g) { return [g.lon, g.lat]; });
        lines.push({
          type: "Feature",
          properties: props,
          geometry: { type: "LineString", coordinates: coords }
        });
      } else if (el.type === "relation" && el.members) {
        // Collect way geometries into a MultiLineString
        var wayCoords = [];
        for (var j = 0; j < el.members.length; j++) {
          var m = el.members[j];
          if (m.type === "way" && m.geometry && m.geometry.length >= 2) {
            wayCoords.push(m.geometry.map(function (g) { return [g.lon, g.lat]; }));
          }
        }
        if (wayCoords.length > 0) {
          lines.push({
            type: "Feature",
            properties: props,
            geometry: { type: "MultiLineString", coordinates: wayCoords }
          });
        }
      }
    }

    return {
      points: { type: "FeatureCollection", features: points },
      lines:  { type: "FeatureCollection", features: lines }
    };
  }

  // ---- Fetch from Overpass ----

  async function fetchOverpassData(category) {
    if (_loading) return;
    if (!QUERIES[category]) return;

    var zoom = App.map.getZoom();
    if (zoom < MIN_ZOOM) {
      App.setStatus("Zoom in to load OSM data (current: " + Math.floor(zoom) + ", need: " + MIN_ZOOM + ")");
      return;
    }

    _loading = true;
    var label = LABELS[category] || category;
    App.setStatus("Fetching " + label + "\u2026");

    try {
      var bbox = getBbox();
      var query = QUERIES[category](bbox);
      var resp = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      });

      if (!resp.ok) {
        throw new Error("Overpass API error: " + resp.status);
      }

      var data = await resp.json();
      var total = (data.elements || []).length;

      if (total === 0) {
        App.setStatus("No " + label + " found in this area");
        renderLayers(
          { type: "FeatureCollection", features: [] },
          { type: "FeatureCollection", features: [] }
        );
        _loading = false;
        return;
      }

      // Cap elements to prevent rendering slowdown
      if (total > MAX_ELEMENTS) {
        data.elements = data.elements.slice(0, MAX_ELEMENTS);
      }

      var geojson = overpassToGeoJSON(data);
      renderLayers(geojson.points, geojson.lines);

      var nPts = geojson.points.features.length;
      var nLns = geojson.lines.features.length;
      var parts = [];
      if (nPts > 0) parts.push(nPts + " point" + (nPts !== 1 ? "s" : ""));
      if (nLns > 0) parts.push(nLns + " route" + (nLns !== 1 ? "s" : ""));
      var msg = "Loaded " + parts.join(", ");
      if (total > MAX_ELEMENTS) msg += " (capped from " + total + ")";
      App.setStatus(msg);
    } catch (e) {
      App.setStatus("OSM fetch failed: " + (e.message || e));
    }

    _loading = false;
  }

  // ---- Popup helpers ----

  function buildHoverEntry(props, keys) {
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var v = props[keys[i]];
      if (v != null && v !== "") {
        parts.push("<b>" + escHtml(formatKey(keys[i])) + ":</b> " + escHtml(String(v)));
      }
    }
    if (parts.length === 0) {
      // Fallback: show first available tag
      var allKeys = Object.keys(props);
      for (var j = 0; j < allKeys.length; j++) {
        if (!SKIP_TAGS[allKeys[j]]) {
          parts.push("<b>" + escHtml(formatKey(allKeys[j])) + ":</b> " + escHtml(String(props[allKeys[j]])));
          break;
        }
      }
    }
    if (parts.length === 0) parts.push("<i>No tags</i>");
    return parts.join("<br>");
  }

  // Accepts an array of features so overlapping OSM features are all listed.
  function buildHoverHTML(feats, keys) {
    var list = Array.isArray(feats) ? feats : [{ properties: feats }];
    var html = '<div class="osm-hover">';
    for (var i = 0; i < list.length; i++) {
      if (i > 0) {
        html += '<div style="border-top:1px solid var(--border);margin:4px 0"></div>';
      }
      html += buildHoverEntry(list[i].properties, keys);
    }
    html += "</div>";
    return html;
  }

  function buildClickHTML(props) {
    var html = '<div class="osm-detail">';

    // Title: name or ref or type
    var title = props.name || props.ref || props.amenity || props.route || "OSM Feature";
    html += '<div class="osm-detail-title">' + escHtml(String(title)) + "</div>";

    // All tags as key/value rows
    var keys = Object.keys(props).sort();
    var hasRows = false;
    for (var i = 0; i < keys.length; i++) {
      if (SKIP_TAGS[keys[i]]) continue;
      var v = props[keys[i]];
      if (v == null || v === "") continue;
      html += '<div class="osm-detail-row">' +
        '<span class="osm-detail-key">' + escHtml(formatKey(keys[i])) + "</span> " +
        '<span class="osm-detail-val">' + escHtml(String(v)) + "</span>" +
        "</div>";
      hasRows = true;
    }
    if (!hasRows) html += '<div class="osm-detail-row"><i>No tags</i></div>';

    // OSM link
    var osmType = props._osm_type || "node";
    var osmId = props._osm_id;
    if (osmId) {
      html += '<div class="osm-detail-link">' +
        '<a href="https://www.openstreetmap.org/' + osmType + '/' + osmId +
        '" target="_blank" rel="noopener">View on OpenStreetMap</a></div>';
    }

    html += "</div>";
    return html;
  }

  function formatKey(k) {
    return k.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function ensurePopups() {
    if (!_hoverPopup) {
      _hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "280px" });
    }
    if (!_clickPopup) {
      _clickPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "320px" });
    }
  }

  function removePopups() {
    if (_hoverPopup) _hoverPopup.remove();
    if (_clickPopup) _clickPopup.remove();
  }

  // Query a small box around the cursor so stacked / near-parallel features are
  // all captured (single-pixel e.features only catches the topmost), deduped by
  // OSM type/id (falling back to name).
  function featuresNear(e, layerId) {
    var map = App.map;
    var T = 5; // px tolerance
    var p = e.point;
    var box = [[p.x - T, p.y - T], [p.x + T, p.y + T]];
    var raw = map.queryRenderedFeatures(box, { layers: [layerId] });
    var seen = {}, out = [];
    raw.forEach(function (f) {
      var pr = f.properties || {};
      var k = (pr._osm_id != null)
        ? (pr._osm_type || "node") + "/" + pr._osm_id
        : (pr.name || JSON.stringify(pr));
      if (seen[k]) return;
      seen[k] = 1;
      out.push(f);
    });
    return out;
  }

  function wireLayerEvents(layerId, hoverKeys) {
    var map = App.map;

    map.on("mouseenter", layerId, function () {
      if (!App.drawMode) map.getCanvas().style.cursor = "default";
    });

    map.on("mousemove", layerId, function (e) {
      if (!App.drawMode) map.getCanvas().style.cursor = "default";
      var feats = featuresNear(e, layerId);
      if (feats.length > 0) {
        ensurePopups();
        _hoverPopup.setLngLat(e.lngLat).setHTML(buildHoverHTML(feats, hoverKeys)).addTo(map);
      }
    });

    map.on("mouseleave", layerId, function () {
      map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "default";
      if (_hoverPopup) _hoverPopup.remove();
    });

    map.on("click", layerId, function (e) {
      if (App.drawMode) return;
      if (e.features && e.features.length > 0) {
        var props = e.features[0].properties;
        ensurePopups();
        if (_hoverPopup) _hoverPopup.remove();
        _clickPopup.setLngLat(e.lngLat).setHTML(buildClickHTML(props)).addTo(map);
      }
    });
  }

  // ---- Render layers ----

  function emptyFC() { return { type: "FeatureCollection", features: [] }; }

  function renderLayers(pointFC, lineFC) {
    var map = App.map;

    // Points (circle layer)
    if (!map.getSource(PT_SOURCE)) {
      map.addSource(PT_SOURCE, { type: "geojson", data: pointFC });
      map.addLayer({
        id: PT_LAYER,
        type: "circle",
        source: PT_SOURCE,
        paint: {
          "circle-radius": 5,
          "circle-color": "#e74c3c",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.85
        }
      });
      wireLayerEvents(PT_LAYER, HOVER_KEYS_POINT);
    } else {
      map.getSource(PT_SOURCE).setData(pointFC);
    }

    // Lines
    if (!map.getSource(LN_SOURCE)) {
      map.addSource(LN_SOURCE, { type: "geojson", data: lineFC });
      map.addLayer({
        id: LN_LAYER,
        type: "line",
        source: LN_SOURCE,
        paint: {
          "line-color": "#3498db",
          "line-width": 2.5,
          "line-opacity": 0.7
        }
      });
      wireLayerEvents(LN_LAYER, HOVER_KEYS_LINE);
    } else {
      map.getSource(LN_SOURCE).setData(lineFC);
    }
  }

  // ---- Clear / toggle ----

  function clearLayers() {
    var map = App.map;
    removePopups();
    if (map.getLayer(PT_LAYER))  map.removeLayer(PT_LAYER);
    if (map.getSource(PT_SOURCE)) map.removeSource(PT_SOURCE);
    if (map.getLayer(LN_LAYER))  map.removeLayer(LN_LAYER);
    if (map.getSource(LN_SOURCE)) map.removeSource(LN_SOURCE);

    if (_moveHandler) {
      map.off("moveend", _moveHandler);
      _moveHandler = null;
    }
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }

    _activeCategory = null;
    App.setStatus("OSM layer cleared");
  }

  function toggleCategory(category) {
    // Same category → clear (toggle off)
    if (_activeCategory === category) {
      clearLayers();
      return;
    }

    // Different category or first load → clean up old layers first
    if (_activeCategory) {
      var map = App.map;
      if (map.getLayer(PT_LAYER))  map.removeLayer(PT_LAYER);
      if (map.getSource(PT_SOURCE)) map.removeSource(PT_SOURCE);
      if (map.getLayer(LN_LAYER))  map.removeLayer(LN_LAYER);
      if (map.getSource(LN_SOURCE)) map.removeSource(LN_SOURCE);
    }

    _activeCategory = category;

    // Fetch immediately
    fetchOverpassData(category);

    // Set up debounced moveend refresh
    if (_moveHandler) {
      App.map.off("moveend", _moveHandler);
    }
    _moveHandler = function () {
      if (!_activeCategory) return;
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(function () {
        fetchOverpassData(_activeCategory);
      }, DEBOUNCE_MS);
    };
    App.map.on("moveend", _moveHandler);
  }

  // ---- Expose on App namespace ----

  App.osmToggleCategory = toggleCategory;
  App.osmClearLayers = clearLayers;
  App.osmActiveCategory = function () { return _activeCategory; };

})();
