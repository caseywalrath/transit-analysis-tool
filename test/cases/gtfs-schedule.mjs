// Golden cases for the GTFS schedule engine (window.GtfsSchedule). The engine is App/DOM/turf-free,
// so it loads alone. Mini-feed values were worked out by hand in test/fixtures/gtfs/mini/EXPECTED.md;
// the comment above each case says what that file requires. Edge cases use small inline texts.
import { readFileSync, readdirSync } from "node:fs";
const DIR = new URL("../fixtures/gtfs/mini/", import.meta.url);
const MINI = {};
for (const f of readdirSync(DIR)) if (f.endsWith(".txt")) MINI[f] = readFileSync(new URL(f, DIR), "utf8");

const D1 = "20260112", D2 = "20260119", D3 = "20260124", D4 = "20260130";
const EV = "GtfsSchedule.evaluate";
const mini = (fn, ...args) => ({ call: EV, args: [MINI, fn, args] });
const inline = (texts, fn, ...args) => ({ call: EV, args: [texts, fn, args] });

const cases = [];
const add = (id, spec) => cases.push({ id, ...spec });

// ---- time ---------------------------------------------------------------
for (const [k, s] of [["std", "07:10:00"], ["onedigit", "7:05:09"], ["past24", "25:10:00"], ["spaces", " 08:00:00 "],
  ["blank", ""], ["whitespace", "   "], ["no-seconds", "07:10"], ["junk", "ab:cd:ef"], ["minute60", "07:60:00"], ["hours100", "100:00:00"]])
  add("parseTime-" + k, { call: "GtfsSchedule.parseTime", args: [s] });
for (const [k, v] of [["past24", 90600], ["missing", -1], ["string", "x"], ["zero", 0], ["mixed", 3661]])
  add("formatTime-" + k, { call: "GtfsSchedule.formatTime", args: [v] });

// ---- CsvStream ----------------------------------------------------------
const csv = (id, chunks) => add("csv-" + id, { call: "GtfsSchedule._csvChunks", args: [chunks] });
csv("bom-crlf", ["﻿a,b\r\n1,2\r\n3,4\r\n"]);
csv("lone-cr", ["a,b\r1,2\r3,4"]);
csv("quoted-comma", ['a,b\n"x,y",2\n']);
csv("quoted-newline", ['a,b\n"line1\nline2",2\n']);
csv("quote-escape", ['a,b\n"say ""hi""",2\n']);
csv("chunk-in-quote", ['a,b\n"he', 'llo, wor', 'ld",2\n']);
csv("chunk-in-escape", ['a,b\n"x"', '"y",2\n']);
csv("chunk-between-crlf", ["a,b\r", "\n1,2\r", "\n3,4"]);
csv("chunk-mid-field", ["a,bb\n12", "3,4", "56\n"]);
csv("no-trailing-newline", ["a,b\n1,2"]);
csv("trailing-empty-field", ["a,b\n1,"]);
csv("short-and-long-rows", ["a,b,c\n1\n1,2,3,4,5\n"]);
csv("blank-lines", ["\n\na,b\n\n1,2\n\n,\n3,4\n\n"]);
csv("header-trim-values-untrimmed", [" a , b \n 1 , 2 \n"]);
csv("bom-own-chunk", ["﻿", "a,b\n1,2\n"]);
csv("empty", [""]);

// ---- mini feed, Mon 2026-01-12: EXPECTED 25 trips (B1 5, R1 2, F1 18), invalid 1, total 26640 s,
// ---- B1 6000 / R1 4440 / F1 16200, first 21600 (06:00) last dep 89400 (24:50), last arr 90600 ----
for (const [d, label] of [[D1, "0112"], [D2, "0119"], [D3, "0124"], [D4, "0130"]]) {
  add("active-" + label, mini("activeServices", d));
  add("daytype-" + label, mini("dayType", d));
  add("summary-" + label, mini("routeDaySummary", d));
  add("peak-" + label, mini("peakVehicles", d));
  add("s1-departures-" + label, mini("departuresAtStop", d, "S1"));
}
// EXPECTED: 0112 not an exception; 0119, 0124, 0130 are.
add("daytype-0112-sunday", mini("dayType", "20260111"));
// EXPECTED 0112: S1 has 21 departures; STN (via P1) has 1 (21600); S2 includes interpolated 29400.
add("stn-departures-0112", mini("departuresAtStop", D1, "STN"));
add("p1-departures-0112", mini("departuresAtStop", D1, "P1"));
// EXPECTED 0124: STN has 2 (08:00 = 28800, 22:00 = 79200).
add("stn-departures-0124", mini("departuresAtStop", D3, "STN"));
add("s2-departures-0112", mini("departuresAtStop", D1, "S2"));
add("unknown-stop-departures", mini("departuresAtStop", D1, "NOPE"));
add("trips-0112", mini("tripsOnDate", D1));
add("trips-0119", mini("tripsOnDate", D2));
add("trips-0124", mini("tripsOnDate", D3));
add("trips-0112-route-filter", mini("tripsOnDate", D1, { routeIds: ["R1"] }));
add("trips-no-service-date", mini("tripsOnDate", "20260301"));
add("summary-no-service-date", mini("routeDaySummary", "20251201"));
add("peak-no-service-date", mini("peakVehicles", "20251201"));
add("peak-0112-layover0", mini("peakVehicles", D1, { layoverSec: 0 }));
add("headway-s1-am-0112", mini("medianHeadway", D1, "S1", 21600, 32400));
add("headway-s1-one-dep", mini("medianHeadway", D2, "S1", 0, 86400));
add("headway-s1-night-0124", mini("medianHeadway", D3, "S1", 79200, 90000));
add("trip-times-b1w2-blank", mini("tripStopTimes", "B1_W_2"));
// EXPECTED: S2 of B1_W_2 interpolates to 08:10:00 = 29400.
add("trip-times-b1w2-interp", mini("tripStopTimes", "B1_W_2", { interpolate: true }));
add("trip-times-owl", mini("tripStopTimes", "B1_W_OWL"));
add("trip-times-bad", mini("tripStopTimes", "B1_W_BAD"));
add("trip-times-generated", mini("tripStopTimes", "F1_W_FREQ@06:20:00"));
add("trip-times-unknown", mini("tripStopTimes", "NOPE"));
add("patterns-b1-0112", mini("patterns", D1, "B1"));
add("patterns-f1-0124", mini("patterns", D3, "F1"));
add("patterns-unknown-route", mini("patterns", D1, "ZZ"));
add("dominant-b1-any", mini("dominantPattern", D1, "B1", null));
add("dominant-b1-dir1", mini("dominantPattern", D1, "B1", "1"));
add("dominant-b1-dir9", mini("dominantPattern", D1, "B1", "9"));
// EXPECTED whole feed: busiest weekday 20260130; saturday/sunday picked by trip count.
add("busiest-weekday", mini("busiestDate", "weekday"));
add("busiest-saturday", mini("busiestDate", "saturday"));
add("busiest-sunday", mini("busiestDate", "sunday"));
add("date-range", mini("dateRange"));
// EXPECTED: S1/STN/R2 = 1; S2 = 2; S3/F2 = 0; P1 inherits 1 from STN.
add("accessibility", mini("stopAccessibility"));
add("mini-problems", mini("problems"));
add("mini-store", mini("store"));

// ---- edge cases ---------------------------------------------------------
const HDR = "trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint\n";
const STOPS = "stop_id,stop_lat,stop_lon\nA,39.0,-105.0\nB,39.0,-104.9\nC,39.0,-104.8\n";
const ROUTES = "route_id\nR\n";
const CAL = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260105,20260201\n";
const TRIPS = "route_id,service_id,trip_id,direction_id,block_id\nR,WK,T1,0,\n";

// Duplicate (trip, sequence): the first row read wins; one bad row (blank trip), one non-integer sequence,
// rows unsorted with gaps, a row with only an arrival time.
const DUP = HDR + [
  "T1,08:20:00,08:20:00,C,30,1", "T1,08:00:00,08:00:00,A,10,1", "T1,08:05:00,08:05:00,B,20,0",
  "T1,09:99:99,09:99:99,B,20,0", ",08:00:00,08:00:00,A,1,1", "T1,08:00:00,08:00:00,A,x,1",
  "T1,08:50:00,,A,40,", "T2,07:00:00,07:00:00,A,1,1"].join("\n");
add("edge-dup-store", inline({ "stop_times.txt": DUP }, "store"));
add("edge-dup-times", inline({ "stop_times.txt": DUP, "stops.txt": STOPS, "routes.txt": ROUTES, "calendar.txt": CAL, "trips.txt": TRIPS },
  "tripStopTimes", "T1"));

// Unknown route and service on trips; stop_times that name an unknown trip and an unknown stop.
const UNK_TRIPS = "route_id,service_id,trip_id\nR,WK,T1\nNOROUTE,WK,T2\nR,NOSVC,T3\n";
const UNK_ST = HDR + ["T1,08:00:00,08:00:00,A,1,1", "T1,08:10:00,08:10:00,ZZ,2,1", "T2,08:00:00,08:00:00,A,1,1",
  "T3,08:00:00,08:00:00,A,1,1", "GHOST,08:00:00,08:00:00,A,1,1", "GHOST,08:10:00,08:10:00,B,2,1"].join("\n");
const UNK = { "stop_times.txt": UNK_ST, "stops.txt": STOPS, "routes.txt": ROUTES, "calendar.txt": CAL, "trips.txt": UNK_TRIPS };
add("edge-unknown-problems", inline(UNK, "problems"));
add("edge-unknown-trips", inline(UNK, "tripsOnDate", "20260112"));

// Calendar: end before start contributes nothing; dates-only service; add outside the calendar range.
const CAL2 = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
  "WK,1,1,1,1,1,0,0,20260105,20260201\nREV,1,1,1,1,1,1,1,20260201,20260105\n";
const CD2 = "service_id,date,exception_type\nONLY,20260301,1\nWK,20260301,1\nWK,20260106,2\nWK,20260106,1\n";
const CALFEED = { "calendar.txt": CAL2, "calendar_dates.txt": CD2 };
add("edge-cal-problems", inline(CALFEED, "problems"));
add("edge-cal-range", inline(CALFEED, "dateRange"));
add("edge-cal-active-monday", inline(CALFEED, "activeServices", "20260112"));
add("edge-cal-removed-wins", inline(CALFEED, "activeServices", "20260106"));
add("edge-cal-add-outside-range", inline(CALFEED, "activeServices", "20260301"));
add("edge-cal-saturday-reverse-ignored", inline(CALFEED, "activeServices", "20260117"));
add("edge-cal-daytype-add-outside", inline(CALFEED, "dayType", "20260301"));
add("edge-cal-daytype-removed", inline(CALFEED, "dayType", "20260106"));
add("edge-cal-busiest", inline(CALFEED, "busiestDate", "weekday"));

// No calendar.txt at all: a service defined only by calendar_dates.txt still runs.
const NOCAL = { "calendar_dates.txt": "service_id,date,exception_type\nWK,20260112,1\nWK,20260113,1\n",
  "routes.txt": ROUTES, "trips.txt": TRIPS, "stops.txt": STOPS, "stop_times.txt": HDR + "T1,08:00:00,08:00:00,A,1,1\nT1,08:10:00,08:10:00,B,2,1\n" };
add("edge-nocal-range", inline(NOCAL, "dateRange"));
add("edge-nocal-trips", inline(NOCAL, "tripsOnDate", "20260112"));
add("edge-nocal-trips-other-day", inline(NOCAL, "tripsOnDate", "20260114"));
add("edge-nocal-busiest", inline(NOCAL, "busiestDate", "weekday"));

// Nothing at all.
add("edge-empty-range", inline({}, "dateRange"));
add("edge-empty-trips", inline({}, "tripsOnDate", "20260112"));
add("edge-empty-summary", inline({}, "routeDaySummary", "20260112"));
add("edge-empty-peak", inline({}, "peakVehicles", "20260112"));
add("edge-empty-busiest", inline({}, "busiestDate", "weekday"));
add("edge-empty-access", inline({}, "stopAccessibility"));
add("edge-empty-store", inline({}, "store"));

// Overlapping frequency windows with a repeated start time are generated once; headway 0 is ignored.
const FR = { "routes.txt": ROUTES, "calendar.txt": CAL, "stops.txt": STOPS,
  "trips.txt": "route_id,service_id,trip_id\nR,WK,TF\n",
  "stop_times.txt": HDR + "TF,06:00:00,06:00:00,A,1,1\nTF,06:10:00,06:10:00,B,2,1\n",
  "frequencies.txt": "trip_id,start_time,end_time,headway_secs,exact_times\nTF,06:00:00,07:00:00,1800,0\nTF,06:30:00,07:30:00,1800,1\nTF,08:00:00,09:00:00,0,1\n" };
add("edge-freq-overlap", inline(FR, "tripsOnDate", "20260112"));

// Blocks: a vehicle ending at 08:00 and one starting at 08:00 do not overlap (half-open).
const BLK = { "routes.txt": ROUTES, "calendar.txt": CAL, "stops.txt": STOPS,
  "trips.txt": "route_id,service_id,trip_id,block_id\nR,WK,X1,K1\nR,WK,X2,K2\nR,WK,X3,\n",
  "stop_times.txt": HDR + "X1,07:00:00,07:00:00,A,1,1\nX1,08:00:00,08:00:00,B,2,1\nX2,08:00:00,08:00:00,A,1,1\nX2,09:00:00,09:00:00,B,2,1\nX3,08:30:00,08:30:00,A,1,1\nX3,08:40:00,08:40:00,B,2,1\n" };
add("edge-blocks-half-open", inline(BLK, "peakVehicles", "20260112"));

// A frequency template with a block_id: each generated run is its own vehicle.
// Run time 60 min, headway 10 min, 06:00-09:00 -> 6 runs overlap from 06:50, so block peak 6.
const FBLK = { "routes.txt": ROUTES, "calendar.txt": CAL, "stops.txt": STOPS,
  "trips.txt": "route_id,service_id,trip_id,block_id\nR,WK,FT,BLK9\n",
  "frequencies.txt": "trip_id,start_time,end_time,headway_secs,exact_times\nFT,06:00:00,09:00:00,600,0\n",
  "stop_times.txt": HDR + "FT,06:00:00,06:00:00,A,1,1\nFT,07:00:00,07:00:00,B,2,1\n" };
add("edge-freq-block-runs-are-vehicles", inline(FBLK, "peakVehicles", "20260112"));

// A later calendar row with end before start is skipped; the earlier valid row keeps WK running.
const CALDUP = { "routes.txt": ROUTES, "stops.txt": STOPS,
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\nWK,1,1,1,1,1,0,0,20261231,20260101\n",
  "trips.txt": "route_id,service_id,trip_id\nR,WK,X1\n",
  "stop_times.txt": HDR + "X1,07:00:00,07:00:00,A,1,1\nX1,08:00:00,08:00:00,B,2,1\n" };
add("edge-cal-bad-duplicate-row-skipped", inline(CALDUP, "activeServices", "20260112"));

// ---- headway bands (headwayBands and helpers) ---------------------------
// Bands are checked by the invariant (bands-invariant), so these cases pin the chosen edges, headways
// and trip counts for the shapes the card names; values come from the rules, not from the code.
const HMS = (h, m) => h * 3600 + m * 60;
const every = (from, to, step) => { const out = []; for (let t = from; t <= to; t += step) out.push(t); return out; };
const bandsCall = (deps, parts) => ({ call: "GtfsSchedule.headwayBands", args: [deps, parts ?? null] });

add("bands-every15-0600-0900", bandsCall(every(HMS(6, 0), HMS(9, 0), 900)));
{ // Alternating 14/16-minute gaps from 09:00 to 15:00.
  const alt = []; let t = HMS(9, 0), g = 840;
  while (t <= HMS(15, 0)) { alt.push(t); t += g; g = g === 840 ? 960 : 840; }
  add("bands-alt-14-16-midday", bandsCall(alt));
}
add("bands-one-dep-0700", bandsCall([HMS(7, 0)]));
add("bands-one-dep-0703", bandsCall([HMS(7, 3)]));
add("bands-night-cross-midnight", bandsCall([HMS(21, 30), HMS(22, 30), HMS(23, 30), HMS(24, 30), HMS(25, 30)]));
add("bands-whole-day-every20", bandsCall(every(HMS(5, 10), HMS(24, 50), 1200)));
{ // 7 trips in a 30-minute band: no round headway gives 7, so the one-decimal fallback (4.9) is used.
  const d = []; for (let i = 0; i < 7; i++) d.push(HMS(6, 0) + i * 300);
  add("bands-decimal-fallback-7-in-30", bandsCall(d));
}
{ // 40 trips in one 60-minute band (90-second spacing).
  const d = []; for (let i = 0; i < 40; i++) d.push(HMS(6, 0) + i * 90);
  add("bands-40-in-60", bandsCall(d));
}
{ // 100 trips in a 180-minute band (108-second spacing): the tight fallback.
  const d = []; for (let i = 0; i < 100; i++) d.push(HMS(6, 0) + i * 108);
  add("bands-100-in-180", bandsCall(d));
}
add("bands-empty", bandsCall([]));
add("bands-unsorted", bandsCall([HMS(9, 30), HMS(7, 0), HMS(8, 15), HMS(7, 45)]));
add("bands-negative-ignored", bandsCall([-60, HMS(7, 0), -1, HMS(7, 3)]));
add("bands-custom-two-parts", bandsCall(every(HMS(6, 0), HMS(13, 0), 1800),
  [{ id: "a", label: "A", start: "06:00" }, { id: "b", label: "B", start: "12:00" }]));
add("bands-invariant", { call: "GtfsSchedule._bandInvariant", args: [1] });

// bandTripCount: Route Costing's formula (22:00 to 02:00 at 30 minutes is 8 trips).
add("bands-trip-count-wrap", { call: "GtfsSchedule.bandTripCount", args: ["22:00", "02:00", 30] });
add("bands-trip-count-bad-time", { call: "GtfsSchedule.bandTripCount", args: ["25:00", "02:00", 30] });
add("bands-trip-count-zero-headway", { call: "GtfsSchedule.bandTripCount", args: ["06:00", "07:00", 0] });

// meanTripMinutes: 600 s and 900 s average 12.5 minutes; the zero-length entry is ignored.
add("bands-mean-trip-minutes", { call: "GtfsSchedule.meanTripMinutes",
  args: [[{ start: 0, end: 600 }, { start: 0, end: 900 }, { start: 100, end: 100 }]] });
add("bands-mean-trip-empty", { call: "GtfsSchedule.meanTripMinutes", args: [[]] });
add("bands-mean-trip-zero-only", { call: "GtfsSchedule.meanTripMinutes", args: [[{ start: 5, end: 5 }]] });

// bandsEqual: trips and part are ignored; from, to and frequency must match.
const B = (from, to, frequency, trips = 6, part = "am") => ({ from, to, frequency, trips, part });
add("bands-equal-same", { call: "GtfsSchedule.bandsEqual", args: [[B("06:00", "07:00", 10)], [B("06:00", "07:00", 10, 99, "x")]] });
add("bands-equal-frequency", { call: "GtfsSchedule.bandsEqual", args: [[B("06:00", "07:00", 10)], [B("06:00", "07:00", 12)]] });
add("bands-equal-length", { call: "GtfsSchedule.bandsEqual", args: [[B("06:00", "07:00", 10)], [B("06:00", "07:00", 10), B("07:00", "08:00", 10)]] });

// ---- serviceCopyPlan / reconciliationNote ------------------------------
// Mini feed: B1 on Fri 0130 has 6 shaped trips (SH_B1_0 x4, SH_B1_1 x2) and a 20-minute run time on both
// shapes; Sat 0124 and Sun 0111 each have one SH_B1_0 trip. F1 has no shape, so every F1 trip is unshaped.
const PLAN_DATES = { weekday: "20260130", saturday: "20260124", sunday: "20260111" };
const plan = (routeId, dates = PLAN_DATES) => mini("serviceCopyPlan", { routeId, dates });
add("plan-b1", plan("B1"));
add("plan-r1", plan("R1"));
add("plan-f1-all-unshaped", plan("F1"));
add("plan-unknown-route", plan("NOPE"));
add("plan-weekday-only", plan("B1", { weekday: "20260112", saturday: null, sunday: null }));
add("plan-no-dates", plan("B1", { weekday: null, saturday: null, sunday: null }));
add("plan-custom-day-parts", mini("serviceCopyPlan", { routeId: "B1", dates: PLAN_DATES,
  dayParts: [{ id: "all", label: "All day", start: "00:00" }] }));

const recon = (day, date, gtfsTrips, copyTrips, gtfsHours, copyHours, diffPct) =>
  ({ day, date, gtfsTrips, copyTrips, gtfsHours, copyHours, diffPct, tripsOk: gtfsTrips === copyTrips, hoursOk: Math.abs(diffPct) <= 3 });
const noteCall = (reconciliation, unshaped = { weekday: 0, saturday: 0, sunday: 0 }, dates = PLAN_DATES) =>
  ({ call: "GtfsSchedule.reconciliationNote", args: [{ routeId: "R", dates, shapes: [], unshaped, reconciliation }, "Red"] });
add("note-matches", noteCall([recon("weekday", "20260112", 25, 25, 4.7, 4.7, 0)]));
add("note-hours-off", noteCall([recon("weekday", "20260112", 25, 25, 4.7, 5.1, 8.5)]));
add("note-hours-off-negative", noteCall([recon("saturday", "20260124", 1, 1, 0.33, 0.32, -3.2)]));
add("note-trip-mismatch", noteCall([recon("weekday", "20260112", 25, 24, 4.7, 4.5, -4.3)]));
add("note-no-service-and-unshaped", noteCall(
  [recon("weekday", "20260112", 0, 0, 0, 0, 0), recon("saturday", "20260124", 0, 0, 0, 0, 0)],
  { weekday: 3, saturday: 0, sunday: 1 }, { weekday: "20260112", saturday: "20260124", sunday: null }));

// ---- details views -----------------------------------------------------
// Stop, route and feed summaries. The values were checked by hand against test/fixtures/gtfs/mini; the
// comment above each group says what the fixture requires. Times are service-day seconds.
const A4_PARTS = [{ id: "am", label: "A", start: "00:00" }, { id: "midday", label: "B", start: "12:00" }];
const A4_DATES = { weekday: D1, saturday: D3, sunday: null };

// stopDepartures at S1 on 0112: B1_W_1 and B1_W_3 end at S1, so their rows are last-row arrivals; F1 adds
// its generated runs under F1_W_FREQ@HH:MM:SS and F1_W_PM@HH:MM:SS ids.
add("a4-stop-departures-s1-d1", mini("stopDepartures", D1, "S1"));
add("a4-stop-departures-s1-b1-only", mini("stopDepartures", D1, "S1", { routeIds: ["B1"] }));
// The parent STN has no stop times of its own; its child platform P1 supplies the row, with stopId "P1".
add("a4-stop-departures-stn-d1", mini("stopDepartures", D1, "STN"));
// S3 is the last stop of B1 direction 0, so its rows are arrivals and sort by arr.
add("a4-stop-departures-s3-d1", mini("stopDepartures", D1, "S3"));
add("a4-stop-departures-unknown", mini("stopDepartures", D1, "NOPE"));

// stopSummary: S1 on 0112 has 21 departures (B1 3, F1 18). With the default parts AM holds 12, PM 8 and
// night 1; early, midday and evening are empty.
add("a4-stop-summary-s1-d1", mini("stopSummary", D1, "S1", {}));
add("a4-stop-summary-s1-d1-two-parts", mini("stopSummary", D1, "S1", { dayParts: A4_PARTS }));
add("a4-stop-summary-s1-no-service", mini("stopSummary", "20250101", "S1", {}));
// S2 includes the interpolated 08:10 time of B1_W_2.
add("a4-stop-summary-s2-d1", mini("stopSummary", D1, "S2", {}));

// stopSpacing: S2 has a neighbour on each side in both B1 patterns, 855 m each way. S1 is the first stop of
// B1 direction 0 and the last of direction 1; on F1 it is the first stop, with F2 1112 m on. STN's platform
// P1 starts R1 direction 0 and ends direction 1, so one neighbour is null on each row.
add("a4-stop-spacing-s2-d1", mini("stopSpacing", D1, "S2"));
add("a4-stop-spacing-s1-d1", mini("stopSpacing", D1, "S1"));
add("a4-stop-spacing-stn-d1", mini("stopSpacing", D1, "STN"));

// routeSchedule: B1 on 0112 has 5 trips, 3 in direction 0 and 2 in direction 1; the invalid B1_W_BAD is
// left out. F1 has 17 generated frequency runs and one ordinary trip. R1 on Saturday 0124 includes the
// EVT trip R1_E_0.
add("a4-route-schedule-b1-d1", mini("routeSchedule", D1, "B1", {}));
add("a4-route-schedule-f1-d1", mini("routeSchedule", D1, "F1", {}));
add("a4-route-schedule-r1-d3", mini("routeSchedule", D3, "R1", {}));
add("a4-route-schedule-unknown", mini("routeSchedule", D1, "NOPE", {}));
add("a4-route-schedule-b1-d1-two-parts", mini("routeSchedule", D1, "B1", { dayParts: A4_PARTS }));

// feedOverview: the mini calendar ends 2026-02-01, so daysLeft is 22 on 20260110 and -28 on 20260301.
// Counts: 3 routes, 6 stops (the station is not one of them), 1 station, 16 trips.
add("a4-feed-overview-mini", mini("feedOverview", { today: "20260110", dates: A4_DATES }));
add("a4-feed-overview-expired", mini("feedOverview", { today: "20260301", dates: A4_DATES }));
add("a4-feed-overview-no-today", mini("feedOverview", { today: null, dates: A4_DATES }));
// No calendar at all: no range, so daysLeft is null even with a valid today; dayTypes count zero trips.
add("a4-feed-overview-agency-only", inline({ "agency.txt": "agency_name\nSolo\n" }, "feedOverview",
  { today: "20260110", dates: A4_DATES }));

// ---- service hours, peak vehicles and cost ------------------------------
// Hand values: test/fixtures/gtfs/mini/EXPECTED.md, section "Service hours and cost (A5)".
// D1 rows: B1 5 trips, R1 2, F1 18, total 25; the total peak of 4 is reached at 26100 (07:15).
add("a5-day-d1", mini("routeServiceDay", D1, {}));
add("a5-day-d1-percent10", mini("routeServiceDay", D1, { layover: { mode: "percent", value: 10 } }));
add("a5-day-d1-b1", mini("routeServiceDay", D1, { routeIds: ["B1"] }));
add("a5-day-d1-gap5", mini("routeServiceDay", D1, { layover: { maxBlockGapMin: 5 } }));
add("a5-day-d3", mini("routeServiceDay", D3, {}));
add("a5-day-unknown", mini("routeServiceDay", "20250101", {}));
// Weekly and annual figures: weekday D1, Saturday D3, Sunday D2 (a holiday with Sunday service).
const A5_DATES = { weekday: D1, saturday: D3, sunday: D2 };
add("a5-year-default", mini("serviceYear", { dates: A5_DATES }));
add("a5-year-platform-overrides", mini("serviceYear", { dates: A5_DATES, rateBasis: "platform",
  rateOverrides: { R1: 300, B1: "x" } }));
add("a5-year-daycount-weekday-250", mini("serviceYear", { dates: A5_DATES, dayCounts: { weekday: 250 } }));
add("a5-year-all-dates-null", mini("serviceYear", { dates: { weekday: null, saturday: null, sunday: null } }));
// Calendar: 2026-01-05 to 2026-02-01 is 28 dates, with 20 weekdays, 4 Saturdays and 4 Sundays.
add("a5-calendar-default", mini("calendarDayCounts", {}));
add("a5-calendar-r1", mini("calendarDayCounts", { routeIds: ["R1"] }));
// No calendar.txt and no calendar_dates.txt: no date range, so every count is zero.
add("a5-calendar-no-calendar", inline({
  "trips.txt": "route_id,service_id,trip_id,direction_id,block_id,shape_id\nB1,WKDY,T1,0,,\n",
  "routes.txt": "route_id,agency_id,route_short_name\nB1,MINI,B1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,07:00:00,07:00:00,S1,1\nT1,07:10:00,07:10:00,S2,2\n"
}, "calendarDayCounts", {}));

// ---- stop analysis (A5) --------------------------------------------------
// Hand values: test/fixtures/gtfs/mini/EXPECTED.md, section "Stop analysis (A5)".
// D1: every segment is "very wide" with default thresholds (B1 4 x 2805 ft, F1 3648 ft, R1 2 x 99440 ft).
add("a5-stops-spacing-d1", mini("stopSpacingStats", D1, {}));
add("a5-stops-spacing-d1-b1", mini("stopSpacingStats", D1, { routeIds: ["B1"] }));
add("a5-stops-spacing-d1-stop-s2", mini("stopSpacingStats", D1, { stopIds: ["S2"] }));
// Thresholds [100, 200, 3000, 50000]: B1 lands in Target, F1 in Wide, R1 in Very wide.
add("a5-stops-spacing-d1-custom-thresholds", mini("stopSpacingStats", D1, { thresholdsFt: [100, 200, 3000, 50000] }));
// [600, 500, 1, 2] is not rising, so the defaults apply.
add("a5-stops-spacing-d1-invalid-thresholds", mini("stopSpacingStats", D1, { thresholdsFt: [600, 500, 1, 2] }));
add("a5-stops-spacing-d3", mini("stopSpacingStats", D3, {}));
add("a5-stops-spacing-unknown-date", mini("stopSpacingStats", "20250101", {}));

// Default 600 ft: nothing is closer. With maxFt 99999, B1's middle stop S2 is the one candidate (5 trips,
// 100 s a day); B1 alone and a stop list without S2 leave nothing.
add("a5-stops-consolidation-d1", mini("consolidationCandidates", D1, {}));
add("a5-stops-consolidation-d1-wide", mini("consolidationCandidates", D1, { maxFt: 99999 }));
add("a5-stops-consolidation-d1-wide-b1", mini("consolidationCandidates", D1, { maxFt: 99999, routeIds: ["B1"] }));
add("a5-stops-consolidation-d1-wide-stop-s2", mini("consolidationCandidates", D1, { maxFt: 99999, stopIds: ["S2"], secondsPerStop: 30 }));
add("a5-stops-consolidation-d1-wide-stop-s1", mini("consolidationCandidates", D1, { maxFt: 99999, stopIds: ["S1"] }));
add("a5-stops-consolidation-d3-wide", mini("consolidationCandidates", D3, { maxFt: 99999 }));
add("a5-stops-consolidation-unknown-date", mini("consolidationCandidates", "20250101", { maxFt: 99999 }));

// D1 rows: P1, R2, S1 (21 trips, 06:00 to 24:50, peak headway 900), S2 (5), S3 (2). STN has none of its own.
add("a5-stops-table-d1", mini("stopServiceTable", D1, {}));
add("a5-stops-table-d1-b1", mini("stopServiceTable", D1, { routeIds: ["B1"] }));
add("a5-stops-table-d1-stop-s2", mini("stopServiceTable", D1, { stopIds: ["S2"] }));
add("a5-stops-table-d1-two-parts", mini("stopServiceTable", D1, { dayParts: A4_PARTS }));
add("a5-stops-table-d3", mini("stopServiceTable", D3, {}));
add("a5-stops-table-unknown-date", mini("stopServiceTable", "20250101", {}));
// Invariant: every childless non-station stop agrees with stopSummary (checked 5, mismatches none).
add("a5-stops-table-matches-summary-d1", mini("_stopTableInvariant", D1, {}));
add("a5-stops-table-matches-summary-d3", mini("_stopTableInvariant", D3, { dayParts: A4_PARTS }));
add("a5-stops-table-matches-summary-d1-b1", mini("_stopTableInvariant", D1, { routeIds: ["B1"] }));

// The mini trips.txt has no wheelchair_accessible column, so every trip is unknown; stops are S1 1, S2 2,
// S3 0, P1 inherits 1 from STN, R2 1, F2 0.
add("a5-stops-wheelchair-d1", mini("wheelchairByRoute", D1, {}));
add("a5-stops-wheelchair-d1-b1", mini("wheelchairByRoute", D1, { routeIds: ["B1"] }));
add("a5-stops-wheelchair-d3", mini("wheelchairByRoute", D3, {}));
add("a5-stops-wheelchair-unknown-date", mini("wheelchairByRoute", "20250101", {}));
// Inline feed with trip values: route A trips T1 1, T2 2, T3 1 (two frequency runs), T4 blank; route B T5 2.
// Stops X 1, Y 2, Z blank, W inherits 2 from its station P.
add("a5-stops-wheelchair-trip-values", inline({
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260105,20260201\n",
  "routes.txt": "route_id,agency_id,route_short_name\nA,M,A\nB,M,B\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding\nX,X,39.70,-105.00,0,,1\nY,Y,39.71,-105.00,0,,2\nZ,Z,39.72,-105.00,0,,\nP,P,39.73,-105.00,1,,2\nW,W,39.73,-105.00,0,P,\n",
  "trips.txt": "route_id,service_id,trip_id,direction_id,wheelchair_accessible\nA,WK,T1,0,1\nA,WK,T2,0,2\nA,WK,T3,0,1\nA,WK,T4,0,\nB,WK,T5,0,2\n",
  "frequencies.txt": "trip_id,start_time,end_time,headway_secs,exact_times\nT3,07:00:00,08:00:00,1800,0\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,06:00:00,06:00:00,X,1\nT1,06:10:00,06:10:00,Y,2\nT2,06:30:00,06:30:00,X,1\nT2,06:40:00,06:40:00,Z,2\nT3,07:00:00,07:00:00,X,1\nT3,07:10:00,07:10:00,Y,2\nT4,09:00:00,09:00:00,Y,1\nT4,09:10:00,09:10:00,Z,2\nT5,10:00:00,10:00:00,W,1\nT5,10:10:00,10:10:00,Z,2\n"
}, "wheelchairByRoute", D1, {}));

// A stop in the middle of route A that is route B's first stop is never removed, even when it is close.
const A5_END = {
  "routes.txt": "route_id,route_type\nA,3\nB,3\n",
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,0,0,20260105,20260201\n",
  "trips.txt": "route_id,service_id,trip_id\nA,W,a1\nB,W,b1\n",
  "stops.txt": "stop_id,stop_lat,stop_lon\nX1,39.7400,-104.9900\nX2,39.7400,-104.9895\nX3,39.7400,-104.9800\nX4,39.7500,-104.9800\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\na1,07:00:00,07:00:00,X1,1\na1,07:01:00,07:01:00,X2,2\na1,07:05:00,07:05:00,X3,3\nb1,08:00:00,08:00:00,X2,1\nb1,08:10:00,08:10:00,X4,2\n"
};
add("a5-stops-consolidation-other-route-end", inline(A5_END, "consolidationCandidates", D1, { maxFt: 99999 }));

// Feed health (feedHealth): one inline feed where each of the seven checks has a known answer.
// T5 has no stop times; T2 has a blank shape_id; T3 names a shape that is not in the set.
const HEALTH = {
  "agency.txt": "agency_id,agency_name\nA1,One\nA2,Two\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_type\nR_BUS,A1,10,3\nR_RAIL,,L,0\nR_FERRY, ,F,4\n",
  "stops.txt": "stop_id,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding\nP1,40.0,-105.0,1,,1\nS1,40.0,-105.0,0,P1,\nS2,40.0,-104.99,0,,2\nS3,40.0,-104.98,,,\nS4,40.01,-104.98,0,,0\nS5,40.5,-104.98,0,,1\n",
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,0,0,20260101,20260131\n",
  "trips.txt": "route_id,service_id,trip_id,shape_id\nR_BUS,SVC,T1,SH1\nR_BUS,SVC,T2,\nR_RAIL,SVC,T3,SH_X\nR_FERRY,SVC,T4,SH1\nR_BUS,SVC,T5,SH1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
    "T1,08:00:00,08:00:00,S1,1\nT1,08:02:00,08:02:00,S2,2\nT1,08:02:00,08:02:00,S3,3\n" +
    "T2,07:00:00,07:00:00,S1,1\nT2,,,S2,2\nT2,07:04:00,07:04:00,S3,3\n" +
    "T3,08:10:00,08:10:00,S2,1\nT3,08:20:00,08:20:00,S5,2\n" +
    "T4,09:00:00,09:00:00,S1,1\nT4,08:59:00,08:59:00,S2,2\nT4,09:05:30,09:05:30,S4,3\n"
};
const HEALTH_SHAPES = { SH1: [[-105.0, 40.0], [-104.98, 40.0]] };
const HEALTH_OPTS = { today: "20260105", shapes: HEALTH_SHAPES };
// Shapes of the mini feed as {shape_id: [[lon, lat], ...]}, points in shape_pt_sequence order.
const MINI_SHAPES = (() => {
  const byId = {};
  const rows = MINI["shapes.txt"].trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  for (const [id, lat, lon, seq] of rows) (byId[id] ||= []).push({ seq: +seq, pt: [+lon, +lat] });
  const out = {};
  for (const id in byId) out[id] = byId[id].sort((a, b) => a.seq - b.seq).map((p) => p.pt);
  return out;
})();

add("a7-health-inline", inline(HEALTH, "feedHealth", HEALTH_OPTS));
add("a7-health-inline-feedinfo", inline({ ...HEALTH, "feed_info.txt": "feed_publisher_name,feed_end_date\nP,20260110\n" }, "feedHealth", HEALTH_OPTS));
add("a7-health-expired", inline(HEALTH, "feedHealth", { today: "20260201", shapes: HEALTH_SHAPES }));
add("a7-health-far-future", inline(HEALTH, "feedHealth", { today: "20250101", shapes: HEALTH_SHAPES, maxExamples: 1 }));
add("a7-health-no-shapes", inline(HEALTH, "feedHealth", { today: "20260105" }));
add("a7-health-zero-examples", inline(HEALTH, "feedHealth", { today: "20260105", shapes: HEALTH_SHAPES, maxExamples: 0 }));
add("a7-health-one-agency", inline({ ...HEALTH, "agency.txt": "agency_id,agency_name\nA1,One\n" }, "feedHealth", HEALTH_OPTS));
add("a7-health-empty-feed", inline({}, "feedHealth", { today: "20260105" }));
add("a7-health-no-opts", inline(HEALTH, "feedHealth"));
add("a7-health-mini", mini("feedHealth", { today: "20260105", shapes: MINI_SHAPES }));

// serviceYearFromTrips must cost a feed's own trips exactly as serviceYear does (blocks included).
const A7_DATES = { weekday: D1, saturday: D3, sunday: null };
add("a7-serviceyear-from-trips-invariant", mini("_serviceYearInvariant", { dates: A7_DATES }));
add("a7-serviceyear-from-trips-invariant-b1", mini("_serviceYearInvariant", { dates: A7_DATES, routeIds: ["B1"], layover: { mode: "percent", value: 20 } }));
// Plain trips with no block: two 30-min trips on route X, 10-min layover per round trip (5 min each),
// 15 % deadhead. Running 1 h, layover 10 min, revenue 1 h 10 min, deadhead 9 min, platform 1 h 19 min.
add("a7-serviceyear-plain-trips", { call: "GtfsSchedule.serviceYearFromTrips", args: [
  { weekday: [{ tripId: "a", routeId: "X", start: 25200, end: 27000, blockId: "", generated: false },
              { tripId: "b", routeId: "X", start: 27000, end: 28800, blockId: "", generated: false }] },
  { dates: { weekday: "20260112" } }] });

export default { scripts: ["js/core/gtfs-schedule.js"], cases };
