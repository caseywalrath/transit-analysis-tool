# Card A6c.1 (Haiku, xhigh): pure schedule router `window.Raptor` + golden cases

## Files (only these)
- NEW `js/core/raptor.js` — `window.Raptor`, pure ES5 IIFE (no App, turf, DOM, map). Copy the header style of
  `js/core/apportion.js`.
- `index.html` — one `<script src="js/core/raptor.js"></script>` directly after the `analysis-network.js` tag.
- NEW `test/cases/raptor.mjs` (`export default { scripts: ["js/core/raptor.js"], cases }`), seeded
  `test/golden/raptor.json`.

## Read first
`CLAUDE.md`, `docs/a6-cards/rules.md`, `docs/reference/modules/gtfs.md` ("Analysis network": the network shape),
`test/cases/apportion.mjs`, `test/README.md`.

## Network shape (input, produced elsewhere)
`network = { stops: [{id, lat, lon}], trips: [{ id, stops: [stopIdx…], arr: [sec…], dep: [sec…] }] }`.
Times are seconds after midnight; `arr[i]`/`dep[i]` may be equal; `-1` never appears (already cleaned).

## API (exactly this)

### `Raptor.prepare(network)`
Returns an opaque prepared object: trips sorted by `dep[0]` ascending (ties by trip id), and for each stop the
list of `{trip, pos}` where that trip stops (pos = index in the trip). Must not mutate `network`.

### `Raptor.route(prep, access, transfers, departSec, opts)`
- `access`: `[{ stop: stopIdx, sec }]` walk time from the origin to the stop.
- `transfers`: array indexed by stopIdx of `[{ to: stopIdx, sec }]` (may be missing/undefined for a stop).
- `opts.maxRounds` default 3 (= up to 2 transfers), `opts.maxSec` default 7200 (ignore arrivals later than
  `departSec + maxSec`), `opts.minTransferSec` default 0 (added when boarding in rounds ≥ 2).
- Algorithm (trip-scanning RAPTOR):
  1. `best[s] = Infinity` for all stops; round 0 labels `L0[s] = departSec + access.sec` (min over duplicates);
     `best = L0`. Then apply transfers once from every stop marked in round 0: `best[to] = min(best[to],
     L0[s] + sec)` and mark `to` (transfers do not chain).
  2. For round k = 1..maxRounds: for each trip (in prepared order) whose `dep[0] ≤ departSec + maxSec`, walk its
     stops in order; the trip is "boarded" from the first position p where the stop was marked in round k−1 and
     `labelPrev[stop] + (k ≥ 2 ? minTransferSec : 0) ≤ dep[p]`; for every later position q > p,
     `t = arr[q]`; if `t < best[stop_q]` and `t ≤ departSec + maxSec`: set `best`, `Lk[stop_q] = t`, mark it.
     (`labelPrev` = the labels of round k−1 after its transfers.)
  3. After the trip scan of round k, apply transfers from the stops marked in round k (as in step 1) into `Lk` /
     `best`, marking the targets.
  4. Stop early when no stop was marked in a round.
- Returns `{ arrival: Float64Array|Array (best, Infinity when unreached), rounds: Array (the round at which each
  stop got its best arrival, −1 unreached, 0 = walk only) }`. Return plain Arrays (golden JSON must hold them;
  write Infinity as `null` in a test helper, not in the engine).

### `Raptor.profile(prep, access, transfers, fromSec, toSec, stepSec, opts)`
- Departures `fromSec, fromSec+stepSec, …` while `< toSec` (at least one: `fromSec`). Default stepSec 120.
- For each departure d, run `route`; travel time per stop = `arrival − d` (unreached = Infinity).
- Per stop: `best` = minimum, `typical` = median (lower median for even counts: sorted[(n−1)>>1]),
  `worst` = 90th percentile = sorted[Math.ceil(0.9·n) − 1]; Infinity counts as a value (so a stop reached in
  only some departures can have typical/worst Infinity).
- Returns `{ departures: n, best: [], typical: [], worst: [] }` in seconds (Infinity unreached).
- `opts.onDeparture(i, n)` optional callback (sync) after each departure.

### `Raptor.evaluate(network, fnName, args)` — test helper
`fnName "route"` → `route(prepare(network), …args)`, `"profile"` likewise; converts every Infinity in the result
to `null` so golden JSON stays plain.

## Golden cases (hand-worked `// EXPECTED:` comment each)
Build a small network in the case file: 6 stops A–F; trip T1 A→B→C (dep 08:00 at A, 08:05 B, 08:10 C); T2 C→D
(08:12, 08:20); T3 B→E (08:20, 08:30); T4 A→B→C later (08:30…); a transfer C→F 120 s; E has no service.
Cases at least:
1. direct ride (access A 60 s, depart 07:58) → C at 08:10, round 1.
2. one transfer at C onto T2 → D 08:20, round 2.
3. missed connection with `minTransferSec` 180 (arrive C 08:10, T2 leaves 08:12) → D unreached in rounds ≤ 3
   unless a later trip exists (state it).
4. walking transfer C→F after the ride → F 08:12.
5. maxRounds 1 → D unreached.
6. maxSec 600 cuts arrivals after depart+10 min.
7. access to two stops, the later-walking one is faster.
8. profile 07:50–08:40 every 10 min: best / typical / worst for C and D, hand-worked.
9. empty network, empty access.
Also, in a scratch script (not committed), compare `route` against a brute-force (repeat relaxation over all trips
until stable, counting transfers) on a random 50-stop / 300-trip network for 200 random queries; report the result.

## Done when
- `node test/run-golden.mjs` → PASS after seeding; seeded values match your EXPECTED comments (fix the CODE if not).
- Brute-force comparison: all equal. Speed: report ms for `route` on a synthetic 8,000-stop / 25,000-trip /
  40-stops-per-trip network, maxSec 5400.
