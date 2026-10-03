// js/projects/title-vi-engine.js
// Title VI Service Equity Analysis — calculation engine (no DOM access).
// Depends on: App (census, feature lookup), turf (CDN). Exports: window.TitleVI
// Detail: docs/reference/modules/title-vi.md

(function () {
  "use strict";

  var TitleVI = window.TitleVI = {};

  // =========================================================================
  // Default policy profile
  // =========================================================================

  TitleVI.defaultPolicy = function () {
    return {
      name: "Agency Default Policy",
      majorChange: {
        routeMilesPct:   { enabled: true,  threshold: 25 },
        revenueHoursPct: { enabled: true,  threshold: 25 },
        spanHoursPct:    { enabled: false, threshold: 25 },
        routeElimination:  { enabled: true },
        eliminatedMilesPct:{ enabled: false, threshold: 25 },
        fareChangePct:     { enabled: false, threshold: 10 }
      },
      disparateImpactThresholdPpt: 15,
      disproportionateBurdenThresholdPpt: 15,
      geoLevel: "bg",
      acsYear: "2024",
      bufferDistanceMiles: 0.5
    };
  };

  // =========================================================================
  // Default scenario
  // =========================================================================

  var _nextScenarioId = 1;

  TitleVI.createScenario = function (name) {
    return {
      id: "scenario-" + (_nextScenarioId++),
      name: name || "Scenario " + (_nextScenarioId - 1),
      type: "service_change",
      alterations: [],
      impactMethod: "service_loss_area",
      notes: ""
    };
  };

  TitleVI.createAlteration = function (name) {
    return {
      name: name || "",
      changeType: "adjustment",
      before: null,   // { featureType, featureId (stable ID), featureName }
      after: null,
      computed: null,  // filled by computeAlterationMetrics
      manual: {
        revenueHours: { before: null, after: null },
        spanHours:    { before: null, after: null },
        fare:         { before: null, after: null }
      }
    };
  };

  // =========================================================================
  // Geometric divergence detection (pure)
  // =========================================================================

  /**
   * Detects where two route geometries diverge.
   * Samples points along the "before" route and measures distance to the
   * nearest point on the "after" route. Segments where the distance exceeds
   * the threshold are flagged as divergent.
   *
   * @param {Feature<LineString>} beforeFeature
   * @param {Feature<LineString>} afterFeature
   * @param {number} [divergenceThresholdMiles=0.25] Distance beyond which a
   *   sample point is considered divergent. (computeAlterationMetrics passes
   *   0.1 unless overridden, so 0.25 applies only to direct callers.)
   * @param {number} [sampleIntervalMiles=0.05] Sample spacing (~80m).
   * @returns {{ alteredPct, alteredMiles, totalMiles, divergentSegments[] }}
   */
  TitleVI.computeDivergence = function (beforeFeature, afterFeature, divergenceThresholdMiles, sampleIntervalMiles) {
    if (!beforeFeature || !afterFeature) return null;

    var interval = sampleIntervalMiles || 0.05;
    var threshold = divergenceThresholdMiles || 0.25;
    var totalMiles = turf.length(beforeFeature, { units: "miles" });
    if (totalMiles <= 0) return { alteredPct: 0, alteredMiles: 0, totalMiles: 0, divergentSegments: [] };

    var numSamples = Math.max(1, Math.floor(totalMiles / interval));
    var divergent = [];  // per-sample: beyond threshold?
    var distances = [];  // per-sample miles from the after-route

    for (var i = 0; i <= numSamples; i++) {
      var dist = Math.min(i * interval, totalMiles);
      var pt = turf.along(beforeFeature, dist, { units: "miles" });
      try {
        var nearest = turf.nearestPointOnLine(afterFeature, pt, { units: "miles" });
        var d = nearest.properties.dist || 0;
        distances.push(d);
        divergent.push(d > threshold);
      } catch (e) {
        distances.push(0);
        divergent.push(false);
      }
    }

    // Walk through divergent samples to identify contiguous segments
    var segments = [];
    var inSegment = false;
    var segStart = 0;
    var segMaxDist = 0;

    for (var j = 0; j <= numSamples; j++) {
      var mile = Math.min(j * interval, totalMiles);
      if (divergent[j]) {
        if (!inSegment) {
          inSegment = true;
          segStart = mile;
          segMaxDist = distances[j];
        } else {
          segMaxDist = Math.max(segMaxDist, distances[j]);
        }
      } else {
        if (inSegment) {
          var segEnd = Math.min((j - 1) * interval, totalMiles);
          segments.push({
            startMile: Math.round(segStart * 100) / 100,
            endMile: Math.round(segEnd * 100) / 100,
            maxDivergenceFt: Math.round(segMaxDist * 5280)
          });
          inSegment = false;
        }
      }
    }
    // Close open segment
    if (inSegment) {
      segments.push({
        startMile: Math.round(segStart * 100) / 100,
        endMile: Math.round(totalMiles * 100) / 100,
        maxDivergenceFt: Math.round(segMaxDist * 5280)
      });
    }

    var alteredMiles = 0;
    for (var s = 0; s < segments.length; s++) {
      alteredMiles += segments[s].endMile - segments[s].startMile;
    }
    var alteredPct = totalMiles > 0 ? (alteredMiles / totalMiles) * 100 : 0;

    return {
      alteredPct: Math.round(alteredPct * 10) / 10,
      alteredMiles: Math.round(alteredMiles * 100) / 100,
      totalMiles: Math.round(totalMiles * 100) / 100,
      divergentSegments: segments
    };
  };

  // =========================================================================
  // Service change area computation (pure)
  // =========================================================================

  /**
   * Computes the geographic areas that lose and gain transit coverage when
   * a route is realigned.
   *
   * @param {Feature<LineString>} beforeFeature
   * @param {Feature<LineString>} afterFeature
   * @param {number} bufferMiles  Buffer distance (e.g. 0.5)
   * @returns {{ serviceLossArea, serviceGainArea, beforeBuffer, afterBuffer }}
   */
  TitleVI.computeServiceChangeArea = function (beforeFeature, afterFeature, bufferMiles) {
    var result = { serviceLossArea: null, serviceGainArea: null, beforeBuffer: null, afterBuffer: null };
    if (!bufferMiles || bufferMiles <= 0) return result;

    if (beforeFeature) {
      result.beforeBuffer = turf.buffer(beforeFeature, bufferMiles, { units: "miles", steps: 64 });
    }
    if (afterFeature) {
      result.afterBuffer = turf.buffer(afterFeature, bufferMiles, { units: "miles", steps: 64 });
    }

    if (result.beforeBuffer && result.afterBuffer) {
      try { result.serviceLossArea = turf.difference(result.beforeBuffer, result.afterBuffer); } catch (e) { /* skip */ }
      try { result.serviceGainArea = turf.difference(result.afterBuffer, result.beforeBuffer); } catch (e) { /* skip */ }
    }

    return result;
  };

  // =========================================================================
  // Alteration metrics (orchestrator, pure)
  // =========================================================================

  /**
   * Resolves feature references and computes all geometric metrics for a
   * single route alteration.
   *
   * @param {object} alteration  Route alteration object (see data model)
   * @param {number} bufferMiles Buffer distance for service change area
   * @param {number} [divergenceThresholdMiles] Override for divergence detection
   * @returns {object} The computed metrics object
   */
  TitleVI.computeAlterationMetrics = function (alteration, bufferMiles, divergenceThresholdMiles) {
    var App = window.App;
    var computed = {
      beforeMiles: null,
      afterMiles: null,
      routeMilesPct: null,
      alteredPct: null,
      alteredMiles: null,
      serviceLossArea: null,
      serviceGainArea: null,
      divergentSegments: []
    };

    var beforeFeature = resolveFeature(alteration.before);
    var afterFeature  = resolveFeature(alteration.after);

    var changeType = alteration.changeType || "adjustment";

    if (changeType === "elimination") {
      // No after — entire route is removed
      if (beforeFeature) {
        computed.beforeMiles = round2(turf.length(beforeFeature, { units: "miles" }));
        computed.afterMiles = 0;
        computed.routeMilesPct = -100;
        computed.alteredPct = 100;
        computed.alteredMiles = computed.beforeMiles;
        if (bufferMiles > 0) {
          computed.serviceLossArea = turf.buffer(beforeFeature, bufferMiles, { units: "miles", steps: 64 });
        }
      }
    } else if (changeType === "new_route") {
      // No before — brand new route
      if (afterFeature) {
        computed.beforeMiles = 0;
        computed.afterMiles = round2(turf.length(afterFeature, { units: "miles" }));
        computed.routeMilesPct = null; // undefined — no base to compare
        computed.alteredPct = null;
        if (bufferMiles > 0) {
          computed.serviceGainArea = turf.buffer(afterFeature, bufferMiles, { units: "miles", steps: 64 });
        }
      }
    } else {
      // Standard alteration — both before and after
      if (beforeFeature) {
        computed.beforeMiles = round2(turf.length(beforeFeature, { units: "miles" }));
      }
      if (afterFeature) {
        computed.afterMiles = round2(turf.length(afterFeature, { units: "miles" }));
      }

      if (Number.isFinite(computed.beforeMiles) && Number.isFinite(computed.afterMiles) && computed.beforeMiles > 0) {
        computed.routeMilesPct = round1(((computed.afterMiles - computed.beforeMiles) / computed.beforeMiles) * 100);
      }

      if (beforeFeature && afterFeature) {
        var divThresh = divergenceThresholdMiles || 0.1;
        var divergence = TitleVI.computeDivergence(beforeFeature, afterFeature, divThresh);
        if (divergence) {
          computed.alteredPct = divergence.alteredPct;
          computed.alteredMiles = divergence.alteredMiles;
          computed.divergentSegments = divergence.divergentSegments;
        }
      }

      if (beforeFeature && afterFeature && bufferMiles > 0) {
        var areas = TitleVI.computeServiceChangeArea(beforeFeature, afterFeature, bufferMiles);
        computed.serviceLossArea = areas.serviceLossArea;
        computed.serviceGainArea = areas.serviceGainArea;
      }
    }

    var manual = alteration.manual || {};
    computed.revenueHoursPct = pctChangeNullable(
      manual.revenueHours && manual.revenueHours.before,
      manual.revenueHours && manual.revenueHours.after
    );
    computed.spanHoursPct = pctChangeNullable(
      manual.spanHours && manual.spanHours.before,
      manual.spanHours && manual.spanHours.after
    );
    computed.farePct = pctChangeNullable(
      manual.fare && manual.fare.before,
      manual.fare && manual.fare.after
    );

    return computed;
  };

  // Resolves a { featureType, featureId } ref to the live feature by stable ID
  // (never by array index, which shifts on delete/merge). Returns null when the
  // feature no longer exists — callers must treat that as "missing", not fall
  // back to anything else. Legacy index-only refs are migrated to IDs at
  // session restore (title-vi.js applyState) and so never reach here.
  function resolveFeature(ref) {
    if (!ref || typeof ref.featureId !== "number") return null;
    var App = window.App;
    if (ref.featureType !== "route" && ref.featureType !== "line") return null;
    return App.featureById ? App.featureById(ref.featureType, ref.featureId) : null;
  }

  TitleVI.resolveFeature = resolveFeature;

  // Lists the before/after refs a scenario's alterations NEED (per change type:
  // adjustment = both, elimination = before, new_route = after) that point at a
  // feature which no longer exists. → [{ altName, which: "before"|"after" }].
  TitleVI.findMissingRefs = function (scenario) {
    var out = [];
    ((scenario && scenario.alterations) || []).forEach(function (alt) {
      var ct = alt.changeType || "adjustment";
      var needBefore = ct !== "new_route";
      var needAfter  = ct !== "elimination";
      if (needBefore && alt.before && !resolveFeature(alt.before)) out.push({ altName: alt.name, which: "before" });
      if (needAfter  && alt.after  && !resolveFeature(alt.after))  out.push({ altName: alt.name, which: "after" });
    });
    return out;
  };

  function pctChangeNullable(before, after) {
    if (!Number.isFinite(before) || before === 0 || !Number.isFinite(after)) return null;
    return round1(((after - before) / before) * 100);
  }

  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }

  // =========================================================================
  // Route metrics computation (pure) — legacy CSV-based (kept for comparison)
  // =========================================================================

  TitleVI.computeRouteMetrics = function (route) {
    var b = route.before || {};
    var a = route.after  || {};

    function pctChange(before, after) {
      if (!Number.isFinite(before) || before === 0) return null;
      if (!Number.isFinite(after)) return null;
      return ((after - before) / before) * 100;
    }

    return {
      routeId: route.routeId,
      routeName: route.routeName,
      changeType: route.changeType,
      routeMilesPct:   pctChange(b.routeMiles, a.routeMiles),
      revenueHoursPct: pctChange(b.revenueHours, a.revenueHours),
      spanHoursPct:    pctChange(b.spanHours, a.spanHours),
      farePct:         pctChange(b.fare, a.fare),
      isElimination:   route.changeType === "elimination",
      isNewRoute:      route.changeType === "new_route"
    };
  };

  // =========================================================================
  // Major Service Change evaluation (pure)
  // =========================================================================

  var RULE_DEFS = {
    routeMilesPct:   { label: "Route miles changed",    metric: "routeMilesPct",   absCompare: true },
    revenueHoursPct: { label: "Revenue hours changed",  metric: "revenueHoursPct", absCompare: true },
    spanHoursPct:    { label: "Span of service changed", metric: "spanHoursPct",   absCompare: true },
    routeElimination:  { label: "Route eliminated",              metric: "isElimination", isBoolean: true },
    eliminatedMilesPct:{ label: "Eliminated / altered miles", metric: "alteredPct",    absCompare: true },
    fareChangePct:     { label: "Fare changed",                metric: "farePct",       absCompare: true }
  };

  TitleVI.evaluateMajorChange = function (policy, scenario) {
    var rules = policy.majorChange || {};
    var alterations = scenario.alterations || [];
    var ruleResults = [];
    var triggered = false;

    // Build per-alteration metric objects from computed + manual data
    var altMetrics = alterations.map(function (alt) {
      var c = alt.computed || {};
      return {
        routeName: alt.name || "(unnamed)",
        changeType: alt.changeType,
        routeMilesPct:   c.routeMilesPct,
        revenueHoursPct: c.revenueHoursPct,
        spanHoursPct:    c.spanHoursPct,
        farePct:         c.farePct,
        isElimination:   alt.changeType === "elimination",
        isNewRoute:      alt.changeType === "new_route"
      };
    });

    Object.keys(RULE_DEFS).forEach(function (ruleId) {
      var ruleCfg = rules[ruleId];
      if (!ruleCfg || !ruleCfg.enabled) return;

      var def = RULE_DEFS[ruleId];

      for (var i = 0; i < altMetrics.length; i++) {
        var rm = altMetrics[i];
        var value = rm[def.metric];

        var ruleTriggered = false;
        if (def.isBoolean) {
          ruleTriggered = !!value;
        } else if (Number.isFinite(value)) {
          var compareVal = def.absCompare ? Math.abs(value) : value;
          ruleTriggered = compareVal >= ruleCfg.threshold;
        }

        if (ruleTriggered) triggered = true;

        ruleResults.push({
          ruleId: ruleId,
          label: def.label,
          routeName: rm.routeName,
          metricValue: def.isBoolean ? (value ? "Yes" : "No") : value,
          threshold: ruleCfg.threshold || null,
          triggered: ruleTriggered
        });
      }
    });

    return {
      triggered: triggered,
      ruleResults: ruleResults,
      altMetrics: altMetrics
    };
  };

  // =========================================================================
  // Impacted area construction (async)
  // =========================================================================

  TitleVI.buildImpactedArea = function (scenario) {
    var method = scenario.impactMethod || "service_loss_area";
    var alterations = scenario.alterations || [];
    var geometry = null;

    if (method === "service_loss_area" || method === "service_change_area") {
      // Union loss areas (and optionally gain areas) from all alterations
      var areas = [];
      for (var a = 0; a < alterations.length; a++) {
        var c = alterations[a].computed;
        if (!c) continue;
        if (c.serviceLossArea) areas.push(c.serviceLossArea);
        if (method === "service_change_area" && c.serviceGainArea) areas.push(c.serviceGainArea);
      }
      if (areas.length > 0) {
        geometry = areas[0];
        for (var ai = 1; ai < areas.length; ai++) {
          try { geometry = turf.union(geometry, areas[ai]); } catch (e) { /* skip */ }
        }
      }
      // Fallback: if no service change areas computed, fall back to before-route buffers
      if (!geometry) {
        var fallbackBufs = [];
        for (var fb = 0; fb < alterations.length; fb++) {
          var ref = alterations[fb].before;
          if (!ref) continue;
          var feat = resolveFeature(ref);
          if (feat) {
            try { fallbackBufs.push(turf.buffer(feat, 0.5, { units: "miles", steps: 64 })); } catch (e) { /* skip */ }
          }
        }
        if (fallbackBufs.length > 0) {
          geometry = fallbackBufs[0];
          for (var fi = 1; fi < fallbackBufs.length; fi++) {
            try { geometry = turf.union(geometry, fallbackBufs[fi]); } catch (e) { /* skip */ }
          }
        }
      }
    } else if (method === "full_route_buffer") {
      // Union all route and line buffers
      var allBuffers = [];
      var routeBuffers = App.routeBuffers || [];
      var lineBuffers = App.lineBuffers || [];
      for (var i = 0; i < routeBuffers.length; i++) allBuffers.push(routeBuffers[i]);
      for (var j = 0; j < lineBuffers.length; j++) allBuffers.push(lineBuffers[j]);
      if (allBuffers.length > 0) {
        geometry = allBuffers[0];
        for (var k = 1; k < allBuffers.length; k++) {
          try { geometry = turf.union(geometry, allBuffers[k]); } catch (e) { /* skip */ }
        }
      }
    } else if (method === "user_polygon") {
      // Union drawn polygons
      var polygons = App.polygons || [];
      var selected = polygons.filter(Boolean);
      if (selected.length > 0) {
        geometry = selected[0];
        for (var p = 1; p < selected.length; p++) {
          try { geometry = turf.union(geometry, selected[p]); } catch (e) { /* skip */ }
        }
      }
    }

    return { geometry: geometry, method: method };
  };

  // =========================================================================
  // Demographic computation (async — Census API calls)
  // =========================================================================

  TitleVI.fetchDemographics = async function (core, unionGeom, geoLevel, year) {
    if (!unionGeom) throw new Error("No impacted area geometry provided.");

    // 1. Fetch intersecting census geographies
    var geos = await core.fetchTigerwebGeos(geoLevel, unionGeom);
    if (!geos || geos.length === 0) {
      return { totalPop: 0, minorityPop: 0, minorityShare: 0, lowIncomePop: 0, lowIncomeShare: 0, geoCount: 0, geos: [] };
    }

    var geoids = geos.map(function (g) {
      return g.properties.GEOID || g.properties.GEOID20 || g.properties.GEOID10 || "";
    }).filter(Boolean);

    // 2. Fetch ACS variables
    var b03002_001 = await App.fetchACSValues(geoLevel, year, "B03002_001E", geoids);
    var b03002_003 = await App.fetchACSValues(geoLevel, year, "B03002_003E", geoids);

    // Poverty: try at requested geoLevel first
    var b17001_002 = await App.fetchACSValues(geoLevel, year, "B17001_002E", geoids);
    var b01003_001 = await App.fetchACSValues(geoLevel, year, "B01003_001E", geoids);

    // Tract-level fallback for poverty at block group level
    if (geoLevel === "bg") {
      var povertyFinite = 0;
      b17001_002.forEach(function (v) { if (Number.isFinite(v)) povertyFinite++; });
      if (povertyFinite === 0 && geos.length > 0) {
        // Re-fetch at tract level and remap to block groups
        var tractGeoids = [];
        var tractMap = {};
        geoids.forEach(function (bgId) {
          var tractId = bgId.substring(0, 11);
          if (!tractMap[tractId]) {
            tractMap[tractId] = true;
            tractGeoids.push(tractId);
          }
        });
        var tractPoverty = await App.fetchACSValues("tract", year, "B17001_002E", tractGeoids);
        // Map tract values back to block groups
        b17001_002 = new Map();
        geoids.forEach(function (bgId) {
          var tractId = bgId.substring(0, 11);
          var tv = tractPoverty.get(tractId);
          if (Number.isFinite(tv)) b17001_002.set(bgId, tv);
        });
      }
    }

    // 3. Aggregate within union
    var aggTotal    = core.aggregateWithinUnion(unionGeom, geos, b03002_001, "sum");
    var aggNhWhite  = core.aggregateWithinUnion(unionGeom, geos, b03002_003, "sum");
    var aggPoverty  = core.aggregateWithinUnion(unionGeom, geos, b17001_002, "sum");
    var aggTotalPop = core.aggregateWithinUnion(unionGeom, geos, b01003_001, "sum");

    // 4. Compute shares
    var totalPopB03 = aggTotal.value || 0;
    var nhWhite     = aggNhWhite.value || 0;
    var minorityPop = Math.max(0, totalPopB03 - nhWhite);
    var minorityShare = totalPopB03 > 0 ? minorityPop / totalPopB03 : 0;

    var totalPop     = aggTotalPop.value || 0;
    var lowIncomePop = aggPoverty.value || 0;
    var lowIncomeShare = totalPop > 0 ? lowIncomePop / totalPop : 0;

    return {
      totalPop: Math.round(totalPop),
      minorityPop: Math.round(minorityPop),
      minorityShare: minorityShare,
      lowIncomePop: Math.round(lowIncomePop),
      lowIncomeShare: lowIncomeShare,
      geoCount: geos.length,
      geos: geos
    };
  };

  // =========================================================================
  // Finding evaluation (pure)
  // =========================================================================

  TitleVI.evaluateFindings = function (impactedDemographics, baseline, policy) {
    var impMinority  = impactedDemographics.minorityShare || 0;
    var baseMinority = baseline.minorityShare || 0;
    var diThreshold  = policy.disparateImpactThresholdPpt || 15;

    var impLowIncome  = impactedDemographics.lowIncomeShare || 0;
    var baseLowIncome = baseline.lowIncomeShare || 0;
    var dbThreshold   = policy.disproportionateBurdenThresholdPpt || 15;

    var minDiffPpt = (impMinority - baseMinority) * 100;
    var liDiffPpt  = (impLowIncome - baseLowIncome) * 100;

    return {
      minority: {
        impactedShare: impMinority,
        baselineShare: baseMinority,
        diffPpt: Math.round(minDiffPpt * 10) / 10,
        thresholdPpt: diThreshold,
        exceedsThreshold: minDiffPpt >= diThreshold,
        finding: minDiffPpt >= diThreshold
          ? "Potential Disparate Impact"
          : "No Disparate Impact"
      },
      lowIncome: {
        impactedShare: impLowIncome,
        baselineShare: baseLowIncome,
        diffPpt: Math.round(liDiffPpt * 10) / 10,
        thresholdPpt: dbThreshold,
        exceedsThreshold: liDiffPpt >= dbThreshold,
        finding: liDiffPpt >= dbThreshold
          ? "Potential Disproportionate Burden"
          : "No Disproportionate Burden"
      }
    };
  };

  // =========================================================================
  // Scenario comparison (pure)
  // =========================================================================

  TitleVI.compareScenarios = function (scenarioResults) {
    return scenarioResults.map(function (sr) {
      var mc = sr.majorChangeResult || {};
      var dem = sr.demographics || {};
      var f = sr.findings || {};
      return {
        scenarioId: sr.scenarioId,
        scenarioName: sr.scenarioName,
        majorChangeTriggered: mc.triggered || false,
        triggeredRuleCount: (mc.ruleResults || []).filter(function (r) { return r.triggered; }).length,
        routesAffected: (sr.scenario && sr.scenario.alterations) ? sr.scenario.alterations.length : 0,
        totalPop: dem.totalPop || 0,
        minorityShare: dem.minorityShare || 0,
        lowIncomeShare: dem.lowIncomeShare || 0,
        minorityFinding: f.minority ? f.minority.finding : "N/A",
        minorityDiffPpt: f.minority ? f.minority.diffPpt : 0,
        minorityExceeds: f.minority ? f.minority.exceedsThreshold : false,
        lowIncomeFinding: f.lowIncome ? f.lowIncome.finding : "N/A",
        lowIncomeDiffPpt: f.lowIncome ? f.lowIncome.diffPpt : 0,
        lowIncomeExceeds: f.lowIncome ? f.lowIncome.exceedsThreshold : false
      };
    });
  };

})();
