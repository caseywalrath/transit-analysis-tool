# Removed: the "Simplified" (concave-hull) walkshed shape

Status: **removed** from Walkshed and Transit Travelshed. Every walk polygon is
now the travel-time contour shape (formerly "Standard", before that "Contour").
This note records what the hull method was, why it was dropped, and how to
bring it back if a future need appears.

**Last commit containing it:** `04ad143` ("Walkshed/Travelshed styling: remove
the Soft edge option"). Everything below can be recovered from that commit with
`git show 04ad143:<path>`.

## What it did

The original walkshed boundary (it was simply "the walkshed" until the shape
work in `docs/archive/walkshed-shape-and-style-plan.md`, then "Classic hull",
then "Simplified"):

1. Flood the street network from the origin up to the largest time budget
   (`runWalkFlood` in `js/core/road-network.js` — this part still exists and is
   unchanged).
2. For each budget, take the coordinates of every reached intersection within
   that budget and wrap them in a **concave hull**:
   `buildWalkshedPolygon(coords, maxEdgeKm, shape)` in `js/core/road-network.js`
   called `turf.concave(points, {maxEdge})`, growing `maxEdge` ×1.8 up to 8 times
   until it returned a polygon, then falling back to `turf.convex`. Fewer than 3
   points became a 30 m buffer.
3. **Hole fill** (added late): interior holes smaller than "Fill holes smaller
   than (acres)" (default 10) were removed with `WalkShape.fillHoles`, so a block
   missing its streets was filled while a lake stayed.

Settings and UI that went with it:

- "Hull detail — max edge (ft)" (default 984 ft = 0.3 km) in Advanced Settings
  of both panels (`#wsMaxEdge`, `#tsMaxEdge`), stored as Walkshed
  `_settings.maxEdge` (km) and Transit Travelshed `_settings.maxEdgeKm`, saved
  in each module's session state and part of the Walkshed cache key.
- A "Boundary shape" dropdown (`#wsShapeMethod`, `#tsShapeMethod`) choosing
  Standard or Simplified, stored as `App.networkSettings.walkShape.method`.
- `App.polygonizeNodeSet(coords, maxEdgeKm, shape)`: the hull exposed for
  Transit Travelshed.
- Transit Travelshed built each band as a **union of per-cluster hulls**: one
  hull for the origin's access walk plus one for each alighting stop's egress
  walk (`App.polygonizeNodeSet` per cluster, `App.foldAnalysisUnion` per band,
  then hole fill). A single hull over all reached nodes would have
  shrink-wrapped the unreachable gaps between clusters; the per-cluster union
  could not.

An intermediate "Smoothed" variant (hull + buffer-out/in rounding + Chaikin
smoothing) existed briefly and was removed first, because at real viewing
zooms it looked the same as the plain hull.

## Why it was removed

- **The contour shape looks better.** On real networks the contour edge (which
  runs partway down the last block, plus a 330 ft off-street reach, rounded at
  330 ft) read as a clean service area; the hull's straight chords and sharp
  corners did not.
- **The hull was slower where it mattered.** In a real-world test with 10
  points on downtown Denver streets, the contour shape finished in about
  5 seconds and the hull in about 30 seconds. The hull's cost grows with the
  number of reached intersections (measured on synthetic grids: ~50 ms at 400
  intersections, ~410 ms at 6,400 — about 60 ms per 1,000, mostly merging the
  kept Delaunay triangles), and dense OpenStreetMap downtown data has a node at
  every crosswalk, sidewalk branch and alley, so a 30-minute walk reaches tens
  of thousands. The contour shape's cost grows with walk *area* (grid cells),
  not intersection count.
- One method means no shape picker, no Hull detail field, simpler cache keys
  and less code to maintain.

Trade-off accepted: contour areas are larger than hull areas (about +15–25% on
the synthetic test grid for walksheds, ~1.5× on a stop-heavy test travelshed,
where the hull drew each stop's short egress walk as a separate small shape).

## Where it could still win

Sparse suburban or rural networks with long walk times: few intersections (cheap
hull) but a large area (more contour grid cells). This was expected from how the
two scale, not measured.

## How to restore it

1. `git show 04ad143:js/core/road-network.js` — copy back `buildWalkshedPolygon`
   and `refineHull`, the hull branch in `computeWalkshed` (`bandPolygon`), and
   the `App.polygonizeNodeSet` export.
2. `js/core/network-connectors.js` at that commit — `SHAPE_METHODS`, the
   `method` field in `walkShapeFor` / `walkShapeSignature` / `setWalkShape`, and
   the select handling in `syncWalkShapeInputs` / `wireWalkShapeInputs`.
3. `js/projects/walkshed.js` and `js/projects/transit-travelshed.js` —
   `maxEdge` / `maxEdgeKm` settings, inputs and persistence; Transit
   Travelshed's per-cluster hull loop.
4. `projects/walkshed-popup.html` and `projects/transit-travelshed-popup.html`
   — the Boundary shape select with its ⓘ text, the Hull detail field, and the
   `data-shape-for` / `data-shape-method` visibility tags.
5. Tests at that commit: `test/browser/walkshed-shape.test.mjs` (hole fill on
   the hull, Standard ↔ Simplified comparison) and the Simplified checks in
   `test/browser/walkshed-contour.test.mjs`.

If restoring for speed on dense networks, thin the reached intersections first
(e.g. one per ~100 ft cell) before hulling; the 984 ft max edge already ignores
detail finer than that, so the outline should not change visibly.
