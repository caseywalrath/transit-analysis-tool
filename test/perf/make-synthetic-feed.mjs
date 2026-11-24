#!/usr/bin/env node
// test/perf/make-synthetic-feed.mjs
//
// Writes a deterministic, RTD-sized fake GTFS feed as a ZIP so tests can load a
// large feed without downloading a real one. The PRNG seed and the ZIP entry
// timestamps are fixed, so the same arguments always produce a byte-identical
// file. See test/perf/README.md ("Synthetic feed").
//
// USAGE: node test/perf/make-synthetic-feed.mjs <out.zip> [--scale S]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import zlib from "node:zlib";

const USAGE = "Usage: node test/perf/make-synthetic-feed.mjs <out.zip> [--scale S]   (S: number > 0, default 1.0)";
const SEED = 12345;
// Service day in minutes after midnight: first trip 05:00, last start 24:30.
const SERVICE_START = 300;
const SERVICE_END = 1470;
// Time between consecutive stops in a run.
const SEGMENT_SEC = 90;
// Weekday headway range (minutes, drawn per route). Set so the row count lands
// near 800,000 stop_times rows at scale 1; a 10-30 min range would give ~1.6M.
const HEADWAY_MIN = 20;
const HEADWAY_MAX = 60;
// Frequency template window and headway.
const FREQ_START = 360;
const FREQ_END = 1320;
const FREQ_HEADWAY_SEC = 600;
const SERVICES = [
  { id: "WKDY", mult: 1 },
  { id: "SAT", mult: 2 },
  { id: "SUN", mult: 3 }
];
// Grid origin is the centre of the stop grid; spacing ~0.004 deg (about 440 m).
const CENTER_LAT = 39.74;
const CENTER_LON = -104.99;
const GRID_STEP = 0.004;
const METERS_PER_DEG = 111320;

function parseArgs(argv) {
  let out = null;
  let scale = 1.0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scale") {
      scale = Number(argv[++i]);
      if (!Number.isFinite(scale) || !(scale > 0)) return null;
    } else if (a.startsWith("--")) {
      return null;
    } else if (out === null) {
      out = a;
    } else {
      return null;
    }
  }
  return out === null ? null : { out, scale };
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error(USAGE);
  process.exit(2);
}

// ---- deterministic helpers ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const randHex = () => Math.floor(rng() * 0x1000000).toString(16).padStart(6, "0").toUpperCase();
const pad = (n, w) => String(n).padStart(w, "0");
const fmtTime = (sec) => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((v) => pad(v, 2)).join(":");
const scaled = (n) => Math.max(1, Math.round(n * args.scale));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP entries get a fixed 1980-01-01 00:00 timestamp so output is reproducible.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---- stop grid ----

const N_STOPS = scaled(9000);
const N_PARENTS = scaled(40);
const N_ROUTES = scaled(150);
const N_FREQ = scaled(5);
const COLS = Math.ceil(Math.sqrt(N_STOPS));
const ROWS = Math.ceil(N_STOPS / COLS);

function gridCoord(idx) {
  const r = Math.floor(idx / COLS);
  const c = idx % COLS;
  return { lat: CENTER_LAT + (r - ROWS / 2) * GRID_STEP, lon: CENTER_LON + (c - COLS / 2) * GRID_STEP };
}

const stopId = (idx) => "S" + pad(idx + 1, 5);
const WHEELCHAIR = [0, 1, 2, ""];

// Each parent station owns two grid stops (indices 2k and 2k+1) as platforms.
const parentOf = new Array(N_STOPS).fill(null);
const parentRows = [];
for (let k = 0; k < N_PARENTS; k++) {
  const a = 2 * k;
  const b = 2 * k + 1;
  const pid = "PS" + pad(k + 1, 3);
  parentOf[a] = pid;
  parentOf[b] = pid;
  const ca = gridCoord(a);
  const cb = gridCoord(b);
  parentRows.push(
    `${pid},Station ${pad(k + 1, 3)},${((ca.lat + cb.lat) / 2).toFixed(6)},${((ca.lon + cb.lon) / 2).toFixed(6)},1,,${WHEELCHAIR[k % 4]},`
  );
}

// Random walk over the grid. Never steps straight back onto the previous stop.
function walkPattern(len) {
  const seq = [];
  let cur = Math.floor(rng() * N_STOPS);
  let prev = -1;
  seq.push(cur);
  while (seq.length < len) {
    const r = Math.floor(cur / COLS);
    const c = cur % COLS;
    const cand = [];
    if (c > 0) cand.push(cur - 1);
    if (c < COLS - 1 && cur + 1 < N_STOPS) cand.push(cur + 1);
    if (r > 0) cand.push(cur - COLS);
    if (cur + COLS < N_STOPS) cand.push(cur + COLS);
    if (cand.length === 0) cand.push(cur); // single-stop grid only
    let pool = cand.filter((x) => x !== prev);
    if (pool.length === 0) pool = cand;
    prev = cur;
    cur = pool[Math.floor(rng() * pool.length)];
    seq.push(cur);
  }
  return seq;
}

// ---- routes, patterns and trips ----

const routeRows = [];
const tripRows = [];
const stopTimeRows = [];
const shapeRows = [];
const frequencyRows = [];

function addShape(shapeId, pattern) {
  let dist = 0;
  let prev = null;
  pattern.forEach((idx, i) => {
    const p = gridCoord(idx);
    if (prev) {
      const dy = (p.lat - prev.lat) * METERS_PER_DEG;
      const dx = (p.lon - prev.lon) * METERS_PER_DEG * Math.cos((p.lat * Math.PI) / 180);
      dist += Math.hypot(dx, dy);
    }
    shapeRows.push(`${shapeId},${p.lat.toFixed(6)},${p.lon.toFixed(6)},${i + 1},${dist.toFixed(2)}`);
    prev = p;
  });
}

// Stop times are offsets from the trip start. Every 7th stop (never first or
// last) has no times and timepoint 0, like the real-feed quirk it mirrors.
function addStopTimes(tripId, startSec, pattern) {
  const L = pattern.length;
  for (let j = 0; j < L; j++) {
    const sid = stopId(pattern[j]);
    const seq = j + 1;
    if ((j + 1) % 7 === 0 && j < L - 1) {
      stopTimeRows.push(`${tripId},,,${sid},${seq},0`);
    } else {
      const t = fmtTime(startSec + j * SEGMENT_SEC);
      stopTimeRows.push(`${tripId},${t},${t},${sid},${seq},1`);
    }
  }
}

const DIRS = [0, 1];

for (let k = 1; k <= N_ROUTES; k++) {
  const rid = "R" + pad(k, 3);
  const type = k <= 10 ? 0 : 3;
  routeRows.push(`${rid},SYN,${rid},Route ${rid},${type},${randHex()}`);
  const headway = randInt(HEADWAY_MIN, HEADWAY_MAX);
  const patterns = DIRS.map(() => walkPattern(randInt(30, 60)));
  for (const dir of DIRS) addShape(`${rid}-${dir}`, patterns[dir]);

  for (const svc of SERVICES) {
    const step = headway * svc.mult;
    let seq = 0;
    for (let t = SERVICE_START; t <= SERVICE_END; t += step) {
      seq++;
      for (const dir of DIRS) {
        const tripId = `${rid}-${dir}-${svc.id}-${pad(seq, 4)}`;
        const blockId = `${rid}-${dir}-${svc.id}-B${pad(Math.floor((seq - 1) / 6) + 1, 3)}`;
        tripRows.push(`${rid},${svc.id},${tripId},${dir},${blockId},${rid}-${dir}`);
        addStopTimes(tripId, t * 60, patterns[dir]);
      }
    }
  }
}

// Frequency routes: one template trip per direction, repeated by frequencies.txt.
for (let k = 1; k <= N_FREQ; k++) {
  const fid = "F" + pad(k, 2);
  routeRows.push(`${fid},SYN,${fid},Frequency route ${fid},3,${randHex()}`);
  const exact = k <= 3 ? 0 : 1;
  for (const dir of DIRS) {
    const pattern = walkPattern(randInt(30, 60));
    addShape(`${fid}-${dir}`, pattern);
    const tripId = `${fid}-${dir}-TPL`;
    tripRows.push(`${fid},WKDY,${tripId},${dir},,${fid}-${dir}`);
    addStopTimes(tripId, FREQ_START * 60, pattern);
    frequencyRows.push(`${tripId},${fmtTime(FREQ_START * 60)},${fmtTime(FREQ_END * 60)},${FREQ_HEADWAY_SEC},${exact}`);
  }
}

// ---- feed files ----

const stopHeader = "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding,platform_note";
const stopLines = [];
for (let i = 0; i < N_STOPS; i++) {
  const c = gridCoord(i);
  stopLines.push(
    `${stopId(i)},Grid ${i + 1},${c.lat.toFixed(6)},${c.lon.toFixed(6)},0,${parentOf[i] || ""},${WHEELCHAIR[i % 4]},`
  );
}
stopLines.push(...parentRows);

const calendarText =
  [
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    "WKDY,1,1,1,1,1,0,0,20260105,20260628",
    "SAT,0,0,0,0,0,1,0,20260105,20260628",
    "SUN,0,0,0,0,0,0,1,20260105,20260628"
  ].join("\r\n") + "\r\n";

const calendarDatesText = [
  "service_id,date,exception_type",
  "WKDY,20260119,2",
  "SUN,20260119,1",
  "WKDY,20260525,2",
  "SUN,20260525,1"
].join("\n") + "\n";

const files = [
  {
    name: "agency.txt",
    data: "agency_id,agency_name,agency_url,agency_timezone\nSYN,Synthetic Transit,https://example.invalid/,America/Denver\n"
  },
  { name: "stops.txt", data: "﻿" + stopHeader + "\n" + stopLines.join("\n") + "\n" },
  { name: "routes.txt", data: "route_id,agency_id,route_short_name,route_long_name,route_type,route_color\n" + routeRows.join("\n") + "\n" },
  { name: "calendar.txt", data: calendarText },
  { name: "calendar_dates.txt", data: calendarDatesText },
  { name: "trips.txt", data: "route_id,service_id,trip_id,direction_id,block_id,shape_id\n" + tripRows.join("\n") + "\n" },
  { name: "stop_times.txt", data: "trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint\n" + stopTimeRows.join("\n") + "\n" },
  { name: "shapes.txt", data: "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n" + shapeRows.join("\n") + "\n" },
  { name: "frequencies.txt", data: "trip_id,start_time,end_time,headway_secs,exact_times\n" + frequencyRows.join("\n") + "\n" }
];

const zip = buildZip(files);
mkdirSync(dirname(resolve(args.out)), { recursive: true });
writeFileSync(args.out, zip);
console.log(`WROTE ${args.out} ${zip.length} bytes, ${stopTimeRows.length} stop_times rows`);
