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

export default { scripts: ["js/core/gtfs-schedule.js"], cases };
