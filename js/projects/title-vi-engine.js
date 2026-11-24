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
      apportionMethod: (window.App && window.App.APPORTION_DEFAULT) || "blockPop",
      bufferDistanceMiles: 0.5,
      lowIncomeDefinition: "poverty100",
      serviceEquity: TitleVI.defaultServiceEquity()
    };
  };

  // Service Equity settings: walk distance to a stop by mode, the optional half-mile rule for
  // frequent stops, and the four-fifths threshold for the trips-per-resident ratio.
  TitleVI.defaultServiceEquity = function () {
    return { busBufferMiles: 0.25, railBufferMiles: 0.5, frequentHalfMile: false,
      frequentHeadwayMin: 15, fourFifths: 0.8 };
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

  // options.apportionMethod ("blockPop" | "area" | "whole", default "area" so
  // direct callers keep their numbers) says how residents of partly covered
  // geographies are counted.
  // Persons in the policy's low-income group per geography: below poverty (B17001, the default) or
  // below 200 % of poverty (C17002 ratio of income to poverty, rows 2–7 summed). B17001 is published
  // for tracts only, so at block-group level a tract's low-income RATE is applied to each block group's
  // population: giving every block group its whole tract's count multiplied low-income residents by the
  // number of block groups in the tract.
  //   popByGeo : Map<geoid, total population> at geoLevel (B01003)
  TitleVI.fetchLowIncomeValues = async function (geoLevel, year, definition, geoids, popByGeo) {
    var spec = window.ServiceEquity ? window.ServiceEquity.lowIncomeSpec(definition)
      : { id: "poverty100", vars: ["B17001_002E"] };
    spec.universe = spec.id === "poverty200" ? "C17002_001E" : "B17001_001E";
    // One variable goes through the cached single-variable fetch, as before; a sum needs the multi fetch.
    var fetchSum = function (level, ids) {
      return spec.vars.length === 1 ? App.fetchACSValues(level, year, spec.vars[0], ids)
        : App.fetchACSMultiValues(level, year, spec.vars, ids);
    };
    var vals;
    try { vals = await fetchSum(geoLevel, geoids); } catch (e) {
      if (geoLevel !== "bg") throw e;
      vals = new Map();
    }
    if (geoLevel !== "bg") return vals;
    var finite = 0;
    vals.forEach(function (v) { if (Number.isFinite(v)) finite++; });
    if (finite > 0 || !geoids.length) return vals;
    var tractIds = [], seen = Object.create(null);
    geoids.forEach(function (id) {
      var t = id.substring(0, 11);
      if (!seen[t]) { seen[t] = true; tractIds.push(t); }
    });
    var tLow = await fetchSum("tract", tractIds);
    // The rate's denominator is the poverty universe (people whose poverty status is known), not total
    // population: group-quarters residents are outside it and would dilute the rate.
    var tPop = await App.fetchACSValues("tract", year, spec.universe || "B01003_001E", tractIds);
    var out = new Map();
    geoids.forEach(function (id) {
      var t = id.substring(0, 11), lo = tLow.get(t), tp = tPop.get(t), bp = popByGeo ? popByGeo.get(id) : NaN;
      if (Number.isFinite(lo) && Number.isFinite(tp) && tp > 0 && Number.isFinite(bp)) out.set(id, lo / tp * bp);
    });
    return out;
  };

  TitleVI.fetchDemographics = async function (core, unionGeom, geoLevel, year, options) {
    if (!unionGeom) throw new Error("No impacted area geometry provided.");

    // 1. Fetch intersecting census geographies
    var geos = await core.fetchTigerwebGeos(geoLevel, unionGeom);
    if (!geos || geos.length === 0) {
      return { totalPop: 0, minorityPop: 0, minorityShare: 0, lowIncomePop: 0, lowIncomeShare: 0, geoCount: 0, geos: [], apportionMethodUsed: null, apportionNote: null };
    }

    var geoids = geos.map(function (g) {
      return g.properties.GEOID || g.properties.GEOID20 || g.properties.GEOID10 || "";
    }).filter(Boolean);

    // 2. Fetch ACS variables
    var b03002_001 = await App.fetchACSValues(geoLevel, year, "B03002_001E", geoids);
    var b03002_003 = await App.fetchACSValues(geoLevel, year, "B03002_003E", geoids);

    var b01003_001 = await App.fetchACSValues(geoLevel, year, "B01003_001E", geoids);
    var b17001_002 = await TitleVI.fetchLowIncomeValues(geoLevel, year, options && options.lowIncomeDefinition,
      geoids, b01003_001);

    // 3. Aggregate within union
    // Fractions are computed once and shared by all four sums so the shares stay consistent.
    var apMethod = (options && options.apportionMethod) || "area";
    var apFn = core.computeApportionFractions || App.computeApportionFractions;
    var ap = await apFn(unionGeom, geos, apMethod);
    var aggOpts = { fractions: ap.fractions };
    var aggTotal    = core.aggregateWithinUnion(unionGeom, geos, b03002_001, "sum", aggOpts);
    var aggNhWhite  = core.aggregateWithinUnion(unionGeom, geos, b03002_003, "sum", aggOpts);
    var aggPoverty  = core.aggregateWithinUnion(unionGeom, geos, b17001_002, "sum", aggOpts);
    var aggTotalPop = core.aggregateWithinUnion(unionGeom, geos, b01003_001, "sum", aggOpts);

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
      geos: geos,
      apportionMethodUsed: ap.methodUsed,
      apportionNote: ap.note
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

  // =========================================================================
  // Service Equity (trips per resident from the analysis network)
  // =========================================================================

  // One row per stop with service: its walk buffer (rail where any rail route stops, else bus; the
  // frequent-stop rule widens it to ½ mi at or under the peak headway cut) and its trips for the day.
  TitleVI.serviceEquityStops = function (network, dayParts, settings) {
    var se = Object.assign(TitleVI.defaultServiceEquity(), settings || {});
    if (!network || !window.AnalysisNetwork) return [];
    var rail = [];
    network.trips.forEach(function (t) {
      var r = network.routes[t.routeKey];
      if (!r || r.mode !== "rail") return;
      for (var j = 0; j < t.stops.length; j++) rail[t.stops[j]] = true;
    });
    var out = [];
    window.AnalysisNetwork.stopService(network, dayParts).forEach(function (row) {
      var k = network.stopIndex[row.stopId], st = network.stops[k];
      if (!st || !Number.isFinite(st.lat) || !Number.isFinite(st.lon)) return;
      var isRail = !!rail[k];
      var r = isRail ? se.railBufferMiles : se.busBufferMiles;
      var frequent = row.peakHeadwaySec != null && row.peakHeadwaySec > 0 &&
        row.peakHeadwaySec <= se.frequentHeadwayMin * 60;
      if (se.frequentHalfMile && frequent) r = Math.max(r, 0.5);
      out.push({ id: row.stopId, name: st.name, source: st.source, lat: st.lat, lon: st.lon,
        radiusMi: r, trips: row.trips, rail: isRail, frequent: frequent });
    });
    return out;
  };

  // The whole run. Region = census geographies touching the stops' convex hull widened by the largest
  // stop buffer, so unserved neighbourhoods between routes count toward the regional averages.
  //   opts : { includeHidden, date, onProgress(text) }
  TitleVI.runServiceEquity = async function (core, policy, opts) {
    opts = opts || {};
    var progress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
    var se = Object.assign(TitleVI.defaultServiceEquity(), (policy && policy.serviceEquity) || {});
    var geoLevel = policy && policy.geoLevel === "tract" ? "tract" : "bg";
    var year = (policy && policy.acsYear) || "2024";
    if (!window.ServiceEquity) throw new Error("The Service Equity engine did not load.");
    if (typeof App.buildAnalysisNetwork !== "function") throw new Error("The analysis network is not available.");

    progress("Building the network\u2026");
    var netOpts = { includeHidden: !!opts.includeHidden };
    if (opts.date) netOpts.date = opts.date;
    var network = App.buildAnalysisNetwork(netOpts);
    if (!network || !network.trips.length) {
      throw new Error("No service to test. Load a GTFS feed with service on the analysis date, or draw a Service with a schedule and run time.");
    }
    var dayParts = App.gtfsDayParts && App.gtfsDayParts.get ? App.gtfsDayParts.get() : null;
    var stops = TitleVI.serviceEquityStops(network, dayParts, se);
    if (!stops.length) throw new Error("No stops with service and a location.");

    var pts = turf.featureCollection(stops.map(function (s) { return turf.point([s.lon, s.lat]); }));
    var hull = null;
    try { hull = stops.length >= 3 ? turf.convex(pts) : null; } catch (e) { hull = null; }
    var maxR = 0;
    stops.forEach(function (s) { if (s.radiusMi > maxR) maxR = s.radiusMi; });
    // One stop, or stops in a straight line, have no hull; a zero-area bbox does not buffer reliably, so
    // widen the bbox by the buffer distance instead.
    var region;
    if (hull) region = turf.buffer(hull, maxR, { units: "miles" });
    else {
      var bb = turf.bbox(pts), midLat = (bb[1] + bb[3]) / 2;
      var dLat = maxR / 69, dLon = maxR / (69 * Math.max(0.01, Math.cos(midLat * Math.PI / 180)));
      region = turf.bboxPolygon([bb[0] - dLon, bb[1] - dLat, bb[2] + dLon, bb[3] + dLat]);
    }

    progress("Fetching census geographies\u2026");
    var geos = await core.fetchTigerwebGeos(geoLevel, region);
    if (!geos || !geos.length) throw new Error("No census geographies found around the stops.");
    var geoids = geos.map(function (g) { return String(g.properties.GEOID || ""); }).filter(Boolean);

    progress("Fetching census blocks\u2026");
    var blocks = await App.fetchBlockPopulations(geos, progress);
    var alloc = window.ServiceEquity.allocateStopTrips(stops, blocks, { parentLength: geoLevel === "tract" ? 11 : 12 });

    progress("Fetching ACS demographics\u2026");
    var tot = await App.fetchACSValues(geoLevel, year, "B03002_001E", geoids);
    var white = await App.fetchACSValues(geoLevel, year, "B03002_003E", geoids);
    var pop = await App.fetchACSValues(geoLevel, year, "B01003_001E", geoids);
    var low = await TitleVI.fetchLowIncomeValues(geoLevel, year, policy && policy.lowIncomeDefinition, geoids, pop);

    var num = function (m, id) { var v = m.get(id); return Number.isFinite(v) && v > 0 ? v : 0; };
    var rows = geoids.map(function (id) {
      var t = num(tot, id), p = num(pop, id);
      // Minority share comes from B03002, low-income share from B01003; both are applied to one
      // population so the two tests weigh each geography the same.
      var minorityShare = t > 0 ? Math.max(0, t - num(white, id)) / t : 0;
      var lowShare = p > 0 ? Math.min(1, num(low, id) / p) : 0;
      var base = p || t;
      return { geoid: id, pop: base, minorityPop: minorityShare * base, lowIncomePop: lowShare * base,
        trips: alloc.tripsByGeo[id] || 0 };
    });
    var result = window.ServiceEquity.evaluate(rows, { fourFifths: se.fourFifths });
    var spec = window.ServiceEquity.lowIncomeSpec(policy && policy.lowIncomeDefinition);

    return {
      result: result,
      geos: geos,
      region: region,
      date: network.date, dayType: network.dayType,
      settings: se, geoLevel: geoLevel, year: year,
      lowIncomeLabel: spec.label, lowIncomeDefinition: spec.id,
      stopCount: stops.length,
      frequentStops: stops.filter(function (s) { return s.frequent; }).length,
      railStops: stops.filter(function (s) { return s.rail; }).length,
      unallocatedStops: alloc.unallocated.length, unallocatedTrips: alloc.unallocatedTrips,
      gtfsTrips: network.counts ? network.counts.gtfsTrips : 0,
      proposalTrips: network.counts ? network.counts.proposalTrips : 0,
      proposalsSkipped: network.proposalsSkipped || [],
      notes: network.notes || []
    };
  };

})();
