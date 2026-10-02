// Golden cases for the pure feature-ID assigner (js/core/utils.js,
// App._assignFeatureIds — docs/feature-merge-plan.md Phase 1). It mutates the
// feature objects it is given, so each case's golden value records both the
// change list and the resulting IDs (`ids`) — pass features as plain
// `{properties:{...}}` stubs. nextFeatureId/ensureFeatureIds touch live App
// arrays and counters, so they are covered by test/feature-merge-smoke.mjs.
//
// The harness calls `App._assignFeatureIds(arraysByType)`, which returns
// { changes, maxByType }; ids after the call are covered by the change list
// plus maxByType (untouched features keep their IDs by construction).

const R = (...ids) => ids.map((id) => ({ properties: id === undefined ? {} : { routeIdx: id } }));

export default {
  scripts: ["js/core/utils.js"],
  cases: [
    { id: "assign/already-unique-no-changes", call: "App._assignFeatureIds", args: [{ route: R(1, 2, 3) }] },
    { id: "assign/unique-but-gappy-no-changes", call: "App._assignFeatureIds", args: [{ route: R(2, 7, 4) }] },
    { id: "assign/missing-ids", call: "App._assignFeatureIds", args: [{ route: R(undefined, 1, undefined) }] },
    { id: "assign/duplicate-first-keeps-id", call: "App._assignFeatureIds", args: [{ route: R(1, 1, 1) }] },
    { id: "assign/duplicate-after-higher-id", call: "App._assignFeatureIds", args: [{ route: R(3, 3, 9, 3) }] },
    { id: "assign/non-numeric-and-invalid", call: "App._assignFeatureIds",
      args: [{ route: [{ properties: { routeIdx: "2" } }, { properties: { routeIdx: 0 } }, { properties: { routeIdx: -4 } },
                      { properties: { routeIdx: 1.5 } }, { properties: { routeIdx: null } }, { properties: { routeIdx: 2 } }] }] },
    { id: "assign/empty-and-absent-types", call: "App._assignFeatureIds", args: [{ route: [] }] },
    { id: "assign/null-input", call: "App._assignFeatureIds", args: [null] },
    { id: "assign/mixed-types", call: "App._assignFeatureIds",
      args: [{
        point:   [{ properties: { pointIdx: 1 } }, { properties: { pointIdx: 1 } }],
        line:    [{ properties: {} }, { properties: { lineIdx: 2 } }],
        route:   R(5, 6),
        polygon: [{ properties: { polyIdx: 4 } }, { properties: { polyIdx: 4 } }, { properties: { polyIdx: "a" } }]
      }] },
  ],
};
