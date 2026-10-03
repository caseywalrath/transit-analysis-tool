// js/projects/fta-small-starts.js — FTA Small Starts Land Use ratings: breakpoint classification,
// CRE / ESS / LBAR upload + computation. Tabbed popup (Ratings | Data Inputs).
// Depends on: App (utils, map, points, census, lodes), turf. Exports: none (self-registers).
// Detail: docs/reference/modules/fta-small-starts.md

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- FTA-local state ----

  var CRE_MAP     = null;  // Map(tractGEOID11 -> { total, high })
  var CRE_HEADERS = [];
  var CRE_ROWS    = [];

  var ESS_POINTS  = null;  // array of [lon, lat]
  var ESS_HEADERS = [];
  var ESS_ROWS    = [];

  var LBAR_SITES   = null;  // array of { lon, lat, units, county5? }
  var LBAR_HEADERS = [];
  var LBAR_ROWS    = [];

  var _bpRunning   = false;
  var _bpQueued    = false;
  var _initialized = false;
  var _activeTab   = "ratings";

  // Last computed rating values (for export + session persistence)
  var _lastRatings = null;
  // { popDensity: { value, label, pill }, employment: { ... }, lbar: { ... }, cre: { ... }, ess: { ... } }

  // ---- DOM guard ----

  function isPopupVisible() {
    return App.popup.isOpen() && App.popup.currentModuleId() === "fta-small-starts";
  }

  // ---- Tab switching ----

  function switchTab(id) {
    _activeTab = id;
    var tabs = document.querySelectorAll(".fta-tab");
    var panes = document.querySelectorAll(".fta-tab-content");
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute("data-tab") === id) {
        tabs[i].classList.add("fta-tab-active");
      } else {
        tabs[i].classList.remove("fta-tab-active");
      }
    }
    for (var j = 0; j < panes.length; j++) {
      if (panes[j].getAttribute("data-tab") === id) {
        panes[j].classList.add("fta-tab-visible");
      } else {
        panes[j].classList.remove("fta-tab-visible");
      }
    }
    if (isPopupVisible() && App.popup && App.popup.setLayoutMode) {
      App.popup.setLayoutMode(id === "data-inputs" ? "workspace" : (_lastRatings ? "results" : "setup"));
    }
  }

  // ---- LBAR map layer ----

  function lbarSitesToGeoJSON() {
    var feats = (LBAR_SITES || []).map(function (s, i) {
      return {
        type: "Feature",
        properties: { idx: i + 1 },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] }
      };
    });
    return { type: "FeatureCollection", features: feats };
  }

  function ensureLbarLayer() {
    var map = App.map;
    if (!map) return;
    var srcId   = "lbar-sites";
    var layerId = "lbar-sites-layer";
    var data    = lbarSitesToGeoJSON();
    if (!map.getSource(srcId)) {
      map.addSource(srcId, { type: "geojson", data: data });
      map.addLayer({
        id: layerId, type: "circle", source: srcId,
        paint: { "circle-radius": 3, "circle-color": "#333333", "circle-opacity": 0.85 }
      });
    } else {
      map.getSource(srcId).setData(data);
    }
  }

  function removeLbarLayer() {
    var map = App.map;
    if (!map) return;
    if (map.getLayer("lbar-sites-layer")) map.removeLayer("lbar-sites-layer");
    if (map.getSource("lbar-sites"))      map.removeSource("lbar-sites");
  }

  function refreshLbarLayerVisibility() {
    var cb = document.getElementById("ftaToggleLbarLayer");
    var on = cb && cb.checked;
    if (!on || !LBAR_SITES || LBAR_SITES.length === 0) { removeLbarLayer(); return; }
    ensureLbarLayer();
  }

  // ---- FTA breakpoint tables ----

  var BP = {
    popDensity: [
      { label: "High",        pill: "high", min: 15000 },
      { label: "Medium-High", pill: "mh",   min: 9600 },
      { label: "Medium",      pill: "med",  min: 5760 },
      { label: "Medium-Low",  pill: "ml",   min: 2560 },
      { label: "Low",         pill: "low",  min: -Infinity }
    ],
    employment: [
      { label: "High",        pill: "high", min: 220000 },
      { label: "Medium-High", pill: "mh",   min: 140000 },
      { label: "Medium",      pill: "med",  min: 70000 },
      { label: "Medium-Low",  pill: "ml",   min: 40000 },
      { label: "Low",         pill: "low",  min: -Infinity }
    ],
    lbarRatio: [
      { label: "High",        pill: "high", min: 2.50 },
      { label: "Medium-High", pill: "mh",   min: 2.25 },
      { label: "Medium",      pill: "med",  min: 1.50 },
      { label: "Medium-Low",  pill: "ml",   min: 1.10 },
      { label: "Low",         pill: "low",  min: -Infinity }
    ],
    communityRiskPct: [
      { label: "High",        pill: "high", min: 50.0 },
      { label: "Medium-High", pill: "mh",   min: 40.0 },
      { label: "Medium",      pill: "med",  min: 18.0 },
      { label: "Medium-Low",  pill: "ml",   min: 5.0 },
      { label: "Low",         pill: "low",  min: -Infinity }
    ],
    essentialAvg: [
      { label: "High",        pill: "high", min: 7.0 },
      { label: "Medium-High", pill: "mh",   min: 5.0 },
      { label: "Medium",      pill: "med",  min: 3.0 },
      { label: "Medium-Low",  pill: "ml",   min: 1.0 },
      { label: "Low",         pill: "low",  min: -Infinity }
    ]
  };

  var RATING_ORDER = ["Low", "Medium-Low", "Medium", "Medium-High", "High"];

  function classify(value, breakpoints) {
    if (!Number.isFinite(value)) return { label: "N/A", pill: "na" };
    for (var i = 0; i < breakpoints.length; i++) {
      if (value >= breakpoints[i].min) return { label: breakpoints[i].label, pill: breakpoints[i].pill };
    }
    return { label: "N/A", pill: "na" };
  }

  function bumpOneLevel(ratingLabel) {
    var idx = RATING_ORDER.indexOf(ratingLabel);
    if (idx < 0) return ratingLabel;
    return RATING_ORDER[Math.min(RATING_ORDER.length - 1, idx + 1)];
  }

  function setPill(elId, label, pillClass) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent = label;
    el.className   = "pill " + (pillClass || "na");
  }

  // ---- CRE builder + compute ----

  function buildCreMapFromRows(geoidCol, totalCol, highCol) {
    var m = new Map();
    for (var i = 0; i < CRE_ROWS.length; i++) {
      var r = CRE_ROWS[i];
      var geoid11 = App.normalizeTractGEOID(r[geoidCol]);
      if (!geoid11) continue;
      var total = App.toNumberSafe(r[totalCol]);
      var high  = App.toNumberSafe(r[highCol]);
      if (!Number.isFinite(total) || !Number.isFinite(high)) continue;
      m.set(geoid11, { total: total, high: high });
    }
    return m;
  }

  async function computeCommunityRiskFromCre() {
    var unionFeat = App.bufferUnionPolygon();
    if (!unionFeat || !CRE_MAP) return { pct: NaN, highInUnion: 0, totalInUnion: 0, used: 0 };
    var tracts   = await App.fetchTigerwebGeos("tract", unionFeat);
    var highSum  = 0;
    var totalSum = 0;
    var used     = 0;
    for (var i = 0; i < tracts.length; i++) {
      var t     = tracts[i];
      var geoid = t.properties && t.properties.GEOID;
      if (!geoid) continue;
      var v = CRE_MAP.get(geoid);
      if (!v) continue;
      var inter;
      try { inter = turf.intersect(t, unionFeat); } catch (_) { continue; }
      if (!inter) continue;
      var aInter = turf.area(inter);
      var aTract = turf.area(t);
      if (aTract <= 0) continue;
      var frac = Math.min(1, Math.max(0, aInter / aTract));
      highSum  += v.high  * frac;
      totalSum += v.total * frac;
      used++;
    }
    var pct = totalSum > 0 ? (highSum / totalSum) * 100 : NaN;
    return { pct: pct, highInUnion: highSum, totalInUnion: totalSum, used: used };
  }

  // ---- Essential services ----

  function extractPointsFromGeoJSON(obj) {
    var pts = [];
    if (!obj || obj.type !== "FeatureCollection" || !Array.isArray(obj.features)) return pts;
    for (var i = 0; i < obj.features.length; i++) {
      var f = obj.features[i];
      if (!f || !f.geometry || f.geometry.type !== "Point") continue;
      var c = f.geometry.coordinates;
      if (!Array.isArray(c) || c.length < 2) continue;
      var lon = Number(c[0]);
      var lat = Number(c[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push([lon, lat]);
    }
    return pts;
  }

  function buildPointsFromCsvRows(rows, latCol, lonCol) {
    var pts = [];
    for (var i = 0; i < rows.length; i++) {
      var r   = rows[i];
      var lat = App.toNumberSafe(r[latCol]);
      var lon = App.toNumberSafe(r[lonCol]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lon, lat]);
    }
    return pts;
  }

  function computeEssentialServicesAvg() {
    var pts = App.points;
    if (!ESS_POINTS || ESS_POINTS.length === 0 || pts.length === 0)
      return { avg: NaN, perPoint: [] };
    var perPoint = [];
    for (var si = 0; si < pts.length; si++) {
      var coords = pts[si].geometry.coordinates;
      var buf    = turf.circle(turf.point([coords[0], coords[1]]), 1.0, { units: "miles", steps: 64 });
      var count  = 0;
      for (var qi = 0; qi < ESS_POINTS.length; qi++) {
        if (turf.booleanPointInPolygon(turf.point(ESS_POINTS[qi]), buf)) count++;
      }
      perPoint.push(count);
    }
    var avg = perPoint.reduce(function (a, b) { return a + b; }, 0) / perPoint.length;
    return { avg: avg, perPoint: perPoint };
  }

  // ---- LBAR ----

  function buildLbarSitesFromGeoJSON(obj) {
    var sites = [];
    if (!obj || obj.type !== "FeatureCollection" || !Array.isArray(obj.features)) return sites;
    for (var i = 0; i < obj.features.length; i++) {
      var f = obj.features[i];
      if (!f || !f.geometry || f.geometry.type !== "Point") continue;
      var c = f.geometry.coordinates;
      if (!Array.isArray(c) || c.length < 2) continue;
      var lon = Number(c[0]);
      var lat = Number(c[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      var p     = f.properties || {};
      var units = App.toNumberSafe(
        p.units != null ? p.units : (p.UNITS != null ? p.UNITS :
        (p.lbar_units != null ? p.lbar_units : p.LBAR_UNITS))
      );
      if (!Number.isFinite(units)) continue;
      var county = String(
        p.county != null ? p.county : (p.COUNTY != null ? p.COUNTY :
        (p.county_fips != null ? p.county_fips : (p.COUNTY_FIPS != null ? p.COUNTY_FIPS : "")))
      ).trim();
      var county5 = county.replace(/\D/g, "").slice(0, 5);
      sites.push({ lon: lon, lat: lat, units: units, county5: county5 || null });
    }
    return sites;
  }

  function buildLbarSitesFromCsvRows(rows, latCol, lonCol, unitsCol, countyCol) {
    var sites = [];
    for (var i = 0; i < rows.length; i++) {
      var r     = rows[i];
      var lat   = App.toNumberSafe(r[latCol]);
      var lon   = App.toNumberSafe(r[lonCol]);
      var units = App.toNumberSafe(r[unitsCol]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(units)) continue;
      var county5 = null;
      if (countyCol) {
        var raw    = String(r[countyCol] != null ? r[countyCol] : "").trim();
        var digits = raw.replace(/\D/g, "");
        if (digits.length >= 5) county5 = digits.slice(0, 5);
      }
      sites.push({ lon: lon, lat: lat, units: units, county5: county5 });
    }
    return sites;
  }

  function parseCountyListInput() {
    var el = document.getElementById("ftaLbarCounties");
    var raw = (el ? el.value : "") || "";
    var parts   = raw.split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var cleaned = parts.map(function (x) { return x.replace(/\D/g, ""); })
                       .filter(function (x) { return x.length === 5; });
    return Array.from(new Set(cleaned));
  }

  async function computeLbarRatio() {
    var unionFeat = App.bufferUnionPolygon();
    if (!unionFeat || !LBAR_SITES || LBAR_SITES.length === 0) {
      return { ratio: NaN, sharePoint: NaN, shareCounty: NaN, note: "LBAR inventory not loaded." };
    }

    var year     = document.getElementById("ftaYearSelect").value;
    var geoLevel = document.getElementById("ftaGeoLevel").value;

    var lbarPoint = 0;
    for (var i = 0; i < LBAR_SITES.length; i++) {
      var s = LBAR_SITES[i];
      if (turf.booleanPointInPolygon(turf.point([s.lon, s.lat]), unionFeat)) lbarPoint += s.units;
    }

    var huPointRes  = await App.computeAcsValueOnly("B25001_001E", year, geoLevel);
    var huPoint     = huPointRes.value;
    var sharePoint  = (Number.isFinite(huPoint) && huPoint > 0) ? (lbarPoint / huPoint) : NaN;

    var counties = parseCountyListInput();
    if (counties.length === 0)
      return { ratio: NaN, sharePoint: sharePoint, shareCounty: NaN,
               note: "Enter project counties (5-digit FIPS) to compute county share." };

    var sitesWithCounty = LBAR_SITES.filter(function (s) { return s.county5 && s.county5.length === 5; });
    if (sitesWithCounty.length === 0)
      return { ratio: NaN, sharePoint: sharePoint, shareCounty: NaN,
               note: "LBAR inventory missing county FIPS per site; cannot compute county share." };

    var lbarCounty = 0;
    for (var j = 0; j < sitesWithCounty.length; j++) {
      if (counties.includes(sitesWithCounty[j].county5)) lbarCounty += sitesWithCounty[j].units;
    }

    var huCountyMap = await App.fetchACSCountyValues(year, "B25001_001E", counties);
    var huCounty = 0, huFound = 0;
    for (var k = 0; k < counties.length; k++) {
      var v = huCountyMap.get(counties[k]);
      if (v != null) { huCounty += v; huFound++; }
    }

    var shareCounty = (huFound > 0 && huCounty > 0) ? (lbarCounty / huCounty) : NaN;
    var ratio = (Number.isFinite(sharePoint) && Number.isFinite(shareCounty) && shareCounty > 0)
      ? (sharePoint / shareCounty) : NaN;
    var note = Number.isFinite(shareCounty)
      ? "LBAR county share=" + (shareCounty * 100).toFixed(2) + "% (" + huFound + "/" + counties.length + " counties found)"
      : "County share unavailable.";
    return { ratio: ratio, sharePoint: sharePoint, shareCounty: shareCounty, note: note };
  }

  // ---- Breakpoint ratings updater (concurrency guard) ----

  async function updateBreakpointRatings() {
    if (_bpRunning) { _bpQueued = true; return; }
    _bpRunning = true;
    try {
      do {
        _bpQueued = false;
        await _doUpdateBreakpointRatings();
      } while (_bpQueued);
    } finally {
      _bpRunning = false;
    }
  }

  async function _doUpdateBreakpointRatings() {
    if (!isPopupVisible()) return;

    var unionFeat = App.bufferUnionPolygon();
    var yearEl    = document.getElementById("ftaYearSelect");
    var geoEl     = document.getElementById("ftaGeoLevel");
    var year      = yearEl  ? yearEl.value  : "2023";
    var geoLevel  = geoEl   ? geoEl.value   : "bg";

    var runBtn   = document.getElementById("ftaRun");
    if (runBtn) runBtn.disabled = true;

    setPill("bpPopPill",  "N/A", "na");
    setPill("bpEmpPill",  "N/A", "na");
    setPill("bpLbarPill", "N/A", "na");
    setPill("bpCrePill",  "N/A", "na");
    setPill("bpEssPill",  "N/A", "na");

    var setVal = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt; };
    setVal("bpPopValue",  "\u2014");
    setVal("bpEmpValue",  "\u2014");
    setVal("bpLbarValue", "\u2014");
    setVal("bpCreValue",  "\u2014");
    setVal("bpEssValue",  "\u2014");
    setVal("bpLbarNote",  "Requires LBAR inventory + counties");
    setVal("bpCreNote",   "Requires CRE upload");
    setVal("bpEssNote",   "Requires ESS upload + points");

    _lastRatings = null;

    if (!unionFeat) {
      App.renderModuleState({
        statusEl: "ftaStatus",
        status: { kind: "stale", message: "Draw features on the map to define a study area." }
      });
      if (runBtn) runBtn.disabled = false;
      return;
    }

    App.renderModuleState({
      statusEl: "ftaStatus",
      status: { kind: "running", message: "Computing breakpoint ratings\u2026" }
    });
    App.setStatus("Computing breakpoint ratings\u2026");

    var ratings = {
      popDensity: { value: NaN, label: "N/A", pill: "na", formatted: "\u2014", source: "ACS B01003_001E / buffer union area" },
      employment: { value: NaN, label: "N/A", pill: "na", formatted: "\u2014", source: "LODES WAC C000" },
      lbar:       { value: NaN, label: "N/A", pill: "na", formatted: "\u2014", note: "Requires LBAR inventory + counties" },
      cre:        { value: NaN, label: "N/A", pill: "na", formatted: "\u2014", note: "Requires CRE upload" },
      ess:        { value: NaN, label: "N/A", pill: "na", formatted: "\u2014", note: "Requires ESS upload + points" }
    };

    try {
      // 1. Population density
      var SQM_PER_SQMI = 2589988.110336;
      var areaSqMi   = turf.area(unionFeat) / SQM_PER_SQMI;
      var popRes     = await App.computeAcsValueOnly("B01003_001E", year, geoLevel);
      var popTotal   = popRes.value;
      var popDensity = (Number.isFinite(popTotal) && areaSqMi > 0) ? (popTotal / areaSqMi) : NaN;

      var popFmt = Number.isFinite(popDensity)
        ? Math.round(popDensity).toLocaleString() + " persons/sq mi" : "\u2014";
      setVal("bpPopValue", popFmt);
      var popClass = classify(popDensity, BP.popDensity);
      setPill("bpPopPill", popClass.label, popClass.pill);
      ratings.popDensity = { value: popDensity, label: popClass.label, pill: popClass.pill, formatted: popFmt };

      // 2. Employment
      if (App.lodesData) {
        var empRes = await App.computeEmploymentServedOnly();
        var emp    = empRes.value;
        var empFmt = Number.isFinite(emp) ? emp.toLocaleString() + " jobs" : "\u2014";
        setVal("bpEmpValue", empFmt);
        var empClass = classify(emp, BP.employment);
        setPill("bpEmpPill", empClass.label, empClass.pill);
        ratings.employment = { value: emp, label: empClass.label, pill: empClass.pill, formatted: empFmt };
      }

      // 3. Community Risk
      if (CRE_MAP) {
        var cre    = await computeCommunityRiskFromCre();
        var pct    = cre.pct;
        var creFmt = Number.isFinite(pct) ? pct.toFixed(2) + "%" : "\u2014";
        setVal("bpCreValue", creFmt);
        var creClass = classify(pct, BP.communityRiskPct);
        setPill("bpCrePill", creClass.label, creClass.pill);
        var creNote = "Used " + cre.used + " intersecting tracts (area-apportioned).";
        setVal("bpCreNote", creNote);
        ratings.cre = { value: pct, label: creClass.label, pill: creClass.pill, formatted: creFmt, note: creNote };
      }

      // 4. Essential services
      if (ESS_POINTS && ESS_POINTS.length > 0 && App.points.length > 0) {
        var ess    = computeEssentialServicesAvg();
        var essFmt = Number.isFinite(ess.avg) ? ess.avg.toFixed(2) : "\u2014";
        setVal("bpEssValue", essFmt);
        var essClass = classify(ess.avg, BP.essentialAvg);
        setPill("bpEssPill", essClass.label, essClass.pill);
        var essNote = "1-mi buffers; " + App.points.length + " points; " + ESS_POINTS.length + " service points.";
        setVal("bpEssNote", essNote);
        ratings.ess = { value: ess.avg, label: essClass.label, pill: essClass.pill, formatted: essFmt, note: essNote };
      }

      // 5. LBAR
      if (LBAR_SITES && LBAR_SITES.length > 0) {
        var lbar = await computeLbarRatio();
        setVal("bpLbarNote", lbar.note || "");

        if (Number.isFinite(lbar.ratio)) {
          var lbarFmt = lbar.ratio.toFixed(2) + " (point " +
            (lbar.sharePoint * 100).toFixed(2) + "% / county " +
            (lbar.shareCounty * 100).toFixed(2) + "%)";
          setVal("bpLbarValue", lbarFmt);

          var cls = classify(lbar.ratio, BP.lbarRatio);

          // Boost if county share > 5%
          if (Number.isFinite(lbar.shareCounty) && lbar.shareCounty > 0.05) {
            var bumpedLabel = bumpOneLevel(cls.label);
            var pillMap     = { "Low": "low", "Medium-Low": "ml", "Medium": "med", "Medium-High": "mh", "High": "high" };
            cls = { label: bumpedLabel, pill: pillMap[bumpedLabel] || cls.pill };
            setVal("bpLbarNote", (lbar.note || "") + " | Boost applied (county share > 5%).");
          }
          setPill("bpLbarPill", cls.label, cls.pill);
          ratings.lbar = { value: lbar.ratio, label: cls.label, pill: cls.pill, formatted: lbarFmt,
                           note: document.getElementById("bpLbarNote") ? document.getElementById("bpLbarNote").textContent : "" };
        }
      }

      _lastRatings = ratings;

      App.renderModuleState({
        statusEl: "ftaStatus",
        status: { kind: "done", message: "Ratings computed successfully." }
      });
      App.setStatus("FTA ratings computed");
      renderInputs(true);
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");

      // Enable export
      var exportBtn = document.getElementById("ftaExportCSV");
      if (exportBtn) exportBtn.disabled = false;

    } catch (e) {
      console.error("FTA ratings error:", e);
      App.renderModuleState({
        statusEl: "ftaStatus",
        status: { kind: "error", message: "Error: " + (e.message || e) }
      });
      App.setStatus("FTA error");
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  // ---- Data indicators (left sidebar summary) ----

  function updateDataIndicators() {
    if (!isPopupVisible()) return;
    var setInd = function (id, loaded, detail) {
      var el = document.getElementById(id);
      if (!el) return;
      el.style.color = loaded ? "#065f46" : "var(--muted)";
      el.textContent = detail;
    };
    setInd("ftaLodesIndicator", !!App.lodesData,
      App.lodesData ? "LODES: loaded" : "LODES: not loaded");
    setInd("ftaCreIndicator", !!CRE_MAP,
      CRE_MAP ? "CRE: " + CRE_MAP.size + " tracts" : "CRE: not loaded");
    setInd("ftaEssIndicator", !!(ESS_POINTS && ESS_POINTS.length),
      ESS_POINTS && ESS_POINTS.length ? "ESS: " + ESS_POINTS.length + " points" : "ESS: not loaded");
    setInd("ftaLbarIndicator", !!(LBAR_SITES && LBAR_SITES.length),
      LBAR_SITES && LBAR_SITES.length ? "LBAR: " + LBAR_SITES.length + " sites" : "LBAR: not loaded");
  }

  // ---- Export ----

  function exportRatingsCSV() {
    if (!_lastRatings) return;
    var yearEl   = document.getElementById("ftaYearSelect");
    var geoEl    = document.getElementById("ftaGeoLevel");
    var year     = yearEl ? yearEl.value : "";
    var geoLevel = geoEl  ? geoEl.value  : "";

    var lines = [];
    lines.push("# FTA Small Starts (Land Use) — Breakpoint Ratings Export");
    lines.push("# Exported: " + new Date().toISOString());
    lines.push("# Geography: " + geoLevel);
    lines.push("# ACS Year: " + year);
    lines.push("");
    lines.push("Metric,Rating,Value,Note");

    var r = _lastRatings;
    lines.push('"Population Density","' + r.popDensity.label + '","' + r.popDensity.formatted + '","' + (r.popDensity.source || "") + '"');
    lines.push('"Employment Served","' + r.employment.label + '","' + r.employment.formatted + '","' + (r.employment.source || "") + '"');
    lines.push('"LBAR Ratio","' + r.lbar.label + '","' + r.lbar.formatted + '","' + (r.lbar.note || "").replace(/"/g, '""') + '"');
    lines.push('"Community Risk","' + r.cre.label + '","' + r.cre.formatted + '","' + (r.cre.note || "").replace(/"/g, '""') + '"');
    lines.push('"Essential Services","' + r.ess.label + '","' + r.ess.formatted + '","' + (r.ess.note || "").replace(/"/g, '""') + '"');

    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    var d    = new Date();
    a.href = url;
    a.download = "fta-ratings-" + d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + ".csv";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  // ---- Collapsible Ratings inputs (shared helper) ----

  function inputsSummary() {
    var geoEl = document.getElementById("ftaGeoLevel");
    var yearEl = document.getElementById("ftaYearSelect");
    var geoLabel = geoEl && geoEl.value === "tract" ? "Tracts" : "Block groups";
    return geoLabel + " \u00b7 " + (yearEl ? yearEl.value : "");
  }

  function renderInputs(collapsed) {
    App.renderModuleInputs({
      hostEl: document.querySelector('.fta-tab-content[data-tab="ratings"] .rf-settings-col'),
      collapsed: collapsed,
      summary: inputsSummary(),
      onToggle: function (isCollapsed) {
        if (!App.popup || !App.popup.setLayoutMode) return;
        App.popup.setLayoutMode(isCollapsed && _lastRatings ? "results" : "setup", true);
      }
    });
  }

  // ---- Init (called once on first popup open) ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    var tabs = document.querySelectorAll(".fta-tab");
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener("click", function (e) {
        switchTab(e.target.getAttribute("data-tab"));
      });
    }

    var runBtn = document.getElementById("ftaRun");
    if (runBtn) runBtn.addEventListener("click", function () { updateBreakpointRatings(); });

    var exportBtn = document.getElementById("ftaExportCSV");
    if (exportBtn) exportBtn.addEventListener("click", exportRatingsCSV);

    // LBAR layer toggle
    var toggleLbar = document.getElementById("ftaToggleLbarLayer");
    if (toggleLbar) toggleLbar.addEventListener("change", refreshLbarLayerVisibility);

    var ratingsSettings = document.querySelector('.fta-tab-content[data-tab="ratings"] .rf-settings-col');
    if (ratingsSettings) ratingsSettings.addEventListener("change", function () { renderInputs(); });
    renderInputs(false);

    // County FIPS (debounced)
    var _countyTimer = null;
    var countyInput  = document.getElementById("ftaLbarCounties");
    if (countyInput) {
      countyInput.addEventListener("input", function () {
        clearTimeout(_countyTimer);
        _countyTimer = setTimeout(function () {
          // don't auto-run; user will click Compute Ratings
        }, 500);
      });
    }

    // ---- CRE upload ----
    var creFileInput = document.getElementById("ftaCreFile");
    if (creFileInput) {
      creFileInput.addEventListener("change", async function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          App.setStatus("Loading CRE CSV\u2026");
          var text   = await file.text();
          var parsed = App.parseCSV(text);
          CRE_HEADERS = parsed.headers;
          CRE_ROWS    = parsed.rows;

          var sG = document.getElementById("ftaCreColGEOID");
          var sT = document.getElementById("ftaCreColTotal");
          var sH = document.getElementById("ftaCreColHigh");

          App.fillSelect(sG, CRE_HEADERS, "Select GEOID column\u2026");
          App.fillSelect(sT, CRE_HEADERS, "Select total pop column\u2026");
          App.fillSelect(sH, CRE_HEADERS, "Select high-risk pop column\u2026");
          App.enableSelect(sG, true);
          App.enableSelect(sT, true);
          App.enableSelect(sH, true);

          sG.value = App.guessHeader(CRE_HEADERS, ["GEO_ID", "geoid", "GEOID"]);
          sT.value = App.guessHeader(CRE_HEADERS, ["POPUNI", "total", "TOT_POP", "population"]);
          sH.value = App.guessHeader(CRE_HEADERS, ["PRED3_E", "HIGH_RISK", "high_risk", "risk3plus"]);

          function rebuildCre() {
            if (!sG.value || !sT.value || !sH.value) {
              CRE_MAP = null;
              var info = document.getElementById("ftaCreInfo");
              if (info) info.textContent = "Select required columns to enable CRE.";
              updateDataIndicators();
              return;
            }
            CRE_MAP = buildCreMapFromRows(sG.value, sT.value, sH.value);
            var sampleRaw  = CRE_ROWS.length ? CRE_ROWS[0][sG.value] : "";
            var sampleNorm = App.normalizeTractGEOID(sampleRaw);
            var info2 = document.getElementById("ftaCreInfo");
            if (info2) {
              info2.textContent = "Loaded " + file.name + ": " + CRE_MAP.size.toLocaleString() + " tracts." +
                (sampleRaw ? ' Sample: "' + sampleRaw + '" \u2192 "' + sampleNorm + '"' : "");
            }
            updateDataIndicators();
          }

          sG.onchange = rebuildCre;
          sT.onchange = rebuildCre;
          sH.onchange = rebuildCre;
          rebuildCre();
          App.setStatus("Ready");
        } catch (err) {
          CRE_MAP = null; CRE_HEADERS = []; CRE_ROWS = [];
          var info3 = document.getElementById("ftaCreInfo");
          if (info3) info3.textContent = "Error: " + (err.message || err);
          App.setStatus("Error");
          updateDataIndicators();
        }
      });
    }

    // ---- ESS upload ----
    var essFileInput = document.getElementById("ftaEssFile");
    if (essFileInput) {
      essFileInput.addEventListener("change", async function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          App.setStatus("Loading essential services\u2026");
          var name = file.name.toLowerCase();
          ESS_POINTS = null; ESS_HEADERS = []; ESS_ROWS = [];
          var latSel = document.getElementById("ftaEssColLat");
          var lonSel = document.getElementById("ftaEssColLon");

          if (name.endsWith(".json") || name.endsWith(".geojson")) {
            var text = await file.text();
            var obj  = JSON.parse(text);
            ESS_POINTS = extractPointsFromGeoJSON(obj);
            App.fillSelect(latSel, [], "N/A (GeoJSON)");
            App.fillSelect(lonSel, [], "N/A (GeoJSON)");
            App.enableSelect(latSel, false);
            App.enableSelect(lonSel, false);
            var info = document.getElementById("ftaEssInfo");
            if (info) info.textContent = "Loaded " + file.name + ": " + ESS_POINTS.length.toLocaleString() + " points.";
          } else if (name.endsWith(".csv")) {
            var csvText = await file.text();
            var parsed  = App.parseCSV(csvText);
            ESS_HEADERS = parsed.headers;
            ESS_ROWS    = parsed.rows;
            App.fillSelect(latSel, ESS_HEADERS, "Select latitude\u2026");
            App.fillSelect(lonSel, ESS_HEADERS, "Select longitude\u2026");
            App.enableSelect(latSel, true);
            App.enableSelect(lonSel, true);
            latSel.value = App.guessHeader(ESS_HEADERS, ["lat", "latitude", "y", "LAT", "Latitude"]);
            lonSel.value = App.guessHeader(ESS_HEADERS, ["lon", "lng", "longitude", "x", "LON", "Longitude"]);

            function rebuildEss() {
              if (!latSel.value || !lonSel.value) {
                ESS_POINTS = null;
                var i = document.getElementById("ftaEssInfo");
                if (i) i.textContent = "Select lat/lon columns.";
                updateDataIndicators();
                return;
              }
              ESS_POINTS = buildPointsFromCsvRows(ESS_ROWS, latSel.value, lonSel.value);
              var i2 = document.getElementById("ftaEssInfo");
              if (i2) i2.textContent = "Loaded " + file.name + ": " + ESS_POINTS.length.toLocaleString() + " points from CSV.";
              updateDataIndicators();
            }
            latSel.onchange = rebuildEss;
            lonSel.onchange = rebuildEss;
            rebuildEss();
          } else {
            throw new Error("Unsupported file type. Upload .geojson/.json or .csv.");
          }
          App.setStatus("Ready");
          updateDataIndicators();
        } catch (err) {
          ESS_POINTS = null;
          var info4 = document.getElementById("ftaEssInfo");
          if (info4) info4.textContent = "Error: " + (err.message || err);
          App.setStatus("Error");
          updateDataIndicators();
        }
      });
    }

    // ---- LBAR upload ----
    var lbarFileInput = document.getElementById("ftaLbarFile");
    if (lbarFileInput) {
      lbarFileInput.addEventListener("change", async function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          App.setStatus("Loading LBAR inventory\u2026");
          var name = file.name.toLowerCase();
          LBAR_SITES = null; LBAR_HEADERS = []; LBAR_ROWS = [];

          var latSel = document.getElementById("ftaLbarColLat");
          var lonSel = document.getElementById("ftaLbarColLon");
          var uniSel = document.getElementById("ftaLbarColUnits");
          var ctySel = document.getElementById("ftaLbarColCounty");

          if (name.endsWith(".json") || name.endsWith(".geojson")) {
            var text = await file.text();
            var obj  = JSON.parse(text);
            LBAR_SITES = buildLbarSitesFromGeoJSON(obj);
            App.fillSelect(latSel, [], "N/A (GeoJSON)");
            App.fillSelect(lonSel, [], "N/A (GeoJSON)");
            App.fillSelect(uniSel, [], "N/A (GeoJSON)");
            App.fillSelect(ctySel, [], "N/A (GeoJSON)");
            App.enableSelect(latSel, false);
            App.enableSelect(lonSel, false);
            App.enableSelect(uniSel, false);
            App.enableSelect(ctySel, false);
            var info = document.getElementById("ftaLbarInfo");
            if (info) info.textContent = "Loaded " + file.name + ": " + LBAR_SITES.length.toLocaleString() + " sites.";
            refreshLbarLayerVisibility();
          } else if (name.endsWith(".csv")) {
            var csvText = await file.text();
            var parsed  = App.parseCSV(csvText);
            LBAR_HEADERS = parsed.headers;
            LBAR_ROWS    = parsed.rows;
            App.fillSelect(latSel, LBAR_HEADERS, "Select latitude\u2026");
            App.fillSelect(lonSel, LBAR_HEADERS, "Select longitude\u2026");
            App.fillSelect(uniSel, LBAR_HEADERS, "Select units\u2026");
            App.fillSelect(ctySel, LBAR_HEADERS, "(Optional) County FIPS\u2026");
            App.enableSelect(latSel, true);
            App.enableSelect(lonSel, true);
            App.enableSelect(uniSel, true);
            App.enableSelect(ctySel, true);
            latSel.value = App.guessHeader(LBAR_HEADERS, ["lat", "latitude", "y", "LAT", "Latitude"]);
            lonSel.value = App.guessHeader(LBAR_HEADERS, ["lon", "lng", "longitude", "x", "LON", "Longitude"]);
            uniSel.value = App.guessHeader(LBAR_HEADERS, ["units", "lbar_units", "LBAR_UNITS", "UNITS", "Total Low-Income Units"]);
            ctySel.value = App.guessHeader(LBAR_HEADERS, ["county_fips", "county", "COUNTY", "COUNTY_FIPS", "FIPS"]);

            function rebuildLbar() {
              if (!latSel.value || !lonSel.value || !uniSel.value) {
                LBAR_SITES = null;
                var i = document.getElementById("ftaLbarInfo");
                if (i) i.textContent = "Select required columns (lat/lon/units).";
                refreshLbarLayerVisibility();
                updateDataIndicators();
                return;
              }
              LBAR_SITES = buildLbarSitesFromCsvRows(LBAR_ROWS, latSel.value, lonSel.value, uniSel.value, ctySel.value || null);
              var hasCounty = LBAR_SITES.some(function (s) { return s.county5 && s.county5.length === 5; });
              var i2 = document.getElementById("ftaLbarInfo");
              if (i2) i2.textContent = "Loaded " + file.name + ": " + LBAR_SITES.length.toLocaleString() + " sites. County: " + (hasCounty ? "Yes" : "No");
              refreshLbarLayerVisibility();
              updateDataIndicators();
            }
            latSel.onchange = rebuildLbar;
            lonSel.onchange = rebuildLbar;
            uniSel.onchange = rebuildLbar;
            ctySel.onchange = rebuildLbar;
            rebuildLbar();
          } else {
            throw new Error("Unsupported file type. Upload .geojson/.json or .csv.");
          }
          App.setStatus("Ready");
          updateDataIndicators();
        } catch (err) {
          LBAR_SITES = null;
          var info5 = document.getElementById("ftaLbarInfo");
          if (info5) info5.textContent = "Error: " + (err.message || err);
          App.setStatus("Error");
          refreshLbarLayerVisibility();
          updateDataIndicators();
        }
      });
    }
  }

  // ---- Popup lifecycle ----

  function onOpen(core) {
    switchTab(_activeTab);
    renderInputs(_lastRatings ? undefined : false);
    updateDataIndicators();
    // Show last ratings if available
    if (_lastRatings) {
      restoreRatingsDisplay(_lastRatings);
    }
  }

  function restoreRatingsDisplay(r) {
    if (!isPopupVisible()) return;
    var setVal = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt; };

    setPill("bpPopPill",  r.popDensity.label, r.popDensity.pill);
    setVal("bpPopValue",  r.popDensity.formatted);

    setPill("bpEmpPill",  r.employment.label, r.employment.pill);
    setVal("bpEmpValue",  r.employment.formatted);

    setPill("bpLbarPill", r.lbar.label, r.lbar.pill);
    setVal("bpLbarValue", r.lbar.formatted);
    if (r.lbar.note) setVal("bpLbarNote", r.lbar.note);

    setPill("bpCrePill",  r.cre.label, r.cre.pill);
    setVal("bpCreValue",  r.cre.formatted);
    if (r.cre.note) setVal("bpCreNote", r.cre.note);

    setPill("bpEssPill",  r.ess.label, r.ess.pill);
    setVal("bpEssValue",  r.ess.formatted);
    if (r.ess.note) setVal("bpEssNote", r.ess.note);

    var exportBtn = document.getElementById("ftaExportCSV");
    if (exportBtn) exportBtn.disabled = false;

    App.renderModuleState({
      statusEl: "ftaStatus",
      status: { kind: "done", message: "Ratings computed successfully." }
    });
  }

  function onClose(core) {
    // State persists in closure
  }

  async function update(core) {
    refreshLbarLayerVisibility();
    if (isPopupVisible()) {
      updateDataIndicators();
    }
  }

  // ---- Session persistence ----

  function saveFtaState(mode) {
    var data = {
      activeTab:  _activeTab,
      hasCre:     !!CRE_MAP,
      creSize:    CRE_MAP ? CRE_MAP.size : 0,
      hasEss:     !!(ESS_POINTS && ESS_POINTS.length),
      essCount:   ESS_POINTS ? ESS_POINTS.length : 0,
      hasLbar:    !!(LBAR_SITES && LBAR_SITES.length),
      lbarCount:  LBAR_SITES ? LBAR_SITES.length : 0
    };
    if (_lastRatings) {
      data.lastRatings = JSON.parse(JSON.stringify(_lastRatings));
    }
    return data;
  }

  function restoreFtaState(data) {
    if (!data) return;
    if (data.activeTab) _activeTab = data.activeTab;
    if (data.lastRatings) _lastRatings = data.lastRatings;
    // Note: uploaded file data (CRE_MAP, ESS_POINTS, LBAR_SITES) is NOT persisted
    // because it's too large. The user must re-upload files after a session restore.
  }

  // ---- Register as analysis module ----

  App.registerModule({
    id:         "fta-small-starts",
    name:       "FTA Small Starts (Land Use)",
    enabled:    true,
    popupWidth: 1000,
    panelWidths: { setup: 520, results: 520, workspace: 1000 },
    popupHTML:  "projects/fta-small-starts-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    update:  async function (core) { await update(core); }
  });

  // Register with session cache
  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("fta", {
      collect: saveFtaState,
      apply:   restoreFtaState
    });
  }

})();
