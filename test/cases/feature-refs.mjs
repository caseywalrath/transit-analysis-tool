// Golden cases for the pure stable-ID reference helpers (docs/feature-merge-plan.md
// Phase 4b): App._featureRefIn / App._resolveRefIn (js/core/utils.js) and the
// legacy-solo-key upgrade App.migrateServiceKey (js/core/service-assembly.js).
// The live-array wrappers (featureRef / resolveFeatureRef / featureById) and the
// module restore paths are covered by test/feature-merge-smoke.mjs.

const R = (...ids) => ids.map((id) => ({ properties: id === undefined ? {} : { routeIdx: id } }));
const L = (...ids) => ids.map((id) => ({ properties: { lineIdx: id } }));

// Routes were drawn 1..4 and the first two deleted -> IDs 3,4 at indices 0,1.
const after = { route: R(3, 4, 9), line: L(2, 5) };

export default {
  scripts: ["js/core/utils.js", "js/core/service-assembly.js"],
  cases: [
    { id: "ref/route-by-index", call: "App._featureRefIn", args: [after, "route", 1] },
    { id: "ref/line-by-index", call: "App._featureRefIn", args: [after, "line", 0] },
    { id: "ref/index-out-of-range", call: "App._featureRefIn", args: [after, "route", 7] },
    { id: "ref/negative-index", call: "App._featureRefIn", args: [after, "route", -1] },
    { id: "ref/unknown-type", call: "App._featureRefIn", args: [after, "label", 0] },
    { id: "ref/absent-type-array", call: "App._featureRefIn", args: [after, "polygon", 0] },
    { id: "ref/feature-without-id", call: "App._featureRefIn", args: [{ route: R(undefined) }, "route", 0] },
    { id: "ref/null-arrays", call: "App._featureRefIn", args: [null, "route", 0] },

    { id: "resolve/finds-current-index", call: "App._resolveRefIn", args: [after, { type: "route", id: 9 }] },
    { id: "resolve/id-not-index", call: "App._resolveRefIn", args: [after, { type: "route", id: 1 }] },
    { id: "resolve/deleted-id", call: "App._resolveRefIn", args: [after, { type: "route", id: 2 }] },
    { id: "resolve/type-mismatch-not-found", call: "App._resolveRefIn", args: [after, { type: "line", id: 3 }] },
    { id: "resolve/line", call: "App._resolveRefIn", args: [after, { type: "line", id: 5 }] },
    { id: "resolve/unknown-type", call: "App._resolveRefIn", args: [after, { type: "label", id: 1 }] },
    { id: "resolve/null-ref", call: "App._resolveRefIn", args: [after, null] },
    { id: "resolve/non-numeric-id", call: "App._resolveRefIn", args: [after, { type: "route", id: "3" }] },
    { id: "resolve/null-arrays", call: "App._resolveRefIn", args: [null, { type: "route", id: 3 }] },
    { id: "resolve/duplicate-id-first-wins", call: "App._resolveRefIn", args: [{ route: R(4, 4) }, { type: "route", id: 4 }] },

    { id: "svckey/legacy-route-upgraded", call: "App.migrateServiceKey", args: ["solo-route-1", after] },
    { id: "svckey/legacy-line-upgraded", call: "App.migrateServiceKey", args: ["solo-line-1", after] },
    { id: "svckey/legacy-index-out-of-range", call: "App.migrateServiceKey", args: ["solo-route-8", after] },
    { id: "svckey/new-format-passes-through", call: "App.migrateServiceKey", args: ["solo-route-id3", after] },
    { id: "svckey/paired-passes-through", call: "App.migrateServiceKey", args: ["service-Route 5", after] },
    { id: "svckey/non-string", call: "App.migrateServiceKey", args: [null, after] },
    { id: "svckey/legacy-target-without-id", call: "App.migrateServiceKey", args: ["solo-route-0", { route: R(undefined) }] },

    { id: "key/format", call: "App.featureRefKey", args: [{ type: "route", id: 9 }] },
    { id: "key/bad-ref", call: "App.featureRefKey", args: [{ type: "label", id: 9 }] },
    { id: "key/null", call: "App.featureRefKey", args: [null] },
    { id: "parse/route", call: "App.parseFeatureRefKey", args: ["route:12"] },
    { id: "parse/all", call: "App.parseFeatureRefKey", args: ["all"] },
    { id: "parse/empty", call: "App.parseFeatureRefKey", args: [""] },
    { id: "parse/unknown-type", call: "App.parseFeatureRefKey", args: ["label:2"] },
    { id: "parse/zero-id-invalid", call: "App.parseFeatureRefKey", args: ["route:0"] },
    { id: "idxkey/upgraded", call: "App._migrateIndexRefKeyIn", args: [after, "route:1"] },
    { id: "idxkey/line-upgraded", call: "App._migrateIndexRefKeyIn", args: [after, "line:0"] },
    { id: "idxkey/out-of-range", call: "App._migrateIndexRefKeyIn", args: [after, "route:7"] },
    { id: "idxkey/all", call: "App._migrateIndexRefKeyIn", args: [after, "all"] },
    {
      id: "idxfilter/mixed",
      call: "App._indexFilterToRefsIn",
      args: [after, { routeIndices: [0, 2, 8], lineIndices: [1], pointIndices: [0] }],
    },
    {
      id: "unchecked/from-checked-filter",
      call: "App._uncheckedRefsFromIndexFilterIn",
      args: [after, { routeIndices: [1], lineIndices: [0, 1] }, ["route", "line"]],
    },
    { id: "unchecked/null-filter-all-unchecked", call: "App._uncheckedRefsFromIndexFilterIn", args: [after, null, ["line"]] },
    { id: "idxfilter/null", call: "App._indexFilterToRefsIn", args: [after, null] },
  ],
};
