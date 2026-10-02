# UI layout

## Dormant legacy sidebar

`#sidebar-wrap` ships `display:none`; nothing calls `App.sidebar.render()`. It is retained code, not navigation. Data actions live in the toolbar Add Data menu; analyses in the toolbar Analysis menu (General / Transit Planning). Selecting an analysis opens a non-modal floating panel over the live map; active choropleths show a floating legend at bottom-left.

## Feature panel (right)

Width is `--fp-width` in `css/style.css` `:root` (250px); `.module-popup`'s right gutter derives from it — change the variable, not individual rules.

- Rows: `div.fp-item-wrapper` holds `div.fp-item` plus a hidden `div.fp-delete-confirm` strip (shown on trash click). Row click selects on the map. The gear (`.fp-gear-btn`) or right-click → Attributes opens `#fp-attr-popup`; there is no inline attribute panel.
- **Features | Layers tabs:** `.fp-header` holds `.fp-tab-btn[data-fptab="features"|"layers"]`. Panes `#fp-tab-features` (feature list, Labels/Text, Feature Settings) and `#fp-tab-layers` (rendered by `js/core/layers-panel.js`, see `layers-and-styling.md`). `#fp-slider-popover` sits outside both panes so the scrubber works from either. All drawn-feature appearance editing (`App.featureSettings` defaults + per-feature overrides) lives in the Layers tab / Appearance popover; per-feature buffer radius is in the Attributes popup.
- **Sorting:** `#fp-sort-btn` (Features tab only) and right-click on the header open one `App.showContextMenu` menu (items may carry `checked`/`divider`): Name/Type/Date added/Group, Ascending, Show groups. **Display-only** — sorts a copy from `collectAllFeatures()` (`App.collectDrawnFeatures`); never reorders `App.points`/`lines`/`routes`/`polygons` or map draw order. Missing values sink to the bottom in both directions; name is the final tiebreaker; descending reverses only the primary key. "Date added" reads a lazily stamped `properties.seq`. Persisted as additive cache fields `featureSortMode`/`featureSortAsc`/`featureShowGroups`. Labels and Text always sort by name.
