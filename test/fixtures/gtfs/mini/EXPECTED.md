# Mini GTFS fixture — expected answers

A tiny, made-up feed whose answers were worked out by hand. The schedule engine's golden tests
(`js/core/gtfs-schedule.js`) check against these numbers. If code disagrees with this file, suspect
the code first; change this file only when a convention below is deliberately changed, and say so
in the commit.

## What the feed contains, and why

| Case | Where |
|---|---|
| Bus route with two directions | `B1` (direction 0 S1→S3, direction 1 S3→S1) |
| Rail route | `R1` (route_type 0), Union Station platform `P1` ↔ Airport `R2` |
| Route defined only by `frequencies.txt` (plus one ordinary trip) | `F1`: `F1_W_FREQ` (`exact_times=0`), `F1_W_PM` (`exact_times=1`), `F1_S_NIGHT` (window 23:00–25:00, crosses midnight); `F1_W_X` is an ordinary trip |
| Stop served by two routes | `S1` (B1 and F1) |
| Parent station and child platform | `STN` (location_type 1), `P1` (location_type 0, parent `STN`) |
| Weekday / Saturday / Sunday services | `WKDY`, `SAT`, `SUN` in `calendar.txt`, 2026-01-05 to 2026-02-01 |
| Weekday holiday replaced by Sunday service | Mon 2026-01-19: `WKDY` removed, `SUN` added (`calendar_dates.txt`) |
| One-off added date | `SAT` also runs Fri 2026-01-30 |
| Service only in `calendar_dates.txt` | `EVT` on Sat 2026-01-24 (trip `R1_E_0`) |
| Trip past midnight | `B1_W_OWL` 24:50 → 25:10 |
| Blank intermediate time (`timepoint=0`) | `B1_W_2` at `S2` |
| Blank first time (invalid trip) | `B1_W_BAD` |
| `stop_sequence` gaps, rows out of order | sequences 10/20/30 and 1/5/9; rows of `B1_W_0` and `B1_W_2` are shuffled |
| `block_id`, including a block that switches routes | `BLK1` (three B1 trips); `BLK2` = `B1_W_3` then `F1_W_X` |
| `wheelchair_boarding` 0, 1, 2 and blank | `S3`=0, `S1`=1, `S2`=2, `P1`/`F2` blank |
| `shapes.txt` for two of three routes | B1 and R1; F1 has none. `shape_dist_traveled` is in an unstated unit (decision D5: never trusted) |
| File quirks | byte-order mark in `stops.txt`; CRLF line endings in `calendar.txt`; quoted commas in `stops.txt` and `routes.txt`; unknown column `platform_note` in `stops.txt` |

## Conventions these answers assume

1. **Service day.** A trip belongs to the date its service runs, even when it runs past midnight.
   `B1_W_OWL` on service day Fri 2026-01-23 leaves at 00:50 clock time on Sat 2026-01-24, but it is
   counted on Fri 2026-01-23 only.
2. **Invalid trips** (no time at the first or last stop) are left out of every count and reported
   separately. This feed has one: `B1_W_BAD`.
3. **Frequency windows** produce trips at `start + k × headway` for every start strictly before
   `end_time`. Each generated trip keeps the template's run time (15 min for F1). The same count is
   used for `exact_times=0` and `1`; for `exact_times=0` the times are nominal.
4. **Running time of a trip** is first departure to last arrival. **Running hours** for a route are
   the sum over its trips.
5. **Departures at a stop** count every stop-time row except a trip's last stop. A parent station
   counts its child platforms' departures.
6. **Blank intermediate times** are filled in by great-circle distance between neighbouring timed
   stops (decision D5), never by `shape_dist_traveled`.
7. **Peak vehicles, block method** (decision D7), used when any trip active that date has a
   `block_id`. A block spans its first departure to its last arrival. A trip with no `block_id`
   counts as its own block. Spans are half-open: a vehicle that ends at 08:00 and one that starts at
   08:00 do not overlap.
8. **Peak vehicles, trip-sweep method** (D7, the fallback, also reported for comparison): each trip
   spans its departure to its arrival **plus a 10-minute layover**, half-open, ignoring blocks. The
   10 minutes is the fixture's assumption; if A2 picks another default, these sweep numbers are
   recomputed and the change is noted.
9. **Busiest weekday** = the Monday–Friday date in the feed's range with the most trips; ties go
   to the earliest date.

## Expected answers

Times are service-day clock times (D4: 25:10 means 01:10 the next morning).

### Mon 2026-01-12 (ordinary weekday)

- **Active services:** `WKDY`
- **Trips:** B1 5, R1 2, F1 18 (9 + 8 generated + 1 ordinary); total 25. Invalid trips skipped: 1.
- **Running hours:** B1 1.6667 h (100 min); R1 1.2333 h (74 min); F1 4.5 h (270 min); total 7.4 h.
- **First / last departure:** system 06:00 / 24:50 (last arrival 25:10).
  - B1 07:00 / 24:50
  - R1 06:00 / 06:45
  - F1 06:00 / 17:45
- **Departures at `S1`:** 21 (B1: 07:00, 08:00, 24:50; F1: 18).
- **Departures at `STN`** (via `P1`): 1 (06:00).
- **Interpolated time** of `B1_W_2` at `S2`: 08:10:00 (S2 is halfway between S1 and S3).
- **Peak vehicles:**
  - Block method: **4**, first reached 07:20 (blocks `BLK1`, `BLK2`, `RBLK1` and the F1 trip of 07:20).
  - Trip-sweep method: **5**, first reached 07:20 (B1_W_0, B1_W_3, R1_W_1 and the F1 trips of 07:00 and 07:20).

### Mon 2026-01-19 (holiday: Sunday service)

- **Active services:** `SUN`
- **Trips:** B1 1; total 1.
- **Running hours:** B1 0.3333 h; total 0.3333 h.
- **First / last departure:** 10:00 / 10:00 (last arrival 10:20).
- **Departures at `S1`:** 1.
- **Peak vehicles:** no active trip has a `block_id`, so the result uses the trip-sweep method: **1**.

### Sat 2026-01-24 (Saturday plus the event-only service)

- **Active services:** `SAT`, `EVT`
- **Trips:** B1 1, R1 2, F1 4 (23:00, 23:30, 24:00, 24:30); total 7.
- **Running hours:** B1 0.3333 h; R1 1.2333 h; F1 1.0 h; total 2.5667 h.
- **First / last departure:** 08:00 / 24:30 (last arrival 24:45).
- **Departures at `S1`:** 5. **At `STN`:** 2 (08:00, 22:00).
- The Friday owl trip at 00:50 clock time is **not** counted here (convention 1).
- **Peak vehicles:** block method **1**; trip-sweep method **1**.

### Fri 2026-01-30 (weekday plus added Saturday service)

- **Active services:** `WKDY`, `SAT`
- **Trips:** B1 6, R1 3, F1 22; total 31.
- **Running hours:** B1 2.0 h; R1 1.85 h; F1 5.5 h; total 9.35 h.
- **First / last departure:** 06:00 / 24:50.
- **Departures at `S1`:** 26.
- **Peak vehicles:** block method **4** (07:20); trip-sweep method **5** (07:20).

### Whole feed

- **Busiest weekday:** Fri 2026-01-30 (31 trips). Every other weekday has 25, except Mon 2026-01-19 with 1.
- **Weekday dates in range:** 20 (2026-01-05 to 2026-01-30). With the holiday removed, `WKDY` runs on 19 of them.
- **Wheelchair boarding:** accessible (1): S1, STN, R2; not accessible (2): S2; unknown (0 or blank): S3, P1, F2.
  A blank `P1` would inherit from its parent `STN` under the GTFS rule, which makes it accessible. The engine should report that as inherited.

## Service hours and cost (A5)

Hand-worked for `routeServiceDay`, `serviceYear` and `calendarDayCounts` (`js/core/gtfs-schedule.js`).
Default settings unless stated: layover minutes mode, value 10 (so 300 s per unblocked trip), block gap
limit 60 min, deadhead 15 % of running time, revenue basis, rate 150 $/h, day counts 255 / 52 / 58.
Seconds are service-day seconds; hours are seconds / 3600.

### Mon 2026-01-12 (D1), trips and running times

Blocked trips (block_id set, not frequency-generated): B1 five trips, R1 two, F1_W_X one. The 17 generated
F1 trips and nothing else are unblocked.

| Trip | Start | End | Run | Block |
|---|---|---|---|---|
| B1_W_0 | 07:00 (25200) | 07:20 (26400) | 1200 | BLK1 |
| B1_W_1 | 07:30 (27000) | 07:50 (28200) | 1200 | BLK1 |
| B1_W_2 | 08:00 (28800) | 08:20 (30000) | 1200 | BLK1 (S2 blank, not needed) |
| B1_W_3 | 07:15 (26100) | 07:35 (27300) | 1200 | BLK2 |
| B1_W_OWL | 24:50 (89400) | 25:10 (90600) | 1200 | BLK5 |
| R1_W_0 | 06:00 (21600) | 06:37 (23820) | 2220 | RBLK1 |
| R1_W_1 | 06:45 (24300) | 07:22 (26520) | 2220 | RBLK1 |
| F1_W_X | 07:45 (27900) | 08:00 (28800) | 900 | BLK2 |
| F1 generated, 9 from F1_W_FREQ | 06:00 … 08:00 every 20 min | +900 each | 900 | none |
| F1 generated, 8 from F1_W_PM | 16:00 … 17:45 every 15 min | +900 each | 900 | none |

Running: B1 6000, R1 4440, F1 16200 (18 × 900), total 26640.

### Layovers

Block chains (gap = next start − previous end; 0 < gap ≤ 3600 counts, the last trip of a block gets 0):

- BLK1: W_0 → W_1 gap 27000 − 26400 = 600; W_1 → W_2 gap 28800 − 28200 = 600. Layovers 600, 600, 0.
- BLK2: B1_W_3 → F1_W_X gap 27900 − 27300 = 600. Layovers 600, 0.
- BLK5: one trip, 0.
- RBLK1: R1_W_0 → R1_W_1 gap 24300 − 23820 = 480. Layovers 480, 0.
- Unblocked, minutes mode: 17 × 300 = 5100.

Per route: B1 = 600 + 600 + 600 + 0 + 0 = 1800; R1 = 480; F1 = 5100 (F1_W_X's 0 is in BLK2).
Total = 7380.

Percent mode 10: blocked gaps unchanged; unblocked trip = round(900 × 10 / 100) = 90; F1 = 17 × 90 = 1530;
total = 1800 + 480 + 1530 = 3810.

Block gap limit 5 min (300 s): every gap above is 480 or 600, so all blocked layovers become 0. Unblocked stay
at 300 each. B1 = 0, R1 = 0, F1 = 5100; total = 5100.

### Route rows, D1 default (hours in brackets)

| Row | Trips | Running s | Layover s | Revenue s | Deadhead s | Platform s | First dep | Last arr | Span s |
|---|---|---|---|---|---|---|---|---|---|
| B1 | 5 | 6000 (1.6667 h) | 1800 | 7800 (2.1667 h) | 900 | 8700 (2.4167 h) | 07:00 (25200) | 25:10 (90600) | 65400 |
| R1 | 2 | 4440 (1.2333 h) | 480 | 4920 (1.3667 h) | 666 | 5586 (1.5517 h) | 06:00 (21600) | 07:22 (26520) | 4920 |
| F1 | 18 | 16200 (4.5 h) | 5100 | 21300 (5.9167 h) | 2430 | 23730 (6.5917 h) | 06:00 (21600) | 18:00 (64800) | 43200 |
| Total | 25 | 26640 (7.4 h) | 7380 | 34020 (9.45 h) | 3996 | 38016 (10.56 h) | 06:00 (21600) | 25:10 (90600) | 69000 |

Deadhead: round(running × 0.15). Revenue = running + layover. Platform = revenue + deadhead.
Total invalid trips: 1 (B1_W_BAD). Total method: 8 blocked of 25, so `mixed`. Row methods: B1 `block`,
R1 `block`, F1 `mixed` (1 blocked of 18).

Other D1 settings, same shape:
- Percent 10: B1 5 trips, layover 1800, revenue 7800, platform 8700 (unchanged). R1 unchanged. F1 layover 1530,
  revenue 17730, platform 20160. Total layover 3810, revenue 30450, platform 34446.
- `routeIds: ["B1"]`: only the B1 row; total equals it (layover 1800, revenue 7800, platform 8700, invalid 1,
  method `block`).
- Gap limit 5: B1 layover 0, revenue 6000, platform 6900. R1 revenue 4440, platform 5106. F1 revenue 21300,
  platform 23730. Total layover 5100, revenue 31740, platform 35736.

### Peak vehicles, D1 default

Per route. Blocked trips form one interval per route + block: [min start, max end].
- B1: BLK1 [25200, 30000]; BLK2 [26100, 27300]; BLK5 [89400, 90600]. Overlap at 26100 (07:15) is 2. Peak **2 at 07:15**, method `block`.
- R1: RBLK1 [21600, 26520]. Peak **1 at 06:00**, method `block`.
- F1: F1_W_X [27900, 28800]. Generated trips are intervals [start, start + 900 + 300]. Only FREQ 27600 [27600, 28800]
  overlaps it, so peak **2 at 07:45** (27900), method `mixed`.

Whole system. Blocked trips grouped by block_id alone, so BLK2 spans [26100, 28800] (B1_W_3 with F1_W_X):
- BLK1 [25200, 30000]; BLK2 [26100, 28800]; BLK5 [89400, 90600]; RBLK1 [21600, 26520].
- Generated F1 intervals, minutes mode: [21600, 22800], [22800, 24000], [24000, 25200], [25200, 26400],
  [26400, 27600], [27600, 28800], [28800, 30000], [30000, 31200], [31200, 32400]; and [57600, 58800] …
  [63900, 65100] for the PM window (never more than 2 overlapping).
- Sweep at 25200: RBLK1, f3 ends, f4 starts, BLK1 starts → 3.
- At 26100: RBLK1, f4, BLK1, BLK2 → **4**. At 26400, f5 starts as f4 ends → still 4. At 26520 RBLK1 ends → 3.

System peak **4 at 07:15 (26100)**, method `mixed`. Not the sum of route peaks (2 + 1 + 2 = 5).

Percent mode 10 (unblocked intervals [start, start + 990]): system peak still 4 at 26100; F1 still 2 at 27900.
Gap limit 5: peaks unchanged, because blocked intervals do not depend on layover. Still 2, 1, 2 and 4.

### Sat 2026-01-24 (D3)

Active: SAT and EVT. Trips: B1_S_0 (09:00 to 09:20, BLK3, blocked), R1_S_0 (08:00 to 08:37, unblocked),
R1_E_0 (22:00 to 22:37, EVT, unblocked), F1_S_NIGHT four runs at 23:00, 23:30, 24:00, 24:30 (900 s each, unblocked).
Trips 7, running 1200 + 2220 + 2220 + 3600 = 9240 (2.5667 h), layover 6 × 300 = 1800, revenue 11040,
deadhead 1386, platform 12426. Invalid 0.

| Row | Trips | Running s | Layover s | Revenue s | Platform s | Span s | Peak | Peak at | Peak method | Method |
|---|---|---|---|---|---|---|---|---|---|---|
| B1 | 1 | 1200 | 0 | 1200 | 1380 | 1200 | 1 | 09:00 | block | block |
| R1 | 2 | 4440 | 600 | 5040 | 5706 | 52620 | 1 | 08:00 | sweep | setting |
| F1 | 4 | 3600 | 1200 | 4800 | 5340 | 6300 | 1 | 23:00 | sweep | setting |
| Total | 7 | 9240 | 1800 | 11040 | 12426 | 60300 | 1 | 08:00 | mixed | mixed |

Total peak: R1_S_0 [28800, 31320] and R1_E_0 [79200, 81720] and the F1 intervals do not overlap, so the
peak is 1, first reached at 08:00.

### Sun 2026-01-19 (D2, holiday with Sunday service)

Active: SUN only (WKDY removed). Trip: B1_U_0 (10:00 to 10:20, unblocked). Running 1200, layover 300,
revenue 1500, deadhead 180, platform 1680, span 1200. Peak 1 at 10:00, method `sweep`. Row method `setting`.

### serviceYear, dates {weekday: D1, saturday: D3, sunday: D2}, defaults

Route cost = rate × revenue hours (150 × hours).

Per-day hours and cost:
- B1: D1 revenue 2.1667 h, cost 325. D3 0.3333 h, cost 50. D2 0.4167 h, cost 62.5.
- F1: D1 revenue 5.9167 h, cost 887.5. D3 1.3333 h, cost 200. Sunday null.
- R1: D1 revenue 1.3667 h, cost 205. D3 1.4 h, cost 210. Sunday null.
- Total: D1 cost 1417.5 (9.45 h). D3 cost 460 (3.0667 h). D2 cost 62.5 (0.4167 h).

Weekly = 5 × weekday + saturday + sunday; annual = dayCount × per-day.

| Row | Weekly trips | Weekly cost | Annual trips | Annual revenue h | Annual cost | Peak |
|---|---|---|---|---|---|---|
| B1 | 27 | 1737.5 | 1385 | 594.0 | 89100 | 2 |
| F1 | 94 | 4637.5 | 4798 | 1578.0833 | 236712.5 | 2 |
| R1 | 12 | 1235 | 614 | 421.3 | 63195 | 1 |
| Total | 133 | 7610 | 6797 | 2593.3833 | 389007.5 | 4 |

Total peak 4 = max(D1 4, D3 1, D2 1). Total running weekly 39.9 h, annual 2039.8 h.

Platform-rate variant (`rateBasis: "platform"`, `rateOverrides: {R1: 300, B1: "x"}`): B1 rate 150 (text is not an
override), R1 rate 300 (override), F1 rate 150.
- B1 platform per day: D1 2.4167 h (362.5), D3 0.3833 h (57.5), D2 0.4667 h (70). Weekly cost 1940, annual 99487.5.
- F1 platform per day: D1 6.5917 h (988.75), D3 1.4833 h (222.5). Weekly 5166.25, annual 263701.25.
- R1 platform per day: D1 1.5517 h (465.5), D3 1.585 h (475.5). Weekly 2803, annual 143428.5.
- Total per day is the sum of route costs: D1 1816.75, D3 755.5, D2 70. Weekly 9909.25, annual 506617.25.

Day-count variant (`dayCounts: {weekday: 250}`): saturday 52 and sunday 58 stay at default. Total annual cost =
250 × 1417.5 + 52 × 460 + 58 × 62.5 = 381920. B1 annual cost = 250 × 325 + 52 × 50 + 58 × 62.5 = 87475.

All dates null: every day null, no routes, total zeros, peak 0.

### calendarDayCounts

Range 2026-01-05 to 2026-02-01 inclusive: **28 dates**. Weekday dates: 20 (Jan 19 is a weekday by `dayType`,
even though it runs Sunday service). Saturdays: 4 (Jan 10, 17, 24, 31). Sundays: 4 (Jan 11, 18, 25, Feb 1).

- Default: byType weekday 20, saturday 4, sunday 4. perYear round(20 × 365 / 28) = 261, round(4 × 365 / 28) = 52, 52.
  Routes: B1 {20, 4, 4}; F1 {19, 4, 0} (WKDY is removed on Jan 19); R1 {19, 4, 0}.
- `routeIds: ["R1"]`: byType 19, 4, 0. perYear round(19 × 365 / 28) = 248, 52, 0. Routes: R1 {19, 4, 0}.
- Inline feed with trips and stop times but no calendar: range null, days 0, all counts 0, route B1 {0, 0, 0}.

## Stop analysis (A5)

Feet = metres x 3.28084, unrounded. Haversine metres (R = 6371008.8): the 0.01 degree longitude step at
latitude 39.74 is 855.0 m (2805.2 ft), the 0.01 degree latitude step is 1112.0 m (3648.1 ft), and P1 to R2
(0.0999 degrees of latitude, 0.3301 degrees of longitude) is about 30.3 km (99,440 ft).

### stopSpacingStats, Mon 2026-01-12 (D1), defaults [600, 750, 1320, 2640]

Dominant patterns: B1 direction 0 S1,S2,S3 (3 trips) and direction 1 S3,S2,S1 (2); F1 direction 0 S1,F2 (18);
R1 direction 0 P1,R2 and direction 1 R2,P1 (1 each). Segments: B1 4 (2805.2 ft each), F1 1 (3648.1 ft),
R1 2 (99,440 ft each) = **7 segments**, skipped 0. All are at least 2640 ft, so every one is **Very wide**:
counts 0, 0, 0, 0, 7; shares 0, 0, 0, 0, 1. Sorted: 2805.2 x4, 3648.1, 99440 x2. Median (rank 3) 2805.2;
mean (4 x 2805.2 + 3648.1 + 2 x 99440) / 7 = 30,535.5; p10 (h = 0.6) 2805.2; p90 (h = 5.4) 99,440.
Routes: B1 4 segments median 2805.2, F1 1 / 3648.1, R1 2 / 99,440.
- `routeIds: ["B1"]`: 4 segments, all 2805.2 ft, one route.
- `stopIds: ["S2"]`: the four B1 segments touch S2; F1 and R1 do not. 4 segments.
- thresholds [100, 200, 3000, 50000]: B1 (2805.2) in Target [200, 3000), F1 (3648.1) in Wide [3000, 50000),
  R1 in Very wide. Counts 0, 0, 4, 1, 2. Bands read minFt 0, 100, 200, 3000, 50000.
- thresholds [600, 500, 1, 2] are not rising, so `thresholdsFt` reports the defaults and the result equals D1.
- Sat 2026-01-24 (D3): B1_S_0 S1,S2,S3 gives 2 segments; R1 has direction 0 only (P1,R2 99,440 ft) and F1
  S1,F2 (3648.1 ft); 4 segments in all.
- Unknown date: 0 segments, bands all zero with share 0, median, mean, p10 and p90 null, routes and list empty.

### consolidationCandidates, D1

Trips per day at a stop = departures that are not a trip's last row: S1 21 (B1 3 + F1 18), S2 5, S3 2, F2 0,
P1 1, R2 1.
- Default 600 ft: no segment is that close. 0 candidates.
- `maxFt: 99999`: the pairs are S1-S2, S2-S3 (and the reverse direction), S1-F2, P1-R2. P1-R2 has a station
  stop. S1-F2: F2 has fewer trips and is the pattern's last stop, which is not removable. S2-S3 and S3-S2:
  S3 has fewer trips than S2 but is a pattern end. S1-S2 (direction 0) and S2-S1 (direction 1): S2 has
  fewer trips than S1 and is mid-pattern. One candidate: remove S2, keep S1, 2805.2 ft, routes [B1],
  5 trips a day, saved 20 x 5 = 100 s, extra walk 2805.2 ft. Count 1, savedSecPerDay 100.
- `routeIds: ["B1"]`: S1 then has 3 trips against S2's 5, so S1 is the one that would go and it is a pattern
  end; S3 (2) is an end too. 0 candidates.
- `stopIds: ["S2"], secondsPerStop: 30`: the same candidate, saved 150 s. `stopIds: ["S1"]`: 0.
- D3 with `maxFt: 99999`: trips per day S1 5 (B1_S_0 and the 4 F1 night runs), S2 1, S3 0. S1-S2: S2 has
  fewer trips and is mid-pattern, so remove S2, keep S1, 1 trip, saved 20 s. S2-S3: S3 goes and is the
  pattern's last stop. Count 1, savedSecPerDay 20.
- Unknown date: 0 candidates.

### stopServiceTable, D1

Rows (stop id, trips, routes, first, last, peak headway, off-peak headway):
- P1: 1, 1, 21600, 21600, null, null.
- R2: 1, 1, 24300, 24300, null, null.
- S1: 21, 2, 21600, 89400, 900, null. Peak pools the AM gaps (11 gaps: 7 x 1200, 2 x 0, 300, 900) and the
  PM gaps (7 x 900): 18 gaps, median of the 9th and 10th sorted values (900, 900) = 900. No midday departures.
- S2: 5, 1, 25800, 90000, 900, null. AM departures 25800, 26700, 27600, 29400 (the interpolated one); gaps
  900, 900, 1800; median 900.
- S3: 2, 1, 26100, 27000, 900, null.
STN has no stop-time rows of its own (P1 carries them), so it has no row. F2 only has arrivals, so no row.
`routeIds: ["B1"]`: S1 3 trips (25200, 28800, 89400; AM gap 3600, peak 3600), S2 5, S3 2. P1 and R2 drop out.
`stopIds: ["S2"]`: the S2 row alone. Unknown date: empty list.
D3 (Sat 0124): P1 2 trips (28800, 79200), S1 5 trips (2 routes, first 32400, last 88200), S2 1 trip (33000);
S3 and R2 have only arrivals. No stop has two departures in a peak or midday part (S1's 09:00 is alone in
midday and its night runs are neither), so both headways are null.
Invariant case: the childless non-station stops are S1, S2, S3, R2 and F2 (STN is a station and P1 sits in
one), so `checked` is 5 and `mismatches` is empty.

### wheelchairByRoute, D1

Stop values: S1 1, S2 2, S3 0, P1 inherits 1 from STN, R2 1, F2 0. Trips: trips.txt has no
wheelchair_accessible column, so every trip is unknown.
- B1: 3 stops (accessible 1, not accessible 1, unknown 1), 5 trips unknown.
- F1: S1 and F2, 1 accessible and 1 unknown, 18 trips unknown.
- R1: P1 and R2, 2 accessible, 2 trips unknown.
- Total: 6 distinct stops (S1, S2, S3, P1, R2, F2): 3 accessible, 1 not, 2 unknown; 25 trips unknown.
Inline feed (route A trips T1 1, T2 2, T3 1 as two frequency runs, T4 blank; B T5 2; stops X 1, Y 2, Z blank,
W inherits 2 from station P): A has stops X, Y, Z (1, 1, 1) and 5 trips (3 accessible, 1 not, 1 unknown);
B has W (not accessible by inheritance) and Z (unknown) and 1 trip not accessible; the total counts X, Y, Z, W
once each (1 accessible, 2 not, 1 unknown) and 6 trips (3, 2, 1).

## Analysis network (A6)

Hand-worked for `AnalysisNetwork` (`js/core/analysis-network.js`). Times are seconds after the date's midnight.

### D1 (Mon 2026-01-12), GTFS only, all routes

- `dayType` weekday. **25 trips** (B1 5, R1 2, F1 18), 0 proposal trips, **0 dropped rows** (B1_W_2's blank
  S2 is interpolated to 29400 first; B1_W_BAD is not on the date at all).
- **6 stops**, sorted by id: `g:F2`, `g:P1`, `g:R2`, `g:S1`, `g:S2`, `g:S3` (indices 0 to 5). STN has no
  stop-time rows, so it is not in the network.
- Routes `g:B1` (name B1, bus, `#0055AA`), `g:F1` (F1, bus, `#228822`), `g:R1` (R1, rail, `#AA3300`).
- First trip: the F1 run `g:F1_W_FREQ@06:00:00` (S1 21600, F2 22500) comes before `g:R1_W_0` (P1 21600,
  R2 23820): equal first departures, so the lower trip id first. Last trip `g:B1_W_OWL` (89400, 90000, 90600).
- `routeIds: ["B1"]`: 5 trips, stops `g:S1`, `g:S2`, `g:S3` only, one route.
- Unknown date 20260301 (a Sunday after the feed's range): dayType sunday, no trips, no stops, counts all 0.
- Feed null, date given: same as no GTFS trips.

### Proposal "P" (not in the feed)

Three stops A, B, C at 0, 1 and 2 mi; line length 2 mi; weekday band 07:00 to 09:00 every 30 min; runtime
20 min. Trips start 420, 450, 480, 510 min (4 trips; 09:00 is not before the end). A trip starting at `s`
min has times `s*60`, `s*60 + 600`, `s*60 + 1200` at A, B, C (B is halfway):

| Start | A | B | C |
|---|---|---|---|
| 07:00 | 25200 | 25800 | 26400 |
| 07:30 | 27000 | 27600 | 28200 |
| 08:00 | 28800 | 29400 | 30000 |
| 08:30 | 30600 | 31200 | 31800 |

Trip ids `d:P|pat1|0|420`, `...|450`, `...|480`, `...|510`.
- Mixed with D1: 29 trips (25 + 4), 9 stops (`d:A`, `d:B`, `d:C` sort before the `g:` stops, so `d:A` is
  index 0 and `g:F2` index 3), routes `d:P`, `g:B1`, `g:F1`, `g:R1`.
- Proposals only (feed null): 4 trips, stops `d:A`, `d:B`, `d:C`, dayType weekday.
- `both: true`: the reverse trips run C, B, A with distances 0, 1, 2 mi from C, so the 07:00 return trip is
  C 25200, B 25800, A 26400, direction "1", id `...|1|420`; 8 trips in all.
- Sunday with no Sunday bands: no trips.

### stopService, D1

Same figures as `stopServiceTable` for D1 (see "Stop analysis"), with `g:` ids: `g:P1` 1 trip, 1 route,
21600 / 21600, no headways; `g:R2` 1, 1, 24300 / 24300; `g:S1` 21, 2, 21600 / 89400, peak 900;
`g:S2` 5, 1, 25800 / 90000, peak 900; `g:S3` 2, 1, 26100 / 27000, peak 900. `g:F2` has only arrivals, so no row. Off-peak headway is null everywhere.
The invariant check compares the rows of non-station stops (P1 sits in a station): S1, S2, S3 and R2, so
`checked` is 4 and `mismatches` is empty.

### Generator and helpers

- `bandTrips`: 07:00 to 08:00 every 20 min gives starts 420, 440, 460 (end = start + runtime). 22:00 to 02:00
  every 120 min wraps (to = 1560): starts 1320, 1440. Headway 0: nothing. Headway 0.5 clamps to 1: 60 trips
  for a one-hour band.
- `stopTimesAlong(420, 20, [0, 1, 2], 2)` = [25200, 25800, 26400]. Length 0: by index, 3 stops, fractions
  0, 0.5, 1: same three values. One stop: [25200].
- `modeOf`: 3 bus, "1" rail, 12 rail, "" bus.
