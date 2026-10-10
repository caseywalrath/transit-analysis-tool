// js/core/osm-pois.js
// OSM Points of Interest loader via Overpass API.
// Provides a category picker popup (Health, Education, Transit, etc.) and renders
// fetched POIs as a purple circle layer with importance-based sizing.
// Follows the same hide/clear pattern as gtfs.js and osm.js.
// Exports: App.osmPoiLoaded, App.clearOsmPois, App.setOsmPoiLayerVisible, App.osmPoiFeatures

(function () {
  "use strict";
  var App = window.App;

  // ---- Category definitions ----

  var POI_CATEGORIES = [
    { group: "Health",      id: "hospital",    label: "Hospital",         tag: "amenity", value: "hospital",         importance: 3 },
    { group: "Health",      id: "clinic",      label: "Clinic / Doctor",  tag: "amenity", value: "clinic",           importance: 1 },
    { group: "Health",      id: "pharmacy",    label: "Pharmacy",         tag: "amenity", value: "pharmacy",         importance: 1 },
    { group: "Education",   id: "school",      label: "School",           tag: "amenity", value: "school",           importance: 2 },
    { group: "Education",   id: "university",  label: "University",       tag: "amenity", value: "university",       importance: 3 },
    { group: "Education",   id: "college",     label: "College",          tag: "amenity", value: "college",          importance: 2 },
    { group: "Education",   id: "library",     label: "Library",          tag: "amenity", value: "library",          importance: 1 },
    { group: "Transit",     id: "bus_station", label: "Bus Station",      tag: "amenity", value: "bus_station",      importance: 2 },
    { group: "Transit",     id: "rail_station",label: "Rail Station",     tag: "railway", value: "station",          importance: 3 },
    { group: "Retail",      id: "supermarket", label: "Supermarket",      tag: "shop",    value: "supermarket",      importance: 1 },
    { group: "Government",  id: "post_office", label: "Post Office",      tag: "amenity", value: "post_office",      importance: 1 },
    { group: "Government",  id: "community",   label: "Community Centre", tag: "amenity", value: "community_centre", importance: 1 },
    { group: "Government",  id: "townhall",    label: "Town Hall / Gov.", tag: "amenity", value: "townhall",         importance: 2 },
    { group: "Government",  id: "courthouse",  label: "Courthouse",       tag: "amenity", value: "courthouse",       importance: 2 },
    { group: "Recreation",  id: "stadium",     label: "Stadium / Arena",  tag: "leisure", value: "stadium",          importance: 2 },
    { group: "Recreation",  id: "park",        label: "Park",             tag: "leisure", value: "park",             importance: 1 },
    { group: "Social Services", id: "social_facility", label: "Social Facility",   tag: "amenity", value: "social_facility",   importance: 2 },
    { group: "Community",   id: "place_of_worship",    label: "Place of Worship",  tag: "amenity", value: "place_of_worship",  importance: 1 }
  ];

  // Lookup by id
  var CAT_BY_ID = {};
  POI_CATEGORIES.forEach(function (c) { CAT_BY_ID[c.id] = c; });

  // ---- Constants ----

  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var POI_SOURCE   = "osm-poi-points";
  var POI_LAYER    = "osm-poi-layer";
  var DEBOUNCE_MS  = 2000;
  var MIN_ZOOM     = 10;
  var MAX_ELEMENTS = 3000;

  // ---- Private state ----

  var _activeIds    = [];       // selected category ids for current layer
  var _moveHandler  = null;
  var _debounceTimer = null;
  var _loading      = false;
  var _hoverPopup   = null;
  var _clickPopup   = null;
  var _popupBuilt   = false;

  // ---- Overpass helpers ----

  function getBbox() {
    var b = App.map.getBounds();
    return b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast();
  }

  function buildQuery(ids, bbox) {
    var parts = ids.map(function (id) {
      var c = CAT_BY_ID[id];
      return 'node["' + c.tag + '"="' + c.value + '"](' + bbox + ');';
    });
    return "[out:json][timeout:30];(" + parts.join("") + ");out body;";
  }

  // ---- GeoJSON builder ----

  function elementsToGeoJSON(elements) {
    var features = [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.type !== "node" || typeof el.lat !== "number") continue;
      var props = Object.assign({}, el.tags || {});
      props._osm_id = el.id;

      // Determine importance from the matched category
      var imp = 1;
      for (var j = 0; j < _activeIds.length; j++) {
        var c = CAT_BY_ID[_activeIds[j]];
        if (c && props[c.tag] === c.value) { imp = c.importance; break; }
      }
      props._importance = imp;

      features.push({
        type: "Feature",
        properties: props,
        geometry: { type: "Point", coordinates: [el.lon, el.lat] }
      });
    }
    return { type: "FeatureCollection", features: features };
  }

  // ---- Fetch & render ----

  async function fetchAndRender() {
    if (_loading || _activeIds.length === 0) return;
    var zoom = App.map.getZoom();
    if (zoom < MIN_ZOOM) {
      App.setStatus("Zoom in to load OSM POIs (need zoom " + MIN_ZOOM + "+)");
      return;
    }

    _loading = true;
    App.setStatus("Fetching OSM points of interest\u2026");

    try {
      var bbox  = getBbox();
      var query = buildQuery(_activeIds, bbox);
      var resp  = await fetch(OVERPASS_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    "data=" + encodeURIComponent(query)
      });
      if (!resp.ok) throw new Error("Overpass error: " + resp.status);

      var data  = await resp.json();
      var elems = data.elements || [];
      if (elems.length > MAX_ELEMENTS) elems = elems.slice(0, MAX_ELEMENTS);

      var fc = elementsToGeoJSON(elems);
      App.osmPoiFeatures = fc;

      renderLayer(fc);

      var n = fc.features.length;
      var suffix = elems.length >= MAX_ELEMENTS ? " (capped)" : "";
      App.setStatus("Loaded " + n + " POI" + (n !== 1 ? "s" : "") + suffix);
    } catch (e) {
      App.setStatus("OSM POI fetch failed: " + (e.message || e));
    }

    _loading = false;
  }

  function renderLayer(fc) {
    var map = App.map;
    if (map.getSource(POI_SOURCE)) {
      map.getSource(POI_SOURCE).setData(fc);
      return;
    }

    // Insert below first user-drawn layer (same pattern as gtfs.js)
    var firstUser = null;
    var layers = map.getStyle().layers || [];
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].id.match(/^(point|line|route|polygon|buffer)/)) {
        firstUser = layers[i].id;
        break;
      }
    }

    map.addSource(POI_SOURCE, { type: "geojson", data: fc });
    map.addLayer({
      id:     POI_LAYER,
      type:   "circle",
      source: POI_SOURCE,
      paint: {
        "circle-radius": [
          "case",
          ["==", ["get", "_importance"], 3], 7,
          ["==", ["get", "_importance"], 2], 6,
          5
        ],
        "circle-color":        "#6b46c1",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#fff",
        "circle-opacity":      0.85
      }
    }, firstUser || undefined);

    wireEvents();
  }

  // ---- Map event wiring ----

  function ensurePopups() {
    if (!_hoverPopup)
      _hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px" });
    if (!_clickPopup)
      _clickPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "300px" });
  }

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtKey(k) {
    return k.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function buildHoverHTML(props) {
    var name    = props.name || props.amenity || props.shop || props.leisure || props.railway || "POI";
    var subtype = props.amenity || props.shop || props.leisure || props.railway || "";
    var html = '<div class="osm-hover"><b>' + escHtml(name) + "</b>";
    if (subtype && subtype !== name) html += "<br>" + escHtml(fmtKey(subtype));
    html += "</div>";
    return html;
  }

  function buildClickHTML(props) {
    var SKIP = { _osm_id: 1, _importance: 1 };
    var title = props.name || props.amenity || props.shop || props.leisure || props.railway || "OSM POI";
    var html  = '<div class="osm-detail"><div class="osm-detail-title">' + escHtml(title) + "</div>";
    var keys  = Object.keys(props).sort();
    var hasRows = false;
    for (var i = 0; i < keys.length; i++) {
      if (SKIP[keys[i]]) continue;
      var v = props[keys[i]];
      if (v == null || v === "") continue;
      html += '<div class="osm-detail-row"><span class="osm-detail-key">' + escHtml(fmtKey(keys[i])) +
              "</span> <span class=\"osm-detail-val\">" + escHtml(String(v)) + "</span></div>";
      hasRows = true;
    }
    if (!hasRows) html += '<div class="osm-detail-row"><i>No tags</i></div>';
    if (props._osm_id) {
      html += '<div class="osm-detail-link"><a href="https://www.openstreetmap.org/node/' +
              props._osm_id + '" target="_blank" rel="noopener">View on OpenStreetMap</a></div>';
    }
    html += "</div>";
    return html;
  }

  function wireEvents() {
    var map = App.map;
    map.on("mouseenter", POI_LAYER, function () {
      if (!App.drawMode) map.getCanvas().style.cursor = "default";
    });
    map.on("mousemove", POI_LAYER, function (e) {
      if (!App.drawMode) map.getCanvas().style.cursor = "default";
      if (e.features && e.features.length > 0) {
        ensurePopups();
        _hoverPopup.setLngLat(e.lngLat).setHTML(buildHoverHTML(e.features[0].properties)).addTo(map);
      }
    });
    map.on("mouseleave", POI_LAYER, function () {
      map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "default";
      if (_hoverPopup) _hoverPopup.remove();
    });
    map.on("click", POI_LAYER, function (e) {
      if (App.drawMode) return;
      if (e.features && e.features.length > 0) {
        ensurePopups();
        if (_hoverPopup) _hoverPopup.remove();
        _clickPopup.setLngLat(e.lngLat).setHTML(buildClickHTML(e.features[0].properties)).addTo(map);
      }
    });
  }

  // ---- Clear / hide ----

  function clearPoiLayer() {
    var map = App.map;
    if (_hoverPopup) _hoverPopup.remove();
    if (_clickPopup) _clickPopup.remove();
    if (map.getLayer(POI_LAYER))   map.removeLayer(POI_LAYER);
    if (map.getSource(POI_SOURCE)) map.removeSource(POI_SOURCE);
    if (_moveHandler) {
      map.off("moveend", _moveHandler);
      _moveHandler = null;
    }
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    _activeIds = [];
    App.osmPoiFeatures = null;
    var btn = document.getElementById("osm-poi-btn");
    if (btn) btn.classList.remove("add-data-active");
    App.setStatus("POI layer cleared");
  }

  // ---- Category picker popup ----

  function buildCategoryPopup() {
    if (_popupBuilt) return;
    _popupBuilt = true;

    var list = document.getElementById("osm-poi-category-list");
    if (!list) return;
    list.innerHTML = "";

    // Group categories
    var groups = [];
    var groupMap = {};
    POI_CATEGORIES.forEach(function (c) {
      if (!groupMap[c.group]) {
        groupMap[c.group] = [];
        groups.push(c.group);
      }
      groupMap[c.group].push(c);
    });

    groups.forEach(function (grp) {
      var grpLabel = document.createElement("div");
      grpLabel.className = "lodes-popup-label";
      grpLabel.textContent = grp;
      list.appendChild(grpLabel);

      groupMap[grp].forEach(function (cat) {
        var lbl = document.createElement("label");
        lbl.className = "osm-poi-check-label";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = cat.id;
        cb.addEventListener("change", updateFetchBtn);
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode("\u00a0" + cat.label));
        list.appendChild(lbl);
      });
    });

    updateFetchBtn();
  }

  function updateFetchBtn() {
    var fetchBtn = document.getElementById("osm-poi-fetch-btn");
    if (!fetchBtn) return;
    var list = document.getElementById("osm-poi-category-list");
    if (!list) return;
    var checked = list.querySelectorAll("input[type=checkbox]:checked");
    fetchBtn.disabled = (checked.length === 0);
  }

  function getCheckedIds() {
    var list = document.getElementById("osm-poi-category-list");
    if (!list) return [];
    var checkboxes = list.querySelectorAll("input[type=checkbox]:checked");
    var ids = [];
    for (var i = 0; i < checkboxes.length; i++) ids.push(checkboxes[i].value);
    return ids;
  }

  function showPoiPopup() {
    buildCategoryPopup();
    var popup = document.getElementById("osm-poi-popup");
    if (popup) popup.style.display = "";
  }

  function hidePoiPopup() {
    var popup = document.getElementById("osm-poi-popup");
    if (popup) popup.style.display = "none";
  }

  // ---- Initialization (runs after DOM ready, after map load) ----

  function init() {
    var poiBtn    = document.getElementById("osm-poi-btn");
    var closeBtn  = document.getElementById("osm-poi-popup-close");
    var fetchBtn  = document.getElementById("osm-poi-fetch-btn");
    var dropdown  = document.getElementById("add-data-dropdown");

    if (poiBtn) {
      poiBtn.addEventListener("click", function () {
        if (dropdown) dropdown.style.display = "none";
        showPoiPopup();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", hidePoiPopup);
    }

    if (fetchBtn) {
      fetchBtn.disabled = true;
      fetchBtn.addEventListener("click", function () {
        var ids = getCheckedIds();
        if (ids.length === 0) return;
        hidePoiPopup();

        _activeIds = ids;

        // Clear existing layer before new fetch
        if (App.map.getLayer(POI_LAYER))   App.map.removeLayer(POI_LAYER);
        if (App.map.getSource(POI_SOURCE)) App.map.removeSource(POI_SOURCE);
        if (_moveHandler) { App.map.off("moveend", _moveHandler); _moveHandler = null; }

        fetchAndRender();

        // Mark button active
        var btn = document.getElementById("osm-poi-btn");
        if (btn) btn.classList.add("add-data-active");

        // Debounced refresh on pan/zoom
        _moveHandler = function () {
          if (_activeIds.length === 0) return;
          if (_debounceTimer) clearTimeout(_debounceTimer);
          _debounceTimer = setTimeout(fetchAndRender, DEBOUNCE_MS);
        };
        App.map.on("moveend", _moveHandler);
      });
    }
  }

  // Wire up once the map is ready
  if (App.map && App.map.loaded()) {
    init();
  } else if (App.map) {
    App.map.on("load", init);
  } else {
    // Fallback: wait for map on the App namespace
    var _initInterval = setInterval(function () {
      if (App.map) {
        clearInterval(_initInterval);
        if (App.map.loaded()) { init(); }
        else { App.map.on("load", init); }
      }
    }, 100);
  }

  // ---- Public API ----

  App.osmPoiFeatures       = null;
  App.osmPoiLoaded         = function () { return !!(App.map && App.map.getLayer && App.map.getLayer(POI_LAYER)); };
  App.clearOsmPois         = clearPoiLayer;
  App.setOsmPoiLayerVisible = function (v) {
    if (App.map && App.map.getLayer(POI_LAYER))
      App.map.setLayoutProperty(POI_LAYER, "visibility", v ? "visible" : "none");
  };

})();
