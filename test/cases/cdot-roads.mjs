// Golden cases for the pure CDOT road engine (window.CdotRoads, js/core/cdot-roads.js).
// No deps: the engine touches no geometry library, DOM or app state, so it loads in
// the vm sandbox. Fixtures in test/fixtures/cdot/ are trimmed from real responses of
// the CDOT FeatureServer, fetched 2026-11-16 with the query URLs of pageUrl (the
// resultRecordCount and where clause shown per file):
//   page14-1.json  layer 14, Denver box -105.015,39.740,-104.995,39.755, offset 0,
//                  resultRecordCount 3 (the first three features; server flag kept).
//   page14-2.json  layer 14, same box, offset 88, resultRecordCount 3 (the last two
//                  features, no flag). The first feature is a copy of page14-1's
//                  first feature (OBJECTID 54875) to exercise the duplicate rule.
//   page17-1.json  layer 17, Denver box, offset 0, resultRecordCount 2000 (216
//                  features, no flag): classes 3 (OBJECTID 210) and 4 (OBJECTID 5050).
//                  Class 2 is not in that box; it is from layer 17, box
//                  -105.20,39.60,-104.80,39.95, where FUNCCLASSID LIKE '2%' (OBJECTID 176).
//   page7-1.json   layer 7, box -105.60,39.70,-105.50,39.76, where ACCESS_ LIKE 'F-W%',
//                  resultRecordCount 2000 (79 features, no flag): OBJECTID 5377 is the
//                  F-W interstate. The second feature (OBJECTID 48706, ACCESS_ R-A) is
//                  from layer 7, box -105.84,39.93,-105.80,39.96 (Fraser), 29 features, no flag.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cdot");
const readJson = (rel) => JSON.parse(readFileSync(join(FIXTURE, rel), "utf8"));

const DENVER = [-105.015, 39.74, -104.995, 39.755];

const page14a = readJson("page14-1.json");
const page14b = readJson("page14-2.json");
const page17 = readJson("page17-1.json");
const page7 = readJson("page7-1.json");

// A copy of page 14-1 with one coordinate in EPSG:26913 metres (the server ignored outSR).
const badCoordPage = JSON.parse(JSON.stringify(page14a));
badCoordPage.features[0].geometry.coordinates[0] = [500000, 4400000];

// A copy of page 14-1 whose first feature is a MultiLineString with the same line inside.
const multiPage = JSON.parse(JSON.stringify(page14a));
multiPage.features[0].geometry = {
  type: "MultiLineString",
  coordinates: [page14a.features[0].geometry.coordinates],
};

// The flagged page only under properties, with no top-level key.
const flagUnderProperties = { type: "FeatureCollection", features: [], properties: { exceededTransferLimit: true } };

export default {
  scripts: ["js/core/cdot-roads.js"],
  cases: [
    // ---- pageUrl ------------------------------------------------------------
    { id: "page-url-14-offset-0", call: "CdotRoads.pageUrl", args: [14, DENVER, 0] },
    { id: "page-url-14-offset-2000", call: "CdotRoads.pageUrl", args: [14, DENVER, 2000] },
    { id: "page-url-throws-layer-99", call: "CdotRoads._test.pageUrlError", args: [99, DENVER, 0] },
    { id: "page-url-throws-bbox-3", call: "CdotRoads._test.pageUrlError", args: [14, [1, 2, 3], 0] },
    { id: "page-url-valid-no-error", call: "CdotRoads._test.pageUrlError", args: [14, DENVER, 0] },

    // ---- hasMore ------------------------------------------------------------
    { id: "has-more-flagged-page", call: "CdotRoads.hasMore", args: [page14a] },
    { id: "has-more-last-page", call: "CdotRoads.hasMore", args: [page14b] },
    { id: "has-more-under-properties", call: "CdotRoads.hasMore", args: [flagUnderProperties] },
    { id: "has-more-null", call: "CdotRoads.hasMore", args: [null] },

    // ---- validatePage -------------------------------------------------------
    { id: "validate-page-14a-ok", call: "CdotRoads.validatePage", args: [page14a] },
    { id: "validate-page-metre-coordinate", call: "CdotRoads.validatePage", args: [badCoordPage] },
    { id: "validate-page-multiline-ok", call: "CdotRoads.validatePage", args: [multiPage] },
    { id: "validate-page-null", call: "CdotRoads.validatePage", args: [null] },

    // ---- classify: layer 14 -------------------------------------------------
    { id: "classify-14-local", call: "CdotRoads.classify", args: [14, { FUNCCLASSID: "7  Local" }] },
    { id: "classify-14-empty-object", call: "CdotRoads.classify", args: [14, {}] },
    { id: "classify-14-null-properties", call: "CdotRoads.classify", args: [14, null] },

    // ---- classify: layer 17 -------------------------------------------------
    { id: "classify-17-class-2", call: "CdotRoads.classify", args: [17, { FUNCCLASSID: "2  Principal Arterial - Fwys and Expwys" }] },
    { id: "classify-17-class-3", call: "CdotRoads.classify", args: [17, { FUNCCLASSID: "3  Principal Arterial - Other" }] },
    { id: "classify-17-class-4", call: "CdotRoads.classify", args: [17, { FUNCCLASSID: "4  Minor Arterial" }] },
    { id: "classify-17-class-5", call: "CdotRoads.classify", args: [17, { FUNCCLASSID: "5  Major Collector" }] },
    { id: "classify-17-class-6", call: "CdotRoads.classify", args: [17, { FUNCCLASSID: "6  Minor Collector" }] },

    // ---- classify: layer 7 -------------------------------------------------
    {
      id: "classify-7-access-fw-wins",
      call: "CdotRoads.classify",
      args: [7, { FUNCCLASS: "3  Principal Arterial - Other", ACCESS_: "F-W: Interstate System, Freeway Facils" }],
    },
    { id: "classify-7-interstate", call: "CdotRoads.classify", args: [7, { FUNCCLASS: "1  Interstate", ACCESS_: "" }] },
    {
      id: "classify-7-rural-highway",
      call: "CdotRoads.classify",
      args: [7, { FUNCCLASS: "3  Principal Arterial - Other", ACCESS_: "R-B: Rural Highway" }],
    },
    {
      id: "classify-7-access-ex-wins",
      call: "CdotRoads.classify",
      args: [7, { FUNCCLASS: "7  Local", ACCESS_: "E-X: Expressway, Major Bypass" }],
    },
    {
      id: "classify-7-fwys-class-2",
      call: "CdotRoads.classify",
      args: [7, { FUNCCLASS: "2  Principal Arterial - Fwys and Expwys" }],
    },
    { id: "classify-7-unknown-class", call: "CdotRoads.classify", args: [7, { FUNCCLASS: "9 x" }] },

    // ---- toRoadGeoJSON ------------------------------------------------------
    {
      id: "to-geojson-merged-dedupe",
      call: "CdotRoads.toRoadGeoJSON",
      args: [[
        { layerId: 14, features: [...page14a.features, ...page14b.features] },
        { layerId: 17, features: page17.features },
      ]],
    },
    { id: "to-geojson-string-input", call: "CdotRoads.toRoadGeoJSON", args: ["x"] },
    { id: "to-geojson-empty-layer-key", call: "CdotRoads.toRoadGeoJSON", args: [[{ layerId: 7, features: [] }]] },
    {
      id: "to-geojson-skips-invalid",
      call: "CdotRoads.toRoadGeoJSON",
      args: [[{
        layerId: 14,
        features: [
          { type: "Feature", geometry: null, properties: { OBJECTID: 1 } },
          { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: {} },
        ],
      }]],
    },
    { id: "to-geojson-layer-7-features", call: "CdotRoads.toRoadGeoJSON", args: [[{ layerId: 7, features: page7.features }]] },
  ],
};
