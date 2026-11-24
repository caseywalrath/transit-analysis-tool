# A4 — Feed overview and click-for-details (sub-plan)

**Status:** done (2026-11-21); archived. Parent plan: `docs/gtfs-expansion-plan.md` § A4.

## Code facts verified (base commit `71eb438`)

- Map clicks: `js/core/editing.js` `map.on("click"` is the only handler that selects features and
  opens the dock (`featuresAt`, `emptyMapClick`). Before A4, `js/projects/gtfs.js` `wireHoverEvents` also
  added a layer `click` listener that opened a MapLibre popup (`_clickPopup`, `buildClickHTML`).
- The dock (`js/core/feature-attributes.js`): `openAttrDock` / `syncAttrDock` / `closeAttrDock`, `_cur`,
  `renderSingle` / `renderMulti` / `renderEmpty`, `setHeader`, `setToolbar`, `freshBody`. Escape:
  `js/app.js` "One Escape closes one layer" calls `App.closeAttrDock()`.
- Schedule engine: `departuresAtStop`, `medianHeadway`, `patterns`, `dominantPattern`,
  `routeDaySummary`, `DEFAULT_DAY_PARTS`, `headwayBands(departures, dayParts)`,
  `serviceCopyPlan(feed, {routeId, dates, dayParts})`.
- Date API: `App.gtfsAnalysisDate.get/set/onChange`; private `_dateListeners`, `fireDateChange`.
- Session state: `App.cache.registerModule("gtfs-browse", {collect, apply})` in `gtfs.js`.

## Fixed decisions

- **G4a (left panel).** GTFS stop and route details open in the attributes dock as a read-only
  "view" (`App.openDockView`). The map click popup is removed; the hover tooltip and right-click menu stay.
- **Click ownership.** `editing.js` stays the single owner: when no drawn feature is under the click it
  asks `App.gtfsPickAt(point)` (stops before routes) and calls `App.gtfsOpenDetails(target)`. Drawn
  features always win. Box select and the stop-selection badge are unaffected.
- **Dock invariants for a view.** Opens only from a gesture; survives empty-selection syncs (no selection
  behind it); replaced by any drawn selection, the empty prompt or a multi-selection; closed by Escape,
  the close button, an empty-map click, and clearing the feed. No delete path touches it.
- **G4b (instant).** Date change, hidden routes and day parts redraw an open view and the overview at
  once (`refreshDetails`). These panels have no Run button and no stale banner, by design.
- **G4c (day parts).** One setting, `App.gtfsDayParts` (six parts, first fixed at 00:00, ids/labels fixed,
  starts editable), saved in the session under `gtfs-browse.dayParts`, used by copies and every headway
  report. Peak = parts `am` + `pm`; off-peak = `midday`. Headway = median gap between departures inside a part.
- **Coverage tab.** Census figures (¼ / ½ mi population, households, workers, equity shares) move to A6,
  which builds the block method for real schedules; A4 ships the schedule-only part as a **Spacing** tab
  (distance to the neighbouring stops on each route). The parent plan allows this ("the sub-plan decides").
- **Trips tab speed.** Renders the first 200 rows with "Show all"; figures come from the cached day
  expansion (`dayEntries`).

## Packages

| Id | Class | Work |
|---|---|---|
| A4.1 | [H] | Engine: `stopDepartures`, `stopSummary`, `stopSpacing`, `routeSchedule`, `feedOverview` + golden cases |
| A4.2 | [O] | Dock view API, click ownership, popup removal, day-parts setting, instant refresh, Details tabs |
| A4.3 | [S] | Trips / Spacing / Stops / Schedule tabs, Overview tab with day-parts editor, `test/browser/gtfs-details.test.mjs` |
| A4.4 | [O] | Review, RTD performance check, screenshots, docs, commit |

Cards: A4.1 and A4.3 were written as task cards in `AGENTS.md` format and kept with the session's
working files; their contracts are summarised in `docs/reference/modules/gtfs.md`.

## Verification

- Golden: `node test/run-golden.mjs` → PASS.
- Browser: `gtfs-details`, `gtfs-schedule`, `gtfs-copy-service`, `attr-dock`, `attr-dock-multi`,
  `gtfs-browser-smoke` (run individually).
- Screenshots of each tab, light and dark, and narrow width.
- RTD: Trips tab on the busiest stop renders in under 250 ms.

## Docs

`docs/reference/modules/gtfs.md` (details views, overview, day parts), `docs/reference/` dock page
(`drawing-and-features.md`: read-only views), `CLAUDE.md` dock invariant line, `test/README.md` (new cases).

## Progress log

- 2026-11-21: gates answered (G4a left panel, G4b instant, G4c shared day parts). A4.1 to Haiku; A4.2 by
  Opus; A4.3 to Sonnet after A4.1.
- 2026-11-21: A4.1 Haiku and A4.3 Sonnet passed first time; review found 10 issues, all fixed by Opus. Closed; see the parent plan's progress log.
