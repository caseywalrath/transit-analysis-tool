// Golden cases for the pure FLM walk-tiles reader (window.WalkTiles).
// No deps: js/core/walk-tiles.js is geometry-library, DOM and app-state free,
// so it loads in the vm sandbox. The fixture release under
// test/fixtures/walk-tiles/fixture-release/ is hand-written: two cells, three
// segments (A in the first cell, B across the shared edge, C in the second),
// plus a third cell far to the east with one segment (D), so a load of two
// distant points has a gap of unloaded cells between them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "walk-tiles",
  "fixture-release"
);
const readJson = (rel) => JSON.parse(readFileSync(join(FIXTURE, rel), "utf8"));

const fixtureManifest = readJson("manifest.json");
const tileA = readJson("network/7499_12975.json");
const tileB = readJson("network/7500_12975.json");
const tileD = readJson("network/7505_12975.json");
const segA = tileA.segments[0];
const segB = tileA.segments[1];
const segC = tileB.segments[1];

const cellA = { col: 7499, row: 12975 };
const cellB = { col: 7500, row: 12975 };

// Two points at opposite ends of the fixture: the first covers cells A and B,
// the second covers cell D, and the cells between them are not touched.
const twoFarBoxes = [
  [-105.0074, 39.7516, -104.9986, 39.7584],
  [-104.9494, 39.7516, -104.9406, 39.7584],
];

// Tile B with its copy of segment B renamed, for the conflict case.
const tileBRenamed = JSON.parse(JSON.stringify(tileB));
tileBRenamed.segments[0].name = "Other";

// Segment A with one field changed or removed, for the record-level cases.
const segANoHwy = { ...segA };
delete segANoHwy.hwy;

export default {
  scripts: ["js/core/walk-tiles.js"],
  cases: [
    // ---- cellOf -------------------------------------------------------------
    { id: "cell-of-inside", call: "WalkTiles.cellOf", args: [-105.005, 39.755] },
    { id: "cell-of-origin", call: "WalkTiles.cellOf", args: [-180, -90] },
    { id: "cell-of-max-clamped", call: "WalkTiles.cellOf", args: [180, 90] },
    // JSON cannot carry NaN reliably, so a non-number stands in for it.
    { id: "cell-of-nan-null", call: "WalkTiles.cellOf", args: ["x", 39.755] },

    // ---- cellsForBbox -------------------------------------------------------
    {
      id: "cells-bbox-two-cells",
      call: "WalkTiles.cellsForBbox",
      args: [[-105.005, 39.755, -104.995, 39.755]],
    },
    {
      // West edge exactly on the shared boundary: both cells are touched.
      id: "cells-bbox-shared-edge",
      call: "WalkTiles.cellsForBbox",
      args: [[-105.00, 39.755, -105.00, 39.755]],
    },
    {
      // South edge exactly on a row boundary: the row below is touched too.
      id: "cells-bbox-south-edge",
      call: "WalkTiles.cellsForBbox",
      args: [[-105.005, 39.75, -105.005, 39.75]],
    },
    {
      id: "cells-bbox-inverted-empty",
      call: "WalkTiles.cellsForBbox",
      args: [[-104.99, 39.755, -105.00, 39.755]],
    },

    // ---- bboxOfCells --------------------------------------------------------
    {
      id: "bbox-of-cells-two",
      call: "WalkTiles.bboxOfCells",
      args: [[cellA, cellB]],
    },
    { id: "bbox-of-cells-empty-null", call: "WalkTiles.bboxOfCells", args: [[]] },

    // ---- validateManifest ---------------------------------------------------
    { id: "manifest-fixture-ok", call: "WalkTiles.validateManifest", args: [fixtureManifest] },
    {
      id: "manifest-version-1-fails",
      call: "WalkTiles.validateManifest",
      args: [{ ...fixtureManifest, version: 1 }],
    },
    {
      id: "manifest-extra-field-ok",
      call: "WalkTiles.validateManifest",
      args: [{ ...fixtureManifest, extra_unknown: 1 }],
    },
    {
      id: "manifest-missing-tiles-fails",
      call: "WalkTiles.validateManifest",
      args: [(() => { const m = { ...fixtureManifest }; delete m.tiles; return m; })()],
    },
    {
      id: "manifest-empty-tiles-fails",
      call: "WalkTiles.validateManifest",
      args: [{ ...fixtureManifest, tiles: [] }],
    },

    // ---- tilesForCells ------------------------------------------------------
    {
      id: "tiles-for-both-cells",
      call: "WalkTiles.tilesForCells",
      args: [fixtureManifest, [cellA, cellB]],
    },
    {
      id: "tiles-for-outside-cell",
      call: "WalkTiles.tilesForCells",
      args: [fixtureManifest, [{ col: 1, row: 1 }]],
    },

    // ---- mergeTiles ---------------------------------------------------------
    { id: "merge-both-tiles", call: "WalkTiles.mergeTiles", args: [[tileA, tileB]] },
    {
      id: "merge-conflicting-name",
      call: "WalkTiles.mergeTiles",
      args: [[tileA, tileBRenamed]],
    },
    {
      // Same coordinates and fields, different id: both are kept.
      id: "merge-same-coords-different-ids-kept",
      call: "WalkTiles.mergeTiles",
      args: [[{ col: 7499, row: 12975, segments: [segA, { ...segA, id: "way/9/segment/0" }] }]],
    },
    {
      id: "merge-missing-field",
      call: "WalkTiles.mergeTiles",
      args: [[{ col: 7499, row: 12975, segments: [segANoHwy] }]],
    },
    {
      id: "merge-bad-len",
      call: "WalkTiles.mergeTiles",
      args: [[{ col: 7499, row: 12975, segments: [{ ...segA, len_ft: 0 }] }]],
    },

    // ---- toRoadGeoJSON ------------------------------------------------------
    { id: "to-geojson-merged", call: "WalkTiles.toRoadGeoJSON", args: [[segA, segB, segC]] },
    {
      id: "to-geojson-non-integer-way-id",
      call: "WalkTiles.toRoadGeoJSON",
      args: [[{ ...segA, way_id: "abc" }]],
    },
    {
      id: "to-geojson-unsafe-way-id",
      call: "WalkTiles.toRoadGeoJSON",
      args: [[{ ...segA, way_id: "99999999999999999999" }]],
    },

    // ---- cellsForBboxes / cellRectsForBboxes / cellKeys ---------------------
    { id: "cells-bboxes-two-far", call: "WalkTiles.cellsForBboxes", args: [twoFarBoxes] },
    {
      id: "cells-bboxes-overlap-deduped",
      call: "WalkTiles.cellsForBboxes",
      args: [[[-105.005, 39.755, -104.995, 39.755], [-105.005, 39.755, -105.004, 39.755]]],
    },
    {
      id: "cells-bboxes-skips-invalid",
      call: "WalkTiles.cellsForBboxes",
      args: [[["x", 1, 2, 3], [-105.005, 39.755, -105.005, 39.755]]],
    },
    { id: "cells-bboxes-not-array", call: "WalkTiles.cellsForBboxes", args: ["nope"] },
    { id: "cell-rects-two-far", call: "WalkTiles.cellRectsForBboxes", args: [twoFarBoxes] },
    {
      id: "cell-rects-duplicates-removed",
      call: "WalkTiles.cellRectsForBboxes",
      args: [[twoFarBoxes[0], twoFarBoxes[0]]],
    },
    {
      id: "cell-keys",
      call: "WalkTiles.cellKeys",
      args: [[{ col: 7499, row: 12975 }, { col: 7505, row: 12975 }]],
    },
    { id: "cell-keys-not-array", call: "WalkTiles.cellKeys", args: ["nope"] },
    {
      id: "merge-three-tiles",
      call: "WalkTiles.mergeTiles",
      args: [[tileA, tileB, tileD]],
    },
  ],
};
