# Script load order

Plain `<script>` tags in `index.html`, in this order (verified against `index.html`). Order matters: a file may only use, **at load time**, what earlier files defined. Most files touch `App.*` only inside functions.

CDN libraries load first: MapLibre GL, Turf, pako, PapaParse, JSZip, shapefile.

```
js/core/
config.js            MUST be first — App.CARTO_API_KEY / CENSUS_API_KEY read by map.js/census.js at init
utils.js             no deps; defines the App namespace helpers (VAR_META, feature IDs/refs, usage hook)
sidebar.js           dormant legacy sidebar
map.js               creates App.map + basemap switcher; reads App.CARTO_API_KEY
search.js            needs App.map
walk-cost.js         pure, no deps; window.WalkCost (before road-network.js)
layer-palettes.js    pure window.LayerPalette + App cascade (App.* only at call time); before every consumer
network-store.js     IndexedDB only; App.networkStore (before road-network.js, its only consumer)
road-network.js      needs App.map, turf, window.WalkCost, App.networkStore (optional, guarded)
network-connectors.js needs road-network.js; App.refreshWalkNetworkLayer etc.
walk-audit.js        pure window.WalkAudit + App block (call time); after road-network/network-connectors
travelshed.js        pure; window.Travelshed
connector-graph.js   pure; window.ConnectorGraph
points.js / lines.js / routes.js / polygons.js   need App.map, turf
labels.js            App.labels, addLabel/removeLabel/…
textboxes.js         App.addTextBox/removeTextBox/renderTextBoxMarkers/…
measure.js           App.handleMeasureClick/clearMeasure/…
osm.js               OSM reference layers (App.osmToggleCategory/osmClearLayers)
osm-pois.js          App.osmPoiFeatures/clearOsmPois/…
editing.js           needs the four feature arrays + move/update functions
selection.js         App.setSelection/selectFeature/getSelectedFeatures/…
box-select.js        after selection.js; defines App.boxSelect, App.bulkFeatures
features.js          feature panel; App.showContextMenu, App.buildColorPickerBody, App.collectDrawnFeatures
feature-appearance.js needs App.buildColorPickerBody (features.js) inside handlers; App.openAppearancePopup, App.buildFeatureOverrideRows
feature-attributes.js App.openAttrPopup/closeAttrPopup/isAttrPopupOpen/getAttrPopupFeature
merge.js             App.mergeGeom/mergeAttrs/merge; must precede attribute-summary.js (uses App.mergeAttrs.fieldHasValue)
split.js             after merge.js (uses App.merge._dialogKit); App.splitGeom, App.split
layers-panel.js      App.refreshLayersPanel
census.js            needs App.bboxStringFromFeature, App.getMeta, turf
lodes.js             needs App.bufferUnionPolygon, pako, turf
projections.js       population-projection CSV (App.parseProjectionsCSV/setProjectionsData/projGrowthFactors/…)
cache.js             session save/restore; App.cache
undo.js              App.undo (snapshots via cache state)
popup.js             App.popup
service-assembly.js  App.buildTransitServices/getEffectiveServiceBands/migrateServiceKey/… (Route Costing, Trip Builder, Travelshed, Coverage)
module-buffers.js    App.foldAnalysisUnion, App.buildAnalysisBufferSet, …; App.getPointWalkshed optional
analysis-checklist.js App.decorateHiddenRow/buildIncludeHiddenToggle/hiddenSelectionMessage
choropleth.js        App.map/maplibregl only inside map functions (math loads in the golden sandbox); App.choropleth
js/app.js            wires everything, toolbar menus, App.registerModule; calls App.cache.restore()
js/projects/ (each calls App.registerModule)
buffer-summary.js    needs App.choropleth
fta-small-starts.js
tpi-scoring.js       window.TPI
transit-propensity.js needs TPI
ridership-scoring.js needs TPI; window.RidershipModel
ridership-forecasting.js needs RidershipModel, TPI
corridor-scoring.js  needs TPI, RidershipModel
walkshed.js          needs road-network.js exports
transit-travelshed.js needs window.Travelshed, road-network.js exports, App.getEffectiveServiceBands
transit-coverage.js  needs census.js, lodes.js, App.getEffectiveServiceBands
(mitigation-needs-data.js, mitigation-needs.js — commented out, dormant)
route-costing.js / trip-builder.js   need service-assembly.js
title-vi-engine.js   window.TitleVI
title-vi.js          needs TitleVI
gtfs.js              needs JSZip, PapaParse
attribute-summary.js system module, opened via App.openAttributeSummary(); needs App.openAppearancePopup, App.buildPointRouteBadge, App.buildTimeBandsBadge
js/core/present-overlays.js  after modules; listens for `mat:present-mode-change`
```

**Call-time cross-file names** (used inside functions, so only presence matters): feature arrays `App.points`/`App.lines`/`App.routes`/`App.polygons`; `App.setStatus`, `App.exitDrawMode`, `App.getSelectedFeatures`, `App.selectFeature`, `App.removePoint`, `App.rerenderForType`, `App.onFeatureDelete`, `App.nextFeatureId`, `App._nextColorSeq`, `App.featureRef`; appearance — `App.buildScrubber`, `App._openFpSlider`, `App.openColorPicker`, `App.updateFeatureColor`, `App.applyFeatureOpacity`, `App.applyLineWidth`, `App.applyBufferLineWidth`, `App._polyOpacityValues`, `App.sectionColors`, `App.featureSettings`, `App.layerStyles`, `App.closeAppearancePopup`, `App.isAppearancePopupOpen`; attributes — `App.closeAttrPopup`, `App.isAttrPopupOpen`, `App.getAttrPopupFeature`; network/buffers — `App.roadNetworkLoaded`, `App.computeWalkshed`, `App.fetchRouteGeometry`, `App.ensurePointWalksheds`, `App.refreshBuffers`, `App.buildAnalysisBuffer`, `App.readAnalysisBufferMiles`, `App.ANALYSIS_BUFFER_DEFAULT_MILES`; `App.renderCensusOverlay` (TPI, RF).

**Active modules:** Feature Area Analysis (`buffer-summary`), Transit Propensity, FTA Small Starts, Ridership Forecasting, Corridor Scoring, Walkshed, Transit Travelshed, Transit Coverage, Route Costing, Trip Builder, Title VI, GTFS Feed Viewer. Attribute Summary is a **system module** (`system: true`, hidden from the Analysis menu).

**Dormant module:** Wetland & Channel Mitigation Needs (`js/projects/mitigation-needs.js` + `mitigation-needs-data.js`, `projects/mitigation-needs-popup.html` + `mitigation-needs-legend.html`) — illustration only; its two script tags are commented out in `index.html`. Re-enable by uncommenting both.
