# Analysis modules

## Adaptive single-step panel widths

`App.popup.setLayoutMode("setup" | "results" | "workspace")` applies the active module's `panelWidths`, resets drag offset by default (inputs expand/collapse passes a flag to keep it), and caps at 90vw. Panels ≤ 620px are marked narrow so `.rf-section-row` stacks vertically. Single-step tools only.

**Rule: keep both widths ≤ 620 and EQUAL.** A `results` width > 620 un-stacks the panel after a run; unequal widths make it jump on run and on every inputs expand/collapse. Both are bugs.

Current: Walkshed 460; Transit Propensity 520; FTA Ratings 520 (+ Data Inputs **workspace** 1000, the one deliberate wide mode); Feature Area Analysis, Corridor Scoring, Transit Coverage, Transit Travelshed 600 — their multi-column results tables overflow at 520 (FAA needs ~556px). Prefer widening toward 600 over restyling a table.

Not in this pattern: Route Costing and Trip Builder (wide layouts), Ridership Forecasting, Title VI, GTFS, system modules, dormant Mitigation Needs.

**Input order:** selection → Census geography → buffer/study-area (incl. apportionment) → module settings → extra settings in a modal or `<details>`. Transit Travelshed starts with **Select Origin**, then route/line selection. Presentation-only: keep existing IDs and listeners when reordering.

## The `core` object

Passed to `init()`, `onOpen()`, `onClose()`, `update()`:

| Key | Description |
|-----|-------------|
| `points`, `buffers`, `routes`, `routeBuffers` | Current feature / buffer arrays (routes carry `properties.waypoints`) |
| `map` | MapLibre map |
| `lodesData`, `lodesFileName` | Parsed LODES Map (w_geocode → C000) or null; file name |
| `getUnion()` | Dissolved buffer union or null |
| `fetchTigerwebGeos(level, union)`, `fetchACSValues(level, year, code, geoids)`, `fetchACSCountyValues(year, code, counties)`, `aggregateWithinUnion(union, geos, values, mode)`, `computeAcsValueOnly(code, year, level)`, `computeEmploymentServedOnly()`, `fetchBlocksInternalPointsInUnion(union)` | Census/LODES helpers |
| `utils.*` | `setStatus`, `parseCSV`, `toNumberSafe`, `normalizeTractGEOID`, `guessHeader`, `fillSelect`, `enableSelect`, `formatValue`, `getMeta`, `setAggUI` |

New modules should prefer `core.*`; FTA still reads `App.*` directly.
