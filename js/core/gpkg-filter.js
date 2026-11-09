// js/core/gpkg-filter.js
// Filter engine for GeoPackage layers (window.GpkgFilter): checks a filter,
// tests one attribute row against it, builds the matching MapLibre expression,
// and lists distinct values for the filter controls.
// CONSTRAINT: plain-value logic only — no DOM, map or App state — so the golden
// harness can load it into a bare node:vm sandbox (test/cases/gpkg-filter.mjs).
// textOf() mirrors MapLibre's to-string, so the map expression and the JS
// matcher pick the same rows and the attribute table shows the same rows as the map.

(function () {
  "use strict";

  // Operator table in the order the filter controls list them. Only the two
  // blank tests take no value; only the four comparisons compare numbers.
  var OPS = [
    { id: "eq", label: "is", needsValue: true, numeric: false },
    { id: "ne", label: "is not", needsValue: true, numeric: false },
    { id: "in", label: "is one of", needsValue: true, numeric: false },
    { id: "contains", label: "contains", needsValue: true, numeric: false },
    { id: "gt", label: "is greater than", needsValue: true, numeric: true },
    { id: "gte", label: "is at least", needsValue: true, numeric: true },
    { id: "lt", label: "is less than", needsValue: true, numeric: true },
    { id: "lte", label: "is at most", needsValue: true, numeric: true },
    { id: "blank", label: "is blank", needsValue: false, numeric: false },
    { id: "notblank", label: "is not blank", needsValue: false, numeric: false }
  ];

  // Field name meaning "any column". Only valid with "contains", because it is
  // the attribute table's search applied across every column.
  var ANY_FIELD = "*";

  var NUMERIC_MAP_OP = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

  function opById(id) {
    for (var i = 0; i < OPS.length; i++) {
      if (OPS[i].id === id) return OPS[i];
    }
    return null;
  }

  // Text form of a cell value. A number prints with String(v) and no rounding,
  // so the number 600 matches an "is 600" test just as the text "600" does.
  // Objects are JSON text.
  function textOf(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  }

  // Own properties only. props[field] would also return Object.prototype members
  // for a column named "constructor", which MapLibre's ["get", ...] never does.
  function cell(props, field) {
    return props && Object.prototype.hasOwnProperty.call(props, field) ? props[field] : undefined;
  }

  // Items of an "is one of" value: split on commas, trimmed, empties dropped.
  function splitItems(text) {
    var out = [];
    var parts = String(text).split(",");
    for (var i = 0; i < parts.length; i++) {
      var item = parts[i].trim();
      if (item !== "") out.push(item);
    }
    return out;
  }

  function dedupe(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (out.indexOf(items[i]) < 0) out.push(items[i]);
    }
    return out;
  }

  // Returns the cleaned condition as a new object, or null when it is invalid.
  // Invalid conditions are dropped rather than rejected, so one bad row in a
  // saved filter does not switch off the others.
  function normalizeCondition(c) {
    if (!c || typeof c !== "object") return null;
    if (typeof c.field !== "string" || c.field.trim() === "") return null;
    var op = opById(c.op);
    if (!op) return null;
    if (c.field === ANY_FIELD && op.id !== "contains") return null;

    var value = c.value === null || c.value === undefined ? "" : String(c.value).trim();
    if (op.needsValue && value === "") return null;
    if (op.numeric && !isFinite(Number(value))) return null;
    if (op.id === "in") {
      var items = dedupe(splitItems(value));
      if (items.length === 0) return null;
      value = items.join(", ");
    }
    if (!op.needsValue) value = "";
    // The field keeps its original spacing: column names may contain spaces.
    return { field: c.field, op: op.id, value: value };
  }

  // Returns { conditions: [...] } with only the valid conditions, or null when
  // none survive. Never throws, so a damaged saved filter reads as "no filter".
  function normalize(f) {
    if (!f || typeof f !== "object" || !Array.isArray(f.conditions)) return null;
    var kept = [];
    for (var i = 0; i < f.conditions.length; i++) {
      var c = normalizeCondition(f.conditions[i]);
      if (c) kept.push(c);
    }
    return kept.length > 0 ? { conditions: kept } : null;
  }

  function isActive(f) {
    return normalize(f) !== null;
  }

  // Compares a row's real number against the filter value. Text that only looks
  // like a number does not match, because the map expression applies the same rule.
  function compareNumber(op, raw, n) {
    if (op === "gt") return raw > n;
    if (op === "gte") return raw >= n;
    if (op === "lt") return raw < n;
    return raw <= n;
  }

  function conditionMatches(props, c, columns) {
    if (c.field === ANY_FIELD) {
      var needle = c.value.toLowerCase();
      for (var j = 0; j < columns.length; j++) {
        if (textOf(cell(props, columns[j])).toLowerCase().indexOf(needle) >= 0) return true;
      }
      return false;
    }
    var raw = cell(props, c.field);
    var t = textOf(raw);
    switch (c.op) {
      case "eq": return t === c.value;
      case "ne": return t !== c.value;
      case "in": return splitItems(c.value).indexOf(t) >= 0;
      case "contains": return t.toLowerCase().indexOf(c.value.toLowerCase()) >= 0;
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        if (typeof raw !== "number" || !isFinite(raw)) return false;
        return compareNumber(c.op, raw, Number(c.value));
      case "blank": return t === "";
      case "notblank": return t !== "";
      default: return false;
    }
  }

  // props may be null; columns may be missing. An inactive filter matches everything.
  function matches(props, f, columns) {
    var n = normalize(f);
    if (!n) return true;
    var cols = columns || [];
    for (var i = 0; i < n.conditions.length; i++) {
      if (!conditionMatches(props, n.conditions[i], cols)) return false;
    }
    return true;
  }

  // Each call builds its own arrays, so editing one part of a returned
  // expression cannot change another part that happens to be the same object.
  function textExpr(field) {
    return ["to-string", ["get", field]];
  }

  function anyColumnExpr(needle, columns) {
    var any = ["any"];
    for (var i = 0; i < columns.length; i++) {
      any.push(["in", needle, ["downcase", ["to-string", ["get", columns[i]]]]]);
    }
    return any;
  }

  // typeof guard: without it, to-number would turn numeric text into a number,
  // which the JS matcher does not do.
  function numericExpr(mapOp, field, n) {
    return ["case",
      ["==", ["typeof", ["get", field]], "number"],
      [mapOp, ["to-number", ["get", field]], n],
      false];
  }

  function conditionExpression(c, columns) {
    if (c.field === ANY_FIELD) {
      if (columns.length === 0) return false;
      return anyColumnExpr(c.value.toLowerCase(), columns);
    }
    switch (c.op) {
      case "eq": return ["==", textExpr(c.field), c.value];
      case "ne": return ["!=", textExpr(c.field), c.value];
      case "in": return ["in", textExpr(c.field), ["literal", splitItems(c.value)]];
      case "contains": return ["in", c.value.toLowerCase(), ["downcase", textExpr(c.field)]];
      case "gt":
      case "gte":
      case "lt":
      case "lte": return numericExpr(NUMERIC_MAP_OP[c.op], c.field, Number(c.value));
      case "blank": return ["==", textExpr(c.field), ""];
      case "notblank": return ["!=", textExpr(c.field), ""];
      default: return false;
    }
  }

  // Always ["all", ...], even for one condition, so callers can append to it.
  function toExpression(f, columns) {
    var n = normalize(f);
    if (!n) return null;
    var cols = columns || [];
    var out = ["all"];
    for (var i = 0; i < n.conditions.length; i++) {
      out.push(conditionExpression(n.conditions[i], cols));
    }
    return out;
  }

  // Human-readable summary for badges and titles, e.g. "polygon_id is denver-25ft".
  function describe(f) {
    var n = normalize(f);
    if (!n) return null;
    var parts = [];
    for (var i = 0; i < n.conditions.length; i++) {
      var c = n.conditions[i];
      var label = opById(c.op).label;
      var text = (c.field === ANY_FIELD ? "any column" : c.field) + " " + label;
      if (opById(c.op).needsValue) text += " " + c.value;
      parts.push(text);
    }
    return parts.join(" and ");
  }

  // Sorted unique non-empty text values of one column, for the value picker.
  // A null row counts as an empty row. limit defaults to 200 when it is not a
  // positive number, so the picker stays usable on a column with many values.
  function distinctValues(rows, field, limit) {
    var max = typeof limit === "number" && limit > 0 ? limit : 200;
    // Object.create(null) so a value such as "constructor" is an ordinary key.
    var seen = Object.create(null);
    var unique = [];
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var v = textOf(cell(list[i], field));
      if (v === "" || seen[v]) continue;
      seen[v] = true;
      unique.push(v);
    }
    unique.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    return { values: unique.slice(0, max), more: unique.length > max };
  }

  window.GpkgFilter = {
    OPS: OPS,
    textOf: textOf,
    normalize: normalize,
    isActive: isActive,
    matches: matches,
    toExpression: toExpression,
    describe: describe,
    distinctValues: distinctValues
  };

})();
