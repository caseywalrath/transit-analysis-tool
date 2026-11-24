// Golden cases for the GTFS export engine (window.GtfsExport). The engine reads window.AnalysisNetwork
// at call time, so the three scripts below load into the vm sandbox together. Cases call through
// GtfsExport.evaluate, which returns the build result or { error }. Every EXPECTED comment was worked
// out by hand from the fixture and the export rules; the golden file must match those values.

const AG = { name: "Test Transit", url: "https://example.org", timezone: "America/Denver" };

const SHAPE = [[-105, 39.7], [-105, 39.72], [-105, 39.72], [-105, 39.74]];

const STOPS = [
  { id: "s1", name: "First & Main", lat: 39.7, lon: -105 },
  { id: "s2", name: "", lat: 39.72, lon: -105 },
  { id: "s3", name: 'Elm, "North"', lat: 39.74, lon: -105 },
];

const PAT = {
  id: "0",
  directionId: "0",
  both: true,
  runtimeMin: 20,
  lengthMi: 2,
  stops: [{ id: "s1", distMi: 0 }, { id: "s2", distMi: 1 }, { id: "s3", distMi: 2 }],
  shape: SHAPE,
  bands: {
    weekday: [{ from: "06:00", to: "07:00", frequency: "20" }],
    saturday: [{ from: "08:00", to: "08:30", frequency: "30" }],
    sunday: [],
  },
};

const R1 = {
  routeId: "R1",
  shortName: "1",
  longName: "Main St",
  routeType: 3,
  color: "#0055AA",
  proposal: { key: "R1", stops: STOPS, patterns: [PAT] },
};

const BASE = { agency: AG, startDate: "20270101", endDate: "20271231", frequencies: true, routes: [R1] };

// BASE with the given top-level fields replaced.
function inputWith(patch) {
  return { ...BASE, ...patch };
}

// R1 with its only pattern changed by patch.
function r1With(patch) {
  return { ...R1, proposal: { ...R1.proposal, patterns: [{ ...PAT, ...patch }] } };
}

// A pattern with the given weekday bands and no bands on the other days.
function weekdayOnly(bands) {
  return { weekday: bands, saturday: [], sunday: [] };
}

// Second Service: R1 renamed, with every band empty, so it has no trips.
const R2 = {
  ...R1,
  routeId: "R2",
  shortName: "",
  longName: "Ghost",
  proposal: { ...R1.proposal, patterns: [{ ...PAT, bands: { weekday: [], saturday: [], sunday: [] } }] },
};

export default {
  scripts: ["js/core/gtfs-schedule.js", "js/core/analysis-network.js", "js/core/gtfs-export.js"],
  cases: [
    // EXPECTED counts {routes 1, stops 3, trips 4, tripsRepresented 8, stopTimes 12, shapes 2, frequencies 2},
    // warnings []. Files in order: agency, stops, routes, trips, stop_times, calendar, shapes, frequencies, feed_info.
    // trips.txt: R1,WK,R1-WK-0-0-21600,0,R1-0 / R1,WK,R1-WK-0-1-21600,1,R1-0-r / R1,SA,R1-SA-0-0-28800,0,R1-0 /
    // R1,SA,R1-SA-0-1-28800,1,R1-0-r.
    // stop_times for R1-WK-0-0-21600: 06:00:00 s1 1 1, 06:10:00 s2 2 0, 06:20:00 s3 3 1; for R1-WK-0-1-21600:
    // s3, s2, s1 at the same three times.
    // frequencies.txt: R1-WK-0-0-21600,06:00:00,07:00:00,1200,1 and R1-WK-0-1-21600,06:00:00,07:00:00,1200,1.
    // routes.txt row R1,A1,1,Main St,3,0055AA,FFFFFF.
    // stops.txt: s1,First & Main,39.700000,-105.000000 / s2,Stop 1,39.720000,... / s3,"Elm, ""North""",39.740000,...
    // calendar: WK,1,1,1,1,1,0,0,20270101,20271231 and SA,0,0,0,0,0,1,0,20270101,20271231.
    // shapes: R1-0 at 39.700000/39.720000/39.740000 seq 1-3; R1-0-r reversed.
    // feed_info row Test Transit,https://example.org,en,20270101,20271231,
    { id: "freq-on", call: "GtfsExport.evaluate", args: [BASE] },

    // EXPECTED counts trips 8, tripsRepresented 8, stopTimes 24, frequencies 0; no frequencies.txt;
    // WK trips start 21600, 22800, 24000 in each direction.
    { id: "freq-off", call: "GtfsExport.evaluate", args: [inputWith({ frequencies: false })] },

    // EXPECTED one frequencies row per direction: ...,23:30:00,24:30:00,1800,1; template stop times end 23:50:00;
    // calendar only WK.
    {
      id: "wrap",
      call: "GtfsExport.evaluate",
      args: [inputWith({ routes: [r1With({ bands: weekdayOnly([{ from: "23:30", to: "00:30", frequency: 30 }]) })] })],
    },

    // EXPECTED trips.txt includes R1-WK-0-0-21600 and R1-WK-0-0-21600-2.
    {
      id: "dup-ids",
      call: "GtfsExport.evaluate",
      args: [inputWith({
        frequencies: false,
        routes: [r1With({ bands: weekdayOnly([
          { from: "06:00", to: "07:00", frequency: "20" },
          { from: "06:00", to: "06:30", frequency: "30" },
        ]) })],
      })],
    },

    // EXPECTED frequencies 0 (7.123 min is 427.38 s, not whole); tripsRepresented 18 (9 per direction), trips 18.
    {
      id: "non-whole-headway",
      call: "GtfsExport.evaluate",
      args: [inputWith({ routes: [r1With({ bands: weekdayOnly([{ from: "06:00", to: "07:00", frequency: "7.123" }]) })] })],
    },

    // EXPECTED frequencies 2, trips 2, tripsRepresented 16, headway 450, end_time 07:00:00.
    {
      id: "half-minute",
      call: "GtfsExport.evaluate",
      args: [inputWith({ routes: [r1With({ bands: weekdayOnly([{ from: "06:00", to: "07:00", frequency: "7.5" }]) })] })],
    },

    // EXPECTED warning exactly once: Service "R1" pattern 0 has no line shape.; shape_id blank on all trips;
    // no shapes.txt.
    { id: "no-shape", call: "GtfsExport.evaluate", args: [inputWith({ routes: [r1With({ shape: [[-105, 39.7]] })] })] },

    // EXPECTED trips 2 (one WK template and one SA trip), all direction_id 1, shape R1-0 (no -r, because both is
    // false); the WK trip is R1-WK-0-1-21600 with stops s1, s2, s3.
    { id: "one-way", call: "GtfsExport.evaluate", args: [inputWith({ routes: [r1With({ both: false, directionId: "1" })] })] },

    // EXPECTED warning Service "Ghost" has no trips in its headway bands and was left out.;
    // routes.txt has 1 row (R1 only).
    { id: "empty-route", call: "GtfsExport.evaluate", args: [inputWith({ routes: [R1, R2] })] },

    // EXPECTED {error: "No trips to export: the selected Services have no headway bands with service."}.
    { id: "all-empty", call: "GtfsExport.evaluate", args: [inputWith({ routes: [R2] })] },

    // EXPECTED {error: "Enter the agency name."}.
    { id: "err-name", call: "GtfsExport.evaluate", args: [inputWith({ agency: { ...AG, name: "" } })] },

    // EXPECTED {error: "Agency URL must start with http:// or https://."}.
    { id: "err-url", call: "GtfsExport.evaluate", args: [inputWith({ agency: { ...AG, url: "example.org" } })] },

    // EXPECTED {error: "Enter a time zone such as America/Denver."}.
    { id: "err-tz", call: "GtfsExport.evaluate", args: [inputWith({ agency: { ...AG, timezone: "Denver" } })] },

    // EXPECTED {error: "Enter start and end dates."} (February 30 does not exist).
    { id: "err-date", call: "GtfsExport.evaluate", args: [inputWith({ startDate: "20270230" })] },

    // EXPECTED {error: "The end date is before the start date."}.
    { id: "err-order", call: "GtfsExport.evaluate", args: [inputWith({ startDate: "20271231", endDate: "20270101" })] },

    // EXPECTED {error: "Choose at least one Service."}.
    { id: "err-routes", call: "GtfsExport.evaluate", args: [inputWith({ routes: [] })] },

    // EXPECTED {error: 'Stop "s2" has no location.'}.
    {
      id: "no-stop-location",
      call: "GtfsExport.evaluate",
      args: [inputWith({
        routes: [{ ...R1, proposal: { ...R1.proposal, stops: STOPS.map((s) => (s.id === "s2" ? { ...s, lat: null } : s)) } }],
      })],
    },

    // EXPECTED route_color FFD700 and route_text_color 000000 (the bright color takes black text).
    { id: "color-light", call: "GtfsExport.evaluate", args: [inputWith({ routes: [{ ...R1, color: "ffd700" }] })] },

    // EXPECTED route_color and route_text_color both blank ("blue" is not six hex digits).
    { id: "color-bad", call: "GtfsExport.evaluate", args: [inputWith({ routes: [{ ...R1, color: "blue" }] })] },
  ],
};
