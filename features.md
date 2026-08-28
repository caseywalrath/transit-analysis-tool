# Features

Planned features and enhancements. Items are grouped by theme, not priority. Each entry should include enough context for a future session to understand the intent and begin planning.

Status key: **Implemented**, **Partial**, **Not started**

---

## Drawing & Geometry

**Potential future improvements:**
- Add a travel mode selector (walking, cycling) per route


### Midpoint Insertion — Implemented
Click along an existing route/line/polygon in vertex edit mode to insert a new vertex. `insertVertex` in `js/core/editing.js` (`turf.nearestPointOnLine`), undo-supported.

### Segment split in edit mode — Not started
Split a drawn line/route into two independent features at a clicked vertex (or an arbitrary clicked point along the geometry). Vertex *deletion* already exists (`deleteVertex` / `canDeleteVertex` in `js/core/editing.js`, wired to the Delete key); this adds the complementary "cut here" operation. Reuse the same geometry helpers as midpoint insert (`turf.nearestPointOnLine` to locate the cut, `turf.lineSlice` to produce the two halves), push both new features with undo, and split attributes (each half inherits the original's `attributes`). Useful for breaking a long corridor into separately-costed patterns.

### Snap-to-layer while drawing — Not started
While drawing a line/route/polygon, snap new vertices to nearby reference geometry — GTFS shape lines (`gtfs-shapes-layer`) and OSM lines — not just the current snap-to-close behavior. Today snapping is limited to closing the shape within `SNAP_PIXELS` of the first/last waypoint (`js/core/lines.js`, `js/core/routes.js`, `js/core/polygons.js`). Reuse the existing rendered layers (already queried for hover/click) to find the nearest candidate within a pixel threshold and snap the cursor/vertex to it. Lets users trace existing service or street alignments precisely when building proposals.


### Walkshed polygons — Implemented
True street-network walking isochrones from placed Points, entirely in-browser. **Walkshed** module (`js/projects/walkshed.js`) uses `App.computeWalkshed` (`js/core/road-network.js`: budget-limited flood Dijkstra + concave-hull polygon); requires a loaded road network. Points flagged `attributes.serviceAreaType = "walkshed"` substitute the walkshed for the circular buffer in `rebuildBuffers()`, so every study-area consumer (BAS, TPI, Title VI, FTA, corridor pickers) picks it up automatically.

### Walkshed sidewalk & access refinement — Not started
A further precision pass on the walkshed network, building on the class-aware traversal already in place (`js/core/road-network.js` tags every edge/segment `pedBlocked`/`carBlocked` from the OSM `highway` class and `foot` tag, so motorways/trunk roads and their ramps are already excluded from walksheds, pedestrian ways — footway/path/steps/pedestrian/cycleway/living_street — are already included, and driving routes still ignore pedestrian-only ways).

**What this adds:** lean on OSM sidewalk and access tagging to refine *which* segments a pedestrian can actually use, rather than relying on the highway class alone.
- **Sidewalk data (two forms).** OSM encodes sidewalks either as `sidewalk=both/left/right/no/none` tags on a road centerline, or as separately-mapped `highway=footway` + `footway=sidewalk` ways. The separately-mapped form already flows into the network via the footway class; the centerline `sidewalk=*` tag is not yet captured. Capturing it would let a walkshed prefer/weight streets known to have sidewalks and down-weight or exclude `sidewalk=no` arterials.
- **Access tags.** Extend the existing `foot=*` override to also honor `access=private`, `access=no`, and `foot=private` so technically-mapped-but-un-walkable segments (gated service roads, private drives) are dropped. Cheap once the tags are captured — the classifier hook (`isPedForbidden`) is already the single choke point.
- **High-stress arterial-crossing penalty (AECOM TLOS).** Beyond a binary include/exclude, apply an edge-weight *multiplier* in `buildGraph` for segments that cross or run along high-stress arterials, so the walkshed is pruned where a pedestrian realistically won't cross (a freeway or 6-lane arterial makes a nominally-close stop unreachable). Same soft-weighting hook as the sidewalk signal; degrades gracefully to today's behavior where the classifying tags are absent.

**⚠ Caveats (why this is "nice if present, never required"):**
- **Coverage is wildly inconsistent.** Sidewalk tagging is excellent in a handful of well-mapped cities and essentially absent across most of the US. Logic that *depends* on `sidewalk=*` would make the tool behave very differently region to region — a walkshed that looks precise in Seattle and empty in a mid-size county — which is hard to explain to the beginner audience (see `CLAUDE.md`). Treat sidewalk tags as an optional refinement signal, never a hard requirement: absent tag ⇒ fall back to today's class-based behavior, don't exclude the street.
- **Directionality (`sidewalk=left/right`) is rarely worth modeling** given the network is undirected and pedestrians cross freely; collapse to a simple present/absent signal.
- **Don't silently change results.** Because coverage is spotty, any sidewalk-aware mode should be surfaced to the user (e.g. an opt-in toggle or a footnote noting how many segments carried sidewalk tags) rather than quietly reshaping the walkshed.

**Files to touch:** `js/core/road-network.js` — capture `sidewalk` (and the extra `access`/`foot` values) in the Overpass→GeoJSON conversion and in `loadRoadNetworkFromFile`'s pass-through, then extend `isPedForbidden` / add a soft-weighting hook; optionally expose the opt-in toggle + footnote in `js/projects/walkshed.js` / `projects/walkshed-popup.html`.

### Transit Travelshed Engine — Implemented
Computes everywhere reachable from a clicked map origin via walk → wait →
ride drawn transit routes/lines → walk, with at most one transfer, rendered
as 1–3 banded isochrones. Extends the walkshed engine's bones:
`js/core/road-network.js` gained per-node cost-map primitives
(`computeWalkCostMap`, `polygonizeNodeSet`, `snapWalk`, `nodeKeyToCoord`,
`fetchRoadNetworkForExtent`) shared with `computeWalkshed`; a new pure
calculation engine `js/core/travelshed.js` (`window.Travelshed`) does the
layered-flood arrival-time math on plain JSON so it's golden-testable with
no turf/DOM; `js/projects/transit-travelshed.js` is the module (origin
probe pattern — a clicked map point, not an `App.points` feature — stop
resolution, chunked-async per-stop flood caching, scoped
prompt-to-download street acquisition, banded rendering). Full design +
phase-by-phase build log: `docs/transit-travelshed-plan.md`.

**Answering the DEVELOPER NOTE above about `headway/2`:** the literature
splits by boarding type. Classic half-headway wait assumes riders arrive at
a stop uniformly at random, which real ridership data (Ingvardson et al.
2018 Copenhagen smart-card data; Lam & Morrall Calgary; Salek & Machemehl /
Fan & Machemehl Austin; TfL's operational 12/15-min timetabled cutoff; Chen
et al. 2025) shows holds only for frequent service — at longer headways
riders increasingly time their arrival to the schedule, so observed
*physical* wait flattens instead of growing linearly with headway. The
model adopted: **initial (unlinked) wait = `min(headway/2, Wmax)`**, `Wmax`
user-adjustable (default 10 min, defensible calibration range 8–12).
**Transfer wait stays uncapped `headway/2`**: a transferring rider's
arrival is dictated by the feeder vehicle's schedule, not something they
can time (absent modeled timed transfers). A fixed boarding penalty
(default 1 min) applies at every boarding, initial or transfer. Full
empirical basis + citations: `docs/transit-travelshed-plan.md` Appendix A.
**Disclosed limitation:** this captures *physical* reachability only — it
does not capture the schedule-delay/flexibility cost of infrequent service
(an hourly route forces a departure-time adjustment even when the stop
wait itself is short). A future generalized-cost or demand use of these
travel times should add a separate schedule-delay penalty rather than
uncapping `headway/2`.

**Disclosure behaviors:** the module never silently drops or approximates —
every choice is surfaced per route in the results panel: which service
band and headway applied at the chosen analysis day/time (or excluded as
"no service at HH:MM" if none), the wait-model arithmetic actually used,
whether stops were **real** (Points whose `associatedRoutes` reference the
feature) or **sampled** (synthetic, spaced at the assumed stop-spacing
setting, used when a feature has zero real stops), and how direction/loop
geometry was propagated (Both = both ways; Loop/CW/CCW = one-way,
wrapping only if the drawn geometry is actually closed — an open "loop"
rides linear, disclosed). Off-network stops (snapped >0.5 km from the
loaded network) are skipped and counted rather than silently ignored.

**v2 (out of scope for this pass):**
- Street-crossing / sidewalk access penalties (undirected graph stands;
  folds into the Walkshed sidewalk & access refinement entry above).
- Transfer cap > 1 (the engine loop already generalizes for this; only a
  UI knob is missing).
- Batch/cumulative-opportunity accessibility (many origins) — this
  engine's per-stop flood-cache design is its prerequisite; the mode
  itself is the separate Cumulative-Opportunity Transit Accessibility
  entry.
- Schedule-based (timetable) waits; re-selecting the active band at a
  simulated later clock time for downstream boardings (v1 freezes the
  analysis-time band for the whole run).
- Riding past the drawn end of an open (non-closed) loop; Service-paired
  pattern awareness (each feature propagates independently in v1 — no
  Route Costing-style pattern pairing).
- Opportunity counts inside bands (population/jobs — natural follow-on
  via census.js/lodes.js); departure-time profiles; per-point
  walk-speed overrides.

### Transit Travelshed performance & simplification brainstorm — Partially implemented
Current implementation computes a full per-stop walk-cost flood at every stop reachable by transit, then layers transfer boarding on top, producing accurate 1–3 banded isochrones. Depending on use cases and iteration velocity, several simplifications and speedups are worth exploring:

**Outcome so far:** `docs/transit-travelshed-v2-walk-caps-plan.md` shrank the origin and per-stop flood radii to the relevant walk cap (access, or the larger of egress/transfer) whenever `"transit"` shed mode is active, cutting per-stop flood work roughly 50–90× at typical settings — and, as a side effect of the same pass, replaced the single per-band concave hull with a union of per-cluster polygons so it can no longer bridge unreachable space between disjoint stop clusters. This is a **model-correctness fix** (walking legs are meant to be capped in the "transit-served shed" model), not an approximation, but it happens to land the biggest, cheapest win from the "Computation shortcuts" and "Large-budget truncation" ideas below. The remaining brainstorm items (sampling mode, grid approximation, per-network-epoch memoization, progressive rendering, etc.) are deferred until it's measured whether the capped floods are fast enough in practice — see that plan's §8 verification checklist item comparing `computeMs` between `"transit"` and `"door"` modes, and its §9 "explicitly deferred" list.

**Computation shortcuts (approximate but fast):**
- **Sampling mode:** Instead of flooding from every stop, sample every Nth stop along each route (e.g., every 2nd or 3rd stop). Reduces compute time linearly with sample rate; accuracy degrades gracefully for widely-spaced stops but remains reasonable for frequent stop patterns.
- **Grid-based approximation:** Divide the study area into a regular grid (e.g., 0.1 mi × 0.1 mi cells), compute reachability only for grid cell centers rather than stop-accurate positions, and interpolate the remaining cells. Orders of magnitude faster for large networks; useful as a rough "opportunity accessibility" layer before drilling into per-stop detail.
- **Stop-only mode:** Render the travelshed as discrete stop buffers (point radius = walk budget) rather than computing walk-to-every-node polygons — single-hop approximation, useful for quick "can I walk to transit" screening. Skips the road-network flood entirely.
- **Large-budget truncation:** For budgets > ~60 minutes, the isochrone area grows with the square of the budget; compute at a smaller budget (e.g., 45 min) and scale the geometry rather than recomputing. Rough but fast for exploratory "does this service reach [far zone]" questions.

**Caching & precomputation:**
- **Memoize per-network-epoch:** The current cache is keyed `stopKey|networkEpoch|budgetKm`, meaning every origin re-floods every stop. Consider caching per-stop walk costs *per network* once (no origin-dependence), reusing them across all travelshed runs, clearing only on network reload. Huge if there's geographic overlap (many origins near the same stops).
- **Pre-seed key corridors:** For common analysis geographies (a city, a region), pre-compute and embed walk floods for a grid of "representative" stops so initial runs are instant, with lazy on-demand computation for unrepresented stops. Breaks the "always fresh" assumption but acceptable if results are timestamped.

**UI/UX efficiency (same accuracy, better perceived speed):**
- **Progressive rendering:** Stream bands to the map as they complete (band 1 at 15 min while band 2 floods). User sees *something* while waiting, reducing perceived staleness.
- **Result caching by coordinate:** If the user re-runs from the same origin (within a snap threshold), reuse the cached result rather than re-flooding.
- **One-band quick-run mode:** Offer a "Show 15-min isochrone only" option that skips 30/45-min computation; user can opt into full 3-band later. Common for "is this stop walkable" screening.

**Architectural simplifications (lower fidelity, much simpler code):**
- **Single-mode (walk-only, no transfer):** A walk-only isochrone from the origin (already computed as the first step) without any transit boarding. Useful as a baseline or for "how far can I walk?" without committing to the full travelshed engine. Trivial to implement — just render the walk-budget polygon.
- **Linear corridor only:** Assume all transit is a single corridor (one route/line) so transfer is not modeled. Reduces from layered-flood to a simple walk-→-buffer-route-→-walk computation. High fidelity for the single-route case; degenerate for network analysis.

**Future coordination:**
- Integration with the Cumulative-Opportunity Transit Accessibility entry above — the sampling and grid modes are perfect for many-origins batch computation.
- Interplay with Operation Abort — a long-running travelshed can be canceled, but incremental results (completed bands, per-stop costs) could be selectively kept rather than discarded entirely.

No recommendation yet — frame as a menu of tradeoffs (speed vs. accuracy, implementation complexity vs. user value) to revisit when performance bottlenecks are observed or compute budgets tighten.

### Unmerge dissolved union — Low Priority
Currently `bufferUnionPolygon()` always dissolves overlapping buffers. Add an option to keep individual buffers separate for per-station analysis or visual comparison.

### Import geospatial data (KML/KMZ/GeoJSON) — Implemented
Upload KML, KMZ, GeoJSON, JSON, CSV, or shapefile (.shp/.zip) via Add Data (+) → Spatial Data as editable features. `js/app.js` extension router → `importKML`/`importFromFile`/`importCSV`/`importSHP` in `js/core/cache.js`.

### Floating attributes popup — Implemented
Feature attributes open in a floating draggable popup (`#fp-attr-popup`, 320px, clamped to viewport, Escape/X to close, auto-updates on selection change). Opened via the row's gear icon (⚙) or right-click → "Attributes".

### Concentric buffer rings — Not started
Draw multiple concentric rings at user-defined distances (e.g. 0.25/0.5/1 mi) around a point or line, distinct from the current single-radius buffer. Useful for graduated service-area visualizations and walking-distance comparisons.

### Freehand drawing mode — Not started
Draw lines and polygons by holding and dragging rather than click-by-click vertex placement. Useful for sketching irregular study areas or approximate corridors quickly.

### Copy / paste features — Implemented
Right-click → "Duplicate" creates an independent copy of any feature type (`duplicatePoint`/`duplicateLine`/`duplicateRoute`/`duplicatePolygon`/`duplicateLabel`/`duplicateTextBox`). Remaining nice-to-have: a Ctrl+D shortcut.

### Copy Attributes (Attribute Summary) — Implemented
Per-row Copy button in the Attribute Summary popup (`js/projects/attribute-summary.js`) opens a modal to copy a source feature's attributes onto one or more compatible targets (Points/Lines/Routes/Polygons; `serviceId` excluded), with per-attribute/per-target selection, an overwrite warning, and one undo step for the whole batch.

---

## Data & Analysis

**Potential future TPI enhancements:**
- GTFS integration for existing transit service overlay
- Custom factor upload for local datasets not available via Census APIs
- Alternative normalization methods (z-scores, Jenks natural breaks)
- Integration with ArcGIS Pro via GeoJSON export (current workflow) or direct ArcGIS REST API
- User-editable index entries for local land use factors
- Ability to filter cloropaths (top/bottom 50% and top/bottom 10%)
- Show missing data in "Scoring Summary" column
- Methodology/inputs for manual land use scoring

### TPI "Important Destinations" factor — Not started

Add an optional 10th factor to the TPI scoring engine using OSM Points of Interest loaded via the Add Data tool (`App.osmPoiFeatures`). Surfaces trip attractors that ACS data cannot capture: a regional hospital in a low-density suburb, a community college, a park-and-ride terminal. The factor is opt-in (active only when POIs are loaded and enabled in TPI settings), carries a fixed default weight of 5 (not user-adjustable via the Adjust Weights modal), and is clearly flagged in TPI results and CSV exports when active.

**Scoring method — proximity-weighted sum, then quintile:**
For each block group, compute `score_i = Σ (importance_j / turf.distance(centroid_i, poi_j, "miles"))` across all loaded POIs. This produces a smooth, non-sparse distribution that correctly propagates the benefit of nearby destinations to surrounding block groups — not just the one containing the facility. Block group centroids computed via `turf.centroid()`. No new Census API calls; pure client-side geometry run after TIGERweb geographies are fetched.

**Double-counting note:** Overlap with Employment Density is real but limited to the specific case where a major employer sits in an already-dense block group. For the primary use case — an atypical destination in a low-density area — overlap is minimal and the factor adds unique signal.

**Subjectivity mitigation:** Labelled "User-Defined Destinations" in results and CSV export. The fixed 5-point weight prevents it from overriding the objective ACS/LODES factors. A footnote in the TPI results panel mirrors the existing LODES warning pattern.

**Files to modify:**
- `js/projects/tpi-scoring.js` — add 10th factor definition; read `App.osmPoiFeatures` to compute proximity scores; integrate into `TPI.computeTPI()` pipeline
- `js/projects/transit-propensity.js` — show/hide Destinations row in factor breakdowns; add footnote when active; exclude from Adjust Weights modal (fixed weight)
- `js/core/osm-pois.js` — `App.osmPoiFeatures` already exposed; no changes needed

### Transit Costing module — Partial
Delivered as **Route Costing** (`js/projects/route-costing.js`): service/revenue miles, rev/plat hours (daily + annualized), layover/deadhead, peak pullout, fleet + spares. Missing: staffing estimates; interlines fleet pooling is built but UI-disabled pending review.

### More census categories — Partial
`VAR_META` (`js/core/utils.js`) has grown to ~60 ACS/LODES variables across Demographics, Equity, Travel, Housing, and Employment. Open-ended — can keep growing.

### Ridership vs. Coverage Allocator — Not started
Jarrett Walker's hallmark budget-philosophy split: tag each drawn route/line as **"Ridership"** (frequent service on dense corridors) or **"Coverage"** (lifeline service everywhere), then report what share of total revenue hours / miles goes to each — updating live as the user draws routes or changes frequency. Add a single `purpose` enum attribute (Ridership | Coverage | unset) alongside the existing `direction`/`mode`/`serviceId` fields in `js/core/feature-attributes.js`; the Attribute Summary table and Copy Attributes pick it up like any other field. Route Costing already computes per-Service `revHrs`/`miles`/`platHrs` per day and annualized (`computeService` / `computeSystemSummary` in `js/projects/route-costing.js`), so the split is a pure group-by-`purpose` aggregation of numbers we already have — surface it as a section in the Route Costing results or a lightweight system dashboard. The split-ratio math is a pure function → golden-value test case per the testing policy.


### FTA Small Starts popup UI — Implemented
Popup module (`js/projects/fta-small-starts.js`, `projects/fta-small-starts-popup.html`), 2-tab (Ratings | Data Inputs): CRE/ESS/LBAR uploads with column mapping, five rating cards, breakpoint classification, session persistence, CSV export.

### Simplified LBAR Housing Inventory workflow — Not started
The current LBAR workflow requires uploading a pre-formatted inventory file with lat/lon/units/county columns. A simpler flow might allow uploading a basic address list, geocoding it, and auto-detecting the county FIPS. Requires conceptual planning — the geocoding step is the main complexity (no backend, so would need a client-side or free API solution).


### Title VI Analysis Module — Implemented
Popup module (`js/projects/title-vi.js` + engine `title-vi-engine.js` +
`projects/title-vi-popup.html`), 3-tab (Policies & Inputs | Analysis |
Scenarios): route-alteration pairing, major-service-change rules,
disparate-impact/disproportionate-burden findings vs. a system baseline,
service loss/gain map overlay, scenario comparison, CSV/GeoJSON/JSON export.

**TODO — golden-value tests deferred:** add `test/cases/title-vi.mjs` once
the engine's math stabilizes (pure pieces: `defaultPolicy`, `createScenario`,
`computeDivergence`, `evaluateMajorChange`, `evaluateFindings`).

**Potential enhancement — New-vs-Old job-access matrix:** the module today
compares demographics of the *impacted area*. A stronger equity output disaggregates
the **change in job access** (not just area demographics) for zero-vehicle,
low-income, and minority populations under a proposed vs. existing network. That
needs job *access* via the Transit Travelshed Engine (buffer overlap isn't
accessibility) and the New-vs-Old comparison via Scenario Save & Compare — the
demographic-disaggregation half already lives here.

### OSM Points of Interest — Implemented

Loads curated transit-relevant destination categories from OSM via Overpass (Add Data → ONLINE → "Points of Interest (OSM)"). Category picker (15 types across Health/Education/Transit/Retail/Government/Recreation), auto re-fetched on pan/zoom, rendered as importance-sized purple circles. No session persistence. Exposed as `App.osmPoiFeatures` for downstream modules (see TPI Destinations factor below).

**Potential future enhancements:**
- Filter loaded POIs by importance tier (show only High, Medium, or both)
- User-editable importance override per individual POI via the click detail popup
- Auto-populate `destinationImportance` attribute on new user-placed Points based on proximity to loaded OSM POIs

### GTFS import — Implemented
Upload a GTFS `.zip` via Add Data (+) → GTFS. Renders shapes.txt as dashed reference lines and stops.txt as hollow circles, with hover tooltips and click detail popups (route info pre-joined from trips.txt + routes.txt). Analysis popup shows the file directory (REQ/OPT badges) + scrollable CSV table viewer (capped 500 rows). No session persistence.

**Potential future enhancements:**
- **Derive frequency/span from `stop_times.txt`.** Aggregating stop_times by trip and service period yields real headways and service spans. This unlocks two high-leverage things: (1) a **frequency heatmap overlay** (color route segments by observed headway), and (2) letting the existing **"Copy As Line"** action (`js/projects/gtfs.js:505`) carry real service bands — populate `attributes.service` (weekday / saturday / sunday band arrays) on the copied feature so **Route Costing** and **Trip Builder** consume observed service automatically. Closes the loop from observed feed → editable proposal with no manual band entry.
- **Filter displayed routes by `route_type` / agency, plus a route picker.** Add a route-level selector so users can copy an entire route's pattern (all its shapes) into editable Lines at once, rather than one shape at a time, and toggle visibility by mode/agency.
- **Use a loaded feed as the "existing service" baseline** for Title VI and Ridership Forecasting — compare a proposed network (drawn features) against the current GTFS network for service-change and equity analysis.
- Persist GTFS feed across sessions (localStorage is too small; IndexedDB or a re-upload prompt would be needed)

### Trip Builder — Implemented
Enabled popup module (`js/projects/trip-builder.js`, `projects/trip-builder-popup.html`) that generates a high-level trip schedule (start/end times per direction per day type) for each Service from its underlying Time Bands, frequency, and run time / avg speed. Same Service assembly as Route Costing (`attributes.serviceId` buckets). Per-trip deletion and CSV export per Service.

### Trip Builder bulk trip generation — Not started
Currently Trip Builder generates trips one Service at a time via the "Generate Trips" button (per-Service control). Enhance with:

1. **"Generate for all" button:** Iterates over every drawn route/line whose service definition is complete (no blank frequency bands, no validation errors) and regenerates trips for each in sequence. Useful when building proposals with many routes that have similar service patterns and need uniform trip generation across the fleet.

2. **Per-route exclusion toggle:** Checkbox or "Exclude from regeneration" flag on each Service row, so the bulk generator skips already-tuned routes. Allows selective regeneration (e.g., regenerate new routes but preserve manually edited schedules on existing routes).

Particularly valuable for scenario planning where dozens of routes share the same service bands and need consistent headway logic applied at scale.

### Corridor Scoring — Implemented
Enabled popup module (`js/projects/corridor-scoring.js`, `projects/corridor-scoring-popup.html`) that surfaces the per-route Corridor Demand Index as a ranked, objective composite score per drawn route/line. Ranked table with classification pills and expandable per-factor breakdowns, map line layer colored by composite CDI, Adjust Weights modal, CSV/GeoJSON export, and session persistence.

### Ridership Forecasting Directionality Multiplier — Not started
Agreed that full granularity (trunk-with-one-way-loop-ends) exceeds the model's
current fidelity — and importantly, it also exceeds the fidelity of the
*calibration data* (route-level observed ridership), so a segment-level
directionality model would be precision we can't validate.

**What's defensible now — a route-level "directionality factor":**
- We already have the pattern for exactly this kind of adjustment: service
  type premiums (user-adjustable sliders, documented defaults, flow through
  `applyElasticity`). Add a **direction multiplier** derived from the existing
  `direction` attribute / Service pairing: bidirectional (paired patterns or
  "Both") = 1.0; one-way loop (Loop/CW/CCW solo) = default ~0.7,
  user-adjustable with a stated basis. The rationale to document: a one-way
  loop imposes out-of-direction travel for roughly half of trip pairs,
  degrading effective in-vehicle time even at identical headways; empirical
  literature is thin, so the default is a judgment value the user can tune —
  same epistemic status as our service premiums, presented the same way.
- **Calibration-consistency guard (cheap, valuable):** if calibration routes
  are predominantly bidirectional and a scenario is a one-way loop (or vice
  versa), show a warning note — the calibration factor silently embeds the
  direction profile of the routes it was fit on. This costs almost nothing
  (direction attributes are on the features already) and prevents the most
  likely real-world misuse.
- **Hybrid trunk+loops:** representable today as a Service (paired trunk
  patterns) plus loop features, and `computeSegments` shows how per-segment
  treatment *could* work — but defer. A length-weighted blend of per-pattern
  multipliers within a Service is the eventual v2 if demand materializes.
- **Longer-term principled path:** once a transit travelshed engine exists,
  directionality stops being a fudge factor — a one-way loop's travelshed is
  visibly smaller/asymmetric, and accessibility-based demand adjustment
  becomes possible.

**Testing note:** any change to `applyElasticity` or a new multiplier function
is calculation-engine math → golden-value test cases and a
`Verified: node test/run-golden.mjs` line in the commit, per the testing policy.

**Effort:** multiplier + warning = small. Methodology write-up (in
`TPI_Ridership_Forecast_Methodology.md` + the user-facing readme) is the real
deliverable; without it the number is indefensible in front of a client.

### Corridor Scoring scenario compare — Not started
Let users save a scored corridor set as a named scenario and diff two corridor alternatives side by side — a ranked delta table showing which corridors gained/lost score and rank between Scenario A and B. Builds on the module's existing `_lastResult` and session persistence in `corridor-scoring.js`; would add a small scenario store (name + captured `routeCDIs` + weights/settings) and a comparison view. Supports "alternative A vs. alternative B" planning conversations directly in the tool.

### Transit Coverage module — Implemented
Combines Ideas 1+2 from the (now-deleted) brainstorm doc — residents & jobs
near frequent transit. Popup module (`js/projects/transit-coverage.js`,
`projects/transit-coverage-popup.html`): geography/ACS year, module-owned
buffer distance (`js/core/module-buffers.js`), day type + optional peak-headway
threshold (`App.getEffectiveServiceBands`), routes+lines checklist (transit
sources), drawn-polygons checklist (service area/denominator). Coverage/
threshold unions clipped to the service area (`turf.intersect`); aggregates
ACS population (area-apportioned) and LODES jobs (whole-block) into a results
table, stat sentence, map overlay, CSV/GeoJSON export, session persistence.

**Potential future enhancements** (from the original brainstorm, not built):
- User-configurable frequency tiers (≤15/≤30/any) with a "sustained over a
  qualifying span" definition option, vs. today's single threshold
- Municipal boundary polygon as an alternative service-area denominator
- Network walkshed option for buffers (vs. crow-fly) when a road network is loaded
- Buffer from a route's associated stops instead of the line (stop-sparse service)

### Cumulative-Opportunity Transit Accessibility — Not started
What the agencies are showing is **cumulative-opportunity accessibility**,
usually computed with schedule-based multimodal routing (Conveyal/R5: GTFS +
street network, departure-time sampling). We can't and shouldn't replicate
that fidelity client-side — but there is a legitimate, well-established
lighter-weight variant that our data model happens to support almost exactly:
**frequency-based (headway-based) accessibility**, where expected wait =
headway/2 instead of consulting a timetable. Conveyal itself offers this mode
for sketch networks that don't have schedules yet — which is precisely what a
drawn scenario network is.

Conceptual pipeline (all pieces named in the Transit Travelshed Engine entry):
1. Transit travelshed from an origin with budget T (walk → wait → ride →
   walk, ≤1 transfer).
2. "Jobs within T" = LODES jobs within the travelshed polygon (existing
   union-based LODES computation).
3. The headline stat ("the *average resident* reaches 39% more jobs") is the
   population-weighted mean of (2) across many origins — one travelshed per
   populated block-group centroid in the service area. That's the expensive
   part: N origins × multi-flood routing. Tractable as a batch run with a
   progress bar *if* per-stop walk floods are cached and reused across origins
   (design note in the Travelshed entry), or by sampling origins.
4. The "% more" framing is a before/after comparison → falls straight out of
   the Scenario Save & Compare System.

**Opportunity types (beyond jobs):** the same "count what's inside the
travelshed" step generalizes past LODES jobs — count reachable **healthcare
facilities from loaded OSM POIs** (`App.osmPoiFeatures` already carries
hospital/clinic categories) and **low-income households** (ACS), so the headline
can be framed for whichever opportunity a client cares about, not just employment.

**Data we'd want eventually but don't need for v1:** real GTFS-derived
headways for the *existing* network (we already parse GTFS; deriving headways
from `stop_times.txt` is a bounded follow-up), giving an honest "existing
(GTFS) vs proposed (drawn)" comparison.

**Verdict:** don't build this directly. It is the *composition* of the
Transit Travelshed Engine + existing LODES machinery + Scenario Save & Compare.
Methodology disclosure matters for consulting use: frequency-based not
schedule-based, average-wait assumption, transfer cap, no reliability/crowding.

### Transit / Auto Opportunity Ratio — Not started
Kimley-Horn's Access2Opportunity framing (also central to Jarrett Walker's
work): the ratio of opportunities — jobs, healthcare facilities, essential
services — reachable within 30/45/60 minutes **by transit vs. by private auto**,
surfacing the "opportunity gap" and proving where transit is a viable
alternative to driving and where it fails. The transit half is the
Cumulative-Opportunity Transit Accessibility computation above (travelshed ∩
opportunities). The **auto half is feasible entirely offline**: `js/core/road-network.js`
already carries a car-mode Dijkstra (`findLocalRoute`, class-aware `carBlocked`
traversal), so a drive-time travelshed can be flooded from the same origin on
the same graph — no OSRM travel-time matrix, no public-server rate-limit
fragility. Ratio = opportunities(transit-shed) / opportunities(auto-shed),
rendered as a per-origin metric or a choropleth of the gap. Depends on the
Transit Travelshed Engine; the auto comparator is a modest add on the existing
car-mode graph. High consulting-differentiator value.

### FTA STOPS-Style Ridership Modeling — Not started
A new analysis module that replicates or approximates the methodology of FTA's STOPS (Simplified Trips-on-Project Software) model. STOPS is FTA's official ridership forecasting tool for Small Starts and some New Starts projects. It estimates **station-level boardings** by modeling three things: where people want to go (destination attractiveness), how well transit gets them there (accessibility via travel time), and how likely they are to choose transit over driving (mode share).

**What the app already covers (demand/demographic side):**
- Population and employment density scoring (TPI's 9-factor system, ACS + LODES)
- Station placement with configurable walk-access buffers
- GTFS feed parsing (shapes, stops, stop_times, routes, trips all available in-browser)
- Corridor Demand Index (CDI) — population-weighted composite demand score per route
- Area-weighted census aggregation within buffer polygons
- Ridership calibration workflow (ratio and OLS regression against observed data)

**What's missing (accessibility/supply side):**
1. **Transit travel time engine** — Parsing GTFS `stop_times.txt` to compute actual A-to-B transit trip durations including transfers, wait times, and walk access. The GTFS module currently displays feed data but does not route through it. Implementing a RAPTOR or Connection Scan algorithm in JS is feasible but computationally intensive for large feeds.
2. **Auto travel time matrix** — Zone-to-zone driving times for mode choice comparison. The app already uses OSRM for route snapping, but building a full matrix for hundreds of zones would require many API calls.
3. **Origin-destination trip table** — STOPS uses a simplified O-D matrix derived from census journey-to-work data (CTPP or ACS commuting flows). The app has employment via LODES but not the O-D flow structure.
4. **Mode choice model** — A logit function estimating probability of choosing transit vs. auto based on relative travel time, cost, and traveler characteristics. The math is straightforward; calibration data is the constraint.
5. **Station-level boarding allocation** — Distributing corridor-level demand across individual stations based on walk catchment area and destination accessibility.

**Architectural options:**
- **Pure in-browser:** Consistent with the app's zero-build-step philosophy. Demand-side and mode choice math are lightweight. The bottleneck is transit travel time computation from raw GTFS — JS implementations of RAPTOR exist but may struggle with large feeds (thousands of trips). Auto travel time matrices would require heavy OSRM usage.
- **Local helper tool:** A Python or Node CLI that runs OTP or OSRM locally to precompute travel time matrices, exporting results as JSON for the web app to import. Breaks the "just open index.html" simplicity but handles the computationally intensive piece.
- **Hybrid (recommended):** The web app handles UI, demographics, scoring, mode choice, and boarding allocation. A lightweight local helper precomputes the travel time matrix from the GTFS feed + road network and exports a JSON file that the web app imports as a data input (similar to how LODES CSVs are uploaded today). Keeps interactive analysis in-browser while offloading the one piece that genuinely needs more horsepower.

**Dependencies:** Builds on `census.js` (ACS fetch), `lodes.js` (employment), `tpi-scoring.js` (demand scoring), `gtfs.js` (feed parsing), `stations.js` (station placement + buffers), and the popup module system. The travel time matrix — whether computed in-browser or imported — is the critical new data input.

**Files (anticipated):** `js/projects/fta-stops.js`, `projects/fta-stops-popup.html`, and potentially a standalone helper script (Python or Node) for travel time matrix generation.

### CSV point import — Implemented
Upload a CSV with lat/lon columns (auto-detected) via Add Data (+) → Spatial Data → point features. `importCSV` (`js/core/cache.js`) also recognizes a geometry_type column for lines/polygons.


### Frequency / service heatmap — Not started
Color route segments by headway or span drawn directly from the route attributes already stored per feature (frequency field in minutes, spanStart/spanEnd). Visual equivalent of a GTFS-based frequency map for proposed service. Could use a diverging color ramp (green = frequent, red = infrequent).

### Frequent Transit Network (FTN) & span visualizer — Not started
A time-of-day slider that filters the drawn network to display only routes running at a chosen headway threshold (e.g. ≤15-min) at the selected time, visually highlighting the **core network** a rider can use without checking a schedule — and emphasizing **span** (how many hours a day that frequency actually holds), which increasingly matters for proving a network serves non-commute trips. Pure client-side: time bands already carry `from`/`to` + `frequency` per day type, and `getEffectiveServiceBands` (`js/core/service-assembly.js`) resolves the active band at any probe time. Complements the Frequency / service heatmap (which colors segments by headway) and the Transit Coverage module (single peak-headway snapshot); the novel pieces are the time-of-day slider and the span roll-up. Could live as a present-mode map overlay or extend Transit Coverage. No new data.

### Transfer connectivity scoring — Not started
Given multiple drawn routes, identify overlap zones and score transfer quality based on shared stop proximity and frequency pairing. Output: a map overlay flagging strong/weak transfer nodes and a summary table.

### Stop spacing analyzer & consolidation optimizer — Not started
Flag segments of a drawn route where stop spacing is too tight (below a minimum threshold) or too wide (above a maximum) vs. a user-configurable target distance, highlighting problematic segments on the map in a distinct color.

**Consolidation economics (Nelson\Nygaard "Smart Stops" framing):** speeding up a route by removing closely-spaced stops is politically contentious, so ground it in data. Given stop Points along a route (they carry `stopId` / `associatedRoutes`), compute average spacing, flag consolidation candidates (e.g. under ¼ mile), and estimate the **run-time saved** per removed stop (a dwell + accel/decel knob, same style as the travelshed boarding penalty) → feed Route Costing's rev-hour math (`js/projects/route-costing.js`) to show **annual operating cost recovery**. Selecting *which* low-ridership stops to cut can use an imported per-stop boardings CSV (CSV point import). No new external data if stops are placed as Points.

### Segment-level delay heatmap — Not started (needs external speed data)
Nelson\Nygaard's right-of-way selling point: map average bus speed vs. posted limit at the segment level to flag "choke points" where transit-priority interventions (bus lanes, signal priority) yield the highest cost savings. **Requires historical AVL or GTFS-RT speed data, which the app does not ingest** — our routes are drawn proposals, not operating vehicles, and GTFS-RT is a streaming feed needing a backend/CORS proxy (against the "just open index.html" model). The only lightweight path: let the user **import a segment-speed CSV** (existing CSV import) keyed to route segments and render it as a heatmap. Deferred until that data path is worth building.

### Multi-variable equity index builder — Not started
Extend TPI to a fully user-composable index: select any 3–5 ACS variables from the existing `VAR_META` catalog, assign weights, and output a scored choropleth. Removes the constraint of TPI's fixed 9 factors while reusing all existing ACS fetch and quintile normalization infrastructure.

### Demographic change over time — Not started
Compare ACS 5-year estimates across two user-selected years for the study corridor. Output a map and table flagging areas with the largest demographic shifts. Useful for long-range planning and Title VI cumulative-impact analysis.

### Environmental Justice overlay — Not started
Pull EPA EJScreen percentile data for the study area as a reference choropleth layer. Covers climate risk, air quality, and traditional EJ indicators. Standard contextual layer for FTA, RAISE, and INFRA grant applications. EJScreen has a public REST API.

### Census geography profile cards — Not started
Click any census tract or block group on a choropleth overlay to get a floating card with key demographics (population, minority share, median income, zero-vehicle HH %, etc.). Currently hovering shows only the GEOID and TPI score; a full profile card would improve interpretability.

### Imported Geography Analysis module — Not started
A new **General**-group module (`js/projects/imported-geography.js`, `projects/imported-geography-popup.html`) that loads a GeoJSON of polygon zones carrying their own attributes (TAZ households/employment, model outputs, etc.), choropleths any numeric attribute via the shared `App.choropleth` engine, and summarizes attributes within a drawn study area. GeoJSON only — no shapefile dependency; the empty state links mapshaper.org for free shapefile→GeoJSON conversion. This was originally scoped as Phase 4 of `docs/feature-area-choropleth-plan.md` and has been moved here — that plan's actual scope (the shared choropleth engine + its migration across Feature Area Analysis/TPI/Ridership Forecasting/Corridor Scoring) is complete; this module is a net-new build, not a continuation of that work.

**Module skeleton:** `id: "imported-geography"`, name "Imported Geography Analysis", `popupWidth: 960`, `panelWidths: { setup: 520, results: 760 }`, 2-column Settings | Results on the shared `.rf-*` shell (same pattern as every other analysis module). All element ids `ig`-prefixed. Registered in the toolbar Analysis menu's **General** group alongside Feature Area Analysis and Walkshed (`buildAnalysisButtonsHTML()` in `js/app.js`).

**Import + validation:** "Load GeoJSON" file input (`.geojson,.json`), parsed with `JSON.parse` — no new libraries. Accepts a `FeatureCollection` of `Polygon`/`MultiPolygon` (other geometry types skipped with a count note); validation errors surface in the status pill, never thrown. On load: scan `properties` across features to discover numeric fields (≥90% of non-null values parse as finite numbers via `App.toNumberSafe`) as choropleth-able, and all fields as zone-id candidates (dropdown seeded by `App.guessHeader` with candidates like `taz`/`taz_id`/`id`/`zone`/`zone_id`/`geoid`/`name`, falling back to row number). Each accepted feature is stamped `properties.GEOID = String(<zone id value>)` on an **internal copy only** (never mutate the user's parsed object beyond the stamped clone) — this is the load-bearing convention that lets the module reuse `App.aggregateWithinUnion`, `App.computeGeoOverlapFractions`, and `App.choropleth` unchanged, since all three key on `properties.GEOID`. Data is not session-persisted (LODES/GTFS precedent — too large); only the filename hint + settings persist, with a "re-upload to restore" note on session restore.

**Choropleth + hover + legend:** a "Map attribute" select (numeric fields) plus the same Shade-by (count / density, and percent-of-a-second-field), ramp, and classes controls Feature Area Analysis already exposes — all driving `App.choropleth.render({ id: "ig", ... })`. Hover shows the zone id, the mapped attribute, and up to 10 other numeric attributes. Legend reuses the shared `projects/choropleth-legend.html` widget (`ig-legend`). Layers panel gains an `ANALYSIS` manifest entry for `ig-choropleth-fill`/`-line`, labeled "Imported geography."

**Study-area summary (optional per run):** a feature checklist + Buffer distance (mi) + Use Display Buffers, the same pattern as Feature Area Analysis via `js/core/module-buffers.js` (`App.readAnalysisBufferMiles`, `App.buildAnalysisBufferSet`/`buildDisplayBufferSet`), plus an "entire layer" default when nothing is selected. Results table: per selected numeric attribute, area-apportioned sum and area-weighted average (via `computeGeoOverlapFractions` + `aggregateWithinUnion` with `"sum"`), with the standard apportion toggle. A per-zone CSV export mirrors Feature Area Analysis's per-geography export (zone id, overlap fraction, attributes, apportioned values).

**Lifecycle:** standard suite plumbing — status pill + stale banner (`App.renderModuleState`), stale when drawn features change *and* a study-area summary exists; a `clear` hook removing layers/legend/data; an empty-state hint ("Load a GeoJSON of zones to begin — convert shapefiles free at mapshaper.org"); settings-only cache registration (schema v1). No golden case needed — no new pure math, all engines (choropleth classification, aggregation) are reused as-is.

**Files (anticipated):** `js/projects/imported-geography.js`, `projects/imported-geography-popup.html`; edits to `index.html` (script tag), `js/app.js` (`buildAnalysisButtonsHTML()` General group), `js/core/layers-panel.js` (`ANALYSIS` manifest entry).

---

## Persistence & Export


### External Data Import — Implemented
Superseded by "Import geospatial data (KML/KMZ/GeoJSON)" above.

### Read-only share link — Implemented
Compressed URL hash (pako-deflated `#share=`) encodes full session state, opening in view-only mode with no backend. `exportShareLink` / share-hash load in `js/core/cache.js`.

### Scenario Save & Compare System — Not started
The instinct here is right, and it's also the architecturally cheap answer: we
already have whole-session export/import with per-module `collect/apply`
persistence, and per-module scenario managers (RF Scenarios tab, Title VI
Scenarios) have proven to be the *expensive* pattern — each one is bespoke UI.

Recommended ladder:

1. **Named session slots (build soon, low effort).** Today localStorage holds
   exactly one session (`"mat-session"`), and file export/import is the only
   way to keep alternatives. Add "Save as scenario…" / "Switch scenario"
   backed by multiple named localStorage keys (same schema, plus a name and
   timestamp). For a non-technical user this converts a fiddly
   export-file-then-reimport dance into a dropdown. Watch localStorage quota
   (~5MB) — sessions are small since LODES isn't cached, but cap slot count
   or fall back to file export gracefully.

2. **Scenario Comparison module (the real payoff).** A system module (like
   Attribute Summary) that loads 2+ scenario states **read-only** and renders
   a side-by-side table of *persisted module results* — not live recomputes.
   This is the key design decision: several modules already persist their last
   summary (`route-costing` lastSummary, `corridor-scoring` lastSummary, RF
   calibration + demand). Comparing those requires **zero Census/LODES calls**
   and no map juggling. Requirements it imposes on new modules: the Transit
   Coverage module should persist its results table in `collect()` from day
   one, specifically so scenarios can be compared (it already does). Each
   compared column shows the run timestamp and a stale flag (results in a
   saved state may predate the features in it — surface that honestly rather
   than recomputing silently).

3. **Side-by-side maps** — defer. High UI cost, and the comparison table plus
   switching scenarios covers most of the consulting need.

**Shortcomings**
- Comparing persisted results means comparing *what was last run*, not a
  guaranteed-fresh computation. Mitigation: prominent timestamps/stale badges,
  and a per-scenario "open & re-run" affordance.
- Cross-scenario normalization: scores like TPI/CDI are normalized within
  their own run's pool, so comparing raw composite scores across scenarios is
  not apples-to-apples (this is the same problem shared-pool mode solves in
  RF). Coverage %, costs, rev-hours, and ridership are absolute and compare
  cleanly — lead with those in the comparison table; badge normalized scores
  with a warning.

**Effort:** slots = small; comparison module = moderate.

### Map export (PNG / PDF) — Not started
Export the current map view as a PNG screenshot (using MapLibre's `map.getCanvas().toBlob()`) or a titled, legended one-page PDF that drops straight into a board deck or grant application. High value, low complexity: pair `map.getCanvas().toBlob()` with a lightweight PDF library (jsPDF) — no backend needed. Reuse the present-mode legend, north arrow, and title overlays from `js/core/present-overlays.js` (and the last analysis run's summary stats) so the exported page matches what's on screen in Present mode.

### Session comments / sticky notes — Not started
Pin a text annotation to a specific map location. Notes persist in the session cache alongside drawn features. Useful for sharing a session with stakeholders who need to mark feedback or flag questions on the map.

---

## UI & Layout

### Stale & empty-state consistency — Not started
Standardize two cross-cutting popup patterns so the whole suite feels coherent. (1) **Stale banner:** most analysis modules already track a `_stale` flag — surface it as a uniform banner ("Inputs changed since last run — re-run to update") with a re-run affordance, instead of each module styling its own. (2) **Friendly empty states:** when a module has nothing to act on, show a one-line prompt ("Draw a route to begin", "Load a GTFS feed to begin") rather than an empty table. **Onboarding-aware:** given the beginner audience (see `CLAUDE.md`), each module's first open should show a one-line "what this needs" hint and lightweight tooltips on key inputs. Could be a shared helper (e.g., `App.renderModuleState({ stale, empty, hint })`) reused by every popup.

### Global "in progress" indicator — Not started
No app-wide visual cue exists today for a calculation in flight. The toolbar has a single `#status` text line (`App.setStatus`, `js/core/utils.js`) used pervasively across the app — Census/LODES fetches, road-network Overpass downloads, drawing feedback, and most analysis modules — but it's plain text that auto-clears after 5 seconds (`_statusTimer`) regardless of whether the underlying operation is still running, and carries no persistent visual weight, so it's easy to miss. Separately, each analysis module's popup shows its own local "running" status pill via `App.renderModuleState({ status: { kind: "running", ... } })` (`js/app.js`) — but that's scoped to whichever popup is open; closing the popup mid-run, or an operation kicked off from the toolbar/sidebar rather than a popup (an ACS batch fetch, a LODES download, an Overpass road download), currently leaves the user with no feedback once the 5-second toolbar line clears.

**What this adds:** a single, ambient "work is happening somewhere" affordance that's visible regardless of which popup (if any) is open — a persistent header/toolbar spinner, a small corner toast/notification stack, or a thin top-of-page progress bar. Driven by a shared, reference-counted `App.beginWork(label)` / `App.endWork(id)` pair so overlapping operations (e.g. a Census fetch running while a road-network download is also in flight) don't clobber each other's indicator state. This is meant to sit *alongside*, not replace, the existing per-module status pill and stale banner (`App.renderModuleState`) — those stay the detailed, in-context readout; this is the ambient cue for when nothing else is on screen. Particularly valuable for the beginner audience (see `CLAUDE.md`): a non-coder watching a blank screen during a multi-second Census/Overpass fetch has no way today to tell "still working" from "silently failed."

**Files to touch:** `js/core/utils.js` (extend `setStatus`, or add the new work-tracking helpers alongside it), `js/app.js` / `index.html` (toolbar chrome for the indicator itself), and every existing `App.setStatus(...)` call site (census.js, lodes.js, road-network.js, and each analysis module) would opt into the shared helper in addition to their current local message.

### Operation abort & cancellation — Not started
Heavy calculations (TPI scoring, Corridor Scoring, Ridership Forecasting, Transit Travelshed) often run for several seconds and trigger multiple async Census/LODES fetches, Overpass network queries, or multi-origin walkshed floods. If a user realizes mid-run they've misconfigured the analysis (wrong geography level, wrong feature selection) or simply changed their mind, they're stuck waiting for completion. Currently no way to abort.

**What this adds:** an Abort button (or Ctrl+Shift+Esc hotkey) that:
1. **Cancels in-flight fetches:** AbortController is already used in routes.js (OSRM preview throttle); extend it to Census `fetchACSValues`, LODES `fetchBlocksInternalPointsInUnion`, Overpass `fetchNetworkForBounds`, so a fetch abort immediately stops the XHR/Promise chain.
2. **Clears pending timers & chunked async:** some modules (Walkshed, Transit Travelshed) use chunked-async iteration (e.g., per-stop flood caching) that yields control back to the event loop between chunks; a cancellation token checked at each yield-point stops the loop, freeing memory.
3. **Resets UI state:** marks the module's `_running` flag false, hides the status pill, and optionally shows a brief "aborted" message.
4. **Appropriate cleanup:** ensures transient state (partial result objects, intermediate GeoJSON, map layers undergoing rendering) is discarded, not persisted or left dangling.

**Architectural pattern:** a module-local `let _abortController` or `let _cancelled` flag (checked at chunk boundaries); a shutdown sequence that clears the abort marker, cancels known AbortControllers, and nulls out partial results. Analysis modules already guard DOM writes with `App.popup.isOpen()`, so aborting mid-render has limited impact. The real hazard is a partial `_lastResult` being persisted by accident — an abort should clear `_lastResult` unless the user explicitly saves a prior complete run.

**Effort:** low-moderate per module (abort controller wiring + yield-point checks), high if harmonizing across all async Census/LODES call sites (but the payoff is broad: applies to TPI, Corridor Scoring, Ridership Forecasting, Transit Travelshed, and future analysis modules alike).

### Resizable sidebar — Low Priority
Allow the user to drag the sidebar edge to resize it. Currently the sidebar is a fixed 310px width defined in `css/sidebar-v2.css`.

### Reorderable sidebar panels — Low Priority
Allow the user to drag sidebar sections (Buffer-Area Data, project panel, LODES) into a preferred order. Could use native drag-and-drop or a lightweight sortable library.

### Dynamic panel loading/unloading — Low Priority
Let users show/hide individual sidebar panels (e.g., collapse LODES section if not needed, or hide the project panel). Toggle via checkboxes or a panel menu.

### Modern UI refresh — Implemented
Completed phases 0–7 of the dependency-free refresh: design tokens, semantic light/dark colors, Inter and the type scale, shared controls/layout primitives, static inline-style cleanup, non-modal floating analysis panels, collapsible single-step Inputs, toolbar/menu hierarchy, accessibility, documentation, and refreshed visual baselines. Implementation plan and phase records: [`docs/ui-refresh/`](docs/ui-refresh/).

### Floating vertical icon rail (toolbar redesign) — Not started
Move draw tools out of the horizontal top bar and into a compact vertical icon strip on the left edge of the map (similar to Felt or Mapbox Studio). Frees the top bar for session-level actions: project name, share link, export, and reset. Reduces visual clutter and scales better as more draw tools are added.

### Analysis dropdown navigation — Partially implemented
Phase 7 grouped `buildAnalysisButtonsHTML()` into **General** (Feature Area Analysis, GTFS, Title VI) and **Transit** sections, with an automatic **Other** fallback so future registered modules never disappear. Remaining optional directions:
- **Additional menu-bar buttons** — split "Analysis" into more than one top-level toolbar entry instead of one growing dropdown.
- **A sidebar-style switcher inside the module popup itself** — every module already opens in the same `#module-popup` shell (`js/core/popup.js`), so the popup could gain a persistent left-hand list of modules (mirroring the app's own left sidebar) letting users jump between analyses without backing out to the dropdown each time.
- A searchable/filterable list, which converges with the Command Palette idea below, once the count gets large enough that browsing linearly stops scaling.

### Top menu layout and hierarchy — Partially implemented
Phase 7 separated session/workflow actions on the left, drawing tools/actions in the center, and dark-mode/presentation view controls immediately beside location search on the right. Subtle separators now show the three functional groups. The vertical icon rail remains the open structural redesign item above.

### Command palette (Ctrl+K) — Not started
A keyboard-triggered search overlay that lets users reach any tool, analysis module, or action by typing. Increasingly standard in modern web tools (Figma, Linear, Notion, Arc). Especially valuable as the feature set grows. Could be implemented as a simple filtered list over a flat registry of labeled actions. One possible convergent answer to the Analysis dropdown crowding above — a typed search sidesteps the grouping question entirely.

### Layer panel — Not started
A dedicated panel listing all drawn feature groups and imported reference layers, with per-layer visibility toggles, opacity sliders, and draw-order control (drag to reorder). Becomes essential once GTFS import and CSV import are added. Modeled on Felt's layers panel.


### Keyboard shortcuts — Implemented
`Escape` cancel/close, `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Delete`/`Backspace` vertex removal, single-key draw-tool toggles (`S`/`L`/`R`/`P`/`M`/`T`/`B`), `Enter` finishes drawing via `App.finishDrawing()`. Wired in `js/app.js`. Possible future polish: shortcuts for analysis modules, a help overlay.



### Print / presentation mode — Implemented
"Present" button hides sidebar/feature panel/toolbar for a full-screen map (Exit button, `Escape` to toggle back). `App.setPresentMode` (`js/app.js`) + `js/core/present-overlays.js` (draggable legend, north arrow, title overlays).

### Classed & diverging legends with editable breaks — Not started
In present mode, support classed and diverging choropleth legends with user-editable break values, rather than only the current continuous/auto legend. Lets a presenter set meaningful thresholds (e.g., headway tiers, or a diverging ramp around a midpoint) and have the legend swatches + map classification update together. Builds on the legend overlay in `js/core/present-overlays.js` and pairs naturally with the Frequency / service heatmap idea (which needs classed headway bins).

## Development & Tooling

### Golden-value test harness — Implemented
Zero-install Node harness (`test/`) that pins pure calculation-function output in a Node `vm` sandbox (no browser/npm/build). Covers Ridership Forecasting, TPI, Route Costing, Trip Builder, Corridor Scoring, Transit Coverage, and Module Buffers; Title VI is intentionally deferred (see its entry above). Run with `node test/run-golden.mjs`; `--update` re-records after a deliberate change. Full workflow in `test/README.md`.

### Automated test runs on push (GitHub Actions CI) — Not started (future decision)
Today the golden tests run only when a person or the agent invokes them — the `CLAUDE.md` instruction makes that a reliable *habit*, but not a hard gate: if a session skips it, nothing physically blocks a bad number from being committed. A small GitHub Actions workflow (~15 lines) would run `node test/run-golden.mjs` automatically on every push / pull request, showing a green check or red ✗ on the branch and optionally blocking merge when red — a server-side guarantee that holds regardless of whether any session remembers. Because the harness needs no install (just Node), the workflow is minimal: check out the repo, set up Node, run the one command. **Recorded as a future decision, not a blocker** — the habit route is already live. Worth adding when a hard gate becomes valuable (e.g., more people/agents touching the calculation engines, or ahead of a release). No app-code impact: it is a single `.github/workflows/*.yml` file and changes nothing about the buildless, static nature of the app.
