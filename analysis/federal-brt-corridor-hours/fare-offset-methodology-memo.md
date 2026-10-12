# Memo: Method for estimating how much BRT fare revenue offsets added operating cost

**Subject:** Proposed method, data limitations and recommended handling for comparing added fare revenue (from added ridership) against added operating cost, Federal Blvd BRT
**Date:** 2026-10-12
**Status:** Methodology review, with preliminary estimates in Section 7 (inputs to be confirmed)
**Related:** `service-hours-reconciliation-memo.md` and `README.md` in this folder

## Summary

The proposed method is sound:

1. Compare the STOPS Build and No-Build ridership forecasts and turn ridership into fare revenue, using an effective fare per trip from the National Transit Database (NTD): fare revenue ÷ trips.
2. Compare the added fare revenue with the added annual operating cost: revenue hours × NTD cost per revenue hour.

The most important refinement is on the revenue side. **Only new transit trips produce new fare revenue**, not total BRT boardings, because most BRT riders already ride Route 31 and already pay. The two data limitations identified (running time vs. revenue hours, and a weekday-only BRT feed) can both be handled with data already in hand.

## 1. Proposed method

| Step | Input | Source |
|---|---|---|
| Effective fare per trip | Fare revenue ÷ trips | NTD, bus mode |
| Added fare revenue | (Build − No-Build) trips × fare per trip | STOPS |
| Added operating cost | (Build − No-Build) revenue hours × cost per revenue hour | GTFS feeds, Plan spreadsheet, NTD |
| Result | Added fare revenue ÷ added operating cost | — |

## 2. Revenue side: count new trips only

**Use the change in total system trips, not BRT boardings.** A rider who moves from Route 31 to the BRT pays the same fare as before. Fare revenue changes only with the net change in transit trips across the system (Build minus No-Build).

**Match the trip type to the fare rate.** NTD reports *unlinked* trips, meaning each boarding. A *linked* trip is one door-to-door journey, which may include transfers.
- Fare revenue ÷ unlinked trips is a fare per boarding, diluted by free transfers.
- If the Build network changes how often riders transfer, applying a per-boarding fare to new boardings misstates revenue, because transfers bring in no money.
- Preferred: apply a **fare per linked trip** (fare per boarding × boardings per linked trip) to STOPS's **added linked trips**.
- Acceptable alternative: apply fare per boarding to the change in **total system boardings**, not BRT boardings.

**Choose the NTD year with care.**
- Use **bus-mode** figures, not the agency total; rail fares and ridership differ.
- Several RTD policies pull down the average fare in some years:
  - Zero Fare for Better Air summers (2022 onward)
  - free youth fares (from late 2023)
  - the September 2023 fare restructuring
- Choose a year whose fare policy matches what is expected when the BRT opens, or adjust for the difference.

**Line up the years.** STOPS forecasts are for a specific opening or horizon year, and the Plan memo's costs are in 2029 dollars ($209.66 per hour). Put fare and cost in the same year's dollars. Note how ridership is expected to ramp up if the horizon year is later than opening.

## 3. Cost side

### 3.1 Limitation 1: running time vs. revenue hours (mostly solved)

GTFS trip times are running time only. NTD cost per hour is divided by revenue hours, which include layover and recovery time. Applying the NTD rate to running time alone would understate cost by about a fifth.

Revenue-type hours (with layover) are already available for both scenarios:

| Scenario | Trip hours (no layover) | Hours with layover | Ratio | Source |
|---|---|---|---|---|
| No-Build, Routes 30 + 31 | ~59,190 | ~76,550 | 1.29 | No-Build GTFS: each bus's first departure to last arrival (`reconcile_memo.py`) |
| Build, BRT + Route 29 | ~92,080 | ~112,550 | 1.22 | Plan spreadsheet, WK Hours sheet |

The layover share is broadly similar in both scenarios: about 23% of revenue hours for the No-Build and 18% for the BRT. If either side ever has to be estimated, scaling trip hours by the other side's ratio is a defensible fallback.

**Use dollar amounts, not a percentage alone.** The question is added revenue ÷ added cost, which needs a dollar figure on both sides. A percentage change in hours is only an intermediate step.

**Cost whole routes, not the corridor.** The corridor-hours analysis in this folder was built for a like-for-like corridor comparison. Buses are paid for over their whole run, so use full-route revenue hours.

**Indicative added cost:** about 31,600 revenue hours a year × $209.66 ≈ **$6.6 million a year** (2029 dollars).

### 3.2 Limitation 2: the Build feed is weekday only

Two workable options:

- **A. Weekday only (recommended as the primary result).**
  - STOPS forecasts are average-weekday trips, and weekday service hours are the best-matched data on both sides.
  - Calculate added fare ÷ added cost for one weekday, then annualize both sides with the same factor, or report the per-weekday ratio as is.
  - Weekends and holidays drop out evenly instead of adding error.
- **B. Full year (sensitivity check).**
  - Weekend hours exist for both scenarios:
    - No-Build: the No-Build feed has weekend trips and bus assignments for Routes 30/31.
    - Build: the Plan spreadsheet has Saturday and Sunday BRT revenue hours (277.0 and 245.9 a day).
  - Weekend ridership is the missing piece. Use an annual-to-weekday ratio, for example Route 31's annual ridership ÷ its average weekday ridership.
  - The Build feed is not needed for weekends.

## 4. Other considerations

- **Leave unchanged routes out of both sides.** Routes 29, 35, 36, 14 and 120E/W are unchanged; only the changes matter.
- **Fully allocated vs. marginal cost.**
  - NTD cost per hour includes fixed overhead that will not grow in proportion to about 30,000 more hours.
  - Present the full rate as the conservative case, with a marginal rate (often about 60–75% of the full rate) as a sensitivity.
- **Costs the hourly rate misses.** BRT-specific items such as station upkeep and fare equipment are not captured by an hourly rate. Note them, or add them as a separate line.
- **Network consistency.** The STOPS No-Build and Build networks should match these GTFS feeds (January 2023 runboard). If STOPS used different networks, the two sides are not comparable.
- **What to report:**
  - the offset ratio (added fare revenue ÷ added operating cost), and
  - the share of operating cost covered by fares (farebox recovery) for each scenario.

## 5. Rough scale (illustrative only)

At about $6.6 million of added annual cost, fares would cover the entire increase only with $6.6 million ÷ (fare per new trip) new trips a year.

| Fare per new trip (illustrative) | New annual trips to break even | Per weekday (about 300 equivalent days) |
|---|---|---|
| $1.00 | 6.6 million | ~22,000 |
| $1.50 | 4.4 million | ~14,700 |
| $2.00 | 3.3 million | ~11,000 |

Corridor BRT projects usually forecast a few thousand new daily trips. Expect fares to offset a minority of the added cost, likely around 10–40%. This is a typical result for this kind of investment and should be presented as an expected finding.

## 6. Next steps

1. Pull bus-mode NTD fare revenue, unlinked trips and (if available) linked trips for the chosen year. Calculate fare per linked trip.
2. From STOPS, get the Build minus No-Build change in total system linked trips (average weekday) and the forecast year.
3. Get weekday revenue hours: No-Build Routes 30/31 from the No-Build GTFS, and BRT from the Plan spreadsheet's WK Hours sheet.
4. Calculate the weekday offset ratio. Annualize, and run the sensitivities: marginal cost, fare year, full year with weekends, ramp-up.

## 7. Preliminary estimates (2026-10-12)

**For later comparison only.** Several inputs are unconfirmed (see 7.1). All dollars are 2024 dollars: the fare comes from 2024 NTD data, so it is paired with the 2024 cost rate from the Plan memo's chain, $180.85 per revenue hour.

### 7.1 Inputs

| Input | Value | Source | To confirm |
|---|---|---|---|
| Weekday ridership, No-Build | 6,720 | STOPS | Linked or unlinked? Corridor routes only, or the whole system? |
| Weekday ridership, Build | 9,566 | STOPS | Same |
| Added weekday ridership | **2,846** | Build − No-Build | — |
| Fare per unlinked trip | $0.81 | 2024 NTD | Update to 2023 to match the GTFS base year |
| Cost per revenue hour | $180.85 | Plan memo rate chain, 2024 | — |
| Weekday revenue hours, No-Build Routes 30 + 31 | 231.4 | No-Build GTFS, each bus's first departure to last arrival (bus assignments that serve only 30/31) | One bus assignment that also runs another route is excluded (small) |
| Weekday revenue hours, BRT | 311.6 | Plan spreadsheet, WK Hours | — |
| Added weekday revenue hours | **80.2** | — | — |
| Weekdays per year | 255 | Plan memo | — |

Route 29 and the other unchanged routes are left out of both sides. For reference, weekday trip time without layover is 185.8 hours for No-Build Routes 30 + 31 and 256.3 hours for the BRT (all 276 plan trips, including late-night).

### 7.2 Base estimate (weekday, revenue hours, full cost rate)

| | No-Build | Build | Change |
|---|---|---|---|
| Weekday ridership | 6,720 | 9,566 | +2,846 |
| Weekday fare revenue | $5,443 | $7,748 | **+$2,305** |
| Weekday revenue hours | 231.4 | 311.6 | +80.2 |
| Weekday operating cost | $41,849 | $56,353 | **+$14,504** |
| Farebox recovery | 13.0% | 13.7% | — |
| Annual (255 weekdays): fare revenue | $1.39M | $1.98M | **+$0.59M** |
| Annual (255 weekdays): operating cost | $10.67M | $14.37M | **+$3.70M** |

**Base result: added fare revenue covers about 16% of the added weekday operating cost.** That is about $0.59 million of $3.70 million a year on weekdays, leaving a net added cost of about $3.1 million a year.

Farebox recovery is about the same in both scenarios, so the BRT neither improves nor worsens the corridor's cost recovery much. The added riders pay for about the same share of the added service as existing riders do today.

### 7.3 Sensitivities

| Case | Change from base | Offset ratio |
|---|---|---|
| Base | — | **16%** |
| Trip time only (no layover) on both sides | +70.5 hrs/day instead of +80.2 | 18% |
| Ridership is linked trips (assumes 1.3 boardings per trip, so $1.05 per trip) | Revenue × 1.3 | 21% |
| Marginal cost at 70% of the full rate | Cost × 0.7 | 23% |
| Linked trips + marginal cost | Both | 30% |
| Part of the added ridership is diverted from other routes (half is new) | Revenue × 0.5 | 8% |
| 2029 cost rate ($209.66) with the fare held at $0.81 | Cost × 1.16 | 14% |
| Full year (see note) | Weekend hours added | ~11% |

**Full-year note.** Weekend increases in hours are larger than on weekdays:
- Saturday: 166.8 → 277.0 (+110.2)
- Sunday/holiday: 115.9 → 245.9 (+130.0)

That brings the annual increase to about 33,700 revenue hours, or $6.10 million. Weekend ridership is not yet available. Scaling weekday revenue to about 300 weekday-equivalent days gives about $0.69 million, an offset of about 11%. Adding weekends therefore lowers the ratio.

### 7.4 Reading the results

- **Expected range: about 10% to 30%.** The base case is about 16%.
- **The biggest unknown is what 6,720 and 9,566 measure.**
  - If they are BRT and corridor-route boardings rather than the change in total system trips, part of the 2,846 is riders moving from other routes. Those riders bring no new fare, which pushes the ratio toward the low end.
  - If they are linked system trips, the ratio moves up.
- **Inputs to update when confirmed:**
  1. what the STOPS figures measure, and their forecast year;
  2. the 2023 NTD fare per trip;
  3. a marginal cost rate, if RTD has one.

  Each enters the tables above as a direct multiplier.

