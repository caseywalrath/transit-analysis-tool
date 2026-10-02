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
- **Drawn Lines/Routes render in three style layers — never reference `lines-layer`/`routes-layer` literally for hit-testing or paint.** Per-feature `properties._lineStyle` (`"dashed"`/`"dotted"`; absent/`""`/`"solid"`/unknown = solid) splits each source into `lines-layer` (solid, original id kept) + `lines-layer-dashed` + `lines-layer-dotted` (same for `routes-layer*`), because MapLibre's `line-dasharray` cannot be a data expression. Use `App.lineStyleLayerIds(type?)` for query/paint lists, `App.lineStyleLayerType(layerId)` (→ `"line"`/`"route"`/`null`) for hit comparisons, `App.addLineStyleLayers(map, type, sourceId, paint)` to create them, and `App.setFeatureLineStyle(type, index, style)` to change a style. The only remaining bare literals are the `firstUserLayer()` insert-below anchors in `gtfs.js`/`walk-audit.js`/`network-connectors.js` (the solid layer is always the lowest of the three, so they stay correct). Behavior test: `test/browser/line-style.test.mjs`.

## Testing — golden-value checks

**After changing any formula, elasticity, constant, or pure helper in a calculation engine, run the golden-value tests before committing.** The `test/` folder holds a zero-install harness (pure Node — no npm, no browser, no build) that pins the numeric output of the pure calculation functions so a silent math change is caught instead of shipped.

- **Command:** `node test/run-golden.mjs` (or `bash test/run-tests.sh`). It runs in this environment as-is. A clean run ends with `PASS — N/N cases passed across M module(s)`.
- **If it FAILS and you did NOT intend to change any numbers:** that is a regression — fix the code. Do **not** edit the golden files to make it pass.
- **If it FAILS because you DELIBERATELY changed a formula/constant:** review the reported diff to confirm the new numbers are what you intended, then re-record with `node test/run-golden.mjs --update` and commit the changed `test/golden/*.json` **in the same commit** as the code change, noting in the message which numbers moved and why.
- **Record the outcome in the commit message** — a `Verified: node test/run-golden.mjs → N/N` line — so the check is part of the record.
- **Added or changed a pure calculation function?** Add or extend the matching `test/cases/<module>.mjs` and seed it with `--update`; a new engine module gets a new case file. Functions private to a module's IIFE closure need a small `__MAT_TEST__`-guarded `App._xxTest` export hook (see the existing hooks in `route-costing.js` / `trip-builder.js` / `corridor-scoring.js`). Full workflow: `test/README.md`.

**Covered engines:** Ridership Forecasting, TPI scoring, Route Costing, Trip Builder, Corridor Scoring, Transit Coverage, Module Buffers, Travelshed, Choropleth classification, Feature IDs, Feature Merge helpers (`test/cases/merge.mjs`), Feature Split helpers (`test/cases/split.mjs`), GTFS route-browse helpers (`test/cases/gtfs-browse.mjs`), Box select helpers (`test/cases/box-select.mjs`), Connector Graph (`docs/network-connectors-plan.md`), Walk Cost / crossing penalties (`docs/walkshed-bands-and-crossing-penalties-plan.md`), Layer palettes (`docs/layer-color-customization-plan.md`), Sidewalk data audit (`docs/sidewalk-data-plan.md`). **Deferred intentionally:** Title VI (see the note in `features.md`). The harness pins only *pure* math — no map, DOM, Census/LODES API, or turf geometry; those paths are out of scope by design, so not every code change needs a test run, only ones touching calculation logic.

## Testing — browser behavior checks

**After changing session/road-network persistence, startup sequencing, or map-layer lifecycle, run the browser behavior tests before committing.** The golden harness above only pins pure calculation math by design — it has no map, DOM, or storage. `test/browser/` fills the gap: it drives the real app in headless Chromium (via Playwright, same one-time setup as `test/ui-screens/`) and asserts runtime behavior that only shows up with a real event loop — e.g. whether the road-network IndexedDB cache (`js/core/network-store.js`) actually survives a page refresh, not just whether its math is right. See `docs/browser-test-harness-plan.md` for the motivating bug (a silent `TransactionInactiveError` that only failed on the real page-startup path, never in manual testing) and `test/browser/README.md` for the full "what belongs here" guidance.

- **Command:** `bash test/browser/run-browser.sh` (every `*.test.mjs` in that directory) or `node test/browser/<file>.test.mjs` for one file. Requires Playwright via `NODE_PATH` — see `test/browser/README.md`'s one-time setup, identical to `test/ui-screens/`'s. A clean run ends with `PASS — n/n checks passed` per file.
- **When do I need to run this?** Only when the change could misbehave in a way a golden test or a screenshot diff can't see: session-cache restore ordering, an IndexedDB/localStorage-backed store, `App.roadNetworkEpoch()`/cache-invalidation timing, or a map layer's create/update/remove lifecycle. A pure formula change stays in the golden harness; a layout/CSS change stays in `test/ui-screens/`.
- **Hidden features in analysis:** `test/browser/hidden-features.test.mjs` (`NODE_PATH=/opt/node-tools/node_modules node test/browser/hidden-features.test.mjs`) covers every module that adopted `analysis-checklist.js` — disabled/tagged hidden rows, selection preserved, live gray-out on hide/show, the hidden-only-selection message, Include hidden toggle + results note, stale banner, and toggle persistence across reload. Run it after touching `module-buffers.js`, `analysis-checklist.js`, any hide/show path, or those modules' checklists.
- **Adding a test:** see `test/browser/README.md`'s "Adding a test file" — import shared plumbing from `test/browser/harness.mjs` rather than duplicating it, and prefer polling observable state over a fixed `waitForTimeout`.

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
- **Behavior verification.** `test/browser/` is the browser behavior harness (see "Testing — browser behavior checks" above) — runtime assertions a pixel diff and the golden math harness both miss, e.g. whether `App.restoreCachedNetwork()` actually restores the road network across a real reload. `test/browser/harness.mjs` holds plumbing shared with `test/ui-screens/capture.mjs` (Playwright loading, Chromium resolution, vendored-CDN route interception, the static server) — extend that file rather than duplicating its pieces into a new test.
- **External libraries via CDN:** MapLibre GL JS, Turf.js, pako (gzip), PapaParse (CSV), JSZip (GTFS ZIP parsing).

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

Remove all module `<script>` tags from `index.html`. The toolbar Analysis menu will be empty. The core app (map, points, ACS summaries, LODES) works independently.

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

See `REVIEW.md` for the full code review. Remaining items not yet addressed:

- No subresource integrity (SRI) hashes on CDN script tags
