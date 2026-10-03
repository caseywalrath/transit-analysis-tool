# Transit Ridership Forecasting Tool — Strategic Evaluation & Implementation Plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/modules/ridership-forecasting.md. This file is historical.

## Context

We have a browser-based geospatial analysis tool (no backend, no build step, no npm) with a Transit Propensity Index (TPI) module that scores census geographies on 9 demographic/equity factors. The goal is to evaluate a proposed 4-layer ridership forecasting model against our current capabilities and determine the best strategy for implementation — what belongs in the existing app, what might need a companion tool, and what should use external tools like Excel.

---

## Current App Capabilities (What We Have)

| Capability | How It Works | Key Code |
|---|---|---|
| **TPI Scoring Engine** | 9-factor quintile-normalized composite scoring (pop density, employment, zero-car HH, poverty, senior, disability, POC, youth, LEP) | `js/projects/tpi-scoring.js` — `TPI.computeTPI()`, `TPI.rescoreFromRaw()` |
| **Census Data Fetching** | ACS 5-year API (2021-2024), batch by state-county, tract and block group levels | `js/core/census.js` — `fetchACSValues()`, `fetchTigerwebGeos()` |
| **LODES Employment** | Block-level C000 jobs via uploaded CSV/gzip, aggregated to tract/BG | `js/core/lodes.js` — `parseLodesFromUploadedFile()`, `computeEmploymentServedOnly()` |
| **Area-Weighted Aggregation** | Clips geographies to buffer union, computes overlap fraction, sums/averages | `js/core/census.js` — `aggregateWithinUnion()` |
| **Route Drawing** | OSRM street-snapped routes with configurable buffers | `js/core/routes.js` — stores full geometry + waypoints |
| **Choropleth Visualization** | MapLibre fill layers with hover tooltips, floating legend widgets | `js/projects/transit-propensity.js` — `renderChoropleth()` |
| **Module System** | Plugin architecture with popup UI, lifecycle hooks, `core` object access | `js/app.js` — `App.registerModule()` |
| **CSV Upload + Column Detection** | PapaParse + `guessHeader()` for flexible file ingestion | `js/core/utils.js`, FTA module pattern in `js/projects/fta-small-starts.js` |
| **Export** | GeoJSON, CSV, JSON session files | TPI export pattern + `js/core/cache.js` |

---

## Layer-by-Layer Evaluation

### Layer 1: Corridor Demand Potential — BUILD IN EXISTING APP

**Feasibility: ~85% of what's needed already exists.**

**What we can reuse directly:**
- `TPI.computeTPI()` produces per-geography demand scores within the buffer union — this IS the demand potential layer
- `TPI.rescoreFromRaw()` enables instant re-weighting without API calls
- Choropleth rendering, legend, hover tooltips — all exist in `transit-propensity.js`
- GeoJSON/CSV export with raw values, quintile scores, and classification

**What we need to add:**
- **Corridor Demand Index (CDI)**: A corridor-level aggregate of TPI scores (weighted average by population or area) — simple arithmetic over existing result objects
- **Segment-level analysis**: Split a route into segments using `turf.lineChunk()`, buffer each segment, intersect with already-fetched TPI geographies, compute per-segment demand scores. No additional API calls needed — raw values are already in memory from the initial `TPI.computeTPI()` call
- **High/Medium/Low classification** with adjustable thresholds (following FTA breakpoint pattern in `fta-small-starts.js`)

**External tools needed:** None for computation. LODES data still requires manual download/upload (existing pattern).

---

### Layer 2: Base Ridership Calibration — BUILD IN APP + EXTERNAL DATA PREP

**Feasibility: ~65% in-app. Data preparation is the bottleneck, not computation.**

**What we can build in the app:**
- **CSV upload** for observed ridership data (boardings/hour, daily ridership, frequency, service type per route), following the FTA module's file upload pattern with `guessHeader()` column auto-detection
- **Ratio-based calibration** (default): `calibration_factor = observed_ridership / corridor_demand_index` — pure arithmetic, no libraries needed
- **Simple OLS regression**: `Ridership = f(density, propensity score, frequency, span)` — ~50 lines of JavaScript for single/multiple regression with the normal equations. Feasible for 5-30 data points typical of local transit data
- **R-squared display** and sample size warnings
- **Calibration coefficient export/import as JSON** — allows external tools to set coefficients that the app consumes

**What needs external preparation:**
- The user must assemble observed ridership data into a CSV. Available data sources:
  - **NTD system-level data** for Mountain Metro (definitely available)
  - **UTA (Utah Transit Authority) route-level and stop-level data** (published monthly; similar mountain-west context — strong peer calibration candidate)
  - **Local route-level data** (availability uncertain — may or may not be obtainable from Mountain Metro)
- For rigorous multi-variate regression with full diagnostics (confidence intervals, residual plots), Excel Data Analysis or R/Python is more appropriate. Results feed back into the app via JSON coefficient import

**Calibration strategy given data availability:**
- **Primary approach — Peer calibration using UTA data**: Run TPI demand analysis on UTA corridors with known ridership, compute calibration factors, apply to Mountain Metro corridor with adjustment for system size/context
- **Secondary approach — NTD ratio calibration**: Use system-level NTD data (total ridership, total revenue hours) to establish a system-wide productivity baseline, scale by corridor demand relative to system average
- **If local route data becomes available**: Direct calibration against Mountain Metro route performance (ideal but not guaranteed)

**Recommendation:** Build ratio-based calibration as the primary approach (robust with small samples). Support peer-system calibration workflow (run demand on peer corridors, match to observed ridership, transfer coefficients). Make regression optional/advanced. Allow JSON import of externally-computed coefficients. A separate calibration plan may be needed to determine the best data sources and methodology.

---

### Layer 3: Service Elasticity Modeling — BUILD ENTIRELY IN APP

**Feasibility: ~95% in-app. This is arithmetic with literature-based defaults.**

**What we can build:**
- **Elasticity parameter sliders** following the TPI weight slider pattern (range + number dual-control, instant recalculation on change)
- **Service type presets** with editable multipliers:

| Service Type | Frequency Premium | Speed Premium | Mode Premium |
|---|---|---|---|
| Local Bus (baseline) | 0% | 0% | 0% |
| Enhanced Bus | +15-30% | +10% | +15-30% |
| Limited-Stop Express | +10-20% | +15% | +10-20% |
| BRT-style | +25-50% | +25% | +25-50% |

- **Range outputs** (low/mid/high) by applying the low and high ends of each multiplier range
- **Frequency elasticity formula**: `ridership_change = (new_freq / old_freq) ^ elasticity` where elasticity defaults to 0.5 (adjustable 0.3-0.6)

**External tools needed:** Literature lookup for elasticity values (TCRP reports). These become the defaults.

---

### Layer 4: Scenario Builder — BUILD MOSTLY IN APP

**Feasibility: ~80% in-app.**

**What we can build:**
- **Scenario definition** (2-4 scenarios): headway, span, stop spacing, speed, cost per revenue hour, vehicle type
- **Revenue hour calculation**: `route_length / avg_speed * trips_per_day`
- **Operating cost**: `revenue_hours * cost_per_revenue_hour * service_days`
- **Ridership estimates** (low/medium/high): `base_ridership * demand_multiplier * elasticity_adjustments`
- **Comparison metrics**: daily/annual ridership, boardings per revenue hour, cost per boarding
- **Comparison table** and **CSV/JSON export**

**What should use external tools:**
- Detailed capital cost estimation (vehicles, infrastructure, ROW acquisition) — better in Excel
- Lifecycle cost modeling and funding scenario analysis — better in Excel
- The app exports scenario parameters as CSV/JSON that feeds into external financial models

---

## Strategic Recommendation

### Overall Feasibility: ~80% achievable in the existing app

| Layer | In-App | External Data Prep | Separate Tool |
|---|---|---|---|
| 1. Corridor Demand | **85%** | 10% (LODES) | 5% |
| 2. Base Calibration | **65%** | **30%** (ridership CSV) | 5% |
| 3. Service Elasticity | **95%** | 5% (literature) | 0% |
| 4. Scenario Builder | **80%** | 10% (cost data) | 10% (financial) |

### Answer to the Three Options

**Option 1 — Expand the existing tool: YES, this is the primary path.**
Build one new module (`ridership-forecasting`) with a tabbed popup interface. Layers 1, 3, and 4 fit naturally. Layer 2 fits with CSV upload for calibration data. The module reuses `TPI.computeTPI()` for demand, adds arithmetic for elasticity/scenarios, and follows all existing UI patterns.

**Option 2 — Separate web app: NOT NEEDED for computation.**
The browser-only architecture handles the entire pipeline. There is no computation here that requires a backend. However, if the tool grows to need persistent storage, user accounts, or shared projects, a companion app could make sense in the future. For now, JSON import/export bridges the gap.

**Option 3 — External tools alongside: YES, for specific tasks.**
- **Excel**: Observed ridership data preparation, advanced calibration regression, capital/lifecycle cost modeling, financial scenario analysis. The app exports/imports CSV/JSON to interoperate.
- **ArcGIS**: Not required. The app's MapLibre + TIGERweb + Turf.js stack handles all spatial analysis needed. GeoJSON export allows bringing results INTO ArcGIS for presentation if desired.

### No separate web app is needed. The recommended architecture is:

```
┌─────────────────────────────────────────────────────────────┐
│                    EXISTING APP (browser)                    │
│                                                             │
│  ┌──────────────┐    ┌──────────────────────────────────┐  │
│  │ TPI Module   │    │ Ridership Forecasting Module      │  │
│  │ (existing)   │───>│  Tab 1: Demand (reuses TPI)       │  │
│  │              │    │  Tab 2: Calibration (CSV upload)   │  │
│  └──────────────┘    │  Tab 3: Elasticity (sliders)      │  │
│                      │  Tab 4: Scenarios (comparison)     │  │
│                      └──────────┬───────────────────────┘  │
│                                 │                           │
│                    JSON/CSV export ↕ import                  │
└─────────────────────────────────┼───────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │     EXCEL (external)       │
                    │  - Ridership data prep     │
                    │  - Advanced regression     │
                    │  - Capital cost modeling   │
                    │  - Financial scenarios     │
                    └───────────────────────────┘
```

---

## Implementation Plan

### Architecture: Single New Module with Tabbed Popup

One module registered via `App.registerModule()` with a 4-tab popup. Tabs unlock progressively as the user completes each step. Internal data flows between layers via closure variables (no serialization needed).

**New files:**
- `js/projects/ridership-scoring.js` — Computation engine (like `tpi-scoring.js`), exposes `window.RidershipModel` namespace
- `js/projects/ridership-forecasting.js` — Module IIFE with popup UI, lifecycle hooks, choropleth rendering
- `projects/ridership-forecasting-popup.html` — Tabbed popup layout
- `projects/ridership-legend.html` — Demand classification legend
- Script tags added to `index.html` after `transit-propensity.js`

**Popup structure:**
```
[Tab 1: Demand] [Tab 2: Calibrate] [Tab 3: Elasticity] [Tab 4: Scenarios]
┌────────────────────────────────────────────────────────────────┐
│  Tab content area (scrollable, varies per tab)                 │
│                                                                │
│  Tab 1: Geography/year selectors, Run Demand button,           │
│         segment count slider, CDI results, segment map         │
│                                                                │
│  Tab 2: Upload CSV button, column mapping dropdowns,           │
│         calibration mode selector (ratio/regression),          │
│         fit statistics, coefficient display, JSON import/export│
│                                                                │
│  Tab 3: Service type dropdown (presets), frequency/speed/      │
│         reliability sliders with ranges, adjusted ridership    │
│         estimate (low/mid/high)                                │
│                                                                │
│  Tab 4: Scenario A/B/C/D sub-tabs, operating params per       │
│         scenario, comparison table, export buttons             │
└────────────────────────────────────────────────────────────────┘
```

### Phase 1: Layer 1 — Corridor Demand Potential

**Goal:** Produce a Corridor Demand Index with segment-level analysis.

1. Create `ridership-scoring.js` with `window.RidershipModel` namespace
   - `RidershipModel.computeCorridorDemand(options)` — wraps `TPI.computeTPI()`, adds segment analysis
   - Uses `turf.lineChunk(routeLine, segmentMiles)` to split routes into segments
   - For each segment: buffer, intersect with TPI geographies (already in memory), compute segment CDI
   - Returns: per-geography scores + per-segment scores + corridor-level CDI

2. Create `ridership-forecasting.js` module IIFE
   - Register via `App.registerModule({ id: "ridership-forecasting", ... })`
   - Tab 1 UI: geography/year selectors, segment length input, "Run Demand Analysis" button
   - Reuse TPI's choropleth rendering pattern for demand map
   - Segment overlay on map (colored by demand level)
   - CDI export as GeoJSON/CSV

3. Create popup HTML with tab navigation
   - Tab 1 populated; Tabs 2-4 show "Complete previous step" placeholder

### Phase 2: Layer 3 — Service Elasticity

**Goal:** Apply literature-based multipliers to convert demand into ridership estimates.

1. Add Tab 3 UI to popup HTML
   - Service type dropdown with preset multiplier bundles
   - Individual sliders for frequency elasticity (0.3-0.6), speed premium, reliability premium
   - Each slider shows a range (low-high), produces three estimates
   - Instant recalculation on change (no API calls, following TPI rescore pattern)

2. Add to `ridership-scoring.js`:
   - `RidershipModel.applyElasticity(baseDemand, params)` — returns `{ low, mid, high }` ridership multipliers
   - Service type preset definitions with default ranges

### Phase 3: Layer 4 — Scenario Builder

**Goal:** Compare 2-4 service scenarios with operating cost and ridership metrics.

1. Add Tab 4 UI to popup HTML
   - Scenario sub-tabs (A, B, C, D) with operating parameter inputs
   - Headway, span, stop spacing, average speed, cost per revenue hour
   - Comparison summary table showing all scenarios side-by-side

2. Add to `ridership-scoring.js`:
   - `RidershipModel.buildScenario(params)` — computes revenue hours, operating cost, ridership range, boardings/rev-hr, cost/boarding
   - `RidershipModel.compareScenarios(scenarios[])` — produces comparison table data

3. Export: CSV comparison table, JSON full results

### Phase 4: Layer 2 — Base Ridership Calibration

**Goal:** Calibrate against observed local transit performance.

1. Add Tab 2 UI to popup HTML
   - CSV upload with column auto-detection (following FTA `guessHeader()` pattern)
   - Expected columns: route name, observed boardings/hour, daily ridership, peak frequency, service type
   - Calibration mode toggle: Ratio (default) vs. Regression
   - Results display: calibration factor(s), R-squared (for regression), sample size

2. Add to `ridership-scoring.js`:
   - `RidershipModel.calibrateRatio(observed, demandScores)` — computes boardings per unit of demand
   - `RidershipModel.calibrateRegression(data, variables)` — simple OLS implementation
   - `RidershipModel.importCoefficients(json)` / `exportCoefficients()` — for external tool integration

3. Connect calibration output to Layers 3 and 4 (replaces raw demand index with calibrated base ridership)

---

## Key Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Census API rate limits under heavy segment analysis | Fetch geographies/ACS once for entire corridor, intersect per-segment locally with Turf. No additional API calls. |
| Browser performance with many geometries (100+ BGs x 30 segments) | Use `turf.booleanIntersects()` as fast pre-filter. Async batching with `setTimeout()` for UI responsiveness. |
| Small sample sizes for regression calibration (5-15 routes) | Default to ratio-based calibration. Make regression optional. Display sample size warnings. Allow JSON coefficient import from external tools. |
| Beginner user overwhelmed by 4-tab workflow | Progressive disclosure: tabs unlock sequentially. Clear "Next Step" guidance. Status indicators per tab. |
| Popup size on smaller screens | Each tab is independent (not shown simultaneously). 960px width, responsive stacking at narrow viewports. |

---

## Calibration Data Strategy (Separate Workstream)

Layer 2 calibration depends on data that needs to be sourced and prepared outside the app. This is a parallel workstream:

**Step 1: Assess local data availability**
- Request route-level ridership data from Mountain Metro (boardings per route, boardings per revenue hour, peak/off-peak frequency, service type)
- If available: direct calibration is possible and preferred

**Step 2: Prepare UTA peer calibration dataset**
- UTA publishes monthly route-level and stop-level ridership data
- Select 10-20 UTA routes with comparable corridor characteristics (similar density, land use mix, demographics)
- Run TPI demand analysis on each UTA corridor using the same tool
- Build calibration table: UTA route → CDI score → observed ridership → calibration factor
- Apply peer-transfer adjustment for system size/context differences

**Step 3: NTD baseline**
- Pull Mountain Metro NTD data: total annual ridership, total revenue hours, total routes
- Compute system-wide productivity: boardings per revenue hour
- Use as a reasonableness check against corridor-level estimates

**Step 4: Build calibration CSV**
- Format: route name, corridor CDI, observed daily ridership, observed boardings/hour, peak frequency, service type
- Upload to app's Layer 2 tab
- The app computes calibration factor(s) and applies to the study corridor

This workstream can proceed in parallel with Phases 1-3 of development and feeds into Phase 4 when ready.

---

## Verification Plan

1. **Layer 1**: Draw a route corridor, run demand analysis, verify CDI scores match TPI scores for the same area, verify segment breakdown sums approximately to corridor total
2. **Layer 2**: Upload a test CSV with known ridership data, verify ratio calibration produces expected calibration factor, verify JSON export/import round-trips correctly
3. **Layer 3**: Select each service type preset, verify multipliers apply correctly, verify low/mid/high range outputs bracket the mid estimate
4. **Layer 4**: Define 2+ scenarios with different parameters, verify comparison table math (revenue hours, cost, ridership), export CSV and verify in Excel
5. **Integration**: Complete all 4 tabs end-to-end, verify data flows correctly between layers, verify stale detection cascades when features change
