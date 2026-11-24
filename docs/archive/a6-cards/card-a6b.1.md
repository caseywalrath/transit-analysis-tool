# Card A6b.1 (Haiku, xhigh): pure Service Equity engine + golden cases

## Files (only these)
- NEW `js/core/service-equity.js` — `window.ServiceEquity`, pure (no App, turf, DOM, map). Copy the header
  style and IIFE shape of `js/core/apportion.js`.
- `index.html` — one `<script src="js/core/service-equity.js"></script>` tag directly after the `apportion.js` tag.
- NEW `test/cases/service-equity.mjs` — golden cases (copy the shape of `test/cases/apportion.mjs`;
  `export default { scripts: ["js/core/service-equity.js"], cases }`).
- Seeded golden file `test/golden/service-equity.json` (created by `node test/run-golden.mjs --update`).

## Read first
`CLAUDE.md`, `docs/a6-cards/rules.md`, `js/core/apportion.js`, `test/cases/apportion.mjs`, `test/README.md`.

## API (exactly this)

### `ServiceEquity.lowIncomeSpec(definition)`
- `"poverty200"` → `{ id: "poverty200", label: "Below 200% of the poverty level",
  vars: ["C17002_002E","C17002_003E","C17002_004E","C17002_005E","C17002_006E","C17002_007E"] }`
- anything else (including `undefined`, `"poverty100"`) → `{ id: "poverty100", label: "Below the poverty level",
  vars: ["B17001_002E"] }`
- Return a fresh object each call.

### `ServiceEquity.distanceMi(lat1, lon1, lat2, lon2)`
Haversine, Earth radius 3958.7613 miles.

### `ServiceEquity.allocateStopTrips(stops, blocks, opts)`
- `stops`: `[{ id, lat, lon, radiusMi, trips }]`; `blocks`: `[{ geoid, lat, lon, pop }]` (geoid = 15-digit
  census block GEOID string); `opts.parentLength` (default 12; 11 = tract).
- For each stop with finite lat/lon, `radiusMi > 0` and `trips > 0`: find blocks with `distanceMi ≤ radiusMi`
  and `pop > 0` (treat non-number / NaN / negative pop as 0). `W` = sum of their pop. If `W > 0`, add
  `trips × pop / W` to `tripsByGeo[geoid.slice(0, parentLength)]` for each such block. If `W === 0`, push the
  stop id onto `unallocated` and add its trips to `unallocatedTrips`.
- Stops that fail the first test (bad coords, radius or trips ≤ 0) are ignored entirely (not unallocated).
- Speed: bucket blocks once into a grid of 0.01° cells keyed `Math.floor(lat/0.01) + ":" + Math.floor(lon/0.01)`;
  for each stop scan only cells covering `lat ± radiusMi/69` and `lon ± radiusMi/(69·cos(lat))`.
  Must handle 10,000 stops × 50,000 blocks in well under a second.
- `tripsByGeo` uses `Object.create(null)`.
- Returns `{ tripsByGeo, unallocated: [ids], unallocatedTrips, allocatedStops }` (allocatedStops = count with W > 0).

### `ServiceEquity.evaluate(rows, opts)`
- `rows`: `[{ geoid, pop, minorityPop, lowIncomePop, trips }]` (non-number / negative → 0);
  `opts.fourFifths` default 0.8.
- `totals = { pop: Σpop, trips: Σtrips, perCapita: pop > 0 ? trips/pop : 0 }`.
- For each `key` in `["minority", "lowIncome"]` (field `minorityPop` / `lowIncomePop`):
  - `avgShare = Σfield / Σpop` (0 when Σpop = 0).
  - A geo with `pop > 0` is **protected** when `field / pop > avgShare` (strictly greater), else **other**.
    Geos with pop 0 are in neither group.
  - each group `{ geoCount, pop, trips, perCapita }` with `perCapita = pop > 0 ? trips / pop : 0`.
  - `ratio = other.perCapita > 0 ? protected.perCapita / other.perCapita : null`;
    if `protected.pop === 0 || other.pop === 0` then `ratio = null`.
  - `band = ratio === null ? "insufficient" : ratio < fourFifths ? "disparity" : "no-disparity"`.
  - result `{ avgShare, protected, other, ratio, band }`.
- `geos`: one entry per input row, in input order: `{ geoid, pop, trips, perCapita, minorityShare,
  lowIncomeShare, isMinority, isLowIncome }` (shares 0 when pop 0; flags false when pop 0).
- Returns `{ totals, minority, lowIncome, geos, fourFifths }`.

## Golden cases (at least these, each with a one-line `// EXPECTED:` comment you worked out by hand)
1. `lowIncomeSpec` for undefined, "poverty100", "poverty200", "bogus".
2. `distanceMi(39.7, -105, 39.7, -105)` = 0 and `(39.7,-105,39.8,-105)` ≈ 6.909.
3. allocate: one stop, radius 0.25, trips 100, two blocks both inside in different block groups, pops 30 and 70 →
   tripsByGeo 30 / 70.
4. allocate: a block just outside the radius is ignored; a zero-pop block inside is ignored.
5. allocate: a stop with no populated blocks → unallocated, unallocatedTrips = its trips.
6. allocate: parentLength 11 (two blocks in the same tract, different block groups → one key).
7. allocate: two stops overlapping the same block add up.
8. allocate: stop with trips 0 / radius 0 / NaN lat ignored.
9. evaluate: four geos hand-built so minority ratio is < 0.8 (disparity) and low-income ≥ 0.8.
10. evaluate: all geos protected-or-equal → `insufficient`; empty rows; a pop-0 row.
11. evaluate: `fourFifths: 0.9` changes a band.

## Done when
- `node test/run-golden.mjs` → `PASS — N/N cases passed` after seeding with `--update`; inspect the seeded JSON
  against your EXPECTED comments and fix the CODE if any differs.
- `node test/doc-coverage.mjs` output: report it (do not edit docs).
