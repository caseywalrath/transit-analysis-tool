// Golden cases for the pure GTFS route-browser helpers (App.gtfsBrowse in
// js/projects/gtfs.js — docs/archive/gtfs-route-browser-plan.md Phase 1). No DOM/map/turf.

const line = (x0, n) => ({ type: "LineString", coordinates: Array.from({ length: n }, (_, i) => [-104.8 + x0 + i * 0.01, 38.8]) });
const shape = (id, x0, n, extra) => ({ type: "Feature", properties: Object.assign({ shape_id: id }, extra || {}), geometry: line(x0, n) });
const FC = { type: "FeatureCollection", features: [
  shape("177198", 0, 6), shape("177198_A", 0, 4), shape("177202", 0, 5),
  shape("B1", 0, 3), shape("X10", 0, 2), shape("X2", 0, 2), shape("orphan", 0, 4), shape("tie_short", 0, 3), shape("tie_long", 0, 5)
] };
const trip = (route_id, shape_id, h) => ({ route_id, shape_id, trip_headsign: h || "" });
const TRIPS = [
  trip("red", "177198", "Downtown"), trip("red", "177198", "Downtown"), trip("red", "177198", "Mall"),
  trip("red", "177198_A", "Downtown"), trip("red", "177202", "Loop"), trip("red", "177202", "Loop"), trip("red", "177202", "Loop"),
  trip("red", "177202", "Loop"),
  trip("blue", "B1", ""), trip("blue", "tie_short", "S"), trip("blue", "tie_long", "L"),
  trip("x10", "X10", ""), trip("x2", "X2", ""),
  trip("red", "missing_shape", ""), trip("ghost", "orphan", "G"), trip("", "orphan", "")
];
const ROUTES = [
  { route_id: "red", route_short_name: "Red", route_long_name: "Red Circulator", route_type: "3", route_color: "FF0000", agency_id: "A" },
  { route_id: "blue", route_short_name: "", route_long_name: "Blue Line", route_type: "3", route_color: "ffffff" },
  { route_id: "x10", route_short_name: "10", route_long_name: "Ten" },
  { route_id: "x2", route_short_name: "2", route_long_name: "Two" },
  { route_id: "nodraw", route_short_name: "0", route_long_name: "No shapes" }
];
const IDX = ["App.gtfsBrowse.buildRouteIndex", [FC, TRIPS, ROUTES]];

export default {
  scripts: ["js/projects/gtfs.js"],
  cases: [
    { id: "natural/2-lt-10", call: "App.gtfsBrowse.naturalCompare", args: ["2", "10"] },
    { id: "natural/10-gt-2", call: "App.gtfsBrowse.naturalCompare", args: ["10", "2"] },
    { id: "natural/case-insensitive-equal", call: "App.gtfsBrowse.naturalCompare", args: ["Red", "red"] },
    { id: "natural/A2-lt-A10", call: "App.gtfsBrowse.naturalCompare", args: ["A2", "A10"] },
    { id: "natural/prefix-shorter-first", call: "App.gtfsBrowse.naturalCompare", args: ["Red", "Red2"] },
    { id: "natural/null-first", call: "App.gtfsBrowse.naturalCompare", args: [null, "a"] },

    { id: "index/full", call: IDX[0], args: IDX[1] },
    { id: "index/no-trips-all-unassigned", call: IDX[0], args: [FC, [], ROUTES] },
    { id: "index/empty", call: IDX[0], args: [{ type: "FeatureCollection", features: [] }, [], []] },
    { id: "index/null-inputs", call: IDX[0], args: [null, null, null] },

    { id: "filter/blank-returns-all-ids", call: "App.gtfsBrowse.filterRoutes", args: [[{ route_id: "a", short: "A", long: "", shapes: [] }], "  "] },
    { id: "filter/by-short-name", call: "App.gtfsBrowse.filterRoutes", args: [[
        { route_id: "r1", short: "Red", long: "Circulator", shapes: [] }, { route_id: "r2", short: "Blue", long: "", shapes: [] }], "red"] },
    { id: "filter/by-long-name", call: "App.gtfsBrowse.filterRoutes", args: [[
        { route_id: "r1", short: "Red", long: "Circulator", shapes: [] }, { route_id: "r2", short: "Blue", long: "", shapes: [] }], "CIRC"] },
    { id: "filter/by-route-id", call: "App.gtfsBrowse.filterRoutes", args: [[
        { route_id: "r1", short: "Red", long: "", shapes: [] }, { route_id: "r2", short: "Blue", long: "", shapes: [] }], "r2"] },
    { id: "filter/by-shape-id", call: "App.gtfsBrowse.filterRoutes", args: [[
        { route_id: "r1", short: "Red", long: "", shapes: [{ shape_id: "177198_A" }] }, { route_id: "r2", short: "Blue", long: "", shapes: [{ shape_id: "B1" }] }], "177198"] },
    { id: "filter/no-match", call: "App.gtfsBrowse.filterRoutes", args: [[{ route_id: "r1", short: "Red", long: "", shapes: [] }], "zzz"] },

    { id: "rep/most-trips", call: "App.gtfsBrowse.representativeShape", args: [{ shapes: [
        { shape_id: "a", tripCount: 2, lengthMi: 9 }, { shape_id: "b", tripCount: 5, lengthMi: 1 }] }] },
    { id: "rep/tie-longest", call: "App.gtfsBrowse.representativeShape", args: [{ shapes: [
        { shape_id: "a", tripCount: 3, lengthMi: 1 }, { shape_id: "b", tripCount: 3, lengthMi: 4 }, { shape_id: "c", tripCount: 3, lengthMi: 2 }] }] },
    { id: "rep/all-zero-trips-longest", call: "App.gtfsBrowse.representativeShape", args: [{ shapes: [
        { shape_id: "a", tripCount: 0, lengthMi: 1 }, { shape_id: "b", tripCount: 0, lengthMi: 4 }] }] },
    { id: "rep/no-shapes", call: "App.gtfsBrowse.representativeShape", args: [{ shapes: [] }] },

    { id: "filterexpr/nothing-hidden", call: "App.gtfsBrowse.buildVisibilityFilter", args: [[], []] },
    { id: "filterexpr/null-inputs", call: "App.gtfsBrowse.buildVisibilityFilter", args: [null, null] },
    { id: "filterexpr/routes-only", call: "App.gtfsBrowse.buildVisibilityFilter", args: [["red", "blue"], []] },
    { id: "filterexpr/shapes-only", call: "App.gtfsBrowse.buildVisibilityFilter", args: [{}, { "177198": true, B1: false }] },
    { id: "filterexpr/both", call: "App.gtfsBrowse.buildVisibilityFilter", args: [["red"], ["B1"]] },
    { id: "filterexpr/unassigned-route", call: "App.gtfsBrowse.buildVisibilityFilter", args: [["__unassigned__"], []] },
    // --- Phase 3: grouped-Service copy helpers ---
    { id: "dirs/agree-mixed-missing", call: "App.gtfsBrowse.shapeDirections", args: [[
      { route_id: "red", shape_id: "a", direction_id: "0" }, { route_id: "red", shape_id: "a", direction_id: 0 },
      { route_id: "red", shape_id: "b", direction_id: "1" },
      { route_id: "red", shape_id: "c", direction_id: "0" }, { route_id: "red", shape_id: "c", direction_id: "1" },
      { route_id: "red", shape_id: "d" },
      { route_id: "red", shape_id: "e", direction_id: "1" }, { route_id: "red", shape_id: "e", direction_id: "" },
      { route_id: "blue", shape_id: "a", direction_id: "1" }
    ], "red"] },
    { id: "serviceid/free", call: "App.gtfsBrowse.uniqueServiceId", args: ["Red", ["Blue"]] },
    { id: "serviceid/taken", call: "App.gtfsBrowse.uniqueServiceId", args: ["Red", ["Red", "Red (2)", " Blue "]] },
    // --- stop-selection plan Phase 1: App.gtfsStopList ---
    { id: "stoplist/parse-header", call: "App.gtfsStopList.parseStopIdList", args: ["stop_id,stop_name\n100,Main\n200,Oak\n"] },
    { id: "stoplist/parse-header-mixed-case-column-2", call: "App.gtfsStopList.parseStopIdList", args: ["name,Stop_ID\r\nMain,100\r\nOak,200"] },
    { id: "stoplist/parse-bom", call: "App.gtfsStopList.parseStopIdList", args: ["\uFEFFstop_id\n7\n8"] },
    { id: "stoplist/parse-quoted", call: "App.gtfsStopList.parseStopIdList", args: ["stop_name,stop_id\n\"Main, & 1st\",\"A,1\"\n\"Say \"\"hi\"\"\",\"B\"\"2\"\n"] },
    { id: "stoplist/parse-blanks-dupes", call: "App.gtfsStopList.parseStopIdList", args: ["stop_id\n1\n\n 2 \n1\n,x\n2\n"] },
    { id: "stoplist/parse-headerless", call: "App.gtfsStopList.parseStopIdList", args: ["100\n 200 \n\n100\r\n300"] },
    { id: "stoplist/parse-headerless-comma-first-field", call: "App.gtfsStopList.parseStopIdList", args: ["100,Main\n200,Oak"] },
    { id: "stoplist/parse-empty", call: "App.gtfsStopList.parseStopIdList", args: [""] },
    { id: "stoplist/parse-null", call: "App.gtfsStopList.parseStopIdList", args: [null] },
    { id: "stoplist/reconcile-array", call: "App.gtfsStopList.reconcile", args: [["3", "1", "9", "2"], ["1", "2", "3"]] },
    { id: "stoplist/reconcile-none-in-feed", call: "App.gtfsStopList.reconcile", args: [["a", "b"], []] },
    { id: "stoplist/csv-present-and-missing", call: "App.gtfsStopList.stopListCSV", args: [["9", "2", "1", "8"], [
      { stop_id: "1", stop_code: "C1", stop_name: "Main, \"Old\" & 1st", stop_lat: "38.8", stop_lon: "-104.8", location_type: "0", parent_station: "" },
      { stop_id: "5", stop_name: "Unselected", stop_lat: "1", stop_lon: "2" },
      { stop_id: "2", stop_name: "Oak", stop_lat: "38.9", stop_lon: "-104.9" }
    ], "rtd_a.zip"] },
    { id: "stoplist/csv-all-missing-no-feed-file", call: "App.gtfsStopList.stopListCSV", args: [["x", "y,z"], [], ""] },
    { id: "stoplist/csv-empty-selection", call: "App.gtfsStopList.stopListCSV", args: [[], [{ stop_id: "1" }], "f.zip"] }
  ]
};
