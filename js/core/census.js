// js/core/census.js
// TIGERweb census geometry fetching, ACS data retrieval, and area-weighted aggregation.
// Depends on: App.map (map.js), App.bboxStringFromFeature (points.js),
//             App.getMeta (utils.js), turf (CDN).
// Exports: renderCensusOverlay, fetchAllTigerwebFeatures, fetchTigerwebGeos,
//          parseGEOID, fetchACSValues, fetchACSCountyValues,
//          aggregateWithinUnion, computeGeoOverlapFractions, computeAcsValueOnly

(function () {
  var App = window.App = window.App || {};

  // ---- Shared session fetch cache (transparent memo) ----
  // Makes repeated TIGERweb/ACS fetches instant and guarantees every analysis
  // module reports the same numbers. Session-scoped; cleared on Reset Session.
  var _geoCache = new Map();  // "geoLevel|bbox" -> raw TIGERweb features (pre union-filter)
  var _acsStore = new Map();  // "geoLevel|year|st-co" -> { vars:Set, data:Map(geoid -> Map(varCode -> value)) }
  var _fetchedAt = new Map(); // "geoLevel|year" -> ms timestamp of last network ACS fetch

  // --- TIGERweb overlay rendering ---

  function renderCensusOverlay(geos) {
    var map = App.map;
    var srcId = "census-geos";
    var fillId = "census-geos-fill";
    var lineId = "census-geos-line";
    var fc = { type: "FeatureCollection", features: geos };

    if (!map.getSource(srcId)) {
      map.addSource(srcId, { type: "geojson", data: fc });

      map.addLayer({
        id: fillId,
        type: "fill",
        source: srcId,
        paint: { "fill-color": "#111827", "fill-opacity": 0.08 }
      }, "buffers-fill");

      map.addLayer({
        id: lineId,
        type: "line",
        source: srcId,
        paint: { "line-color": "#111827", "line-width": 1, "line-opacity": 0.35 }
      }, "buffers-fill");
    } else {
      map.getSource(srcId).setData(fc);
    }
  }

  function clearCensusOverlay() {
    var map = App.map;
    if (!map || !map.getSource("census-geos")) return;
    map.getSource("census-geos").setData({ type: "FeatureCollection", features: [] });
  }

  // --- Paginated TIGERweb query (shared by census.js and lodes.js) ---

  async function fetchAllTigerwebFeatures(layerUrl, params) {
    var pageSize = 1000;
    var offset = 0;
    var allFeatures = [];

    params.set("resultRecordCount", String(pageSize));

    while (true) {
      params.set("resultOffset", String(offset));
      var url = layerUrl + "/query?" + params.toString();
      var resp = await fetch(url);
      if (!resp.ok) throw new Error("TIGERweb error " + resp.status);
      var data = await resp.json();

      var features = data.features || [];
      allFeatures = allFeatures.concat(features);

      if (!data.exceededTransferLimit || features.length === 0) break;
      offset += features.length;
    }

    return allFeatures;
  }

  // --- TIGERweb fetch for tracts / block groups ---

  async function fetchTigerwebGeos(geoLevel, unionFeat) {
    var bbox = App.bboxStringFromFeature(unionFeat);
    // Memoize the (expensive) bbox query; keep the union-intersect filter outside
    // the cache so different study areas sharing a bbox still reuse the network result.
    var cacheKey = geoLevel + "|" + bbox;
    var features = _geoCache.get(cacheKey);
    if (!features) {
      var layerId = (geoLevel === "tract") ? 0 : 1;
      var layerUrl = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/" + layerId;

      var params = new URLSearchParams({
        where: "1=1",
        outFields: "GEOID",
        geometry: bbox,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outSR: "4326",
        returnGeometry: "true",
        f: "geojson"
      });

      features = await fetchAllTigerwebFeatures(layerUrl, params);
      _geoCache.set(cacheKey, features);
    }
    return features.filter(function (f) {
      return turf.booleanIntersects(f, unionFeat);
    });
  }

  // --- ACS API fetch + aggregation ---

  function parseGEOID(geoLevel, geoid) {
    var state = geoid.slice(0, 2);
    var county = geoid.slice(2, 5);
    var tract = geoid.slice(5, 11);
    var blkgrp = (geoLevel === "bg") ? geoid.slice(11, 12) : null;
    return { state: state, county: county, tract: tract, blkgrp: blkgrp };
  }

  // Fetch one county's missing ACS vars and merge into the store slot.
  // Pulls the whole county (for:*) so the result is reusable by any study area.
  async function fetchCountyVarsInto(geoLevel, year, entry, varCodes, slot) {
    var base = "https://api.census.gov/data/" + year + "/acs/acs5";
    var forClause, inClause;
    if (geoLevel === "tract") {
      forClause = "tract:*";
      inClause = "state:" + entry.state + "%20county:" + entry.county;
    } else {
      forClause = "block%20group:*";
      inClause = "state:" + entry.state + "%20county:" + entry.county + "%20tract:*";
    }
    var CHUNK = 49; // Census API allows ≤50 columns/request; NAME uses one slot
    for (var ci = 0; ci < varCodes.length; ci += CHUNK) {
      var chunk = varCodes.slice(ci, ci + CHUNK);
      var url = base + "?get=NAME," + encodeURIComponent(chunk.join(",")) + "&for=" + forClause + "&in=" + inClause + (App.CENSUS_API_KEY ? "&key=" + App.CENSUS_API_KEY : "");
      var resp = await fetch(url);
      if (!resp.ok) throw new Error("ACS API error " + resp.status + " for state " + entry.state + " county " + entry.county);
      var rows = await resp.json();
      var header = rows[0];
      var varIdx = {};
      chunk.forEach(function (v) { var i = header.indexOf(v); if (i !== -1) varIdx[v] = i; });
      var sIdx = header.indexOf("state"), cIdx = header.indexOf("county"),
          tIdx = header.indexOf("tract"), bIdx = header.indexOf("block group");
      for (var ri = 1; ri < rows.length; ri++) {
        var r = rows[ri];
        var gid = (geoLevel === "tract")
          ? r[sIdx] + r[cIdx] + r[tIdx]
          : r[sIdx] + r[cIdx] + r[tIdx] + r[bIdx];
        var gm = slot.data.get(gid);
        if (!gm) { gm = new Map(); slot.data.set(gid, gm); }
        for (var v in varIdx) {
          var raw = r[varIdx[v]];
          if (raw === null || raw === undefined || raw === "") continue;
          var val = Number(raw);
          // Skip Census sentinel values (negative placeholders like -666666666).
          if (Number.isFinite(val) && val >= 0) gm.set(v, val);
        }
      }
      // Mark the chunk's vars as fetched for this county (a sentinel means
      // "no value", not "not fetched" — so we never refetch them).
      chunk.forEach(function (v) { slot.vars.add(v); });
    }
  }

  // Cached, multi-var ACS fetch shared by TPI (TPI.batchFetchACS) and Title VI
  // (fetchACSValues). Returns Map(geoid -> Map(varCode -> value)). Only fetches
  // vars not already cached for each (geoLevel, year, county). opts.force bypasses.
  async function fetchACSBatchCached(geoLevel, year, varCodes, geoids, opts) {
    opts = opts || {};
    var result = new Map();
    if (!varCodes.length || !geoids.length) return result;

    var counties = new Map();
    geoids.forEach(function (g) {
      var st = g.slice(0, 2), co = g.slice(2, 5), k = st + "-" + co;
      if (!counties.has(k)) counties.set(k, { state: st, county: co });
    });

    for (var entry of counties.values()) {
      var storeKey = geoLevel + "|" + year + "|" + entry.state + "-" + entry.county;
      var slot = _acsStore.get(storeKey);
      if (opts.force && slot) { _acsStore.delete(storeKey); slot = null; }
      if (!slot) { slot = { vars: new Set(), data: new Map() }; _acsStore.set(storeKey, slot); }
      var missing = varCodes.filter(function (v) { return !slot.vars.has(v); });
      if (missing.length) {
        await fetchCountyVarsInto(geoLevel, year, entry, missing, slot);
        _fetchedAt.set(geoLevel + "|" + year, Date.now());
        try { window.dispatchEvent(new CustomEvent("mat:census-fetch")); } catch (e) {}
      }
    }

    geoids.forEach(function (g) {
      var st = g.slice(0, 2), co = g.slice(2, 5);
      var slot = _acsStore.get(geoLevel + "|" + year + "|" + st + "-" + co);
      if (!slot) return;
      var gm = slot.data.get(g);
      if (!gm) return;
      var out = new Map();
      varCodes.forEach(function (v) { if (gm.has(v)) out.set(v, gm.get(v)); });
      if (out.size) result.set(g, out);
    });
    return result;
  }

  // Single-variable convenience wrapper over the cached batch fetcher.
  async function fetchACSValues(geoLevel, year, varCode, geoids) {
    var batch = await fetchACSBatchCached(geoLevel, year, [varCode], geoids);
    var results = new Map();
    batch.forEach(function (varMap, geoid) {
      if (varMap.has(varCode)) results.set(geoid, varMap.get(varCode));
    });
    return results;
  }

  async function fetchACSCountyValues(year, varCode, countyFipsList) {
    var base = "https://api.census.gov/data/" + year + "/acs/acs5";
    var byState = new Map();

    for (var ci = 0; ci < countyFipsList.length; ci++) {
      var c5 = countyFipsList[ci];
      var st = c5.slice(0, 2);
      var co = c5.slice(2, 5);
      if (!byState.has(st)) byState.set(st, []);
      byState.get(st).push(co);
    }

    var out = new Map();
    for (var entry of byState.entries()) {
      var stateFips = entry[0];
      var counties = entry[1];
      var url = base + "?get=NAME," + encodeURIComponent(varCode) + "&for=county:*&in=state:" + stateFips + (App.CENSUS_API_KEY ? "&key=" + App.CENSUS_API_KEY : "");
      var resp = await fetch(url);
      if (!resp.ok) throw new Error("ACS county fetch failed " + resp.status + " for state " + stateFips);
      var rows = await resp.json();
      var header = rows[0];
      var idxVar = header.indexOf(varCode);
      var idxState = header.indexOf("state");
      var idxCounty = header.indexOf("county");

      for (var i = 1; i < rows.length; i++) {
        var r = rows[i];
        var co2 = r[idxCounty];
        if (!counties.includes(co2)) continue;
        var val = Number(r[idxVar]);
        // Skip Census sentinel values (negative placeholders like -666666666).
        if (!Number.isFinite(val) || val < 0) continue;
        out.set(r[idxState] + co2, val);
      }
    }
    return out;
  }

  // Fetch multiple ACS variable codes in a single API call per state-county group,
  // summing all code values per GEOID. Returns Map<GEOID, sum>.
  async function fetchACSMultiValues(geoLevel, year, varCodes, geoids) {
    var groups = new Map();
    for (var gi = 0; gi < geoids.length; gi++) {
      var p = parseGEOID(geoLevel, geoids[gi]);
      var key = p.state + "-" + p.county;
      if (!groups.has(key)) groups.set(key, { state: p.state, county: p.county });
    }

    var results = new Map();
    var base = "https://api.census.gov/data/" + year + "/acs/acs5";

    for (var entry of groups.values()) {
      var forClause, inClause;
      if (geoLevel === "tract") {
        forClause = "tract:*";
        inClause = "state:" + entry.state + "%20county:" + entry.county;
      } else {
        forClause = "block%20group:*";
        inClause = "state:" + entry.state + "%20county:" + entry.county + "%20tract:*";
      }

      var codesParam = varCodes.map(encodeURIComponent).join(",");
      var url = base + "?get=NAME," + codesParam + "&for=" + forClause + "&in=" + inClause + (App.CENSUS_API_KEY ? "&key=" + App.CENSUS_API_KEY : "");
      var resp = await fetch(url);
      if (!resp.ok) throw new Error("ACS API error " + resp.status + " for state " + entry.state + " county " + entry.county);
      var rows = await resp.json();

      var header = rows[0];
      var idxVars = varCodes.map(function (c) { return header.indexOf(c); });

      for (var i = 1; i < rows.length; i++) {
        var r = rows[i];
        var sum = 0;
        var hasAny = false;
        for (var vi = 0; vi < idxVars.length; vi++) {
          if (idxVars[vi] === -1) continue;
          var val = Number(r[idxVars[vi]]);
          // Skip Census sentinel values (negative placeholders like -666666666)
          if (Number.isFinite(val) && val >= 0) { sum += val; hasAny = true; }
        }
        if (!hasAny) continue;

        var geoid;
        if (geoLevel === "tract") {
          var tract = r[header.indexOf("tract")];
          var st = r[header.indexOf("state")];
          var co = r[header.indexOf("county")];
          geoid = st + co + tract;
        } else {
          var bg = r[header.indexOf("block group")];
          var tract2 = r[header.indexOf("tract")];
          var st2 = r[header.indexOf("state")];
          var co2 = r[header.indexOf("county")];
          geoid = st2 + co2 + tract2 + bg;
        }
        results.set(geoid, sum);
      }
    }
    return results;
  }

  // computeGeoOverlapFractions: the per-geo union-overlap fraction math used
  // by aggregateWithinUnion, exposed standalone so a caller can compute it
  // once and reuse it across many variables (and, for the choropleth hover
  // popup, show the apportioned share). apportionByArea true = fractional
  // area overlap (turf.intersect area ratio); false = 1 for any geo that
  // intersects the union, else the geo is simply absent from the returned
  // map (same skip-on-failure behavior as the inlined version this replaces).
  function computeGeoOverlapFractions(unionFeat, geos, apportionByArea) {
    var fractions = new Map();

    for (var fi = 0; fi < geos.length; fi++) {
      var f = geos[fi];
      var geoid = f.properties && f.properties.GEOID;
      if (!geoid) continue;

      var frac;
      if (apportionByArea) {
        var inter;
        try { inter = turf.intersect(f, unionFeat); } catch (_) { continue; }
        if (!inter) continue;
        var aInter = turf.area(inter);
        var aGeo = turf.area(f);
        if (aGeo <= 0) continue;
        frac = Math.min(1, Math.max(0, aInter / aGeo));
      } else {
        var intersects;
        try { intersects = turf.booleanIntersects(f, unionFeat); } catch (_) { continue; }
        if (!intersects) continue;
        frac = 1;
      }

      fractions.set(geoid, frac);
    }

    return fractions;
  }

  // aggregateWithinUnion: area-weighted aggregation of census values within a union polygon.
  // options.apportionByArea (default true): when false, uses full geography values for any
  // geo that intersects the union (no fractional area apportionment).
  // options.fractions (optional): a precomputed Map<GEOID, frac> from
  // computeGeoOverlapFractions — when present, it is used instead of
  // recomputing the overlap per call (a geo absent from the map is skipped,
  // same as a failed/no-overlap geo below). With no options.fractions,
  // behavior is byte-identical to before this option existed.
  function aggregateWithinUnion(unionFeat, geos, valueMap, aggMode, options) {
    var apportionByArea = !(options && options.apportionByArea === false);
    var precomputedFractions = options && options.fractions;
    var numerator = 0;
    var denom = 0;
    var used = 0;

    for (var fi = 0; fi < geos.length; fi++) {
      var f = geos[fi];
      var geoid = f.properties && f.properties.GEOID;
      if (!geoid) continue;
      var v = valueMap.get(geoid);
      if (v == null) continue;

      var frac;
      if (precomputedFractions) {
        if (!precomputedFractions.has(geoid)) continue;
        frac = precomputedFractions.get(geoid);
      } else if (apportionByArea) {
        var inter;
        try { inter = turf.intersect(f, unionFeat); } catch (_) { continue; }
        if (!inter) continue;
        var aInter = turf.area(inter);
        var aGeo = turf.area(f);
        if (aGeo <= 0) continue;
        frac = Math.min(1, Math.max(0, aInter / aGeo));
      } else {
        var intersects;
        try { intersects = turf.booleanIntersects(f, unionFeat); } catch (_) { continue; }
        if (!intersects) continue;
        frac = 1;
      }

      numerator += v * frac;
      denom += frac;
      used++;
    }

    if (aggMode === "avg") return { value: denom > 0 ? (numerator / denom) : NaN, used: used, weightSum: denom };
    return { value: numerator, used: used, weightSum: denom };
  }

  async function computeAcsValueOnly(varCode, year, geoLevel) {
    var unionFeat = App.bufferUnionPolygon();
    if (!unionFeat) return { value: NaN, used: 0 };

    var geos = await fetchTigerwebGeos(geoLevel, unionFeat);
    if (geos.length === 0) return { value: NaN, used: 0 };

    var geoids = geos.map(function (f) { return f.properties.GEOID; }).filter(Boolean);
    var valueMap = await fetchACSValues(geoLevel, year, varCode, geoids);

    var meta = App.getMeta(varCode);
    var agg = aggregateWithinUnion(unionFeat, geos, valueMap, meta.agg);
    return { value: agg.value, used: agg.used };
  }

  // --- Expose on App namespace ---

  App.renderCensusOverlay = renderCensusOverlay;
  App.clearCensusOverlay = clearCensusOverlay;
  App.fetchAllTigerwebFeatures = fetchAllTigerwebFeatures;
  App.fetchTigerwebGeos = fetchTigerwebGeos;
  App.parseGEOID = parseGEOID;
  App.fetchACSValues = fetchACSValues;
  App.fetchACSBatchCached = fetchACSBatchCached;
  App.fetchACSMultiValues = fetchACSMultiValues;
  App.fetchACSCountyValues = fetchACSCountyValues;
  App.aggregateWithinUnion = aggregateWithinUnion;
  App.computeGeoOverlapFractions = computeGeoOverlapFractions;
  App.computeAcsValueOnly = computeAcsValueOnly;

  // Shared session fetch cache control (awareness + override).
  App.censusCache = {
    clear: function () { _geoCache.clear(); _acsStore.clear(); _fetchedAt.clear(); },
    // Drop cached ACS for a (geoLevel, year) and all geos for that geoLevel so the
    // next run refetches — backs the per-module "Re-fetch" button.
    invalidate: function (geoLevel, year) {
      var acsPrefix = geoLevel + "|" + year + "|";
      Array.from(_acsStore.keys()).forEach(function (k) { if (k.indexOf(acsPrefix) === 0) _acsStore.delete(k); });
      var geoPrefix = geoLevel + "|";
      Array.from(_geoCache.keys()).forEach(function (k) { if (k.indexOf(geoPrefix) === 0) _geoCache.delete(k); });
      _fetchedAt.delete(geoLevel + "|" + year);
    },
    fetchedAt: function (geoLevel, year) { return _fetchedAt.get(geoLevel + "|" + year) || null; },
    stats: function () { return { geoKeys: _geoCache.size, acsCounties: _acsStore.size }; }
  };

  // ---- Per-module cache status line + Re-fetch (awareness + override) ----
  // opts = { geoSel, yearSel (option <select> elements), onRefetch (function) }.
  // Returns a DOM node with an el.refresh() method; auto-refreshes on fetches.
  App.buildCensusCacheStatus = function (opts) {
    opts = opts || {};
    var el = document.createElement("div");
    el.className = "cc-status";
    var txt = document.createElement("span");
    txt.className = "cc-status-text";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cc-refetch-btn";
    btn.textContent = "Re-fetch";
    btn.title = "Ignore cached census data and fetch fresh";
    el.appendChild(txt);
    el.appendChild(btn);

    function glOf() { return opts.geoSel ? opts.geoSel.value : null; }
    function yrOf() { return opts.yearSel ? opts.yearSel.value : null; }
    function glLabel(gl) { return gl === "tract" ? "Tract" : (gl === "bg" ? "BG" : (gl || "—")); }
    function fmtAge(ms) {
      var s = Math.floor((Date.now() - ms) / 1000);
      if (s < 10) return "just now";
      if (s < 60) return s + "s ago";
      var m = Math.floor(s / 60);
      if (m < 60) return m + "m ago";
      return Math.floor(m / 60) + "h ago";
    }

    el.refresh = function () {
      var gl = glOf(), yr = yrOf();
      var at = (gl && yr) ? App.censusCache.fetchedAt(gl, yr) : null;
      var tail = " · " + glLabel(gl) + " · " + (yr || "—");
      if (at) {
        var age = fmtAge(at);
        txt.textContent = "Census data: " + (age === "just now" ? "fetched just now" : "cached · fetched " + age) + tail;
        btn.style.display = "";
      } else {
        txt.textContent = "Census data: not yet fetched" + tail;
        btn.style.display = "none";
      }
    };

    btn.addEventListener("click", function () {
      var gl = glOf(), yr = yrOf();
      if (gl && yr) App.censusCache.invalidate(gl, yr);
      if (typeof opts.onRefetch === "function") opts.onRefetch();
    });

    if (opts.geoSel) opts.geoSel.addEventListener("change", el.refresh);
    if (opts.yearSel) opts.yearSel.addEventListener("change", el.refresh);
    window.addEventListener("mat:census-fetch", el.refresh);

    el.refresh();
    return el;
  };
})();
