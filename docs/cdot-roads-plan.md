# Plan: CDOT road layers as a live street source

Status: planning, not started. Source brief: `cdot-rest-source-design-brief.md` (approved by the lead
November 13, 2026; kept outside the repository). This plan follows the brief except where the sections
below say otherwise. Where the brief and this plan disagree, this plan wins; where this plan and the code
disagree, the code wins and the difference is reported.

Purpose: run the same walkshed on CDOT road centerlines and on OpenStreetMap streets, side by side, using
the existing engine. Nothing is replaced; OpenStreetMap stays the default.

## 1. Changes to the brief, decided with the lead (November 16, 2026)

### 1.1 Streets load automatically on Calculate

The brief (section 6) has the user press "Download CDOT streets for this area" before the walkshed runs.
Instead, with CDOT active, Calculate fetches whatever streets the run needs and then runs, exactly as the
FLM tile source already does. The download button stays as a fallback (for example, to retry after a
failure). Failures show in the status line and nothing is drawn. The large-area warning
(`MAX_AREA_WARN_KM2`) still asks before a very large download.

The long-term goal (place points, click Calculate, the app handles streets for any chosen source) also
covers plain OpenStreetMap downloads. That is a separate change, not part of this plan.

### 1.2 One request area per point, not one rectangle around all points

The brief sends one rectangle around every point, so two distant points download every road between
them. Instead Walkshed sends one CDOT query per point's box (the `pieces` Walkshed already computes
for FLM tiles) and merges the results. `CdotRoads.toRoadGeoJSON` already keeps a road once when two
boxes both return it (dedupe by layer + `OBJECTID`).

- Coverage: `road-network.js` remembers the loaded boxes (`_loadedBoxes`, list of `[w,s,e,n]`) for a
  CDOT network. `App.roadNetworkCoversExtent(extent, pieces)` answers true when every needed piece lies
  inside one loaded box. Cells (`_tileCells`) stay for tiles only.
- Map outline: the union of the boxes, as for tiles (display only).
- Stored copy: id `cdot:<layersKey>:<cache id of the overall extent>` as in the brief, plus a new field
  `boxes`. `findCovering` matches only `bbox:` ids, so a CDOT record is never matched by area. Like the
  tile records, it comes back only through the startup restore, and a run that needs more fetches it.
  `network-store.js` is not changed.
- Request count: N points spread far apart means N small queries per layer. Pages per layer stay
  sequential; the 50-page cap applies per box.
- Transit Travelshed keeps one rectangle (no pieces), as it does for tiles.
- Not built now: sending all boxes as one multi-part polygon in a single query. CDOT's server may accept
  it; untested. Phase 3 may try it once by hand and record the result.

### 1.3 Size of each point's box: walk reach plus the snapping distance

Walkshed already sizes each box as the straight-line reach of the largest time threshold:
`walk speed × largest minutes` (`computeRequiredExtent` in `js/projects/walkshed.js`). Because walking
along streets is never shorter than the straight line, every street a walker can reach lies inside that
circle, in every direction, even at a crossing of two perfectly straight roads.

Missing today: a buffer. A point can sit up to `SNAP_MAX_KM` (0.5 km, `js/core/road-network.js`) from
the street it snaps to, and that street may lie outside the circle. The radius therefore becomes

    radius = walk speed × largest minutes + SNAP_MAX_KM

which guarantees the snapped starting street is inside the box as well. `road-network.js` exposes the
constant as `App.ROAD_SNAP_MAX_KM` so the module does not copy the number.

This change lives in `computeRequiredExtent`, so it applies to every street source (OpenStreetMap, FLM
tiles, CDOT), which keeps the comparison fair. Side effects, accepted:
- Areas grow. For 5 minutes at 2.8 mph the radius goes from 0.38 km to 0.88 km; at 15 minutes from
  1.13 km to 1.63 km.
- A stored OpenStreetMap network downloaded with the old, smaller box may no longer cover a re-run, so
  that run asks for (or, with tiles/CDOT, fetches) streets once more.
- Golden values do not move (the function is not covered by golden tests). `walkshed-stale`,
  `walkshed-contour`, `network-cache` and `walk-tiles` browser tests are re-run; expected texts that
  quote a prepared area may need updating, which the card lists.

### 1.4 Reconciliation with the FLM tiles code as built

- **Turning tiles off without forgetting the folder.** `App.walkTilesSource` has only `clear()`, which
  forgets the folder or address. Add `pause()` / `resume()` and a paused flag (persisted in
  `mat-walk-tiles-source`): `isActive()` is false while paused, the dialog shows
  "Paused while CDOT supplies streets". Turning CDOT on pauses tiles; using tiles again (or turning
  CDOT off) resumes them. A picked folder cannot survive a page refresh anyway; that is unchanged.
- **Which source the live streets came from.** Add `App.roadNetworkSource()` returning
  `"overpass" | "file" | "walk-tiles" | "cdot" | null`, set at each load tail and in `loadStoredRecord`.
  Keep `App.roadNetworkTileRelease()`.
- **Store guard.** The tiles guard in `restoreNetworkCovering` becomes the brief's single rule (the
  record must come from the source a fresh load would use; for CDOT, also the same layers).
- **Entry point.** `App.fetchRoadNetworkForExtent(extent, pieces)` already takes pieces. Order: tiles
  branch, then CDOT branch (`loadNetworkFromCdot(extent, pieces)`), then the unchanged Overpass path.
- **Module text.** Extend the existing `labelDownloadBtn`, `streetsSuffix`, `needStreetsMsg` and
  coverage-warning helpers in `walkshed.js` and `transit-travelshed.js` with the CDOT strings from the
  brief, section 7.

## 2. Phases

| Phase | Class | Content |
|---|---|---|
| 0 | Lead | Ask CDOT GIS staff about terms of use for a public app and request limits (now more relevant: one query per point). Does not block 1 to 4. |
| 1 | Haiku, high | `js/core/cdot-roads.js` (brief 5.1), trimmed real fixtures, `test/cases/cdot-roads.mjs`, golden seeded. |
| 2 | Haiku, high | Markup only: Add Data entry under ONLINE, `#cdot-popup`, script tags (`cdot-roads.js` after `walk-tiles.js`; `cdot-source.js` after `walk-tiles-source.js`, before `road-network.js`). |
| 3 | Sonnet | `js/core/cdot-source.js` (brief 5.2) with `fetchExtent(boxes, progress)` taking a list of boxes; dialog wiring; tiles `pause()`/`resume()`. Live check from localhost at Union Station. |
| 4 | Sonnet, Opus review | `road-network.js` CDOT branch with pieces, `_loadedBoxes`, coverage, `App.roadNetworkSource()`, store guard; Walkshed auto-load on Calculate for CDOT; snap buffer in `computeRequiredExtent` (1.3); module strings; `app.js` entries. Behaviour test `test/browser/cdot-source.test.mjs` per brief section 9, plus: two distant points send two boxes per layer and the gap is not covered; Calculate alone (no button press) loads and runs. |
| 5 | Opus | Reference docs (`docs/reference/road-network.md` "CDOT road layers"), `CLAUDE.md` file map and load order, `features.md`, comparison write-up with the brief's section 9 table. |

## 3. Out of scope

As in the brief, section 11, plus: automatic street loading for plain OpenStreetMap downloads; per-point
requests for Transit Travelshed; the single multi-part query (1.2).

## 4. Progress log

- 2026-11-16: plan written from the brief; lead approved automatic load on Calculate, per-point requests,
  and the box size "walk reach plus snapping distance".
- 2026-11-16, Phases 1 and 2 (Haiku, high, in parallel on disjoint files). Phase 1: `js/core/cdot-roads.js`
  (`window.CdotRoads`: SERVICE, PAGE_SIZE, LAYERS, pageUrl, hasMore, validatePage, classify, toRoadGeoJSON),
  fixtures `test/fixtures/cdot/` fetched live and trimmed, 32 golden cases. Accepted deviations: test-only
  `CdotRoads._test.pageUrlError` behind a bare `__MAT_TEST__` check; extra validatePage text "feature <i> has
  malformed coordinates"; `report.skipped`; the layer-17 class-2 sample (PENA BLVD INBOUND, OBJECTID 176) comes
  from a wider box because the brief's box had none; page14-2 repeats OBJECTID 54875 on purpose. Live data
  matched brief section 2. Phase 2: Add Data entry `#ad-cdot-roads`, dialog `#cdot-popup` (ids `cdotLayer14/17/7`,
  `cdotLayerMsg`, `cdotUse`, `cdotInfo`, `cdot-popup-close`), CSS rule, script tag for `cdot-roads.js`; no tag
  yet for `cdot-source.js`. Review: diff read in full by the orchestrator; the formal code-review pass is run
  once over Phases 1 to 4 together at the Phase 4 gate.
- Deviation from 1.4 (orchestrator): no stored "pause" flag. `App.walkTilesSource.isActive()` is false while
  `App.cdotSource.isActive()` is true; the tile choice stays. Choosing a tile source turns CDOT off.
