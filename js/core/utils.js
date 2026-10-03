// js/core/utils.js
// Shared utility functions, variable metadata, and helpers.
// No dependencies beyond PapaParse (loaded via CDN).
// Exports: setStatus, escapeHTML, escapeAttr, parseCSV, fillSelect,
//          enableSelect, toNumberSafe, normalizeTractGEOID, guessHeader,
//          VAR_META, GROUP_INFO, getMeta, getCheckboxGroups,
//          getCheckboxGroupMembers, getDenominator, setAggUI, formatValue,
//          FEATURE_ID_PROP, nextFeatureId, ensureFeatureIds,
//          featureRef, resolveFeatureRef, featureById, featureRefKey,
//          parseFeatureRefKey, migrateIndexRefKey, indexFilterToRefs,
//          uncheckedRefsFromIndexFilter

(function () {
  var App = window.App = window.App || {};

  // Census API key now lives in js/core/config.js (loaded before this file),
  // alongside the CARTO basemap key — see that file's header for why those
  // values are public by design.

  // Sequential color palette for new lines + routes (shared sequence, 18 distinct colors)
  App.FEATURE_COLORS = [
    "#e53e3e","#319795","#d69e2e","#805ad5","#3182ce","#38a169",
    "#dd6b20","#d53f8c","#00b5d8","#b7791f","#276749","#c53030",
    "#553c9a","#2c7a7b","#744210","#22543d","#2b6cb0","#97266d"
  ];

  // Default color for new polygons (powder blue)
  App.POLYGON_DEFAULT_COLOR = "#b0c4de";

  // Per-section color overrides (null = use sequential or built-in default)
  App.sectionColors = { point: null, line: null, route: null, polygon: null };

  // --- Feature color resolution (docs/archive/feature-color-system-plan.md) ---
  // One cascade, for every drawn feature type, resolved fresh on every render:
  //   1. feature.properties.color, when non-empty — a per-feature override.
  //   2. App.sectionColors[type], when non-empty — a flat type-level default.
  //   3. Automatic — line/route vary per feature via a stable palette slot
  //      (properties.colorSeq); point/polygon/label use a fixed built-in.

  var _colorSeqCounter = 0;

  // Called once at creation time for every new line/route so it gets a
  // stable palette slot that survives later deletions elsewhere in the array
  // (an array-position lookup would recolor later features when an earlier
  // one is removed).
  function nextColorSeq() {
    return _colorSeqCounter++;
  }

  // Called on session restore so a freshly-created feature never collides
  // with a colorSeq already stamped on a restored line/route.
  function advanceColorSeqPast(n) {
    if (typeof n === "number" && isFinite(n) && n >= _colorSeqCounter) _colorSeqCounter = n + 1;
  }

  // Fallback for a line/route with no stamped colorSeq (every feature drawn
  // before this cascade existed). Reproduces the array-position formula the
  // creation sites used before colorSeq existed, so an untouched session
  // resolves to the color it already has.
  function _positionalColorSeq(featureType, feature) {
    if (featureType === "route") {
      return (App.lines ? App.lines.length : 0) + (App.routes ? App.routes.indexOf(feature) : 0);
    }
    return App.lines ? App.lines.indexOf(feature) : 0;
  }

  function resolveFeatureColor(featureType, feature) {
    var props = (feature && feature.properties) || {};

    // Tier 1: per-feature override.
    if (props.color) return props.color;

    // Tier 2: type-level flat default.
    var typeDefault = App.sectionColors && App.sectionColors[featureType];
    if (typeDefault) return typeDefault;

    // Tier 3: Automatic.
    if (featureType === "line" || featureType === "route") {
      var seq = (typeof props.colorSeq === "number") ? props.colorSeq : _positionalColorSeq(featureType, feature);
      var n = App.FEATURE_COLORS.length;
      return App.FEATURE_COLORS[((seq % n) + n) % n];
    }
    if (featureType === "polygon") return App.POLYGON_DEFAULT_COLOR || "#b0c4de";
    if (featureType === "label") return "#1a202c";
    return "#2b6cb0"; // point, and any unrecognized type
  }

  // --- Stable per-type feature IDs (docs/archive/feature-merge-plan.md, Phase 1) ---
  // Every drawn feature carries an integer ID in a per-type property
  // (pointIdx / lineIdx / routeIdx / polyIdx). It is used to map a clicked map
  // feature back to its array index and to link stops to routes
  // (attributes.associatedRoutes[].featureId). IDs are handed out from a
  // monotonic per-type counter, so they are never reused after a delete
  // (the old `array.length + 1` scheme repeated IDs once anything was removed).
  // Display names ("Route 3") are independent of the ID and unchanged.

  App.FEATURE_ID_PROP = { point: "pointIdx", line: "lineIdx", route: "routeIdx", polygon: "polyIdx" };

  var _featureIdCounters = { point: 1, line: 1, route: 1, polygon: 1 };

  // Returns the next unused ID for a feature type and advances the counter.
  function nextFeatureId(type) {
    if (!App.FEATURE_ID_PROP[type]) throw new Error("nextFeatureId: unknown feature type " + type);
    return _featureIdCounters[type]++;
  }

  function _isValidFeatureId(v) {
    return typeof v === "number" && isFinite(v) && v >= 1 && Math.floor(v) === v;
  }

  // PURE (no DOM/map/turf — loaded directly by the golden harness).
  // arraysByType = { point: [...], line: [...], route: [...], polygon: [...] }
  // (any key may be absent). Walks each array in order and stamps a fresh ID
  // on any feature whose ID is missing, not a positive integer, or duplicates
  // an earlier feature of the same type — the first (older) occurrence keeps
  // it. Fresh IDs start above every valid ID in that array. Mutates the
  // features' properties; returns
  //   { changes: [{ type, index, oldId, newId }], maxByType: { type: maxId } }.
  // Idempotent: a second call on the same arrays changes nothing.
  function assignFeatureIds(arraysByType) {
    var changes = [];
    var maxByType = {};
    Object.keys(App.FEATURE_ID_PROP).forEach(function (type) {
      var arr = (arraysByType && arraysByType[type]) || [];
      var prop = App.FEATURE_ID_PROP[type];
      var seen = {};
      var max = 0;
      var needsNew = [];
      for (var i = 0; i < arr.length; i++) {
        var props = arr[i] && arr[i].properties;
        if (!props) continue;
        var id = props[prop];
        if (_isValidFeatureId(id) && !seen[id]) {
          seen[id] = true;
          if (id > max) max = id;
        } else {
          needsNew.push(i);
        }
      }
      for (var n = 0; n < needsNew.length; n++) {
        var idx = needsNew[n];
        var p = arr[idx].properties;
        var oldId = (p[prop] === undefined) ? null : p[prop];
        p[prop] = ++max;
        changes.push({ type: type, index: idx, oldId: oldId, newId: p[prop] });
      }
      maxByType[type] = max;
    });
    return { changes: changes, maxByType: maxByType };
  }

  // Runs assignFeatureIds over the live arrays and advances the counters past
  // every ID in use. Called from cache.js applyState() after the features are
  // pushed, which covers session restore, file import, shapefile/CSV/GeoJSON
  // import and undo/redo. Returns the change list (empty when nothing moved).
  // Limitation: a stop link (associatedRoutes[].featureId) that referenced a
  // duplicated ID keeps pointing at the first (older) feature that holds it;
  // the ambiguity cannot be resolved retroactively.
  function ensureFeatureIds() {
    var res = assignFeatureIds({
      point: App.points, line: App.lines, route: App.routes, polygon: App.polygons
    });
    Object.keys(res.maxByType).forEach(function (type) {
      if (res.maxByType[type] >= _featureIdCounters[type]) _featureIdCounters[type] = res.maxByType[type] + 1;
    });
    return res.changes;
  }

  // Snapshot of the counters for the session cache.
  function getFeatureIdCounters() {
    return { point: _featureIdCounters.point, line: _featureIdCounters.line,
             route: _featureIdCounters.route, polygon: _featureIdCounters.polygon };
  }

  // Raise each counter to at least the stored value (never lowers one).
  function advanceFeatureIdCounters(stored) {
    if (!stored) return;
    Object.keys(_featureIdCounters).forEach(function (type) {
      var v = stored[type];
      if (_isValidFeatureId(v) && v > _featureIdCounters[type]) _featureIdCounters[type] = v;
    });
  }

  // --- Feature references by stable ID (docs/archive/feature-merge-plan.md, Phase 4b) ---
  // Array indices shift whenever an earlier feature is deleted or merged, so a
  // module that remembers a feature by index silently retargets. A feature ref
  // is { type, id } (type = point|line|route|polygon, id = the per-type stable
  // ID above). Modules store refs, and resolve them to a current index at USE
  // time via App.resolveFeatureRef — never cache the resolved index.

  // PURE. First index in `arr` whose properties[prop] === id, else -1.
  function findIndexById(arr, prop, id) {
    if (!arr || !_isValidFeatureId(id)) return -1;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i] && arr[i].properties;
      if (p && p[prop] === id) return i;
    }
    return -1;
  }

  // PURE. arraysByType = { point, line, route, polygon } (any may be absent).
  // → { type, id } for the feature at `index`, or null (bad type, index out of
  // range, or the feature has no valid ID).
  function featureRefIn(arraysByType, type, index) {
    var prop = App.FEATURE_ID_PROP[type];
    var arr = prop && arraysByType && arraysByType[type];
    var f = arr && arr[index];
    var id = f && f.properties && f.properties[prop];
    return _isValidFeatureId(id) ? { type: type, id: id } : null;
  }

  // PURE. ref = { type, id } → current index in arraysByType[type], or -1
  // (unknown type, malformed ref, or the feature no longer exists).
  function resolveRefIn(arraysByType, ref) {
    if (!ref || !App.FEATURE_ID_PROP[ref.type]) return -1;
    return findIndexById(arraysByType && arraysByType[ref.type], App.FEATURE_ID_PROP[ref.type], ref.id);
  }

  function _liveArrays() {
    return { point: App.points, line: App.lines, route: App.routes, polygon: App.polygons };
  }
  function featureRef(type, index) { return featureRefIn(_liveArrays(), type, index); }
  function resolveFeatureRef(ref) { return resolveRefIn(_liveArrays(), ref); }
  function featureById(type, id) {
    var i = resolveRefIn(_liveArrays(), { type: type, id: id });
    return i < 0 ? null : _liveArrays()[type][i];
  }

  // PURE. A ref as a "type:id" string — the form modules use as a <select>
  // option value or checkbox key ("route:12" is route ID 12, NOT array index 12).
  function featureRefKey(ref) {
    return ref && App.FEATURE_ID_PROP[ref.type] && _isValidFeatureId(ref.id) ? ref.type + ":" + ref.id : "";
  }

  // PURE. Inverse of featureRefKey → { type, id } or null (malformed, unknown
  // type, or a non-integer id). "all" and "" parse to null.
  function parseFeatureRefKey(str) {
    if (typeof str !== "string") return null;
    var m = /^([a-z]+):(\d+)$/.exec(str);
    if (!m || !App.FEATURE_ID_PROP[m[1]]) return null;
    var ref = { type: m[1], id: parseInt(m[2], 10) };
    return _isValidFeatureId(ref.id) ? ref : null;
  }

  // PURE. Legacy "type:<array index>" string ("route:3", as older sessions saved
  // corridor selections) → the ID-based "type:<id>" key, resolved against
  // arraysByType. "" when the index points at nothing. Only valid at the moment a
  // legacy session is applied, when saved indices still match the live arrays.
  function migrateIndexRefKeyIn(arraysByType, str) {
    if (typeof str !== "string") return "";
    var m = /^([a-z]+):(\d+)$/.exec(str);
    if (!m) return "";
    return featureRefKey(featureRefIn(arraysByType, m[1], parseInt(m[2], 10)));
  }

  // PURE. Legacy index filter { routeIndices, lineIndices, pointIndices,
  // polygonIndices } (any key may be absent) → array of { type, id } refs for the
  // features those indices name. Indices that resolve to nothing are dropped.
  function indexFilterToRefsIn(arraysByType, filter) {
    var out = [];
    if (!filter) return out;
    [["route", "routeIndices"], ["line", "lineIndices"],
     ["point", "pointIndices"], ["polygon", "polygonIndices"]].forEach(function (pair) {
      (filter[pair[1]] || []).forEach(function (i) {
        var ref = featureRefIn(arraysByType, pair[0], i);
        if (ref) out.push(ref);
      });
    });
    return out;
  }

  // PURE. Legacy CHECKED-index filter → refs of the features of `types` that the
  // filter leaves UNchecked (everything live not named by it). Modules remember a
  // checklist as its unchecked refs so newly drawn features default to checked.
  function uncheckedRefsFromIndexFilterIn(arraysByType, filter, types) {
    var checked = {};
    indexFilterToRefsIn(arraysByType, filter).forEach(function (r) { checked[featureRefKey(r)] = true; });
    var out = [];
    (types || []).forEach(function (type) {
      var arr = (arraysByType && arraysByType[type]) || [];
      for (var i = 0; i < arr.length; i++) {
        var ref = featureRefIn(arraysByType, type, i);
        if (ref && !checked[featureRefKey(ref)]) out.push(ref);
      }
    });
    return out;
  }

  App.nextFeatureId = nextFeatureId;
  App.getFeatureIdCounters = getFeatureIdCounters;
  App.advanceFeatureIdCounters = advanceFeatureIdCounters;
  App._assignFeatureIds = assignFeatureIds;
  App.featureRef = featureRef;
  App.resolveFeatureRef = resolveFeatureRef;
  App.featureById = featureById;
  App._featureRefIn = featureRefIn;
  App._resolveRefIn = resolveRefIn;
  App.featureRefKey = featureRefKey;
  App.parseFeatureRefKey = parseFeatureRefKey;
  App._migrateIndexRefKeyIn = migrateIndexRefKeyIn;
  App._indexFilterToRefsIn = indexFilterToRefsIn;
  App.migrateIndexRefKey = function (str) { return migrateIndexRefKeyIn(_liveArrays(), str); };
  App._uncheckedRefsFromIndexFilterIn = uncheckedRefsFromIndexFilterIn;
  App.uncheckedRefsFromIndexFilter = function (filter, types) {
    return uncheckedRefsFromIndexFilterIn(_liveArrays(), filter, types);
  };
  App.indexFilterToRefs = function (filter) { return indexFilterToRefsIn(_liveArrays(), filter); };
  App.ensureFeatureIds = ensureFeatureIds;

  /* Feature usage hook (docs/archive/feature-split-plan.md Phase 3). Analysis modules
     register a provider fn(type, id) -> [label | {label, severity}] that says
     how they refer to a feature; the Split and Merge dialogs ask
     describeFeatureUsage(type, id) -> [{module, label, severity: "warn"|"info"}].
     Lives here (the first App file) so every module can register at load time.
     A provider that throws is ignored, never breaks the caller. */
  var _usageProviders = [];
  App.registerFeatureUsage = function (fn, opts) {
    if (typeof fn !== "function") return;
    var o = typeof opts === "string" ? { module: opts } : (opts || {});
    _usageProviders.push({ fn: fn, module: o.module || "", severity: o.severity === "warn" ? "warn" : "info" });
  };
  App.describeFeatureUsage = function (type, id) {
    var out = [];
    if (!type || id == null) return out;
    _usageProviders.forEach(function (p) {
      var res;
      try { res = p.fn(type, id); } catch (e) { return; }
      if (!Array.isArray(res)) res = res ? [res] : [];
      res.forEach(function (r) {
        if (!r) return;
        var label = typeof r === "string" ? r : r.label;
        if (!label) return;
        var sev = (r && r.severity) || p.severity;
        out.push({ module: (r && r.module) || p.module, label: String(label), severity: sev === "warn" ? "warn" : "info" });
      });
    });
    return out;
  };

  // "Last action wins" (docs/archive/feature-color-sync-plan.md): a type-wide color
  // chosen in the Layers tab must reach every feature of that type, so each
  // feature's own override is cleared and it inherits the type setting again.
  // Does not re-render or push undo -- App.setTypeColor (features.js) does both.
  // Labels are excluded (they have their own section color control).
  function clearFeatureColorOverrides(featureType) {
    var arr = { point: App.points, line: App.lines, route: App.routes, polygon: App.polygons }[featureType];
    var n = 0;
    (arr || []).forEach(function (f) {
      if (f && f.properties && f.properties.color) { f.properties.color = ""; n++; }
    });
    return n;
  }

  App.resolveFeatureColor = resolveFeatureColor;
  App.clearFeatureColorOverrides = clearFeatureColorOverrides;
  App._nextColorSeq = nextColorSeq;
  App._advanceColorSeqPast = advanceColorSeqPast;

  // --- Status ---

  var _statusTimer = null;
  function setStatus(s) {
    var el = document.getElementById("status");
    if (!el) return;
    el.textContent = s;
    clearTimeout(_statusTimer);
    if (s) _statusTimer = setTimeout(function () { el.textContent = ""; }, 5000);
  }

  // --- HTML escaping ---
  // Single source of truth for innerHTML / template-string escaping.
  // escapeAttr is an alias so callers can self-document the context they're
  // escaping for; both names produce identical, attribute-safe output.

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function escapeAttr(s) { return escapeHTML(s); }

  // --- CSV parsing + helpers ---

  function parseCSV(text) {
    var res = Papa.parse(text, {
      header: true,
      dynamicTyping: false,
      skipEmptyLines: true
    });
    if (res.errors && res.errors.length) {
      console.warn("CSV parse warnings:", res.errors.slice(0, 10));
    }
    var headers = res.meta && res.meta.fields ? res.meta.fields : [];
    var rows = res.data || [];
    return { headers: headers, rows: rows };
  }

  function fillSelect(selectEl, options, placeholder) {
    if (placeholder === undefined) placeholder = "Select\u2026";
    selectEl.innerHTML = "";
    var opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = placeholder;
    selectEl.appendChild(opt0);
    for (var i = 0; i < options.length; i++) {
      var opt = document.createElement("option");
      opt.value = options[i];
      opt.textContent = options[i];
      selectEl.appendChild(opt);
    }
  }

  function enableSelect(selectEl, enabled) { selectEl.disabled = !enabled; }

  function toNumberSafe(v) {
    if (v == null) return NaN;
    var s = String(v).replace(/,/g, "").trim();
    if (s === "") return NaN;
    var n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function normalizeTractGEOID(raw) {
    // CRE GEO_ID is like 1400000US01001020100 -> want trailing 11 digits
    var s = String(raw || "").trim();
    var m = s.match(/(\d{11})$/);
    return m ? m[1] : "";
  }

  function guessHeader(headers, candidates) {
    var lower = new Map(headers.map(function (h) { return [h.toLowerCase(), h]; }));
    for (var i = 0; i < candidates.length; i++) {
      var v = lower.get(candidates[i].toLowerCase());
      if (v) return v;
    }
    return "";
  }

  // --- Variable metadata ---
  // VAR_META is the single source of truth for ACS/LODES variables.
  //
  // Per-entry fields:
  //   source              "ACS" or "LODES"
  //   agg                 "sum" | "avg" | "ratio"
  //   fmt                 "int" | "decimal" | "usd"
  //   label               human-readable name
  //   category            section header in the checkbox UI
  //   codes               (optional) array of ACS codes summed per GEOID for derived variables
  //   tractOnly           (optional) only available at tract level; triggers fallback at BG
  //   numerator/denominator/ratioLabel  (ratio aggregations only)
  //
  // Checkbox-UI fields (drive the popup checkbox list and percentage column):
  //   displayInChecklist  true \u2192 render as its own checkbox in the popup
  //   group               e.g. "GROUP_RACE" \u2192 member of a group checkbox; not shown individually
  //   denominator         "B01003_001E" \u2192 percent against that variable
  //                       "$group"      \u2192 percent against the sum of this entry's group members
  //                       (absent)      \u2192 no percentage column
  //
  // displayInChecklist and group are mutually exclusive. Entries with neither are
  // hidden from the checkbox UI but still resolvable via getMeta() (denominators,
  // mandatory totals, etc.).

  var VAR_META = {
    // ---- Demographics ----
    "B01003_001E": { source: "ACS", agg: "sum", fmt: "int",     label: "Total population",            category: "Demographics", displayInChecklist: true },
    "B11001_001E": { source: "ACS", agg: "sum", fmt: "int",     label: "Total households",            category: "Demographics", displayInChecklist: true },
    "DERIVED_PPH":  { source: "ACS", agg: "ratio", fmt: "decimal", label: "Average persons per household", category: "Demographics", displayInChecklist: true,
                      numerator: "B01003_001E", denominator: "B11001_001E",
                      ratioLabel: "Calculated: Total Population / Total Households" },
    "B19013_001E": { source: "ACS", agg: "avg", fmt: "usd",     label: "Median household income",     category: "Demographics", tractOnly: true, displayInChecklist: true },
    "B01002_001E": { source: "ACS", agg: "avg", fmt: "decimal", label: "Median age",                  category: "Demographics", displayInChecklist: true },
    "B01001_002E": { source: "ACS", agg: "sum", fmt: "int",     label: "Male population",              category: "Demographics", group: "GROUP_SEX",       denominator: "B01003_001E" },
    "B01001_026E": { source: "ACS", agg: "sum", fmt: "int",     label: "Female population",            category: "Demographics", group: "GROUP_SEX",       denominator: "B01003_001E" },
    "B02001_002E": { source: "ACS", agg: "sum", fmt: "int",     label: "White alone",                  category: "Demographics", group: "GROUP_RACE",      denominator: "B01003_001E" },
    "B02001_003E": { source: "ACS", agg: "sum", fmt: "int",     label: "Black or African American alone", category: "Demographics", group: "GROUP_RACE",   denominator: "B01003_001E" },
    "B02001_004E": { source: "ACS", agg: "sum", fmt: "int",     label: "American Indian and Alaska Native alone", category: "Demographics", group: "GROUP_RACE", denominator: "B01003_001E" },
    "B02001_005E": { source: "ACS", agg: "sum", fmt: "int",     label: "Asian alone",                  category: "Demographics", group: "GROUP_RACE",      denominator: "B01003_001E" },
    "B02001_006E": { source: "ACS", agg: "sum", fmt: "int",     label: "Native Hawaiian and Other Pacific Islander alone", category: "Demographics", group: "GROUP_RACE", denominator: "B01003_001E" },
    "B02001_007E": { source: "ACS", agg: "sum", fmt: "int",     label: "Some other race alone",        category: "Demographics", group: "GROUP_RACE",      denominator: "B01003_001E" },
    "B02001_008E": { source: "ACS", agg: "sum", fmt: "int",     label: "Two or more races",            category: "Demographics", group: "GROUP_RACE",      denominator: "B01003_001E" },
    "B03003_003E": { source: "ACS", agg: "sum", fmt: "int",     label: "Hispanic or Latino",           category: "Demographics", group: "GROUP_ETHNICITY", denominator: "B01003_001E" },
    "B03003_002E": { source: "ACS", agg: "sum", fmt: "int",     label: "Not Hispanic or Latino",       category: "Demographics", group: "GROUP_ETHNICITY", denominator: "B01003_001E" },

    // ---- Equity ----
    "DERIVED_DISABILITY":     { source: "ACS", agg: "sum", fmt: "int", label: "With a disability",                                        category: "Equity", tractOnly: true, displayInChecklist: true, denominator: "B01003_001E",
      codes: ["B18101_004E","B18101_007E","B18101_010E","B18101_013E","B18101_016E","B18101_019E",
              "B18101_023E","B18101_026E","B18101_029E","B18101_032E","B18101_035E","B18101_038E"] },
    "B17001_002E":            { source: "ACS", agg: "sum", fmt: "int", label: "Persons below poverty level",                              category: "Equity", tractOnly: true, displayInChecklist: true, denominator: "B01003_001E" },
    "DERIVED_EDU_LT_HS":      { source: "ACS", agg: "sum", fmt: "int", label: "Less than high school diploma",                            category: "Equity", group: "GROUP_EDUCATION", denominator: "$group",
      codes: ["B15003_002E","B15003_003E","B15003_004E","B15003_005E","B15003_006E","B15003_007E","B15003_008E",
              "B15003_009E","B15003_010E","B15003_011E","B15003_012E","B15003_013E","B15003_014E","B15003_015E","B15003_016E"] },
    "DERIVED_EDU_HS":         { source: "ACS", agg: "sum", fmt: "int", label: "High school diploma or GED",                              category: "Equity", group: "GROUP_EDUCATION", denominator: "$group",
      codes: ["B15003_017E","B15003_018E"] },
    "DERIVED_EDU_SOME_COLLEGE":{ source: "ACS", agg: "sum", fmt: "int", label: "Some college or associate's degree",                     category: "Equity", group: "GROUP_EDUCATION", denominator: "$group",
      codes: ["B15003_019E","B15003_020E","B15003_021E"] },
    "DERIVED_EDU_BA_PLUS":    { source: "ACS", agg: "sum", fmt: "int", label: "Bachelor's degree or higher",                             category: "Equity", group: "GROUP_EDUCATION", denominator: "$group",
      codes: ["B15003_022E","B15003_023E","B15003_024E","B15003_025E"] },
    "DERIVED_LEP":            { source: "ACS", agg: "sum", fmt: "int", label: "Limited English proficient",                              category: "Equity", tractOnly: true, displayInChecklist: true, denominator: "B01003_001E",
      codes: ["C16001_005E","C16001_008E","C16001_011E","C16001_014E","C16001_017E","C16001_020E",
              "C16001_023E","C16001_026E","C16001_029E","C16001_032E","C16001_035E","C16001_038E"] },
    "B05001_002E":            { source: "ACS", agg: "sum", fmt: "int", label: "Born in US, citizen",                                     category: "Equity", tractOnly: true, group: "GROUP_CITIZENSHIP", denominator: "B01003_001E" },
    "B05001_005E":            { source: "ACS", agg: "sum", fmt: "int", label: "Naturalized US citizen",                                  category: "Equity", tractOnly: true, group: "GROUP_CITIZENSHIP", denominator: "B01003_001E" },
    "B05001_006E":            { source: "ACS", agg: "sum", fmt: "int", label: "Not a US citizen",                                        category: "Equity", tractOnly: true, group: "GROUP_CITIZENSHIP", denominator: "B01003_001E" },
    "B11016_002E":            { source: "ACS", agg: "sum", fmt: "int", label: "1-person household",                                      category: "Equity" },
    "B11016_003E":            { source: "ACS", agg: "sum", fmt: "int", label: "2-person household",                                      category: "Equity" },
    "B11016_004E":            { source: "ACS", agg: "sum", fmt: "int", label: "3-person household",                                      category: "Equity" },
    "B11016_005E":            { source: "ACS", agg: "sum", fmt: "int", label: "4-person household",                                      category: "Equity" },
    "B11016_006E":            { source: "ACS", agg: "sum", fmt: "int", label: "5-person household",                                      category: "Equity" },
    "B11016_007E":            { source: "ACS", agg: "sum", fmt: "int", label: "6-person household",                                      category: "Equity" },
    "B11016_008E":            { source: "ACS", agg: "sum", fmt: "int", label: "7+-person household",                                     category: "Equity" },
    "B08201_002E":            { source: "ACS", agg: "sum", fmt: "int", label: "Zero-car households",                                     category: "Equity", tractOnly: true, displayInChecklist: true, denominator: "B11001_001E" },
    "B23025_004E":            { source: "ACS", agg: "sum", fmt: "int", label: "Employed (civilian labor force)",                         category: "Equity", group: "GROUP_EMPLOYMENT", denominator: "$group" },
    "B23025_005E":            { source: "ACS", agg: "sum", fmt: "int", label: "Unemployed (civilian labor force)",                       category: "Equity", group: "GROUP_EMPLOYMENT", denominator: "$group" },
    "B23025_007E":            { source: "ACS", agg: "sum", fmt: "int", label: "Not in labor force",                                      category: "Equity", group: "GROUP_EMPLOYMENT", denominator: "$group" },

    // ---- Travel ----
    "DERIVED_VEH_0":          { source: "ACS", agg: "sum", fmt: "int", label: "0 vehicles available",          category: "Travel", tractOnly: true, codes: ["B08201_002E"] },
    "B08201_003E":            { source: "ACS", agg: "sum", fmt: "int", label: "1 vehicle available",            category: "Travel", tractOnly: true },
    "B08201_004E":            { source: "ACS", agg: "sum", fmt: "int", label: "2 vehicles available",           category: "Travel", tractOnly: true },
    "B08201_005E":            { source: "ACS", agg: "sum", fmt: "int", label: "3 vehicles available",           category: "Travel", tractOnly: true },
    "B08201_006E":            { source: "ACS", agg: "sum", fmt: "int", label: "4+ vehicles available",          category: "Travel", tractOnly: true },
    "B08301_003E":            { source: "ACS", agg: "sum", fmt: "int", label: "Commute: drove alone",           category: "Travel", group: "GROUP_COMMUTE",  denominator: "$group" },
    "B08301_004E":            { source: "ACS", agg: "sum", fmt: "int", label: "Commute: carpooled",             category: "Travel", group: "GROUP_COMMUTE",  denominator: "$group" },
    "B08301_010E":            { source: "ACS", agg: "sum", fmt: "int", label: "Commute: public transit",        category: "Travel", group: "GROUP_COMMUTE",  denominator: "$group" },
    "B08301_019E":            { source: "ACS", agg: "sum", fmt: "int", label: "Commute: walked",                category: "Travel", group: "GROUP_COMMUTE",  denominator: "$group" },
    "B08301_018E":            { source: "ACS", agg: "sum", fmt: "int", label: "Commute: biked",                 category: "Travel", group: "GROUP_COMMUTE",  denominator: "$group" },
    "B08301_021E":            { source: "ACS", agg: "sum", fmt: "int", label: "Commute: worked from home",      category: "Travel", group: "GROUP_COMMUTE",  denominator: "$group" },
    "DERIVED_COMMTIME_LT15":  { source: "ACS", agg: "sum", fmt: "int", label: "Commute time: under 15 min",     category: "Travel", group: "GROUP_COMMTIME", denominator: "$group",
      codes: ["B08303_002E","B08303_003E","B08303_004E"] },
    "DERIVED_COMMTIME_15_29": { source: "ACS", agg: "sum", fmt: "int", label: "Commute time: 15\u201329 min",   category: "Travel", group: "GROUP_COMMTIME", denominator: "$group",
      codes: ["B08303_005E","B08303_006E","B08303_007E"] },
    "DERIVED_COMMTIME_30_44": { source: "ACS", agg: "sum", fmt: "int", label: "Commute time: 30\u201344 min",   category: "Travel", group: "GROUP_COMMTIME", denominator: "$group",
      codes: ["B08303_008E","B08303_009E","B08303_010E"] },
    "B08303_011E":            { source: "ACS", agg: "sum", fmt: "int", label: "Commute time: 45\u201359 min",   category: "Travel", group: "GROUP_COMMTIME", denominator: "$group" },
    "DERIVED_COMMTIME_60PLUS":{ source: "ACS", agg: "sum", fmt: "int", label: "Commute time: 60+ min",          category: "Travel", group: "GROUP_COMMTIME", denominator: "$group",
      codes: ["B08303_012E","B08303_013E"] },

    // ---- Housing ----
    "B25001_001E": { source: "ACS", agg: "sum", fmt: "int", label: "Total housing units",  category: "Housing", displayInChecklist: true },
    "B25003_002E": { source: "ACS", agg: "sum", fmt: "int", label: "Owner-occupied units", category: "Housing", group: "GROUP_OCCUPANCY",   denominator: "B25001_001E" },
    "B25003_003E": { source: "ACS", agg: "sum", fmt: "int", label: "Renter-occupied units", category: "Housing", group: "GROUP_OCCUPANCY",   denominator: "B25001_001E" },
    "DERIVED_RENT_NOT_BURDENED": { source: "ACS", agg: "sum", fmt: "int", label: "Gross rent < 30% of income",              category: "Housing", group: "GROUP_RENT_BURDEN", denominator: "B25003_003E",
      codes: ["B25070_002E","B25070_003E","B25070_004E","B25070_005E","B25070_006E"] },
    "DERIVED_RENT_BURDENED":     { source: "ACS", agg: "sum", fmt: "int", label: "Gross rent 30\u201349.9% of income (cost burdened)", category: "Housing", group: "GROUP_RENT_BURDEN", denominator: "B25003_003E",
      codes: ["B25070_007E","B25070_008E","B25070_009E"] },
    "B25070_010E": { source: "ACS", agg: "sum", fmt: "int", label: "Gross rent 50%+ of income (severely cost burdened)", category: "Housing", group: "GROUP_RENT_BURDEN", denominator: "B25003_003E" },
    "B25064_001E": { source: "ACS", agg: "avg", fmt: "usd", label: "Median gross rent",   category: "Housing", displayInChecklist: true },
    "B25077_001E": { source: "ACS", agg: "avg", fmt: "usd", label: "Median home value",   category: "Housing", displayInChecklist: true },

    // ---- Employment ----
    "LODES_WAC_C000": { source: "LODES", agg: "sum", fmt: "int", label: "Total existing employment \u2014 LODES file required", category: "Employment", displayInChecklist: true }
  };

  // Display info for group checkboxes (members carry the `group` key on VAR_META).
  // The category for each group is inherited from its first member at runtime.
  var GROUP_INFO = {
    GROUP_SEX:         { label: "Sex" },
    GROUP_RACE:        { label: "Race" },
    GROUP_ETHNICITY:   { label: "Ethnicity" },
    GROUP_EDUCATION:   { label: "Education" },
    GROUP_CITIZENSHIP: { label: "Citizenship" },
    GROUP_EMPLOYMENT:  { label: "Employment status" },
    GROUP_COMMUTE:     { label: "Commute mode" },
    GROUP_COMMTIME:    { label: "Commute time" },
    GROUP_OCCUPANCY:   { label: "Occupancy" },
    GROUP_RENT_BURDEN: { label: "Rent burden" }
  };

  // Computed once: { GROUP_KEY: [memberCode, ...] } in VAR_META declaration order.
  var _checkboxGroups = (function () {
    var out = {};
    Object.keys(VAR_META).forEach(function (code) {
      var g = VAR_META[code].group;
      if (!g) return;
      if (!out[g]) out[g] = [];
      out[g].push(code);
    });
    return out;
  })();

  // Returns the member-code list for a group key, or [] if the group has no members.
  function getCheckboxGroupMembers(groupKey) {
    return _checkboxGroups[groupKey] ? _checkboxGroups[groupKey].slice() : [];
  }

  // Returns the entire group \u2192 members map (shallow copy).
  function getCheckboxGroups() {
    var out = {};
    Object.keys(_checkboxGroups).forEach(function (k) { out[k] = _checkboxGroups[k].slice(); });
    return out;
  }

  // Returns { type: "var", code } | { type: "group", codes } | null \u2014 the same
  // shape buffer-summary expects when computing the percent column.
  // Ratio entries (e.g. DERIVED_PPH) carry a `denominator` for the ratio math;
  // those don't get a percent column, so they return null here.
  function getDenominator(code) {
    var meta = VAR_META[code];
    if (!meta || !meta.denominator || meta.agg === "ratio") return null;
    if (meta.denominator === "$group") {
      if (!meta.group) return null;
      var members = _checkboxGroups[meta.group];
      return members && members.length ? { type: "group", codes: members.slice() } : null;
    }
    return { type: "var", code: meta.denominator };
  }

  function getMeta(code) { return VAR_META[code] || { source: "ACS", agg: "sum", fmt: "int" }; }
  function isTractOnly(code) { var m = VAR_META[code]; return !!(m && m.tractOnly); }

  function setAggUI(meta) {
    var aggMethodEl = document.getElementById("aggMethod");
    var warnEl = document.getElementById("aggWarning");

    if (!aggMethodEl || !warnEl) return;

    if (meta.source === "LODES") {
      aggMethodEl.textContent = "Sum (LODES jobs for blocks whose internal point is inside union)";
      warnEl.style.display = "block";
      warnEl.innerHTML =
        "<b>LODES method:</b> Sums LODES WAC jobs (C000) for blocks whose TIGERweb internal point " +
        "falls within the dissolved 0.5-mile buffer union. Screening-grade approach.";
      return;
    }

    if (meta.agg === "sum") {
      aggMethodEl.textContent = "Sum (area-apportioned counts)";
      warnEl.style.display = "none";
      warnEl.textContent = "";
    } else {
      aggMethodEl.textContent = "Area-weighted average (approximation)";
      warnEl.style.display = "block";
      warnEl.textContent =
        "Selected ACS variable is non-additive (e.g., median). This tool reports an area-weighted average estimate, not a true median.";
    }
  }

  function formatValue(val, meta) {
    if (!Number.isFinite(val)) return "\u2014";
    if (meta.fmt === "usd") {
      return val.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    }
    if (meta.fmt === "decimal") {
      return val.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }
    return val.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function getSelectedVars() {
    var boxes = document.querySelectorAll('#varSelect input[type="checkbox"]:checked');
    var codes = [];
    for (var i = 0; i < boxes.length; i++) {
      codes.push(boxes[i].value);
    }
    return codes;
  }

  // --- Map serialization helpers (for saving/restoring TPI/RF results) ---

  // Convert Map<k, v> → plain Object { k: v } (for JSON serialization)
  function mapToObj(map) {
    if (!map) return null;
    var obj = {};
    map.forEach(function (v, k) { obj[k] = v; });
    return obj;
  }

  // Convert plain Object { k: v } → Map<k, v>
  function objToMap(obj) {
    var m = new Map();
    if (!obj) return m;
    Object.keys(obj).forEach(function (k) { m.set(k, obj[k]); });
    return m;
  }

  // Convert Map<k, Map<k2, v>> → nested Object { k: { k2: v } }
  function nestedMapToObj(outerMap) {
    if (!outerMap) return null;
    var obj = {};
    outerMap.forEach(function (innerMap, key) { obj[key] = mapToObj(innerMap); });
    return obj;
  }

  // Convert nested Object { k: { k2: v } } → Map<k, Map<k2, v>>
  function nestedObjToMap(obj) {
    var m = new Map();
    if (!obj) return m;
    Object.keys(obj).forEach(function (k) { m.set(k, objToMap(obj[k])); });
    return m;
  }

  // --- Expose on App namespace ---

  App.setStatus = setStatus;
  App.escapeHTML = escapeHTML;
  App.escapeAttr = escapeAttr;
  App.parseCSV = parseCSV;
  App.fillSelect = fillSelect;
  App.enableSelect = enableSelect;
  App.toNumberSafe = toNumberSafe;
  App.normalizeTractGEOID = normalizeTractGEOID;
  App.guessHeader = guessHeader;
  App.VAR_META = VAR_META;
  App.GROUP_INFO = GROUP_INFO;
  App.getMeta = getMeta;
  App.isTractOnly = isTractOnly;
  App.getCheckboxGroups = getCheckboxGroups;
  App.getCheckboxGroupMembers = getCheckboxGroupMembers;
  App.getDenominator = getDenominator;
  App.setAggUI = setAggUI;
  App.formatValue = formatValue;
  App.getSelectedVars = getSelectedVars;
  App.mapToObj = mapToObj;
  App.objToMap = objToMap;
  App.nestedMapToObj = nestedMapToObj;
  App.nestedObjToMap = nestedObjToMap;

  // ---- Per-feature line style (docs/archive/feature-appearance-plan.md Phase 3) ----
  // Drawn Lines/Routes render in THREE layers over one source, one per
  // properties._lineStyle value, because MapLibre's line-dasharray cannot be a
  // data expression. The solid layer keeps the historical id. Never reference
  // "lines-layer"/"routes-layer" alone for hit-testing — use these helpers.
  var LINE_STYLES = ["solid", "dashed", "dotted"];
  var LINE_STYLE_LAYERS = {
    line:  ["lines-layer",  "lines-layer-dashed",  "lines-layer-dotted"],
    route: ["routes-layer", "routes-layer-dashed", "routes-layer-dotted"]
  };
  // Dash arrays are in line-width units. Dotted = zero-length dash + round cap.
  var LINE_STYLE_DASH = { dashed: [4, 2.5], dotted: [0, 2] };

  function normalizeLineStyle(v) {
    return (v === "dashed" || v === "dotted") ? v : "solid";
  }
  // MapLibre filter for one style layer. The solid filter catches absent,
  // "", "solid" and any unknown value, so a feature can never vanish.
  function lineStyleFilter(style) {
    if (style === "dashed" || style === "dotted") return ["==", ["get", "_lineStyle"], style];
    return ["!", ["in", ["coalesce", ["get", "_lineStyle"], ""], ["literal", ["dashed", "dotted"]]]];
  }
  function lineStyleLayerIds(type) {
    if (type === "line" || type === "route") return LINE_STYLE_LAYERS[type].slice();
    return LINE_STYLE_LAYERS.line.concat(LINE_STYLE_LAYERS.route);
  }
  // "line" | "route" | null for a MapLibre layer id.
  function lineStyleLayerType(layerId) {
    if (LINE_STYLE_LAYERS.line.indexOf(layerId) >= 0) return "line";
    if (LINE_STYLE_LAYERS.route.indexOf(layerId) >= 0) return "route";
    return null;
  }
  // Creates the three style layers for a line/route source (call once, when
  // the source is first added). paint is the solid layer's paint object.
  function addLineStyleLayers(map, type, sourceId, paint) {
    LINE_STYLE_LAYERS[type].forEach(function (id, i) {
      var style = LINE_STYLES[i];
      var p = {};
      for (var k in paint) p[k] = paint[k];
      var spec = { id: id, type: "line", source: sourceId, filter: lineStyleFilter(style), paint: p };
      if (LINE_STYLE_DASH[style]) p["line-dasharray"] = LINE_STYLE_DASH[style];
      if (style === "dotted") spec.layout = { "line-cap": "round" };
      map.addLayer(spec);
    });
  }

  // Per-feature appearance overrides (color is copied separately by callers).
  // Used by Duplicate (Decision 5): copy every override, never _mergedFrom.
  var APPEARANCE_OVERRIDE_KEYS = ["_opacity", "_fillOpacity", "_borderOpacity", "_lineWidth",
    "_offset", "_offsetManual", "_lineStyle", "_bufferRadius"];
  function copyAppearanceOverrides(srcProps, dstProps) {
    if (!srcProps || !dstProps) return dstProps;
    APPEARANCE_OVERRIDE_KEYS.forEach(function (k) {
      // An automatic overlap offset (no _offsetManual) belongs to the source's
      // position, not its look — the copy gets its own from the next recompute.
      if ((k === "_offset" || k === "_offsetManual") && !srcProps._offsetManual) return;
      if (srcProps[k] !== undefined && srcProps[k] !== null) dstProps[k] = srcProps[k];
    });
    return dstProps;
  }
  App.APPEARANCE_OVERRIDE_KEYS = APPEARANCE_OVERRIDE_KEYS;
  App.copyAppearanceOverrides = copyAppearanceOverrides;

  App.LINE_STYLES = LINE_STYLES;
  App.LINE_STYLE_LAYERS = LINE_STYLE_LAYERS;
  App.LINE_STYLE_DASH = LINE_STYLE_DASH;
  App.normalizeLineStyle = normalizeLineStyle;
  App.lineStyleFilter = lineStyleFilter;
  App.lineStyleLayerIds = lineStyleLayerIds;
  App.lineStyleLayerType = lineStyleLayerType;
  App.addLineStyleLayers = addLineStyleLayers;
})();
