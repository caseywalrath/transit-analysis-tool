// Golden cases for the pure GeoPackage filter engine (window.GpkgFilter).
// Each id names one edge case; the order follows the card's list.
// Golden arguments must be plain JSON, so every case passes plain objects,
// arrays, strings and numbers.

// Rows for distinctValues: duplicates, a null row, an empty text, a number and a boolean.
var MIXED_ROWS = [
  { f: "b" }, { f: "a" }, { f: null }, { f: "b" }, { f: 3 }, { f: "" }, null, { f: "a" }, { f: true }
];

// 205 distinct values, so the default limit of 200 is observable.
var MANY_ROWS = [];
for (var k = 0; k < 205; k++) {
  MANY_ROWS.push({ f: "v" + (k < 10 ? "00" : k < 100 ? "0" : "") + k });
}

export default {
  scripts: ["js/core/gpkg-filter.js"],
  cases: [
    // ---- normalize ------------------------------------------------------
    { id: "norm-null", call: "GpkgFilter.normalize", args: [null] },
    { id: "norm-no-conditions", call: "GpkgFilter.normalize", args: [{}] },
    { id: "norm-conditions-not-array", call: "GpkgFilter.normalize", args: [{ conditions: "x" }] },
    { id: "norm-mixed", call: "GpkgFilter.normalize", args: [{ conditions: [
      { field: "polygon_id", op: "bogus", value: "x" },
      { field: "  ", op: "eq", value: "x" },
      { field: "*", op: "eq", value: "x" },
      { field: "name", op: "eq", value: "   " },
      { field: "length", op: "gt", value: "abc" },
      { field: "polygon_id", op: "eq", value: "denver" }
    ] }] },
    { id: "norm-trim", call: "GpkgFilter.normalize", args: [{ conditions: [{ field: "a", op: "eq", value: "  x " }] }] },
    { id: "norm-in-dedupe", call: "GpkgFilter.normalize", args: [{ conditions: [{ field: "a", op: "in", value: " a, ,b , a " }] }] },
    { id: "norm-blank-value-cleared", call: "GpkgFilter.normalize", args: [{ conditions: [{ field: "a", op: "blank", value: "zzz" }] }] },
    { id: "norm-numeric-trim", call: "GpkgFilter.normalize", args: [{ conditions: [{ field: "a", op: "gte", value: " 10 " }] }] },

    // ---- textOf -----------------------------------------------------------
    { id: "text-null", call: "GpkgFilter.textOf", args: [null] },
    { id: "text-bool", call: "GpkgFilter.textOf", args: [true] },
    { id: "text-zero", call: "GpkgFilter.textOf", args: [0] },
    { id: "text-float", call: "GpkgFilter.textOf", args: [1.5] },
    { id: "text-object", call: "GpkgFilter.textOf", args: [{ a: 1 }] },

    // ---- matches ----------------------------------------------------------
    { id: "match-inactive", call: "GpkgFilter.matches", args: [{ a: 1 }, { conditions: [] }] },
    { id: "match-eq-number-text", call: "GpkgFilter.matches", args: [{ minutes: 600 }, { conditions: [{ field: "minutes", op: "eq", value: "600" }] }] },
    { id: "match-eq-case", call: "GpkgFilter.matches", args: [{ name: "Denver" }, { conditions: [{ field: "name", op: "eq", value: "denver" }] }] },
    { id: "match-ne-missing", call: "GpkgFilter.matches", args: [{}, { conditions: [{ field: "name", op: "ne", value: "x" }] }] },
    { id: "match-in", call: "GpkgFilter.matches", args: [{ name: "b" }, { conditions: [{ field: "name", op: "in", value: "a, b" }] }] },
    { id: "match-contains-case", call: "GpkgFilter.matches", args: [{ name: "denver-25ft" }, { conditions: [{ field: "name", op: "contains", value: "DEN" }] }] },
    { id: "match-any-column", call: "GpkgFilter.matches", args: [{ a: "x", b: "Denver" }, { conditions: [{ field: "*", op: "contains", value: "den" }] }, ["a", "b"]] },
    { id: "match-any-column-empty", call: "GpkgFilter.matches", args: [{ a: "Denver" }, { conditions: [{ field: "*", op: "contains", value: "den" }] }, []] },
    { id: "match-gt-number", call: "GpkgFilter.matches", args: [{ len: 6 }, { conditions: [{ field: "len", op: "gt", value: "5" }] }] },
    { id: "match-gt-text", call: "GpkgFilter.matches", args: [{ len: "6" }, { conditions: [{ field: "len", op: "gt", value: "5" }] }] },
    { id: "match-lte-equal", call: "GpkgFilter.matches", args: [{ len: 5 }, { conditions: [{ field: "len", op: "lte", value: "5" }] }] },
    { id: "match-blank-null", call: "GpkgFilter.matches", args: [{ a: null }, { conditions: [{ field: "a", op: "blank" }] }] },
    { id: "match-blank-empty", call: "GpkgFilter.matches", args: [{ a: "" }, { conditions: [{ field: "a", op: "blank" }] }] },
    { id: "match-blank-missing", call: "GpkgFilter.matches", args: [{}, { conditions: [{ field: "a", op: "blank" }] }] },
    { id: "match-notblank-zero", call: "GpkgFilter.matches", args: [{ a: 0 }, { conditions: [{ field: "a", op: "notblank" }] }] },
    { id: "match-and", call: "GpkgFilter.matches", args: [{ a: "x", b: "y" }, { conditions: [{ field: "a", op: "eq", value: "x" }, { field: "b", op: "eq", value: "z" }] }] },
    { id: "match-null-props", call: "GpkgFilter.matches", args: [null, { conditions: [{ field: "a", op: "blank" }] }] },

    // ---- toExpression -----------------------------------------------------
    { id: "expr-inactive", call: "GpkgFilter.toExpression", args: [{ conditions: [] }] },
    { id: "expr-eq", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "polygon_id", op: "eq", value: "denver-25ft-blocks_2020" }] }] },
    { id: "expr-in", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "name", op: "in", value: "a, b" }] }] },
    { id: "expr-contains", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "name", op: "contains", value: "DEN" }] }] },
    { id: "expr-any-column", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "*", op: "contains", value: "Den" }] }, ["a", "b"]] },
    { id: "expr-gt", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "minutes", op: "gt", value: "5" }] }] },
    { id: "expr-blank", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "name", op: "blank" }] }] },
    { id: "expr-any-column-empty", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "*", op: "contains", value: "x" }] }, []] },
    { id: "expr-two", call: "GpkgFilter.toExpression", args: [{ conditions: [{ field: "a", op: "eq", value: "1" }, { field: "b", op: "notblank" }] }] },

    // ---- describe ---------------------------------------------------------
    { id: "desc-eq", call: "GpkgFilter.describe", args: [{ conditions: [{ field: "polygon_id", op: "eq", value: "denver-25ft-blocks_2020" }] }] },
    { id: "desc-blank", call: "GpkgFilter.describe", args: [{ conditions: [{ field: "name", op: "blank" }] }] },
    { id: "desc-any", call: "GpkgFilter.describe", args: [{ conditions: [{ field: "*", op: "contains", value: "den" }] }] },
    { id: "desc-two", call: "GpkgFilter.describe", args: [{ conditions: [{ field: "a", op: "eq", value: "1" }, { field: "b", op: "notblank" }] }] },
    { id: "desc-inactive", call: "GpkgFilter.describe", args: [{ conditions: [] }] },

    // ---- distinctValues ---------------------------------------------------
    { id: "distinct-basic", call: "GpkgFilter.distinctValues", args: [MIXED_ROWS, "f", 200] },
    { id: "distinct-limit", call: "GpkgFilter.distinctValues", args: [MIXED_ROWS, "f", 2] },
    { id: "distinct-default-limit", call: "GpkgFilter.distinctValues", args: [MANY_ROWS, "f", 0] }
  ],
};
