# Federal Blvd BRT — corridor service hours (No-Build vs Build)

One-off analysis, **not part of the app**. Nothing in `index.html` or `js/` loads these files. They are plain Python scripts and CSV results, kept here so the figures can be revisited and re-run.

Run date: 2026-10-12. Feeds: `NoBuild_GTFS.zip` and `Build_GTFS.zip` (RTD model feeds, calendar 2023-01-08 to 2023-05-27). **The feed ZIPs are not in the repo** (size and data ownership). Keep them somewhere you can find them, since they are needed to re-run.

## Results (typical weekday)

| | No-Build hrs | Build hrs | Change |
|---|---|---|---|
| BRT (`FED 4C`) | — | 242.3 | +242.3 |
| Route 31 | 160.2 | — (removed) | −160.2 |
| Route 30 | 10.1 | — (removed) | −10.1 |
| Routes 35, 29, 36, 120E/W, 14 (unchanged) | 24.8 | 24.8 | 0 |
| **Total** | **195.1** | **267.0** | **+72.0 (+37%)** |

Corridor miles go from 2,679 to 4,347. The full route-by-route table for every day type is in `output/route_comparison.csv`.

## What "corridor hours" means

For each trip, the scripts find stretches of 2 or more consecutive stops that are on the stop list. A stretch may skip up to 2 off-list stops. Corridor time is the scheduled time from the first such stop to the last; miles are straight-line stop to stop. This is **in-corridor running time only**: no layover, recovery or deadhead. Apply those factors separately (for example in Route Costing).

## Files

| File | What it is |
|---|---|
| `stop-lists/nobuild_stops_selected.csv` | Stop list exported from the app (GTFS stops → Export selected stops) with No-Build loaded. 190 stop IDs, 4 of them BRT-only (`in_feed` = 0). |
| `stop-lists/build_stops_selected.csv` | The same 190 IDs exported with Build loaded. |
| `stop-lists/build_stops_plus_brt.csv` | The Build list plus the 85 BRT stop IDs it was missing (see Caveat 1). **This is the list the Build results use.** |
| `corridor_hours.py` | Feed + stop list → per-trip table and per-route summary. Honors each feed's `editlist.txt` (Build removes routes 30 and 31). |
| `compare.py` | The two summaries → `route_comparison.csv`. |
| `output/route_comparison.csv` | **Main result.** One row per day type × route: trips, hours, miles for each scenario, plus the change. TOTAL row per day type. |
| `output/nobuild_trips.csv`, `output/build_trips.csv` | One row per trip: route, service day, direction, block, entry/exit stop and time, corridor stops, minutes, miles. |
| `service-hours-reconciliation-memo.md` | **Memo** reconciling this analysis with the Dec 2024 BRT Service Plan memo and spreadsheet (why its +76% is about +39% like for like). |
| `reconcile_memo.py` | Reproduces the memo's numbers (needs the No-Build feed, the Plan spreadsheet and `openpyxl`). |
| `output/nobuild_summary.csv`, `output/build_summary.csv` | Per route × service_id totals. |

Service IDs: `WK` = weekday, `SA` = Saturday, `SU` = Sunday, `DPSWK` = school-day add-on trips.

## Caveats

1. **BRT stop IDs.** The BRT uses its own stop IDs, stacked on the local stops (local 13714, BRT 113714). The exported list caught only 4 of the BRT's 88 stops, so as exported the BRT counted zero hours. `build_stops_plus_brt.csv` adds every stop the BRT serves; all are on Federal within the list's extent. To fix it at the source instead: load Build in the app, Select stops by box, Shift+drag the corridor, re-export.
2. **Evans/Clay loop.** Stops 21208, 21209 and 13565 (used by routes 29, 30, 31, 36) are not on the list. The 2-stop skip rule counts the loop time; without it, No-Build drops about 14 weekday hours and the change becomes about +79.
3. **No weekend BRT in the Build feed.** All 276 BRT trips are weekday only, so the Saturday (−85%) and Sunday (−84%) results reflect the model feed, not a real plan. Compare weekdays only.
4. **16 BRT placeholder trips** with 00:00 times are skipped (no real schedule).
5. **No BRT `block_id`**, so vehicle counts can't come from the Build feed.

## Re-running

Requires Python 3 only (no packages). Unzip each feed into a folder, then from this directory:

```
python3 corridor_hours.py <nobuild_feed_dir> stop-lists/nobuild_stops_selected.csv nobuild output 2 2
python3 corridor_hours.py <build_feed_dir>   stop-lists/build_stops_plus_brt.csv  build   output 2 2
python3 compare.py output
```

The last two arguments are the minimum stops per stretch (2) and how many off-list stops a stretch may skip (2). Use `2 0` for no skipping.
