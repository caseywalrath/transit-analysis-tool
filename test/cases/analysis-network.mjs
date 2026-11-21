// Golden cases for the analysis network engine (window.AnalysisNetwork). Pure and App-free, so it loads
// with the GTFS schedule engine alone. Mini-feed and proposal values were worked out by hand in
// test/fixtures/gtfs/mini/EXPECTED.md ("Analysis network (A6)"); the comment above each case says what
// that file requires.
import { readFileSync, readdirSync } from "node:fs";
const DIR = new URL("../fixtures/gtfs/mini/", import.meta.url);
const MINI = {};
for (const f of readdirSync(DIR)) if (f.endsWith(".txt")) MINI[f] = readFileSync(new URL(f, DIR), "utf8");

const D1 = "20260112";
const EV = "AnalysisNetwork.evaluate";
const net = (fn, ...args) => ({ call: EV, args: [MINI, fn, args] });
const cases = [];
const add = (id, spec) => cases.push({ id, ...spec });
const band = (from, to, frequency) => ({ from, to, frequency });

// ---- bandTrips ------------------------------------------------------------
// EXPECTED: starts 420, 440, 460; end = start + runtime.
add("a6-net-band-plain", { call: "AnalysisNetwork.bandTrips", args: [[band("07:00", "08:00", "20")], 15] });
// EXPECTED: 22:00 to 02:00 wraps to 1560: starts 1320, 1440.
add("a6-net-band-wrap", { call: "AnalysisNetwork.bandTrips", args: [[band("22:00", "02:00", "120")], 30] });
// EXPECTED: no service.
add("a6-net-band-headway-0", { call: "AnalysisNetwork.bandTrips", args: [[band("07:00", "08:00", "0")], 15] });
// EXPECTED: clamps to 1 min, 60 trips.
add("a6-net-band-headway-half", { call: "AnalysisNetwork.bandTrips", args: [[band("07:00", "08:00", "0.5")], 15] });

// ---- stopTimesAlong -------------------------------------------------------
// EXPECTED: [25200, 25800, 26400].
add("a6-net-along-normal", { call: "AnalysisNetwork.stopTimesAlong", args: [420, 20, [0, 1, 2], 2] });
// EXPECTED: by index, same three values.
add("a6-net-along-length-0", { call: "AnalysisNetwork.stopTimesAlong", args: [420, 20, [0, 1, 2], 0] });
// EXPECTED: [25200].
add("a6-net-along-one-stop", { call: "AnalysisNetwork.stopTimesAlong", args: [420, 20, [0.5], 0] });

// ---- proposalTrips --------------------------------------------------------
const STOPS3 = [{ id: "A", distMi: 0 }, { id: "B", distMi: 1 }, { id: "C", distMi: 2 }];
const pattern = (extra) => ({
  id: "pat1", directionId: "", both: false, runtimeMin: 20, lengthMi: 2, stops: STOPS3,
  bands: { weekday: [band("07:00", "09:00", "30")], saturday: [], sunday: [] }, ...extra,
});
// EXPECTED: 4 trips (420, 450, 480, 510), times in the EXPECTED table.
add("a6-net-prop-weekday", { call: "AnalysisNetwork.proposalTrips", args: [{ key: "P", patterns: [pattern({})] }, "weekday"] });
// EXPECTED: 8 trips; the 07:00 return trip is C 25200, B 25800, A 26400, direction "1".
add("a6-net-prop-both", { call: "AnalysisNetwork.proposalTrips", args: [{ key: "P", patterns: [pattern({ both: true })] }, "weekday"] });
add("a6-net-prop-no-stops", { call: "AnalysisNetwork.proposalTrips", args: [{ key: "P", patterns: [pattern({ stops: [] })] }, "weekday"] });
// EXPECTED: no Sunday bands, no trips.
add("a6-net-prop-sunday-no-bands", { call: "AnalysisNetwork.proposalTrips", args: [{ key: "P", patterns: [pattern({})] }, "sunday"] });

// ---- modeOf ---------------------------------------------------------------
for (const [k, v] of [["3", 3], ["string-1", "1"], ["12", 12], ["blank", ""]])
  add("a6-net-mode-" + k, { call: "AnalysisNetwork.modeOf", args: [v] });

// ---- build ----------------------------------------------------------------
const PROPOSAL = {
  key: "P", name: "Drawn Line", mode: "bus", color: "#112233",
  stops: [{ id: "A", name: "Stop A", lat: 39.7, lon: -105.0 }, { id: "B", name: "Stop B", lat: 39.71, lon: -105.0 },
    { id: "C", name: "Stop C", lat: 39.72, lon: -105.0 }],
  patterns: [pattern({})],
};
// EXPECTED: 25 trips, 6 stops g:F2 g:P1 g:R2 g:S1 g:S2 g:S3, 0 dropped rows, first trip g:F1_W_FREQ@06:00:00.
add("a6-net-build-d1", net("build", { date: D1, routeIds: null, proposals: [] }));
// EXPECTED: 5 trips, stops S1 S2 S3.
add("a6-net-build-b1", net("build", { date: D1, routeIds: ["B1"], proposals: [] }));
// EXPECTED: 29 trips, 9 stops, routes d:P g:B1 g:F1 g:R1.
add("a6-net-build-d1-proposal", net("build", { date: D1, routeIds: null, proposals: [PROPOSAL] }));
// EXPECTED: 4 trips on stops d:A d:B d:C.
add("a6-net-build-proposals-only", { call: "AnalysisNetwork.build", args: [{ feed: null, date: D1, routeIds: null, proposals: [PROPOSAL] }] });
// EXPECTED: sunday, nothing.
add("a6-net-build-unknown-date", net("build", { date: "20260301", routeIds: null, proposals: [] }));
add("a6-net-build-empty", { call: "AnalysisNetwork.build", args: [null] });

// ---- stopService ----------------------------------------------------------
// EXPECTED: g:P1, g:R2, g:S1 (21 trips, peak 900), g:S2 (5), g:S3 (2); see EXPECTED.md.
add("a6-net-service-d1", net("stopService", { date: D1, routeIds: null, proposals: [] }));
// EXPECTED: checked 4, mismatches [].
add("a6-net-service-invariant-d1", net("stopServiceInvariant", { date: D1, routeIds: null }));
add("a6-net-service-invariant-d3", net("stopServiceInvariant", { date: "20260124", routeIds: null }));
add("a6-net-service-empty", { call: "AnalysisNetwork.stopService", args: [null] });

export default { scripts: ["js/core/gtfs-schedule.js", "js/core/analysis-network.js"], cases };
