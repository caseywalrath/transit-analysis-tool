# Core app

Reference for the core shell files. Read the code when this and the code disagree.

## Shell and styles

- **`index.html`** — app shell: grouped toolbar, map, Features/Layers panel, floating module-panel container, dormant hidden sidebar markup, script tags.
- **`css/style.css`** — core layout plus module styles (`.bas-`, `.tpi-`, `.rf-`, `.fta-`, `.tvi-` prefixes), pill rating colors.
- **`css/sidebar-v2.css`**, **`js/core/sidebar.js`** — dormant legacy sidebar. `#sidebar-wrap` ships hidden; `App.sidebar.render()` is never called. API kept for compatibility: `sidebar.addPanel({id, title, html, collapsed=false, order=100})`, `sidebar.removePanel(id)`, `sidebar.toggle(id)`, `sidebar.render()`.
- **`projects/choropleth-legend.html`** — generic legend fragment for `App.choropleth`: `.cl-legend-title`, 5 `.cl-legend-row` rows (`.cl-legend-swatch` + `.cl-legend-label`), `.cl-legend-note`. Filled after mount by `App.choropleth.fillLegend` (same fill-after-mount pattern as `transit-travelshed-legend.html`). First consumer: Feature Area Analysis (widget id `"bas-legend"`).

## config.js

`App.CARTO_API_KEY`, `App.CENSUS_API_KEY`, plus a per-browser CARTO override in `localStorage` (`mat-carto-key`). Loads FIRST, before utils.js. **Everything here is public** (static site, public repo, GitHub Pages) — only public, rate-limited, read-only credentials. See `docs/carto-api-key-plan.md`.

## utils.js

Exports: `setStatus(s)`, `parseCSV(text)`, `fillSelect(el, opts, placeholder)`, `enableSelect(el, bool)`, `toNumberSafe(v)`, `normalizeTractGEOID(raw)`, `guessHeader(headers, candidates)`, `VAR_META`, `GROUP_INFO`, `getMeta(code)`, `getCheckboxGroups()`, `getCheckboxGroupMembers(groupKey)`, `getDenominator(code)`, `setAggUI(meta)`, `formatValue(val, meta)`, `getSelectedVars()`, `mapToObj`/`objToMap`/`nestedMapToObj`/`nestedObjToMap`, `FEATURE_COLORS`, `POLYGON_DEFAULT_COLOR`, `sectionColors`, `resolveFeatureColor(featureType, feature)`, `_nextColorSeq()`, `_advanceColorSeqPast(n)`, line-style helpers `LINE_STYLES` / `LINE_STYLE_LAYERS` (`{line: [3 ids], route: [3 ids]}`) / `LINE_STYLE_DASH` / `normalizeLineStyle(v)` / `lineStyleFilter(style)` / `lineStyleLayerIds(type?)` / `lineStyleLayerType(layerId)` / `addLineStyleLayers(map, type, sourceId, paint)`, and `APPEARANCE_OVERRIDE_KEYS` / `copyAppearanceOverrides(srcProps, dstProps)` (used by every `duplicateX`; `_offset`/`_offsetManual` copied only when the offset is manual — an automatic overlap offset is recomputed).

**`VAR_META`** — single source of truth for variable metadata. Fields: `source` ("ACS"|"LODES"), `agg` ("sum"|"avg"|"ratio"), `fmt`, `label`, `category`, optional `codes` (multi-code sums), `tractOnly`, `numerator`/`denominator`/`ratioLabel` (ratio only). Checkbox fields: `displayInChecklist: true`, `group: "GROUP_X"`, `denominator: "<code>"|"$group"`. `GROUP_INFO` = group labels. `getCheckboxGroups()` → `{groupKey: [codes]}`. `getDenominator(code)` → `{type:"var", code}` | `{type:"group", codes}` | `null` (null for ratio aggs).

**Stable feature IDs** (see `docs/feature-merge-plan.md`). Each drawn feature has a unique integer ID per type in `properties.pointIdx`/`lineIdx`/`routeIdx`/`polyIdx` (`App.FEATURE_ID_PROP` maps type → property). Used to map a clicked map feature to its array index (`editing.js`) and to link stops to routes (`attributes.associatedRoutes[].featureId`).
- **Always get a new ID from `App.nextFeatureId(type)`** (monotonic counter) — never reuse or derive from `array.length + 1`. Any code that pushes straight into `App.points/lines/routes/polygons` must stamp one. Display names ("Route 3") are independent of IDs.
- `App._assignFeatureIds(arraysByType)` — pure repair pass (golden: `test/cases/feature-ids.mjs`): re-stamps missing, non-positive-integer, or duplicate IDs (the older feature keeps it) → `{changes: [{type, index, oldId, newId}], maxByType}`. `App.ensureFeatureIds()` runs it on the live arrays and advances counters; idempotent, called by `cache.js applyState()`. A stop link to a duplicated ID keeps the older feature.
- Counters persist as the additive `featureIdCounters` session field (`App.getFeatureIdCounters()` / `App.advanceFeatureIdCounters(stored)`, which only raises) so a deleted feature's ID is not reissued after reload.

**Module references by stable ID.** Indices shift on every delete/merge, so modules must never remember a feature by index. Store `App.featureRef(type, index)` → `{type, id}` | `null`; resolve at USE time with `App.resolveFeatureRef(ref)` → index | `-1` or `App.featureById(type, id)` → feature | `null`; **never cache the resolved index**. `-1`/`null` = deleted/merged: show as missing and skip/refuse, never fall back to another feature. Pure cores `App._featureRefIn(arraysByType, type, index)` / `App._resolveRefIn(arraysByType, ref)` (golden: `test/cases/feature-refs.mjs`). Key helpers: `featureRefKey` / `parseFeatureRefKey` (`"type:<id>"`).
- **Legacy-session migration:** `cache.applyState` pushes features in saved order (and runs `ensureFeatureIds`) BEFORE any module `apply()`, so a legacy saved index is still valid inside `apply()` — convert to ID refs there, idempotently, and turn an unresolvable index into a missing ref rather than guessing. Helpers: `App.migrateIndexRefKey(str)`, `App.indexFilterToRefs(filter)`, `App.uncheckedRefsFromIndexFilter(filter, types)` (pure `_…In` variants exported too). Run-time index arrays rebuilt from checkboxes may stay as indices.
- Browser smoke test: `test/feature-merge-smoke.mjs`.

**Feature usage hook** (lives in utils.js so every module can register at load time; see `docs/feature-split-plan.md`): `App.registerFeatureUsage(fn, {module, severity})` — `fn(type, id)` returns labels (strings or `{label, severity}`); `App.describeFeatureUsage(type, id)` → `[{module, label, severity: "warn"|"info"}]`, each provider try/catch-wrapped. Providers read closure state only (safe before the popup opens). Registered by Title VI (warn), Ridership Forecasting (warn for calibration CSV matches; info for selected corridor), Corridor Scoring, Transit Propensity, Route Costing (via `App.buildTransitServices`), Trip Builder (info). Shown by the Split and Merge dialogs; any new module that remembers features should register one.

**Feature color cascade** (see `docs/feature-color-system-plan.md`, `docs/feature-color-sync-plan.md`). `resolveFeatureColor(type, feature)` returns, in order: (1) non-empty `properties.color` (per-feature override; `""`/absent = inherit); (2) non-empty `App.sectionColors[type]` (type default from the Layers tab); (3) Automatic (`null`): lines/routes use `FEATURE_COLORS[properties.colorSeq % length]`, points/polygons/labels a fixed built-in color.
- `colorSeq` is stamped once at creation (`_nextColorSeq()`) so a palette slot survives deletions elsewhere; `_advanceColorSeqPast(n)` runs on restore so new features don't collide. A feature without `colorSeq` falls back to its array position.
- `App.sectionColors` (`{point, line, route, polygon, label}`) is persisted by `cache.js`.
- **Last action wins:** type-wide color changes go through `App.setTypeColor(type, color|null)` (features.js) — one undo snapshot, sets `sectionColors[type]`, **clears every feature's `properties.color` of that type** (`App.clearFeatureColorOverrides`), refreshes panels. A later `App.updateFeatureColor` wins for that feature.
- **Every swatch/icon for a specific feature must use `App.resolveFeatureColor(type, feature)`**, never `properties.color || getTypeDefaultColor(type)` (ignores the rainbow slot). `getTypeDefaultColor` (features.js) is only for contexts with no specific feature. Test: `test/feature-color-smoke.mjs`.

## map.js

`App.map`, `switchBasemap(id)`, `getBasemaps()` → `[{id, name}]`, `getCurrentBasemapId()`, `getThemeBasemapId(isDark)`. Basemap ids: `carto-light` (default), `carto-dark`, `carto-voyager`, `osm`, `satellite`, `esri-dark-gray`, `esri-light-gray`.

- **CARTO key:** `App.CARTO_API_KEY` is appended as `?key=` to every `basemaps.cartocdn.com` URL once at init. The initial style and `switchBasemap()` are **separate code paths** both reading the registry, so applying the key in only one place breaks the default basemap on load. With no key the three CARTO entries are removed from `BASEMAPS` and the default becomes `esri-light-gray` — a supported state, not an error.
- **Dark-mode callers must use `getThemeBasemapId(isDark)`**, never hardcoded `carto-light`/`carto-dark`: those ids don't exist keyless, and `switchBasemap` silently ignores unknown ids.
- CARTO/OSM attribution must stay visible on CARTO basemaps (license condition).

## selection.js

`App.setSelection(list)` — replaces the selection with a de-duplicated `[{type, index}]`; same refresh as `selectFeature`; one item = `selectFeature`, empty = `clearSelection()`. Also: `selectFeature`, `toggleMultiSelect`, `shiftSelectFeature`, `clearSelection`, `isFeatureSelected`, `getSelectedFeatures`.

## census.js

`renderCensusOverlay(geos)`, `clearCensusOverlay()` (empties the `census-geos` source via `setData`, keeping layers for reuse), `fetchAllTigerwebFeatures(layerUrl, params)`, `fetchTigerwebGeos(geoLevel, unionFeat)`, `parseGEOID(geoLevel, geoid)`, `fetchACSValues(geoLevel, year, varCode, geoids)`, `fetchACSCountyValues(year, varCode, counties)`, `aggregateWithinUnion(unionFeat, geos, valueMap, aggMode, options)` (optional `options.fractions` = precomputed map), `computeGeoOverlapFractions(unionFeat, geos, apportionByArea)` → `Map<GEOID, frac>` (compute once per run, reuse), `computeAcsValueOnly(varCode, year, geoLevel)`.

## lodes.js

`STATE_FIPS_TO_ABBR`, `getStateFromMapCenter()`, `startDownload(url, filename)`, `lodesData` (Map or null), `lodesFileName`, `setLodesLoadedUI(loaded, name, nRows)`, `parseLodesFromUploadedFile(file)`, `fetchBlocksInternalPointsInUnion(unionFeat)`, `computeEmploymentServedOnly()`.

## cache.js

`App.cache.save()` (debounced 500 ms, call after every mutation), `restore()` (runs at end of map load), `reset()`, `exportToFile()`, `importFromFile(file)`, `registerModule(id, handlers)`, `STORAGE_KEY` (`"mat-session"`).

- Saves points/lines/routes/polygons (routes keep geometry + waypoints, no re-routing), buffer radii, form selections, LODES filename only (data too large).
- `applyState()` is the single funnel for restore, file/shapefile/CSV/GeoJSON import and undo/redo; it calls `App.ensureFeatureIds()` right after pushing features.
- **Schema `version: 4`** (localStorage and file). v1 (`stations`) → v2 (`points`) → v3 → v4. **v3→v4** (one-time, only when `version === 3`): a line/route whose `color` equals its array-position palette color is cleared to `""` and stamped with the equivalent `colorSeq`; a polygon matching the built-in default is cleared. Non-matching colors are kept as deliberate overrides.
- Additive fields (no schema bump, default gracefully when absent): `featureIdCounters`, `networkSnapToleranceFt`, `networkCrossingMajorSec`/`networkCrossingMinorSec` (→ `App.networkSettings.crossingMajorSec`/`crossingMinorSec`), `networkExcludedWayIds`, `layerStyles`/`mapPalette`.
  - `networkExcludedWayIds` restores via `App.setExcludedWays(...)` — the sanctioned write path — **not** by poking `App.networkSettings.excludedWayIds`, so road-network.js's private `_excludedWays` Set stays in sync.
  - `layerStyles`/`mapPalette` are deep-copied onto `App.layerStyles`/`App.mapPalette`; `restore()` then calls `App.repaintStyledLayers()` once at the end (typeof-guarded — cache.js loads before modules register repainters).
- **Merge history:** `properties._mergedFrom` is kept by every state path (autosave, undo/redo, session JSON) and **omitted from every feature export**: JSON (Features only) strips it via `App.mergeHistory.stripHistory`; CSV/KML/Shapefile write fixed columns. Any new feature-export path must strip it. Render functions copying `properties` into MapLibre sources skip `_mergedFrom`; `duplicateX` never copies it.
- `registerModule(id, { collect(mode), apply(data) })` — `mode` is `"light"` (localStorage, skip heavy geometry) or `"full"` (file export). Stored under `state.moduleState[moduleId]`. Example: Ridership Forecasting registers as `"rf"`, schema v4 (stable-ID feature refs; v1–v3 index refs converted in `restoreRfState`).

## popup.js

`App.popup.open(moduleId, modules, buildCore)`, `close()`, `isOpen()`, `currentModuleId()`, `showFloatingWidget(id, htmlFile, {position: "bottom-left"|"bottom-right"|"top-left"|"top-right", width, title})`, `hideFloatingWidget(id)`, `removeFloatingWidget(id)`, `wire(modules, buildCore)`. Panels can be dragged but the top edge can't leave the viewport; on release, overflow is corrected to keep 120 px horizontally / 32 px vertically of the title bar reachable. Collapse/expand keeps the close button + caret anchored on screen.

## module-buffers.js

Feature Area Analysis, Transit Coverage, Transit Propensity, Ridership Forecasting and Corridor Scoring each have a Buffer distance (mi) input plus a default-off **Use Display Buffers** toggle. Neither path mutates shared map buffers. See `docs/module-buffer-distance-plan.md`.

- `App.ANALYSIS_BUFFER_DEFAULT_MILES` 0.5, `App.ANALYSIS_BUFFER_MIN_MILES` 0.05, `App.ANALYSIS_BUFFER_MAX_MILES` 5.
- `App.foldAnalysisUnion(polys)` — `turf.union` fold; `null` for empty.
- `App.buildAnalysisBuffer(feature, miles)` — `turf.buffer(..., {units:"miles", steps:64})`, `null` on failure.
- `App.readAnalysisBufferMiles(elOrId, fallback)` — accepts an id, element, or any `{value}` object (headless-testable); returns `fallback` (default 0.5) when missing, non-numeric or out of `[MIN, MAX]`.
- `App.buildAnalysisBufferSet(filter, miles, opts)` — `filter = {routeIndices, lineIndices, pointIndices, polygonIndices}` (explicit arrays; never null-means-all) → `{byType: {route, line, point, polygon}, union, get(type, idx), count, hiddenCount}`. Points prefer a cached walkshed (`serviceAreaType === "walkshed"` + `App.getPointWalkshed`) unless `opts.preserveWalksheds === false`. Polygons pass through unbuffered.
- `App.buildDisplayBufferSet(filter, opts)` — same shape, using the displayed buffers (Feature Settings + per-feature overrides).
- `opts.includeHidden` (default false) on both bypasses the `properties.hidden` skip; both return `hiddenCount: {included, skipped}`. Hidden features get an on-the-fly buffer (per-feature `_bufferRadius`, else the `App.featureSettings` default) that is never written to shared display arrays. Every hide/show path (Layers tab, `App.bulkFeatures.setHidden`, Features pane, map right-click) calls `App.notifyProject()`.

## analysis-checklist.js

Loads right after module-buffers.js (see `docs/hidden-features-analysis-plan.md`).
- `App.decorateHiddenRow(rowEl, checkboxEl, feature, includeHidden)` — disables + tags (`.ac-hidden`, `.ac-hidden-tag`) a hidden feature's row unless `includeHidden`; **never changes `checkboxEl.checked`**.
- `App.buildIncludeHiddenToggle({id, checked, onChange})`, `App.hiddenSelectionMessage(hiddenCount)` → `{error, notes}`.
- `App.hiddenSignature(refs)` — modules snapshot at run time and compare in `update()` to mark results stale; `App.featureGeomSignature`.
- Adopted by Feature Area Analysis, Transit Propensity, Corridor Scoring, Transit Coverage (cache field `includeHidden`) and Ridership Forecasting (`includeHiddenCalib`/`includeHiddenDemand`); additive, default `false`. Title VI, Walkshed, Transit Travelshed deliberately unchanged.

## choropleth.js

`App.choropleth` (see `docs/feature-area-choropleth-plan.md`). Consumers: Feature Area Analysis (`"bas"`), TPI (`"tpi"`), Ridership Forecasting (`"rf"`), Corridor Scoring (color expression only — line layer). No App/map reads at load, so the math runs in the golden sandbox.

- `App.choropleth.RAMPS` — `{label, colors5}`: `blues` (default), `heat`, `greens`, `rdbu`.
- `App.choropleth.computeClassBreaks(values, method, nClasses=5)` — pure, golden-tested; `"quantile"` (R-7) or `"equal"` → `{breaks, nEffective}`; `breaks` = `nClasses-1` inner breaks (class i covers `breaks[i-1] < v <= breaks[i]`), deduped on ties; all-equal → `{[], 1}`, empty → `{[], 0}`.
- `App.choropleth.buildStepColorExpr(prop, breaks, colors, noDataColor)` — `step` expr wrapped in a `typeof == "number"` case so missing values get `noDataColor` (default `"rgba(200,200,200,0.35)"`), not the first class. `colors.length === breaks.length + 1`.
- `buildInterpolateColorExpr` — linear gradient across the 5 ramp colors from min to max, same no-data guard; a degenerate range (no data or min === max) falls back to one solid color because MapLibre rejects non-ascending stops.
- `App.choropleth.formatBreakLabels(breaks, min, max, fmt=String)` — one range label per class, lowest first.
- `App.choropleth.render(opts)` — `{id, features, valueProp, method ("quantile"|"equal"|"continuous"), classes, ramp, breaks (manual override), beforeLayer (default "buffers-fill" if present), fillOpacity (0.55), lineColor/lineWidth/lineOpacity, hoverHTML(props), noDataColor}`. Creates/updates source `"<id>-choropleth"` + layers `"<id>-choropleth-fill"`/`"<id>-choropleth-line"` (create-once/setData-after, shared hover popup). Returns `{breaks, colors, nEffective, min, max}`; `colors` is exactly what was painted (continuous: 5, 1 if degenerate, `[]` if no data) so legends never show extra swatches.
- `App.choropleth.remove(id)` (idempotent), `App.choropleth.setVisible(id, bool)`, `fillLegend(containerEl, {title, labels, colors, note})` (rows lowest class first, unused rows hidden).

## present-overlays.js

Presentation-mode legend, north arrow and title (draggable/resizable). Registers `"present-overlays"` cache state; listens for `mat:present-mode-change` from `App.setPresentMode()` (app.js). Legend and title auto-size until manually resized; manual title size persists.

## app.js

Startup, module registry, event wiring. Exports: `drawMode`, `registerModule(config)`, `registerProject` (alias), `notifyProject()`, `onFeatureDelete()`, `openModulePopup(id)` (used by the Layers ⋯ menu), `updateAddDataClearIcons()` (Add Data eye/× icons + Layers panel; the visibility sync bridge), `exitDrawMode()`, `finishDrawing()` (Enter; commits via `App.saveLine`/`App.saveRoute`/`App.savePolygon`), `applyFeatureOpacity(type)`, `applyLineWidth(type)`, `applyBufferLineWidth()`.

- `App.buildScrubber(cfg)` — compact numeric control; `cfg` = `{min, max, step, unit, value, onChange}` or `{values: [...], unit, value, onChange}`; returned element exposes `refresh(v)`.
- `_openFpSlider(btn, cfg)` — mounts a scrubber in `#fp-slider-popover`; with `cfg.key` it writes `App.featureSettings[cfg.key]` and calls `App.cache.save()` before `cfg.onChange`.
- **`App.featureSettings`** — type-default half of the appearance cascade: `pointOpacity`/`lineOpacity`/`routeOpacity`, `polygonFillOpacity`/`polygonLineOpacity`/`bufferFillOpacity`/`bufferLineOpacity` (0–100), `pointLineWidth`/`pointStrokeWidth`/`lineLineWidth`/`routeLineWidth`/`polygonLineWidth`/`bufferLineWidth` (×), `bufferRadius`/`lineBufferRadius`/`routeBufferRadius` (mi). Per-feature overrides: `properties._opacity`/`_fillOpacity`/`_borderOpacity`/`_lineWidth`/`_offset`/`_lineStyle` (lines/routes only; set only via `App.setFeatureLineStyle(type, index, style)`), and `_bufferRadius` (study-area geometry, edited via `App.buildBufferRadiusControl`). Color follows the same cascade via `App.resolveFeatureColor` / `App.sectionColors`.
- **Keyboard:** one `keydown` listener handles Delete/Backspace (feature selection → `App.bulkFeatures.confirmRemove`; or selected vertex), Escape, Ctrl+Z / Ctrl+Shift+Z. A second handles tool keys `S` Point, `L` Line, `R` Route, `P` Polygon, `M` Measure, `T` Text Box, `B` Label, `A` Box select (each clicks `.tool-btn[data-mode]`, so it toggles) and Enter. Both skip inputs/contenteditable; tool keys also skip modifiers and when `App.popup.isOpen()`.

**`App.renderModuleState(opts)`** — the shared stale/empty UI every analysis popup must use. `opts = {statusEl, emptyEl, empty, hint, stale, status, onRerun}`; els may be elements or ids (no-op if absent, safe while closed). Precedence: `empty` → show `.rf-info-box` hint (`hint` string or `{need, action}`), hide pill; `status: {kind: "running"|"done"|"error"|"", message}` → pill; `stale` → `.rf-status-stale` "Inputs changed — re-run to update." + Re-run button calling `onRerun`; else hide. Preserves an existing `<span id="…StatusText">`.

**`App.renderModuleInputs(opts)`** — shared collapsible inputs. `opts = {hostEl, collapsed, summary, label, onToggle}`; `hostEl` = `.rf-settings-col` element or id. First call moves the host's children into `.module-inputs-body` and prepends `.module-inputs-header` (listeners and ids preserved — no markup changes). Omit `collapsed` to keep state. Collapsed, the column becomes a full-width bar above results (`.rf-section-row:has(> .module-inputs-collapsed)`). **Collapse on a successful run only** — failed runs leave inputs open. Modules supply `inputsSummary()` (e.g. `"15 min · 3.1 mph · 2 points"`). Used by Walkshed, Transit Coverage, Transit Travelshed, Transit Propensity, Corridor Scoring, Feature Area Analysis and FTA Small Starts.

**Inputs vs. Settings** (convention, not enforced): **Inputs** are required selections, inline, collapsing after a run (buffer distance, checklist, geography, ACS year). **Settings** are optional tuning behind a button, modal or `<details>` (Adjust Weights, Costing Settings, `maxEdge`).
