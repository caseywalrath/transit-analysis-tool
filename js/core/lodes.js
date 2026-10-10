// js/core/lodes.js
// LODES file download/upload/parse and block-level employment computation.
// Depends on: App.map (map.js), App.bboxStringFromFeature (points.js),
//             App.bufferUnionPolygon (points.js), pako (CDN), turf (CDN).
// Exports: STATE_FIPS_TO_ABBR, getStateFromMapCenter, startDownload, lodesData,
//          lodesFileName, lodesFileNames, setLodesLoadedUI, mergeLodesFile, clearLodesData,
//          restoreLodesFromData, serializeLodesData, parseLodesFromUploadedFile,
//          fetchBlocksInternalPointsInUnion, computeEmploymentServedOnly

(function () {
  var App = window.App = window.App || {};

  var STATE_FIPS_TO_ABBR = {
    "01":"al","02":"ak","04":"az","05":"ar","06":"ca","08":"co","09":"ct","10":"de","11":"dc","12":"fl",
    "13":"ga","15":"hi","16":"id","17":"il","18":"in","19":"ia","20":"ks","21":"ky","22":"la","23":"me",
    "24":"md","25":"ma","26":"mi","27":"mn","28":"ms","29":"mo","30":"mt","31":"ne","32":"nv","33":"nh",
    "34":"nj","35":"nm","36":"ny","37":"nc","38":"nd","39":"oh","40":"ok","41":"or","42":"pa","44":"ri",
    "45":"sc","46":"sd","47":"tn","48":"tx","49":"ut","50":"vt","51":"va","53":"wa","54":"wv","55":"wi","56":"wy",
    "72":"pr"
  };

  async function getStateFromMapCenter() {
    var c = App.map.getCenter();
    var layerUrl = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/2";

    var params = new URLSearchParams({
      f: "geojson",
      where: "1=1",
      outFields: "GEOID",
      geometry: c.lng + "," + c.lat,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outSR: "4326",
      returnGeometry: "false",
      resultRecordCount: "1"
    });

    var url = layerUrl + "/query?" + params.toString();
    var resp = await fetch(url);
    if (!resp.ok) throw new Error("TIGERweb state lookup failed (" + resp.status + ")");
    var gj = await resp.json();

    var feat = gj.features && gj.features[0];
    var geoid = feat && feat.properties && feat.properties.GEOID;
    if (!geoid || geoid.length < 2) throw new Error("Could not infer state from TIGERweb GEOID.");
    var stateFips = geoid.slice(0, 2);
    var abbr = STATE_FIPS_TO_ABBR[stateFips];
    if (!abbr) throw new Error("Unsupported/unknown state FIPS: " + stateFips);
    return { stateFips: stateFips, abbr: abbr };
  }

  function startDownload(url, filename) {
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  var LODES_UPLOADED = null; // Map(w_geocode -> C000), merged across all loaded state files
  var LODES_UPLOADED_NAME = "";
  var LODES_LOADED_FILES = []; // [{ name, stateAbbr, nRows }] — one entry per uploaded file

  function guessStateFromMap(jobsMap) {
    var firstKey = jobsMap.keys().next().value || "";
    var fips = firstKey.slice(0, 2);
    var abbr = STATE_FIPS_TO_ABBR[fips];
    return abbr ? abbr.toUpperCase() : (fips || "??");
  }

  function setLodesLoadedUI() {
    var loadedEl = document.getElementById("lodesLoaded");
    var infoEl = document.getElementById("lodesInfo");
    var clearBtn = document.getElementById("lodesClearAll");
    if (loadedEl) loadedEl.textContent = LODES_LOADED_FILES.length > 0 ? "Yes" : "No";
    if (!infoEl) return;
    if (LODES_LOADED_FILES.length === 0) {
      infoEl.textContent = "";
      if (clearBtn) clearBtn.style.display = "none";
    } else {
      infoEl.innerHTML = LODES_LOADED_FILES.map(function (f) {
        return "<div>" + App.escapeHTML(f.stateAbbr) + " \u2014 " +
               App.escapeHTML(f.name) + " (" +
               App.escapeHTML(f.nRows.toLocaleString()) + " blocks)</div>";
      }).join("");
      if (clearBtn) clearBtn.style.display = "";
    }
  }

  function mergeLodesFile(jobsMap, name) {
    if (!LODES_UPLOADED) LODES_UPLOADED = new Map();
    jobsMap.forEach(function (v, k) { LODES_UPLOADED.set(k, v); });
    var stateAbbr = guessStateFromMap(jobsMap);
    LODES_LOADED_FILES.push({ name: name, stateAbbr: stateAbbr, nRows: jobsMap.size });
    LODES_UPLOADED_NAME = LODES_LOADED_FILES.map(function (f) { return f.name; }).join(", ");
    setLodesLoadedUI();
  }

  function clearLodesData() {
    LODES_UPLOADED = null;
    LODES_UPLOADED_NAME = "";
    LODES_LOADED_FILES = [];
    setLodesLoadedUI();
  }

  // Restore LODES from a previously serialized state-file payload.
  // entries: array of [w_geocode, jobs] pairs (or a plain object).
  // meta: { name, files: [{ name, stateAbbr, nRows }] }
  function restoreLodesFromData(entries, meta) {
    if (!entries) return;
    if (Array.isArray(entries)) {
      LODES_UPLOADED = new Map(entries);
    } else if (typeof entries === "object") {
      LODES_UPLOADED = new Map(Object.keys(entries).map(function (k) {
        return [k, entries[k]];
      }));
    } else {
      return;
    }
    meta = meta || {};
    LODES_UPLOADED_NAME = meta.name || "";
    LODES_LOADED_FILES  = Array.isArray(meta.files) ? meta.files.slice() : [];
    setLodesLoadedUI();
  }

  // Serialize current LODES state for state-file export. Returns null when empty.
  function serializeLodesData() {
    if (!LODES_UPLOADED || LODES_UPLOADED.size === 0) return null;
    return {
      entries: Array.from(LODES_UPLOADED.entries()),
      meta: {
        name:  LODES_UPLOADED_NAME,
        files: LODES_LOADED_FILES.slice()
      }
    };
  }

  async function parseLodesFromUploadedFile(file) {
    App.setStatus("Reading LODES file\u2026");
    var buf = await file.arrayBuffer();
    var bytes = new Uint8Array(buf);

    var csvText;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      App.setStatus("Decompressing LODES (gzip)\u2026");
      csvText = pako.ungzip(bytes, { to: "string" });
    } else {
      csvText = new TextDecoder().decode(bytes);
    }

    App.setStatus("Parsing LODES CSV\u2026");
    var lines = csvText.split(/\r?\n/);
    if (lines.length < 2) throw new Error("LODES file appears empty.");

    var header = lines[0].split(",");
    var idxGeo = header.indexOf("w_geocode");
    var idxC000 = header.indexOf("C000");
    if (idxGeo === -1 || idxC000 === -1) {
      throw new Error("LODES CSV missing expected columns (w_geocode, C000).");
    }

    var jobsMap = new Map();
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var parts = line.split(",");
      var g = parts[idxGeo];
      var c = parts[idxC000];
      if (!g || c === undefined) continue;
      var v = Number(String(c).replace(/,/g, "").trim());
      if (!Number.isFinite(v)) continue;
      jobsMap.set(String(g), v);
    }
    return jobsMap;
  }

  async function fetchBlocksInternalPointsInUnion(unionFeat) {
    var bbox = App.bboxStringFromFeature(unionFeat);
    var layerUrl = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/2";

    var params = new URLSearchParams({
      where: "1=1",
      outFields: "GEOID,INTPTLAT,INTPTLON",
      geometry: bbox,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outSR: "4326",
      returnGeometry: "false",
      f: "geojson"
    });

    var features = await App.fetchAllTigerwebFeatures(layerUrl, params);

    var inside = new Set();
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var p = f.properties || {};
      var geoid = p.GEOID;
      var lat = Number(p.INTPTLAT);
      var lon = Number(p.INTPTLON);
      if (!geoid || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      if (turf.booleanPointInPolygon(turf.point([lon, lat]), unionFeat)) {
        inside.add(String(geoid));
      }
    }
    return inside;
  }

  async function computeEmploymentServedOnly() {
    var unionFeat = App.bufferUnionPolygon();
    if (!unionFeat || !LODES_UPLOADED) return { value: NaN, blocks: 0, matched: 0 };

    var blocksInside = await fetchBlocksInternalPointsInUnion(unionFeat);

    var sum = 0;
    var matched = 0;
    for (var geoid of blocksInside) {
      var v = LODES_UPLOADED.get(geoid);
      if (v != null) { sum += v; matched++; }
    }
    return { value: sum, blocks: blocksInside.size, matched: matched };
  }

  // --- Expose on App namespace ---

  App.STATE_FIPS_TO_ABBR = STATE_FIPS_TO_ABBR;
  App.getStateFromMapCenter = getStateFromMapCenter;
  App.startDownload = startDownload;
  App.setLodesLoadedUI = setLodesLoadedUI;
  App.mergeLodesFile = mergeLodesFile;
  App.clearLodesData = clearLodesData;
  App.restoreLodesFromData = restoreLodesFromData;
  App.serializeLodesData   = serializeLodesData;
  App.parseLodesFromUploadedFile = parseLodesFromUploadedFile;
  App.fetchBlocksInternalPointsInUnion = fetchBlocksInternalPointsInUnion;
  App.computeEmploymentServedOnly = computeEmploymentServedOnly;

  // Getter/setter so project code and app.js can read/write the LODES state
  Object.defineProperty(App, "lodesData", {
    get: function () { return LODES_UPLOADED; },
    set: function (v) { LODES_UPLOADED = v; },
    configurable: true
  });
  Object.defineProperty(App, "lodesFileName", {
    get: function () { return LODES_UPLOADED_NAME; },
    set: function (v) { LODES_UPLOADED_NAME = v; },
    configurable: true
  });
  Object.defineProperty(App, "lodesFileNames", {
    get: function () { return LODES_LOADED_FILES.map(function (f) { return f.name; }); },
    configurable: true
  });
})();
