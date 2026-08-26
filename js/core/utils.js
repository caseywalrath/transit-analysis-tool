// js/core/utils.js
// Shared utility functions, variable metadata, and helpers.
// No dependencies beyond PapaParse (loaded via CDN).
// Exports: setStatus, escapeHTML, escapeAttr, parseCSV, fillSelect,
//          enableSelect, toNumberSafe, normalizeTractGEOID, guessHeader,
//          VAR_META, GROUP_INFO, getMeta, getCheckboxGroups,
//          getCheckboxGroupMembers, getDenominator, setAggUI, formatValue

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
})();
