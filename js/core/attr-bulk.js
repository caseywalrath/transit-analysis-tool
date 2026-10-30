// js/core/attr-bulk.js
// window.AttrBulk — which attribute fields a multi-selection shares and whether
// each one's value is the same across it. Pure: no App, DOM or map, so the
// golden harness loads it alone (test/cases/attr-bulk.mjs). The attributes dock
// (feature-attributes.js) renders the result and does the writing.
// Detail: docs/reference/drawing-and-features.md, docs/archive/attributes-dock-plan.md §5.
//
// Rules (one set covers every type combination):
//   R1 a field is shared when every selected feature's type has a field with
//      that key, it is not `hidden`, and not `bulk: false` (identity fields)
//   R2 values are compared with unset treated as the field's defaultValue (or
//      empty); all equal → "same", otherwise → "mixed"
//   R5 `skipIf: { attr, equals }` excludes a feature from a field (e.g. buffer
//      radius on walkshed points); only eligible features are compared/written
//   R6 `bulk: "replace"` (complex editors) is passed through for the UI, which
//      seeds a Mixed editor from the first eligible feature

(function () {
  var AttrBulk = window.AttrBulk = {};

  function isBlank(v) {
    return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  }

  // A field's value on a feature: buffer radius lives on properties, every
  // other field on properties.attributes.
  function readValue(field, feature) {
    var p = (feature && feature.properties) || {};
    var v = field.type === "buffer-radius" ? p._bufferRadius : (p.attributes || {})[field.key];
    if (isBlank(v)) return field.defaultValue !== undefined ? field.defaultValue : null;
    return v;
  }
  AttrBulk.readValue = readValue;

  function sameValue(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      // "15" typed vs 15 stored are the same number.
      return a !== null && b !== null && typeof a !== "object" && typeof b !== "object" && String(a) === String(b);
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function eligible(field, feature) {
    var s = field.skipIf;
    if (!s) return true;
    var attrs = (feature && feature.properties && feature.properties.attributes) || {};
    return attrs[s.attr] !== s.equals;
  }
  AttrBulk.eligible = eligible;

  // fieldsByType: { type: [field, …] } (ATTR_FIELDS plus any pseudo-fields).
  // items: [{ type, feature }]. Returns, in the first item's field order:
  //   [{ key, label, type, section, bulk, state: "same"|"mixed"|"none",
  //      value, eligible, total }]
  // state "none" = no selected feature is eligible (row shown disabled).
  AttrBulk.analyze = function (fieldsByType, items) {
    var out = [];
    if (!items || !items.length) return out;
    var first = fieldsByType[items[0].type] || [];
    first.forEach(function (field) {
      if (field.hidden || field.bulk === false) return;
      var perItem = [];
      for (var i = 0; i < items.length; i++) {
        var list = fieldsByType[items[i].type] || [];
        var match = null;
        for (var j = 0; j < list.length; j++) if (list[j].key === field.key) { match = list[j]; break; }
        if (!match || match.hidden || match.bulk === false) return;
        perItem.push(match);
      }
      var values = [];
      items.forEach(function (it, i) {
        if (eligible(perItem[i], it.feature)) values.push(readValue(perItem[i], it.feature));
      });
      var state = "none", value = null;
      if (values.length) {
        state = "same";
        value = values[0];
        for (var k = 1; k < values.length; k++) {
          if (!sameValue(values[0], values[k])) { state = "mixed"; value = null; break; }
        }
      }
      out.push({
        key: field.key, label: field.label, type: field.type || "text",
        section: field.section || null, bulk: field.bulk || null,
        state: state, value: value, eligible: values.length, total: items.length
      });
    });
    return out;
  };

  // "3 Routes · 2 Lines" source: [{ type, count }] in first-seen order.
  AttrBulk.typeCounts = function (items) {
    var order = [], counts = {};
    (items || []).forEach(function (it) {
      if (!counts[it.type]) { counts[it.type] = 0; order.push(it.type); }
      counts[it.type]++;
    });
    return order.map(function (t) { return { type: t, count: counts[t] }; });
  };
})();
