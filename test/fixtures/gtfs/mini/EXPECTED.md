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
