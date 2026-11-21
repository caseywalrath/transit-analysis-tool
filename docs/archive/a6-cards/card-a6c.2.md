# Card A6c.2 (Sonnet): Transit Travelshed "Schedule (GTFS + proposals)" mode

## Files (only these)
- `js/projects/transit-travelshed.js`, `projects/transit-travelshed-popup.html`, `css/style.css` (`.ts-` rules only)
- NEW `test/browser/travelshed-schedule.test.mjs`
- `docs/reference/modules/transit-travelshed.md`

## Read first
`CLAUDE.md`, `docs/a6-cards/rules.md`, `docs/A6-plan.md` (A6c outline), `docs/reference/modules/transit-travelshed.md`,
the whole of `js/projects/transit-travelshed.js` and its popup, `js/core/raptor.js`, and in
`js/core/analysis-network-source.js` `App.computeScheduleTravelshed` (written; do not change it — report if it needs a
change), `App.computeOffsetWalkCostMap` / `App.walkKmToPoints` in `js/core/road-network.js`.
Tests to copy from: `test/browser/multi-walk-flood.test.mjs` (Overpass street grid stub),
`test/browser/analysis-network.test.mjs` (mini feed loading), `test/browser/walkshed-contour.test.mjs`.

## What to build
1. A "Service" select at the top of the inputs: "Headways (drawn routes)" (today's behaviour, default) and
   "Schedule (GTFS + proposals)". Stored as `settings.serviceMode` = `"headway"` | `"schedule"`.
2. In schedule mode:
   - hide the headway-only inputs (day/time, wait model, stop spacing, route checklist, shed mode "door");
   - show: departure window From / To (`HH:MM`, default 07:00 / 08:00), "Every [2] min", statistic select
     Typical (median) / Best case / Worst case (90th percentile), checkbox "Include hidden routes and Services";
     a read-only line with the GTFS analysis date and "(change it in GTFS Feed Attributes)", or "No GTFS feed:
     drawn Services only." The access / egress / transfer walk caps stay (defaults 0.5 / 0.25 / 0.25 mi).
   - Calculate keeps the origin + budgets + road-network prompt-to-download logic, then calls
     `App.computeScheduleTravelshed({ origin, budgetsMin, fromSec, toSec, stepSec, statistic, walkMph, accessMi,
     egressMi, transferMi, includeHidden, onProgress })`, shows progress in the status, and draws
     `result.bands` with the existing band rendering (ring-differenced largest first, legend, style options,
     GeoJSON export with metadata: serviceMode, window, statistic, departures).
   - Results: the band area table, plus a summary line: "D departures 07:00–08:00 every 2 min · typical (median)
     · S stops within reach · A stops within walk of the origin", the date / day type, `result.notes`,
     skipped proposals, "Transfers: walk up to ¼ mi, straight line × 1.3." and route timing (`routeMs`).
     If `accessStops === 0`: status "No stops within walking distance of the origin." (draw the walk-only band).
3. Stale: schedule-mode results go stale on input changes, on the GTFS analysis date change
   (`App.gtfsAnalysisDate.onChange`), on `update()`, and when the loaded feed changes (feed identity as in
   `js/projects/title-vi.js` `seSignature`).
4. Persistence: bump the settings version to 3 adding `serviceMode`, `windowFrom`, `windowTo`, `stepMin`,
   `statistic`, `includeHidden`; v1/v2 load as headway mode.
5. Docs: a "Schedule mode" section.

## Browser test
Street grid stub (as multi-walk-flood) placed under the mini feed's stops, or a drawn Service with a schedule on
the grid (no feed) — your choice; state hand-checkable facts: (a) schedule mode draws bands; the largest band
contains the origin; (b) a stop reachable only by riding is inside the band and not inside a walk-only run's band;
(c) Best ≤ Typical ≤ Worst areas; (d) a window with no trips gives only the walk area; (e) stale on date change;
(f) persistence v3 round trip; (g) headway mode unchanged (existing `walkshed-contour` still passes); no page errors.
Time a run and report it. Screenshots light + dark of results to
`/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/a6/shots/`.

## Done when
- `node test/run-golden.mjs` → PASS.
- `travelshed-schedule.test.mjs` → PASS twice; `walkshed-contour.test.mjs` and `hidden-features.test.mjs` → PASS.
