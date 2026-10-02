# Ui layout

Moved verbatim from `CLAUDE.md`.

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

**Features | Layers tabs.** The panel header (`.fp-header`) is a two-button tab bar (`.fp-tab-btn` with `data-fptab="features"|"layers"`). The existing feature list, Labels/Text, and Feature Settings live in `#fp-tab-features`; the `#fp-tab-layers` pane is rendered by `js/core/layers-panel.js` (see that module's File Structure entry). The shared `#fp-slider-popover` sits outside both panes so the numeric scrubber popover works from either tab. The Layers tab lists a Drawn band (features nested by `attributes.group`, with group/feature visibility + color, per-feature style-override drawers, and — below a "Style defaults" heading — a collapsible per-type style drawer for each geometry type in use), Analysis overlays and Reference/Imported bands (present layers only, with show/hide, opacity, constrained drag-reorder, and a ⋯ menu), and a Basemap selector. Layer visibility is kept in sync with the Add Data dropdown eye/× icons in both directions. All drawn-feature appearance editing (opacity, weight, color, offset) lives here (per-feature buffer radius moved to the Attributes popup) — see the `layers-panel.js` File Structure entry and the `App.featureSettings` entry under `app.js`'s API for the full field list.

**Sorting the Features list.** A sort icon button (`#fp-sort-btn`) sits in `.fp-header`, visible only on the Features tab. It and a right-click on the header both open the same menu (built on the shared `showContextMenu`, extended with optional `checked`/`divider` fields for checkmarks and section dividers — existing plain `{label, action}` callers are unaffected): four sort keys (Name/Type/Date added/Group), an Ascending toggle, and a Show groups toggle. Sorting is display-only — it reorders a copy built by `collectAllFeatures()`, never `App.points`/`lines`/`routes`/`polygons`, and has no effect on map draw order. Missing values for the active key always sink to the bottom in both directions; name is always the final tiebreaker; descending reverses only the primary key. "Date added" reads a lazily-stamped `properties.seq` (a monotonic counter assigned in `collectAllFeatures()` the first time a feature is seen, so every creation path picks it up automatically and old sessions get a sensible legacy fallback). Sort state persists in the session cache (`featureSortMode`/`featureSortAsc`/`featureShowGroups`, additive fields, default gracefully). The Labels and Text section is out of scope and always sorts by name.
