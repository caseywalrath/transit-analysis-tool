# Memo: Reconciling Federal Blvd BRT service-hour figures

**Subject:** Where the "+76% vs 2023 baseline" figure in the Federal Blvd BRT Station Analysis and Service Plan (12-2024) comes from, and what a like-for-like comparison shows
**Date:** 2026-10-12
**Sources:**
- *Federal BRT Station Analysis and Service Plan* memo, December 2024 (the "Plan memo")
- *Federal_Blvd_Service_Plan_11-20-2024.xlsx* (the "Plan spreadsheet": sheets WK/SA/SU Times, WK Hours)
- No-Build and Build GTFS feeds (RTD January 2023 runboard, `feed_version` `Jan23-31190-5-7-20230111-030143`, valid 2023-01-08 to 2023-05-27)
- This folder's corridor-hours analysis (`README.md`, `output/route_comparison.csv`)

## Summary

The Plan memo reports BRT service at 112,470 annual hours against a 2023 baseline of 63,800 hours, an increase of **76%**. The two figures are not measured the same way:

- The **2023 baseline counts trip time only**: first stop to last stop, no layover.
- The **BRT figure counts revenue hours including layover and recovery** at the terminals.

Measured on the same basis, the BRT plan is about **+39% to +45%** over 2023 service. That matches this folder's independent corridor analysis (+45% on a typical weekday once the plan's late-night trips are included). Because every cost in the memo is hours × one hourly rate, the "BRT vs existing" cost gap is overstated for the same reason, by roughly **$3.6–4.2 million a year** in 2029 dollars.

The comparison against the System Optimization Plan (SOP) is set aside here. The GTFS feeds are January 2023 service, and the SOP's 98,600 hours can't be checked against anything available.

## 1. The 2023 baseline (63,800 hours) is trip time only

The Plan memo describes 63,800 as "current (2023) annual service hours" for Routes 29, 30 and 31, with Route 30 running to Wadsworth & Hampden. Rebuilding it from the January 2023 No-Build feed:

- Trip time = first departure to last arrival on each trip, for the **whole route** (not only the Federal portion).
- Annualized with the memo's service days: 255 weekdays, 52 Saturdays, 58 Sundays/holidays.

| Route | Weekday trip hrs/day | Saturday | Sunday | Annual trip hours |
|---|---|---|---|---|
| 29 | 12.9 | 10.7 | 10.1 | ~4,430 |
| 30 | 21.8 (+0.7 school days) | 11.3 | 8.0 | |
| 31 | 164.0 | 118.2 | 79.6 | |
| **29 + 30 + 31** | | | | **63,617** |

63,617 is within 0.3% of the memo's 63,800. Route 29's ~4,430 also matches the memo's separate Route 29 line (4,420 in the memo, 4,427 in the spreadsheet), so it is counted the same way: trip time, no layover.

## 2. The BRT figure (108,050 hours) includes layover

The BRT hours come from the spreadsheet's **WK Hours** sheet. Each bus is counted from its first departure to its last arrival, so all layover and recovery time is included. The Plan memo defines these as revenue hours "including layover and recovery time at the terminals."

| Day | BRT revenue hrs/day (with layover) | BRT trip hrs/day (no layover) |
|---|---|---|
| Weekday | 311.6 | 256.3 |
| Saturday | 277.0 | 218.6 |
| Sunday/Holiday | 245.9 | 188.5 |
| **Annual** | **108,123** (memo: 108,050) | **87,651** |

The memo's 108,050 is the sum of rounded table values; the spreadsheet's unrounded total is 108,123. The trip-only column was computed from the spreadsheet's WK/SA/SU Times sheets: first to last timepoint for every trip, both directions, including the trips that run past midnight. Layover makes up about a fifth of the BRT revenue hours (19%).

## 3. Like-for-like comparison

| Basis | 2023 existing | BRT plan + Route 29 | Change |
|---|---|---|---|
| Memo (mixed bases) | 63,800 (trip time) | 112,470 (with layover) | **+76%** |
| Both trip time only | 63,617 | 87,651 + 4,430 = 92,080 | **+45%** |
| Both with layover | 80,980 | 112,550 | **+39%** |

Notes on the "both with layover" row:
- The existing Routes 30/31 figure (76,551) uses each bus's day from first departure to last arrival, grouped by the feed's bus assignments (`block_id`). This is the same method the spreadsheet uses for BRT.
- Route 29 (4,430) is counted as trip time only, because its buses also run other routes and their day can't be split out. The total is 76,551 + 4,430 = 80,980.

Both like-for-like methods land at about +39% to +45%.

### Cross-check against the corridor-only analysis

This folder's corridor analysis measures something narrower: scheduled time **on the Federal corridor only**, typical weekday, from the same two GTFS feeds and the same stop list.

| Weekday, Federal corridor only | No-Build | Build | Change |
|---|---|---|---|
| Corridor trip hours | 195.1 | 267.0 | +72.0 hrs (**+37%**) |

The Build feed has no running times for the plan's 16 late-night BRT trips (16.4 trip hours on a weekday; see Section 5). Adding them back puts the change at roughly +88 hours (+45%), consistent with the trip-time route-level result above.

## 4. Operating cost

Every cost in the Plan memo is annual hours × one hourly rate.

| Year | Rate per hour | Derivation |
|---|---|---|
| 2022 | $164.29 | RTD bus cost per hour reported to the National Transit Database (NTD); labeled "2022 Cost" in WK Hours |
| 2023 | $172.57 | +4.8% |
| 2024 | $180.85 | +4.8% |
| 2029 | **$209.66** | +3% a year from 2025 |

| Figure in the memo | Hours × 2029 rate | Result |
|---|---|---|
| BRT + Route 29 | 112,470 × $209.66 | $23,583,780 |
| SOP | 98,600 × $209.66 | $20,672,340 |
| BRT vs SOP | 13,870 × $209.66 | $2,911,440 |
| Existing (spreadsheet only) | 63,800 × $209.66 | $13,376,219 |

Using the spreadsheet's unrounded 112,550 hours, the BRT figure is $23,597,145.

**Effect of the mixed bases on cost.** The memo implies an increase of 112,470 − 63,800 = 48,670 hours over existing service. Measured on one basis, the increase is smaller:

| Basis | Increase over existing | Overstated by | At $209.66/hr |
|---|---|---|---|
| Memo (mixed) | 48,670 hrs | — | — |
| Both trip time only | 92,080 − 63,617 = 28,463 hrs | 20,207 hrs | **$4.2M/yr** |
| Both with layover | 112,550 − 80,980 = 31,570 hrs | 17,100 hrs | **$3.6M/yr** |

So the BRT-vs-existing operating cost increase is overstated by roughly **$3.6–4.2 million a year** in 2029 dollars.

The BRT-vs-SOP gap ($2.9M) is like for like only if the SOP's 98,600 hours also include layover; the memo doesn't say.

## 5. Other reconciliation notes

- **Plan schedule vs Build GTFS.** Running hours (no layover), with and without the late-night trips. "Late-night" means trips departing after 21:55, the Build feed's last timed BRT departure.

  | Day | Source | All trips | All hrs | Excl. late-night: trips | Excl. late-night: hrs | Late-night trips (full-corridor) | Late-night hrs | Last departure |
  |---|---|---|---|---|---|---|---|---|
  | Weekday | Plan spreadsheet | 276 | 256.3 | 260 | 239.9 | 16 (14) | 16.4 | 01:27 |
  | Weekday | Build GTFS | 276 (16 untimed) | — | 260 | 242.3 | 16 (all 00:00) | — | 21:55 |
  | Weekday | Build GTFS + plan late-night times (est.) | 276 | ~258.7 | 260 | 242.3 | 16 | 16.4 | — |
  | Saturday | Plan spreadsheet | 260 | 218.6 | 243 | 202.2 | 17 (8) | 16.5 | 01:38 |
  | Saturday (GTFS modeled) | Plan × weekday GTFS/plan ratio (1.010) | — | — | 243 | 204.2 | omitted | — | 21:55 cutoff |
  | Sunday/Holiday | Plan spreadsheet | 224 | 188.5 | 213 | 177.9 | 11 (5) | 10.6 | 00:38 |
  | Sunday (GTFS modeled) | Plan × weekday GTFS/plan ratio (1.010) | — | — | 213 | 179.6 | omitted | — | 21:55 cutoff |

  Findings:
  - The Build feed has the same 276 weekday trips as the plan.
  - Its 16 placeholder trips are the plan's 16 late-night trips (8 each direction). The feed codes them as the full Wagon Road–Englewood pattern (45 stops) with every time set to 00:00, probably because the model could not represent service past midnight. The plan has 14 of the 16 as full-corridor trips and 2 as short trips.
  - Excluding the late-night trips, the feed runs 2.4 hours a weekday (1.0%) longer than the plan, about 0.6 minutes per trip.
  - **Saturday and Sunday (GTFS modeled)** estimate what weekend feeds would show if built the same way as the weekday feed: the plan's weekend trips with the late-night trips omitted, scaled by the weekday feed-to-plan ratio on the same trips (242.3 ÷ 239.9 = 1.010).
  - Including the late-night trips, the plan's weekday total of 256.3 hours matches the figure computed by hand from WK Times (about 256).
  - Generated by `plan_vs_gtfs.py`; output in `output/brt_plan_vs_gtfs_running_hours.csv`.
- **Correction (2026-10-12).** An earlier version of this memo read the spreadsheet's after-midnight times (stored as dates) as blank, and so reported:
  - 269 weekday trips, 247.1 hours, and a last departure of 23:54;
  - weekend figures that were also too low;
  - +40% on a trip-time basis, and a $4.9M overstatement.

  The figures above, and in Sections 2–4 and 6, are corrected.
- **Weekends.** The Build feed has no Saturday or Sunday BRT trips. Weekend comparisons must use the Plan spreadsheet, not the feed.
- **"Platform" vs "revenue" hours.** The Plan memo uses "platform time" in one place and revenue hours elsewhere. The annual figures are revenue hours; platform hours, which add travel to and from the garage, appear in the spreadsheet but are not used.
- **Baseline date.** Both feeds are RTD's January 2023 runboard (generated 2023-01-11). Corridor service may have changed in later service changes. A current No-Build would need a current RTD feed.

## 6. Recommendation

Report the BRT service increase on one consistent basis, either:
- **revenue hours with layover:** about 81,000 hours today vs 112,550 for the plan (+39%), or
- **trip time only:** 63,600 vs 92,100 (+45%).

Restate the BRT-vs-existing operating cost on the same basis. Before using the BRT-vs-SOP comparison, confirm with RTD whether the SOP's 98,600 hours include layover.

## Reproducing these numbers

- Corridor-only results: see `README.md` in this folder.
- Route-level 2023 baseline and the BRT trip-only hours: `reconcile_memo.py` in this folder. It needs the No-Build feed (unzipped) and the Plan spreadsheet; neither is committed to the repo.
