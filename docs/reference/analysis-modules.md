# Analysis modules

Moved verbatim from `CLAUDE.md`.

### Adaptive single-step panel widths

`App.popup.setLayoutMode("setup" | "results" | "workspace")` resolves the active
module's `panelWidths`, resets any drag offset by default, and preserves the 90vw
maximum. Input expand/collapse passes its optional preservation flag so a user's drag
position is retained while the panel width changes. Panels at 620px or less are marked
narrow so `.rf-section-row` stacks vertically. Use it only
for active single-step tools.

**Every module in this pattern keeps BOTH widths at or under the 620px breakpoint, and
keeps them EQUAL**, so the panel is a narrow, vertically stacked task panel in every
state — inputs collapse to a one-line bar on a successful run and the results sit below
them, never beside them — and the panel never resizes when you run it. A `results` width
above 620 un-stacks the panel after a run, which is not the intent: that is a bug, not a
per-module choice. Unequal widths are also a bug — they make the panel jump on run and on
every inputs expand/collapse.

Current choices: Walkshed 460; Transit Propensity 520; FTA Ratings 520 (plus its Data
Inputs **workspace** at 1000 — the one deliberate wide mode, a file-upload +
column-mapping surface rather than a results view); and Feature Area Analysis, Corridor
Scoring, Transit Coverage, and Transit Travelshed all at **600**. Those four sit at 600
rather than their settings columns' natural ~520 because each renders a multi-column
results table: Feature Area Analysis's five columns need ~556px of content width, and at
520 the table overflowed and forced the popup body to scroll sideways. 600 is simply the
most room available without crossing the stacking breakpoint. Prefer widening toward 600
over restyling a table when a results table does not fit.

Route Costing and Trip Builder intentionally retain their existing wide layouts and are
not part of this pattern; Ridership Forecasting, Title VI, GTFS, system modules, and the
dormant Mitigation Needs prototype are not either.

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
