# Card A7b.1 — `window.ServiceCompare` (pure engine) [Haiku, xhigh]

## 1. Goal
A new pure engine that matches routes between a No-Build and a Build service summary, computes per-route and
total changes, and pre-checks changed routes against the Title VI major-change rules.

## 2. Read first
- `CLAUDE.md`, `AGENTS.md`, `docs/A7-plan.md`.
- `js/core/service-equity.js` (file layout to copy: IIFE, `window.X = {...}`, header comment).
- `js/core/gtfs-schedule.js`: `function serviceYearOf` (the `year` shape: `routes[key].annual`, `.peakVehicles`,
  `.perDay.weekday.spanHrs`; `total.annual`, `total.peakVehicles`, `total.perDay.weekday`).
- `js/projects/title-vi-engine.js`: `var RULE_DEFS` and `majorChange:` in the default policy (rule ids, `enabled`, `threshold`).
- `test/cases/service-equity.mjs` (case file style), `test/README.md`.
- `index.html`: `<script src="js/core/service-equity.js">`.

## 3. Files you may change
- `js/core/service-compare.js` (new)
- `index.html` (one tag immediately after `<script src="js/core/service-equity.js"></script>`)
- `test/cases/service-compare.mjs` (new), `test/golden/service-compare.json` (only via `--update service-compare`)

## 4. Contract
ES5 in `js/`. Never reads `App`, DOM or turf. Never throws on missing fields: absent numbers count as 0
(span as null). All output numbers rounded to 2 decimals (`Math.round(x * 100) / 100`); `null` stays null.

Input summary (both sides):
```
{ label: string, year: <serviceYear result>,
  routes: { key: { id, shortName, longName, type } } }      // keys are the keys of year.routes plus any routes without service
```

1. `ServiceCompare.matchRoutes(aRoutes, bRoutes, pairs)` → array of `{ a: keyA | null, b: keyB | null, how }`.
   - Step 1 `how "pair"`: each `pairs` entry `{a, b}` (array, may be null) whose `a` is in aRoutes and `b` in bRoutes and
     neither already used, in array order. A pair with `b === null` and a known `a` marks `a` as removed: output
     `{a, b: null, how: "pair"}`.
   - Step 2 `how "id"`: unmatched keys present in both.
   - Step 3 `how "short"`: `norm(shortName)` = trimmed lower-case; non-blank and occurring exactly once among the
     still-unmatched routes on each side.
   - Step 4 `how "long"`: same with `longName`.
   - Rest: `{a, b: null, how: null}` and `{a: null, b, how: null}`.
   - Output order: sorted by display name (`shortName || longName || id` of the a-side route, else the b-side) with
     `localeCompare(other, undefined, { numeric: true })`, ties by `(a || "") + "\u0001" + (b || "")` plain string order.
2. `ServiceCompare.compare(noBuild, build, opts)`; `opts = { pairs }` → `{ rows, total, counts }`.
   - Metrics, in this order: `trips`, `runningHrs`, `revenueHrs`, `platformHrs`, `cost` (all from `year.routes[k].annual`),
     `peakVehicles` (`year.routes[k].peakVehicles`), `spanHrs` (`year.routes[k].perDay.weekday.spanHrs`, null when
     the route or its weekday is missing).
   - Each metric `{ a, b, diff, pct }`: missing side → 0 (span null); `diff = b − a` (null if either is null);
     `pct = a ? diff / a * 100 : null` (null when a is 0 or null, or diff null).
   - Row: `{ aKey, bKey, name, match: how, status, metrics }`; `name` = display name as in step order above;
     `status`: `aKey === null` → `"added"`; `bKey === null` → `"removed"`; else `"changed"` when any metric's diff is
     non-null and `Math.abs(diff) > 0.005`, otherwise `"unchanged"`.
   - `total`: same metrics from `year.total.annual`, `year.total.peakVehicles`, `year.total.perDay.weekday.spanHrs`.
   - `counts`: `{ added, removed, changed, unchanged }`.
3. `ServiceCompare.precheck(rows, majorChange)` → array (only rows whose status is not `"unchanged"`, input order) of
   `{ aKey, bKey, name, changeType, revenueHoursPct, spanHoursPct, triggers, suggested }`.
   - `changeType`: added → `"new_route"`, removed → `"elimination"`, changed → `"adjustment"`.
   - `revenueHoursPct` = `metrics.revenueHrs.pct` (removed → −100, added → null); `spanHoursPct` likewise from spanHrs.
   - `triggers` (rule ids, this order): `"revenueHoursPct"` when `majorChange.revenueHoursPct.enabled` and
     `|revenueHoursPct| >= threshold`; `"spanHoursPct"` same; `"routeElimination"` when that rule is enabled and the row
     is removed. A missing `majorChange` or rule = disabled. `suggested = triggers.length > 0`.
4. `ServiceCompare.csv(result, labels)`; `labels = { a, b }` → `{ header: [...], rows: [[...]] }`.
   Header: `Route, Status, Matched by` then for each metric `<Metric> (<a>), <Metric> (<b>), <Metric> change, <Metric> change %`
   with metric names `Trips/yr, Running hr/yr, Revenue hr/yr, Platform hr/yr, Cost/yr, Peak vehicles, Weekday span hr`.
   Rows: one per result row, then a `Total` row (status and matched-by blank). Null → `""`.
5. `ServiceCompare.evaluate(fn, args)` → `ServiceCompare[fn].apply(null, args)` (golden entry point).

## 5. Edge cases
1. Both summaries empty → rows [], counts all 0, total metrics all 0 (span null).
2. A route key present in `routes` but not in `year.routes` (no service) → metrics 0, span null; status by match rules.
3. Two b-side routes with the same short name → neither matches by short name (step 3 needs uniqueness), then long name may.
4. A pair naming an unknown key is ignored.
5. `pct` when a = 0 → null.

## 6. Placement
As in §3. Header comment: what it is, that it is pure, and who calls it (GTFS Service Analysis Compare tab).

## 7. Steps
1. Engine. 2. Script tag. 3. Cases (fixtures below) and seed. 4. Hand-check the expectations in §8.

Fixtures (build in the test file with a helper `yr(routes, total)` that makes `{ routes: { k: { annual: {...}, peakVehicles, perDay: { weekday: { spanHrs } } } }, total: {...} }`):
- `NB`: routes `10` (short "10", long "Colfax"), `15` (short "15"), `20` (short "20"), `R1` (short "", long "Airport Rail").
  annual: `10` trips 1000 running 500 revenue 600 platform 690 cost 90000 peak 8 span 18;
  `15` trips 400 running 200 revenue 240 platform 276 cost 36000 peak 3 span 14;
  `20` trips 300 running 150 revenue 180 platform 207 cost 27000 peak 2 span 12;
  `R1` trips 200 running 300 revenue 330 platform 380 cost 49500 peak 4 span 19.
  total trips 1900 running 1150 revenue 1350 platform 1553 cost 202500 peak 17 span 20.
- `B`: routes `10` (short "10") same as NB except revenue 720 cost 108000 platform 828; `15X` (short "15") identical to NB `15`;
  `R1-new` (short "", long "Airport Rail") identical to NB `R1`; `d:svc1` (short "", long "Crosstown") trips 500 running 250
  revenue 300 platform 345 cost 45000 peak 4 span 16. No route `20`.
  total trips 2100 running 1250 revenue 1590 platform 1749 cost 238500 peak 19 span 20.
Cases: `compare-basic` (NB vs B, no pairs), `compare-pairs` (pairs `[{a:"20", b:"d:svc1"}]`), `compare-pair-removed`
(pairs `[{a:"15", b:null}]`), `compare-empty`, `match-dup-short` (b has two routes short "10"), `precheck-default`
(rows of compare-basic, majorChange `{revenueHoursPct:{enabled:true,threshold:25}, spanHoursPct:{enabled:true,threshold:25}, routeElimination:{enabled:true}}`),
`precheck-threshold-15` (same, revenue threshold 15), `precheck-none` (majorChange undefined), `csv-basic`.

## 8. Done when
`node test/run-golden.mjs` ends `PASS — N/N cases passed across 32 module(s)` and:
1. `compare-basic`: rows by name: `10` id/changed (revenue diff 120, pct 20); `15` ↔ `15X` short/unchanged; `20` removed;
   `R1` ↔ `R1-new` long/unchanged; `d:svc1` "Crosstown" added. counts `{added 1, removed 1, changed 1, unchanged 2}`.
   Row order: `10, 15, 20, Airport Rail, Crosstown`.
2. `compare-pairs`: `20` ↔ `d:svc1` pair/changed (trips diff 200, pct 66.67); counts `{added 0, removed 0, changed 2, unchanged 2}`.
3. `compare-pair-removed`: `15` removed (pair), `15X` added.
4. `precheck-default`: `10` adjustment revenueHoursPct 20 triggers []; `20` elimination −100 triggers
   `["revenueHoursPct","spanHoursPct","routeElimination"]`; Crosstown new_route triggers [] suggested false.
5. `precheck-threshold-15`: `10` triggers `["revenueHoursPct"]`.
6. `precheck-none`: every triggers [] and suggested false.
7. Total row diff: trips 200, revenue 240 (pct 17.78), peak 2.

## 9. Stop and report if
An expectation in §8 differs after two fixes (report actual vs expected), or any existing golden case changes.
