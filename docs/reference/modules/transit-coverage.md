# Transit coverage

Read the code when this and the code disagree.

## transit-coverage.js

Share of a service area's population and jobs within a buffer of selected routes/lines, optionally only those meeting a peak-headway threshold.

- **Inputs:** geography/ACS year (LODES warning), buffer distance (mi, default 0.5, module-owned via `js/core/module-buffers.js`), day type (via `App.getEffectiveServiceBands`), optional headway threshold (blank = plain coverage), routes+lines checklist, drawn-polygons checklist (union = service area / denominator).
- **Rules:** builds **private** buffers via `App.buildAnalysisBuffer`/`App.foldAnalysisUnion` — never reads/mutates `App.routeBuffers`/`App.lineBuffers`. Unions are clipped to the service area with `turf.intersect` (null = zero coverage, not an error). Population `B01003_001E` is always area-apportioned (no toggle); jobs are whole-block via `App.fetchBlocksInternalPointsInUnion` ("—" + ⚠ without LODES).
- **Map:** one geojson source with `kind`-filtered layers (coverage fill, threshold fill, dashed service-area outline) + legend. Colors resolve through `App.resolveLayerColors("transit-coverage")` (categorical spec, one class per fill) at add time and in the `setData` branch; `repaintOverlay()` is registered via `App.registerLayerRepainter` (paint-only), and `fillLegendColors()` re-tints legend swatches (via `LayerPalette.rgba`) after mount and on repaint.
- **Persistence:** schema **v2**, numbers + selections only. Selections are the UNCHECKED features of both checklists as stable `{type, id}` refs (`_uncheckedRefs`), so new features default to checked and deletes/merges can't shift selection; `headwayRows` carry `featureId`. v1 index selections migrate in `restoreTcState`. Geometry is not persisted; GeoJSON export is disabled until Re-run.

`App._tcTest` → `{computePeakHeadway, formatPct, formatCount, buildStatSentence, _csvField}`. Test-only hook (exists only when `window.__MAT_TEST__`; used by `test/run-golden.mjs`).

## transit-coverage-popup.html

`#tcFeatureList`, `#tcAreaList` (each with Select all / Clear), Analyze Coverage. Results: `#tcStatus.rf-status`, `#tcResultsTable`, `#tcStatSentence`, `#tcHeadwayList`, CSV/GeoJSON export, `#tcEmptyState.rf-info-box`.

## transit-coverage-legend.html

Coverage swatch, threshold swatch, dashed service-area outline (`.tpi-legend-*`).
