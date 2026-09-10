# Route Electrification Feasibility — route-range redesign plan

Rework of the existing ZEB demo module (`js/projects/zeb-feasibility.js`,
`js/core/zeb-model.js`). Written to be implemented step by step.

**Why:** the current dashboard grades each route by the worst *inferred vehicle
block*, shown as a 5-tier classification. Feedback from the project PM: the
mock-up is too small to read and there is too much text. The underlying reason
is that inferred blocks are an implementation detail the audience does not care
about, and "tier" is a taxonomy that has to be explained before it means
anything.

**What changes:** the headline number becomes **round trips per charge** — how
far a bus gets on one charge, expressed in the route's own round trips. It is a
count, so it reads at a glance, colors a map without a legend paragraph, and
needs no block inference at all. Every route row expands to a state-of-charge
curve plotted **against miles travelled**, drawn inline in the panel.

**Scope note:** this is a demo/visualization module for an RFP task. Break
points and the deadhead allowance are deliberately coarse. Do not add
sophistication the plan does not ask for.

---

## 1. The model

All inputs already exist in `data/zeb/zeb-demo-data.js`. Nothing new is invented
— this is the same energy model solved for distance instead of for a ratio
against one block.

```
usableKWh             = batteryKWh × (1 − socBuffer)
kWhPerMi              = baseKWhPerMi × gradeFactor × seasonFactor
usableMiles           = usableKWh / kWhPerMi            // miles until SoC hits the reserve
revenueMilesPerCharge = max(0, usableMiles − deadheadMiles)
roundTripsPerCharge   = revenueMilesPerCharge / roundTripMiles      // fractional
roundTripsWhole       = floor(roundTripsPerCharge)
chargesPerDay         = ceil(roundTripsPerDay / roundTripsPerCharge)
```

Worked example — Greeley-Evans (40-ft, plains, winter), for the implementer to
check against:

```
usableKWh   = 440 × 0.80              = 352 kWh
kWhPerMi    = 2.10 × 1.00 × 1.30      = 2.73
usableMiles = 352 / 2.73              = 128.9 mi
revenue     = 128.9 − 6               = 122.9 mi
round trip  = 14.2 mi  ->  8.65 round trips per charge, 8 whole
```

### Round-trip miles from GTFS

Per route, over the trips on that agency's representative service day
(`ZEB.pickRepresentativeService`, unchanged). Three bases, checked in order:

| Basis | Test | `roundTripMiles` | `roundTripsPerDay` |
|---|---|---|---|
| `loop` | majority of trips start and end within `blockChaining.terminalToleranceMi` of each other | mean of all trip miles | `tripCount` |
| `directions` | trips exist with both `direction_id` `0` and `1` | `mean(dir 0) + mean(dir 1)` | `tripCount / 2` |
| `doubled` | otherwise | `2 × mean(all trip miles)` | `tripCount / 2` |

`direction_id` comes straight off the `trips.txt` row; first/last stop coords
are already on each digested trip (`firstStop` / `lastStop`). The loop test
matters — Avon has loop routes, and doubling a loop would report double the
real round trip.

### Deadhead

One number input, **"Deadhead allowance (mi/day)", default 6**, charged once at
the start of the charge (not per round trip). It is explicitly synthetic. The
real depot→first-stop distance is still *shown* in the expanded row as context
(`ZEB.deadheadMiles` already computes it from the agency depot coords), but it
does not drive the math. Do not build an auto/override toggle.

---

## 2. Step 1 — engine (`js/core/zeb-model.js`)

Add two pure functions. Plain JSON in / plain JSON out, no DOM, no turf, no
`App` — same contract as the rest of the file.

```js
// params: { batteryKWh, baseKWhPerMi, gradeFactor, seasonFactor, socBuffer,
//           deadheadMiles, roundTripMiles, roundTripsPerDay }
ZEB.routeRange(params) -> {
  usableKWh, kWhPerMi, usableMiles,
  deadheadMiles, revenueMilesPerCharge,
  roundTripMiles, roundTripsPerCharge, roundTripsWhole,
  roundTripsPerDay, chargesPerDay, coversDay,
  points: [ { mile, soc }, { mile, soc } ],   // (0, 1.0) and (usableMiles, socBuffer)
  marks:  [ { mile, tripNo, complete } ]      // round-trip completions
}
```

`marks` runs `tripNo = 1..roundTripsWhole + 1` at
`mile = deadheadMiles + tripNo × roundTripMiles`; the final one has
`complete: false` (it is the one the bus does *not* reach, drawn grayed so the
chart shows how close it came). Cap the array at 24 entries so a short shuttle
route cannot generate hundreds of marks.

Edge cases, all of which need a golden case:

- `roundTripMiles <= 0` or non-finite → `roundTripsPerCharge: null`, `marks: []`
- `batteryKWh` or `kWhPerMi` of 0 → `usableMiles: 0`, `roundTripsPerCharge: 0`
- `deadheadMiles >= usableMiles` → `revenueMilesPerCharge: 0`, `roundTripsPerCharge: 0`
- `roundTripsPerDay` missing → `chargesPerDay: null`, `coversDay: null`

```js
// breaks: ascending [{ min, label, color }] from ZebDemoData.chargeBreaks
ZEB.chargeBreakFor(roundTripsPerCharge, breaks) -> { index, label, color }
```

Returns the last break whose `min` the value clears; `index: -1` with a neutral
result for `null`/non-finite input.

**Do not delete** `buildBlocks`, `chainTrips`, `summarizeBlock`, `deadheadMiles`,
`energyForBlock`, `tierFor`, `scoreFor`, `summarizeRoute`, or `socProfile`. They
stop being called by the module but they are covered by the existing 177-case
golden suite, and `deadheadMiles` is still used for the depot-distance display.
Removing them means re-recording goldens for no benefit.

## 3. Step 2 — golden cases

Extend `test/cases/zeb-model.mjs` with cases for `routeRange` (the worked
example above, plus each edge case) and `chargeBreakFor` (one per bucket, plus
`null`). Hand-verify the arithmetic before seeding — same "verify before
seeding" convention the file's header comment already describes — then:

```
node test/run-golden.mjs --update
```

Commit the changed `test/golden/zeb-model.json` in the same commit. Existing
cases must not move; if any do, something in the shared code was changed by
accident.

## 4. Step 3 — demo data (`data/zeb/zeb-demo-data.js`)

Add:

```js
deadheadAllowanceMi: 6,
chargeBreaks: [
  { min: 0,  label: "Under 1 round trip", color: "#d73027" },
  { min: 1,  label: "1–2 round trips",    color: "#fc8d59" },
  { min: 2,  label: "2–4 round trips",    color: "#fee08b" },
  { min: 4,  label: "4–8 round trips",    color: "#91cf60" },
  { min: 8,  label: "8+ round trips",     color: "#1a9850" }
]
```

Keep `tiers` in the file — the engine's `tierFor` still references that shape in
its golden fixtures. It simply stops being read by the module.

**Sanity-check the breaks against the demo feed** once Step 5 renders. If every
route lands in one bucket the visualization is useless; adjust the `min` values
here (only here) until the two agencies separate. This is the one number in the
plan the implementer is expected to tune by eye.

## 5. Step 4 — feed digest (`prepareFeed`)

Replace the block-building tail of `prepareFeed` with a per-route digest. Keep
everything above it (shape miles, stop coords, route index, per-trip digest from
`stop_times.txt`, agency bucketing, `pickRepresentativeService`) — that all
still applies.

Add `direction_id` to each digested trip when reading `trips.txt`.

```js
routeDigests[routeId] = {
  routeId, agencyId,
  tripCount,                          // representative service day only
  oneWayMiles: { min, median, max, mean },
  roundTripMiles, roundTripBasis,     // "loop" | "directions" | "doubled"
  roundTripsPerDay,
  firstDepartMin, lastArriveMin,
  depotMiles                          // ZEB.deadheadMiles(depot, {firstStop,lastStop}) — display only
}
```

Return `{ agencies, routes, routeDigests, shapeGeomById }`.

Removed from the returned object: `blocks`, `blockLabels`, `method`.

Removed from the module: `blockLabel()`, `_preparedLayover`, the `chainingOpts`
argument, and the layover-driven rebuild condition in `ensurePrepared()` (the
digest now only rebuilds when the feed identity changes).

## 6. Step 5 — scoring (`runScoring`)

The per-block loop goes away. New shape: one pass over `routeDigests`.

For each route: resolve agency → climate zone, grade class, default vehicle
class; apply `routeOverrides` and the Vehicle-assumption dropdown exactly as
today; then call `ZEB.routeRange` once with the route's digest and the
resolved factors. Attach the digest, the range result, and
`ZEB.chargeBreakFor(...)` to the row.

`_lastResult` becomes `{ allRoutes, shownRoutes, vehicleClassesLocal }` where
each entry in `allRoutes` is
`{ routeId, name, longName, agencyId, agencyLabel, vehicleClassId, vehicleLabel, digest, range, bucket }`.

`filterAndSort()` keeps the same Agency / Route / Vehicle-class filters. Sort by
`range.roundTripsPerCharge` ascending (worst first) — same "worst at the top"
convention the ratio sort has today, `null` sinking to the bottom.

## 7. Step 6 — results table

Six columns, down from eight. Drop Class, Blocks, Worst block mi, Block kWh,
Req. kWh, Tier.

| Route | Trips/day | Round-trip mi | Miles per charge | Round trips per charge | ▸ |
|---|---|---|---|---|---|

- **Route** — name, long name, agency badge. Unchanged markup.
- **Round trips per charge** — the whole number in a large colored pill
  (`bucket.color`), the fractional value as small muted text beneath
  (`8` over `8.6`).
- Everything else is plain right-aligned numbers.

Vehicle class, kWh/mi, and battery move into the expansion. They are
assumptions, not findings, and having them in the row is most of why the
current table feels dense.

### Expanded row

Two-up. Left `.zeb-detail-facts`, right `.zeb-detail-chart`, one sentence
spanning both underneath.

Facts list (label / value pairs, no prose):

```
Agency                Greeley-Evans Transit
Vehicle               40-ft BEB · 440 kWh
Energy use            2.73 kWh/mi   (2.10 base × 1.00 grade × 1.30 winter)
Usable energy         352 kWh after 20% reserve
Deadhead allowance    6.0 mi/day
Depot distance        3.1 mi to first stop
Service span          06:12 – 19:47
One-way miles         6.8 / 7.1 / 7.4   (min / median / max)
Round trip            14.2 mi (paired directions)
```

`fmtHHMM` is still needed for the service-span line — keep it. `fmtHours` and
`blockLabel` are no longer used; remove them.

The sentence, which replaces the current rationale paragraph entirely:

> **8 round trips (114 mi) per charge.** Route runs 9 round trips/day — needs 2 charges, or a second bus.

Three variants only:

- `coversDay` → "…— one charge covers the day."
- `roundTripsPerCharge >= 1` → "…— needs {chargesPerDay} charges, or a second bus."
- `roundTripsPerCharge < 1` → "…— cannot finish one round trip on a charge."

This is where the old tier-4 "midday recharge required" idea survives, as plain
English rather than a category.

## 8. Step 7 — the state-of-charge chart

New `buildRangeChartSVG(row)`, replacing `buildSocChartSVG`. Rendered **inline
in the expanded row**, not in `#fp-mini-popup`. `openBlockDetail()` and the
"View SoC" button are removed; `App.openMiniPopup` is no longer used by this
module.

Because SoC against distance is linear and monotone, this chart is simpler than
the block/time one it replaces — and more honest, since the old one had to
assume 15 mph for the deadhead legs to place them on a time axis.

- Dependency-free inline SVG, `viewBox="0 0 640 200"`,
  `preserveAspectRatio="xMidYMid meet"`, `class="zeb-range-chart"`, capped at
  `max-width:100%`.
- **X**: 0 → `xMax = max(usableMiles, deadheadMiles + roundTripMiles × 1.15)`,
  rounded up to the next 10 mi. Ticks every 10 or 20 mi (pick so there are 5–8
  ticks). Axis label "miles travelled".
- **Y**: 0–100% SoC. Ticks at 0/25/50/75/100.
- **Reserve band**: filled rect from the buffer line down to 0,
  `rgba(215,48,39,0.10)`, with a dashed rule at the buffer labeled "20% reserve".
- **Deadhead**: light gray band from x=0 to x=`deadheadMiles`, tiny "deadhead"
  label.
- **Depletion line**: one straight segment from `points[0]` to `points[1]` —
  (0, 100%) to (`usableMiles`, buffer%).
- **Round-trip marks**: vertical hairline at each `marks[i].mile` with the trip
  number above the axis. `complete: false` renders at ~35% opacity.
- **Crossing dot** at `points[1]` labeled with the mileage, e.g. "128.9 mi".

Colors for chrome come from CSS custom properties (`--muted`, `--border`) so the
chart reads in dark mode; the reserve red and the bucket color are data
encodings and stay explicit hex, per the repo's design-token convention.

## 9. Step 8 — summary strip, map, legend

**Summary strip** — four stat tiles instead of five tier counts:
`Routes scored` · `One charge covers the day` · `Needs a midday charge` ·
`Can't finish a round trip`. Reuse `.zeb-tile` markup.

**Map colors** — `tierColorExpr()` becomes `chargeColorExpr()`:
`App.choropleth.buildStepColorExpr("roundTrips", [1, 2, 4, 8], colors, "rgba(160,160,160,0.6)")`
with `colors` read from `ZebDemoData.chargeBreaks`. Same five-bucket shape, so
the call site and the 5-row legend fragment both survive as-is.

`buildRoutesFC` properties become
`{ route_id, name, agency, vehicle, roundTrips, roundTripsWhole, roundTripMiles, milesPerCharge, tripsPerDay, bucketLabel }`.
Hover popup shows route, agency, and "N round trips per charge".

**Legend** (`projects/zeb-feasibility-legend.html`) — labels filled from
`chargeBreaks`; footer note becomes "Round trips per charge · depot-only
charging, 20% reserve."

The depot point/label layer, the `#zebHideColoring` toggle, and the three
`App.zebOverlays` checkboxes are untouched.

## 10. Step 9 — panel width

`panelWidths: { setup: 600, results: 1040 }` — the chart needs the room.

ZEB is already the documented unequal-width exception, and the safety argument
holds unchanged at any results width: `App.renderModuleInputs` collapses the
settings column to a one-line bar on a successful run, and
`.rf-section-row:has(> .module-inputs-collapsed)` stacks the row regardless of
container width, so the panel never un-stacks into two columns.

Mirror the new number in `test/ui-screens/capture.mjs`
(`ADAPTIVE_PANEL_WIDTHS["zeb-feasibility"]`). The `UNEQUAL_WIDTH_EXEMPT` set
already contains `"zeb-feasibility"` — leave it.

## 11. Step 10 — popup markup, export, persistence

**`projects/zeb-feasibility-popup.html`**
- Remove `#zebLayover` (max layover for chaining) from the Assumptions block.
- Add `#zebDeadheadMi` — "Deadhead allowance (mi/day)", default 6, min 0, max
  50, step 0.5.
- Footer note becomes one sentence: "Each route is measured by how far one
  charge goes, in round trips, with a 20% state-of-charge reserve."

**Feed bar** — drop the `blocks: <method>` clause. Optionally add the
representative service day's `service_id`.

**CSV** — new header:
`agency, route_id, route_short_name, route_long_name, vehicle_class, season, trips_per_day, round_trip_miles, round_trip_basis, one_way_median_mi, kwh_per_mile, battery_kwh, usable_kwh, deadhead_mi, miles_per_charge, round_trips_per_charge, charges_per_day, covers_day`.
Both `governing_block` columns are gone.

**GeoJSON** — same property set as `buildRoutesFC`; metadata block keeps
`season`, `vehicleAssume`, `assumptions`.

**Session state** — bump to `v: 2`. `assumptions.layover` is dropped,
`assumptions.deadheadMi` added. In `restoreZebState`, merge
`defaultAssumptions()` underneath whatever was restored so a v1 payload restores
cleanly with the new key defaulted and the stale key ignored.

**CSS** (`css/style.css`, `.zeb-` block) — remove `.zeb-blocks-table`,
`.zeb-soc-*`; add `.zeb-detail-grid` (two-column, stacking under ~700px),
`.zeb-detail-facts`, `.zeb-range-chart`, `.zeb-rt-pill`. Keep the existing dark
mode overrides in sync.

## 12. Step 11 — CLAUDE.md

Four places, all of which currently describe blocks and tiers:

1. **File Structure → `js/projects/zeb-feasibility.js`** — rewrite the entry:
   route digest instead of blocks, round trips per charge instead of tiers,
   inline range chart instead of the mini-popup SoC chart, new width.
2. **File Structure → `js/core/zeb-model.js`** — add `routeRange` and
   `chargeBreakFor`; note that the block/tier functions remain exported and
   golden-tested but are no longer called by the module.
3. **File Structure → `data/zeb/zeb-demo-data.js`** — add `chargeBreaks` and
   `deadheadAllowanceMi`; note `tiers` is retained for the engine's fixtures.
4. **Conventions → "Adaptive single-step panel widths"** — update the ZEB
   exception paragraph: 760 → 1040, and replace the "Tier column pill text"
   justification with the inline range chart.

Also update the **App Namespace → `zeb-model.js`** and
**`zeb-feasibility.js`** entries, and the one-line module description under
**Active modules**.

---

## Verification

Run all three before committing — the first two are cheap, the third is what
actually proves the redesign works.

1. **`node test/run-golden.mjs`** — must end `PASS — N/N`. Record the count in
   the commit message (`Verified: node test/run-golden.mjs → N/N`), per the
   repo's testing convention.
2. **UI regression harness** —
   `NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/ui-screens/capture.mjs`.
   Expect ~112/114 (two pre-existing skips). Inspect the ZEB images in
   `test/ui-screens/out/`, do not just read the pass count.
3. **Live check against the demo feed** — drive the real module: open the popup,
   click `#zebLoadDemoBtn` (loads `data/gtfs/colorado-demo-gtfs.zip`), click
   `#zebRunBtn`, expand a route row. Confirm:
   - no horizontal scroll (`scrollWidth - clientWidth === 0` on
     `.module-popup-body` before and after expanding),
   - the range chart renders with visible round-trip marks,
   - Avon's loop routes report `roundTripBasis: "loop"` and are not double-counted,
   - the two agencies land in different color buckets (if not, retune
     `chargeBreaks` per Step 3).

## Out of scope

- Opportunity/on-route charging modeling. The midday-charge conclusion stays a
  sentence, not a second scenario.
- Per-route deadhead override, auto/fixed deadhead toggle.
- Restoring blocks in any form, including as a hidden cross-check.
- Fleet sizing beyond the "or a second bus" clause.
- Touching any module other than ZEB.
