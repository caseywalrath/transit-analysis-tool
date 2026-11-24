// Golden cases for Transit Coverage's pure helpers. The module delegates all
// geometry/Census/LODES work to turf and the shared census.js/lodes.js
// pipeline (not pure — out of scope for this harness); what's covered here is
// the peak-headway reducer and the formatting/sentence-building helpers that
// live in the module's private closure, exposed under App._tcTest when
// window.__MAT_TEST__ is set (see the hook near _dateStamp in
// js/projects/transit-coverage.js).
//
// service-assembly.js is loaded first so App.getEffectiveServiceBands exists
// before transit-coverage.js's computePeakHeadway calls it — verified safe:
// its top level only assigns functions onto App, no turf/DOM calls at load
// time. Registered module: at load transit-coverage.js calls
// App.registerModule (stubbed no-op) and guards App.cache with an `if`, so
// loading the files alone is enough.

export default {
  scripts: ["js/core/service-assembly.js", "js/projects/transit-coverage.js"],
  cases: [
    // --- computePeakHeadway: min positive frequency across effective bands ---
    {
      id: "peakHeadway/basic-min",
      call: "App._tcTest.computePeakHeadway",
      args: [{ weekday: [{ frequency: 30 }, { frequency: 15 }, { frequency: 60 }] }, "weekday"],
    },
    {
      id: "peakHeadway/skips-zero-negative-nonnumeric",
      call: "App._tcTest.computePeakHeadway",
      args: [{ weekday: [{ frequency: 0 }, { frequency: -5 }, { frequency: "abc" }, { frequency: 20 }] }, "weekday"],
    },
    {
      id: "peakHeadway/sunday-mirrors-saturday",
      call: "App._tcTest.computePeakHeadway",
      args: [{ saturday: [{ frequency: 45 }, { frequency: 60 }], sunday: [], sundayMirrorsSaturday: true }, "sunday"],
    },
    {
      id: "peakHeadway/empty-day",
      call: "App._tcTest.computePeakHeadway",
      args: [{ weekday: [] }, "weekday"],
    },
    {
      id: "peakHeadway/null-service",
      call: "App._tcTest.computePeakHeadway",
      args: [null, "weekday"],
    },

    // --- formatPct: 1-decimal percent, em dash on invalid/zero denominator ---
    { id: "formatPct/normal", call: "App._tcTest.formatPct", args: [50, 200] },
    { id: "formatPct/zero-denominator", call: "App._tcTest.formatPct", args: [50, 0] },
    { id: "formatPct/nan-numerator", call: "App._tcTest.formatPct", args: [Number.NaN, 100] },

    // --- formatCount: rounded + locale-grouped, em dash on non-finite -------
    { id: "formatCount/value", call: "App._tcTest.formatCount", args: [12345.6] },
    { id: "formatCount/nan", call: "App._tcTest.formatCount", args: [Number.NaN] },

    // --- buildStatSentence ---------------------------------------------------
    {
      id: "statSentence/with-threshold",
      call: "App._tcTest.buildStatSentence",
      args: [{
        bufferMiles: 0.25, headwayThreshold: 15,
        popTotal: 1000, popCovered: 600, popThreshold: 300, hasThreshold: true,
      }],
    },
    {
      id: "statSentence/without-threshold",
      call: "App._tcTest.buildStatSentence",
      args: [{ bufferMiles: 0.5, popTotal: 1000, popCovered: 250, hasThreshold: false }],
    },
    {
      id: "statSentence/zero-population",
      call: "App._tcTest.buildStatSentence",
      args: [{ bufferMiles: 0.25, popTotal: 0, popCovered: 0, hasThreshold: false }],
    },

    // --- _csvField: RFC-4180-style quoting -----------------------------------
    { id: "csv/plain", call: "App._tcTest._csvField", args: ["plain"] },
    { id: "csv/has-comma", call: "App._tcTest._csvField", args: ["a,b"] },
    { id: "csv/has-quote", call: "App._tcTest._csvField", args: ['quote"here'] },

    // --- GTFS stop coverage helpers ------------------------------------------
    { id: "gtfsMode/bus", call: "App._tcTest.gtfsRouteMode", args: ["3"] },
    { id: "gtfsMode/tram-number", call: "App._tcTest.gtfsRouteMode", args: [0] },
    { id: "gtfsMode/subway", call: "App._tcTest.gtfsRouteMode", args: ["1"] },
    { id: "gtfsMode/rail", call: "App._tcTest.gtfsRouteMode", args: [" 2 "] },
    { id: "gtfsMode/funicular", call: "App._tcTest.gtfsRouteMode", args: ["7"] },
    { id: "gtfsMode/extended-rail", call: "App._tcTest.gtfsRouteMode", args: ["12"] },
    { id: "gtfsMode/trolleybus-is-bus", call: "App._tcTest.gtfsRouteMode", args: ["11"] },
    { id: "gtfsMode/blank-is-bus", call: "App._tcTest.gtfsRouteMode", args: [""] },
    { id: "gtfsMode/null-is-bus", call: "App._tcTest.gtfsRouteMode", args: [null] },

    {
      // S1 is shared by a bus and a rail route (takes the rail buffer); X has no coordinates and counts
      // toward nothing; the bus route's median over 600/1200/null is 900 s = 15 min; the rail route's
      // even-count median (600, 1200) is 900 s too.
      id: "gtfsPlan/shared-stop-takes-rail",
      call: "App._tcTest.buildGtfsStopPlan",
      args: [[
        { routeId: "B", name: "Bus", mode: "bus", rows: [
          { stopId: "S1", lat: 39.74, lon: -104.99, peakHeadwaySec: 600 },
          { stopId: "S2", lat: 39.75, lon: -104.98, peakHeadwaySec: 1200 },
          { stopId: "S3", lat: 39.76, lon: -104.97, peakHeadwaySec: null },
          { stopId: "X", lat: null, lon: null, peakHeadwaySec: 300 } ] },
        { routeId: "R", name: "Rail", mode: "rail", rows: [
          { stopId: "S1", lat: 39.74, lon: -104.99, peakHeadwaySec: 600 },
          { stopId: "R2", lat: 39.85, lon: -104.67, peakHeadwaySec: 1200 } ] }
      ], 0.25, 0.5],
    },
    { id: "gtfsPlan/empty", call: "App._tcTest.buildGtfsStopPlan", args: [[], 0.25, 0.5] },
    {
      id: "gtfsPlan/route-with-no-rows",
      call: "App._tcTest.buildGtfsStopPlan",
      args: [[{ routeId: "Z", name: "Z", mode: "bus", rows: [] }], 0.3, 0.6],
    },

    {
      id: "gtfsQualify/threshold-15",
      call: "App._tcTest.gtfsQualifyingStopIds",
      args: [[
        { stopId: "b", peakHeadwaySec: 900 }, { stopId: "a", peakHeadwaySec: 899 },
        { stopId: "c", peakHeadwaySec: 901 }, { stopId: "d", peakHeadwaySec: null }
      ], 15],
    },
    { id: "gtfsQualify/no-threshold", call: "App._tcTest.gtfsQualifyingStopIds", args: [[{ stopId: "a", peakHeadwaySec: 60 }], null] },

    { id: "bufferLabel/drawn-only", call: "App._tcTest.coverageBufferLabel", args: [{ bufferMiles: 0.5, drawn: true, gtfs: false, busMi: 0.25, railMi: 0.5 }] },
    { id: "bufferLabel/gtfs-only", call: "App._tcTest.coverageBufferLabel", args: [{ bufferMiles: 0.5, drawn: false, gtfs: true, busMi: 0.25, railMi: 0.5 }] },
    { id: "bufferLabel/both", call: "App._tcTest.coverageBufferLabel", args: [{ bufferMiles: 0.5, drawn: true, gtfs: true, busMi: 0.25, railMi: 0.75 }] },
    {
      id: "statSentence/with-buffer-label",
      call: "App._tcTest.buildStatSentence",
      args: [{
        bufferMiles: 0.5, bufferLabel: "bus 0.25 mi / rail 0.5 mi", headwayThreshold: 15,
        popTotal: 1000, popCovered: 600, popThreshold: 300, hasThreshold: true,
      }],
    },
  ],
};
