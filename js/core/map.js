// js/core/map.js
// Map initialization: basemap via MapLibre GL JS, basemap switcher control.
// Depends on: maplibregl (loaded via CDN), App.CARTO_API_KEY (config.js).
// Exports: map, switchBasemap, getBasemaps, getCurrentBasemapId,
//          getThemeBasemapId

(function () {
  var App = window.App = window.App || {};

  // ---- Basemap registry ----

  var BASEMAPS = [
    {
      id: "carto-light",
      name: "Carto Light",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
      ],
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    {
      id: "carto-dark",
      name: "Carto Dark",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
      ],
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    {
      id: "carto-voyager",
      name: "Carto Voyager",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
      ],
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    {
      id: "osm",
      name: "OpenStreetMap",
      tiles: [
        "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
      ],
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },
    {
      id: "satellite",
      name: "Satellite",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      ],
      attribution:
        'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
    },
    {
      id: "esri-dark-gray",
      name: "Esri Dark Gray",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      ],
      attribution:
        'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community'
    },
    {
      id: "esri-light-gray",
      name: "Esri Light Gray",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      ],
      attribution:
        'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community'
    }
  ];

  // ---- CARTO API key ----
  // CARTO requires a key on basemaps.cartocdn.com; unkeyed tiles come back
  // stamped "API KEY REQUIRED". The key is applied to every CARTO tile URL
  // once, here at init, so both consumers below — the initial style and
  // switchBasemap() — read already-keyed URLs and neither has to remember.
  //
  // With no key we withdraw the CARTO basemaps entirely rather than render
  // watermarked tiles. That is the state a fork, an exhausted quota, or (if
  // the key turns out to be domain-locked) local development sees, so the
  // remaining keyless basemaps have to carry the app on their own.
  // See js/core/config.js and docs/carto-api-key-plan.md.

  var CARTO_TILE_HOST = "basemaps.cartocdn.com";

  // Themed pairs: CARTO when keyed, Esri Canvas when not. Esri Light/Dark
  // Gray are the closest visual match among the keyless options.
  var THEME_BASEMAPS = {
    carto: { light: "carto-light",      dark: "carto-dark" },
    esri:  { light: "esri-light-gray",  dark: "esri-dark-gray" }
  };

  function usesCartoTiles(basemap) {
    for (var i = 0; i < basemap.tiles.length; i++) {
      if (basemap.tiles[i].indexOf(CARTO_TILE_HOST) !== -1) return true;
    }
    return false;
  }

  function withCartoKey(tiles, key) {
    return tiles.map(function (url) {
      if (url.indexOf(CARTO_TILE_HOST) === -1) return url;
      return url + (url.indexOf("?") === -1 ? "?" : "&") +
             "key=" + encodeURIComponent(key);
    });
  }

  var cartoKey = (App.CARTO_API_KEY || "").trim();
  var cartoEnabled = !!cartoKey;

  if (cartoEnabled) {
    BASEMAPS.forEach(function (bm) {
      if (usesCartoTiles(bm)) bm.tiles = withCartoKey(bm.tiles, cartoKey);
    });
  } else {
    BASEMAPS = BASEMAPS.filter(function (bm) { return !usesCartoTiles(bm); });
    console.info(
      "[map] No CARTO API key set — CARTO basemaps disabled, using Esri. " +
      "Set one in js/core/config.js, or run " +
      'localStorage.setItem("mat-carto-key", "…") for this browser only.'
    );
  }

  var THEME_FAMILY = cartoEnabled ? THEME_BASEMAPS.carto : THEME_BASEMAPS.esri;

  function findBasemap(id) {
    for (var i = 0; i < BASEMAPS.length; i++) {
      if (BASEMAPS[i].id === id) return BASEMAPS[i];
    }
    return null;
  }

  var currentBasemapId = THEME_FAMILY.light;

  // ---- Municipal boundaries overlay state ----

  var _muniBoundariesVisible = false;
  var _muniMoveHandler = null;
  var MUNI_SOURCE = "muni-boundaries";
  var MUNI_LAYER  = "muni-boundaries-line";

  // ---- Initial map style ----
  // Resolved by id, not BASEMAPS[0] — with no CARTO key the array no longer
  // starts with the intended default.

  var initialBasemap = findBasemap(currentBasemapId) || BASEMAPS[0];
  var rasterStyle = {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: initialBasemap.tiles,
        tileSize: 256,
        attribution: initialBasemap.attribution
      }
    },
    layers: [{ id: "carto", type: "raster", source: "carto" }]
  };

  var map = new maplibregl.Map({
    container: "map",
    style: rasterStyle,
    center: [-104.9903, 39.7392],
    zoom: 10
  });
  map.scrollZoom.setWheelZoomRate(1 / 900); // half the default (1/450) for finer zoom granularity
  // ---- Default cursor: grab hand ----
  map.on("load", function () {
    map.getCanvas().style.cursor = "grab";
  });
  map.on("dragstart", function () {
    if (!App.drawMode && !App._editing) {
      map.getCanvas().style.cursor = "grabbing";
    }
  });
  map.on("dragend", function () {
    if (App.drawMode) {
      map.getCanvas().style.cursor = "crosshair";
    } else if (!App._editing) {
      map.getCanvas().style.cursor = "grab";
    }
  });

  // ---- Basemap switching ----

  function switchBasemap(basemapId) {
    if (basemapId === currentBasemapId) return;

    var basemap = findBasemap(basemapId);
    if (!basemap) return;

    // Find the first data layer (the layer right above "carto")
    var layers = map.getStyle().layers;
    var firstDataLayerId = null;
    for (var j = 0; j < layers.length; j++) {
      if (layers[j].id !== "carto") {
        firstDataLayerId = layers[j].id;
        break;
      }
    }

    // Remove old basemap
    if (map.getLayer("carto")) map.removeLayer("carto");
    if (map.getSource("carto")) map.removeSource("carto");

    // Add new basemap below all data layers
    map.addSource("carto", {
      type: "raster",
      tiles: basemap.tiles,
      tileSize: 256,
      attribution: basemap.attribution
    });

    if (firstDataLayerId) {
      map.addLayer({ id: "carto", type: "raster", source: "carto" }, firstDataLayerId);
    } else {
      map.addLayer({ id: "carto", type: "raster", source: "carto" });
    }

    currentBasemapId = basemapId;
  }

  // ---- Municipal boundaries overlay ----

  async function fetchAndRenderMuniBoundaries() {
    try {
      var bounds = map.getBounds();
      var bbox = bounds.getWest() + "," + bounds.getSouth() + "," +
                 bounds.getEast() + "," + bounds.getNorth();

      var layerUrl = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4";
      var params = new URLSearchParams({
        where: "1=1",
        geometry: bbox,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "NAME,GEOID",
        returnGeometry: "true",
        f: "geojson"
      });
      var features = await App.fetchAllTigerwebFeatures(layerUrl, params);

      var fc = { type: "FeatureCollection", features: features };

      if (map.getSource(MUNI_SOURCE)) {
        map.getSource(MUNI_SOURCE).setData(fc);
      } else {
        map.addSource(MUNI_SOURCE, { type: "geojson", data: fc });
        map.addLayer({
          id: MUNI_LAYER,
          type: "line",
          source: MUNI_SOURCE,
          paint: {
            "line-color": "#e05c00",
            "line-width": 1.5,
            "line-dasharray": [4, 3],
            "line-opacity": 0.8
          }
        });
      }
    } catch (e) {
      // Leave existing layer data in place if fetch fails
    }
  }

  function toggleMuniBoundaries(show) {
    _muniBoundariesVisible = show;

    if (!show) {
      if (map.getLayer(MUNI_LAYER))   map.removeLayer(MUNI_LAYER);
      if (map.getSource(MUNI_SOURCE)) map.removeSource(MUNI_SOURCE);
      if (_muniMoveHandler) {
        map.off("moveend", _muniMoveHandler);
        _muniMoveHandler = null;
      }
      return;
    }

    fetchAndRenderMuniBoundaries();

    _muniMoveHandler = function () {
      if (_muniBoundariesVisible) fetchAndRenderMuniBoundaries();
    };
    map.on("moveend", _muniMoveHandler);
  }

  // ---- North arrow control (bottom-left) ----

  var NORTH_ARROW_SVG =
    '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
    '<polygon points="11,2 7,11 11,9 15,11" fill="#333"/>' +
    '<polygon points="11,20 7,11 11,13 15,11" fill="#bbb"/>' +
    '</svg>';

  function NorthArrowControl() {}

  NorthArrowControl.prototype.onAdd = function (mapInstance) {
    this._map = mapInstance;
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";

    this._btn = document.createElement("button");
    this._btn.type = "button";
    this._btn.className = "north-arrow-btn";
    this._btn.title = "Reset north";
    this._btn.setAttribute("aria-label", "Reset map orientation to north");
    this._btn.innerHTML = NORTH_ARROW_SVG;
    this._btn.addEventListener("click", function () { mapInstance.resetNorth(); });

    this._onRotate = function () {
      var b = mapInstance.getBearing();
      this._btn.style.transform = "rotate(" + (-b) + "deg)";
    }.bind(this);
    mapInstance.on("rotate", this._onRotate);

    this._container.appendChild(this._btn);
    return this._container;
  };

  NorthArrowControl.prototype.onRemove = function () {
    this._map.off("rotate", this._onRotate);
    this._container.parentNode.removeChild(this._container);
    this._map = undefined;
  };

  // ---- Basemap switcher control (bottom-right) ----

  var LAYERS_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polygon points="12 2 2 7 12 12 22 7 12 2"/>' +
    '<polyline points="2 17 12 22 22 17"/>' +
    '<polyline points="2 12 12 17 22 12"/>' +
    '</svg>';

  function BasemapControl() {}

  BasemapControl.prototype.onAdd = function (mapInstance) {
    this._map = mapInstance;
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group basemap-switcher";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "basemap-btn";
    btn.title = "Switch basemap";
    btn.setAttribute("aria-label", "Choose basemap");
    btn.innerHTML = LAYERS_SVG;

    var dropdown = document.createElement("div");
    dropdown.className = "basemap-dropdown";
    dropdown.style.display = "none";

    for (var i = 0; i < BASEMAPS.length; i++) {
      var opt = document.createElement("button");
      opt.type = "button";
      opt.className = "basemap-option" + (BASEMAPS[i].id === currentBasemapId ? " active" : "");
      opt.textContent = BASEMAPS[i].name;
      opt.setAttribute("data-basemap", BASEMAPS[i].id);
      opt.addEventListener("click", (function (id) {
        return function () {
          switchBasemap(id);
          var allOpts = dropdown.querySelectorAll(".basemap-option");
          for (var j = 0; j < allOpts.length; j++) {
            allOpts[j].classList.toggle("active", allOpts[j].getAttribute("data-basemap") === id);
          }
          dropdown.style.display = "none";
        };
      })(BASEMAPS[i].id));
      dropdown.appendChild(opt);
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
    });

    // Close dropdown on click outside
    document.addEventListener("click", function () {
      dropdown.style.display = "none";
    });

    // Prevent dropdown clicks from closing dropdown via the document listener
    dropdown.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    this._container.appendChild(btn);
    this._container.appendChild(dropdown);
    return this._container;
  };

  BasemapControl.prototype.onRemove = function () {
    this._container.parentNode.removeChild(this._container);
    this._map = undefined;
  };

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new BasemapControl(), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "imperial" }), "bottom-left");
  map.addControl(new NorthArrowControl(), "bottom-left");

  // ---- Expose on App namespace ----

  App.map = map;
  App.switchBasemap = switchBasemap;
  App.getBasemaps = function () {
    return BASEMAPS.map(function (b) { return { id: b.id, name: b.name }; });
  };
  App.getCurrentBasemapId = function () { return currentBasemapId; };
  // Light/dark basemap for the current theme. Callers (the dark-mode toggle
  // in app.js) must not hardcode "carto-light"/"carto-dark" — those ids do
  // not exist when there is no CARTO key, and switchBasemap would silently
  // no-op, stranding the map on the wrong-theme basemap.
  App.getThemeBasemapId = function (isDark) {
    return isDark ? THEME_FAMILY.dark : THEME_FAMILY.light;
  };
  App.toggleMuniBoundaries = toggleMuniBoundaries;
  App.setMuniBoundariesLayerVisible = function (visible) {
    var LAYER = "muni-boundaries-line";
    if (visible) {
      if (map.getLayer(LAYER)) {
        map.setLayoutProperty(LAYER, "visibility", "visible");
      } else {
        toggleMuniBoundaries(true);
      }
    } else {
      if (map.getLayer(LAYER)) {
        map.setLayoutProperty(LAYER, "visibility", "none");
      }
    }
  };
})();
