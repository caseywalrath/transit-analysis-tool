# Script load order

Moved verbatim from `CLAUDE.md`.

## Script Load Order

Order matters because modules depend on earlier ones:

```
config.js   (no deps — API keys; MUST be first so map.js/census.js see the keys at init)
utils.js    (no deps)
sidebar.js  (needs App namespace from utils.js)
map.js      (creates App.map, basemap switcher, cursor handlers; reads App.CARTO_API_KEY)
search.js   (needs App.map)
walk-cost.js (core block, no deps — turf/DOM/Map/App-free; defines window.WalkCost — see docs/walkshed-bands-and-crossing-penalties-plan.md; loaded before road-network.js, which consumes it starting Phase 5)
layer-palettes.js (no deps at load time — the pure window.LayerPalette block is turf/DOM/Map/App-free like walk-cost.js/travelshed.js; the App-level cascade block below it reads/writes App.* only at call time, same rule choropleth.js follows — see docs/layer-color-customization-plan.md; defines window.LayerPalette, App.layerStyles/mapPalette/resolveLayerColors/setLayerStyle/clearLayerStyle/registerLayerRepainter/repaintStyledLayers; loaded before road-network.js and every module that consumes it — layers-panel.js, choropleth.js, walkshed.js, transit-travelshed.js, transit-propensity.js, ridership-forecasting.js, corridor-scoring.js, gtfs.js)
network-store.js (no deps at load time — IndexedDB only, no App state read; defines App.networkStore. Loaded before road-network.js, its only consumer)
road-network.js (needs App.map, App.setStatus, turf, window.WalkCost, App.networkStore (optional — every call site is guarded); defines App.roadNetworkLoaded/roadNetworkEpoch/findLocalRoute/computeWalkshed/computeWalkCostMap/getWalkNetworkSegments/restoreCachedNetwork/etc.)
network-connectors.js (needs App.map, App.roadNetworkLoaded/getWalkNetworkSegments from road-network.js; defines App.refreshWalkNetworkLayer — see docs/network-connectors-plan.md)
walk-audit.js (core block, no deps — turf/DOM/Map/App-free like walk-cost.js/travelshed.js; defines window.WalkAudit; App block reads App.map/roadNetworkLoaded/getWalkNetworkSegments only at call time — see docs/sidewalk-data-plan.md; loaded after road-network.js/network-connectors.js and before walkshed.js/transit-travelshed.js)
travelshed.js (core block, no deps — turf/DOM/Map/App-free; defines window.Travelshed)
connector-graph.js (core block, no deps — turf/DOM/Map/App-free; defines window.ConnectorGraph — see docs/network-connectors-plan.md)
points.js (needs App.map, turf)
lines.js    (needs App.map, turf)
routes.js   (needs App.map, turf, fetch/AbortController)
polygons.js (needs App.map)
editing.js  (needs App.map, App.points, App.lines, App.routes, App.polygons, move/update functions)
box-select.js         (needs App namespace only at load; App.map, App.points/lines/routes/polygons, App.setSelection, App.getSelectedFeatures, App.exitDrawMode, App.setStatus only inside handlers — loads after selection.js)
features.js           (needs App.points, App.lines, App.routes, App.polygons, App.removePoint, etc.)
feature-appearance.js (needs App namespace at load; App.buildScrubber, App.buildColorPickerBody (features.js), App.featureRef/featureById, App.undo, App.cache, the per-type render functions only inside handlers; defines App.openAppearancePopup, App.closeAppearancePopup, App.isAppearancePopupOpen, App.buildFeatureOverrideRows)
feature-attributes.js (needs App namespace; defines App.openAttrPopup, App.closeAttrPopup, App.isAttrPopupOpen, App.getAttrPopupFeature)
merge.js              (needs App namespace at load; App.points/lines/routes/polygons, App.undo, App.rerenderForType, App.onFeatureDelete, App.selectFeature, App.fetchRouteGeometry (routes.js), App.ensurePointWalksheds/dropPointWalksheds/refreshBuffers (points), App.foldAnalysisUnion and turf only inside functions; defines App.mergeGeom, App.mergeAttrs, App.merge. Must load before attribute-summary.js, which delegates its has-value check to App.mergeAttrs.fieldHasValue)
split.js              (needs App namespace at load; App.merge._dialogKit, App.lines/routes/points, App.undo, App.nextFeatureId, App._nextColorSeq, App.rerenderForType, App.onFeatureDelete, App.selectFeature/toggleMultiSelect, App.map (optional, for pixel snapping) only inside functions; defines App.splitGeom, App.split)
layers-panel.js       (needs App.map, App.collectDrawnFeatures, App.rerenderForType, App.openColorPicker, App._openFpSlider, App.buildScrubber, App.applyFeatureOpacity, App.applyLineWidth, App.applyBufferLineWidth, App._polyOpacityValues, App.sectionColors, App.featureSettings, basemap API, turf; defines App.refreshLayersPanel)
census.js             (needs App.map, App.bboxStringFromFeature, App.getMeta, turf)
lodes.js    (needs App.map, App.bboxStringFromFeature, App.bufferUnionPolygon, pako, turf)
cache.js    (needs App.points, App.lines, App.routes, App.polygons, render/rebuild functions)
popup.js    (needs App namespace; defines App.popup)
module-buffers.js   (needs App.points/lines/routes/polygons, App.getPointWalkshed (optional), turf; defines App.ANALYSIS_BUFFER_DEFAULT_MILES/_MIN_MILES/_MAX_MILES, App.foldAnalysisUnion, App.buildAnalysisBuffer, App.readAnalysisBufferMiles, App.buildAnalysisBufferSet)
analysis-checklist.js (needs App namespace only at load; DOM touched only inside functions; defines App.decorateHiddenRow/buildIncludeHiddenToggle/hiddenSelectionMessage)
choropleth.js       (no deps at load time — App.map/maplibregl are read only inside the map-facing functions, so the classification math loads/runs fine in the golden test sandbox; defines App.choropleth)
app.js              (wires everything; builds toolbar menus; defines App.registerModule; calls cache.restore)
<modules>           (call App.registerModule)
  buffer-summary.js     (needs App namespace, App.cache, App.choropleth; registers Buffer-Area Summary module; runSummary + builds checkbox UI from VAR_META at popup init)
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
  attribute-summary.js  (needs App.registerModule, App.popup, App.openColorPicker, App.updateFeatureColor, App.openAppearancePopup, App.buildPointRouteBadge, App.buildTimeBandsBadge; system module — opened via App.openAttributeSummary())
present-overlays.js     (needs App namespace and App.cache; loaded after modules; listens for `mat:present-mode-change`)
```

**Active modules:** Buffer-Area Summary is enabled (popup-based, settings + results table). TPI is enabled (popup-based, 2-column). FTA Small Starts is enabled (popup-based, 2-tab). Ridership Forecasting is enabled (popup-based, 4-tab). Corridor Scoring is enabled (popup-based, 2-column). Walkshed Analysis is enabled (popup-based, 2-column; network isochrones via the offline road-network engine). Transit Travelshed is enabled (popup-based, 2-column; walk→wait→ride transit→walk isochrones from a clicked origin, ≤1 transfer, via the offline road-network engine + the pure Travelshed calc engine). Transit Coverage is enabled (popup-based, 2-column; population/jobs coverage within a buffer of selected routes/lines, clipped to a drawn service area). Route Costing is enabled (popup-based, 2-column). Trip Builder is enabled (popup-based, 2-column). Title VI Service Equity is enabled (popup-based, 3-tab). GTFS Feed Viewer is enabled (popup-based, 2-column file browser + map layers). Attribute Summary is enabled as a **system module** (registered with `system: true` so it is hidden from the Analysis dropdown; opened via the Attribute Summary… button under Feature Settings).

**Dormant module:** *Wetland & Channel Mitigation Needs* (`js/projects/mitigation-needs.js` + `mitigation-needs-data.js`, `projects/mitigation-needs-popup.html` + `mitigation-needs-legend.html`) was built only as an illustration. Its two `<script>` tags in `index.html` are commented out, so the module does not load or appear in the Analysis dropdown. The files are retained; re-enable by uncommenting both tags.
