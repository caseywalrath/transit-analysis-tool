# Feature Split (lines and routes) — design plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/drawing-and-features.md. This file is historical.

Status: Phases 1 (Split here) and 2 (Split out section…, loops, Split at this node) done — `js/core/split.js`, `test/cases/split.mjs`, `test/feature-split-smoke.mjs`. Phase 3 (module awareness, opposite direction) done.

## Goal

Let the user right-click a drawn Line or Route on the map and cut it into
pieces: **Split here** (one cut, two pieces) or **Split out section…** (two
cuts, the stretch between them becomes its own feature). It is the reverse of
Feature Merge (`docs/feature-merge-plan.md`): one undo step, a short
confirmation dialog, and the resulting pieces can be merged back with the
existing Merge… command to give the original geometry exactly.

Polygons and points are out of scope.

## What already makes this easy

- **Stable feature IDs** (merge plan Phase 1) and **module references by ID**
  (Phase 4b). Every module now remembers features as `{type, id}` and treats a
  missing ID as "deleted". So a split that keeps the original ID on one piece and
  gives the other piece a new ID can't silently point a module at the wrong
  feature.
- **Checklists remember the unchecked features.** TPI, Corridor Scoring,
  Transit Coverage and Feature Area Analysis default a new feature to checked,
  so a new piece joins their analysis set automatically and total coverage is
  unchanged.
- **Merge is already the inverse.**
  - `chainLines` drops the duplicate vertex at a join under ~1 m.
  - Route merge drops a duplicate waypoint at a coincident join and doesn't route
    a connector there.
  - So merging the two pieces back reproduces the original line exactly.
- **The rest can be reused.** Merge's dialog shell (`buildShell` /
  `buildActions` / `installDialog`, `.fm-*` styles), `App.undo.push()`, the
  per-type re-render and `App.onFeatureDelete()` housekeeping.

## User interface

**Map right-click menu** (`js/core/editing.js`, the `contextmenu` handler) on a
line or route, placed after Duplicate:

- **Split here.** The cut goes at the point on the line nearest the click.
  - If the click is within ~10 px of an existing vertex, the cut snaps to that
    vertex, so no sliver segments are created.
  - The item is hidden within ~30 ft of either end, where it would make a piece
    with no length.
- **Split out section…** First point = where you right-clicked. Moving the mouse
  highlights the stretch along the line up to the cursor (a preview layer). Click
  again to set the second point; Escape cancels.
  - The result is 3 pieces, or 2 if a cut lands on an end.
  - The middle piece is selected afterwards.
  - This is what "select a segment and split it off" means in practice.
- **Vertex-edit menu** (`showVertexCtxMenu`): add **Split at this node** next to
  Delete node. For routes this cuts exactly at a waypoint, the cleanest split a
  route can have.

The cut is not applied at once. A **Split dialog** opens first, reusing the
`.fm-*` shell, and shows:

- One row per piece: an editable name and its length (mi). The new pieces' names
  are pre-filled (see Names).
- **Service:** only when the feature has a `serviceId` (see Services).
- What happens to **run time** and **stops**, for example "3 stops move to part
  2; 1 stop at the cut point is linked to both".
- Amber warnings (see Warnings).
- **Split** and **Cancel** buttons. Enter confirms; Escape cancels.

**Loops.** A feature whose two ends are within ~50 ft of each other (a Loop/CW/
CCW route) can't be split into two by one cut — the cut only opens it. On a
loop, **Split here** is replaced by **Split out section…**.

## What each piece gets

The convention: **the piece containing the original start keeps the feature**
(its array slot, ID, `colorSeq`, merge history rule below). The other pieces
are new features appended to the end of the same array with
`App.nextFeatureId(type)`.

| Property | Rule | Why |
|---|---|---|
| Name | First piece keeps the name; others get `"<name> (2)"`, `"(3)"`, made unique like `App.gtfsBrowse.uniqueServiceId`. Editable in the dialog. | A rename is a choice the user should make, not a default. |
| Color | An explicit `properties.color` is copied to every piece. When the color is Automatic, each new piece gets a fresh `colorSeq` (a different palette color), the same rule as Duplicate. | Pieces of a custom-colored route stay matched; automatic pieces become visually distinct, so the cut can be seen. |
| Appearance overrides (`_opacity`, `_lineWidth`, `_bufferRadius`, `_offset`, …) | Copied to every piece. | They were the user's style for this feature. |
| `group` | Copied. | Pieces belong together in the Layers tab. |
| `direction`, `mode`, `avgSpeed`, `notes` | Copied. | Each piece still runs the same way. |
| Service bands (`service`) | Copied. | The same schedule runs on every piece. |
| `runTime` | Divided in proportion to each piece's length (rounded to 0.1 min). The dialog says it is an estimate. | The opposite of merge, which adds run times together. |
| `serviceId` | See Services. | — |
| Route `waypoints` | Split at the cut, with the cut point added as a new end waypoint on both sides of it. | The pieces stay editable. |
| Line `waypoints` (vertex count) | Recomputed. | — |
| `_mergedFrom` (Unmerge history) | Removed from every piece. The dialog says "Unmerge will no longer be available for this feature." | Unmerging the first piece later would bring back the originals and leave the other piece orphaned. |
| `seq` (Features "Date added" sort) | The first piece keeps it; new pieces get a fresh one. | — |

### Services (`serviceId`) — the most important decision

Copying the `serviceId` onto both pieces is usually wrong. Route Costing and
Trip Builder would then read the pieces as separate patterns of one Service:

- **Example 1 — a 1-pattern "Both" Service.** The pieces become two "Both"
  patterns, which is invalid as a pair.
- **Example 2 — a NB+SB pair, with NB split.** The result has 3 patterns, so
  NB-a and NB-b are costed as two independent trip streams. They are really two
  halves of the same trip, so cost and vehicle counts come out wrong.

Choices for the new pieces:

1. **New Service (default).** Named `"<serviceId> (2)"`, made unique.
2. **No Service.** Each piece is its own 1-pattern Service.
3. **Keep in the same Service.** For a user who really is building branches or
   short-turns.

The first piece always keeps the original `serviceId`.

If the feature is **one half of a paired Service**, the dialog also warns that
the opposite direction has not been split, so the pair now covers only part 1.
Phase 3 adds the option "also split the opposite direction at the matching
point".

### Stops (`attributes.associatedRoutes`)

Every point linked to the original feature is re-linked by distance:

- A stop goes to the piece nearest to it.
- A stop within ~50 ft of a cut stays linked to **both** neighbouring pieces, as
  a transfer point.

Links use stable IDs. The first piece's link is unchanged, and the new pieces
get new `{featureType, featureId}` entries. The dialog shows how many stops
moved. This keeps Transit Travelshed's real stops correct with no change to
that module.

## Effect on analysis modules

| Module | What happens | Action needed |
|---|---|---|
| Route Costing, Trip Builder | Lengths change; new pieces become Services according to the Service choice. Trip Builder's stored trips under the first piece's key become stale (the run time changed). | Already marked stale by `notifyProject()`. Nothing new. |
| TPI, Corridor Scoring, Transit Coverage, Feature Area Analysis | The first piece keeps its ID; new pieces are checked by default. Results show as stale. | None. Corridor Scoring ranks the pieces as separate corridors, which is the intended result. |
| Ridership Forecasting | Calibration matches routes to the CSV **by name**, so renamed pieces stop matching. | Dialog warning when an RF calibration exists. |
| Title VI | A before/after reference now points only at the first piece, so % altered and service-loss area cover part of the route. | Dialog warning naming the scenario/alteration. |
| Transit Travelshed | Stops are re-linked (see Stops); each piece is ridden on its own, so riding across the cut needs the transfer the cut point gives. | None. Noted in the help text. |
| Buffers | Rebuilt per piece; the combined area is the same. | None. |

The Ridership Forecasting and Title VI warnings need a way to ask "which
modules refer to this feature?". Phase 3 adds a small, optional hook:
`App.registerFeatureUsage(fn)`, where each module returns labels such as
"Title VI · Scenario A · 'before' of Alteration 1". The Merge dialog can use the
same hook.

## Code layout

New file `js/core/split.js`, loaded after `merge.js`. It reuses the merge
dialog helpers; export them from `merge.js` as `App.merge._dialogKit`.

Pure helpers on `App.splitGeom` — no turf, map or DOM, so they can be tested in
`test/cases/split.mjs`:

- `cutAt(coords, cuts)`
  - `cuts` is a list of `{segIndex, t}` positions along the line.
  - Returns the coordinate arrays of the pieces.
  - The cut point is a shared vertex at the end of one piece and the start of
    the next; a cut at an existing vertex adds no new vertex.
- `locate(coords, lngLat, hintSegIndex?)`
  - Finds the nearest position on the line, using inline equirectangular maths
    like `road-network.js`'s `nearestOnSegmentKm`.
  - A segment hint lets a route that passes the same spot twice use the stretch
    the user actually clicked.
- `partitionWaypoints(coords, waypoints, cuts)`
  - Places each waypoint along the line, searching forward from the previous
    one so a route that overlaps itself still places them in order.
  - Splits them at the cuts and adds the cut point as an end waypoint.
- `splitRunTime(runTime, lengths)`
- `assignStops(stops, pieces, toleranceFt)`

The engine, `App.split.analyze(type, index, cuts)`, returns a plan
`{ok, errors, warnings, pieces, stopsMoved, apply}`, the same shape as merge's.
`App.split.run(plan, choices)` then:

1. Takes one `App.undo.push()`.
2. Mutates the first piece in place and appends the new pieces.
3. Re-links stops.
4. Re-renders lines/routes/points.
5. Calls `App.onFeatureDelete()` housekeeping and `App.notifyProject()`.
6. Selects the resulting pieces with multi-select.

## Phases

1. **Split here.** *(Done.)* Lines and routes: pure helpers plus golden tests, engine,
   dialog, attribute/Service/stop rules, undo, and the map menu item. A browser
   smoke test is added to `test/feature-merge-smoke.mjs`, or a new
   `test/feature-split-smoke.mjs`. It checks that split followed by Merge gives
   identical coordinates, and that split followed by Undo restores the session
   exactly.
2. **Split out section…** *(Done.)* The two-point pick mode with preview, splitting loops,
   and **Split at this node** in the vertex menu. Loop rule: the stretch between the
   two points (in line order) becomes the new feature; the rest is joined through the
   loop start into one piece that keeps the original feature and begins at the second
   point. A point within ~30 ft of an end of an open line counts as that end (2 pieces).
3. **Module awareness.** *(Done.)* The `registerFeatureUsage` hook and its warnings in
   both the Split and Merge dialogs, plus "also split the opposite direction"
   for paired Services. Opposite rule: offered when the `serviceId` has exactly one other
   pattern with the opposite direction (neither a loop); its cut(s) are the nearest positions
   to our cut points, refused beyond ~300 ft or within ~30 ft of its end; each of its pieces
   takes the serviceId of the piece of ours it runs alongside (its order is reversed), so the
   pieces form valid pairs; both splits are one undo step.

Update `CLAUDE.md` (File Structure, Script Load Order, `split.js` API) in each
phase, as merge did.
