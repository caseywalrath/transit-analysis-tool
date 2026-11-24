# Card A6a-fix (Sonnet): review fixes in Transit Coverage and Feature Area Analysis

Files you may change: `js/projects/transit-coverage.js`, `js/projects/buffer-summary.js`,
`js/core/module-buffers.js`, `css/style.css` (only `.bas-feature-group-label`),
`test/browser/transit-coverage-gtfs.test.mjs` (ADD checks only), `docs/reference/modules/transit-coverage.md`,
`docs/reference/modules/feature-area-analysis.md`.

Read first: `CLAUDE.md`, `docs/a6-cards/rules.md`, `docs/A6-plan.md`, the files above.

Fixes:
1. `unionMany` (transit-coverage.js, about line 667): when `turf.union(a[i], a[i+1])` throws, keep BOTH
   inputs (push both into the next round, or fold a[i+1] into a[i] with a per-polygon fallback), never drop one.
2. Move the pairwise yielding `unionMany` into `js/core/module-buffers.js` as `App.unionManyPolygons(list, opts)`
   (same behaviour, same yielding), make Transit Coverage call it, and make Feature Area Analysis's GTFS stop
   selection buffer (buffer-summary.js about line 500, currently `App.buildStopCircleUnion`) use it so thousands of
   stops do not freeze the page. Document the new function in `docs/reference/` where module-buffers is documented.
3. Run snapshot (about line 1036): take `makeRunSnap` and read the GTFS analysis date ONCE before the first
   `await` of the run; reuse that date for the results label (about line 1117).
4. Restored session (about line 1824): after restore, compare GTFS inputs against the saved `gtfsDate` once the
   feed is loaded, so a changed analysis date, hidden routes or unloaded feed marks GTFS-based results stale.
5. Stale signature (about line 92/109): include `App.roadNetworkEpoch()` only for runs that measured along
   streets, and `gtfsSig()` only for runs that used GTFS routes; don't let a restored streets run go stale merely
   because the cached network finished loading.
6. `unionAround` (about line 698): when streets was requested but no street polygon was used, count those stops
   as off-network so the straight-line note shows.
7. `.bas-feature-group-label`: replace `margin: 8px 0 2px` with `--space-*` tokens.

Done when:
- `node test/run-golden.mjs` → PASS.
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/transit-coverage-gtfs.test.mjs` → PASS (add checks
  for fix 1 via a forced-throw stub, fix 3 or 5 where practical).
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/faa-gtfs-stops.test.mjs` → PASS.
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/hidden-features.test.mjs` → PASS.
