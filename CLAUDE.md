# CLAUDE.md

Project onboarding for Claude Code sessions. Read this first.

## Developer Context

**User Experience Level**: Beginner/non-coder
- Limited experience with Git, GitHub, and project development
- Does not read or understand code
- Interfaces with Claude through web/chat, not terminal-based development
- Requires clear, step-by-step instructions with explicit file paths

---

## Communication Guidelines

- Use plain language, avoid jargon where possible
- Always specify full file paths (e.g., `src/App.jsx` not "the main file")
- Explain *where* code changes are happening before making them
- Verify branch state before implementing features
- Show git commands explicitly: `git status`, `git pull`, `git checkout branch-name`
- Explain deployment implications (what happens when code is pushed)
- Confirm which branch should be used as base before starting work
- Use specific line numbers when referencing code locations
**At session start**: Always notify the user what branch you are working on and why a new branch was created. Example: "This session is on branch `claude/review-changelog". It was created automatically for this session and includes all prior work."

## Common Issues to Prevent

- Wrong branch base → old UI deploying
- Features reverting due to unclear git state
- Changes made to wrong files
- User confusion about what version is "live"
- User not knowing a new branch was created or how to work from it
- **ACS variable code changes are a one-file edit in `js/core/utils.js`.** `VAR_META` is the single source of truth for variable metadata, checkbox-group membership, and percentage denominators. Add or change a variable with one entry; the popup checkbox list, the percent column, and group expansion all update automatically. Per-entry fields:
  - `displayInChecklist: true` → render as its own checkbox in the popup.
  - `group: "GROUP_X"` → appears in the UI only as part of group X's collective checkbox (mutually exclusive with `displayInChecklist`).
  - `denominator: "B01003_001E"` → percent column against that variable.
  - `denominator: "$group"` → percent against the sum of this entry's group members.
  - omit `denominator` for "no percent column."

  Group display labels live in `GROUP_INFO` (also in `utils.js`). The buffer-summary popup builds its checkbox list at runtime via `App.getCheckboxGroups()` and `App.getDenominator()`. The legacy `CHECKBOX_GROUPS`, local `*_GROUP` arrays, and `DENOM_MAP` in `buffer-summary.js` were removed in this consolidation.
- **Feature attribute changes must update BOTH the per-feature popup and the Attribute Summary module.** The attribute schema is currently duplicated across two render surfaces:
  - `js/core/feature-attributes.js` — `ATTR_FIELDS` config drives the floating per-feature popup (`#fp-attr-popup`).
  - `js/projects/attribute-summary.js` — explicit `renderPoints` / `renderLineLike` / `renderPolygons` / `renderMarkers` build each row's columns.

  When you add, remove, rename, or change the type of any `feature.properties.attributes.*` field (or any direct `feature.properties.*` field surfaced in the UI), update **both** files in the same change so the two surfaces stay in sync. Also update the column grid template in `css/style.css` (`.as-grid-points` / `.as-grid-routelike` / `.as-grid-polygons` / `.as-grid-marker`) if you add or remove a column — header rows and data rows share the same grid, so column count and order must match. If you add a multi-row editor (like Time Bands or Route Picker), build a shared helper in `feature-attributes.js` (pattern: `App.buildXBadge(...)` + `App.openXPopup(...)`) so both surfaces call the same code rather than duplicating the editor UI.

## Testing — golden-value checks

**After changing any formula, elasticity, constant, or pure helper in a calculation engine, run the golden-value tests before committing.** The `test/` folder holds a zero-install harness (pure Node — no npm, no browser, no build) that pins the numeric output of the pure calculation functions so a silent math change is caught instead of shipped.

- **Command:** `node test/run-golden.mjs` (or `bash test/run-tests.sh`). It runs in this environment as-is. A clean run ends with `PASS — N/N cases passed across M module(s)`.
- **If it FAILS and you did NOT intend to change any numbers:** that is a regression — fix the code. Do **not** edit the golden files to make it pass.
- **If it FAILS because you DELIBERATELY changed a formula/constant:** review the reported diff to confirm the new numbers are what you intended, then re-record with `node test/run-golden.mjs --update` and commit the changed `test/golden/*.json` **in the same commit** as the code change, noting in the message which numbers moved and why.
- **Record the outcome in the commit message** — a `Verified: node test/run-golden.mjs → N/N` line — so the check is part of the record.
- **Added or changed a pure calculation function?** Add or extend the matching `test/cases/<module>.mjs` and seed it with `--update`; a new engine module gets a new case file. Functions private to a module's IIFE closure need a small `__MAT_TEST__`-guarded `App._xxTest` export hook (see the existing hooks in `route-costing.js` / `trip-builder.js` / `corridor-scoring.js`). Full workflow: `test/README.md`.

**Covered engines:** Ridership Forecasting, TPI scoring, Route Costing, Trip Builder, Corridor Scoring, Transit Coverage, Module Buffers, Travelshed. **Deferred intentionally:** Title VI (see the note in `features.md`). The harness pins only *pure* math — no map, DOM, Census/LODES API, or turf geometry; those paths are out of scope by design, so not every code change needs a test run, only ones touching calculation logic.

## Overview

Browser-based geospatial analysis tool. Pure front-end (no build step, no backend, no npm). Open `index.html` in a browser and it works. All data stays client-side; Census APIs are called directly.

## File Structure

```
index.html                  App shell: grouped toolbar, map, feature/layers panel, floating module-panel container, dormant hidden sidebar markup, script tags
css/
  style.css                 Core layout, toolbar, feature panel, module popup, floating widgets, basemap switcher, BAS styles (.bas- prefix), TPI styles, RF styles (.rf- prefix), FTA styles (.fta- prefix), TVI styles (.tvi- prefix), pill rating colors
  sidebar-v2.css            Dormant legacy sidebar styles (scoped under hidden #sidebar); retained for compatibility
js/
  app.js                    Startup, module registry, event wiring. Variable checkbox UI is built at runtime by buffer-summary.js from VAR_META in utils.js (no sidebar Data Inputs panel).
  core/
    config.js               Third-party API keys (`App.CARTO_API_KEY`, `App.CENSUS_API_KEY`) + a `localStorage` per-browser CARTO override (`mat-carto-key`). Loads FIRST, before utils.js. **Everything in this file is public** — static site, no build step, public repo, GitHub Pages: values here are served verbatim to the browser and cannot be hidden. Only ever put public, rate-limited, read-only credentials here. See `docs/carto-api-key-plan.md`.
    utils.js                CSV parsing, number formatting, GEOID normalization, VAR_META (single source of truth — label, category, group, displayInChecklist, denominator), GROUP_INFO, getCheckboxGroups, getDenominator, getSelectedVars
    sidebar.js              Dormant legacy sidebar manager: addPanel, removePanel, toggle, render. `#sidebar-wrap` ships hidden and `App.sidebar.render()` is not called; current Data/Analysis entry points are toolbar menus and module popups.
    map.js                  MapLibre GL map instance, basemap registry + switcher control, cursor management. CARTO basemaps require `App.CARTO_API_KEY` (appended as `?key=` to every `basemaps.cartocdn.com` tile URL once at init, so the initial style and `switchBasemap()` both read already-keyed URLs). With no key the three CARTO entries are filtered out of `BASEMAPS` and the default falls back to `esri-light-gray`, so a fork / exhausted quota / domain-locked local dev never renders a watermarked map.
    travelshed.js           Transit Travelshed pure calculation engine (`window.Travelshed`, same engine-namespace convention as `window.TPI`). No turf/DOM/Map/App state — plain JSON in/out so the golden harness loads it directly. `parseHHMMtoMin`, `selectActiveBand` (wrap-aware), `initialWait`/`transferWait` (capped-initial/uncapped-transfer wait model — see `docs/transit-travelshed-plan.md` Appendix A), `rideMinAtDistance` (runTime-priority), `sampleStopPositions`, `propagateRide` (both/forward/loop-wrap), `bandNodeSets` (cumulative per-budget node sets), and the core `computeArrivalTimes` (layered-flood arrival-time propagation: initial boardings from an origin flood, egress-merge into a shared node-time map, one generalized transfer round). `computeArrivalTimes` takes three OPTIONAL walk-leg cap inputs in minutes — `accessMaxMin` (origin-flood seed + round-0 walk), `transferMaxMin` (round ≥1 walk), `egressMaxMin` (the egress-merge walk) — null/undefined = uncapped, backward compatible (see `docs/transit-travelshed-v2-walk-caps-plan.md` §2.2); it also returns `alightings: [{stopKey, alightMin}]`, the best (minimum) alighting time per stopKey across all rounds, consumed by the module's cluster-union polygonization (§2.4). Everything needing turf or the road graph lives in `road-network.js` or `js/projects/transit-travelshed.js`.
    points.js               Points, user-defined buffers (default 0.5 mi), union polygon, point drag support
    lines.js                Line drawing (polylines with snap-to-close), line buffers (default 0.5 mi), rubber-band preview, vertex editing
    routes.js               Route drawing (OSRM street-snapped), route buffers (default 0.5 mi), throttled snapped preview, waypoint-only vertex editing
    polygons.js             Polygon drawing (vertex-by-vertex with snap-to-close), rubber-band preview, vertex editing
    editing.js              Feature editing: point click-drag, line/polygon/route vertex editing with orange handles
    features.js             Right-side feature panel: lists features, editable names, per-item color swatches, gear icon (⚙) per row to open the floating attributes popup, right-click context menu with Attributes option. Row click selects/highlights feature on map only. Delete (trash icon) stays in the row with an inline confirm strip. Exports refreshFeaturePanel, openColorPicker, updateFeatureColor.
    feature-attributes.js   Floating draggable attribute popup (singleton, #fp-attr-popup): ATTR_FIELDS config per type, openAttrPopup(featureType, featureIndex, feature), closeAttrPopup(), isAttrPopupOpen(), getAttrPopupFeature(). Popup is 320px wide, position: fixed, docked left (24px / 60px) on a fresh open, draggable by title bar, clamped within viewport, and collapsible to its title bar. Its color and per-feature appearance controls sit in a left-aligned row below the title; it closes on Escape or X button. Auto-updates when a different feature is selected while open. Attributes stored in feature.properties.attributes (lazy-init). Route/line fields: group (universal grouping key with autocomplete datalist), direction (Both/NB/SB/EB/WB/Inbound/Outbound/Loop/CW/CCW), mode, serviceId (Route Costing pairing key — route+line-only datalist via buildServicePicker; replaces the deprecated routeId field), avgSpeed (default 14 mph, seeded on lazy-init), service bands per day (weekday/saturday/sunday), notes. Polygon fields: group, notes. Point fields: group, serviceAreaType (`""`/circular buffer vs `"walkshed"` — drives the Walkshed study-area substitution in `points.js rebuildBuffers()`; changing it fires `App.ensurePointWalksheds()` + `App.refreshBuffers()` + `App.notifyProject()`), stopId, associatedRoutes. **Any change to this attribute schema must be mirrored in `js/projects/attribute-summary.js` and the `.as-grid-*` column templates in `css/style.css` — see "Common Issues to Prevent" above.** `buildSelect` supports an optional `field.optionLabels` map (value→display text) and a `field.onChange(attrs)` hook.
    layers-panel.js         "Layers" tab on the right feature panel (sibling of the "Features" tab). Unified map-layer manager: a Drawn band (features nested by `attributes.group` with per-group/-feature visibility + color and per-geometry-type opacity), Analysis overlays and Reference/Imported bands (only layers currently on the map) with per-layer show/hide + opacity + constrained drag-reorder + a ⋯ menu (zoom to, open module, remove), and a Basemap selector. Declarative layer manifest (REFERENCE/ANALYSIS) keyed by MapLibre layer id; renders only present layers. Reorder is clamped within a band via map.moveLayer (drawn features stay on top; drawn groups can't z-reorder since a geometry type shares one layer). Two-way visibility sync with the Add Data eye/× icons. Reuses properties.hidden, App.rerenderForType, App.openColorPicker, App._openFpSlider, App.applyFeatureOpacity, App.showContextMenu, basemap API. Exports App.refreshLayersPanel. No own persistence (drawn visibility/color/opacity already ride the session cache; reference/analysis order + visibility are per-session).
    census.js               TIGERweb geometry queries, ACS data fetch, area-weighted aggregation
    lodes.js                LODES .csv.gz download/upload/parse, block-level employment
    cache.js                Session cache: save/restore/reset via localStorage; JSON import/export
    popup.js                Analysis popup manager: open/close module popups, adaptive panel widths, title-bar dragging locked below the browser top with release-time left/right/bottom recovery, collapse/expand anchored on the caret/close controls, and floating map widgets (legend)
    module-buffers.js       Shared analysis-buffer helper: `App.ANALYSIS_BUFFER_DEFAULT_MILES` (0.5) / `_MIN_MILES` (0.05) / `_MAX_MILES` (5), `foldAnalysisUnion`, `buildAnalysisBuffer`, `buildDisplayBufferSet`, `readAnalysisBufferMiles`, `buildAnalysisBufferSet`. Lets Feature Area Analysis, Transit Coverage, Transit Propensity, Ridership Forecasting, and Corridor Scoring choose either a module-owned analysis distance or the selected current Feature Settings buffers without changing map state — see those modules' entries below and `docs/module-buffer-distance-plan.md`.
    present-overlays.js     Presentation mode overlay manager: draggable/resizable legend, north arrow, and title. Registers `"present-overlays"` cache state and listens for `mat:present-mode-change` from `App.setPresentMode()` in `app.js`. Legend auto-sizes to row content with balanced horizontal padding until manually resized. Title auto-sizes to entered text until manually resized; manual title size persists and title text scales from box width.
  projects/
    buffer-summary.js       Feature Area Analysis module: MANDATORY_VARS, expandGroups, runSummary, buildVarChecklistHTML, and a points/lines/routes/polygons checklist. It can use a 0.5-mi default analysis distance or selected displayed buffers; polygons pass through unbuffered. Registered as popup-based module.
    fta-small-starts.js     FTA Small Starts: breakpoint classification, CRE/ESS/LBAR, popup-based 2-tab UI (Ratings | Data Inputs), session persistence, CSV export
    tpi-scoring.js          TPI scoring engine: 9-factor definitions, batch ACS fetch, LODES aggregation, quintile normalization, composite scoring
    transit-propensity.js   TPI module: popup-based 2-column UI (Settings | Results), weights modal overlay, buffer distance (mi, default 0.5 — module-owned analysis distance via `js/core/module-buffers.js`, independent of the Feature Settings global buffer radius; applies to routes/lines/circular-buffer points, preserves walkshed-flagged points' cached walkshed, leaves drawn polygons unbuffered), feature checklist (normalization pool), analysis corridor dropdown, scrollable geography list with expandable factor breakdowns, choropleth rendering, hover tooltips, floating legend (auto-shown on run), GeoJSON/CSV export, stale detection
    ridership-scoring.js    Ridership scoring engine: corridor CDI computation, per-route CDI extraction, system-wide demand orchestration, CSV route matching, segment analysis, service type presets, elasticity formulas, scenario builder, ratio/OLS calibration (window.RidershipModel namespace)
    ridership-forecasting.js  Ridership Forecasting module: 4-tab popup (Calibrate | Demand | Elasticity | Scenarios), 3-step calibration workflow, buffer distance (mi, default 0.5 — one module-owned analysis distance shared by Calibrate and Demand, set on the Calibrate tab with a read-only tracking note on the Demand tab, independent of the Feature Settings global buffer radius), corridor dropdown, choropleth + segment map, scenario comparison table, GeoJSON/CSV/JSON export; shared-pool normalization mode for cross-system calibration
    corridor-scoring.js     Corridor Scoring module: 2-column popup (Settings | Results) that surfaces the per-route CDI engine as a first-class endpoint for ranked, defensible corridor scoring. Buffer distance (mi, default 0.5 — module-owned analysis distance via `js/core/module-buffers.js`, independent of the Feature Settings global buffer radius). Ranked table with classification pills + expandable per-factor breakdowns, map line layer colored by composite CDI (5-class Blues), floating legend, Adjust Weights modal, selected-corridors-only normalization pool, CSV/GeoJSON export, session persistence (weights + buffer distance + selection + last summary; full-mode includes system factor averages for breakdown restore).
    walkshed.js             Walkshed module: 2-column popup (Settings | Results) that computes true street-network walking isochrones from placed Points using the offline road-network engine (`App.computeWalkshed` in `js/core/road-network.js`) — no external service. Settings: minutes (default 15, cap 60), walk speed mph (default 3.1; converted to km/h internally since the road-network engine's graph weights are km), point checklist (target set), advanced concave-hull `maxEdge` (default 0.3 km — a hull-geometry parameter, not a walking unit), "show reachable streets" toggle. Renders a blue walkshed fill/line layer + optional green reachable-segments correctness layer, floating legend, per-point area (mi²/km²) + node count + compute time table, GeoJSON export. **v2 study-area integration:** each Point carries `attributes.serviceAreaType` (`"walkshed"` vs default circular buffer); the module computes+caches a walkshed polygon per point (keyed by pointIdx, invalidated on move / settings / network-epoch change) and exposes `App.getPointWalkshed(pointIdx)` + `App.ensurePointWalksheds()`. `points.js rebuildBuffers()` substitutes the cached walkshed for the circle when a point is flagged, so every study-area consumer (Buffer-Area Summary, Census, LODES, TPI, Title VI, FTA, corridor pickers) uses the walkshed with no per-module changes. Walk parameters are global module settings (per-point `walkMinutes`/`walkSpeedMph` overrides are supported in the data model but not yet exposed in the UI). Session persistence: settings only (schema v2 — v1 sessions stored `walkSpeedKmh` and are migrated to `walkSpeedMph` on restore); polygons recompute cheaply and are not persisted (network is re-imported per session).
    transit-travelshed.js   Transit Travelshed module: 2-column popup (Settings | Results) that computes walk → wait → ride drawn transit routes/lines → walk isochrones from a clicked map origin, with at most one transfer, rendered as 1-3 banded rings. Origin is a probe pattern (an in-popup "Pick origin on map" button arms a one-shot `App.drawMode === "ts-origin"` map click, NOT an `App.points` feature — textboxes.js's `_initDrawMode` is the precedent), rendered as a single draggable-free `maplibregl.Marker`. Settings: 1-3 time budgets (min, default 15/30/blank), walk speed (mph, default 3.1), analysis day + time (`App.getEffectiveServiceBands` selects each feature's active band; no band or blank/0 frequency excludes the feature — disclosed, not an error), wait model (max initial wait min 10, boarding penalty min 1 — capped-initial/uncapped-transfer split per `docs/transit-travelshed-plan.md` Appendix A, with an info toggle), **walk limits** (`shedMode` select — `"transit"` (default; walking to/between/from transit is capped) vs `"door"` (walking may use the whole time budget — v1's uncapped behavior), plus max access/egress/transfer walk (mi, defaults 0.5/0.25/0.25) with an info toggle; the three cap inputs disable while `"door"` mode is selected — see `docs/transit-travelshed-v2-walk-caps-plan.md`), assumed stop spacing (mi, default 0.25, for routes/lines with no associated stop Points), a routes+lines checklist (annotates schedule-less features), and an Advanced hull-detail `maxEdge` (km, default 0.3). Real stops come from Points whose `attributes.associatedRoutes` reference the feature (resolved by scanning `routeIdx`/`lineIdx`, never the array index); synthetic stops are sampled otherwise. A per-stop walk-flood cache (`stopKey|networkEpoch|budgetKm`) is filled chunked-async via `App.computeWalkCostMap`; in `"transit"` mode the origin flood radius is capped at `min(budgetKm, accessCapKm)` and the stop flood radius at `min(budgetKm, max(egressCapKm, transferCapKm))` — shrinking per-stop flood work roughly 50-90× at typical settings — while `"door"` mode floods both at the full max-budget radius as in v1, so one flood still serves every band and re-run at unchanged settings. `ensureFloods()` yields every 5 stops or every ≥50ms of work (not after every single stop — a nested `setTimeout(0)` costs real time, roughly 4ms each, across hundreds of stops) while still updating the "Walking from stop x/y" status every stop. Each fresh `computeWalkCostMap` call returns a `snapMs`/`floodMs` split (see the `road-network.js` entry's "Snap acceleration" note); `ensureFloods` sums these across every fresh stop flood, `runTravelshed()` adds the origin flood's own split, logs the totals to the console, and shows them in the results footer (`snap N ms · flood N ms`) — added after a diagnostic found city-scale snapping (an unindexed per-call scan of every network segment) was the actual bottleneck behind slow "Walking from stop x/y" progress, not the flood radius. `window.Travelshed.computeArrivalTimes` (js/core/travelshed.js) does the layered-flood arrival-time math on plain JSON built from that cache, passing the three walk-leg caps (minutes) only in `"transit"` mode. Bands are pure thresholds over one flood (`Travelshed.bandNodeSets`) but that now drives only the per-band **node counts** shown in the results table — per-band **geometry** is a union of per-cluster polygons (§2.4 cluster-union polygonization): one for the origin/access walk blob, plus one per alighting stop (from the engine's `alightings` array), each independently capped and polygonized via `App.polygonizeNodeSet` then combined with `App.foldAnalysisUnion` — used in both modes, so a single hull can no longer bridge unreachable space between disjoint stop clusters. The resulting per-band union is ring-differenced largest-first (innermost stays solid; a `turf.difference` failure falls back to the un-differenced polygon) into a 3-class Blues fill/line layer. Prompt-to-download: Calculate first checks whether the loaded network's recorded download extent (`App.getRoadDownloadExtent`) contains the analysis's required extent (origin's walk circle — access-capped in `"transit"` mode, full-budget in `"door"` mode — ∪ a walk buffer around each selected feature — capped at the larger of the egress/transfer limits in `"transit"` mode, full-budget in `"door"` mode); if not (or no network loaded), it offers a scoped `App.fetchRoadNetworkForExtent` download and auto re-runs on success — a file-imported network (extent unknown) gets a soft warning instead and is not blocked. Results: per-band area (mi²/km²) + node count + compute stats table, a per-route disclosure panel (band used, wait math, real vs sampled stop counts, direction/loop handling, or exclusion reason) with a footer disclosing the active walk caps (or "Door-to-door — walk uncapped" in `"door"` mode), a floating legend with dynamic per-band labels, GeoJSON export (band rings + origin + methodology metadata, including `shedMode` and the three walk-cap values). Session persistence: settings-only schema **v2** (origin, budgets, wait model, spacing, hull detail, shed mode + the three walk caps, `selectedRouteIds` keyed by the stable routeIdx/lineIdx counter so restore survives index shifts; v1 payloads restore cleanly since the new fields fall back to `DEFAULT_SETTINGS`) — geometry is not persisted, so a restored session's export stays disabled until Re-run.
    transit-coverage.js     Transit Coverage module: 2-column popup (Settings | Results) that answers the classic consulting coverage stat — what share of a service area's population and jobs is within a buffer distance of selected transit, optionally filtered to routes/lines meeting a peak-headway threshold. Settings: geography level/ACS year (with LODES warning), buffer distance (mi, default 0.5 — module-owned analysis distance via `js/core/module-buffers.js`, independent of the Feature Settings global buffer radius), day type for peak headway (Weekday default/Saturday/Sunday, read via `App.getEffectiveServiceBands`), optional headway threshold (min, blank = generic coverage only), a routes+lines checklist (transit sources), and a drawn-polygons checklist (service area, union = denominator). Builds **private** buffers via `App.buildAnalysisBuffer`/`App.foldAnalysisUnion` — never reads/mutates `App.routeBuffers`/`App.lineBuffers`. Coverage/threshold unions are clipped to the service-area union with `turf.intersect` (null = zero coverage, not an error) before aggregating ACS population (`B01003_001E`, always area-apportioned — no user toggle) and LODES jobs (whole-block, `App.fetchBlocksInternalPointsInUnion` — apportionment doesn't apply to jobs, shown as "—" + ⚠ when LODES absent). Results table (Service area / within-buffer / within-buffer-and-threshold rows × Population, Pop %, Jobs, Jobs %), a plain-language stat sentence, and a collapsible per-feature peak-headway list. Map overlay: light-blue coverage fill, dark-blue threshold fill, dashed service-area outline (one geojson source, `kind`-filtered layers), floating legend. CSV/GeoJSON export; session persistence (schema v1, numbers + selections only — geometry is not persisted, so a restored session's GeoJSON export is disabled until Re-run regenerates it).
    route-costing.js        Route Costing module: 2-column popup (Settings | Results) that estimates daily and annual operating cost for transit services assembled from drawn Route/Line features. Service assembly buckets features by `attributes.serviceId` (1-2 patterns per Service; standalone features become 1-pattern Services). Validates direction pairings; warns and skips invalid Services. Costing Settings modal configures cost/hr, deadhead %, layover (min or % of round-trip), Weekday/Saturday/Sunday days per year, fleet spare ratio, cost basis label, and runtime input mode (avg speed vs. run time — supports per-feature `runTime` attribute). Results split into four tables: Weekday / Saturday / Sunday / Total (annualized), each with expandable per-band breakdown on Total. System Summary has 4 columns (Wk/Sa/Su/Total): daily/annual trips, rev-hr, plat-hr, miles, operating cost, peak pullout (Σ services), theoretical interline min, and fleet planning total with spares. An Interlines button exists in the UI but is currently disabled (logic under review — do not enable). CSV export with Day Type column and explicit layover/deadhead breakdown; session persistence (schema v2).
    trip-builder.js         Trip Builder module: 2-column popup (Services | Trips) that generates a high-level trip schedule (Start / End times) per direction per day type from each Service's underlying Time Bands, Frequency, and Run time / Avg speed attributes. Same Service assembly as Route Costing (`attributes.serviceId` buckets, 1-2 patterns, paired/solo validation). Left column lists every Service (single-select). Right column shows an expandable service header (per-pattern runtime, length, headway summary) + a "Generate Trips" button + per-day side-by-side direction tables (Weekday / Saturday / Sunday); each table row has a trash icon to delete that single trip. Direction columns are colored by their underlying feature's color. Single-pattern "Both" produces derived Outbound* / Inbound* columns with simultaneous trips; paired patterns each generate from their own bands. Loop / CW / CCW solos produce one column. Runtime priority: per-feature `runTime` wins; falls back to `lengthMiles / avgSpeed × 60`. Bands wrapping past midnight are supported (display modulo 24h, no "+1d" annotation). Trips with end past band end are still generated. CSV export per service. Session persistence (schema v1) keeps `selectedKey` and `tripsByService`. No Census/LODES/TPI dependency.
    title-vi-engine.js      Title VI engine: policy profiles, major-change rules, geometric divergence detection (turf.nearestPointOnLine), service change area computation (turf.difference), alteration metrics orchestration, demographic fetching, finding evaluation, scenario comparison (window.TitleVI namespace)
    title-vi.js             Title VI Service Equity module: 3-tab popup (Policies & Inputs | Analysis | Scenarios), route alteration pairing UI (before/after feature dropdowns), auto-computed route miles and % altered, service loss/gain map overlay, system baseline vs impacted area demographic comparison, CSV/GeoJSON/JSON export, session persistence
    gtfs.js                 GTFS Feed Viewer: loads a GTFS ZIP (JSZip + PapaParse), renders shapes.txt as dashed reference lines (gtfs-shapes-layer) and stops.txt as hollow circles (gtfs-stops-layer) below user-drawn features, hover tooltip + click detail popup on both layers (route name/mode for shapes; stop name/ID for stops), shape_id → route info pre-joined from trips.txt + routes.txt at load time, two-column analysis popup (file directory with REQ/OPT badges | scrollable CSV table, capped at 500 rows), layer visibility toggles, clear-feed button. No session persistence (feed must be re-uploaded per session). Wires Add Data dropdown buttons directly (no app.js changes needed).
    attribute-summary.js    Attribute Summary "system" module: registered with `system: true` so it does NOT appear in the Analysis dropdown. Opened via the Attribute Summary… button under Feature Settings (right-side feature panel). Single-column popup (960px) with one section per feature type (Points / Lines / Routes / Polygons / Text Boxes / Labels). Each row binds inputs directly to `feature.properties` and `feature.properties.attributes` — no duplicated state. Per-row override icons (opacity / buffer / width / offset / reset) reuse the same `App.buildOverrideIcons` helper as the per-feature attribute popup. Time bands and route-pickers are rendered as compact pill badges (`fp-bands-badge`, `fp-route-badge`) that open a shared mini-popup (`#fp-mini-popup`) with the same UI as the per-feature attribute popup.
projects/
  buffer-summary-popup.html   Feature Area Analysis popup body: vertical setup/results layout on the shared `.rf-section-row` / `.rf-settings-col` / `.rf-results-col` schema. Settings has an all-feature checklist, 0.5-mi default analysis distance, Use Display Buffers toggle, variable checklist, geography, ACS year, apportion toggle, and Calculate Summary; results has the progress line, `#basEmptyState`, table, and notes.
  fta-small-starts-popup.html  FTA popup body: 2-tab layout (Ratings | Data Inputs); Ratings tab has 2-column layout (settings + 5 rating cards); Data Inputs tab has CRE/ESS/LBAR file uploads with column mapping selects
  fta-small-starts.html     FTA sidebar HTML fragment (legacy, replaced by popup version)
  transit-propensity-popup.html  TPI popup body: 2-column layout (Settings | Results); Settings column has geography/year selectors, apportion toggle, feature checklist (normalization pool), analysis corridor dropdown, Adjust Weights button (opens modal overlay with 9 factor sliders + Confirm/Cancel/Reset), Analyze System button; Results column has scrollable geography list with expandable per-geo factor breakdowns, summary stats, export buttons; LODES warning icon (⚠) next to ACS Year selector
  transit-propensity.html   TPI sidebar panel (legacy, replaced by popup version)
  tpi-weights.html          TPI weight sliders (legacy, merged into popup)
  tpi-legend.html           TPI legend: 5-class Blues color swatches (reused by floating widget)
  ridership-forecasting-popup.html  RF popup body: 4-tab layout (Calibrate first), 3-step calibration workflow UI (system analysis → CSV upload → match/calibrate); "Adjust Weights" button above "Analyze System" opens an in-popup modal overlay with 9 factor weight sliders (Confirm / Cancel / Reset to Defaults / Copy From TPI); expandable per-route factor breakdowns with quintile bars; headway normalization note (`rfCalibHeadwayNote`); shared-pool refit note (`rfCalibSharedPoolNote`); LODES warning icons (⚠) next to ACS Year in Calibrate and Demand tabs (shows tooltip when LODES not loaded); corridor dropdown in Demand tab, CDI info button (ⓘ toggle), segment breakdown, "Shared pool normalization" checkbox (`rfSharedPoolMode`) with info tooltip (`rfSharedPoolTooltip`) in Demand tab feature section, elasticity sliders — frequency elasticity (`rfFreqElastSlider`/`rfFreqElastValue`, 0.1–1.0, default 0.60) and service span elasticity (`rfSpanElastSlider`/`rfSpanElastValue`, 0.1–1.0, default 0.70, typical range 0.5–0.9) — in Elasticity tab left column; service type premium sliders (`rfServicePremLow`/`rfServicePremLowVal` and `rfServicePremHigh`/`rfServicePremHighVal`, 0–150% range) in Elasticity tab right column (replaces static Frequency/Speed/Mode breakdown), baseline uncertainty slider (`rfBaseUncertSlider`/`rfBaseUncertValue`, 0–60% range, default 25%) in Elasticity tab with "Baseline Projection" result card (`rfBaselineBand`) showing pre-service uncertainty band, 4-column scenario grid (A|B|C|D), comparison table
  ridership-legend.html     RF demand legend: 5-class Blues swatches for CDI score (High → Low)
  corridor-scoring-popup.html   Corridor Scoring popup body: 2-column layout (Settings | Results). Settings column has geography/year selectors, LODES warning icon, apportion toggle, corridor checklist (routes + lines only — normalization pool), Adjust Weights button (opens modal overlay with 9 factor sliders + Confirm/Cancel/Reset), Score Corridors button. Results column has ranked corridor table (rank, name, score, classification pill, expand caret) with hidden .cs-row-details rows holding factor breakdown bars; CSV + GeoJSON export buttons.
  corridor-scoring-legend.html  Corridor Scoring legend: 5-class Blues swatches keyed to composite CDI buckets (≥4 High, 3–4, 2–3 Medium, 1–2, <1 Low).
  walkshed-popup.html           Walkshed popup body: 2-column layout (Settings | Results). Settings has minutes/walk-speed inputs, an advanced `maxEdge` details block, a point checklist (`#wsPointList`), a "show reachable streets" toggle, and a Calculate button (disabled + `#wsNetWarn` shown when no road network is loaded). Results has the standard `#wsStatus.rf-status` pill, a per-point results table (`#wsResultsTable`), and "Use as study areas" / "Export GeoJSON" buttons, plus `#wsEmptyState.rf-info-box`.
  walkshed-legend.html          Walkshed legend: walkshed-fill swatch + reachable-streets swatch (reuses `.tpi-legend-*`).
  transit-coverage-popup.html   Transit Coverage popup body: 2-column layout (Settings | Results), copied from the Corridor Scoring shell (no weights modal). Settings column has geography/year selectors + LODES warning icon, buffer distance / day type / headway threshold inputs (no apportion toggle — population is always area-apportioned), a routes+lines checklist (`#tcFeatureList`) and a drawn-polygons checklist (`#tcAreaList`), each with its own Select all / Clear links, and an Analyze Coverage button. Results column has the standard `#tcStatus.rf-status` pill, a results table (`#tcResultsTable`), a plain-language stat sentence (`#tcStatSentence`), a collapsible peak-headway list (`#tcHeadwayList`), CSV/GeoJSON export buttons, and `#tcEmptyState.rf-info-box`.
  transit-coverage-legend.html  Transit Coverage legend: light-blue coverage swatch, dark-blue threshold swatch, dashed service-area outline swatch (reuses `.tpi-legend-*`).
  transit-travelshed-popup.html  Transit Travelshed popup body: 2-column layout (Settings | Results), settings column copied from the Transit Coverage/Walkshed shells. Settings has the origin block (`#tsPickOriginBtn`/`#tsOriginLabel`/`#tsClearOriginBtn`), 3 budget inputs (`#tsBudget1/2/3`), walk speed, day+time selectors, wait-model inputs with an info toggle (`#tsWaitInfoBtn`/`#tsWaitInfoText`), a "Walk limits" block (`#tsShedMode` transit/door select, `#tsAccessWalk`/`#tsEgressWalk`/`#tsTransferWalk` cap inputs (mi), info toggle `#tsWalkCapsInfoBtn`/`#tsWalkCapsInfoText`), stop spacing, a routes+lines checklist (`#tsRouteList`) with Select all/Clear, an Advanced `maxEdge` details block, network state (`#tsNetWarn`/`#tsCoverageWarn`/`#tsDownloadBtn`), and the Calculate button (`#tsRunBtn`). Results has the standard `#tsStatus.rf-status` pill, a per-band table (`#tsResultsTable`), a per-route disclosure panel (`#tsRouteDetail`), an Export GeoJSON button (`#tsExportBtn`), and `#tsEmptyState.rf-info-box`.
  transit-travelshed-legend.html  Transit Travelshed legend: 3 rows reusing `.tpi-legend-*` (ids `#tsLegendRow0/1/2` + `#tsLegendLabel0/1/2`); the module fills each band's "≤ N min" label and hides unused rows after mount.
  route-costing-popup.html  Route Costing popup body: Costing Settings modal overlay (cost/hr, deadhead %, layover mode+value, days/year Wk/Sa/Su with live sum, fleet spare ratio, cost basis label, runtime input mode radio) + Interlines modal overlay (UI built but button is `disabled` — logic under review, do not enable) + 2-column layout. Settings column has Service checklist with Select all / Clear, side-by-side Costing Settings / Interlines (disabled) buttons, Cost Services button. Results column has four per-Service tables (Weekday / Saturday / Sunday / Total with expandable band breakdown), system summary with 4-column layout (Wk/Sa/Su/Total), CSV export.
  trip-builder-popup.html   Trip Builder popup body: 2-column layout. Left column has the Services list (`#tbServiceList`, single-select rows with color stripe + paired/solo pill + warning badge). Right column has status pill, expandable service header (`#tbHeader`), Generate Trips button (`#tbGenerateBtn`), trip results grid (`#tbResults`, populated by JS with `.tb-day-section` per day and `.tb-day-grid` of side-by-side direction tables), Export CSV button (`#tbExportCSV`), and an empty-state info box (`#tbEmptyState`).
  title-vi-popup.html       Title VI popup body: 3-tab layout (Policies & Inputs | Analysis | Scenarios); Policies tab has 2-column layout (policy settings left, route alteration cards + impact method right); Analysis tab has baseline computation + equity findings; Scenarios tab has scenario manager + comparison table
  gtfs-popup.html           GTFS Feed popup body: two-column layout (left: scrollable file directory with REQ/OPT badges + layer visibility checkboxes + Clear button; right: scrollable CSV table for the selected file with row/column count)
  attribute-summary-popup.html  Attribute Summary popup body: single column, one `<section data-section="…">` per feature type (point/line/route/polygon/textbox/label) with an inner `.as-table` populated by JS. All sections are hidden by default and revealed only when that feature type has any features.
docs/
  ridership-forecasting-plan.md  Strategic evaluation and implementation plan for the ridership forecasting tool
  route-costing-plan.md          Sequenced resume plan for the Route Costing module (design decisions + 9-step build order)
Ridership_Forecast_Readme.md    User-facing documentation for the Ridership Forecasting module (plain-language, transit professional audience)
```

## Conventions

- **No build tools.** Plain `<script>` tags in dependency order. Anyone can read/edit the source directly.
- **Global namespace.** All shared state and functions live on `window.App`. Each module IIFE reads `var App = window.App` and assigns its exports (e.g., `App.fetchTigerwebGeos = fetchTigerwebGeos`).
- **Module-local state stays private.** Variables like `CRE_MAP`, `ESS_POINTS`, `LBAR_SITES` (FTA) and `_lastResult`, `_stale`, `_running` (TPI, RF) are declared inside the module IIFE closure, not on `App`. Scoring engines use separate window namespaces: `window.TPI` (TPI scoring), `window.RidershipModel` (ridership scoring).
- **Dormant sidebar.** `#sidebar-wrap`, `sidebar-v2.css`, and `js/core/sidebar.js` remain for compatibility, but the wrapper ships hidden and `App.sidebar.render()` is not called. Current Data access is the toolbar Add Data menu; analyses are opened from the grouped toolbar Analysis menu. Do not describe the legacy sidebar as a live surface unless it is explicitly revived.
- **Analysis panels.** Analysis modules open as non-modal floating panels over a live, interactive map. `App.popup` loads the HTML, manages init/open/close lifecycle and Escape, docks a fresh panel to the right, and collapses the whole panel to its title bar. Compatible single-step modules declare `panelWidths` and call `App.popup.setLayoutMode("setup" | "results" | "workspace")`: setup opens narrow with Inputs expanded; a successful run uses the result width and collapses Inputs; clearing returns to setup. `App.renderModuleInputs()` provides that separate, keyboard-accessible Inputs section. Use stable `data-input-group` wrappers for movable input sections and keep Run/Calculate controls in `.module-input-actions`. Floating widgets such as legends persist independently.
- **Tabbed popup layout.** Multi-step analysis modules (e.g., Ridership Forecasting, FTA Small Starts, Title VI) use a tab bar (`<div class="rf-tabs">` / `<div class="fta-tabs">` / `<div class="tvi-tabs">` with `[data-tab]` buttons) and tab content panels toggled via a `switchTab(id)` function in the module JS. State is saved to closure variables on tab switch; the form is not reset.
- **Inline info buttons.** Contextual help uses a small `<button class="rf-info-btn">ⓘ</button>` element adjacent to the label, wired in `init()` to toggle a sibling explanation `<div>` via `style.display`. No tooltip libraries needed.
- **CSS namespacing.** TPI styles use `.tpi-` prefix. Ridership Forecasting styles use `.rf-` prefix. FTA Small Starts styles use `.fta-` prefix. Title VI styles use `.tvi-` prefix. Rating pill colors use `.pill.high` through `.pill.low`. All live in `css/style.css`. **Exception — `.rf-status` / `.rf-status-stale|-done|-error|-running` / `.rf-status-rerun` / `.rf-status-text` and `.rf-info-box` are intentionally SHARED cross-module classes** (despite the `rf-` prefix): every analysis popup's stale/empty UI is emitted by `App.renderModuleState()`. Do not "fix" the prefix or fork per-module copies.
- **Standardized module state (stale + empty/onboarding).** Every analysis module routes its "results are stale" banner and "nothing to act on" empty state through `App.renderModuleState()` (see app.js API). The stale banner is uniform across the suite and carries a working **Re-run** button (each module passes its run function as `onRerun`). The empty state shows a one-line, context-aware "what this needs" onboarding hint on first open (e.g. "Draw a route or line to begin" vs. "Select corridors and click Score Corridors"). Modules typically keep a thin `setStatus(msg, kind)` that delegates to the helper, a `showStale()` wrapper, and an `emptyHint()` returning `{ need, action }`. When adding a new module, follow this pattern rather than styling a bespoke banner. Per-input tooltips are a deferred follow-up (not yet implemented).
- **Design tokens and colors.** App chrome uses semantic tokens from `:root` and the `body.dark-mode` token block (`--bg`, `--surface*`, `--text-*`, `--border*`, `--accent`, status tokens). Do not add raw hex values for chrome colors. Data encodings are exempt: feature colors, choropleth ramps, rating/classification pills, legend swatches, and tool-specific map symbols retain explicit colors.
- **Spacing and shared primitives.** Use the `--space-*` scale for new layout spacing. Shared form/control/layout primitives include `.form-field`, `.form-section`, `.btn-row`, `.rf-select`, `.rf-number-input`, `.rf-action-primary`, `.rf-btn-sm`, and `.u-*` utilities. Extend these shared primitives instead of adding module-specific duplicates.
- **Typography.** Inter is the single app-wide UI and map-label font. Font sizes, weights, line heights, letter spacing, and families are CSS custom properties in `:root`; use variables such as `--text-sm`, `--weight-semibold`, and `--leading-normal` instead of hardcoded typography values. Dense tables intentionally use the smaller end of the shared scale.
- **Visual verification.** `test/ui-screens/capture.mjs` is the UI regression harness. It renders the shell, feature/attribute panels, every analysis panel, tab states, representative collapse states, narrow viewport, and light/dark themes into `test/ui-screens/out/`; committed references live in `test/ui-screens/baseline/`. Run it after app-shell, shared-CSS, popup, or module-markup changes and inspect the images, not only the pass count.
- **External libraries via CDN:** MapLibre GL JS, Turf.js, pako (gzip), PapaParse (CSV), JSZip (GTFS ZIP parsing).

## Script Load Order

Order matters because modules depend on earlier ones:

```
config.js   (no deps — API keys; MUST be first so map.js/census.js see the keys at init)
utils.js    (no deps)
sidebar.js  (needs App namespace from utils.js)
map.js      (creates App.map, basemap switcher, cursor handlers; reads App.CARTO_API_KEY)
travelshed.js (core block, no deps — turf/DOM/Map/App-free; defines window.Travelshed)
points.js (needs App.map, turf)
lines.js    (needs App.map, turf)
routes.js   (needs App.map, turf, fetch/AbortController)
polygons.js (needs App.map)
editing.js  (needs App.map, App.points, App.lines, App.routes, App.polygons, move/update functions)
features.js           (needs App.points, App.lines, App.routes, App.polygons, App.removePoint, etc.)
feature-attributes.js (needs App namespace; defines App.openAttrPopup, App.closeAttrPopup, App.isAttrPopupOpen, App.getAttrPopupFeature)
layers-panel.js       (needs App.map, App.collectDrawnFeatures, App.rerenderForType, App.openColorPicker, App._openFpSlider, App.applyFeatureOpacity, basemap API, turf; defines App.refreshLayersPanel)
census.js             (needs App.map, App.bboxStringFromFeature, App.getMeta, turf)
lodes.js    (needs App.map, App.bboxStringFromFeature, App.bufferUnionPolygon, pako, turf)
cache.js    (needs App.points, App.lines, App.routes, App.polygons, render/rebuild functions)
popup.js    (needs App namespace; defines App.popup)
module-buffers.js   (needs App.points/lines/routes/polygons, App.getPointWalkshed (optional), turf; defines App.ANALYSIS_BUFFER_DEFAULT_MILES/_MIN_MILES/_MAX_MILES, App.foldAnalysisUnion, App.buildAnalysisBuffer, App.readAnalysisBufferMiles, App.buildAnalysisBufferSet)
app.js              (wires everything; builds toolbar menus; defines App.registerModule; calls cache.restore)
<modules>           (call App.registerModule)
  buffer-summary.js     (needs App namespace, App.cache; registers Buffer-Area Summary module; runSummary + builds checkbox UI from VAR_META at popup init)
  fta-small-starts.js   (needs App namespace, App.cache; registers FTA Small Starts module; popup-based 2-tab UI)
  tpi-scoring.js        (needs App namespace, turf; defines window.TPI)
  transit-propensity.js (needs TPI, App.registerModule, App.popup, App.map, App.renderCensusOverlay)
  ridership-scoring.js  (needs window.TPI, App namespace, turf; defines window.RidershipModel)
  ridership-forecasting.js (needs RidershipModel, TPI, App.registerModule, App.popup, App.map, App.renderCensusOverlay)
  corridor-scoring.js   (needs TPI, RidershipModel, App.registerModule, App.popup, App.map, App.cache; registers Corridor Scoring module)
  walkshed.js           (needs App.registerModule, App.popup, App.map, App.cache, App.computeWalkshed/roadNetworkLoaded/roadNetworkEpoch from road-network.js, App.points, App.refreshBuffers, turf; registers Walkshed module — no TPI/Census dependency)
  transit-travelshed.js (needs window.Travelshed, road-network.js exports (computeWalkCostMap/polygonizeNodeSet/nodeKeyToCoord/snapWalk/getRoadDownloadExtent/fetchRoadNetworkForExtent/roadNetworkLoaded/roadNetworkEpoch), App.registerModule, App.popup, App.map, App.cache, App.getEffectiveServiceBands, App.foldAnalysisUnion, turf, maplibregl; registers Transit Travelshed module — no TPI/Census dependency)
  transit-coverage.js   (needs App.registerModule, App.popup, App.map, App.cache, App.getEffectiveServiceBands, census.js, lodes.js, turf; registers Transit Coverage module)
  route-costing.js      (needs App.registerModule, App.popup, App.cache, turf; registers Route Costing module — no TPI/Census dependency)
  trip-builder.js       (needs App.registerModule, App.popup, App.cache, turf; registers Trip Builder module — no TPI/Census dependency)
  title-vi-engine.js    (needs App namespace, turf; defines window.TitleVI)
  title-vi.js           (needs TitleVI, App.registerModule, App.popup, App.map, App.cache)
  gtfs.js               (needs JSZip, PapaParse, maplibregl, App.registerModule, App.popup, App.map; no scoring engine deps)
  attribute-summary.js  (needs App.registerModule, App.popup, App.openColorPicker, App.updateFeatureColor, App.buildOverrideIcons, App.buildPointRouteBadge, App.buildTimeBandsBadge; system module — opened via App.openAttributeSummary())
present-overlays.js     (needs App namespace and App.cache; loaded after modules; listens for `mat:present-mode-change`)
```

**Active modules:** Buffer-Area Summary is enabled (popup-based, settings + results table). TPI is enabled (popup-based, 2-column). FTA Small Starts is enabled (popup-based, 2-tab). Ridership Forecasting is enabled (popup-based, 4-tab). Corridor Scoring is enabled (popup-based, 2-column). Walkshed Analysis is enabled (popup-based, 2-column; network isochrones via the offline road-network engine). Transit Travelshed is enabled (popup-based, 2-column; walk→wait→ride transit→walk isochrones from a clicked origin, ≤1 transfer, via the offline road-network engine + the pure Travelshed calc engine). Transit Coverage is enabled (popup-based, 2-column; population/jobs coverage within a buffer of selected routes/lines, clipped to a drawn service area). Route Costing is enabled (popup-based, 2-column). Trip Builder is enabled (popup-based, 2-column). Title VI Service Equity is enabled (popup-based, 3-tab). GTFS Feed Viewer is enabled (popup-based, 2-column file browser + map layers). Attribute Summary is enabled as a **system module** (registered with `system: true` so it is hidden from the Analysis dropdown; opened via the Attribute Summary… button under Feature Settings).

**Dormant module:** *Wetland & Channel Mitigation Needs* (`js/projects/mitigation-needs.js` + `mitigation-needs-data.js`, `projects/mitigation-needs-popup.html` + `mitigation-needs-legend.html`) was built only as an illustration. Its two `<script>` tags in `index.html` are commented out, so the module does not load or appear in the Analysis dropdown. The files are retained; re-enable by uncommenting both tags.

## App Namespace (Public API)

### utils.js
`setStatus(s)`, `parseCSV(text)`, `fillSelect(el, opts, placeholder)`, `enableSelect(el, bool)`, `toNumberSafe(v)`, `normalizeTractGEOID(raw)`, `guessHeader(headers, candidates)`, `VAR_META`, `GROUP_INFO`, `getMeta(code)`, `getCheckboxGroups()`, `getCheckboxGroupMembers(groupKey)`, `getDenominator(code)`, `setAggUI(meta)`, `formatValue(val, meta)`, `getSelectedVars()`, `mapToObj(map)`, `objToMap(obj)`, `nestedMapToObj(outerMap)`, `nestedObjToMap(obj)`

`VAR_META` is the single source of truth for variable metadata. Per-entry fields: `source` ("ACS"|"LODES"), `agg` ("sum"|"avg"|"ratio"), `fmt`, `label`, `category`, optional `codes` (multi-code derived sums), optional `tractOnly`, `numerator`/`denominator`/`ratioLabel` (ratio aggregations only). Checkbox-UI fields (drive the popup): `displayInChecklist: true` for individual checkboxes, `group: "GROUP_X"` for group members, `denominator: "<code>"` or `"$group"` for the percent column. `GROUP_INFO` holds display labels for `GROUP_*` keys. `getCheckboxGroups()` returns `{ groupKey: [memberCodes] }` derived from `VAR_META`. `getDenominator(code)` returns `{ type: "var", code }` | `{ type: "group", codes }` | `null` (returns `null` for ratio aggregations).

### sidebar.js
`sidebar.addPanel(config)`, `sidebar.removePanel(id)`, `sidebar.toggle(id)`, `sidebar.render()`

Dormant compatibility API; current startup does not call `render()`. Panel config remains `{ id, title, html, collapsed (default false), order (default 100) }` if the sidebar is deliberately revived later.

### map.js
`map` (MapLibre instance), `switchBasemap(basemapId)`, `getBasemaps()` (returns `[{id, name}]`), `getCurrentBasemapId()`, `getThemeBasemapId(isDark)`

Basemap IDs: `"carto-light"` (default), `"carto-dark"`, `"carto-voyager"`, `"osm"`, `"satellite"`, `"esri-dark-gray"`, `"esri-light-gray"` (the last two are Esri Canvas raster basemaps — muted background, streets emphasized, minimal labels)

**CARTO key + keyless fallback.** CARTO requires an API key on `basemaps.cartocdn.com` (unkeyed tiles are stamped "API KEY REQUIRED"). `App.CARTO_API_KEY` comes from `js/core/config.js` and is applied once at init to every CARTO tile URL, so both consumers — the initial style and `switchBasemap()` — read already-keyed URLs. Note those are **separate code paths**: the initial style is built directly from the registry, not via `switchBasemap`, so a key applied in only one place leaves the default basemap broken on load. When the key is empty the three CARTO entries are removed from `BASEMAPS` and the default becomes `"esri-light-gray"`; that is a supported state (fork, exhausted quota, or domain-locked local dev), not an error.

**`getThemeBasemapId(isDark)`** returns the light/dark basemap for the active family — CARTO when keyed, Esri Canvas when not. Dark-mode callers in `app.js` **must** use it rather than hardcoding `"carto-light"`/`"carto-dark"`: those ids do not exist in the keyless path and `switchBasemap` silently returns on an unknown id, which would strand the map on the wrong-theme basemap.

CARTO and OpenStreetMap attribution must stay visible on the CARTO basemaps — it is a license condition of the free tier.

### points.js
`points` (Point array), `buffers` (Polygon array), `addPoint(lon, lat)`, `addPointWithOpts(lon, lat, opts)`, `rebuildBuffers(radiusMiles)`, `refreshBuffers()` (rebuild at the current radius — used by the Walkshed module), `movePoint(index, lng, lat)`, `removePoint(index)`, `clearPoints()`, `undoLastPoint()`, `duplicatePoint(index)`, `renderPointLayers()`, `bufferUnionPolygon()`, `getUnion()` (alias), `bboxStringFromFeature(feat)`

`rebuildBuffers()` substitutes a cached walkshed polygon for the circle when a point has `attributes.serviceAreaType === "walkshed"` and `App.getPointWalkshed(pointIdx)` returns one (else it falls back to the circular buffer). The resulting `buffers[i]` carries `properties.walkshed = true`.

### road-network.js
Offline routing engine (Overpass/file import → graph → Dijkstra). Public: `roadNetworkLoaded()` (bool), `roadNetworkEpoch()` (int, bumped on every network (re)build/clear — used by the walkshed cache to invalidate), `findLocalRoute(waypoints)`, `fetchRoadNetwork()`, `loadRoadNetworkFromFile(file)`, `exportRoadNetwork()`, `clearRoadNetwork()`, `clearRoadDownloadArea()` (removes only the downloaded-area outline, leaves the graph — wired to the Layers panel), and `computeWalkshed(lngLat, budgetKm, options)` → `{ polygon (turf Feature<Polygon|MultiPolygon>), reachableSegments (FeatureCollection of reachable street LineStrings), reachableCount, snap, computeMs, snapMs, floodMs } | null` (null when no network is loaded or the origin snaps > `SNAP_MAX_KM` (0.5 km) from the network). `computeWalkshed` runs a budget-limited flood Dijkstra (no `endKey` early-exit; prunes relaxations beyond `budgetKm`), collects settled nodes/edges, and builds the polygon via a concave-hull auto-relax loop (grow `maxEdge` until non-null → `turf.convex` fallback → small buffer for <3 nodes). **Class-aware traversal:** the shared network is tagged per-edge/segment with `pedBlocked`/`carBlocked` in `buildGraph()`, derived from the OSM `highway` class and `foot` tag via `isPedForbidden(hwy, foot)` / `isCarForbidden(hwy)` (`PED_FORBIDDEN_HWY` = motorway/trunk + their `_link` ramps; `CAR_FORBIDDEN_HWY` = footway/path/steps/pedestrian/cycleway; an explicit `foot=yes/designated/permissive` or `foot=no` overrides the class default). The walkshed flood and its reachable-streets layer skip `pedBlocked` edges (freeways excluded), the driving `dijkstra` skips `carBlocked` edges (never routes over pedestrian-only ways), and `snapToNetwork(lngLat, mode)` skips segments this mode can't use via a per-candidate `pedBlocked`/`carBlocked` check (`"walk"` from `computeWalkshed`, `"drive"` from `findLocalRoute`; absent mode = no filter). One download, two interpretations. **Snap acceleration:** `snapToNetwork` queries a uniform spatial grid (`_segGrid`, built by `buildSegGrid()` alongside `_segmentIndex` in `buildGraph()`, cell size ≈0.5 km sized from the network bbox's mid-latitude) instead of scanning every segment — only the 3×3 cell neighborhood around the query point (~1.5 km²) is checked, which always covers the `SNAP_MAX_KM` rejection radius. Candidate segments are compared with inline equirectangular point-to-segment math (`nearestOnSegmentKm`, projected around the query point) instead of per-segment `turf.lineString`/`turf.nearestPointOnLine` allocations — on a city-scale Overpass download (tens of thousands of segments once footways/paths are included) the old whole-network scan cost 1-3 seconds per call and was the actual bottleneck behind "Walking from stop x/y" in Transit Travelshed, not the flood itself. `_segGrid` is cleared in `clearRoadNetwork()` alongside the rest of the graph state. Graph weights are in **km**, so `budgetKm = walkSpeedKmh * (minutes / 60)` (the Walkshed module's UI/attributes are in **mph**; it converts to km/h before calling `computeWalkshed`). **`fetchRoadNetwork()`** downloads Overpass roads for the current map view **expanded ×1.5 on each side** (`turf.transformScale`, area ≈ 2.25×) so edge routes/walksheds aren't starved of streets; the query pulls vehicle roads **and** pedestrian-specific ways (`living_street|pedestrian|footway|path|steps|cycleway`) and captures the `foot` tag, so walksheds follow real walking connections while drive-routing ignores the pedestrian-only classes (see class-aware traversal above); it warns via `window.confirm` when the expanded area exceeds `MAX_AREA_WARN_KM2` (~2000 km², since Overpass file size can't be known up front), and records the fetched extent as `_downloadedBboxPolygon`. A subtle dashed fuchsia (`#c026d3`) rectangle outline (`road-dl-area` source / `road-dl-area-line` layer, styled like the Municipal Boundaries border) is drawn/updated/removed through `updateUI()` (the single choke point for download / import / clear). File-imported networks draw no outline (no known download area); `clearRoadNetwork()` and `clearRoadDownloadArea()` remove it. The outline is listed in the Layers panel `REFERENCE` band as "Road download area." **Transit Travelshed primitives** (added alongside `computeWalkshed`, sharing its private `_graph`/`runWalkFlood`): `computeWalkCostMap(lngLat, budgetKm)` → `{ distMap: Map<nodeKey, distKm>, snap, accessNodes: [{nodeKey, extraKm} × 2], computeMs, snapMs, floodMs } | null` — the same budget-limited flood as `computeWalkshed` but returns the raw per-node cost map instead of a polygon, plus the two straight-line "access" bridges (snap coord → each bracketing segment endpoint) a caller needs to compute walk time to that exact stop from any other cost map without an O(nodes) turf scan. `polygonizeNodeSet(coords, maxEdgeKm)` — exposes the same concave-hull-with-auto-relax polygonizer `computeWalkshed` uses, for building band isochrones from an arbitrary node-coordinate list. `nodeKeyToCoord(key)` — alias for the internal `keyToCoord`. `snapWalk(lngLat)` — alias for `snapToNetwork(lngLat, "walk")`. `getRoadDownloadExtent()` → `Feature<Polygon> | null`, the last Overpass download's recorded extent (same value that drives the dashed outline). `fetchRoadNetworkForExtent(extentPolygon)` → `Promise<boolean>` — downloads roads for a **caller-supplied** extent instead of the current map view (built on the same `fetchNetworkForBounds` helper `fetchRoadNetwork()` uses); replaces the loaded network wholesale and bumps `_networkEpoch`, so every module cache keyed by epoch (Walkshed, Travelshed) invalidates automatically. **Atomicity note:** `computeWalkCostMap`/`computeWalkshed` are synchronous and atomic — the temp snap-node injection, flood, and cleanup all happen inside one call (cleanup in a `finally`). Callers may `await`-yield BETWEEN calls, never during; the temp-node graph mutation is not async-safe.

### walkshed.js (analysis module)
Registers module `"walkshed"`. Public: `App.getPointWalkshed(pointIdx)` (validated cached walkshed polygon Feature, or null when absent/stale — consumed by `rebuildBuffers`), `App.ensurePointWalksheds()` (synchronously compute any walkshed-flagged points missing/stale in the cache; returns `{ computed, cached, failed, warnings }`). Module-local cache keys entries by `pointIdx` with a `settingsKey` of `coords|minutes|speed|maxEdge|networkEpoch`, so moving a point, changing walk parameters, or reloading the network invalidates the entry automatically.

### lines.js
`lines` (LineString array), `lineBuffers` (Polygon array), `handleLineClick(lngLat)`, `rebuildLineBuffers(radiusMiles)`, `lineBufferUnionPolygon()`, `removeLine(index)`, `clearLines()`, `undoLastLine()`, `cancelLineDrawing()`, `renderLineLayers()`, `setLinePreview(lngLat)`, `updateLineVertex(lineIndex, vertexIndex, lng, lat)`

### routes.js
`routes` (LineString array with `waypoints` property), `routeBuffers` (Polygon array), `handleRouteClick(lngLat)`, `setRoutePreview(lngLat)`, `rebuildRouteBuffers(radiusMiles)`, `routeBufferUnionPolygon()`, `removeRoute(index)`, `clearRoutes()`, `undoLastRoute()`, `cancelRouteDrawing()`, `renderRouteLayers()`, `updateRouteWaypoint(routeIndex, waypointIndex, lng, lat)`

Route features store `properties.waypoints` (user click points) separately from the full street-snapped `geometry.coordinates`. Vertex editing shows handles on waypoints only. OSRM demo server used for routing (`https://router.project-osrm.org/route/v1/driving/`). Preview is throttled: straight line immediately, street-snapped after ~1s of mouse idle (AbortController used to cancel stale fetches).

### polygons.js
`polygons` (Polygon array), `handlePolygonClick(lngLat)`, `removePolygon(index)`, `clearPolygons()`, `undoLastPolygon()`, `cancelPolygonDrawing()`, `renderPolygonLayers()`, `setPolygonPreview(lngLat)`, `updatePolygonVertex(polyIndex, vertexIndex, lng, lat)`

### editing.js
`_editing` (edit state or null), `exitEditMode()`, `_initEditing()` (called from app.js on map load)

### features.js
`refreshFeaturePanel()`, `rerenderForType(type)`, `getTypeDefaultColor(type)`, `showContextMenu(x, y, options)`, `openColorPicker(anchorEl, color, onChange)`, `collectDrawnFeatures()` (returns `[{ feature, type, index }]` across points/lines/routes/polygons — shared with the Layers panel), `UNIVERSAL_GROUP_KEY` (the `attributes.group` key string). The right panel header is a `Features | Layers` tab bar (panes `#fp-tab-features` / `#fp-tab-layers`); the tab toggle calls `App.refreshLayersPanel()` when Layers is shown.

### layers-panel.js
`refreshLayersPanel()` — rebuilds the Layers tab from current map state (no-op when the tab is hidden). Called from the tab toggle, `App.notifyProject()`, and `App.updateAddDataClearIcons()`. No other public API (the manifest, drag-reorder, and ⋯ actions are private to the module).

### feature-attributes.js
`openAttrPopup(featureType, featureIndex, feature)` — opens the floating attributes popup for the given feature. If the same feature is already shown, closes it (toggle). If a different feature was shown, replaces content in place (preserves dragged position). On first open, positions the popup at left: 320px, top: 60px (just right of sidebar, below toolbar).

`closeAttrPopup()` — hides the popup and clears current feature tracking.

`isAttrPopupOpen()` — returns boolean.

`getAttrPopupFeature()` — returns `{ featureType, featureIndex }` or null.

**Popup DOM:** `#fp-attr-popup` (position: fixed, z-index: 9000, width: 320px). Header (`.fp-attr-popup-header`) is draggable; drag state uses `initLeft/initTop` + mouse delta, clamped to keep ≥40px visible on all edges. Window resize re-clamps. Escape key closes. X button (`.fp-attr-popup-close`) closes. Body (`.fp-attr-popup-body`) contains Name row + type-specific field rows using existing `.fp-attr-row` / `.fp-attr-label` / `.fp-attr-input` classes.

**Auto-update on selection:** `selection.js selectFeature()` calls `openAttrPopup` if the popup is already open, so clicking a different feature row or map feature automatically switches the popup content.

**Feature attribute storage:** All feature types (routes, lines, points, polygons) can carry a `properties.attributes` object. Preserved automatically by session cache serialization. Lazy-init means old sessions without the field restore cleanly.

**Service pairing (Route Costing):** The `serviceId` field on route/line attributes is the dedicated pattern-grouping key consumed by the Route Costing module. Routes/lines sharing a `serviceId` string are paired into one Service (1-2 patterns in v1); standalone features become 1-pattern Services. The `direction` field (`Both`, `NB`, `SB`, `EB`, `WB`, `Inbound`, `Outbound`, `Loop`, `CW`, `CCW`) labels each pattern; Route Costing validates that 2-pattern Services use valid opposites (NB+SB, EB+WB, Inbound+Outbound, CW+CCW). The Service field has its own route+line-only autocomplete datalist (`fp-service-datalist`) and inherits color across paired patterns. `serviceId` replaced the previously-unused `routeId` field; old prose referenced an `attributes.group`-based pairing — `group` is now strictly a general-purpose universal grouping field with no Route Costing semantics. `computePerRouteCDI`, `matchRoutesToCSV`, and the RF corridor dropdown still treat each feature as its own route — Service-aware logic is only implemented by Route Costing so far.

**Shared helpers (used by both the per-feature popup and the Attribute Summary module):**

`App.openTimeBandsPopup(feature, anchor, onChange)` — opens the Weekday / Saturday / Sunday time-bands editor for a route/line feature inside the shared `#fp-mini-popup` floating dialog. `anchor` is an optional DOM element used to position the popup. `onChange` fires when the popup closes (used by the badge button to refresh its label). The mounted UI is exactly the same `buildServiceSchedule(attrs)` widget used inline by the per-feature popup.

`App.openRoutePickerPopup(attrs, anchor, onChange)` — opens the route-picker checklist (point's `attributes.associatedRoutes`) inside `#fp-mini-popup`. Mutates `attrs.associatedRoutes` directly. Used by the Routes pill button.

`App.buildOverrideIcons(featureType, feature)` — returns a `<div class="fp-attr-overrides">` element wired with the per-feature override buttons (opacity / buffer / width / offset / reset), or `null` for `label`/`textbox` features (which have no per-feature overrides). Internally calls `App._openFpSlider` for each icon. The per-feature attribute popup and the Attribute Summary module both call this helper so behavior stays in sync.

`App.buildPointRouteBadge(pointFeature)` — returns a small pill button (`.fp-route-badge`) showing the count of associated routes (e.g. `"3 routes"` or `"Add routes"`). Click opens `App.openRoutePickerPopup`. The per-feature point attribute popup also uses this badge in place of the previous inline checkbox grid (less vertical space, click-to-edit).

`App.buildTimeBandsBadge(feature)` — returns a small pill button (`.fp-bands-badge`) showing the per-day band count summary (e.g. `"3 · 1 · 0"` for Weekday · Saturday · Sunday) or `"Add bands"` if empty. Click opens `App.openTimeBandsPopup`. Used by the Attribute Summary module's Bands column.

`App.openMiniPopup(opts)` — generic opener for the shared `#fp-mini-popup` floating dialog. `opts` = `{ title, content (DOM node), anchor (DOM element), onClose (function) }`. Modules embedding their own attribute editors (e.g. Trip Builder's truncated Edit panel) call this rather than reimplementing the dialog shell. `App.closeMiniPopup()` closes whichever content is currently mounted.

`App.buildServiceScheduleEditor(feature)` — returns the Weekday / Saturday / Sunday time-bands editor DOM node (the same widget mounted by the per-feature popup and `App.openTimeBandsPopup`). Modules can append the returned node to their own container to embed the bands UI without duplicating it.

**Mini-popup (`#fp-mini-popup`):** singleton floating dialog used by the time-bands and route-picker badge buttons, and by Trip Builder's Edit panel. 320px wide, z-index 9100, draggable header, Escape to close, anchored beneath the trigger button when opened. Independent from `#fp-attr-popup` so the per-feature popup can stay open simultaneously.

### attribute-summary.js (system module, no public API)
Registered with `id: "attribute-summary"`, `system: true`, `popupWidth: 960`. Opened via `App.openAttributeSummary()`, which is wired to the `#open-attribute-summary` button under the Feature Settings panel (right-side feature panel, below the "Offset overlapping Lines/Routes" toggle). Hidden from the toolbar Analysis menu by the `entry.system === true` skip in `buildAnalysisButtonsHTML()` (`js/app.js`).

**Layout:** single column. One `<section data-section="…">` per feature type (Points / Lines / Routes / Polygons / Text Boxes / Labels). Empty sections are hidden. The Lines and Routes tables share a column model: swatch · name · direction · mode · service · avg speed · run time · bands badge · **copy-attributes button** · override icons. Headers are short (`Avg Spd`, `RunT`, `Bands`) with `title=` tooltips for the full names; CSS Grid (`.as-grid-routelike`) keeps columns aligned in a 960px popup. Points rows show: swatch · name · stop ID · `App.buildPointRouteBadge` · copy-attributes button · override icons. Polygons rows show: swatch · name · notes · copy-attributes button · override icons. Text Boxes / Labels rows show: name · size · background swatch · text swatch (no override icons or copy-attributes button — these are DOM markers, not analytical features; out of scope for Copy Attributes).

**Field bindings:** Every cell input is wired directly to the live feature object — `feature.properties.name`, `feature.properties.attributes[key]`, `feature.properties.color`, `feature.properties.fontSize`, etc. There is no parallel state. After every edit the module calls `App.cache.save()` and `App.refreshFeaturePanel()`. For text/label markers it also calls `App.updateLabelAppearance(idx)` / `App.updateTextBoxAppearance(idx)` so the on-map marker re-renders.

**Live updates while open:** `update(core)` (called by `App.notifyProject()` after feature add/delete and after cache restore) re-renders the entire table list. DOM writes are guarded by `App.popup.isOpen() && App.popup.currentModuleId() === "attribute-summary"`.

**Internal functions:** `renderAll`, `renderPoints`, `renderLineLike` (shared between Lines and Routes), `renderPolygons`, `renderMarkers` (shared between Text Boxes and Labels), plus cell builders `buildSwatchCell`, `buildTextCell`, `buildNumberCell`, `buildSelectCell`, `buildColorSwatchCell`, and `buildServiceIdCell` (text input wired against the shared `fp-service-datalist` autocomplete).

**Copy Attributes (Points / Lines / Routes / Polygons):** a small `.fp-sib`-styled icon button (`buildCopyButton`) on each row opens `#asCopyModal` (a `.rf-weights-modal-overlay` shell, same pattern as Corridor Scoring's Adjust Weights modal) to copy that row's — the source's — attribute values onto one or more other compatible features. Routes and Lines share one target pool (identical attribute schema); Points and Polygons only target their own type. Copyable fields per type live in `COPY_FIELD_DEFS` (`kind: "text"|"select"|"number"|"bands"|"routearray"` drives generic get/has-value/set logic via `copyFieldGetValue`/`copyFieldHasValue`/`copyFieldSetValue`): Point — `group`, `serviceAreaType`, `stopId`, `associatedRoutes` (atomic array copy); Line/Route — `group`, `direction`, `mode`, `avgSpeed`, `runTime`, `service` (atomic Time Bands copy); Polygon — `group`, `notes`. **`serviceId` is deliberately never copyable** — it's the Route Costing / Trip Builder pairing key, and copying it onto other routes/lines would silently merge them into the same Service. A checkbox is disabled (with a "(no value to copy)" hint) when the source has no value for that field — blank source fields are always skipped per-target, never overwriting existing target data with emptiness. An amber `.as-copy-warning` banner (recomputed on every checkbox change) reports how many selected targets already have data for the checked fields before the user applies. `applyCopyAttributes` pushes one `App.undo.push()` snapshot for the whole batch, replicates `serviceAreaType`'s normal side effects (`App.ensurePointWalksheds()` / `App.refreshBuffers()` / `App.notifyProject()`) since it writes the attribute directly rather than through that cell's own `onChange`, then does the same cache-save/refresh/re-render as every other edit. `closeCopyModal()` is also called from the module's `onClose` hook so the modal doesn't reappear on next open if left open when the whole popup is closed.

**No new persistence:** all edits (including Copy Attributes) write through to `feature.properties` / `feature.properties.attributes`, which the session cache already serializes. The module itself does NOT register with `App.cache.registerModule`.

### census.js
`renderCensusOverlay(geos)`, `fetchAllTigerwebFeatures(layerUrl, params)`, `fetchTigerwebGeos(geoLevel, unionFeat)`, `parseGEOID(geoLevel, geoid)`, `fetchACSValues(geoLevel, year, varCode, geoids)`, `fetchACSCountyValues(year, varCode, counties)`, `aggregateWithinUnion(unionFeat, geos, valueMap, aggMode)`, `computeAcsValueOnly(varCode, year, geoLevel)`

### lodes.js
`STATE_FIPS_TO_ABBR`, `getStateFromMapCenter()`, `startDownload(url, filename)`, `lodesData` (Map or null), `lodesFileName`, `setLodesLoadedUI(loaded, name, nRows)`, `parseLodesFromUploadedFile(file)`, `fetchBlocksInternalPointsInUnion(unionFeat)`, `computeEmploymentServedOnly()`

### cache.js
`cache.save()`, `cache.restore()`, `cache.reset()`, `cache.exportToFile()`, `cache.importFromFile(file)`, `cache.registerModule(id, handlers)`, `cache.STORAGE_KEY`

Saves session state (points, lines, routes, polygons, buffer radii, form selections, LODES filename) to `localStorage` under key `"mat-session"`. Routes store full geometry + waypoints; no re-routing needed on restore. Restore runs automatically at end of map load. Save is debounced (500ms) and called after every state mutation. Reset clears localStorage and all app state. LODES data is NOT cached (too large); only the filename is stored as a re-upload hint.

`exportToFile()` serializes current state to a timestamped `.json` file and triggers a browser download. `importFromFile(file)` reads a JSON file (from a hidden `<input type="file">`), validates it, and applies the state — replacing all current features. Both use the same schema as localStorage (`version: 2`). Schema v1 sessions (with `stations` key) are automatically migrated to v2 (`points` key) on restore.

`registerModule(id, { collect(mode), apply(data) })` — analysis modules call this at load time to opt into session persistence. `collect(mode)` returns a serializable object; `mode` is `"light"` (localStorage, skip heavy geometry) or `"full"` (file export, includes geos for choropleth restore). `apply(data)` restores state from a previously collected object. Module state is stored under `state.moduleState[moduleId]` in the JSON schema. The RF module registers as `"rf"` and persists weights, scenario forms, calibration metadata, per-route CDI, system demand result, shared-pool mode flag, and baseline uncertainty percentage (TPI geographies included in full export only). RF session schema is at **v3** (v1/v2 restored with backward-compat migration; v3 adds `sharedPoolMode`; `baselineUncertaintyPct` added gracefully — defaults to 0.25 when absent, no schema version bump needed).

### popup.js
`popup.open(moduleId, modules, buildCore)`, `popup.close()`, `popup.isOpen()`, `popup.currentModuleId()`, `popup.showFloatingWidget(id, htmlFile, options)`, `popup.hideFloatingWidget(id)`, `popup.removeFloatingWidget(id)`, `popup.wire(modules, buildCore)`

Module panels dock over the map but can be dragged. The panel's top edge cannot move above the browser viewport. On mouse release, left, right, or bottom overflow is corrected just enough to leave 120 px horizontally and 32 px vertically of the title bar reachable. Collapsing or expanding anchors the close button and adjacent caret at their current screen location; the compact bar shrinks or expands leftward around those controls.

Floating widget options: `{ position: "bottom-left"|"bottom-right"|"top-left"|"top-right", width: px, title: string }`

### module-buffers.js
Shared analysis-buffer helper. Feature Area Analysis, Transit Coverage, Transit Propensity, Ridership Forecasting, and Corridor Scoring each expose a Buffer distance (mi) input plus a default-off **Use Display Buffers** toggle. The toggle disables the field and reads the selected currently displayed Feature Settings buffers; the default path builds a private buffer set from source geometry at the module's distance. Neither path mutates shared map buffers. See `docs/module-buffer-distance-plan.md` for the full design rationale.

`App.ANALYSIS_BUFFER_DEFAULT_MILES` (0.5 — one shared default for all five modules), `App.ANALYSIS_BUFFER_MIN_MILES` (0.05), `App.ANALYSIS_BUFFER_MAX_MILES` (5).

`App.foldAnalysisUnion(polys)` — folds an array of polygons into one union via `turf.union`; `null` for an empty array.

`App.buildAnalysisBuffer(feature, miles)` — `turf.buffer(feature, miles, {units:"miles", steps:64})`, `null` on failure.

`App.buildDisplayBufferSet(filter)` — returns the displayed route, line, and point buffers for an explicit selection, plus selected polygons unchanged, in the same `{ byType, union, get, count }` shape as `buildAnalysisBufferSet`. It honors Feature Settings and per-feature overrides exactly as the map does.

`App.readAnalysisBufferMiles(elOrId, fallback)` — reads + validates a buffer-distance input; accepts an element id (string), a DOM element, or any object exposing `.value` (so it's testable headless — the golden harness passes a plain `{value: "..."}` object). Returns `fallback` (default `ANALYSIS_BUFFER_DEFAULT_MILES`) when the value is missing, non-numeric, or outside `[MIN, MAX]`.

`App.buildAnalysisBufferSet(filter, miles, opts)` — the core builder. `filter = { routeIndices, lineIndices, pointIndices, polygonIndices }` (any key may be absent; always explicit arrays, consistent with the "never null means all" convention used by every module that calls this). Returns `{ byType: {route:{}, line:{}, point:{}, polygon:{}}, union, get(type, idx), count }`. Routes/lines get a plain `buildAnalysisBuffer`. Points prefer a cached walkshed (`attributes.serviceAreaType === "walkshed"` + `App.getPointWalkshed(pointIdx)` returns a polygon) over a circle at `miles`, unless `opts.preserveWalksheds === false` — a walkshed is a study-area *type*, not a distance. Polygons pass through **unbuffered** (already an area). Hidden features (`properties.hidden`) are skipped.

### app.js
`drawMode`, `registerModule(config)`, `registerProject(config)` (alias for registerModule), `notifyProject()`, `onFeatureDelete()` (hook, see below), `openModulePopup(id)` (opens a registered module's popup by id — used by the Layers panel ⋯ menu), `updateAddDataClearIcons()` (refreshes the Add Data dropdown eye/× icons and the Layers panel; the visibility single-source-of-truth bridge), `_openFpSlider(btn, cfg)` (shared vertical slider popover; `cfg = { value|key, values?, min, max, step, unit, onChange(v) }`), `applyFeatureOpacity(type)`, `featureSettings` (per-type opacity/width/buffer settings, 0–100 opacity), `exitDrawMode()` (clears `drawMode` + button active state + cursor; called by the save functions), `finishDrawing()` (commits the in-progress line/route/polygon via `App.saveLine`/`App.saveRoute`/`App.savePolygon` then runs undo/notify/cache housekeeping — wired to the **Enter** shortcut).

**Keyboard shortcuts** (two `keydown` listeners in app.js): the original handles `Escape` (close popup / exit present / cancel measure), `Ctrl+Z`/`Ctrl+Shift+Z` (undo/redo), `Delete`/`Backspace` (delete selected vertex). A second, isolated listener handles single-key draw-tool toggles — `S` Point, `L` Line, `R` Route, `P` Polygon, `M` Measure, `T` Text Box, `B` Label (each programmatically clicks the matching `.tool-btn[data-mode]`, so a second press toggles off) — and `Enter` to finish the current line/route/polygon. Both listeners skip `INPUT`/`TEXTAREA`/`SELECT`/contenteditable; tool keys also skip modifier combos and when `App.popup.isOpen()`. The core `saveLine`/`saveRoute`/`savePolygon` finishers are exported as `App.saveLine`/`App.saveRoute`/`App.savePolygon` from `lines.js`/`routes.js`/`polygons.js`.

`renderModuleState(opts)` — **shared module-state UI helper** every analysis popup uses to render its stale banner and empty/onboarding state identically. `opts = { statusEl, emptyEl, empty, hint, stale, status, onRerun }` where `statusEl`/`emptyEl` are a DOM element **or** an id string (resolved via `getElementById`; no-ops if absent, so it is safe to call from `update()` while the popup is closed). Precedence: (1) `empty:true` → show `emptyEl` (standardized `.rf-info-box` markup; `hint` is a string or `{ need, action }` — bold need line + muted action line) and hide the pill — this doubles as the first-open onboarding hint; (2) `status: { kind, message }` (`kind` = `running`|`done`|`error` or `""` neutral) → render the pill; (3) `stale:true` → render the `.rf-status-stale` pill with the standardized text "Inputs changed — re-run to update." plus a **Re-run button** that calls `onRerun`; (4) otherwise hide the pill. The pill preserves an existing `<span id="…StatusText">` when present. Each module keeps a thin local `setStatus(msg, kind)` that delegates here, plus (where applicable) a `showStale()` wrapper passing its run function as `onRerun` and a context-aware `emptyHint()`.

`renderModuleInputs(opts)` — **shared collapsible-inputs helper**, the sibling of `renderModuleState()`. `opts = { hostEl, collapsed, summary, label, onToggle }` where `hostEl` is the module's `.rf-settings-col` element **or** an id string. On the first call the host's existing children are moved into a `.module-inputs-body` wrapper and a clickable `.module-inputs-header` is prepended (moving nodes preserves listeners and element ids, so **no module markup changes are needed**). Later calls only update the summary text and collapsed state; omit `collapsed` to leave the current state alone. No-ops on a missing host, so it is safe to call while the popup is closed. Collapsed, the settings column becomes a full-width one-line bar above the results (`.rf-section-row:has(> .module-inputs-collapsed)` flips the row to a column) rather than a 280px stub beside them — this is what makes a narrow/stacked panel usable, since there the settings sit *above* the results and would otherwise push them below the fold. **Modules must collapse on a successful run only** — a failed or bailed-out run has to leave the inputs open, where the user needs them. Each module supplies an `inputsSummary()` returning a one-line description of what was actually run (e.g. `"15 min · 3.1 mph · 2 points"`), so a collapsed panel still answers "what am I looking at". Wired into `walkshed`, `transit-coverage` and `transit-travelshed`; the other modules adopt it as they are narrowed.

**Inputs vs. Settings — a naming convention, not enforced by code.** Analysis modules already split their controls two ways; this gives the split a name and a placement rule for new controls:
- **Inputs** — required selections the user must make. Live inline in the settings column, and collapse after a run (buffer distance, feature checklist, geography level, ACS year).
- **Settings** — optional or expert tuning. Live behind a button, a modal overlay, or a `<details>` block (Adjust Weights, Costing Settings, hull-detail `maxEdge`).

Nothing in the code checks this; it is a convention in the same spirit as the `.rf-`/`.tpi-` prefix rules.

### tpi-scoring.js (window.TPI namespace, not on App)
`TPI.FACTORS` (9-factor array with id, label, weight, acsCodes, compute functions), `TPI.batchFetchACS(geoLevel, year, geoids)`, `TPI.aggregateLodesToGeo(lodesData, geoLevel, geoids)`, `TPI.computeQuintiles(values)`, `TPI.computeComposite(factorScores, weights)`, `TPI.computeTPI(options)` (full pipeline: fetch → normalize → score; accepts optional `options.unionPolygon` to restrict the study area instead of using `App.bufferUnionPolygon()`), `TPI.rescoreFromRaw(rawValues, weights, geoids)` (instant re-score from cached data)

**Default factor weights** (sum = 100): Population Density 35, Employment Density 35, Zero-Vehicle HH 5, Low-Income % 5, Senior 65+ % 5, Disability % 5, Minority % 5, Youth <18% 0, LEP % 5. These are shared defaults for both TPI and RF modules (each module stores its own independent copy in `_weights`).

**Tract-level fallbacks** (within `TPI.computeTPI()`): When `geoLevel === "bg"` and `apportionByArea` is false, TPI runs two fallback passes: (1) *static* — factors flagged `tractOnly: true` (currently only LEP / C16001) are always fetched at tract level and mapped down to block groups via parent-tract GEOID slicing; (2) *dynamic* — after computing raw values, any ACS factor that produced zero finite values at BG level is automatically re-fetched at tract level and remapped. Both fallbacks are skipped when `apportionByArea: true`. All downstream modules (RF included) benefit automatically since they delegate to `TPI.computeTPI()`.

### transit-propensity.js (analysis module)
Registers module `"transit-propensity"` as a popup-based analysis. Opens in a 2-column popup (960px wide): left Settings column (240px fixed) and right Results column (flex). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()` so `update()` can safely fire when the popup is closed. LODES warning icon (`#tpiLodesWarnBtn`, ⚠ button) shows/hides next to the ACS Year selector: shown when `App.lodesData` is null (Employment factor excluded), hidden when LODES is loaded. Visibility updated in `onOpen()` and `update()`.

**Settings column (left):** Geography level dropdown, ACS Year selector (with LODES warning), apportion-by-area toggle, **TPI Features checklist** (checkboxes to select which routes/lines define the normalization pool — only selected features' union polygon is used for quintile computation), **Analysis Corridor dropdown** (filters the geography list display to a specific route/line without re-running the computation), **"Adjust Weights" button** (opens a modal overlay with 9 factor weight sliders; Confirm copies `_pendingWeights` → `_weights` and triggers instant rescore, Cancel discards, Reset to Defaults restores default weights), and "Analyze System" button.

**Results column (right):** Status indicator, scrollable geography list (each row shows geo GEOID + composite TPI score; click to expand and see per-factor quintile bars), aggregate TPI Score for the selected corridor, summary stats (geographies scored, factors included), footnotes (LODES status, apportion mode), GeoJSON and CSV export buttons. Legend auto-shows on the map when analysis runs (no manual "Show Legend" button).

**Internal functions:** `runTPI()`, `runInstantRescore()`, `renderChoropleth(result)`, `clearChoropleth()`, `displayGeographyList(result)`, `updateSummaryStats()`, `updateFootnotes()`, `updateExportButtons()`, `exportGeoJSON()`, `exportCSV()`, `markStale()`, `buildFeatureChecklist()`, `buildCorridorDropdown()`, `getFeatureFilter()`, `buildUnionFromFilter()`, `getGeosInCorridor()`, `openWeightsModal()`, `closeWeightsModal()`, `resetModalToDefaults()`, `syncSlidersToWeights()`, `onModalSliderChange()`, `onModalNumberChange()`, `updateModalWeightSum()`.

**Module-local state:** `_tpiFeatureFilter` (which features selected for normalization pool), `_selectedCorridor` ("all" or "route:N"/"line:N"), `_pendingWeights` (temporary copy while weights modal is open), `_weights`, `_lastResult`, `_stale`, `_running`, `_initialized`, `_apportionByArea`.

**Public API (on `App`):** `App.getTpiWeights()` — returns a shallow copy of TPI's current `_weights` object. Used by the RF module's "Copy From TPI" button to read TPI's live weight settings without tight coupling.

### fta-small-starts.js (analysis module, no public API)
Registers module `"fta-small-starts"` as a popup-based analysis. Opens in a 2-tab popup (960px wide). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()`. All DOM element IDs use `fta` prefix (e.g., `ftaGeoLevel`, `ftaYearSelect`, `ftaCreFile`) to avoid collisions with other modules.

**Tab 1 – Ratings**: 2-column layout. Left column: geography level dropdown, ACS Year selector, "Compute Breakpoints" button, loaded-data indicators (CRE/ESS/LBAR status). Right column: 5 rating cards (`bpItem` class) for Cost Effectiveness (CRE), Existing Ridership (ESS), Transit-Supportive Land Use (LBAR), Mobility Improvement, and Congestion Relief — each showing a color-coded pill (High/Medium-High/Medium/Medium-Low/Low) with numeric value and classification range. CSV export button below ratings.

**Tab 2 – Data Inputs**: 2-column layout. Left column: CRE file upload (3 column selects: route name, annualized cost, new annual riders) and ESS file upload (2 column selects: route name, avg weekday boardings). Right column: LBAR file upload (4 column selects: block GEOID, residential density, employment density, CBD dummy) with county FIPS input and map layer toggle.

**Pill color coding:** `.pill.high` (green), `.pill.mh` (blue), `.pill.med` (yellow), `.pill.ml` (orange), `.pill.low` (red) — defined in `css/style.css`.

**Internal functions:** `_doUpdateBreakpointRatings()` (async, computes all 5 ratings from uploaded data + ACS), `computeCRE()`, `computeESS()`, `computeLbarRatio()`, `switchTab()`, `updateDataIndicators()`, `exportRatingsCSV()`, `restoreRatingsDisplay()`, `saveFtaState()`, `restoreFtaState()`.

**Module-local state:** `CRE_MAP`, `ESS_POINTS`, `LBAR_SITES` (uploaded data), `_lastRatings` (computed rating results for session persistence), `_initialized`, `_activeTab`, `_bpRunning`, `_bpQueued` (concurrency guard). Session persistence via `App.cache.registerModule("fta", ...)` — persists computed ratings only, not raw uploaded file data.

### ridership-scoring.js (window.RidershipModel namespace, not on App)
Scoring engine for the Ridership Forecasting module. Depends on `window.TPI` for demand computation.

`RidershipModel.SERVICE_TYPES` — array of 4 service type presets (local_bus, enhanced_bus, limited_stop, brt), each with `id`, `label`, default operating parameters (`defaultSpeed`, `defaultHeadway`, `defaultSpan`, `defaultStopSpacing`), and a single combined `servicePremium: { low, high }` (fractions; mid derived as average). Default values: local_bus 0/0, enhanced_bus 0.15/0.35, limited_stop 0.15/0.30, brt 0.30/0.65. User-adjusted values are stored in `_servicePremiums` in the module closure and passed via `customServicePremium` param to `applyElasticity`.

`RidershipModel.getServiceType(id)` — returns a service type preset by id.

`RidershipModel.computeCorridorDemand(options)` — wraps `TPI.computeTPI()`, then computes the Corridor Demand Index (CDI) as a population-weighted average of TPI composite scores. Options: `{ geoLevel, year, weights, lodesData, apportionByArea, segmentLengthMiles, onProgress }`. Returns `{ tpiResult, corridorCDI: { value, scored, total }, segments: [...], classification }`. Used in uncalibrated mode only; calibrated mode bypasses this and calls `computeSegments()` directly on cached TPI data.

`RidershipModel.computeSegments(tpiResult, segmentMiles, selectedCorridor)` — segments drawn routes and lines into equal-length chunks, computes a population-weighted CDI for each segment by intersecting chunk buffers with already-fetched TPI geographies. Pure turf.js — no Census API calls. `selectedCorridor` is `"route:N"` / `"line:N"` (only that feature) or `"all"` / falsy (all drawn routes and lines). Segment objects: `{ featureType, routeIndex, segmentIndex, cdi, classification, geoCount, geometry, bufferGeometry, lengthMiles }`.

`RidershipModel.classifyCDI(score)` — returns `{ label, level, cssClass }` for a numeric CDI (High ≥4, Medium 3–3.9, Low-Medium 2–2.9, Low <2).

`RidershipModel.getRouteLength()` — returns total length in miles of all drawn routes via `turf.length()`.

`RidershipModel.computeFrequencyEffect(baseHeadway, newHeadway, elasticity)` — computes the frequency effect multiplier: `(newFreq / baseFreq) ^ elasticity` where `freq = 60 / headway`. Used internally by `applyElasticity()` and externally by the Calibrate tab for headway normalization of observed ridership.

`RidershipModel.computeSpanEffect(baseSpan, newSpan, elasticity)` — computes the service span effect multiplier: `(newSpan / baseSpan) ^ elasticity`. `baseSpan` is the reference span in hours (14h — local bus default); `newSpan` is the scenario span. Default elasticity 0.7 (user-adjustable via `_spanElasticity`; typical range 0.5–0.9 per Currie & Loader 2009, TCRP synthesis). Applied per-scenario in the Scenarios tab; not applied in the Elasticity tab (which is headway/service-type focused). Returns 1 if either span is non-positive.

`RidershipModel.applyElasticity(baseCDI, params)` — applies frequency elasticity and service type premiums to produce `{ low, mid, high }` ridership values. When `baseCDI` is `1.0`, returns pure multipliers (used by Elasticity/Scenarios tabs to separate service effects from baseline uncertainty). Frequency effect formula: `(newFreq / oldFreq) ^ elasticity` where `freq = 60 / headwayMinutes`. Combined multiplier: `freqEffect × (1 + servicePremium[level])` where mid = (low+high)/2. Accepts `customServicePremium: { low, high }` param to override the preset values. Returns `{ low, mid, high, freqEffect, serviceType }`.

`RidershipModel.applyBaselineUncertainty(baseMid, pct)` — applies a symmetric model uncertainty band around a calibrated baseline ridership estimate. Input: `baseMid` (calibrated baseline projection), `pct` (0–1, e.g. 0.25 for ±25%). Returns `{ low: max(0, baseMid*(1-pct)), mid: baseMid, high: baseMid*(1+pct) }`. Returns all zeros if `baseMid` is non-finite or ≤ 0. Used by the Elasticity and Scenarios tabs: the baseline band is computed once, then multiplied element-wise by service effect multipliers from `applyElasticity(1.0, ...)` to produce the final Conservative/Moderate/Optimistic ridership range.

`RidershipModel.buildScenario(params)` — computes operating metrics for one scenario. Key formulas: `vehiclesNeeded = ceil(2 × routeLength / avgSpeed / (headway/60))`, `revHoursPerDay = vehiclesNeeded × span`, `annualRevHours = revHoursPerDay × serviceDays`, `annualCost = annualRevHours × costPerRevHour`. Ridership multiplies the baseline uncertainty band × frequency+service multipliers (from `applyElasticity`) × span effect (from `computeSpanEffect`, baseline span 14h). Returns full scenario object with low/mid/high ridership, cost/boarding, boardings/rev-hr.

`RidershipModel.compareScenarios(scenarios[])` — builds scenario objects for up to 4 scenarios; returns array.

`RidershipModel.calibrateRatio(rows, demandColKey, ridershipColKey)` — ratio-based calibration: `factor = mean(observed / CDI)`. Returns `{ factor, n, rSquared, method: "ratio" }`.

`RidershipModel.calibrateRegression(rows, demandColKey, ridershipColKey)` — OLS regression: `ridership = intercept + slope × CDI`. Returns `{ factor (=slope), intercept, n, rSquared, method: "regression" }`. Requires n ≥ 3.

`RidershipModel.computePerRouteCDI(tpiResult, featureFilter)` — Takes a system-wide TPI result and extracts a CDI score for each individual drawn route and line. Optional `featureFilter` parameter `{ routeIndices: [...], lineIndices: [...] }` restricts which features are processed (null = all features, backward compatible). Uses population-weighted intersection (same pattern as segment analysis) against each feature's own buffer polygon. Returns array of `{ name, featureType ("route"|"line"), featureIndex, cdi, classification, geoCount, lengthMiles, factorBreakdown, compositeRange }`. `factorBreakdown` is an object `{ factorId: avgQuintileScore }` showing population-weighted average quintile per factor for that route. `compositeRange` is `{ min, max }` showing the spread of composite TPI scores across overlapping geographies. These enable the Calibrate tab's expandable factor breakdown display. Enables meaningful CDI variation across corridors (urban routes score high, suburban routes score low), which is required for valid calibration.

`RidershipModel.computeSystemDemand(options)` — Orchestrator that runs `TPI.computeTPI()` once, then computes both the system-wide CDI and per-route CDI array. Options: `{ geoLevel, year, weights, lodesData, apportionByArea, onProgress, unionPolygon, featureFilter }`. When `unionPolygon` is provided, it restricts the TPI study area (passed through to `TPI.computeTPI()`). When `featureFilter` is provided, only the specified routes/lines are included in per-route CDI computation. Returns `{ tpiResult, systemCDI, routeCDIs, geoLevel, year }`.

`RidershipModel.buildUnionFromFeatures(featureFilter)` — Builds a turf union polygon from the buffers of specified features. `featureFilter`: `{ routeIndices: [...], lineIndices: [...] }`. Returns a union Polygon/MultiPolygon, or null. Used to construct a custom study area for `TPI.computeTPI()` when analyzing a subset of drawn features.

`RidershipModel.matchRoutesToCSV(routeCDIs, csvRows, nameCol)` — Case-insensitive exact name matching between drawn features (from `computePerRouteCDI`) and CSV rows. Returns `{ matched: [{ csvRow, routeCDI, csvRowIndex }], unmatched: [...], duplicateWarnings: [] }`. Used in the Calibrate tab "Match Routes" step.

### ridership-forecasting.js (analysis module, no public API)
Registers module `"ridership-forecasting"` as a popup-based analysis. Opens in a 4-tab popup (960px wide). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()`. LODES warning icons (`#rfCalibLodesWarnBtn` in Calibrate tab, `#rfDemandLodesWarnBtn` in Demand tab) show/hide next to the ACS Year selectors: shown when `App.lodesData` is null (Employment factor excluded), hidden when LODES is loaded. Visibility updated in `onOpen()` (every popup open) and `update()` (when LODES uploaded/cleared while popup open) via `updateLodesWarnings()` helper.

**Tab 1 – Calibrate** (now first): 3-step gated workflow. Step 1: "Analyze System" — geography/year settings, a **feature checklist** (checkboxes to select which routes/lines to include in the calibration system — only selected features contribute to quintile normalization and CDI scoring), an **"Adjust Weights" button** (opens a modal overlay with 9 factor weight sliders; buttons: Confirm / Cancel / Reset to Defaults / Copy From TPI), and the "Analyze System" button; calls `RidershipModel.computeSystemDemand()` with the selected feature filter and custom union polygon, and shows a per-route CDI score table with **expandable factor breakdowns** (click any route to see per-factor quintile bars with green/red coloring relative to system averages). Step 2: "Upload CSV" — file picker, auto-column detection via `App.guessHeader()`, "Match Routes" button; calls `RidershipModel.matchRoutesToCSV()` and shows green/red match results. Step 3: "Run Calibration" — uses matched (CDI, ridership) pairs (one per route) for ratio-based or OLS regression calibration. **Headway normalization**: if a headway column is mapped in the CSV, observed ridership is divided by `computeFrequencyEffect(refHeadway=30, routeHeadway, elasticity)` before fitting, stripping frequency variation so the calibration factor isolates pure demand; a blue `.rf-note` info box shows normalization details. When shared-pool mode is active, a second `.rf-note` (`rfCalibSharedPoolNote`) confirms the calibration was auto-refitted from shared-pool CDI values. Each step is unlocked by completing the previous one. Calibration factor persists across tabs. Calibration data (coefficients + weights + per-route CDI + `baselineUncertaintyPct`) is exportable/importable as standalone v3 JSON (v2 also supported on import; missing `baselineUncertaintyPct` defaults to 0.25). RF weights are independent from TPI weights; `_weights` is stored in the module closure and defaults to `TPI.getDefaultWeights()`.

**Tab 2 – Demand**: "Target System" section at top with a **"Same system as calibration" toggle** and a **feature checklist** for selecting demand system features. When "same system" is checked, the feature checklist (including the shared-pool checkbox) is hidden and calibration TPI data is reused (no Census API calls). When unchecked, the feature section is shown and one of three paths runs: **(A)** same system (reuse calibration TPI); **(B-shared)** `_sharedPoolMode=true` — `runSharedPoolAnalysis()` runs one combined TPI covering both calibration and demand features' union polygon with `featureFilter:null`, then partitions `result.routeCDIs` by filter into `_sharedCalibPerRouteCDI` and `_demandPerRouteCDI`, and auto-refits `_calibration` via `refitCalibrationFromCDI()`; **(B)** separate pool — fresh `computeSystemDemand()` scoped to selected demand features only. **"Shared pool normalization" checkbox** (`rfSharedPoolMode`): visible when "Same system" is unchecked, defaults to checked when the user unchecks "Same system" — recommended for cross-system calibration where absolute density levels differ. An ⓘ info button toggles an inline explanation. Below the system section, a corridor dropdown ("Analysis corridor") lets the user select a specific route/line or the system-wide CDI. Segment analysis calls `RidershipModel.computeSegments()` on the active TPI result — scoped to the selected corridor. If neither calibration nor demand system analysis has been run, `computeCorridorDemand()` is called (full TPI fetch, legacy uncalibrated behavior). Renders CDI choropleth on map (Blues color ramp), segment overlay, and floating legend widget (`projects/ridership-legend.html`). CDI info button (ⓘ) toggles inline explanation. GeoJSON and CSV export enabled after analysis.

**Tab 3 – Elasticity**: Service type dropdown, baseline/proposed headway inputs, frequency elasticity slider (0.1–1.0, default 0.60), **service span elasticity slider** (`rfSpanElastSlider`, 0.1–1.0, default 0.70; typical range 0.5–0.9), **baseline uncertainty slider** (0–60%, step 5, default 25%). Note: span elasticity is stored in `_spanElasticity` but span effect is only applied in the Scenarios tab (which has an explicit span input per scenario); the Elasticity tab displays headway and service-type effects only. Right column: **user-adjustable service type premium sliders** (Conservative % and Optimistic %, 0–150% range, step 5) that store per-service-type values in `_servicePremiums` — switching service types loads that type's saved values; mid is derived as the average. Uses `getActiveCDI()` (see below) so the CDI automatically reflects the selected corridor. Calculation flow: (1) compute `baseMid` using the full calibration formula `max(0, CDI×factor×length, (intercept+CDI×factor)×length)`, (2) apply `RidershipModel.applyBaselineUncertainty(baseMid, _baselineUncertaintyPct)` to get `{low, mid, high}` baseline band, (3) extract pure service multipliers via `RidershipModel.applyElasticity(1.0, params)` with `customServicePremium: _servicePremiums[stId]`, (4) multiply aligned: `finalLow = baseBand.low × mult.low`, etc. Displays two result cards: "Baseline Projection (before service effects)" showing the uncertainty band, and "Projected Ridership (with service effects)" showing the final Conservative / Moderate / Optimistic range. Recalculates instantly on any input change (no API calls).

**Tab 4 – Scenarios**: 4-column side-by-side grid (A|B|C|D), each column containing identical input fields (name, service type, headway, span, speed, cost/rev-hr, service days). All 4 scenarios are visible simultaneously — no sub-tabs. Input IDs use `_0`/`_1`/`_2`/`_3` suffixes. Uses `getActiveCDI()` for the active corridor CDI. Applies baseline uncertainty band once (`applyBaselineUncertainty`), then for each scenario extracts pure service multipliers via `applyElasticity(1.0, ...)` and span effect via `computeSpanEffect(14, scenarioSpan, _spanElasticity)`, and multiplies all three aligned (`finalLow = baseBand.low × serviceMult.low × spanEffect`, etc.). "Build Scenarios" calls `RidershipModel.buildScenario()` for each and renders a comparison table with mid rows highlighted. CSV and JSON export enabled after build (exports include `baselineUncertaintyPct` for reproducibility).

**`getActiveCDI()`** (internal helper): Returns the CDI value for the currently selected corridor. Prefers the demand context (`_demandPerRouteCDI`) over the calibration context (`_perRouteCDI`). Falls back through `_demandSystemResult.systemCDI`, `_systemResult.systemCDI`, then `_lastResult.corridorCDI`. This ensures Elasticity and Scenarios tabs use CDI values from the target system's independent normalization pool when available.

**Module-local state**: `_lastResult` (legacy demand result from Demand tab), `_systemResult` (calibration-context result from `computeSystemDemand()`), `_perRouteCDI` (calibration-context per-route CDI array), `_calibFeatureFilter` (which features selected for calibration), `_demandSystemResult` (demand-context TPI + CDI results; in shared-pool mode this IS the shared result), `_demandPerRouteCDI` (demand-context per-route CDI; in shared-pool mode filtered from shared result), `_demandFeatureFilter` (which features selected for demand), `_demandUseSameSystem` (boolean, reuse calibration TPI for demand), `_sharedPoolMode` (boolean, use combined calibration+demand normalization pool), `_sharedCalibPerRouteCDI` (calibration-context per-route CDI filtered from shared pool result), `_sharedSystemResult` (the full shared-pool TPI result; same object as `_demandSystemResult` when shared pool ran), `_matchResult` (CSV match result), `_selectedCorridor` ("all" or "route:N"/"line:N"), `_calibration` (calibration coefficients; when headway-normalized includes `headwayNormalized`, `refHeadway`, `normElasticity`, `headwayNormCount`; when refitted from shared pool includes `sharedPoolMode: true`), `_calibData` (uploaded CSV rows), `_baselineUncertaintyPct` (number 0–1, default 0.25; ±% model uncertainty applied to calibrated baseline before service multipliers), `_spanElasticity` (number 0.1–1.0, default 0.70; power-curve exponent for service span effect applied in Scenarios tab; user-adjustable via `rfSpanElastSlider`; persisted in session cache), `_servicePremiums` (object keyed by service type id, each `{ low, high }` fraction; user-adjustable via sliders, defaults mirror `SERVICE_TYPES.servicePremium`; persisted in session cache and calibration export), `_normalizeByLength` (boolean, scale ridership by corridor length), `_scenarios` (array of 4 scenario param sets), `_activeScenario`, `_stale`, `_calibStale`, `_demandStale`, `_running`, `_initialized`, `_apportionByArea`, `_activeTab`, `_weights` (independent factor weights, defaults to `TPI.getDefaultWeights()`), `_pendingWeights` (temporary copy while the Adjust Weights modal is open).

**Internal helpers** (ridership-forecasting.js, not on RidershipModel): `combineFeatureFilters(a, b)` — unions two feature filters (null = all features; either null → result is null); `filterRouteCDIs(allRouteCDIs, filter)` — filters a routeCDIs array to entries matching a feature filter; `refitCalibrationFromCDI(calibPerRouteCDI)` — re-runs the calibration fit from `_matchResult` data using updated CDI values from the shared pool, returns a new calibration object with `sharedPoolMode: true`, or null if insufficient data; `runSharedPoolAnalysis(geoLevel, year, textEl)` — orchestrates the shared-pool path: combines filters, builds union, calls `computeSystemDemand` once, partitions results, auto-refits calibration; `updateLodesWarnings()` — shows/hides LODES warning icons (⚠) based on `App.lodesData` state (called from `onOpen()` and `update()`).

### corridor-scoring.js (analysis module, no public API)
Registers module `"corridor-scoring"` as a popup-based analysis. Opens in a 2-column popup (960px wide). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()`. All DOM element IDs use the `cs` prefix (e.g., `csGeoLevel`, `csYearSelect`, `csFeatureList`, `csWeightsModal`, `csScoreBtn`). CSS classes use the `.cs-` prefix for module-specific styles; visual classes from TPI/RF (`.tpi-slider`, `.rf-route-factor-*`, `.rf-settings-col`, `.rf-results-col`, `.rf-status`, `.pill.*`) are reused where purely presentational.

**Purpose:** Surfaces the per-route CDI engine as a first-class endpoint — a ranked, objective composite score per draft/hypothetical corridor. Distinct from TPI (geography-focused) and Ridership Forecasting (ridership-focused), which both use per-route CDI as an intermediate step rather than the final product. Normalization pool is the union of only the selected routes/lines, producing apples-to-apples comparison within the user's working set.

**Settings column (left):** Geography level dropdown (block group / tract), ACS Year selector (with LODES warning icon), apportion-by-area toggle, corridor checklist (routes + lines only — points/polygons are not applicable to corridor scoring), Select all / Clear links, Adjust Weights button (opens modal overlay with 9 factor sliders + Confirm / Cancel / Reset to Defaults), Score Corridors button.

**Results column (right):** Status indicator (with stale / done states), ranked corridor table (columns: Rank, Corridor with R/L badge, Score, Classification pill, expand caret) — each row toggles open a hidden `.cs-row-details` row containing a factor breakdown (one row per active TPI factor with colored quintile bar, system-avg marker, raw quintile score; green when corridor > system, red when <, neutral when close). CSV + GeoJSON export buttons enable on successful run and disable on stale/clear.

**Map rendering:** A line source/layer (`corridor-scoring-routes` / `corridor-scoring-routes-layer`) renders the scored corridors using their source geometry from `App.routes[i]` / `App.lines[i]`, colored by composite CDI via a 5-class Blues interpolation. Hover popup shows rank, name, score, and classification. Floating legend (`projects/corridor-scoring-legend.html`) auto-shows at bottom-left on a successful score and is hidden on Clear / Reset Session via the module's `clear` lifecycle hook.

**Internal functions:** `runScoring()` (wraps `RidershipModel.buildUnionFromFeatures` + `RidershipModel.computeSystemDemand`, sorts result by CDI desc, stores `_lastResult`), `buildFeatureChecklist()` (routes + lines only), `getFeatureFilter()`, `buildUnionFromFilter(filter)` (delegates to `RidershipModel.buildUnionFromFeatures`), `applyFeatureFilterToCheckboxes(filter)` (used on session restore to re-check boxes), `renderResultsTable(result)`, `buildFactorBreakdownHTML(routeCDI, systemAvgs, effectiveWeights)`, `computeSystemFactorAverages(tpiResult)`, `renderMapChoropleth(result)`, `clearMapChoropleth()`, `exportCSV()`, `exportGeoJSON()`, `setExportButtonsEnabled(bool)`, `markStale()`, `setStatus(msg, kind)`, `clearAll()` (wired to the registered `clear` hook), plus the weights modal handlers `buildWeightSliders`, `syncSlidersToWeights`, `onModalSliderChange`, `onModalNumberChange`, `updateModalWeightSum`, `openWeightsModal`, `closeWeightsModal(confirm)`, `resetModalToDefaults`.

**Module-local state:** `_weights` (independent factor weights; defaults to `TPI.getDefaultWeights()`), `_pendingWeights` (temporary copy while weights modal is open), `_featureFilter` (`{ routeIndices, lineIndices }` or null; captured at last scoring run), `_lastResult` (`{ routeCDIs, tpiResult, systemCDI, geoLevel, year, apportionByArea, unionPolygon, featureFilter, weights }`), `_stale`, `_running`, `_initialized`, `_apportionByArea`.

**Session persistence** via `App.cache.registerModule("corridor-scoring", { collect, apply })` — persists `weights`, `featureFilter`, `apportionByArea`, `geoLevel`, `year`, and `lastSummary` (the ranked `routeCDIs` array plus run metadata) to localStorage. Full-mode export (JSON file) additionally includes a pre-computed `systemFactorAverages` map and `effectiveWeights` so the factor breakdown comparison bars restore correctly on file import without needing the raw TPI `factorScores` Map. On restore, the map choropleth + legend are re-rendered from `routeCDIs` + source geometries (no Census API calls required). Schema version: **1**.

### route-costing.js (analysis module, no public API)
Registers module `"route-costing"` as a popup-based analysis. Opens in a 2-column popup (960px wide). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()`. All DOM element IDs use the `rc` prefix (e.g., `rcServiceList`, `rcSettingsModal`, `rcCostBtn`, `rcResultsTable`, `rcSummaryTable`). CSS classes use the `.rc-` prefix; visual classes from `.rf-` (settings column, results column, status pill, section title, weights modal) are reused for layout consistency.

**Purpose:** High-level transit service costing based on user-entered attributes (length via turf, avgSpeed, direction, service bands). No Census, LODES, or TPI dependency — purely attribute-driven. Produces daily/annual platform hours, revenue hours, trips, and operating cost per Service plus a system summary.

**Service assembly:** `buildServicesFromFeatures()` walks `App.routes` + `App.lines`. Features with a non-empty `attributes.serviceId` are bucketed together (max 2 per Service in v1); features without a `serviceId` become standalone 1-pattern Services. `validateService(svc)` attaches blocking warnings for: 3+ patterns assigned to one Service, 2-pattern Services without valid opposite directions (valid pairs: NB+SB, EB+WB, Inbound+Outbound, CW+CCW), 1-pattern Services whose direction is a cardinal (NB/SB/etc.) rather than Both/Loop/CW/CCW, missing `avgSpeed`, or no service bands with a headway on any pattern. Blocked services render red in the checklist with a ⚠ tooltip. (The Service field replaced an earlier prototype that bucketed by `attributes.group`; the universal `group` field is now strictly general-purpose.)

**Runtime input mode:** Costing Settings includes a radio (avg speed / run time). In `"speed"` mode, one-way runtime = `lengthMiles / avgSpeed`. In `"runTime"` mode, one-way runtime = `pattern.runTime / 60` (the `runTime` attribute in minutes set on each route/line in the Attributes popup). `oneWayRuntimeHrsFromSettings(pattern, settings)` centralizes this branch. Validation in `validateService()` is mode-aware — missing speed generates a warning in speed mode; missing run time generates a warning in run time mode. The Attributes popup also shows a live **Cycle est.** read-only row that displays both the speed-derived and manual run-time estimates side by side.

**Cost math** (pure functions):
- `oneWayRuntimeHrs(pattern)` = speed-based (legacy helper).
- `oneWayRuntimeHrsFromSettings(pattern, settings)` = mode-aware; used by all current costing paths.
- `computeRoundTrip(svc, settings)` → `{ rtHrs, rtMiles, oneWays[] }`. 2-pattern Services sum both one-ways. 1-pattern "Both" doubles the one-way. 1-pattern Loop/CW/CCW uses one-way as the full cycle.
- `computeLayoverHrs(rtHrs, settings)` — minutes mode: `layoverValue / 60`; percent mode: `rtHrs × layoverValue / 100`.
- `cycleHrs = rtHrs + layoverHrs`. `tripsPerCycle` = 2 for paired/Both, 1 for Loop.
- Per band: `trips = ceil(hours × 60 / headwayMin)`; blank/zero headway = "no service in band" (skipped). Midnight-wrap bands supported. `platHrs = revHrs + layoverHrs + deadheadHrs` (where `deadheadHrs = revHrs × deadheadPct/100`).
- Each day type (weekday/saturday/sunday) gets its own `minHeadway → peakVehiclesRaw/Rounded`. Service peak fleet = max across day types.
- `computeSystemSummary(serviceResults, settings, intGroups)` aggregates per-day-type and total metrics. Computes `fleetSumRounded`, `fleetSumRaw` (theoretical interline min), and calls `computeInterlinesEffect()` to apply declared interline pools (currently UI-disabled). `fleetWithSpares` uses the interlined fleet when pools are active, otherwise the standalone fleet.
- `computeInterlinesEffect(serviceResults, intGroups)` — **built but not exposed** (Interlines button disabled). For each group with ≥2 members: `poolMax[day] = max(member peaks)`, `savings[day] = sum(member peaks) − poolMax`. Returns per-group day results and aggregate `savingsPerDay`.

**Rendering:** `renderResultsTable(serviceResults)` outputs four sections: a Skipped block (red warning rows), then three per-day-type tables (Weekday / Saturday / Sunday via `renderPerDayTable(rows, day)`), then a Total (annualized) table via `renderTotalTable(rows)` with expandable `tr.rc-row-details` containing `buildBandBreakdownHTML(r)`. Per-day columns: Service, RT mi, Frequency, Run time (min), Cycle time (min), Trips, Daily rev-hr, Daily plat-hr, Annual cost, Peak pullout. Total columns: Service, RT mi, Annual trips, Annual rev-hr, Annual plat-hr, Annual cost, Peak pullout. `renderSummaryTable(summary)` renders a 5-column table (metric + Wk/Sa/Su/Total). When interline groups are active (currently disabled), pool savings rows and "Fleet — after interlines" replace the theoretical "Fleet — interlined min / Interline opportunity" rows.

**Costing Settings modal** (`rcSettingsModal`): cost per platform hour, deadhead %, layover mode radio (`minutes` / `percent`) with a dynamic unit label (`rcLayoverValueLabel`), layover value, days per year Wk/Sa/Su with a live sum that turns red over 366, fleet spare ratio %, cost basis year free-text label, runtime input mode radio (`rcRuntimeMode`: `speed` / `runTime`). Confirm / Cancel / Reset to Defaults. Confirm re-validates checklist and marks `_lastResult` stale.

**Interlines modal** (`rcInterlinesModal`): **UI built but button is disabled** (`disabled` attribute on `#rcInterlinesBtn`). The modal renders group cards (name input, Wk/Sa/Su day checkboxes, member service checkboxes). `openInterlinesModal`, `closeInterlinesModal(confirm)`, `renderInterlinesModal` are all present in the closure but unreachable while the button is disabled. Do not enable without reviewing the fleet-pooling logic.

**Internal functions:** `buildServicesFromFeatures`, `validateService`, `directionSummary`, `hasBlockingWarnings`, `buildServiceChecklist`, `getSelectedServices`, `getSelectedServiceKeys`, `oneWayRuntimeHrs`, `oneWayRuntimeHrsFromSettings`, `computeRoundTrip`, `computeLayoverHrs`, `parseBandTime`, `computeService`, `computeSystemSummary`, `computeInterlinesEffect`, `renderResultsTable`, `renderPerDayTable`, `renderTotalTable`, `buildBandBreakdownHTML`, `renderSummaryTable`, `showResultsSection`, `setExportEnabled`, `exportCSV`, `openSettingsModal`, `closeSettingsModal(confirm)`, `resetSettingsToDefaults`, `syncSettingsToInputs`, `readSettingsFromInputs`, `updateLayoverUnitLabel`, `updateDaysSum`, `openInterlinesModal`, `closeInterlinesModal(confirm)`, `renderInterlinesModal`, `runCosting`, `markStale`, `clearAll`, `setStatus`.

**Module-local state:** `_settings` (object matching `DEFAULT_SETTINGS`, includes `runtimeMode`), `_pendingSettings`, `_lastServices`, `_lastResult` (`{ services, summary, settings }`), `_restoredSelectedKeys`, `_interlineGroups` (array of interline group objects — persisted but UI-disabled), `_pendingInterlines`, `_ilGroupCounter`, `_stale`, `_running`, `_initialized`.

**Session persistence** via `App.cache.registerModule("route-costing", { collect, apply })` — persists `settings`, `selectedKeys`, `interlineGroups`, and `lastSummary` (per-Service totals with `perDay` structure; band breakdown dropped). Schema version: **2** (v1 summaries silently dropped on restore; `_interlineGroups` defaults to `[]` when absent). `restoreRcState` migrates legacy `"group-…"` selectedKeys to `"service-…"`.

**Not in v1:** 3+ patterns per Service, fare/revenue modeling, per-Service overrides for cost/deadhead/layover, inflation. Interlines fleet pooling is implemented in the JS but the UI button is disabled pending logic review.

### trip-builder.js (analysis module, no public API)
Registers module `"trip-builder"` as a popup-based analysis. Opens in a 2-column popup (1100px wide). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()`. All DOM element IDs use the `tb` prefix (`tbServiceList`, `tbHeader`, `tbActions`, `tbGenerateBtn`, `tbResults`, `tbExportRow`, `tbExportCSV`, `tbEmptyState`, `tbStatus`/`tbStatusText`). CSS classes use the `.tb-` prefix; visual classes from `.rf-` (settings column, results column, status pill, section title, info box) and `.rc-` (paired/solo pills, warning badge) are reused for visual consistency.

**Purpose:** Generates a high-level trip schedule (Start / End times) per direction per day type from each Service's underlying Time Bands, Frequency, and Run time / Avg speed attributes. Distinct from Route Costing (which aggregates trips into rev-hr / plat-hr totals) — Trip Builder shows the individual trip-level implications of the band choices. Not intended to be a true GTFS-quality schedule (no nodes / time points). May feed into Route Costing in the future for higher-fidelity rev-hr.

**Service assembly:** Identical to Route Costing — `attributes.serviceId` buckets routes/lines into 1-2-pattern Services; standalone features become 1-pattern Services. Same direction-pair validation (`NB+SB`, `EB+WB`, `Inbound+Outbound`, `CW+CCW`). The assembly code is duplicated rather than shared (two consumers; extracting a helper is premature).

**Settings column (left):** Single-select Service list (`#tbServiceList`). Each row shows a 4px color stripe (from the first pattern's `feature.properties.color`), the Service name with optional warning badge, a paired/solo pill, the direction summary, and pattern count. Clicking a row selects it and rebuilds the right column. Blocked services (with validation errors) are red and not clickable.

**Results column (right):** Status pill, Service header (`#tbHeader`) containing the at-a-glance **summary table** (3 rows × 4 columns: Span / Frequency / Run Time / Avg Speed for Weekday / Saturday / Sunday), an **Edit button** (`#tbEditBtn`) that opens the truncated Edit mini-popup, and a chevron toggle that reveals the per-pattern details drawer (one-way runtime + source label, length, headway summary like `WD 15/30 · Sa 30 · Su 60`). Below the header: the **Generate Trips** button (`#tbGenerateBtn`), per-day trip tables, and a CSV export button. The header card's left border and each direction column's left border are colored by the underlying feature's color. Empty state (`#tbEmptyState`) shows when no Service is selected.

**Header summary table (`summarizeService` helper):** For each day type, the helper rolls up across all patterns: **Span** = merged band intervals (touch-or-overlap merged so contiguous bands collapse to a single range; gaps preserved with comma separators e.g. `"6:00 – 10:00, 15:00 – 19:30"`; midnight-wrapping bands display modulo 24); **Frequency** = sorted unique non-zero headways joined with `/` (e.g. `"15/30 min"`); **Run Time** and **Avg Speed** = pattern attributes (run time prefixed with `~` when derived from speed × length). For paired services with mismatched per-pattern values, Run Time / Avg Speed are slash-joined (e.g. `"30 / 28 min"`). Rows for days with no bands render with `—` cells in muted style.

**Edit mini-popup (`openEditPopup`):** Mounts inside the shared `#fp-mini-popup` via `App.openMiniPopup`. For each pattern, renders a block with Direction (select), Run time (number), Avg speed (number), and the embedded `App.buildServiceScheduleEditor(feature)` time-bands editor. Paired services show two stacked blocks separated by a dashed rule. All inputs mutate `feature.properties.attributes` directly (matching the per-feature popup's behavior). A capture-free `input`/`change` listener on the popup body (1) saves to cache, (2) marks generated trips stale via `_stale` + status pill, and (3) re-runs `buildServicesFromFeatures` and `renderServiceHeader` so the summary table updates live. On popup close, `App.notifyProject()` fires to broadcast changes to other modules (Feature Panel, Attribute Summary).

**Trip generation algorithm:** For each pattern × day type, walk `attributes.service[day]` bands. For each band with non-zero `frequency`, generate trips at `band.from`, `band.from + frequency`, `band.from + 2*frequency`, ..., while `t < band.to`. End time = start + one-way runtime. Bands wrapping past midnight are handled by adding 1440 minutes to `band.to` before iterating; display formats `t mod 1440` (no "+1d" annotation). Trips whose end exceeds `band.to` are still generated (per Route Costing convention).

**Runtime resolver:** `oneWayRuntimeMin(pattern)` returns `pattern.runTime` (minutes) when `> 0`; otherwise falls back to `(lengthMiles / avgSpeed) × 60` when both are positive; otherwise `0` (Service is blocked with a warning). `runTime` always wins when present — there is no per-module setting analogous to Route Costing's `runtimeMode`.

**Direction column resolution:** For 2-pattern Services, each pattern produces one column labeled with its actual direction (`NB`, `SB`, `Inbound`, etc.). For 1-pattern `Both`, two derived columns labeled **`Outbound*`** and **`Inbound*`** (asterisks indicate derivation) are generated from the same pattern's bands — trips depart simultaneously. For 1-pattern `Loop` / `CW` / `CCW`, one column labeled with the pattern's direction. Column ordering: `NB`/`EB`/`Outbound`/`CW`/`Outbound*` rank 1; `SB`/`WB`/`Inbound`/`CCW`/`Inbound*` rank 2. Paired CW/CCW shows side-by-side; solo CW (or CCW) shows a single column.

**Trip deletion:** Each row has a 🗑 button that splices that single trip out of the in-memory array and re-renders. Clicking **Generate Trips** again regenerates from scratch, wiping all manual deletions for that Service. Manual deletions for one Service do not affect any other Service's trip array. There is no "Add Trip" UI in v1.

**CSV export:** One row per trip. Columns: `Service, Day, Direction, Trip #, Start, End, Runtime (min)`. Direction includes the `*` suffix for derived columns. Filename: `trip-builder_<service-name>_<timestamp>.csv`.

**Internal functions:** `collectPattern`, `buildServicesFromFeatures`, `validateService`, `directionSummary`, `hasBlockingWarnings`, `oneWayRuntimeMin`, `runtimeSource`, `resolveColumns`, `parseHHMMtoMin`, `formatMin`, `generateTripsForPattern`, `generateAllTrips`, `buildServiceList`, `selectService`, `getSelectedService`, `renderRightSide`, `renderServiceHeader`, `summarizeService`, `mergeIntervals`, `buildSummaryTableHTML`, `getFeatureFromPattern`, `buildEditPatternBlock`, `openEditPopup`, `listHeadways`, `renderResults`, `deleteTrip`, `runGenerate`, `setExportEnabled`, `csvRow`, `exportCSV`, plus the lifecycle quartet (`init`, `onOpen`, `onClose`, `update`) and `clearAll`.

**Module-local state:** `_services` (last `buildServicesFromFeatures()` result), `_selectedKey` (currently selected `Service.key` or null), `_tripsByService` (`{ key → { weekday, saturday, sunday: [{ direction, label, withAsterisk, color, patternName, runtimeMin, trips: [{ startMin, endMin }] } ] } }`), `_detailsOpen` (header expand state), `_stale`, `_initialized`.

**Session persistence** via `App.cache.registerModule("trip-builder", { collect, apply })` — persists `selectedKey` and `tripsByService` (small, structurally simple). Schema version: **1**. The `update()` lifecycle hook marks state as stale when features change so the user is prompted to re-generate.

**Not in v1:** Manual add-trip UI, layovers between trips, per-pattern offset for paired patterns starting at different times (each pattern's bands drive its own trips already, so users wanting an offset enter it in the bands), block scheduling, integration with Route Costing for higher-fidelity rev-hr.

### title-vi-engine.js (window.TitleVI namespace, not on App)
Pure calculation engine for the Title VI Service Equity module. No DOM access. Depends on `turf` (CDN) and `window.App` (for feature resolution).

`TitleVI.defaultPolicy()` — returns a fresh policy profile object with major-change rules (route miles %, revenue hours %, span %, route elimination, fare %), equity thresholds (disparate impact and disproportionate burden in percentage points), geography level, ACS year, and buffer distance.

`TitleVI.createScenario(name)` — returns a new scenario object with `alterations: []` array and `impactMethod: "service_loss_area"`.

`TitleVI.createAlteration(name)` — returns a new alteration object: `{ name, changeType ("alteration"|"elimination"|"new_route"), before (feature ref or null), after (feature ref or null), computed (filled by computeAlterationMetrics), manual: { revenueHours, spanHours, fare } }`. Feature refs are `{ featureType: "route"|"line", featureIndex, featureName }`.

`TitleVI.computeDivergence(beforeFeature, afterFeature, divergenceThresholdMiles, sampleIntervalMiles)` — samples points every ~0.05 mi along the "before" route and measures distance to the nearest point on the "after" route via `turf.nearestPointOnLine()`. Points farther than the threshold (default 0.1 mi / 528 ft) are flagged as divergent. Returns `{ alteredPct, alteredMiles, totalMiles, divergentSegments: [{ startMile, endMile, maxDivergenceFt }] }`.

`TitleVI.computeServiceChangeArea(beforeFeature, afterFeature, bufferMiles)` — buffers both routes at `bufferMiles`, then uses `turf.difference()` to compute service loss area (before minus after) and service gain area (after minus before). Returns `{ serviceLossArea, serviceGainArea, beforeBuffer, afterBuffer }`.

`TitleVI.computeAlterationMetrics(alteration, bufferMiles, divergenceThresholdMiles)` — orchestrates all metric computation for a single alteration. Resolves feature references, computes route miles, divergence (% altered), service change areas, and manual metric % changes. Handles all three change types: `alteration` (both before and after), `elimination` (before only, 100% altered, entire buffer is loss), `new_route` (after only, entire buffer is gain). Returns computed metrics object stored on `alteration.computed`.

`TitleVI.computeRouteMetrics(route)` — legacy CSV-based route metrics (kept for backward compat).

`TitleVI.evaluateMajorChange(policy, scenario)` — evaluates all enabled major-change rules against each alteration's computed metrics. Returns `{ triggered, ruleResults: [...], altMetrics: [...] }`.

`TitleVI.buildImpactedArea(scenario)` — constructs the impacted area geometry based on `scenario.impactMethod`. Methods: `service_loss_area` (default — union of service loss polygons from all alterations), `service_change_area` (union of both loss and gain areas), `full_route_buffer` (all App route/line buffers), `user_polygon` (drawn polygons). Falls back to before-route buffers if no service change areas are computed.

`TitleVI.fetchDemographics(core, unionGeom, geoLevel, year)` — fetches ACS race/ethnicity (B03002) and poverty (B17001) data for census geographies intersecting the union polygon. Includes tract-level fallback for poverty at block-group level. Returns `{ totalPop, minorityPop, minorityShare, lowIncomePop, lowIncomeShare, geoCount, geos }`.

`TitleVI.evaluateFindings(impactedDemographics, baseline, policy)` — compares impacted area demographics against the system baseline. Returns findings for both minority (Disparate Impact) and low-income (Disproportionate Burden) with `diffPpt`, `exceedsThreshold`, and `finding` string.

`TitleVI.compareScenarios(scenarioResults)` — builds a comparison array from multiple analyzed scenarios for the comparison table.

### title-vi.js (analysis module, no public API)
Registers module `"title-vi"` as a popup-based analysis. Opens in a 3-tab popup (960px wide). All state is private to the IIFE closure. DOM writes guarded with `isPopupVisible()`. All DOM element IDs use `tvi` prefix. CSS classes use `.tvi-` prefix.

**Tab 1 – Policies & Inputs**: 2-column layout. Left column: policy name, major service change rules (checkboxes + threshold inputs), equity thresholds (DI and DB in ppt), geography level and ACS year. Right column: route alteration card system ("+&nbsp;Add Alteration" button, cards with name input, change-type dropdown, before/after feature dropdowns, auto-computed metrics display, manual inputs for revenue hours/span/fare), and impacted area method radio group (service loss area, all affected area, full route buffer, drawn polygons).

**Tab 2 – Analysis**: 2-column layout. Left: system baseline section (feature checklist for baseline union, "Compute Baseline" button, baseline results box showing minority/low-income shares), equity analysis section ("Run Equity Analysis" button, shared stale banner via `App.renderModuleState()` rendered into `#tviStaleWarning` (now `.rf-status`, with a Re-run button; the old `.tvi-stale-banner` style was removed), status text). Right: results display (Major Service Change verdict pill + per-rule breakdown, Minority/Disparate Impact card with impacted vs baseline shares and threshold comparison, Low-Income/Disproportionate Burden card, summary stats, export buttons for CSV and GeoJSON).

**Tab 3 – Scenarios**: Scenario manager (dropdown, Duplicate/Rename/Delete buttons), comparison table (all analyzed scenarios side-by-side), export buttons (Comparison CSV, Session JSON), session import file picker.

**Map overlay**: Red semi-transparent fill for service loss / impacted area (`tvi-impacted-*` layers), green semi-transparent fill for service gain area (`tvi-gain-*` layers). Both cleared on popup close or new analysis.

**Alteration data model**: Each scenario has an `alterations[]` array. Each alteration has `{ name, changeType, before, after, computed, manual }`. `before`/`after` are feature references `{ featureType, featureIndex, featureName }` pointing to drawn routes/lines on the map. `computed` is filled by `TitleVI.computeAlterationMetrics()` and contains `{ beforeMiles, afterMiles, routeMilesPct, alteredPct, alteredMiles, serviceLossArea, serviceGainArea, divergentSegments, revenueHoursPct, spanHoursPct, farePct }`.

**Internal functions**: `addAlteration()`, `removeAlteration(idx)`, `onAlterationChanged(idx)`, `renderAlterationCards()`, `buildAlterationCard(idx, alt)`, `displayComputedMetrics(card, alt)`, `buildFeatureSelect(selectedRef)`, `parseFeatureRef(selectEl)`, `readManualInputs(card)`, `runBaseline(core)`, `runAnalysis(core)`, `runInstantReevaluation()`, `displayResults(result)`, `displayFinding(prefix, finding)`, `renderImpactedArea(geometry)`, `renderServiceGainOverlay()`, `clearOverlay()`, `switchScenario(idx)`, `duplicateScenario()`, `renameScenario()`, `deleteScenario()`, `exportFindingsCSV()`, `exportImpactedGeoJSON()`, `exportSessionJSON()`, `exportComparisonCSV()`, `importSessionJSON(file)`.

**Module-local state**: `_policy` (current policy profile), `_scenarios` (array of scenario objects), `_activeScenarioIdx`, `_baseline` (system-wide demographics), `_results` (scenarioId → analysis result), `_cachedDemographics` (for instant threshold re-evaluation), `_cachedImpactedGeom`, `_baselineFeatureFilter`, `_stale`, `_running`, `_initialized`, `_activeTab`. Session persistence via `App.cache.registerModule("title-vi", ...)` at schema **v2** (v1 backward-compat migration adds empty `alterations[]` and maps `selected_routes` impact method to `full_route_buffer`).

### gtfs.js (GTFS Feed Viewer, limited public API)
Registers module `"gtfs"` as a popup-based analysis. Opens in a 2-column popup (960px wide). All state is private to the IIFE closure. No session persistence — the feed must be re-uploaded each session.

**Entry point:** Add Data (+) dropdown → "GTFS" section → "Load GTFS Feed" triggers a hidden `<input id="gtfs-file-input" type="file" accept=".zip">`. The button wiring is done inside `gtfs.js`, not `app.js`.

**Feed loading:** `loadGTFSFile(file)` uses JSZip to unzip the file, then PapaParse to parse each `.txt` entry. Files inside a top-level subfolder are handled (folder prefix is stripped). All parsed files are stored in `_gtfsData` (Map of filename → `{ headers, rows }`).

**Map layers:** Two non-editable reference layers added below user-drawn features:
- Source `gtfs-shapes` / Layer `gtfs-shapes-layer`: dashed gray lines (color #718096, width 2, opacity 0.65, dash [4,2]) built from `shapes.txt`.
- Source `gtfs-stops` / Layer `gtfs-stops-layer`: hollow white circles with gray stroke (radius 4, stroke 1.5) built from `stops.txt` (location_type 0 or absent only).
- Both layers support `mouseenter`/`mousemove`/`mouseleave`/`click` events (identical pattern to `js/core/osm.js`).

**Hover tooltip** (`.gtfs-hover`): Route shapes → route short name + mode label. Stops → stop name + stop_id.

**Click detail popup** (`.gtfs-detail`): Route shapes → colored swatch in title + route_id, long name, mode, agency, shape_id. Stops → stop_id, code, desc, location type, wheelchair status, parent_station, zone_id.

**Route-info join:** `buildRouteLookup(data)` joins `trips.txt → routes.txt` at load time to build a `shape_id → { route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency_id }` Map. These fields are merged directly into each `shapes.txt` GeoJSON feature's properties by `buildShapesGeoJSON(rows, routeLookup)`, so hover requires no runtime join. Feeds without `trips.txt` or `routes.txt` fall back to displaying `shape_id` only.

**Analysis popup:** Left column — scrollable file directory listing all `.txt` files found in the ZIP with REQ/OPT badges (required files per GTFS spec: agency, stops, routes, trips, stop_times, calendar, calendar_dates). Clicking a file populates the right column. Right column — scrollable CSV table with sticky header, capped at 500 rendered rows with a count note (important for `stop_times.txt` which can have millions of rows). Layer visibility checkboxes and a Clear button appear below the file list once a feed is loaded.

**CSS:** `.gtfs-*` prefix. All styles in `css/style.css` inside the `/* GTFS Feed Viewer module */` block. Includes dark mode overrides.

**Constants:** `ROUTE_TYPE_LABELS` (GTFS route_type integers → readable strings), `LOCATION_TYPE_LABELS` (stop location types), `WHEELCHAIR_LABELS`, `FILE_ORDER` (preferred display order), `REQUIRED` (required-file lookup).

**Public API (on `App`):**
`App.loadGTFSFile(file)` — loads a File object as a GTFS ZIP (same as the file picker flow).
`App.clearGTFS()` — clears the feed, removes map layers, resets UI.
`App.gtfsData` — set at module load time to `null`; note this is a static snapshot, not a live reference to the Map — check `_gtfsData` is not exported live. Future modules needing feed data should call `App.loadGTFSFile` and observe the map layers, or the approach may need revision.

## Analysis Module System

Analysis modules are optional domain-specific analyses that plug into the core. Each module registers itself at load time and appears in the grouped toolbar Analysis menu unless marked `system: true`. Selecting a module opens its floating panel.

### Registration

A module registers itself at load time by calling:

```js
App.registerModule({
  id: "my-analysis",
  name: "Human-readable Name",
  enabled: true,                                  // false = button shown grayed out
  popupWidth: 720,                                // dialog width in px
  panelWidths: { setup: 520, results: 760 },      // optional adaptive widths; popupWidth is fallback
  popupHTML: "projects/my-analysis-popup.html",   // popup body HTML fragment path

  init: function (core) {
    // Called once, the first time the popup opens (lazy init).
    // Wire event listeners, build dynamic UI, etc.
    // DOM elements from popupHTML are accessible at this point.
  },

  onOpen: function (core) {
    // Called every time the popup opens. Refresh display from current state.
  },

  onClose: function (core) {
    // Called when the popup closes. Cleanup is optional — state persists in closure.
  },

  update: async function (core) {
    // Called whenever core data changes (features, LODES, etc.).
    // Fires even when popup is closed — guard DOM writes with App.popup.isOpen().
  }
});
```

`App.registerProject` is a backward-compat alias for `App.registerModule`.

### Adaptive single-step panel widths

`App.popup.setLayoutMode("setup" | "results" | "workspace")` resolves the active
module's `panelWidths`, resets any drag offset by default, and preserves the 90vw
maximum. Input expand/collapse passes its optional preservation flag so a user's drag
position is retained while the panel width changes. Panels at 620px or less are marked
narrow so `.rf-section-row` stacks vertically. Use it only
for active single-step tools. Current choices are: Walkshed 460/460; Feature Area
Analysis 520/900; Transit Propensity 520/520; Corridor Scoring 520/760; FTA Ratings
520 with its Data Inputs workspace at 1000; Transit Coverage 540/760; and Transit
Travelshed 540/640. Route Costing and Trip Builder intentionally retain their existing
wide layouts; Ridership Forecasting, Title VI, GTFS, system modules, and the dormant
Mitigation Needs prototype are not part of this pattern.

**Analysis input order:** Where controls exist, analysis popup inputs are ordered as
selection, Census geography, buffer/study-area parameters (including apportionment),
module-specific settings, then additional settings in an existing modal or native
details control. Transit Travelshed deliberately starts with **Select Origin**, followed
by its route/line selection. This is presentation-only: preserve the existing IDs and
listeners when reorganizing these groups.

### The `core` object

Passed to `init()`, `onOpen()`, `onClose()`, and `update()`. Provides the module with access to shared state and functions without reaching into `App` directly:

| Key | Type | Description |
|-----|------|-------------|
| `points` | Array | Current Point features |
| `buffers` | Array | Current buffer Polygon features |
| `routes` | Array | Current route LineString features (with `properties.waypoints`) |
| `routeBuffers` | Array | Current route buffer Polygon features |
| `map` | MapLibre.Map | The map instance |
| `lodesData` | Map or null | Parsed LODES data (w_geocode -> C000) |
| `lodesFileName` | string | Current LODES file name |
| `getUnion()` | Function | Dissolved buffer union polygon (or null) |
| `fetchTigerwebGeos(level, union)` | Function | Query TIGERweb for tracts/block groups |
| `fetchACSValues(level, year, code, geoids)` | Function | Fetch ACS variable values |
| `fetchACSCountyValues(year, code, counties)` | Function | Fetch county-level ACS values |
| `aggregateWithinUnion(union, geos, values, mode)` | Function | Area-weighted aggregation |
| `computeAcsValueOnly(code, year, level)` | Function | Convenience ACS wrapper |
| `computeEmploymentServedOnly()` | Function | Sum LODES jobs in union |
| `fetchBlocksInternalPointsInUnion(union)` | Function | TIGERweb block internal points |
| `utils.*` | Object | Shared helpers: `setStatus`, `parseCSV`, `toNumberSafe`, `normalizeTractGEOID`, `guessHeader`, `fillSelect`, `enableSelect`, `formatValue`, `getMeta`, `setAggUI` |

The FTA module still accesses `App.*` directly in its internal computation functions. New modules should prefer `core.*` for cleaner dependency boundaries.

### How to add a new analysis module

1. Create `js/projects/my-analysis.js` with an `App.registerModule({...})` call
2. Create `projects/my-analysis-popup.html` with the popup body markup
3. Add `<script src="js/projects/my-analysis.js"></script>` to `index.html` (after `app.js`)
4. The module button automatically appears in the toolbar Analysis menu. Feature Area Analysis and Walkshed Analysis are in **General**; every other non-system module is alphabetized in **Transit Planning** by `buildAnalysisButtonsHTML()`.

Multiple modules can be active simultaneously. No core code needs to change.

### How to run with no modules

Remove all module `<script>` tags from `index.html`. The toolbar Analysis menu will be empty. The core app (map, points, ACS summaries, LODES) works independently.

## Layout

```
+--------------------------------------------------------------------------------+
| Toolbar: workflow | draw tools/actions | view controls | location search       |
+-------------------------------------------------------------+------------------+
|                    Live map (flex)                          | Feature/Layers   |
|                                                            | panel (208px)    |
|                    Floating analysis panel docks right over the map             |
+-------------------------------------------------------------+------------------+
```

### Dormant legacy sidebar

`#sidebar-wrap` ships with `display:none`, and no live code calls `App.sidebar.render()`. The structure below is retained legacy code, not current navigation. Current data actions are in the toolbar Add Data menu; the toolbar Analysis menu is grouped into General and Transit Planning sections.

Historical dormant structure:

```
+-----------------------------+
|  ▾ Data Inputs              |  Collapsible panel (order 10)
|  Census                     |  Section header: variable checkboxes
|    Select all / Clear all   |  grouped by: Demographics, Equity,
|    checkbox variables       |  Travel, Housing, Employment (LODES)
|  Employment (LODES)         |  LODES checkbox, Download/Add State/
|    Download / Add State     |  Clear All buttons, file picker
|  PPACG Pop Projection       |  Projection year, Upload CSV, Clear
+-----------------------------+
|  ▾ Analysis                 |  Collapsible panel (order 30)
|  [Buffer-Area Summary]      |  Button: opens BAS popup (settings + results table)
|  [Transit Propensity Index] |  Button: opens TPI popup (2-column layout)
|  [FTA Small Starts]         |  Button: opens FTA popup (2-tab layout)
|  [Ridership Forecasting]    |  Button: opens RF popup (4-tab layout)
|  [Corridor Scoring]         |  Button: opens CS popup (2-column layout)
|  [Walkshed Analysis]        |  Button: opens Walkshed popup (2-column layout)
|  [Route Costing]            |  Button: opens RC popup (2-column layout)
|  [Trip Builder]             |  Button: opens TB popup (2-column layout)
|  [Title VI Service Equity]  |  Button: opens TVI popup (3-tab layout)
|  [GTFS Feed Viewer]         |  Button: opens GTFS popup (2-column file browser)
+-----------------------------+
```

Selecting an analysis from the toolbar menu opens a non-modal floating panel over the live map. The Buffer-Area Summary popup contains geography/year settings and a results table. The TPI popup has a 2-column layout (Settings | Results) with an Adjust Weights modal overlay. The FTA Small Starts popup has a 2-tab layout (Ratings | Data Inputs). The Ridership Forecasting popup has a 4-tab layout (Calibrate | Demand | Elasticity | Scenarios). The Corridor Scoring popup has a 2-column layout (Settings | Results). The Route Costing popup has a 2-column layout (Service checklist | per-Service and system summary tables) with a Costing Settings modal overlay. The Trip Builder popup has a 2-column layout (Service list | trip schedule). The Title VI Service Equity popup has a 3-tab layout (Policies & Inputs | Analysis | Scenarios). Each active choropleth shows a floating legend widget at bottom-left of the map.

### Feature Panel (right)

```
+-----------------------------+
|  Features                   |
|  POINTS                     |  Per-point rows: editable name +
|    Point 1          [⚙][🗑]|  gear (⚙) opens floating attr popup.
|    Point 2          [⚙][🗑]|  Row click selects on map only.
|  LINES                      |  Points can be dragged on the map.
|    Line 1           [⚙][🗑]|  Per-line: name, mode, notes.
|  ROUTES                     |  Per-route: name, route group,
|    Route 1          [⚙][🗑]|  direction, mode, route ID,
|                             |  frequency, span, days, avg speed.
|                             |  🗑 = trash + inline confirm strip.
|  POLYGONS                   |  Per-polygon: name, notes.
|    Polygon 1          [▸]  |
|  BUFFERS                    |
|    Points   [_0.5_] mi      |  Radius input: default 0.5 mi.
|    Lines    [_0.5_] mi      |  Separate buffer for line features.
|    Routes   [_0.5_] mi      |  Separate buffer for route features.
|  [Import] [Export]          |  Anchored to bottom (flex footer).
+-----------------------------+
```

Each feature row is wrapped in a `div.fp-item-wrapper` containing the `div.fp-item` row and a sibling `div.fp-delete-confirm` strip (hidden by default, shown on trash click). Clicking a row selects the feature on the map (highlights it). The gear icon (`.fp-gear-btn`) opens the floating attributes popup (`#fp-attr-popup`); right-clicking the row also offers "Attributes" in the context menu. No inline attribute panel exists in the DOM.

**Features | Layers tabs.** The panel header (`.fp-header`) is a two-button tab bar (`.fp-tab-btn` with `data-fptab="features"|"layers"`). The existing feature list, Labels/Text, and Feature Settings live in `#fp-tab-features`; the `#fp-tab-layers` pane is rendered by `js/core/layers-panel.js` (see that module's File Structure entry). The shared `#fp-slider-popover` sits outside both panes so the opacity slider works from either tab. The Layers tab lists a Drawn band (features nested by `attributes.group`, with group/feature visibility + color and per-type opacity), Analysis overlays and Reference/Imported bands (present layers only, with show/hide, opacity, constrained drag-reorder, and a ⋯ menu), and a Basemap selector. Layer visibility is kept in sync with the Add Data dropdown eye/× icons in both directions.

## Known Issues

See `REVIEW.md` for the full code review. Remaining items not yet addressed:

- No subresource integrity (SRI) hashes on CDN script tags
