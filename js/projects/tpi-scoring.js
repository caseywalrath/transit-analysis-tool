// js/projects/tpi-scoring.js
// Transit Propensity Index (TPI) scoring engine.
// Per-geography factor scores via corridor-only quintile normalization, combined
// into a weighted composite. Depends on App (census.js ACS cache) and turf (CDN).
// Exports: window.TPI. Detail: docs/reference/modules/transit-propensity.md

(function () {
  "use strict";

  var TPI = window.TPI = {};

  // =========================================================================
  // Factor definitions
  // =========================================================================
  // Each factor has:
  //   id            – unique key
  //   label         – human-readable name
  //   category      – grouping for UI
  //   acsVars       – array of ACS variable codes needed (null for LODES)
  //   source        – "ACS" | "LODES"
  //   compute       – function(geoValues, geoFeature, unionFeat) => raw numeric value
  //                    geoValues is a Map(varCode -> number) for this geography
  //   higherIsBetter – if true, higher raw values get higher quintile scores
  //   defaultWeight – default weight (0-100); weights sum to 100
  //   description   – tooltip/help text

  var SQM_PER_SQMI = 2589988.110336;

  var FACTORS = [
    {
      id: "pop_density",
      label: "Population Density",
      category: "Demographics",
      acsVars: ["B01003_001E"],
      source: "ACS",
      compute: function (vals, geoFeat) {
        var pop = vals.get("B01003_001E");
        if (!Number.isFinite(pop)) return NaN;
        var areaSqMi = turf.area(geoFeat) / SQM_PER_SQMI;
        return areaSqMi > 0 ? pop / areaSqMi : NaN;
      },
      higherIsBetter: true,
      defaultWeight: 35,
      description: "Total population per square mile (ACS B01003_001E / geography area)"
    },
    {
      id: "employment",
      label: "Employment Density",
      category: "Employment",
      acsVars: null,
      source: "LODES",
      compute: null, // computed separately via LODES block aggregation
      higherIsBetter: true,
      defaultWeight: 35,
      description: "LODES WAC C000 jobs aggregated to geography, divided by area"
    },
    {
      id: "zero_car",
      label: "Zero-Vehicle Households",
      category: "Transit Dependence",
      acsVars: ["B08201_002E", "B11001_001E"],
      tractOnly: true,
      source: "ACS",
      compute: function (vals) {
        var zeroCar = vals.get("B08201_002E");
        var totalHH = vals.get("B11001_001E");
        if (!Number.isFinite(zeroCar) || !Number.isFinite(totalHH) || totalHH <= 0) return NaN;
        return (zeroCar / totalHH) * 100;
      },
      higherIsBetter: true,
      defaultWeight: 5,
      description: "Percent of households with zero vehicles (ACS B08201_002E / B11001_001E)"
    },
    {
      id: "poverty",
      label: "Low-Income % (Poverty)",
      category: "Transit Dependence",
      acsVars: ["B17001_002E", "B01003_001E"],
      tractOnly: true,
      source: "ACS",
      compute: function (vals) {
        var povPop = vals.get("B17001_002E");
        var totalPop = vals.get("B01003_001E");
        if (!Number.isFinite(povPop) || !Number.isFinite(totalPop) || totalPop <= 0) return NaN;
        return (povPop / totalPop) * 100;
      },
      higherIsBetter: true,
      defaultWeight: 5,
      description: "Percent of persons below poverty level (ACS B17001_002E / B01003_001E)"
    },
    {
      id: "senior",
      label: "Senior 65+ %",
      category: "Equity",
      acsVars: [
        "B01001_020E","B01001_021E","B01001_022E","B01001_023E","B01001_024E","B01001_025E",
        "B01001_044E","B01001_045E","B01001_046E","B01001_047E","B01001_048E","B01001_049E",
        "B01003_001E"
      ],
      source: "ACS",
      compute: function (vals) {
        var totalPop = vals.get("B01003_001E");
        if (!Number.isFinite(totalPop) || totalPop <= 0) return NaN;
        var seniorCodes = [
          "B01001_020E","B01001_021E","B01001_022E","B01001_023E","B01001_024E","B01001_025E",
          "B01001_044E","B01001_045E","B01001_046E","B01001_047E","B01001_048E","B01001_049E"
        ];
        var seniorSum = 0;
        for (var si = 0; si < seniorCodes.length; si++) {
          var sv = vals.get(seniorCodes[si]);
          if (Number.isFinite(sv)) seniorSum += sv;
        }
        return (seniorSum / totalPop) * 100;
      },
      higherIsBetter: true,
      defaultWeight: 5,
      description: "Percent of population age 65 and over (ACS B01001 males + females 65+ / B01003_001E)"
    },
    {
      id: "disability",
      label: "Disability %",
      category: "Equity",
      acsVars: [
        "B18101_004E","B18101_007E","B18101_010E","B18101_013E","B18101_016E","B18101_019E",
        "B18101_023E","B18101_026E","B18101_029E","B18101_032E","B18101_035E","B18101_038E",
        "B18101_001E"
      ],
      tractOnly: true,
      source: "ACS",
      compute: function (vals) {
        var denom = vals.get("B18101_001E");
        if (!Number.isFinite(denom) || denom <= 0) return NaN;
        var disabCodes = [
          "B18101_004E","B18101_007E","B18101_010E","B18101_013E","B18101_016E","B18101_019E",
          "B18101_023E","B18101_026E","B18101_029E","B18101_032E","B18101_035E","B18101_038E"
        ];
        var disabSum = 0;
        for (var di = 0; di < disabCodes.length; di++) {
          var dv = vals.get(disabCodes[di]);
          if (Number.isFinite(dv)) disabSum += dv;
        }
        return (disabSum / denom) * 100;
      },
      higherIsBetter: true,
      defaultWeight: 5,
      description: "Percent of civilian noninstitutionalized population with a disability (ACS B18101)"
    },
    {
      id: "poc",
      label: "Minority %",
      category: "Equity",
      acsVars: ["B03002_001E", "B03002_003E"],
      source: "ACS",
      compute: function (vals) {
        var total   = vals.get("B03002_001E");
        var nhWhite = vals.get("B03002_003E");
        if (!Number.isFinite(total) || !Number.isFinite(nhWhite) || total <= 0) return NaN;
        return ((total - nhWhite) / total) * 100;
      },
      higherIsBetter: true,
      defaultWeight: 5,
      description: "Percent of population who are people of color (ACS B03002: total minus NH White alone)"
    },
    {
      id: "youth",
      label: "Young Adults 18\u201324 %",
      category: "Equity",
      acsVars: [
        "B01001_007E","B01001_008E","B01001_009E","B01001_010E",
        "B01001_031E","B01001_032E","B01001_033E","B01001_034E",
        "B01003_001E"
      ],
      source: "ACS",
      compute: function (vals) {
        var totalPop = vals.get("B01003_001E");
        if (!Number.isFinite(totalPop) || totalPop <= 0) return NaN;
        var codes = [
          "B01001_007E","B01001_008E","B01001_009E","B01001_010E",
          "B01001_031E","B01001_032E","B01001_033E","B01001_034E"
        ];
        var sum = 0;
        for (var i = 0; i < codes.length; i++) {
          var v = vals.get(codes[i]);
          if (Number.isFinite(v)) sum += v;
        }
        return (sum / totalPop) * 100;
      },
      higherIsBetter: true,
      defaultWeight: 0,
      description: "Percent of population aged 18\u201324 (ACS B01001 males + females 18\u201324 / B01003_001E)"
    },
    {
      id: "lep",
      label: "LEP %",
      category: "Equity",
      acsVars: [
        "C16001_005E","C16001_008E","C16001_011E","C16001_014E","C16001_017E","C16001_020E",
        "C16001_023E","C16001_026E","C16001_029E","C16001_032E","C16001_035E","C16001_038E",
        "C16001_001E"
      ],
      tractOnly: true,
      source: "ACS",
      compute: function (vals) {
        var denom = vals.get("C16001_001E");
        if (!Number.isFinite(denom) || denom <= 0) return NaN;
        var lepCodes = [
          "C16001_005E","C16001_008E","C16001_011E","C16001_014E","C16001_017E","C16001_020E",
          "C16001_023E","C16001_026E","C16001_029E","C16001_032E","C16001_035E","C16001_038E"
        ];
        var lepSum = 0;
        for (var li = 0; li < lepCodes.length; li++) {
          var lv = vals.get(lepCodes[li]);
          if (Number.isFinite(lv)) lepSum += lv;
        }
        return (lepSum / denom) * 100;
      },
      higherIsBetter: true,
      defaultWeight: 5,
      description: "Percent of population age 5+ who speak English less than very well (ACS C16001)"
    }
  ];

  TPI.FACTORS = FACTORS;

  // =========================================================================
  // Collect unique ACS variable codes needed across all active factors
  // =========================================================================

  function getRequiredAcsVars(weights) {
    var codes = new Set();
    for (var i = 0; i < FACTORS.length; i++) {
      var f = FACTORS[i];
      if (weights && weights[f.id] === 0) continue; // skip disabled factors
      if (f.acsVars) {
        for (var j = 0; j < f.acsVars.length; j++) codes.add(f.acsVars[j]);
      }
    }
    return Array.from(codes);
  }
  TPI.getRequiredAcsVars = getRequiredAcsVars;

  // =========================================================================
  // Batch ACS fetch. Returns Map(geoid -> Map(varCode -> value)).
  // =========================================================================

  // Delegates to the shared session cache in census.js (App.fetchACSBatchCached)
  // so TPI, Ridership, Corridor Scoring and Title VI agree on the numbers.
  async function batchFetchACS(geoLevel, year, geoids, varCodes) {
    if (varCodes.length === 0 || geoids.length === 0) return new Map();
    if (typeof App.fetchACSBatchCached !== "function") {
      throw new Error("census.js App.fetchACSBatchCached unavailable (script load order?)");
    }
    return App.fetchACSBatchCached(geoLevel, year, varCodes, geoids);
  }
  TPI.batchFetchACS = batchFetchACS;

  // =========================================================================
  // Aggregate LODES data to tract/BG level
  // Returns Map(geoid -> jobCount)
  // =========================================================================

  function aggregateLodesToGeo(lodesData, geoids, geoLevel) {
    if (!lodesData) return new Map();
    // LODES w_geocode is a 15-digit block GEOID
    // Tract GEOID = first 11 digits, BG GEOID = first 12 digits
    var prefixLen = (geoLevel === "tract") ? 11 : 12;
    var geoidSet = new Set(geoids);
    var result = new Map();

    for (var entry of lodesData.entries()) {
      var blockGeoid = entry[0];
      var jobs = entry[1];
      var prefix = String(blockGeoid).slice(0, prefixLen);
      if (!geoidSet.has(prefix)) continue;
      result.set(prefix, (result.get(prefix) || 0) + jobs);
    }
    return result;
  }
  TPI.aggregateLodesToGeo = aggregateLodesToGeo;

  // =========================================================================
  // Quintile normalization (corridor-only)
  // Assigns each geography a score 1-5 based on its rank within the corridor.
  // For small N (<5), uses equal-interval breaks.
  // =========================================================================

  function computeQuintiles(values) {
    // values: array of { geoid, rawValue }
    // Returns Map(geoid -> quintile 1-5)
    var result = new Map();

    // Filter to finite values
    var valid = values.filter(function (v) { return Number.isFinite(v.rawValue); });
    if (valid.length === 0) return result;

    if (valid.length < 5) {
      // Too few for meaningful quintiles — use equal-interval
      var sorted = valid.slice().sort(function (a, b) { return a.rawValue - b.rawValue; });
      var minVal = sorted[0].rawValue;
      var maxVal = sorted[sorted.length - 1].rawValue;
      var range = maxVal - minVal;

      for (var ei = 0; ei < sorted.length; ei++) {
        var score;
        if (range === 0) {
          score = 3; // all equal -> middle
        } else {
          score = Math.min(5, Math.max(1, Math.ceil(((sorted[ei].rawValue - minVal) / range) * 5)));
        }
        result.set(sorted[ei].geoid, score);
      }
      return result;
    }

    // Standard quintile: sort and divide into 5 equal groups
    var sorted2 = valid.slice().sort(function (a, b) { return a.rawValue - b.rawValue; });
    var n = sorted2.length;

    for (var qi = 0; qi < n; qi++) {
      // Position 0..n-1 maps to quintile 1..5
      // Multiply before dividing to avoid IEEE 754 rounding error at exact
      // fractions (e.g. qi=3, n=5: (3/5)*5 = 2.999...→ floor 2; 3*5/5 = 3.0→ correct)
      var quintile = Math.min(5, Math.floor(qi * 5 / n) + 1);
      result.set(sorted2[qi].geoid, quintile);
    }
    return result;
  }
  TPI.computeQuintiles = computeQuintiles;

  // =========================================================================
  // Normalize a factor: flip direction if higherIsBetter is false
  // =========================================================================

  function normalizeQuintiles(quintileMap, higherIsBetter) {
    if (higherIsBetter) return quintileMap;
    // Invert: 1->5, 2->4, 3->3, 4->2, 5->1
    var inverted = new Map();
    for (var entry of quintileMap.entries()) {
      inverted.set(entry[0], 6 - entry[1]);
    }
    return inverted;
  }

  // =========================================================================
  // Compute composite TPI score for each geography
  // =========================================================================
  // factorScores: Map(factorId -> Map(geoid -> quintile 1-5))
  // weights: { factorId -> weight (0-100) }
  // Returns Map(geoid -> { composite, factors: { factorId: score } })

  function computeComposite(factorScores, weights, allGeoids) {
    var result = new Map();

    // Normalize weights to sum to 1 (excluding factors with weight 0)
    var activeFactors = [];
    var totalWeight = 0;
    for (var i = 0; i < FACTORS.length; i++) {
      var fid = FACTORS[i].id;
      var w = (weights && weights[fid] != null) ? weights[fid] : FACTORS[i].defaultWeight;
      if (w > 0 && factorScores.has(fid)) {
        activeFactors.push({ id: fid, weight: w });
        totalWeight += w;
      }
    }

    for (var gi = 0; gi < allGeoids.length; gi++) {
      var geoid = allGeoids[gi];
      var factorDetail = {};
      var weightedSum = 0;
      var availableWeight = 0;

      for (var ai = 0; ai < activeFactors.length; ai++) {
        var af = activeFactors[ai];
        var scoreMap = factorScores.get(af.id);
        var score = scoreMap ? scoreMap.get(geoid) : undefined;
        factorDetail[af.id] = score || null;

        if (score != null) {
          weightedSum += score * (af.weight / totalWeight);
          availableWeight += af.weight / totalWeight;
        }
      }

      // Redistribute weight from missing factors
      var composite = availableWeight > 0 ? (weightedSum / availableWeight) : NaN;

      result.set(geoid, {
        composite: composite,
        factors: factorDetail
      });
    }
    return result;
  }
  TPI.computeComposite = computeComposite;

  // =========================================================================
  // Re-score from cached rawValues (no API calls)
  // =========================================================================
  // rawValues: Map(factorId -> Map(geoid -> rawValue))  — from a prior computeTPI result
  // weights:   { factorId -> weight }
  // geoids:    string[]
  // Returns:   { scores, factorScores, effectiveWeights }  (same shape as computeTPI return)

  function rescoreFromRaw(rawValues, weights, geoids) {
    var effectiveWeights = {};
    for (var wi = 0; wi < FACTORS.length; wi++) {
      var fid = FACTORS[wi].id;
      effectiveWeights[fid] = (weights[fid] != null) ? weights[fid] : FACTORS[wi].defaultWeight;
    }

    var factorScores = new Map();
    for (var ni = 0; ni < FACTORS.length; ni++) {
      var nf = FACTORS[ni];
      if (effectiveWeights[nf.id] === 0) continue;
      var rawMap = rawValues.get(nf.id);
      if (!rawMap || rawMap.size === 0) continue;
      var valArray = [];
      for (var entry of rawMap.entries()) {
        valArray.push({ geoid: entry[0], rawValue: entry[1] });
      }
      factorScores.set(nf.id, normalizeQuintiles(computeQuintiles(valArray), nf.higherIsBetter));
    }

    return {
      scores: computeComposite(factorScores, effectiveWeights, geoids),
      factorScores: factorScores,
      effectiveWeights: effectiveWeights
    };
  }
  TPI.rescoreFromRaw = rescoreFromRaw;

  // =========================================================================
  // Area apportionment: compute buffer-overlap fractions and clipped geometries
  // =========================================================================

  function computeAreaFractions(geos, unionFeat) {
    var fractions = new Map();
    var clippedGeos = [];

    for (var i = 0; i < geos.length; i++) {
      var f = geos[i];
      var geoid = f.properties && f.properties.GEOID;
      if (!geoid) continue;

      var inter;
      try { inter = turf.intersect(f, unionFeat); } catch (_) { inter = null; }

      if (!inter) {
        fractions.set(geoid, 0);
        continue;
      }

      var aInter = turf.area(inter);
      var aGeo = turf.area(f);
      var frac = aGeo > 0 ? Math.min(1, Math.max(0, aInter / aGeo)) : 0;
      fractions.set(geoid, frac);

      clippedGeos.push({
        type: "Feature",
        properties: { GEOID: geoid },
        geometry: inter.geometry
      });
    }

    return { fractions: fractions, clippedGeos: clippedGeos };
  }

  function apportionRawValues(rawValues, fractions) {
    var apportioned = new Map();
    for (var entry of rawValues.entries()) {
      var factorId = entry[0];
      var rawMap = entry[1];
      var aMap = new Map();
      for (var gEntry of rawMap.entries()) {
        var geoid = gEntry[0];
        var val = gEntry[1];
        var frac = fractions.get(geoid);
        if (frac == null) frac = 1;
        aMap.set(geoid, Number.isFinite(val) ? val * frac : val);
      }
      apportioned.set(factorId, aMap);
    }
    return apportioned;
  }

  // =========================================================================
  // Main orchestrator: run full TPI computation
  // =========================================================================
  // options: { geoLevel, year, weights, lodesData, onProgress, apportionByArea, growthFactors }
  // Returns { geos, geoids, scores, factorScores, rawValues, ... }

  async function computeTPI(options) {
    var geoLevel = options.geoLevel || "bg";
    var year = options.year || "2024";
    var weights = options.weights || {};
    var lodesData = options.lodesData || null;
    var onProgress = options.onProgress || function () {};
    var apportionByArea = !!options.apportionByArea;
    var growthFactors = options.growthFactors || null;

    // Build effective weights: use defaults where not overridden
    var effectiveWeights = {};
    for (var wi = 0; wi < FACTORS.length; wi++) {
      var fid = FACTORS[wi].id;
      effectiveWeights[fid] = (weights[fid] != null) ? weights[fid] : FACTORS[wi].defaultWeight;
    }

    // If no LODES data, redistribute employment weight to others
    if (!lodesData) {
      var empWeight = effectiveWeights.employment || 0;
      effectiveWeights.employment = 0;
      if (empWeight > 0) {
        var otherActive = FACTORS.filter(function (f) {
          return f.id !== "employment" && effectiveWeights[f.id] > 0;
        });
        var share = empWeight / (otherActive.length || 1);
        for (var oi = 0; oi < otherActive.length; oi++) {
          effectiveWeights[otherActive[oi].id] += share;
        }
      }
    }

    // 1. Get buffer union (use custom polygon if provided, else global union)
    onProgress("Getting buffer union...");
    var unionFeat = options.unionPolygon || App.bufferUnionPolygon();
    if (!unionFeat) throw new Error("No buffers set. Place points, lines, or routes first.");

    // 2. Fetch census geographies
    onProgress("Fetching census geographies...");
    var geos = await App.fetchTigerwebGeos(geoLevel, unionFeat);
    if (geos.length === 0) throw new Error("No intersecting " + (geoLevel === "tract" ? "tracts" : "block groups") + " found.");

    var geoids = geos.map(function (f) { return f.properties.GEOID; }).filter(Boolean);

    // 3. Batch fetch all required ACS variables, with tract-level fallback for tract-only tables
    var allAcsVars = getRequiredAcsVars(effectiveWeights);
    var tractFallbackFactors = []; // factor ids that used tract-level data when BG was requested

    var acsData; // Map(geoid -> Map(varCode -> value)), keyed by the requested geoLevel GEOID

    if (geoLevel === "bg") {
      // Identify which vars belong to tract-only factors
      var tractOnlyVarSet = new Set();
      for (var tfi = 0; tfi < FACTORS.length; tfi++) {
        var tf = FACTORS[tfi];
        if (tf.tractOnly && effectiveWeights[tf.id] !== 0 && tf.acsVars) {
          for (var tvi = 0; tvi < tf.acsVars.length; tvi++) tractOnlyVarSet.add(tf.acsVars[tvi]);
          tractFallbackFactors.push(tf.id);
        }
      }

      var bgVars = allAcsVars.filter(function (v) { return !tractOnlyVarSet.has(v); });
      var tractOnlyVars = allAcsVars.filter(function (v) { return tractOnlyVarSet.has(v); });

      onProgress("Fetching ACS data (" + allAcsVars.length + " variables)...");

      // Fetch BG-level vars
      acsData = await batchFetchACS("bg", year, geoids, bgVars);

      // Fetch tract-level vars if any, then map values down to BG GEOIDs
      if (tractOnlyVars.length > 0) {
        // Derive unique tract GEOIDs from BG GEOIDs (first 11 chars)
        var tractGeoidSet = new Set();
        for (var bgi = 0; bgi < geoids.length; bgi++) tractGeoidSet.add(geoids[bgi].slice(0, 11));
        var tractGeoids = Array.from(tractGeoidSet);

        onProgress("Fetching tract-level data for " + tractFallbackFactors.join(", ") + "...");
        var tractData = await batchFetchACS("tract", year, tractGeoids, tractOnlyVars);

        // Copy tract values into each BG's entry, keyed by the BG GEOID
        for (var bgi2 = 0; bgi2 < geoids.length; bgi2++) {
          var bgGeo = geoids[bgi2];
          var parentTract = bgGeo.slice(0, 11);
          var tractVals = tractData.get(parentTract) || new Map();
          if (!acsData.has(bgGeo)) acsData.set(bgGeo, new Map());
          var bgEntry = acsData.get(bgGeo);
          for (var tractEntry of tractVals.entries()) {
            bgEntry.set(tractEntry[0], tractEntry[1]);
          }
        }
      }
    } else {
      // Tract level: no fallback needed, all vars available natively
      onProgress("Fetching ACS data (" + allAcsVars.length + " variables)...");
      acsData = await batchFetchACS("tract", year, geoids, allAcsVars);
    }

    // 3b. Deep-clone ACS data before growth factor application (for re-scoring later)
    var cachedAcsData = new Map();
    acsData.forEach(function (geoVals, geoid) {
      cachedAcsData.set(geoid, new Map(geoVals));
    });

    // 3c. Apply population projections (if provided) — additive: pop_new = pop_census + pop_addition
    if (growthFactors) {
      acsData.forEach(function (geoVals, geoid) {
        var tractId = geoid.slice(0, 11);
        var popAdd = growthFactors.get(geoid) || growthFactors.get(tractId) || 0;
        var pop = geoVals.get("B01003_001E");
        if (Number.isFinite(pop) && popAdd !== 0) geoVals.set("B01003_001E", Math.max(0, pop + popAdd));
      });
    }

    // 4. Aggregate LODES to geo level (if available and weighted)
    var lodesAgg = null;
    if (lodesData && effectiveWeights.employment > 0) {
      onProgress("Aggregating LODES employment data...");
      lodesAgg = aggregateLodesToGeo(lodesData, geoids, geoLevel);
    }

    // 5. Compute raw values for each factor x geography
    onProgress("Computing factor values...");
    var rawValues = new Map(); // Map(factorId -> Map(geoid -> rawValue))

    for (var fi = 0; fi < FACTORS.length; fi++) {
      var factor = FACTORS[fi];
      if (effectiveWeights[factor.id] === 0) continue;

      var raw = new Map();

      if (factor.source === "LODES" && factor.id === "employment") {
        if (lodesAgg) {
          for (var gIdx = 0; gIdx < geos.length; gIdx++) {
            var gf = geos[gIdx];
            var gid = gf.properties.GEOID;
            var jobs = lodesAgg.get(gid) || 0;
            var areaSqMi = turf.area(gf) / SQM_PER_SQMI;
            raw.set(gid, areaSqMi > 0 ? jobs / areaSqMi : NaN);
          }
        }
      } else if (factor.compute) {
        for (var gIdx2 = 0; gIdx2 < geos.length; gIdx2++) {
          var gf2 = geos[gIdx2];
          var gid2 = gf2.properties.GEOID;
          var geoVals = acsData.get(gid2) || new Map();
          var val = factor.compute(geoVals, gf2, unionFeat);
          raw.set(gid2, val);
        }
      }

      rawValues.set(factor.id, raw);
    }

    // 5b. Area apportionment: compute fractions and apportioned raw values
    var areaFractions = null;       // Map(geoid -> frac), only when apportionByArea
    var apportionedRawValues = null; // Map(factorId -> Map(geoid -> rawValue*frac))
    var clippedGeos = null;         // Array of clipped GeoJSON features

    if (apportionByArea) {
      onProgress("Computing area fractions...");
      var areaResult = computeAreaFractions(geos, unionFeat);
      areaFractions = areaResult.fractions;
      clippedGeos = areaResult.clippedGeos;
      apportionedRawValues = apportionRawValues(rawValues, areaFractions);
    }

    // 5c. Dynamic tract fallback: if any ACS factor has BGs with NaN values,
    //     fetch those factor variables at tract level and fill in the missing BGs.
    //     Handles both total-miss (no BG data at all) and partial-miss (some BGs
    //     have data, others are suppressed/missing) cases.
    //     Skipped when area apportionment is on (fractions make the spatial weighting accurate).
    if (geoLevel === "bg" && !apportionByArea) {
      var dynamicFallbackVars = [];
      var dynamicFallbackEntries = []; // { factor, nanGeoids: Set }

      for (var di = 0; di < FACTORS.length; di++) {
        var df = FACTORS[di];
        if (df.source !== "ACS" || !df.compute || !df.acsVars || effectiveWeights[df.id] === 0) continue;
        if (tractFallbackFactors.indexOf(df.id) !== -1) continue; // already handled statically

        var dfRawMap = rawValues.get(df.id);
        var nanGeoids = new Set();
        for (var ngi = 0; ngi < geoids.length; ngi++) {
          if (!dfRawMap || !Number.isFinite(dfRawMap.get(geoids[ngi]))) nanGeoids.add(geoids[ngi]);
        }

        if (nanGeoids.size > 0) {
          for (var dvi = 0; dvi < df.acsVars.length; dvi++) {
            if (dynamicFallbackVars.indexOf(df.acsVars[dvi]) === -1) {
              dynamicFallbackVars.push(df.acsVars[dvi]);
            }
          }
          dynamicFallbackEntries.push({ factor: df, nanGeoids: nanGeoids });
        }
      }

      if (dynamicFallbackVars.length > 0) {
        var dynTractGeoidSet = new Set();
        for (var bgi3 = 0; bgi3 < geoids.length; bgi3++) dynTractGeoidSet.add(geoids[bgi3].slice(0, 11));
        var dynTractGeoids = Array.from(dynTractGeoidSet);

        var fallbackNames = dynamicFallbackEntries.map(function (e) { return e.factor.id; });
        onProgress("Fetching tract-level fallback for " + fallbackNames.join(", ") + "...");
        var dynTractData = await batchFetchACS("tract", year, dynTractGeoids, dynamicFallbackVars);

        // Build GEOID-to-feature lookup for efficient recomputation
        var geoidToFeat = {};
        for (var gli = 0; gli < geos.length; gli++) {
          if (geos[gli].properties && geos[gli].properties.GEOID) {
            geoidToFeat[geos[gli].properties.GEOID] = geos[gli];
          }
        }

        // For each factor with NaN BGs, fill in tract-level data and recompute
        for (var dfi = 0; dfi < dynamicFallbackEntries.length; dfi++) {
          var dEntry = dynamicFallbackEntries[dfi];
          var dfactor = dEntry.factor;
          var nanSet = dEntry.nanGeoids;

          // For NaN BGs, overwrite their acsData with tract values for
          // this factor's variables so numerator & denominator are consistent
          for (var nanBg of nanSet) {
            var parentTract2 = nanBg.slice(0, 11);
            var tVals2 = dynTractData.get(parentTract2) || new Map();
            if (!acsData.has(nanBg)) acsData.set(nanBg, new Map());
            var bgEntry2 = acsData.get(nanBg);
            for (var avi = 0; avi < dfactor.acsVars.length; avi++) {
              var acsVar = dfactor.acsVars[avi];
              if (tVals2.has(acsVar)) bgEntry2.set(acsVar, tVals2.get(acsVar));
            }
          }

          // Recompute raw values only for BGs that had NaN
          var existingRaw = rawValues.get(dfactor.id) || new Map();
          for (var nanBg2 of nanSet) {
            var feat = geoidToFeat[nanBg2];
            if (!feat) continue;
            var geoVals3 = acsData.get(nanBg2) || new Map();
            existingRaw.set(nanBg2, dfactor.compute(geoVals3, feat, unionFeat));
          }
          rawValues.set(dfactor.id, existingRaw);
          if (tractFallbackFactors.indexOf(dfactor.id) === -1) {
            tractFallbackFactors.push(dfactor.id);
          }
        }
      }
    }

    // 6. Quintile normalize each factor
    //    When area apportionment is on, normalize from apportioned values.
    onProgress("Normalizing scores...");
    var scoringValues = apportionByArea ? apportionedRawValues : rawValues;
    var factorScores = new Map(); // Map(factorId -> Map(geoid -> 1-5))

    for (var ni = 0; ni < FACTORS.length; ni++) {
      var nf = FACTORS[ni];
      if (effectiveWeights[nf.id] === 0) continue;
      var rawMap = scoringValues.get(nf.id);
      if (!rawMap || rawMap.size === 0) continue;

      // Build values array for quintile computation
      var valArray = [];
      for (var entry of rawMap.entries()) {
        valArray.push({ geoid: entry[0], rawValue: entry[1] });
      }

      var quintiles = computeQuintiles(valArray);
      var normalized = normalizeQuintiles(quintiles, nf.higherIsBetter);
      factorScores.set(nf.id, normalized);
    }

    // 7. Compute composite
    onProgress("Computing composite scores...");
    var scores = computeComposite(factorScores, effectiveWeights, geoids);

    var result = {
      geos: geos,
      geoids: geoids,
      scores: scores,
      factorScores: factorScores,
      rawValues: rawValues,
      effectiveWeights: effectiveWeights,
      tractFallbackFactors: tractFallbackFactors,
      apportionByArea: apportionByArea,
      cachedAcsData: cachedAcsData,
      cachedLodesAgg: lodesAgg
    };

    if (apportionByArea) {
      result.apportionedRawValues = apportionedRawValues;
      result.areaFractions = areaFractions;
      result.clippedGeos = clippedGeos;
    }

    return result;
  }
  TPI.computeTPI = computeTPI;

  // =========================================================================
  // Re-score TPI with different growth factors using cached ACS data.
  // No Census API calls — instant recomputation.
  // prevResult must include cachedAcsData (from a prior computeTPI call).
  // Returns a full result object (geos, geoids, scores, factorScores, rawValues, effectiveWeights).
  // =========================================================================

  function recomputeWithGrowthFactors(prevResult, newGrowthFactors) {
    if (!prevResult || !prevResult.cachedAcsData) {
      throw new Error("Previous TPI result does not contain cached ACS data for re-scoring.");
    }

    var geos = prevResult.geos;
    var geoids = prevResult.geoids;
    var effectiveWeights = prevResult.effectiveWeights;
    var lodesAgg = prevResult.cachedLodesAgg;
    var apportionByArea = prevResult.apportionByArea;

    // Deep-clone cached ACS data and apply new growth factors
    var acsData = new Map();
    prevResult.cachedAcsData.forEach(function (geoVals, geoid) {
      acsData.set(geoid, new Map(geoVals));
    });

    if (newGrowthFactors) {
      acsData.forEach(function (geoVals, geoid) {
        var tractId = geoid.slice(0, 11);
        var popAdd = newGrowthFactors.get(geoid) || newGrowthFactors.get(tractId) || 0;
        var pop = geoVals.get("B01003_001E");
        if (Number.isFinite(pop) && popAdd !== 0) geoVals.set("B01003_001E", Math.max(0, pop + popAdd));
      });
    }

    // Recompute raw factor values (same logic as computeTPI steps 5-7)
    var rawValues = new Map();
    for (var fi = 0; fi < FACTORS.length; fi++) {
      var factor = FACTORS[fi];
      if (effectiveWeights[factor.id] === 0) continue;

      var raw = new Map();
      if (factor.source === "LODES" && factor.id === "employment") {
        if (lodesAgg) {
          for (var gIdx = 0; gIdx < geos.length; gIdx++) {
            var gf = geos[gIdx];
            var gid = gf.properties.GEOID;
            var jobs = lodesAgg.get(gid) || 0;
            var areaSqMi = turf.area(gf) / SQM_PER_SQMI;
            raw.set(gid, areaSqMi > 0 ? jobs / areaSqMi : NaN);
          }
        }
      } else if (factor.compute) {
        for (var gIdx2 = 0; gIdx2 < geos.length; gIdx2++) {
          var gf2 = geos[gIdx2];
          var gid2 = gf2.properties.GEOID;
          var geoVals2 = acsData.get(gid2) || new Map();
          raw.set(gid2, factor.compute(geoVals2, gf2));
        }
      }
      rawValues.set(factor.id, raw);
    }

    // Area apportionment (reuse fractions from original result)
    var scoringValues = rawValues;
    if (apportionByArea && prevResult.areaFractions) {
      scoringValues = apportionRawValues(rawValues, prevResult.areaFractions);
    }

    // Quintile normalize
    var factorScores = new Map();
    for (var ni = 0; ni < FACTORS.length; ni++) {
      var nf = FACTORS[ni];
      if (effectiveWeights[nf.id] === 0) continue;
      var rawMap = scoringValues.get(nf.id);
      if (!rawMap || rawMap.size === 0) continue;
      var valArray = [];
      for (var entry of rawMap.entries()) {
        valArray.push({ geoid: entry[0], rawValue: entry[1] });
      }
      factorScores.set(nf.id, normalizeQuintiles(computeQuintiles(valArray), nf.higherIsBetter));
    }

    // Composite
    var scores = computeComposite(factorScores, effectiveWeights, geoids);

    return {
      geos: geos,
      geoids: geoids,
      scores: scores,
      factorScores: factorScores,
      rawValues: rawValues,
      effectiveWeights: effectiveWeights,
      tractFallbackFactors: prevResult.tractFallbackFactors,
      apportionByArea: apportionByArea,
      cachedAcsData: prevResult.cachedAcsData,
      cachedLodesAgg: lodesAgg
    };
  }
  TPI.recomputeWithGrowthFactors = recomputeWithGrowthFactors;

  // =========================================================================
  // Utility: get default weights as an object
  // =========================================================================

  function getDefaultWeights() {
    var w = {};
    for (var i = 0; i < FACTORS.length; i++) {
      w[FACTORS[i].id] = FACTORS[i].defaultWeight;
    }
    return w;
  }
  TPI.getDefaultWeights = getDefaultWeights;

})();
