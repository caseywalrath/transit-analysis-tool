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
- **ACS variables are a one-file edit in `js/core/utils.js`.** `VAR_META` is the single source of truth for variable metadata, checkbox-group membership and percent denominators; the popup checklist, percent column and group expansion all follow it. Per entry:
  - `displayInChecklist: true` → its own checkbox.
  - `group: "GROUP_X"` → shown only inside group X's checkbox (mutually exclusive with `displayInChecklist`); labels in `GROUP_INFO`.
  - `denominator: "<code>"` → percent against that variable; `"$group"` → against the sum of the group's members; omit for no percent column.
- **Feature attribute changes must update BOTH the per-feature popup and Attribute Summary.** The schema is duplicated in `js/core/feature-attributes.js` (`ATTR_FIELDS`, the `#fp-attr-popup`) and `js/projects/attribute-summary.js` (`renderPoints` / `renderLineLike` / `renderPolygons` / `renderMarkers`). Any add/remove/rename/type change of a `feature.properties.attributes.*` field, or a direct `feature.properties.*` field shown in the UI, changes both files in the same commit. Adding or removing a column also changes the matching grid template in `css/style.css` (`.as-grid-points` / `-routelike` / `-polygons` / `-marker`): header and data rows share it. A multi-row editor (Time Bands, Route Picker) is a shared helper in `feature-attributes.js` (`App.buildXBadge` + `App.openXPopup`), never a second copy.
- **Drawn Lines/Routes render in three style layers — never use `lines-layer`/`routes-layer` literally for hit-testing or paint.** `properties._lineStyle` (`"dashed"`/`"dotted"`, anything else = solid) splits each source into `lines-layer` (solid) + `-dashed` + `-dotted`, because MapLibre's `line-dasharray` cannot be a data expression. Use `App.lineStyleLayerIds(type?)`, `App.lineStyleLayerType(layerId)`, `App.addLineStyleLayers(map, type, sourceId, paint)` and `App.setFeatureLineStyle(type, index, style)`. The only allowed bare literals are the `firstUserLayer()` insert-below anchors in `gtfs.js`/`walk-audit.js`/`network-connectors.js` (the solid layer is always lowest). Test: `test/browser/line-style.test.mjs`.

## Testing

Run only the tier that matches the change. Record each result in the commit message as a `Verified:` line.

**Golden values — after changing any formula, constant or pure calculation helper.** `node test/run-golden.mjs` (pure Node, runs as-is; clean run ends `PASS — N/N cases passed`).
- Fails and you did not mean to change numbers → it is a regression: fix the code, never the golden files.
- Fails because you deliberately changed math → confirm the diff, re-record with `--update`, and commit the changed `test/golden/*.json` in the same commit, saying which numbers moved and why.
- New or changed pure function → extend `test/cases/<module>.mjs` and seed with `--update`. Closure-private functions need a `__MAT_TEST__`-guarded `App._xxTest` hook (examples in `route-costing.js`, `trip-builder.js`, `corridor-scoring.js`). Details: `test/README.md`.
- Pins only pure math (no map, DOM, network APIs, turf geometry). Title VI is deliberately not covered (see `features.md`).

**Browser behavior — after changing persistence, startup order, map-layer create/update/remove, or hide/show paths.** `bash test/browser/run-browser.sh`, or one file with `NODE_PATH=/opt/node-tools/node_modules node test/browser/<file>.test.mjs` (clean run ends `PASS — n/n checks passed`). Drives the real app in headless Chromium to catch what golden tests and screenshots cannot (the motivating bug: a `TransactionInactiveError` only on the real startup path, `docs/archive/browser-test-harness-plan.md`). `hidden-features.test.mjs` covers every module using `analysis-checklist.js`; run it after touching `module-buffers.js`, `analysis-checklist.js`, a hide/show path or those modules' checklists. New tests reuse `test/browser/harness.mjs` and poll observable state rather than fixed waits (`test/browser/README.md`).

**Screenshots — after app-shell, shared-CSS, popup or module-markup changes.** `test/ui-screens/capture.mjs`; inspect the images, not only the pass count (see Conventions).

**Comment guard — for comment- or doc-only edits.** `NODE_PATH=/opt/node-tools/node_modules node test/comment-guard.mjs [base-rev]` proves only comments/whitespace changed. `node test/doc-coverage.mjs` lists public `App.*`/`window.*` names missing from `CLAUDE.md` and `docs/reference/`.

## Overview

Browser-based geospatial analysis tool. Pure front-end (no build step, no backend, no npm). Open `index.html` in a browser and it works. All data stays client-side; Census APIs are called directly.

## File Map

One line per file. Detail (behavior, invariants, public API) lives in the reference doc named in brackets, under `docs/reference/`. Read that doc before changing a file, and trust the code when the two disagree.

```
index.html                  App shell: toolbar, map, Features/Layers panel, module-panel container, script tags   [core-app]
css/style.css               All live styles, namespaced per module (.tpi-, .rf-, .fta-, .tvi-, .cs-, .rc-, .tb-, .gtfs-, .lp-, .fa-, .fm-)   [core-app]
css/sidebar-v2.css          Dormant legacy sidebar styles   [core-app]
js/app.js                   Startup, module registry, toolbar menus, keyboard shortcuts, renderModuleState/renderModuleInputs   [core-app]
js/core/
  config.js                 Public API keys (CARTO, Census); loads first   [core-app]
  utils.js                  VAR_META, feature IDs/refs, color cascade, line-style helpers, feature-usage hook   [core-app]
  sidebar.js                Dormant legacy sidebar manager   [core-app]
  map.js                    MapLibre map, basemap registry/switcher, CARTO key handling   [core-app]
  search.js                 Toolbar location search
  walk-cost.js              window.WalkCost — crossing-penalty math (pure)   [road-network]
  layer-palettes.js         window.LayerPalette + App layer-color cascade   [layers-and-styling]
  network-store.js          IndexedDB cache of the road network   [road-network]
  road-network.js           Overpass download → graph → Dijkstra; walksheds, cost maps, connectors overlay   [road-network]
  network-connectors.js     Walk-network layer, connector Lines, join markers, street exclusion   [road-network]
  walk-audit.js             window.WalkAudit — sidewalk coverage classification + layer   [road-network]
  travelshed.js             window.Travelshed — transit travelshed math (pure)   [road-network]
  connector-graph.js        window.ConnectorGraph — connector planarization (pure)   [road-network]
  points.js / lines.js / routes.js / polygons.js   Drawing, buffers, rendering per type   [drawing-and-features]
  labels.js / textboxes.js  Map label and text-box annotations (DOM markers)
  measure.js                Temporary distance/area measure tool
  osm.js / osm-pois.js      Overpass reference layers (stops, routes, POIs)
  editing.js                Vertex editing, drag, map right-click feature menu   [drawing-and-features]
  selection.js              Selection state and highlighting   [drawing-and-features]
  box-select.js             Box select tool + App.bulkFeatures group actions   [drawing-and-features]
  features.js               Features panel list, sorting, context menu, color picker   [drawing-and-features]
  feature-appearance.js     Shared Appearance popover + override rows   [drawing-and-features]
  feature-attributes.js     Floating attributes popup, ATTR_FIELDS, shared editors   [drawing-and-features]
  merge.js / split.js       Feature Merge/Unmerge and Split   [drawing-and-features]
  layers-panel.js           Layers tab: drawn/analysis/reference bands, style drawers, GTFS browser   [layers-and-styling]
  census.js / lodes.js      TIGERweb + ACS fetch/aggregation; LODES employment   [core-app]
  projections.js            Population-projection CSV additions
  cache.js                  Session save/restore/import/export, schema migrations   [core-app]
  undo.js                   Undo/redo via full-state snapshots
  popup.js                  Analysis panel manager + floating widgets   [core-app]
  service-assembly.js       Transit Service assembly for Route Costing / Trip Builder   [drawing-and-features]
  module-buffers.js         Module-owned analysis buffers   [core-app]
  analysis-checklist.js     Hidden-feature handling for analysis checklists   [core-app]
  choropleth.js             Shared choropleth engine (App.choropleth)   [core-app]
  present-overlays.js       Presentation-mode legend/north arrow/title   [core-app]
js/projects/                Analysis modules, one reference doc each under docs/reference/modules/:
  buffer-summary.js         Feature Area Analysis   [feature-area-analysis]
  fta-small-starts.js       FTA Small Starts   [fta-small-starts]
  tpi-scoring.js + transit-propensity.js        window.TPI engine + TPI module   [transit-propensity]
  ridership-scoring.js + ridership-forecasting.js   window.RidershipModel + RF module   [ridership-forecasting]
  corridor-scoring.js       Corridor Scoring   [corridor-scoring]
  walkshed.js               Walkshed (also supplies point walkshed study areas)   [walkshed]
  transit-travelshed.js     Transit Travelshed   [transit-travelshed]
  transit-coverage.js       Transit Coverage   [transit-coverage]
  route-costing.js          Route Costing   [route-costing]
  trip-builder.js           Trip Builder   [trip-builder]
  title-vi-engine.js + title-vi.js   window.TitleVI engine + Title VI module   [title-vi]
  gtfs.js                   GTFS Feed Viewer + route browser engine   [gtfs]
  attribute-summary.js      Attribute Summary (system module)   [drawing-and-features]
  mitigation-needs*.js      Dormant illustration module (script tags commented out)
projects/*.html             Popup bodies and legend fragments, documented with their module
docs/                       Feature plans (historical design records) and docs/reference/
test/                       Golden, browser and UI-screenshot harnesses, comment guard
```

**Other reference docs:** `docs/reference/script-load-order.md` (full dependency notes), `docs/reference/analysis-modules.md` (adaptive panel widths, the `core` object), `docs/reference/ui-layout.md` (dormant sidebar, Feature panel details).

## Script Load Order

Plain `<script>` tags in `index.html`; a file may only use what loads before it at load time. Engine files (`walk-cost`, `layer-palettes`, `travelshed`, `connector-graph`, `choropleth`) read `App`/map only at call time so the golden harness can load them alone. Full per-file dependencies: `docs/reference/script-load-order.md`.

```
config → utils → sidebar → map → search → walk-cost → layer-palettes → network-store → road-network
→ network-connectors → walk-audit → travelshed → connector-graph → points → lines → routes → polygons
→ labels → textboxes → measure → osm → osm-pois → editing → selection → box-select → features
→ feature-appearance → feature-attributes → merge → split → layers-panel → census → lodes → projections
→ cache → undo → popup → service-assembly → module-buffers → analysis-checklist → choropleth → app.js
→ modules (buffer-summary, fta-small-starts, tpi-scoring, transit-propensity, ridership-scoring,
   ridership-forecasting, corridor-scoring, walkshed, transit-travelshed, transit-coverage, route-costing,
   trip-builder, title-vi-engine, title-vi, gtfs, attribute-summary) → present-overlays
```

Hard ordering rules: `config.js` first (map.js/census.js read the keys at init); `merge.js` before `attribute-summary.js`; each `*-scoring.js`/`*-engine.js` before its module; `present-overlays.js` after all modules.

**Modules:** every module in the list above is enabled. Attribute Summary is a system module (hidden from the Analysis menu, opened from Feature Settings). Wetland & Channel Mitigation Needs is dormant: its two script tags are commented out; uncomment both to re-enable.

## Conventions

- **No build tools.** Plain `<script>` tags in dependency order; external libraries come from CDN (MapLibre GL JS, Turf.js, pako, PapaParse, JSZip, shapefile.js).
- **Global namespace.** Shared state and functions live on `window.App`; each file is an IIFE that reads `var App = window.App` and assigns its exports. Pure engines use their own namespaces (`window.TPI`, `window.RidershipModel`, `window.TitleVI`, `window.Travelshed`, `window.WalkCost`, `window.ConnectorGraph`, `window.WalkAudit`, `window.LayerPalette`).
- **Module-local state stays private** inside the IIFE closure (`_lastResult`, `_stale`, `_running`, …), never on `App`.
- **Dormant sidebar.** `#sidebar-wrap`, `sidebar-v2.css` and `js/core/sidebar.js` ship hidden and unused. Data actions live in the toolbar Add Data menu and analyses in the toolbar Analysis menu. Never describe the sidebar as live.
- **Analysis panels** are non-modal floating panels over a live map, managed by `App.popup` (load, init/open/close, Escape, docking, collapse). Single-step modules declare `panelWidths` and call `App.popup.setLayoutMode("setup" | "results" | "workspace")`; a successful run collapses Inputs via `App.renderModuleInputs()` (failed runs leave them open). Keep movable input sections in `data-input-group` wrappers and Run buttons in `.module-input-actions`. Width rules: `docs/reference/analysis-modules.md`.
- **Inputs vs. Settings.** Required selections (buffer, checklist, geography, year) sit inline and collapse after a run; optional/expert tuning sits behind a button, modal or `<details>`.
- **Tabbed popups** (Ridership Forecasting, FTA, Title VI) use a `[data-tab]` tab bar and a module `switchTab(id)`; state is kept in the closure across tab switches.
- **Inline help** is a `<button class="rf-info-btn">ⓘ</button>` toggling a sibling `<div>` in `init()`. No tooltip libraries.
- **CSS namespacing.** Each module's styles use its prefix (`.tpi-`, `.rf-`, `.fta-`, `.tvi-`, …) in `css/style.css`. **Exception:** `.rf-status*` and `.rf-info-box` are deliberately shared by every module through `App.renderModuleState()`; do not rename or fork them.
- **Standardized module state.** Every module renders its stale banner (with a working Re-run button via `onRerun`) and its empty/onboarding hint through `App.renderModuleState()`, usually via thin local `setStatus`, `showStale()` and `emptyHint()` → `{need, action}` wrappers. New modules follow this pattern, never a bespoke banner.
- **Design tokens.** Chrome colors use the semantic tokens in `:root` / `body.dark-mode` (`--bg`, `--surface*`, `--text-*`, `--border*`, `--accent`, status tokens); no raw hex for chrome. Data encodings (feature colors, ramps, pills, legend swatches, map symbols) are exempt. Spacing uses `--space-*`; typography uses the `:root` font variables (Inter only). Extend the shared primitives (`.form-field`, `.form-section`, `.btn-row`, `.rf-select`, `.rf-number-input`, `.rf-action-primary`, `.rf-btn-sm`, `.u-*`) rather than adding module copies.
- **Comments explain why, not what.** Keep invariants, past-bug reasons and quirks; no plan-phase history ("Phase 3 added…") in code comments. Module detail goes in `docs/reference/`, not `CLAUDE.md`; finished plans go in `docs/archive/`.
- **Test plumbing.** `test/browser/harness.mjs` is shared with `test/ui-screens/capture.mjs` (Playwright loading, Chromium, CDN interception, static server); extend it rather than duplicating it. `test/ui-screens/baseline/` holds committed reference images.

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

Adaptive panel widths and the `core` object passed to these hooks: `docs/reference/analysis-modules.md`. Per-module behavior and state: `docs/reference/modules/`.

### How to add a new analysis module

1. Create `js/projects/my-analysis.js` with an `App.registerModule({...})` call
2. Create `projects/my-analysis-popup.html` with the popup body markup
3. Add `<script src="js/projects/my-analysis.js"></script>` to `index.html` (after `app.js`)
4. The module button automatically appears in the toolbar Analysis menu. Feature Area Analysis and Walkshed Analysis are in **General**; every other non-system module is alphabetized in **Transit Planning** by `buildAnalysisButtonsHTML()`.

Multiple modules can be active simultaneously. No core code needs to change.

### How to run with no modules

Remove all module `<script>` tags from `index.html`. The toolbar Analysis menu will be empty. The core app (map, drawing, data layers, session save/restore) works independently; Feature Area Analysis, which produces ACS summaries, is itself a module.

## Layout

```
+--------------------------------------------------------------------------------+
| Toolbar: workflow | draw tools/actions | view controls | location search       |
+-------------------------------------------------------------+------------------+
|                    Live map (flex)                          | Feature/Layers   |
|                                                            | panel (250px)    |
|                    Floating analysis panel docks right over the map             |
+-------------------------------------------------------------+------------------+
```

The right panel's width is the `--fp-width` custom property in `:root` (`css/style.css`, currently 250px). `#feature-panel` uses it directly and `.module-popup`'s right gutter is `calc(var(--fp-width) + 25px)`, so change the variable, never the individual rules. The map controls (zoom, basemap switcher), floating legends and the panel's collapse tab are all positioned relative to `#map` or the panel itself, so they follow the width automatically; the collapsed (24px) and present-mode rules deliberately stay explicit.

## Known Issues

See `docs/REVIEW.md` for the full code review. Remaining items not yet addressed:

- No subresource integrity (SRI) hashes on CDN script tags
