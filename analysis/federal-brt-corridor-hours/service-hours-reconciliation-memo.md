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

Measured on the same basis, the BRT plan is about **+39% to +40%** over 2023 service. That matches this folder's independent corridor analysis (+37% on a typical weekday). Because every cost in the memo is hours × one hourly rate, the "BRT vs existing" cost gap is overstated for the same reason, by roughly **$3.6–4.9 million a year** in 2029 dollars.

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
| Weekday | 311.6 | 247.1 |
| Saturday | 277.0 | 209.7 |
| Sunday/Holiday | 245.9 | 183.5 |
| **Annual** | **108,123** (memo: 108,050) | **84,549** |

The memo's 108,050 is the sum of rounded table values; the spreadsheet's unrounded total is 108,123. The trip-only column was computed from the spreadsheet's WK/SA/SU Times sheets: first to last timepoint for every trip, both directions. Layover makes up about a fifth of the BRT revenue hours.

## 3. Like-for-like comparison

| Basis | 2023 existing | BRT plan + Route 29 | Change |
|---|---|---|---|
| Memo (mixed bases) | 63,800 (trip time) | 112,470 (with layover) | **+76%** |
| Both trip time only | 63,617 | 84,549 + 4,430 = 88,980 | **+40%** |
| Both with layover | 80,980 | 112,550 | **+39%** |

Notes on the "both with layover" row:
- The existing Routes 30/31 figure (76,551) uses each bus's day from first departure to last arrival, grouped by the feed's bus assignments (`block_id`). This is the same method the spreadsheet uses for BRT.
- Route 29 (4,430) is counted as trip time only, because its buses also run other routes and their day can't be split out. The total is 76,551 + 4,430 = 80,980.

Both like-for-like methods land at about +39% to +40%.

### Cross-check against the corridor-only analysis

This folder's corridor analysis measures something narrower: scheduled time **on the Federal corridor only**, typical weekday, from the same two GTFS feeds and the same stop list.

| Weekday, Federal corridor only | No-Build | Build | Change |
|---|---|---|---|
| Corridor trip hours | 195.1 | 267.0 | +72.0 hrs (**+37%**) |

The Build feed is missing the plan's late-evening BRT trips (about 7.4 trip hours on a weekday; see Section 5). Adding them back puts the change at roughly +77 hours (+39%), consistent with the route-level result above.

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
| Both trip time only | 88,980 − 63,617 = 25,363 hrs | 23,307 hrs | **$4.9M/yr** |
| Both with layover | 112,550 − 80,980 = 31,570 hrs | 17,100 hrs | **$3.6M/yr** |

So the BRT-vs-existing operating cost increase is overstated by roughly **$3.6–4.9 million a year** in 2029 dollars.

The BRT-vs-SOP gap ($2.9M) is like for like only if the SOP's 98,600 hours also include layover; the memo doesn't say.

## 5. Other reconciliation notes

- **Plan schedule vs Build GTFS (weekday).** The Plan spreadsheet has 269 BRT trips (247.1 trip hours). The Build feed has 260 timed trips (242.3 hours) plus 16 placeholder trips whose times are all 00:00.
  - On the matching 260 trips, the feed runs 2.6 hours longer, about 0.6 minutes per trip.
  - The feed is missing the plan's 9 extra trips (7.4 hours): 5 full-length late-evening trips and 4 short pull-in/pull-out trips. The plan's last departure is 23:54; the feed's is 21:55.
- **Weekends.** The Build feed has no Saturday or Sunday BRT trips. Weekend comparisons must use the Plan spreadsheet, not the feed.
- **"Platform" vs "revenue" hours.** The Plan memo uses "platform time" in one place and revenue hours elsewhere. The annual figures are revenue hours; platform hours, which add travel to and from the garage, appear in the spreadsheet but are not used.
- **Baseline date.** Both feeds are RTD's January 2023 runboard (generated 2023-01-11). Corridor service may have changed in later service changes. A current No-Build would need a current RTD feed.

## 6. Recommendation

Report the BRT service increase on one consistent basis, either:
- **revenue hours with layover:** about 81,000 hours today vs 112,550 for the plan (+39%), or
- **trip time only:** 63,600 vs 89,000 (+40%).

Restate the BRT-vs-existing operating cost on the same basis. Before using the BRT-vs-SOP comparison, confirm with RTD whether the SOP's 98,600 hours include layover.

## Reproducing these numbers

- Corridor-only results: see `README.md` in this folder.
- Route-level 2023 baseline and the BRT trip-only hours: `reconcile_memo.py` in this folder. It needs the No-Build feed (unzipped) and the Plan spreadsheet; neither is committed to the repo.
