# A8 — Export drawn Services as GTFS; retire Trip Builder (sub-plan)

**Status:** In progress. Parent plan: `docs/gtfs-expansion-plan.md` § A8. Base commit `808c797`.

## Gate answers (2026-11-21)

- **G8a — Option A:** retire the Trip Builder panel once the export has passed its checks. Its trip generator
  (`AnalysisNetwork.bandTrips` / `proposalTrips`) stays and feeds the export and the travel-time analyses.
- **G8b — Option A:** headway bands travel with the file as `frequencies.txt`.

## Code facts verified (base `808c797`)

- `AnalysisNetwork.proposalTrips(proposal, dayType)` is already exported. Proposal shape (built by the private
  `collectProposals` in `js/core/analysis-network-source.js`): `{key, name, color, mode, stops: [{id, name, lat, lon}],
  patterns: [{id, directionId "0"|"1", both, bands: {weekday, saturday, sunday: [{from "HH:MM", to, frequency min}]},
  runtimeMin, lengthMi, stops: [{id, distMi}]}]}`. Patterns without associated Points get stops every 0.25 mi.
- Trips step from each band's start by its headway while below its end (`bandTrips`); stop times are
  `round((start + runtime × fraction) × 60)` seconds, so with a whole-second headway every trip of a band has the
  same offsets from its first stop. That makes `frequencies.txt` with `exact_times=1` an exact, lossless
  description of the same trips.
- JSZip is loaded globally (`index.html`); the toolbar Export dropdown (`#export-dropdown`) holds the export buttons.
- Costing tool (read-only, D14): its planned frequencies (Decision 0058) are periods `{startTime, endTime,
  headwaySeconds}` with whole seconds ≥ 60, start inclusive, end exclusive, slots `start + k × headway` below the end;
  stops carry latitude/longitude (Decision 0085); stop times between timepoints are derived (0079, 0086). The
  export therefore writes whole-second headways, exact-times windows whose end is exclusive, stop coordinates, and
  marks the first and last stop of each trip as timepoints.

## How bands become frequencies.txt (G8b)

The user chose "alongside the trips". Writing every trip **and** a frequency window over the same trips would make
any GTFS reader run the service twice, so each eligible band is written as **one template trip plus one
`exact_times=1` window**: the file still describes every departure exactly, and readers expand it to the same trips.
A band is eligible when its headway is a whole number of seconds of at least 60 and it yields two or more trips in
that direction; otherwise its trips are written one by one. With the dialog's "Include headway windows" switch off,
every trip is written one by one.

## Shape

- **A8.1 [Haiku xhigh]** `window.GtfsExport.build(input)` pure engine in `js/core/gtfs-export.js` + golden cases
  (card `docs/a8-cards/card-a8.1.md`).
- **A8.2 [Opus]** `App.gtfsExportInput(serviceKeys, opts)` in `analysis-network-source.js` (reuses `collectProposals`,
  adds shapes and route fields).
- **A8.3 [Sonnet]** Export dialog from the Export dropdown ("Drawn Services as GTFS (ZIP)"): Service checklist, agency
  fields, date range, headway-window switch; ZIP download; browser test that loads the ZIP back through the app's GTFS
  reader.
- **A8.4 [Opus]** Verification (load-back test; validator instructions for the user), then retire Trip Builder (G8a):
  remove its menu entry and script tag, keep old sessions loading (its saved block is ignored), update docs.

## Progress log

- 2026-11-21: gates answered (G8a Option A, G8b Option A); sub-plan and card A8.1 written (Opus).
