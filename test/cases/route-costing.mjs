// Golden cases for the Route Costing cost-math helpers. These live in the
// module's private closure, so route-costing.js exposes them under
// App._rcTest when window.__MAT_TEST__ is set (the harness sets it). See the
// test-only hook near computeLayoverHrs in js/projects/route-costing.js.
//
// Route Costing is a registered module: at load it calls App.registerModule,
// which the harness stubs as a no-op. Its pure helpers touch no map/API/turf.

export default {
  scripts: ["js/core/service-assembly.js", "js/projects/route-costing.js"],
  cases: [
    // --- parseBandTime: "H:MM" -> hours (NaN on bad input) ----------------
    { id: "parseBandTime/valid", call: "App._rcTest.parseBandTime", args: ["6:30"] },
    { id: "parseBandTime/midnight-end", call: "App._rcTest.parseBandTime", args: ["24:00"] },
    { id: "parseBandTime/out-of-range", call: "App._rcTest.parseBandTime", args: ["25:00"] },
    { id: "parseBandTime/garbage", call: "App._rcTest.parseBandTime", args: ["nope"] },

    // --- oneWayRuntimeHrs: length / speed (0 when speed missing) -----------
    { id: "oneWay/speed", call: "App._rcTest.oneWayRuntimeHrs", args: [{ avgSpeed: 12, lengthMiles: 6 }] },
    { id: "oneWay/no-speed", call: "App._rcTest.oneWayRuntimeHrs", args: [{ avgSpeed: 0, lengthMiles: 6 }] },

    // --- oneWayRuntimeHrsFromSettings: honors runtimeMode -----------------
    {
      id: "oneWaySettings/runTime-mode",
      call: "App._rcTest.oneWayRuntimeHrsFromSettings",
      args: [{ runTime: 45, lengthMiles: 6, avgSpeed: 12 }, { runtimeMode: "runTime" }],
    },
    {
      id: "oneWaySettings/speed-mode",
      call: "App._rcTest.oneWayRuntimeHrsFromSettings",
      args: [{ runTime: 45, lengthMiles: 5, avgSpeed: 15 }, { runtimeMode: "speed" }],
    },

    // --- computeRoundTrip: paired / Both / Loop -------------------------
    {
      id: "roundTrip/two-pattern",
      call: "App._rcTest.computeRoundTrip",
      args: [
        { patterns: [
          { avgSpeed: 12, lengthMiles: 6, direction: "NB" },
          { avgSpeed: 12, lengthMiles: 6, direction: "SB" },
        ] },
        { runtimeMode: "speed" },
      ],
    },
    {
      id: "roundTrip/one-pattern-both",
      call: "App._rcTest.computeRoundTrip",
      args: [
        { patterns: [{ avgSpeed: 10, lengthMiles: 5, direction: "Both" }] },
        { runtimeMode: "speed" },
      ],
    },
    {
      id: "roundTrip/one-pattern-loop",
      call: "App._rcTest.computeRoundTrip",
      args: [
        { patterns: [{ avgSpeed: 10, lengthMiles: 5, direction: "Loop" }] },
        { runtimeMode: "speed" },
      ],
    },

    // --- computeLayoverHrs: percent vs minutes ---------------------------
    { id: "layover/percent", call: "App._rcTest.computeLayoverHrs", args: [1.0, { layoverMode: "percent", layoverValue: 10 }] },
    { id: "layover/minutes", call: "App._rcTest.computeLayoverHrs", args: [1.0, { layoverMode: "minutes", layoverValue: 12 }] },
    // --- 3+ pattern Services (docs/archive/gtfs-route-browser-plan.md Phase 3) ----
    // Each pattern is its own one-way trip stream: per-trip layover, fleet =
    // sum over patterns of (one-way + layover) / that pattern's headway.
    {
      id: "roundTrip/three-pattern",
      call: "App._rcTest.computeRoundTrip",
      args: [
        { patterns: [
          { avgSpeed: 12, lengthMiles: 6, direction: "Outbound" },
          { avgSpeed: 12, lengthMiles: 4, direction: "Outbound" },
          { avgSpeed: 10, lengthMiles: 5, direction: "Inbound" },
        ] },
        { runtimeMode: "speed" },
      ],
    },
    {
      id: "service/three-pattern-minutes-layover",
      call: "App._rcTest.computeService",
      args: [
        { key: "service-Red", name: "Red", isGroup: true, warnings: [], patterns: [
          { name: "Red A", direction: "Outbound", avgSpeed: 12, lengthMiles: 6,
            service: { weekday: [{ from: "6:00", to: "9:00", frequency: 15 }, { from: "9:00", to: "18:00", frequency: 30 }],
                       saturday: [{ from: "8:00", to: "18:00", frequency: 60 }] } },
          { name: "Red B", direction: "Outbound", avgSpeed: 12, lengthMiles: 4,
            service: { weekday: [{ from: "6:00", to: "9:00", frequency: 30 }] } },
          { name: "Red C", direction: "Inbound", avgSpeed: 10, lengthMiles: 5,
            service: { weekday: [{ from: "6:00", to: "18:00", frequency: 20 }],
                       saturday: [{ from: "8:00", to: "18:00", frequency: 60 }], sundayMirrorsSaturday: true } },
        ] },
        { runtimeMode: "speed", layoverMode: "minutes", layoverValue: 10, deadheadPct: 10, costPerHour: 120,
          daysWeekday: 255, daysSaturday: 52, daysSunday: 58 },
      ],
    },
    {
      id: "service/three-pattern-percent-layover",
      call: "App._rcTest.computeService",
      args: [
        { key: "service-Loop", name: "Loop", isGroup: true, warnings: [], patterns: [
          { name: "L1", direction: "CW", runTime: 30, lengthMiles: 5, service: { weekday: [{ from: "22:00", to: "2:00", frequency: 30 }] } },
          { name: "L2", direction: "CCW", runTime: 30, lengthMiles: 5, service: { weekday: [{ from: "6:00", to: "10:00", frequency: 20 }] } },
          { name: "L3", direction: "Loop", runTime: 45, lengthMiles: 7, service: { weekday: [{ from: "6:00", to: "10:00", frequency: 60 }] } },
        ] },
        { runtimeMode: "runTime", layoverMode: "percent", layoverValue: 15, deadheadPct: 0, costPerHour: 100,
          daysWeekday: 255, daysSaturday: 0, daysSunday: 0 },
      ],
    },
    {
      // Cross-check: a 2-pattern Service through the same function (pins the
      // unchanged pair math alongside the new 3+ math).
      id: "service/two-pattern-reference",
      call: "App._rcTest.computeService",
      args: [
        { key: "service-P", name: "P", isGroup: true, warnings: [], patterns: [
          { name: "P N", direction: "NB", avgSpeed: 12, lengthMiles: 6, service: { weekday: [{ from: "6:00", to: "9:00", frequency: 15 }] } },
          { name: "P S", direction: "SB", avgSpeed: 12, lengthMiles: 6, service: { weekday: [{ from: "6:00", to: "9:00", frequency: 15 }] } },
        ] },
        { runtimeMode: "speed", layoverMode: "minutes", layoverValue: 10, deadheadPct: 10, costPerHour: 120,
          daysWeekday: 255, daysSaturday: 52, daysSunday: 58 },
      ],
    },
  ],
};
