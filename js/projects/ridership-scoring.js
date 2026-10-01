// js/projects/ridership-scoring.js
// Ridership Forecasting computation engine.
// Wraps TPI scoring for corridor demand, adds service elasticity,
// scenario building, and calibration logic.
// Depends on: TPI namespace (tpi-scoring.js), App namespace, turf (CDN).
// Exports: window.RidershipModel namespace

(function () {
  "use strict";

  var RM = window.RidershipModel = {};
  var TPI = window.TPI;

  var SQM_PER_SQMI = 2589988.110336;

  // =========================================================================
  // Service type presets (literature-based defaults)
  // Each service type has low/mid/high multiplier ranges
  // =========================================================================

  var SERVICE_TYPES = [
    {
      id: "local_bus",
      label: "Local Bus (Baseline)",
      servicePremium:    { low: 0.00, high: 0.00 },
      defaultSpeed: 12,    // mph
      defaultHeadway: 30,  // minutes
      defaultSpan: 14,     // hours
      defaultStopSpacing: 0.125 // miles (1/8 mi)
    },
    {
      id: "enhanced_bus",
      label: "Enhanced Bus",
      servicePremium:    { low: 0.05, high: 0.15 },
      defaultSpeed: 14,
      defaultHeadway: 20,
      defaultSpan: 16,
      defaultStopSpacing: 0.20
    },
    {
      id: "limited_stop",
      label: "Limited-Stop Express",
      servicePremium:    { low: 0.00, high: 0.10 },
      defaultSpeed: 18,
      defaultHeadway: 15,
      defaultSpan: 16,
      defaultStopSpacing: 0.50
    },
    {
      id: "brt",
      label: "BRT-Style",
      servicePremium:    { low: 0.05, high: 0.25 },
      defaultSpeed: 22,
      defaultHeadway: 10,
      defaultSpan: 18,
      defaultStopSpacing: 0.50
    }
  ];

  RM.SERVICE_TYPES = SERVICE_TYPES;

  function getServiceType(id) {
    for (var i = 0; i < SERVICE_TYPES.length; i++) {
      if (SERVICE_TYPES[i].id === id) return SERVICE_TYPES[i];
    }
    return SERVICE_TYPES[0]; // default to local bus
  }
  RM.getServiceType = getServiceType;

  // =========================================================================
  // Layer 1: Corridor Demand Potential
  // Wraps TPI.computeTPI(), adds segment analysis and CDI aggregate
  // =========================================================================

  // Stable ID of the drawn feature at array position `index` (null if unknown).
  // Per-route results carry it alongside the positional featureIndex so callers
  // can re-find the feature after deletions/merges shift the arrays
  // (docs/feature-merge-plan.md, Phase 4b).
  function featureIdAt(type, index) {
    var ref = App.featureRef ? App.featureRef(type, index) : null;
    return ref ? ref.id : null;
  }

  // Build a union polygon from a subset of drawn features' buffers.
  // featureFilter: { routeIndices: [0,2,...], lineIndices: [1,3,...] }
  // bufferSet (optional): an App.buildAnalysisBufferSet() result — when given,
  //   buffers are read from it (module-owned analysis distance) instead of
  //   the shared App.routeBuffers/App.lineBuffers (Feature Settings radius).
  // Returns a single union Polygon/MultiPolygon, or null if no buffers found.
  function buildUnionFromFeatures(featureFilter, bufferSet) {
    if (!featureFilter) return null;
    var union = null;
    var routeBuffers = bufferSet ? null : (App.routeBuffers || []);
    var lineBuffers = bufferSet ? null : (App.lineBuffers || []);

    if (featureFilter.routeIndices) {
      for (var i = 0; i < featureFilter.routeIndices.length; i++) {
        var idx = featureFilter.routeIndices[i];
        var buf = bufferSet ? bufferSet.get("route", idx) : ((idx < routeBuffers.length) ? routeBuffers[idx] : null);
        if (buf) union = union ? turf.union(union, buf) : buf;
      }
    }
    if (featureFilter.lineIndices) {
      for (var i = 0; i < featureFilter.lineIndices.length; i++) {
        var idx = featureFilter.lineIndices[i];
        var buf = bufferSet ? bufferSet.get("line", idx) : ((idx < lineBuffers.length) ? lineBuffers[idx] : null);
        if (buf) union = union ? turf.union(union, buf) : buf;
      }
    }
    return union;
  }
  RM.buildUnionFromFeatures = buildUnionFromFeatures;

  // computeCorridorDemand(options)
  // options: {
  //   geoLevel, year, weights, lodesData, apportionByArea, onProgress,
  //   segmentMiles  (e.g. 0.5 — length of each corridor segment)
  //   segmentBufferMiles (optional — buffer distance around each segment chunk;
  //     defaults to 0.5 when not given, see computeSegments)
  // }
  // Returns: { tpiResult, corridorCDI, segments: [ { geometry, cdi, geoCount } ], classification }

  async function computeCorridorDemand(options) {
    var onProgress = options.onProgress || function () {};

    // Step 1: Run TPI across entire corridor buffer union
    onProgress("Running demand analysis...");
    var tpiResult = await TPI.computeTPI({
      geoLevel: options.geoLevel || "bg",
      year: options.year || "2024",
      weights: options.weights || {},
      lodesData: options.lodesData || null,
      apportionByArea: !!options.apportionByArea,
      growthFactors: options.growthFactors || null,
      onProgress: onProgress
    });

    // Step 2: Compute corridor-level CDI (population-weighted average of composite scores)
    onProgress("Computing corridor demand index...");
    var corridorCDI = computeCorridorCDI(tpiResult);

    // Step 3: Segment analysis (if routes exist and segmentMiles > 0)
    var segments = [];
    var segmentMiles = options.segmentMiles || 0;

    if (segmentMiles > 0) {
      onProgress("Analyzing corridor segments...");
      segments = computeSegments(tpiResult, segmentMiles, null, options.segmentBufferMiles);
    }

    // Step 4: Classification
    var classification = classifyCDI(corridorCDI);

    return {
      tpiResult: tpiResult,
      corridorCDI: corridorCDI,
      segments: segments,
      classification: classification,
      geoLevel: options.geoLevel || "bg",
      year: options.year || "2024"
    };
  }
  RM.computeCorridorDemand = computeCorridorDemand;

  // Corridor-level CDI: population-weighted average of all geography composite scores
  function computeCorridorCDI(tpiResult) {
    var popRaw = tpiResult.rawValues.get("pop_density");
    var totalPop = 0;
    var weightedSum = 0;
    var scored = 0;

    for (var i = 0; i < tpiResult.geoids.length; i++) {
      var geoid = tpiResult.geoids[i];
      var scoreData = tpiResult.scores.get(geoid);
      if (!scoreData || !Number.isFinite(scoreData.composite)) continue;

      // Use population density * area as population proxy
      var popDens = popRaw ? popRaw.get(geoid) : null;
      var geo = tpiResult.geos[i];
      var areaSqMi = geo ? turf.area(geo) / SQM_PER_SQMI : 1;
      var pop = (popDens && Number.isFinite(popDens)) ? popDens * areaSqMi : 1;

      weightedSum += scoreData.composite * pop;
      totalPop += pop;
      scored++;
    }

    return {
      value: totalPop > 0 ? weightedSum / totalPop : NaN,
      scored: scored,
      total: tpiResult.geoids.length
    };
  }

  RM.computeCorridorCDI = computeCorridorCDI;

  // Per-route/line CDI: extract individual route CDI from system-wide TPI result.
  // Uses the same population-weighted intersection logic as computeSegments(),
  // but operates on full route/line buffers instead of segment chunks.
  // This enables the "snapshot" approach: TPI is run once across ALL features
  // with shared quintile normalization, then per-route CDI is extracted by
  // aggregating only the geographies overlapping each individual buffer.
  // featureFilter (optional): { routeIndices: [0,2,...], lineIndices: [1,3,...] }
  // If null/undefined, all routes and lines are included (backward compatible).
  // bufferSet (optional): an App.buildAnalysisBufferSet() result — when given,
  //   each feature's buffer is read from it instead of App.routeBuffers/App.lineBuffers.
  function computePerRouteCDI(tpiResult, featureFilter, bufferSet) {
    var results = [];
    var popRaw = tpiResult.rawValues.get("pop_density");

    // Collect routes + lines with their buffers
    var features = [];
    var routes = App.routes || [];
    var routeBuffers = bufferSet ? null : (App.routeBuffers || []);
    for (var ri = 0; ri < routes.length; ri++) {
      if (featureFilter && featureFilter.routeIndices && featureFilter.routeIndices.indexOf(ri) === -1) continue;
      var rBuf = bufferSet ? bufferSet.get("route", ri) : ((ri < routeBuffers.length) ? routeBuffers[ri] : null);
      if (rBuf) {
        features.push({
          name: (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1)),
          type: "route",
          index: ri,
          id: featureIdAt("route", ri),
          buffer: rBuf
        });
      }
    }
    var lines = App.lines || [];
    var lineBuffers = bufferSet ? null : (App.lineBuffers || []);
    for (var li = 0; li < lines.length; li++) {
      if (featureFilter && featureFilter.lineIndices && featureFilter.lineIndices.indexOf(li) === -1) continue;
      var lBuf = bufferSet ? bufferSet.get("line", li) : ((li < lineBuffers.length) ? lineBuffers[li] : null);
      if (lBuf) {
        features.push({
          name: (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1)),
          type: "line",
          index: li,
          id: featureIdAt("line", li),
          buffer: lBuf
        });
      }
    }

    // For each feature, compute population-weighted CDI from overlapping TPI geos
    // Also collect per-factor breakdowns and composite range for transparency
    for (var fi = 0; fi < features.length; fi++) {
      var feat = features[fi];
      var weightedSum = 0, totalPop = 0, geoCount = 0;

      // Per-factor accumulators (weighted sum of quintile scores per factor)
      var factorWeightedSums = {};
      var factorPopSums = {};
      var compositeMin = Infinity;
      var compositeMax = -Infinity;

      for (var gi = 0; gi < tpiResult.geos.length; gi++) {
        var geo = tpiResult.geos[gi];
        var geoid = geo.properties && geo.properties.GEOID;
        var scoreData = geoid ? tpiResult.scores.get(geoid) : null;
        if (!scoreData || !Number.isFinite(scoreData.composite)) continue;

        var intersects;
        try { intersects = turf.booleanIntersects(geo, feat.buffer); } catch (_) { continue; }
        if (!intersects) continue;

        var inter;
        try { inter = turf.intersect(geo, feat.buffer); } catch (_) { continue; }
        if (!inter) continue;

        var overlapArea = turf.area(inter);
        var geoArea = turf.area(geo);
        var frac = geoArea > 0 ? Math.min(1, overlapArea / geoArea) : 0;
        if (frac <= 0) continue;

        var popDens = popRaw ? popRaw.get(geoid) : null;
        var areaSqMi = geoArea / SQM_PER_SQMI;
        var pop = (popDens && Number.isFinite(popDens)) ? popDens * areaSqMi * frac : frac;

        weightedSum += scoreData.composite * pop;
        totalPop += pop;
        geoCount++;

        // Track min/max composite scores
        if (scoreData.composite < compositeMin) compositeMin = scoreData.composite;
        if (scoreData.composite > compositeMax) compositeMax = scoreData.composite;

        // Extract per-factor quintile scores for this geo
        if (tpiResult.factorScores) {
          var fsIter = tpiResult.factorScores.entries();
          var fsEntry = fsIter.next();
          while (!fsEntry.done) {
            var factorId = fsEntry.value[0];
            var scoreMap = fsEntry.value[1];
            var fScore = scoreMap.get(geoid);
            if (fScore != null && Number.isFinite(fScore)) {
              if (!factorWeightedSums[factorId]) {
                factorWeightedSums[factorId] = 0;
                factorPopSums[factorId] = 0;
              }
              factorWeightedSums[factorId] += fScore * pop;
              factorPopSums[factorId] += pop;
            }
            fsEntry = fsIter.next();
          }
        }
      }

      // Build factor breakdown: population-weighted average quintile per factor
      var factorBreakdown = {};
      for (var fId in factorWeightedSums) {
        factorBreakdown[fId] = factorPopSums[fId] > 0
          ? factorWeightedSums[fId] / factorPopSums[fId]
          : NaN;
      }

      var cdi = totalPop > 0 ? weightedSum / totalPop : NaN;
      var srcGeom = feat.type === "route"
        ? (App.routes[feat.index] || null)
        : (App.lines[feat.index] || null);
      var lengthMiles = (srcGeom && srcGeom.geometry)
        ? turf.length(srcGeom, { units: "miles" })
        : 0;
      results.push({
        name: feat.name,
        featureType: feat.type,
        featureIndex: feat.index,   // position at run time — goes stale; look features up by featureId
        featureId: feat.id,
        cdi: cdi,
        classification: classifyCDI({ value: cdi }).label,
        geoCount: geoCount,
        lengthMiles: lengthMiles,
        factorBreakdown: factorBreakdown,
        compositeRange: {
          min: compositeMin === Infinity ? NaN : compositeMin,
          max: compositeMax === -Infinity ? NaN : compositeMax
        }
      });
    }

    return results;
  }
  RM.computePerRouteCDI = computePerRouteCDI;

  // System-wide demand: runs TPI across drawn features, then extracts per-route CDI.
  // options.unionPolygon (optional): custom study area polygon (passed to TPI.computeTPI)
  // options.featureFilter (optional): { routeIndices: [...], lineIndices: [...] } to restrict
  //   which routes/lines are included in per-route CDI computation.
  // options.bufferSet (optional): an App.buildAnalysisBufferSet() result — forwarded to
  //   computePerRouteCDI so per-route buffers come from the module's own analysis
  //   distance instead of the shared Feature Settings buffers.
  // Returns: { tpiResult, systemCDI, routeCDIs[], geoLevel, year }
  async function computeSystemDemand(options) {
    var onProgress = options.onProgress || function () {};

    onProgress("Running system-wide demand analysis...");
    var tpiResult = await TPI.computeTPI({
      geoLevel: options.geoLevel || "bg",
      year: options.year || "2024",
      weights: options.weights || {},
      lodesData: options.lodesData || null,
      apportionByArea: !!options.apportionByArea,
      growthFactors: options.growthFactors || null,
      unionPolygon: options.unionPolygon || null,
      onProgress: onProgress
    });

    onProgress("Computing system-wide demand index...");
    var systemCDI = computeCorridorCDI(tpiResult);

    onProgress("Computing per-route demand indices...");
    var routeCDIs = computePerRouteCDI(tpiResult, options.featureFilter || null, options.bufferSet || null);

    return {
      tpiResult: tpiResult,
      systemCDI: systemCDI,
      routeCDIs: routeCDIs,
      geoLevel: options.geoLevel || "bg",
      year: options.year || "2024"
    };
  }
  RM.computeSystemDemand = computeSystemDemand;

  // Match CSV rows to drawn routes/lines by name (case-insensitive exact match).
  // Returns: { matched: [{ csvRow, routeCDI, csvRowIndex }], unmatched: [...], duplicateWarnings: [] }
  function matchRoutesToCSV(routeCDIs, csvRows, nameCol) {
    var matched = [];
    var unmatched = [];
    var duplicateWarnings = [];

    // Build lookup: lowercase name -> routeCDI entry (first match wins)
    var lookup = {};
    for (var i = 0; i < routeCDIs.length; i++) {
      var key = (routeCDIs[i].name || "").trim().toLowerCase();
      if (lookup[key]) {
        duplicateWarnings.push('Duplicate feature name: "' + routeCDIs[i].name + '" — first match used.');
      } else {
        lookup[key] = routeCDIs[i];
      }
    }

    for (var r = 0; r < csvRows.length; r++) {
      var row = csvRows[r];
      var csvName = (row[nameCol] || "").trim().toLowerCase();
      if (!csvName) {
        unmatched.push({ csvRow: row, csvRowIndex: r, reason: "Empty name" });
        continue;
      }
      var match = lookup[csvName];
      if (match) {
        matched.push({ csvRow: row, routeCDI: match, csvRowIndex: r });
      } else {
        unmatched.push({ csvRow: row, csvRowIndex: r, reason: "No matching feature" });
      }
    }

    return { matched: matched, unmatched: unmatched, duplicateWarnings: duplicateWarnings };
  }
  RM.matchRoutesToCSV = matchRoutesToCSV;

  // Segment analysis: split routes/lines into equal chunks, compute CDI per segment.
  // selectedCorridor: "all" or falsy = process all routes + lines;
  //                   "route:N" or "line:N" = only that feature (faster single-corridor view).
  // segBufferMiles (optional): buffer distance around each segment chunk; defaults to 0.5
  //   (the historical hardcoded value) when not given or <= 0.
  function computeSegments(tpiResult, segmentMiles, selectedCorridor, segBufferMiles) {
    var effSegBufferMiles = (segBufferMiles > 0) ? segBufferMiles : 0.5;
    var routes = App.routes || [];
    var lines  = App.lines  || [];

    // Build the list of features to segment based on corridor selection
    var toProcess = [];
    if (selectedCorridor && selectedCorridor !== "all") {
      var parts   = selectedCorridor.split(":");
      var selType = parts[0];
      var selIdx  = parseInt(parts[1], 10);
      if (selType === "route" && routes[selIdx] && routes[selIdx].geometry) {
        toProcess.push({ feature: routes[selIdx], type: "route", index: selIdx });
      } else if (selType === "line" && lines[selIdx] && lines[selIdx].geometry) {
        toProcess.push({ feature: lines[selIdx], type: "line", index: selIdx });
      }
    } else {
      // System-wide: all routes and lines
      for (var ri = 0; ri < routes.length; ri++) {
        if (routes[ri] && routes[ri].geometry) {
          toProcess.push({ feature: routes[ri], type: "route", index: ri });
        }
      }
      for (var li = 0; li < lines.length; li++) {
        if (lines[li] && lines[li].geometry) {
          toProcess.push({ feature: lines[li], type: "line", index: li });
        }
      }
    }

    if (toProcess.length === 0) return [];

    var segments = [];
    var popRaw = tpiResult.rawValues.get("pop_density");

    for (var fi = 0; fi < toProcess.length; fi++) {
      var item = toProcess[fi];

      var chunks;
      try {
        chunks = turf.lineChunk(item.feature, segmentMiles, { units: "miles" });
      } catch (_) { continue; }

      if (!chunks || !chunks.features) continue;

      for (var ci = 0; ci < chunks.features.length; ci++) {
        var chunk = chunks.features[ci];
        var segBuffer;
        try {
          segBuffer = turf.buffer(chunk, effSegBufferMiles, { units: "miles" });
        } catch (_) { continue; }

        if (!segBuffer) continue;

        // Intersect segment buffer with TPI geographies
        var segScoreSum = 0;
        var segPopSum   = 0;
        var segGeoCount = 0;

        for (var gi = 0; gi < tpiResult.geos.length; gi++) {
          var geo = tpiResult.geos[gi];
          var geoid = geo.properties && geo.properties.GEOID;
          var scoreData = geoid ? tpiResult.scores.get(geoid) : null;
          if (!scoreData || !Number.isFinite(scoreData.composite)) continue;

          // Quick check: does this geography intersect the segment buffer?
          var intersects;
          try { intersects = turf.booleanIntersects(geo, segBuffer); } catch (_) { continue; }
          if (!intersects) continue;

          // Compute overlap fraction
          var inter;
          try { inter = turf.intersect(geo, segBuffer); } catch (_) { continue; }
          if (!inter) continue;

          var overlapArea = turf.area(inter);
          var geoArea     = turf.area(geo);
          var frac = geoArea > 0 ? Math.min(1, overlapArea / geoArea) : 0;
          if (frac <= 0) continue;

          var popDens = popRaw ? popRaw.get(geoid) : null;
          var areaSqMi = geoArea / SQM_PER_SQMI;
          var pop = (popDens && Number.isFinite(popDens)) ? popDens * areaSqMi * frac : frac;

          segScoreSum += scoreData.composite * pop;
          segPopSum   += pop;
          segGeoCount++;
        }

        var segCDI = segPopSum > 0 ? segScoreSum / segPopSum : NaN;

        segments.push({
          featureType:    item.type,
          routeIndex:     item.index,
          featureId:      featureIdAt(item.type, item.index),
          segmentIndex:   ci,
          geometry:       chunk.geometry,
          bufferGeometry: segBuffer.geometry,
          cdi:            segCDI,
          classification: classifyCDI({ value: segCDI }).label,
          geoCount:       segGeoCount,
          lengthMiles:    segmentMiles
        });
      }
    }

    return segments;
  }

  // CDI classification
  function classifyCDI(cdi) {
    var val = (cdi && cdi.value != null) ? cdi.value : cdi;
    if (!Number.isFinite(val)) return { label: "N/A", level: 0 };
    if (val >= 4.0) return { label: "High", level: 3 };
    if (val >= 3.0) return { label: "Medium", level: 2 };
    if (val >= 2.0) return { label: "Low-Medium", level: 1 };
    return { label: "Low", level: 0 };
  }
  RM.classifyCDI = classifyCDI;

  // Re-score demand from cached TPI raw values (no API calls)
  function rescoreDemand(lastResult, weights, segmentMiles) {
    if (!lastResult || !lastResult.tpiResult) return null;
    var tpi = lastResult.tpiResult;
    var rawToUse = (tpi.apportionByArea && tpi.apportionedRawValues)
      ? tpi.apportionedRawValues : tpi.rawValues;

    var rescored = TPI.rescoreFromRaw(rawToUse, weights, tpi.geoids);
    tpi.scores = rescored.scores;
    tpi.factorScores = rescored.factorScores;
    tpi.effectiveWeights = rescored.effectiveWeights;

    var corridorCDI = computeCorridorCDI(tpi);
    var segments = segmentMiles > 0 ? computeSegments(tpi, segmentMiles) : [];

    return {
      tpiResult: tpi,
      corridorCDI: corridorCDI,
      segments: segments,
      classification: classifyCDI(corridorCDI),
      geoLevel: lastResult.geoLevel,
      year: lastResult.year
    };
  }
  RM.rescoreDemand = rescoreDemand;

  // =========================================================================
  // Layer 3: Service Elasticity
  // Applies literature-based multipliers to convert demand into ridership estimates
  // =========================================================================

  // Frequency elasticity: ridership_change = (new_freq / old_freq) ^ elasticity
  // Default 0.6. Consistent with ranges reported in TCRP Report 95 (~0.3-0.6) and
  // supported by newer empirical evidence (Berrebi et al. 2021: 0.66-0.78 across four
  // US agencies). The "already-frequent routes respond less" finding in that work
  // corroborates the diminishing-returns shape of this power curve.
  function computeFrequencyEffect(baseHeadway, newHeadway, elasticity) {
    if (!baseHeadway || !newHeadway || baseHeadway <= 0 || newHeadway <= 0) return 1;
    // Convert headway to frequency: freq = 60 / headway
    var baseFreq = 60 / baseHeadway;
    var newFreq = 60 / newHeadway;
    return Math.pow(newFreq / baseFreq, elasticity || 0.6);
  }
  RM.computeFrequencyEffect = computeFrequencyEffect;

  // Span elasticity: ridership_2 = ridership_1 × (span_2 / span_1) ^ elasticity
  // Constant-elasticity power curve produces diminishing marginal returns automatically.
  // Adding 4 hours is a bigger % change at 10 hrs than at 18 hrs.
  // elasticity is typically 0.5-0.9, default 0.7
  // References: Currie & Loader (2009), TRB TCQSM hours-of-service LOS guidance,
  //   Hampton Roads Transit (0.83), TCRP synthesis literature.
  // baseSpan: reference span in hours (typically 14 — the local bus default)
  // newSpan: proposed span in hours for this scenario
  function computeSpanEffect(baseSpan, newSpan, elasticity) {
    if (!baseSpan || !newSpan || baseSpan <= 0 || newSpan <= 0) return 1;
    return Math.pow(newSpan / baseSpan, elasticity != null ? elasticity : 0.7);
  }
  RM.computeSpanEffect = computeSpanEffect;

  // Apply elasticity multipliers to produce low/mid/high ridership estimates.
  // When baseDemandCDI is 1.0, returns pure multipliers for use with applyBaselineUncertainty.
  // params: {
  //   serviceTypeId,
  //   baseHeadway, newHeadway, freqElasticity,
  //   customServicePremium  (optional override: { low, high } fractions, mid derived as avg)
  // }
  function applyElasticity(baseDemandCDI, params) {
    var st = getServiceType(params.serviceTypeId || "local_bus");

    // Frequency effect from headway change
    var freqEffect = computeFrequencyEffect(
      params.baseHeadway || 30,
      params.newHeadway || st.defaultHeadway,
      params.freqElasticity || 0.6
    );

    // Combined service premium (custom override or preset); mid = avg of low and high
    var prem = params.customServicePremium != null ? params.customServicePremium : st.servicePremium;

    function calcMultiplier(level) {
      var p;
      if (typeof prem === "object") {
        p = level === "mid"
          ? (prem.low + prem.high) / 2
          : (prem[level] != null ? prem[level] : (prem.low + prem.high) / 2);
      } else {
        p = prem;
      }
      return freqEffect * (1 + p);
    }

    return {
      low:  baseDemandCDI * calcMultiplier("low"),
      mid:  baseDemandCDI * calcMultiplier("mid"),
      high: baseDemandCDI * calcMultiplier("high"),
      freqEffect: freqEffect,
      serviceType: st
    };
  }
  RM.applyElasticity = applyElasticity;

  // Apply model uncertainty band around a calibrated baseline ridership estimate.
  // baseMid: number (the calibrated baseline projection)
  // pct: number 0–1 (e.g., 0.25 for ±25%)
  // Returns: { low, mid, high }
  function applyBaselineUncertainty(baseMid, pct) {
    if (!Number.isFinite(baseMid) || baseMid <= 0) return { low: 0, mid: 0, high: 0 };
    pct = (pct != null && Number.isFinite(pct)) ? Math.max(0, Math.min(1, pct)) : 0.25;
    return {
      low:  Math.max(0, baseMid * (1 - pct)),
      mid:  baseMid,
      high: baseMid * (1 + pct)
    };
  }
  RM.applyBaselineUncertainty = applyBaselineUncertainty;

  // =========================================================================
  // Layer 4: Scenario Builder
  // Computes operating metrics for a service scenario
  // =========================================================================

  // buildScenario(params)
  // params: {
  //   name, serviceTypeId,
  //   routeLengthMiles,        // corridor length
  //   headway,                 // minutes (peak)
  //   span,                    // hours of service per day
  //   avgSpeed,                // mph
  //   costPerRevenueHour,      // $/hr
  //   serviceDaysPerYear,      // default 260 (weekday) or 302 (w/ Sat) or 312 (daily)
  //   baseDemandCDI,           // from Layer 1
  //   elasticityResult,        // from Layer 3 (low/mid/high)
  //   calibrationFactor        // from Layer 2 (optional, default 1)
  // }

  function buildScenario(params) {
    var routeLength = params.routeLengthMiles || 0;
    var headway = params.headway || 30;
    var span = params.span || 14;
    var avgSpeed = params.avgSpeed || 15;
    var costPerRevHr = params.costPerRevenueHour || 150;
    var serviceDays = params.serviceDaysPerYear || 260;
    var calibFactor = params.calibrationFactor || 1;

    // One-way trip time (hours)
    var tripTimeHrs = routeLength / avgSpeed;

    // Round trips per day = span / (2 * tripTime) -- simplified
    var roundTripTime = tripTimeHrs * 2;
    var tripsPerHour = 60 / headway;

    // Revenue hours per day = trips per day * trip time per trip
    // vehicles needed = ceil(roundTripTime / (headway/60))
    var vehiclesNeeded = Math.max(1, Math.ceil(roundTripTime / (headway / 60)));
    var revenueHoursPerDay = vehiclesNeeded * span;

    // Annual revenue hours
    var annualRevenueHours = revenueHoursPerDay * serviceDays;

    // Annual operating cost
    var annualCost = annualRevenueHours * costPerRevHr;

    // Ridership from elasticity result or demand CDI
    var elast = params.elasticityResult;
    var dailyRidership, annualRidership;

    if (elast) {
      dailyRidership = {
        low:  elast.low * calibFactor,
        mid:  elast.mid * calibFactor,
        high: elast.high * calibFactor
      };
    } else {
      var base = (params.baseDemandCDI || 0) * calibFactor;
      dailyRidership = { low: base * 0.8, mid: base, high: base * 1.2 };
    }

    annualRidership = {
      low:  dailyRidership.low * serviceDays,
      mid:  dailyRidership.mid * serviceDays,
      high: dailyRidership.high * serviceDays
    };

    // Boardings per revenue hour
    var boardingsPerRevHr = {
      low:  annualRidership.low / annualRevenueHours,
      mid:  annualRidership.mid / annualRevenueHours,
      high: annualRidership.high / annualRevenueHours
    };

    // Cost per boarding
    var costPerBoarding = {
      low:  annualRidership.high > 0 ? annualCost / annualRidership.high : Infinity,
      mid:  annualRidership.mid > 0 ? annualCost / annualRidership.mid : Infinity,
      high: annualRidership.low > 0 ? annualCost / annualRidership.low : Infinity
    };

    return {
      name: params.name || "Unnamed",
      serviceTypeId: params.serviceTypeId || "local_bus",
      routeLengthMiles: routeLength,
      headway: headway,
      span: span,
      avgSpeed: avgSpeed,
      costPerRevenueHour: costPerRevHr,
      serviceDaysPerYear: serviceDays,
      vehiclesNeeded: vehiclesNeeded,
      revenueHoursPerDay: revenueHoursPerDay,
      annualRevenueHours: annualRevenueHours,
      annualOperatingCost: annualCost,
      dailyRidership: dailyRidership,
      annualRidership: annualRidership,
      boardingsPerRevHr: boardingsPerRevHr,
      costPerBoarding: costPerBoarding
    };
  }
  RM.buildScenario = buildScenario;

  // Compare multiple scenarios
  function compareScenarios(scenarios) {
    return {
      scenarios: scenarios,
      count: scenarios.length,
      headers: [
        "Scenario", "Service Type", "Headway (min)", "Span (hrs)", "Avg Speed (mph)",
        "Vehicles", "Rev-Hrs/Day", "Annual Rev-Hrs", "Annual Cost",
        "Daily Ridership (Low)", "Daily Ridership (Mid)", "Daily Ridership (High)",
        "Annual Ridership (Mid)", "Boardings/Rev-Hr (Mid)", "Cost/Boarding (Mid)"
      ]
    };
  }
  RM.compareScenarios = compareScenarios;

  // Format scenario as row for comparison table
  function scenarioToRow(s) {
    var st = getServiceType(s.serviceTypeId);
    return [
      s.name,
      st.label,
      s.headway,
      s.span,
      s.avgSpeed,
      s.vehiclesNeeded,
      s.revenueHoursPerDay.toFixed(1),
      Math.round(s.annualRevenueHours),
      Math.round(s.annualOperatingCost),
      Math.round(s.dailyRidership.low),
      Math.round(s.dailyRidership.mid),
      Math.round(s.dailyRidership.high),
      Math.round(s.annualRidership.mid),
      s.boardingsPerRevHr.mid.toFixed(1),
      s.costPerBoarding.mid.toFixed(2)
    ];
  }
  RM.scenarioToRow = scenarioToRow;

  // =========================================================================
  // Layer 2: Calibration
  // Ratio-based and simple regression calibration
  // =========================================================================

  // Ratio-based calibration: calibFactor = observedRidership / demandIndex
  function calibrateRatio(observedData) {
    // observedData: array of { ridership, demandIndex }
    if (!observedData || observedData.length === 0) return { factor: 1, n: 0, rSquared: null };

    var sumRatio = 0;
    var n = 0;
    for (var i = 0; i < observedData.length; i++) {
      var d = observedData[i];
      if (d.demandIndex > 0 && Number.isFinite(d.ridership)) {
        sumRatio += d.ridership / d.demandIndex;
        n++;
      }
    }

    var factor = n > 0 ? sumRatio / n : 1;

    // Compute R-squared for the ratio model
    var rSquared = null;
    if (n >= 2) {
      var predicted = [];
      var actual = [];
      for (var j = 0; j < observedData.length; j++) {
        if (observedData[j].demandIndex > 0 && Number.isFinite(observedData[j].ridership)) {
          predicted.push(factor * observedData[j].demandIndex);
          actual.push(observedData[j].ridership);
        }
      }
      rSquared = computeRSquared(actual, predicted);
    }

    return { factor: factor, n: n, rSquared: rSquared };
  }
  RM.calibrateRatio = calibrateRatio;

  // Simple OLS regression: y = a + b*x
  function calibrateRegression(observedData) {
    if (!observedData || observedData.length < 3) {
      return { intercept: 0, slope: 1, rSquared: null, n: observedData ? observedData.length : 0, warning: "Need at least 3 data points" };
    }

    var xs = [];
    var ys = [];
    for (var i = 0; i < observedData.length; i++) {
      var d = observedData[i];
      if (Number.isFinite(d.demandIndex) && Number.isFinite(d.ridership)) {
        xs.push(d.demandIndex);
        ys.push(d.ridership);
      }
    }

    var n = xs.length;
    if (n < 3) return { intercept: 0, slope: 1, rSquared: null, n: n, warning: "Need at least 3 valid data points" };

    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (var j = 0; j < n; j++) {
      sumX += xs[j];
      sumY += ys[j];
      sumXY += xs[j] * ys[j];
      sumX2 += xs[j] * xs[j];
    }

    var denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { intercept: sumY / n, slope: 0, rSquared: 0, n: n };

    var slope = (n * sumXY - sumX * sumY) / denom;
    var intercept = (sumY - slope * sumX) / n;

    var predicted = xs.map(function (x) { return intercept + slope * x; });
    var rSquared = computeRSquared(ys, predicted);

    return {
      intercept: intercept,
      slope: slope,
      rSquared: rSquared,
      n: n,
      warning: n < 10 ? "Small sample size (" + n + " points) — interpret with caution" : null
    };
  }
  RM.calibrateRegression = calibrateRegression;

  function computeRSquared(actual, predicted) {
    var n = actual.length;
    if (n < 2) return null;
    var meanY = 0;
    for (var i = 0; i < n; i++) meanY += actual[i];
    meanY /= n;

    var ssTot = 0, ssRes = 0;
    for (var j = 0; j < n; j++) {
      ssTot += (actual[j] - meanY) * (actual[j] - meanY);
      ssRes += (actual[j] - predicted[j]) * (actual[j] - predicted[j]);
    }

    return ssTot > 0 ? 1 - (ssRes / ssTot) : 0;
  }

  // Import/export calibration coefficients
  // Export calibration coefficients + optional metadata (weights, perRouteCDI, settings).
  // options: { weights, featureFilter, perRouteCDI, geoLevel, year }
  function exportCoefficients(calibResult, options) {
    var data = {
      type: "ridership-calibration",
      version: 2,
      calibration: calibResult,
      exportedAt: new Date().toISOString()
    };
    if (options) {
      if (options.weights) data.weights = options.weights;
      if (options.featureFilter) data.featureFilter = options.featureFilter;
      if (options.perRouteCDI) data.perRouteCDI = options.perRouteCDI;
      if (options.geoLevel) data.geoLevel = options.geoLevel;
      if (options.year) data.year = options.year;
    }
    return JSON.stringify(data, null, 2);
  }
  RM.exportCoefficients = exportCoefficients;

  // Import calibration coefficients. Handles both v1 (coefficients only) and v2 (with metadata).
  // Returns: { calibration, weights?, perRouteCDI?, geoLevel?, year?, error? }
  function importCoefficients(jsonStr) {
    try {
      var data = JSON.parse(jsonStr);
      if (data.type !== "ridership-calibration" || !data.calibration) {
        return { error: "Invalid calibration file format" };
      }
      var result = { calibration: data.calibration };
      // v2 metadata
      if (data.weights) result.weights = data.weights;
      if (data.perRouteCDI) result.perRouteCDI = data.perRouteCDI;
      if (data.featureFilter) result.featureFilter = data.featureFilter;
      if (data.geoLevel) result.geoLevel = data.geoLevel;
      if (data.year) result.year = data.year;
      return result;
    } catch (e) {
      return { error: "Could not parse calibration file: " + e.message };
    }
  }
  RM.importCoefficients = importCoefficients;

  // =========================================================================
  // Route length utility
  // =========================================================================

  function getRouteLength() {
    var routes = App.routes || [];
    var totalLength = 0;
    for (var i = 0; i < routes.length; i++) {
      if (routes[i] && routes[i].geometry) {
        totalLength += turf.length(routes[i], { units: "miles" });
      }
    }
    return totalLength;
  }
  RM.getRouteLength = getRouteLength;

  RM.computeSegments = computeSegments;

})();
