// Golden cases for the Build vs No-Build comparison engine (window.ServiceCompare).
// No deps — service-compare.js is App/turf/DOM-free, so it loads clean in the vm
// sandbox. Cases call through ServiceCompare.evaluate(fn, args), which applies the
// named export to args. Every expected value in the comments was worked out by hand.

// Route record: { id, shortName, longName, type }.
function rec(id, shortName, longName, type) {
  return { id: id, shortName: shortName, longName: longName, type: type };
}

// Annual figures, in the field names serviceYear's weightedSum returns.
function fig(trips, runningHrs, revenueHrs, platformHrs, cost) {
  return { trips, runningHrs, revenueHrs, platformHrs, cost };
}

// serviceYear-shaped result. routes: { key: { annual, peak, span } }; total: { annual, peak, span }.
function yr(routes, total) {
  const out = { routes: {}, total: {} };
  for (const k of Object.keys(routes)) {
    const r = routes[k];
    out.routes[k] = { annual: r.annual, peakVehicles: r.peak, perDay: { weekday: { spanHrs: r.span } } };
  }
  if (total) out.total = { annual: total.annual, peakVehicles: total.peak, perDay: { weekday: { spanHrs: total.span } } };
  return out;
}

// No-Build: the loaded feed.
const NB = {
  label: "No-Build",
  year: yr(
    {
      "10": { annual: fig(1000, 500, 600, 690, 90000), peak: 8, span: 18 },
      "15": { annual: fig(400, 200, 240, 276, 36000), peak: 3, span: 14 },
      "20": { annual: fig(300, 150, 180, 207, 27000), peak: 2, span: 12 },
      R1: { annual: fig(200, 300, 330, 380, 49500), peak: 4, span: 19 },
    },
    { annual: fig(1900, 1150, 1350, 1553, 202500), peak: 17, span: 20 }
  ),
  routes: {
    "10": rec("10", "10", "Colfax", "3"),
    "15": rec("15", "15", "", "3"),
    "20": rec("20", "20", "", "3"),
    R1: rec("R1", "", "Airport Rail", "2"),
  },
};

// Build: 10 with more revenue; 15X is 15 renamed; R1-new is R1 renamed; d:svc1 is new; no 20.
const B = {
  label: "Build",
  year: yr(
    {
      "10": { annual: fig(1000, 500, 720, 828, 108000), peak: 8, span: 18 },
      "15X": { annual: fig(400, 200, 240, 276, 36000), peak: 3, span: 14 },
      "R1-new": { annual: fig(200, 300, 330, 380, 49500), peak: 4, span: 19 },
      "d:svc1": { annual: fig(500, 250, 300, 345, 45000), peak: 4, span: 16 },
    },
    { annual: fig(2100, 1250, 1590, 1749, 238500), peak: 19, span: 20 }
  ),
  routes: {
    "10": rec("10", "10", "Colfax", "3"),
    "15X": rec("15X", "15", "", "3"),
    "R1-new": rec("R1-new", "", "Airport Rail", "2"),
    "d:svc1": rec("d:svc1", "", "Crosstown", "3"),
  },
};

// Hand-worked compare-basic result (NB vs B, no pairs). precheck and csv take a compare
// result as input, and a case cannot pass another case's output, so the input is written out.
// mt(a, b, diff, pct) is one metric, with diff and pct to 2 decimals as compare rounds them.
function mt(a, b, diff, pct) {
  return { a, b, diff, pct };
}

const BASIC_ROWS = [
  { aKey: "10", bKey: "10", name: "10", match: "id", status: "changed", metrics: {
    trips: mt(1000, 1000, 0, 0), runningHrs: mt(500, 500, 0, 0), revenueHrs: mt(600, 720, 120, 20),
    platformHrs: mt(690, 828, 138, 20), cost: mt(90000, 108000, 18000, 20),
    peakVehicles: mt(8, 8, 0, 0), spanHrs: mt(18, 18, 0, 0) } },
  { aKey: "15", bKey: "15X", name: "15", match: "short", status: "unchanged", metrics: {
    trips: mt(400, 400, 0, 0), runningHrs: mt(200, 200, 0, 0), revenueHrs: mt(240, 240, 0, 0),
    platformHrs: mt(276, 276, 0, 0), cost: mt(36000, 36000, 0, 0),
    peakVehicles: mt(3, 3, 0, 0), spanHrs: mt(14, 14, 0, 0) } },
  { aKey: "20", bKey: null, name: "20", match: null, status: "removed", metrics: {
    trips: mt(300, 0, -300, -100), runningHrs: mt(150, 0, -150, -100), revenueHrs: mt(180, 0, -180, -100),
    platformHrs: mt(207, 0, -207, -100), cost: mt(27000, 0, -27000, -100),
    peakVehicles: mt(2, 0, -2, -100), spanHrs: mt(12, 0, -12, -100) } },
  { aKey: "R1", bKey: "R1-new", name: "Airport Rail", match: "long", status: "unchanged", metrics: {
    trips: mt(200, 200, 0, 0), runningHrs: mt(300, 300, 0, 0), revenueHrs: mt(330, 330, 0, 0),
    platformHrs: mt(380, 380, 0, 0), cost: mt(49500, 49500, 0, 0),
    peakVehicles: mt(4, 4, 0, 0), spanHrs: mt(19, 19, 0, 0) } },
  { aKey: null, bKey: "d:svc1", name: "Crosstown", match: null, status: "added", metrics: {
    trips: mt(0, 500, 500, null), runningHrs: mt(0, 250, 250, null), revenueHrs: mt(0, 300, 300, null),
    platformHrs: mt(0, 345, 345, null), cost: mt(0, 45000, 45000, null),
    peakVehicles: mt(0, 4, 4, null), spanHrs: mt(0, 16, 16, null) } },
];

const BASIC = {
  rows: BASIC_ROWS,
  total: { metrics: {
    trips: mt(1900, 2100, 200, 10.53), runningHrs: mt(1150, 1250, 100, 8.7),
    revenueHrs: mt(1350, 1590, 240, 17.78), platformHrs: mt(1553, 1749, 196, 12.62),
    cost: mt(202500, 238500, 36000, 17.78), peakVehicles: mt(17, 19, 2, 11.76),
    spanHrs: mt(20, 20, 0, 0) } },
  counts: { added: 1, removed: 1, changed: 1, unchanged: 2 },
};

const NO_PAIRS = { pairs: [] };

// Two build routes share the short name "10", so neither matches on it. x1 matches on long name.
const DUP_A = { "10": rec("10", "10", "Colfax", "3") };
const DUP_B = {
  x1: rec("x1", "10", "Colfax", "3"),
  x2: rec("x2", "10", "Colfax Shuttle", "3"),
};

const MAJOR = {
  revenueHoursPct: { enabled: true, threshold: 25 },
  spanHoursPct: { enabled: true, threshold: 25 },
  routeElimination: { enabled: true },
};
const MAJOR_15 = { ...MAJOR, revenueHoursPct: { enabled: true, threshold: 15 } };

export default {
  scripts: ["js/core/service-compare.js"],
  cases: [
    // EXPECTED rows by name: 10 id/changed (revenue diff 120, pct 20); 15 short/unchanged; 20 removed (bKey null);
    // Airport Rail long/unchanged; Crosstown added. Counts {added 1, removed 1, changed 1, unchanged 2}.
    // Total: trips diff 200, revenue diff 240 (pct 17.78), peak diff 2.
    { id: "compare-basic", call: "ServiceCompare.evaluate", args: ["compare", [NB, B, NO_PAIRS]] },

    // Pair 20 with d:svc1: a pair row, changed (trips 300 to 500, diff 200, pct 66.67).
    // EXPECTED counts {added 0, removed 0, changed 2, unchanged 2}.
    { id: "compare-pairs", call: "ServiceCompare.evaluate", args: ["compare", [NB, B, { pairs: [{ a: "20", b: "d:svc1" }] }]] },

    // Pair 15 as removed (pair). 15X has no partner left, so it is added. Row order: 10, 15X, 15, 20, Airport Rail, Crosstown
    // (the two rows named "15" tie on name; the added row sorts first on its key).
    // EXPECTED 15 removed with match "pair"; 15X added with match null.
    { id: "compare-pair-removed", call: "ServiceCompare.evaluate", args: ["compare", [NB, B, { pairs: [{ a: "15", b: null }] }]] },

    // EXPECTED rows [], counts {added 0, removed 0, changed 0, unchanged 0}; total trips 0 both sides, diff 0, pct null;
    // total spanHrs null on both sides, diff null, pct null.
    { id: "compare-empty", call: "ServiceCompare.evaluate", args: ["compare", [
      { label: "No-Build", year: yr({}, null), routes: {} },
      { label: "Build", year: yr({}, null), routes: {} },
      NO_PAIRS,
    ]] },

    // EXPECTED [{a: null, b: "x2", how: null}, {a: "10", b: "x1", how: "long"}].
    // The short name "10" is not unique on the Build side, so only the long name matches. The two rows both
    // display "10" and tie on name; x2 sorts first because its key starts with \u0001, which sorts before "1".
    { id: "match-dup-short", call: "ServiceCompare.evaluate", args: ["matchRoutes", [DUP_A, DUP_B, null]] },

    // EXPECTED: 10 adjustment, revenueHoursPct 20, spanHoursPct 0, triggers [], suggested false;
    // 20 elimination, revenueHoursPct -100, spanHoursPct -100, triggers ["revenueHoursPct","spanHoursPct","routeElimination"], suggested true;
    // Crosstown new_route, revenueHoursPct null, spanHoursPct null, triggers [], suggested false. Unchanged rows are left out.
    { id: "precheck-default", call: "ServiceCompare.evaluate", args: ["precheck", [BASIC_ROWS, MAJOR]] },

    // EXPECTED: 10 triggers ["revenueHoursPct"] (20 is at or above 15); 20 as in precheck-default; Crosstown triggers [].
    { id: "precheck-threshold-15", call: "ServiceCompare.evaluate", args: ["precheck", [BASIC_ROWS, MAJOR_15]] },

    // EXPECTED: every row has triggers [] and suggested false (no majorChange means every rule is disabled).
    { id: "precheck-none", call: "ServiceCompare.evaluate", args: ["precheck", [BASIC_ROWS, undefined]] },

    // EXPECTED header (31 columns): Route, Status, Matched by, then for each metric
    // "<Metric> (No-Build)", "<Metric> (Build)", "<Metric> change", "<Metric> change %".
    // Rows: 10 changed id ... 1000,1000,0,0 ... 600,720,120,20 ...; 15 unchanged short;
    // 20 removed "" with 300,0,-300,-100 and span 12,0,-12,-100; Airport Rail unchanged long;
    // Crosstown added "" with 0,500,500 and blank pct; Total "" "" with 1900,2100,200,10.53 ...
    { id: "csv-basic", call: "ServiceCompare.evaluate", args: ["csv", [BASIC, { a: "No-Build", b: "Build" }]] },
  ],
};
