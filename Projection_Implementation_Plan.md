# Population Projections Integration — Implementation Plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/core-app.md. This file is historical.
> Deviation: shipped projections are additive population counts (pop_new = pop_census + pop_addition), not the multiplicative growth factors described below.

## Context

The TPI and Ridership Forecasting modules use ACS census data for current-year population, which anchors both the population density factor (35% of TPI weight) and the population-weighted CDI aggregation used throughout the ridership scoring engine. This change adds the ability to upload a pre-computed growth factor CSV — derived offline from the PPACG MPO's TAZ-level population projections (2020–2050) — so that TPI and ridership analyses can be run against projected future-year populations (2030, 2040, or 2050) without changing the underlying census geography or ACS workflow.

The MPO ArcGIS service (`PPACG_TAZ_Forecasted_Changes_2020_to_2050`) requires authentication and cannot be queried live from the browser. The offline crosswalk (TAZ polygons → census tract GEOIDs, area-weighted growth factor per tract) is a one-time ArcGIS/QGIS operation per metro area. The resulting CSV is reusable across projects. See `Projection_Crosswalk_Guide.md` for step-by-step instructions to produce the CSV.

---

## Methodology: Growth Factors, Not Absolute Values

TAZ model populations and ACS census populations use different methodologies and will not match exactly. To avoid apples-to-oranges substitution, growth factors (ratios) are used. The crosswalk uses **population weighting** (not area weighting) to prevent greenfield TAZs with near-zero baselines from producing extreme growth factors:

```
TAZ growth factor (year) = TAZ_pop(year) / TAZ_pop(2020)
weight(tract, TAZᵢ) = overlap_area(tract, TAZᵢ) × TAZ_pop_density_2020ᵢ
Tract growth factor (year) = Σᵢ[TAZ_gf_i × weight(tract, TAZᵢ)] / Σᵢ[weight(tract, TAZᵢ)]
```

At analysis time: `projected_pop = ACS_baseline_pop × tract_growth_factor`

Population weighting ensures dense, established TAZs dominate the tract-level average, while near-empty greenfield TAZs (e.g., 3 people → 5,992) contribute almost no weight despite their extreme ratios. Areas with no TAZ coverage default to a growth factor of 1.0 (no projected change).

---

## CSV Format (User-Prepared Offline)

Tract-level GEOIDs (11-character). When the TPI runs at block-group level, the parent tract is looked up by slicing the BG GEOID to 11 characters — the same pattern LODES uses for census aggregation.

```csv
GEOID,gf_2030,gf_2040,gf_2050
08041960100,1.08,1.22,1.41
08041960200,1.02,1.05,1.09
...
```

Missing GEOIDs default to growth factor 1.0 (no change assumed).

---

## Injection Point in TPI Pipeline

**Recommended: modify `acsData` after ACS fetch, before raw value computation.**

In `tpi-scoring.js`, after `batchFetchACS()` completes (around line 645), multiply `B01003_001E` values in the `acsData` Map by the corresponding growth factor. This is the most minimal and complete approach:
- The `pop_density` factor compute function (`vals.get("B01003_001E")`) receives the adjusted value automatically
- The `rawValues.get("pop_density")` values used as CDI weighting denominators in `ridership-scoring.js` are automatically correct
- No changes needed to individual factor compute functions or the ridership scoring engine

```js
// After ACS fetch, before raw value computation (~line 646):
if (options.growthFactors) {
  acsData.forEach(function(geoVals, geoid) {
    var tractId = geoid.slice(0, 11);
    var gf = options.growthFactors.get(geoid) || options.growthFactors.get(tractId) || 1.0;
    var pop = geoVals.get("B01003_001E");
    if (Number.isFinite(pop) && gf !== 1.0) geoVals.set("B01003_001E", pop * gf);
  });
}
```

The GEOID lookup tries exact match first (for tract-level analysis), then falls back to 11-char prefix (for block-group-level analysis mapping to parent tract).

---

## Files to Create

### `js/core/projections.js` (new, modeled on `js/core/lodes.js`)

Module-closure variables:
- `PROJ_DATA = null` — `Map<geoid(11-char), { gf_2030, gf_2040, gf_2050 }>`
- `PROJ_FILE_NAME = ""`
- `PROJ_YEAR = null` — `"2030"`, `"2040"`, `"2050"`, or `null` (= current year, no adjustment)

Exported on `App`:
- `App.projData` — getter returning `PROJ_DATA`
- `App.projFileName` — getter returning filename string
- `App.projYear` — getter/setter for selected projection year
- `App.projGrowthFactors()` — returns `Map<geoid, number>` for the current `projYear`, or `null` if no data / year is null. This is what gets passed to `TPI.computeTPI()`.
- `App.parseProjectionsCSV(file)` — reads file, parses GEOID/gf_2030/gf_2040/gf_2050 columns (auto-detect headers with `guessHeader`), returns the Map
- `App.setProjectionsData(data, fileName)` — stores data, updates UI
- `App.clearProjectionsData()` — clears data, resets UI

No gzip support needed (these are small, user-prepared CSVs). Use `App.parseCSV()` (already in `utils.js`) for parsing.

---

## Files to Modify

### `index.html`

Add script tag after `lodes.js`:
```html
<script src="js/core/projections.js"></script>
```

### `js/app.js`

**1. New sidebar panel** (order 25, between LODES at 20 and Analysis at 30):

```
▸ Population Projections  (collapsed by default)
  Projection year: [Current (ACS) ▾]  ← dropdown, disabled until data loaded
  [Upload CSV]  [Clear]               ← Clear hidden until data loaded
  <input type="file" hidden>
  Status: "No projection loaded — upload a growth factor CSV"
```

The year dropdown options: `Current (ACS)` / `2030` / `2040` / `2050`. Selecting `Current (ACS)` is equivalent to no projection (passes `null` growth factors to TPI).

**2. Event wiring** (in map `load` callback, same location as LODES wiring):
- Year dropdown `change` → update `App.projYear` → `notifyProject()` → `App.cache.save()`
- Upload button `click` → trigger hidden file input
- File input `change` → `App.parseProjectionsCSV(file)` → `App.setProjectionsData(data, name)` → `notifyProject()` → `App.cache.save()`
- Clear button → `App.clearProjectionsData()` → `notifyProject()` → `App.cache.save()`

### `js/projects/tpi-scoring.js`

In `computeTPI()` (line ~552):
1. Add `var growthFactors = options.growthFactors || null;` to options extraction
2. After ACS fetch (~line 645), insert the growth factor application block (see above)

No other changes to `tpi-scoring.js` needed.

### `js/projects/transit-propensity.js`

In `runTPI()`, add `growthFactors: App.projGrowthFactors()` to the `TPI.computeTPI()` options object.

### `js/projects/ridership-forecasting.js`

In each `RidershipModel.computeSystemDemand()` call, add `growthFactors: App.projGrowthFactors()` to the options object. Since `computeSystemDemand()` already passes its options through to `TPI.computeTPI()`, this propagates automatically.

Also check `computeCorridorDemand()` (legacy uncalibrated path in Demand tab) and add `growthFactors` there too.

### `js/core/cache.js`

In `collectState()`: add `projFileName: App.projFileName || "", projYear: App.projYear || null`

In `applyState()`: if `state.projFileName` exists, show re-upload hint in `#projInfo`; restore `App.projYear` if present (set the dropdown value accordingly).

Do **not** cache the Map data itself (same as LODES — data is not needed between sessions since re-upload is fast and the file is small).

### `css/sidebar-v2.css`

Add `.proj-actions` button group (same pattern as `.lodes-actions`):
```css
#sidebar .proj-actions { display: flex; gap: 6px; margin-top: 6px; }
#sidebar .proj-actions button { flex: 1; margin-top: 0; }
```

---

## UI Behavior

- **Year dropdown disabled** when no projection data is loaded; enabled after upload
- **Status text** below the upload button:
  - Before upload: "No projection loaded — upload a growth factor CSV"
  - After upload: "Loaded: filename.csv — 842 tracts — Projecting to 2040"
  - After clear: reverts to default message
- **Clear button** hidden when no data loaded; visible after upload (matches LODES pattern)
- **No "Download" button** — unlike LODES there is no standard URL to construct; user prepares the CSV offline using the crosswalk guide

---

## What Is NOT in Scope

- **Employment growth factors** — MPO has employee data by TAZ, but TPI's employment factor uses LODES data (block-level jobs), not ACS. Applying employment growth would require a different injection point (modifying LODES aggregation results). Defer to future work.
- **Housing unit projections** — not used in TPI or RF
- **Live ArcGIS service queries** — service requires authentication (403); offline crosswalk is sufficient
- **QGIS workflow** — the crosswalk guide covers ArcGIS Pro; QGIS is a valid alternative but not documented here

---

## Critical Files

| File | Role |
|------|------|
| `js/core/projections.js` | New module — parse/store/export projection data |
| `js/app.js` | New sidebar panel HTML + event wiring |
| `js/projects/tpi-scoring.js` | Add `growthFactors` option + apply to acsData post-fetch |
| `js/projects/transit-propensity.js` | Pass `App.projGrowthFactors()` to TPI |
| `js/projects/ridership-forecasting.js` | Pass `App.projGrowthFactors()` to RF/TPI |
| `js/core/cache.js` | Persist filename + year as re-upload hint |
| `index.html` | Add `projections.js` script tag |
| `css/sidebar-v2.css` | `.proj-actions` button group |

### Existing utilities to reuse

| Utility | File | Use |
|---------|------|-----|
| `App.parseCSV(text)` | `js/core/utils.js` | CSV parsing |
| `App.guessHeader(headers, candidates)` | `js/core/utils.js` | Auto-detect column names |
| `App.setStatus(msg)` | `js/core/utils.js` | Toolbar status |
| `.lodes-actions` CSS | `css/sidebar-v2.css` lines 134–142 | Button layout pattern |
| `.sb2-tiny` CSS class | `css/sidebar-v2.css` lines 83–86 | Status/info text |

---

## Verification

1. **Upload a test CSV** with a handful of real Colorado census tract GEOIDs and varied growth factors. Select year 2050. Re-run TPI — the population density choropleth should show higher scores in high-growth tracts.
2. **Current-year behavior unchanged** — with no projection loaded (or year = "Current (ACS)"), results must be identical to before this change.
3. **Ridership Forecasting** — with projection loaded, run Calibrate + Demand tabs. CDI values should change when switching from 2030 to 2050 projection year in areas with strong projected growth.
4. **Session cache** — reload the page; confirm the re-upload hint appears with the previous filename and the year dropdown restores to the saved value.
5. **Missing GEOIDs** — test with a CSV covering only part of the study area; verify uncovered tracts behave identically to the no-projection baseline.
