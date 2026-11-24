// GTFS schedule engine (window.GtfsSchedule): pure functions that turn GTFS text tables into a
// compact in-memory feed and answer "what runs on date X" questions.
//
// Conventions every function here relies on:
//   - Dates are 8-character strings "YYYYMMDD".
//   - Times are integer seconds after the service day's midnight, so 25:10:00 is 90600 and a trip
//     that runs past midnight still belongs to the date its service runs (GTFS rule, plan D4).
//   - -1 means "missing time". Blank times are never guessed unless a caller asks to interpolate,
//     and interpolation uses great-circle distance, never shape_dist_traveled (plan D5).
//   - Bad data is counted (feed.problems, store.badRows) and skipped; nothing here throws on it.
//
// stop_times.txt is the one big table, so it is stored as parallel typed arrays sorted by
// (trip, sequence) with an offset table; every other file stays as small row objects.
// No DOM, App, map, turf, Papa or JSZip: the golden harness loads this file alone.
(function () {
  "use strict";

  var DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  var DEFAULT_LAYOVER_SEC = 600;

  // ---------------------------------------------------------------- time

  function digits(s, from, to) {
    var n = 0;
    for (var i = from; i < to; i++) {
      var c = s.charCodeAt(i) - 48;
      if (c < 0 || c > 9) return -1;
      n = n * 10 + c;
    }
    return n;
  }

  function parseTime(s) {
    if (typeof s !== "string") return -1;
    var len = s.length;
    if (len === 0) return -1;
    var h, m, sec;
    // Fast path for the two standard shapes; stop_times has millions of these.
    if (len === 8 && s.charCodeAt(2) === 58 && s.charCodeAt(5) === 58) {
      h = digits(s, 0, 2); m = digits(s, 3, 5); sec = digits(s, 6, 8);
    } else if (len === 7 && s.charCodeAt(1) === 58 && s.charCodeAt(4) === 58) {
      h = digits(s, 0, 1); m = digits(s, 2, 4); sec = digits(s, 5, 7);
    } else {
      var t = s.replace(/^\s+|\s+$/g, "");
      if (t === s || t.length === 0) {
        // Hours may exceed two digits in odd feeds; accept the general H+:MM:SS shape.
        var g = /^(\d+):(\d{2}):(\d{2})$/.exec(t);
        if (!g) return -1;
        h = +g[1]; m = +g[2]; sec = +g[3];
      } else {
        return parseTime(t);
      }
    }
    if (h < 0 || m < 0 || sec < 0 || m > 59 || sec > 59) return -1;
    return h * 3600 + m * 60 + sec;
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function formatTime(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "";
    sec = Math.round(sec);
    return pad2(Math.floor(sec / 3600)) + ":" + pad2(Math.floor((sec % 3600) / 60)) + ":" + pad2(sec % 60);
  }

  // ---------------------------------------------------------------- CSV

  // Streaming RFC 4180 reader. State lives on the instance so a chunk may end anywhere,
  // including inside a quote or between a CR and its LF.
  function CsvStream(onHeader, onRow) {
    this._onHeader = onHeader;
    this._onRow = onRow;
    this._header = null;
    this._width = 0;
    this._record = [];
    this._field = "";
    this._inQuotes = false;
    this._afterQuote = false;   // a closing quote was just read; a second quote makes it an escaped one
    this._atFieldStart = true;
    this._pendingCR = false;    // the last char was CR, so an LF next belongs to the same line end
    this._first = true;
  }

  CsvStream.prototype._endField = function () {
    this._record.push(this._field);
    this._field = "";
    this._atFieldStart = true;
    this._afterQuote = false;
  };

  CsvStream.prototype._endRecord = function () {
    var rec = this._record;
    this._record = [];
    var i, any = false;
    for (i = 0; i < rec.length; i++) { if (rec[i] !== "") { any = true; break; } }
    if (!any) return;
    if (this._header === null) {
      for (i = 0; i < rec.length; i++) rec[i] = rec[i].replace(/^\s+|\s+$/g, "");
      this._header = rec;
      this._width = rec.length;
      if (this._onHeader) this._onHeader(rec.slice());
      return;
    }
    while (rec.length < this._width) rec.push("");
    if (rec.length > this._width) rec.length = this._width;
    if (this._onRow) this._onRow(rec);
  };

  CsvStream.prototype.write = function (text) {
    if (typeof text !== "string" || text.length === 0) return;
    if (this._first) {
      this._first = false;
      if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
    }
    var n = text.length, seg = 0, i, c;
    for (i = 0; i < n; i++) {
      c = text.charCodeAt(i);
      if (this._pendingCR) {
        this._pendingCR = false;
        if (c === 10) { seg = i + 1; continue; }
      }
      if (this._inQuotes) {
        if (c === 34) {
          this._field += text.substring(seg, i);
          this._inQuotes = false;
          this._afterQuote = true;
          seg = i + 1;
        }
        continue;
      }
      if (this._afterQuote) {
        if (c === 34) {
          this._field += '"';
          this._inQuotes = true;
          this._afterQuote = false;
          seg = i + 1;
          continue;
        }
        this._afterQuote = false;
      }
      if (c === 44) {
        this._field += text.substring(seg, i);
        this._endField();
        seg = i + 1;
      } else if (c === 10 || c === 13) {
        this._field += text.substring(seg, i);
        this._endField();
        this._endRecord();
        seg = i + 1;
        if (c === 13) this._pendingCR = true;
      } else if (c === 34 && this._atFieldStart) {
        this._inQuotes = true;
        this._atFieldStart = false;
        seg = i + 1;
      } else {
        this._atFieldStart = false;
      }
    }
    this._field += text.substring(seg, n);
  };

  CsvStream.prototype.end = function () {
    if (this._record.length > 0 || this._field.length > 0) {
      this._endField();
      this._endRecord();
    }
    this._inQuotes = false;
    this._afterQuote = false;
    this._pendingCR = false;
  };

  function parseCSV(text) {
    var headers = [], rows = [];
    var cs = new CsvStream(function (h) { headers = h; }, function (vals) {
      var o = {};
      for (var i = 0; i < headers.length; i++) o[headers[i]] = vals[i];
      rows.push(o);
    });
    cs.write(text);
    cs.end();
    return { headers: headers, rows: rows };
  }

  // Test helper: feed pre-split chunks, return arrays of strings.
  function _csvChunks(chunks) {
    var headers = [], rows = [];
    var cs = new CsvStream(function (h) { headers = h; }, function (v) { rows.push(v.slice()); });
    for (var i = 0; i < chunks.length; i++) cs.write(chunks[i]);
    cs.end();
    return { headers: headers, rows: rows };
  }

  // ---------------------------------------------------------------- stop_times store

  function StopTimesBuilder() {
    this._cap = 65536;
    this._n = 0;
    this._trip = new Int32Array(this._cap);
    this._stop = new Int32Array(this._cap);
    this._seq = new Int32Array(this._cap);
    this._arr = new Int32Array(this._cap);
    this._dep = new Int32Array(this._cap);
    this._tp = new Uint8Array(this._cap);
    this.tripIds = [];
    this.stopIds = [];
    this._tripLookup = Object.create(null);
    this._stopLookup = Object.create(null);
    this._badRows = 0;
    this._col = null;
  }

  StopTimesBuilder.prototype.header = function (fields) {
    function at(name) { return fields.indexOf(name); }
    this._col = {
      trip: at("trip_id"), arr: at("arrival_time"), dep: at("departure_time"),
      stop: at("stop_id"), seq: at("stop_sequence"), tp: at("timepoint")
    };
  };

  StopTimesBuilder.prototype._grow = function () {
    var cap = this._cap * 2, n = this._n;
    function g(old, Ctor) { var a = new Ctor(cap); a.set(old.subarray(0, n)); return a; }
    this._trip = g(this._trip, Int32Array);
    this._stop = g(this._stop, Int32Array);
    this._seq = g(this._seq, Int32Array);
    this._arr = g(this._arr, Int32Array);
    this._dep = g(this._dep, Int32Array);
    this._tp = g(this._tp, Uint8Array);
    this._cap = cap;
  };

  var INT_RE = /^-?\d+$/;

  StopTimesBuilder.prototype.row = function (v) {
    var c = this._col;
    if (!c) return;
    var tripId = c.trip >= 0 ? v[c.trip].replace(/^\s+|\s+$/g, "") : "";
    var stopId = c.stop >= 0 ? v[c.stop].replace(/^\s+|\s+$/g, "") : "";
    var seqText = c.seq >= 0 ? v[c.seq].replace(/^\s+|\s+$/g, "") : "";
    if (tripId === "" || stopId === "" || !INT_RE.test(seqText)) { this._badRows++; return; }
    var ti = this._tripLookup[tripId];
    if (ti === undefined) { ti = this.tripIds.length; this.tripIds.push(tripId); this._tripLookup[tripId] = ti; }
    var si = this._stopLookup[stopId];
    if (si === undefined) { si = this.stopIds.length; this.stopIds.push(stopId); this._stopLookup[stopId] = si; }
    var a = c.arr >= 0 ? parseTime(v[c.arr]) : -1;
    var d = c.dep >= 0 ? parseTime(v[c.dep]) : -1;
    if (a < 0) a = d; else if (d < 0) d = a;
    var tp = 255;
    if (c.tp >= 0) {
      var t = v[c.tp].replace(/^\s+|\s+$/g, "");
      if (t === "1") tp = 1; else if (t === "0") tp = 0;
    }
    if (this._n === this._cap) this._grow();
    var k = this._n++;
    this._trip[k] = ti; this._stop[k] = si; this._seq[k] = +seqText;
    this._arr[k] = a; this._dep[k] = d; this._tp[k] = tp;
  };

  StopTimesBuilder.prototype.finish = function () {
    var n = this._n, nTrips = this.tripIds.length, i, k;
    var trip = this._trip, seq = this._seq;

    // Counting sort by trip (rows of one trip stay in read order), then a stable insertion sort by
    // sequence inside each trip. Feeds are nearly sorted, so this is close to linear.
    var start = new Int32Array(nTrips + 1);
    for (i = 0; i < n; i++) start[trip[i] + 1]++;
    for (i = 0; i < nTrips; i++) start[i + 1] += start[i];
    var fill = start.slice(0, nTrips);
    var perm = new Int32Array(n);
    for (i = 0; i < n; i++) perm[fill[trip[i]]++] = i;
    for (var t = 0; t < nTrips; t++) {
      for (i = start[t] + 1; i < start[t + 1]; i++) {
        var p = perm[i], key = seq[p];
        k = i - 1;
        while (k >= start[t] && seq[perm[k]] > key) { perm[k + 1] = perm[k]; k--; }
        perm[k + 1] = p;
      }
    }

    // A duplicate (trip, sequence) keeps the first row read; the stable sort puts it first.
    var keep = new Uint8Array(n), kept = 0, dups = 0;
    for (t = 0; t < nTrips; t++) {
      for (i = start[t]; i < start[t + 1]; i++) {
        if (i > start[t] && seq[perm[i]] === seq[perm[i - 1]]) { dups++; continue; }
        keep[i] = 1; kept++;
      }
    }
    var out = {
      tripIds: this.tripIds, stopIds: this.stopIds,
      trip: new Int32Array(kept), stop: new Int32Array(kept), seq: new Int32Array(kept),
      arr: new Int32Array(kept), dep: new Int32Array(kept), tp: new Uint8Array(kept),
      tripStart: new Int32Array(nTrips + 1),
      rowCount: kept, badRows: this._badRows, duplicateRows: dups
    };
    var w = 0;
    for (t = 0; t < nTrips; t++) {
      out.tripStart[t] = w;
      for (i = start[t]; i < start[t + 1]; i++) {
        if (!keep[i]) continue;
        var r = perm[i];
        out.trip[w] = trip[r]; out.stop[w] = this._stop[r]; out.seq[w] = seq[r];
        out.arr[w] = this._arr[r]; out.dep[w] = this._dep[r]; out.tp[w] = this._tp[r];
        w++;
      }
    }
    out.tripStart[nTrips] = w;
    return out;
  };

  // ---------------------------------------------------------------- feed

  var EMPTY_TABLE = { headers: [], rows: [] };

  function g(row, key) {
    var v = row[key];
    return typeof v === "string" ? v.replace(/^\s+|\s+$/g, "") : "";
  }

  function isDate(s) { return /^\d{8}$/.test(s); }

  function toNum(s) {
    if (s === "") return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function emptyStore() {
    return new StopTimesBuilder().finish();
  }

  function buildFeed(tables, stopTimesStore) {
    tables = tables || {};
    var st = stopTimesStore || emptyStore();
    function tbl(name) { return tables[name] || EMPTY_TABLE; }
    var problems = {
      tripsUnknownRoute: 0, tripsUnknownService: 0,
      stopTimesUnknownTrip: 0, stopTimesUnknownStop: 0, calendarEndBeforeStart: 0
    };
    var i, r, rows;

    var routes = Object.create(null);
    rows = tbl("routes.txt").rows;
    for (i = 0; i < rows.length; i++) { r = g(rows[i], "route_id"); if (r !== "" && !routes[r]) routes[r] = rows[i]; }

    var stops = Object.create(null);
    rows = tbl("stops.txt").rows;
    for (i = 0; i < rows.length; i++) {
      var sid = g(rows[i], "stop_id");
      if (sid === "" || stops[sid]) continue;
      stops[sid] = {
        id: sid, lat: toNum(g(rows[i], "stop_lat")), lon: toNum(g(rows[i], "stop_lon")),
        parent: g(rows[i], "parent_station"), locationType: g(rows[i], "location_type"),
        wheelchair: g(rows[i], "wheelchair_boarding"), children: []
      };
    }
    for (var key in stops) {
      var p = stops[key].parent;
      if (p !== "" && stops[p]) stops[p].children.push(key);
    }

    var cal = [], services = Object.create(null);
    rows = tbl("calendar.txt").rows;
    var calById = Object.create(null);
    for (i = 0; i < rows.length; i++) {
      var csid = g(rows[i], "service_id");
      if (csid === "") continue;
      services[csid] = true;
      var s0 = g(rows[i], "start_date"), e0 = g(rows[i], "end_date");
      if (!isDate(s0) || !isDate(e0)) continue;
      if (e0 < s0) { problems.calendarEndBeforeStart++; continue; }
      calById[csid] = {
        id: csid, start: s0, end: e0,
        days: [g(rows[i], "sunday") === "1", g(rows[i], "monday") === "1", g(rows[i], "tuesday") === "1",
               g(rows[i], "wednesday") === "1", g(rows[i], "thursday") === "1", g(rows[i], "friday") === "1",
               g(rows[i], "saturday") === "1"]
      };
    }
    for (var cid in calById) cal.push(calById[cid]);

    var cd = Object.create(null);
    rows = tbl("calendar_dates.txt").rows;
    for (i = 0; i < rows.length; i++) {
      var dsid = g(rows[i], "service_id"), dd = g(rows[i], "date"), et = g(rows[i], "exception_type");
      if (dsid === "" || !isDate(dd) || (et !== "1" && et !== "2")) continue;
      services[dsid] = true;
      var slot = cd[dd] || (cd[dd] = { add: [], rem: [] });
      (et === "1" ? slot.add : slot.rem).push(dsid);
    }

    var freqs = Object.create(null);
    rows = tbl("frequencies.txt").rows;
    for (i = 0; i < rows.length; i++) {
      var ftid = g(rows[i], "trip_id");
      var fs = parseTime(g(rows[i], "start_time")), fe = parseTime(g(rows[i], "end_time"));
      var hw = parseInt(g(rows[i], "headway_secs"), 10);
      if (ftid === "" || fs < 0 || fe < 0 || !(hw > 0)) continue;
      (freqs[ftid] || (freqs[ftid] = [])).push({
        start: fs, end: fe, headway: hw, exact: g(rows[i], "exact_times") === "1" ? 1 : 0
      });
    }

    var tripIdx = Object.create(null);
    for (i = 0; i < st.tripIds.length; i++) tripIdx[st.tripIds[i]] = i;
    var stopIdx = Object.create(null);
    for (i = 0; i < st.stopIds.length; i++) stopIdx[st.stopIds[i]] = i;

    var trips = [], tripsById = Object.create(null);
    rows = tbl("trips.txt").rows;
    for (i = 0; i < rows.length; i++) {
      var tid = g(rows[i], "trip_id");
      if (tid === "" || tripsById[tid]) continue;
      var rec = {
        id: tid, routeId: g(rows[i], "route_id"), serviceId: g(rows[i], "service_id"),
        directionId: g(rows[i], "direction_id"), blockId: g(rows[i], "block_id"),
        shapeId: g(rows[i], "shape_id"), wheelchair: g(rows[i], "wheelchair_accessible"),
        ti: tripIdx[tid] === undefined ? -1 : tripIdx[tid],
        freq: freqs[tid] || null, routeOk: !!routes[g(rows[i], "route_id")]
      };
      if (!rec.routeOk) problems.tripsUnknownRoute++;
      if (!services[rec.serviceId]) problems.tripsUnknownService++;
      tripsById[tid] = rec;
      trips.push(rec);
    }

    for (i = 0; i < st.tripIds.length; i++) {
      if (!tripsById[st.tripIds[i]]) problems.stopTimesUnknownTrip += st.tripStart[i + 1] - st.tripStart[i];
    }
    for (i = 0; i < st.rowCount; i++) {
      if (!stops[st.stopIds[st.stop[i]]]) problems.stopTimesUnknownStop++;
    }

    return {
      tables: tables, st: st, problems: problems,
      _trips: trips, _tripsById: tripsById, _routes: routes, _stops: stops,
      _cal: cal, _cd: cd, _services: services, _tripIdx: tripIdx, _stopIdx: stopIdx,
      _range: undefined, _active: Object.create(null), _days: Object.create(null), _dayKeys: []
    };
  }

  function feedFromTexts(texts) {
    texts = texts || {};
    var tables = {}, b = new StopTimesBuilder();
    for (var name in texts) {
      if (name === "stop_times.txt") {
        var cs = new CsvStream(b.header.bind(b), b.row.bind(b));
        cs.write(texts[name]);
        cs.end();
      } else {
        tables[name] = parseCSV(texts[name]);
      }
    }
    return buildFeed(tables, b.finish());
  }

  // ---------------------------------------------------------------- dates

  function weekdayIndex(date) {
    return new Date(Date.UTC(+date.substring(0, 4), +date.substring(4, 6) - 1, +date.substring(6, 8))).getUTCDay();
  }

  function addDays(date, n) {
    var d = new Date(Date.UTC(+date.substring(0, 4), +date.substring(4, 6) - 1, +date.substring(6, 8) + n));
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  }

  function dateRange(feed) {
    if (feed._range !== undefined) return feed._range;
    var lo = null, hi = null, i;
    function see(d) { if (lo === null || d < lo) lo = d; if (hi === null || d > hi) hi = d; }
    for (i = 0; i < feed._cal.length; i++) { see(feed._cal[i].start); see(feed._cal[i].end); }
    for (var d in feed._cd) see(d);
    feed._range = lo === null ? null : { start: lo, end: hi };
    return feed._range;
  }

  // Services the weekly calendar alone runs on that date.
  function calendarRun(feed, date) {
    var wd = weekdayIndex(date), out = Object.create(null);
    for (var i = 0; i < feed._cal.length; i++) {
      var c = feed._cal[i];
      if (date >= c.start && date <= c.end && c.days[wd]) out[c.id] = true;
    }
    return out;
  }

  function activeServices(feed, date) {
    var hit = feed._active[date];
    if (hit) return hit.slice();
    var set = isDate(date) ? calendarRun(feed, date) : Object.create(null);
    var x = feed._cd[date], i;
    if (x) {
      for (i = 0; i < x.add.length; i++) set[x.add[i]] = true;
      for (i = 0; i < x.rem.length; i++) delete set[x.rem[i]];
    }
    var list = Object.keys(set).sort();
    feed._active[date] = list;
    return list.slice();
  }

  function dayType(feed, date) {
    var wd = weekdayIndex(date);
    var run = calendarRun(feed, date), x = feed._cd[date], exception = false;
    if (x) {
      if (x.add.length > 0) exception = true;
      for (var i = 0; i < x.rem.length && !exception; i++) if (run[x.rem[i]]) exception = true;
    }
    return {
      date: date, weekday: DAY_NAMES[wd],
      dayType: wd === 0 ? "sunday" : wd === 6 ? "saturday" : "weekday",
      exception: exception
    };
  }

  // ---------------------------------------------------------------- trips on a date

  function dayEntries(feed, date) {
    var cached = feed._days[date];
    if (cached) return cached;
    var active = activeServices(feed, date), set = Object.create(null), i, j, k;
    for (i = 0; i < active.length; i++) set[active[i]] = true;
    var st = feed.st, entries = [], invalid = [];
    for (i = 0; i < feed._trips.length; i++) {
      var t = feed._trips[i];
      if (!t.routeOk || t.ti < 0 || !set[t.serviceId]) continue;
      var a = st.tripStart[t.ti], b = st.tripStart[t.ti + 1];
      if (b <= a) continue;
      var start = st.dep[a], end = st.arr[b - 1];
      if (start < 0 || end < 0) { invalid.push(t.id); continue; }
      if (t.freq) {
        var dur = end - start, seen = Object.create(null);
        for (j = 0; j < t.freq.length; j++) {
          var w = t.freq[j];
          for (k = w.start; k < w.end; k += w.headway) {
            var gid = t.id + "@" + formatTime(k);
            if (seen[gid]) continue;
            seen[gid] = true;
            entries.push({ ti: t.ti, off: k - start, trip: {
              tripId: gid, routeId: t.routeId, directionId: t.directionId, blockId: t.blockId,
              serviceId: t.serviceId, shapeId: t.shapeId, start: k, end: k + dur,
              generated: true, templateId: t.id, exactTimes: w.exact
            } });
          }
        }
      } else {
        entries.push({ ti: t.ti, off: 0, trip: {
          tripId: t.id, routeId: t.routeId, directionId: t.directionId, blockId: t.blockId,
          serviceId: t.serviceId, shapeId: t.shapeId, start: start, end: end,
          generated: false, templateId: null, exactTimes: null
        } });
      }
    }
    entries.sort(function (p, q) {
      if (p.trip.start !== q.trip.start) return p.trip.start - q.trip.start;
      return p.trip.tripId < q.trip.tripId ? -1 : p.trip.tripId > q.trip.tripId ? 1 : 0;
    });
    invalid.sort();
    var res = { date: date, entries: entries, invalid: invalid };
    // Keep only a few dates: busiestDate walks a whole year and each entry list can be large.
    if (feed._dayKeys.length >= 6) delete feed._days[feed._dayKeys.shift()];
    feed._dayKeys.push(date);
    feed._days[date] = res;
    return res;
  }

  function routeFilter(opts) {
    if (!opts || !opts.routeIds) return null;
    var m = Object.create(null);
    for (var i = 0; i < opts.routeIds.length; i++) m[opts.routeIds[i]] = true;
    return m;
  }

  function filteredEntries(feed, date, opts) {
    var day = dayEntries(feed, date), f = routeFilter(opts);
    if (!f) return day.entries;
    return day.entries.filter(function (e) { return f[e.trip.routeId]; });
  }

  function tripsOnDate(feed, date, opts) {
    var day = dayEntries(feed, date), ents = filteredEntries(feed, date, opts);
    var f = routeFilter(opts), invalid = day.invalid;
    if (f) invalid = invalid.filter(function (id) { return f[feed._tripsById[id].routeId]; });
    return {
      date: date,
      trips: ents.map(function (e) { return e.trip; }),
      invalid: invalid.slice()
    };
  }

  // ---------------------------------------------------------------- stop times of one trip

  function haversine(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Arrival/departure arrays for the rows of store trip `ti`, optionally with blank intermediate
  // times filled by distance between the neighbouring timed stops. Without blanks (the common
  // case) these are zero-copy views of the store.
  function timesFor(feed, ti, interpolate) {
    var st = feed.st, a = st.tripStart[ti], b = st.tripStart[ti + 1], n = b - a, i;
    var arr = st.arr.subarray(a, b), dep = st.dep.subarray(a, b);
    if (!interpolate) return { arr: arr, dep: dep, interp: null, n: n, a: a };
    var blank = false;
    for (i = 0; i < n; i++) if (arr[i] < 0 || dep[i] < 0) { blank = true; break; }
    if (!blank) return { arr: arr, dep: dep, interp: null, n: n, a: a };
    var A = [], D = [], interp = [];
    for (i = 0; i < n; i++) { A.push(arr[i]); D.push(dep[i]); interp.push(false); }
    i = 0;
    while (i < n) {
      if (D[i] >= 0 && A[i] >= 0) { i++; continue; }
      var j = i;
      while (j < n && (A[j] < 0 || D[j] < 0)) j++;
      if (i === 0 || j >= n) { i = j; continue; }   // no timed neighbour on one side: leave blank
      var pts = [], ok = true, k;
      for (k = i - 1; k <= j; k++) {
        var s = feed._stops[st.stopIds[st.stop[a + k]]];
        if (!s || s.lat === null || s.lon === null) { ok = false; break; }
        pts.push(s);
      }
      var cum = [0], total = 0;
      if (ok) {
        for (k = 1; k < pts.length; k++) {
          total += haversine(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);
          cum.push(total);
        }
      }
      var t0 = D[i - 1], t1 = A[j];
      for (k = i; k < j; k++) {
        var frac = ok && total > 0 ? cum[k - i + 1] / total : (k - i + 1) / (j - i + 1);
        var tv = Math.round(t0 + (t1 - t0) * frac);
        A[k] = tv; D[k] = tv; interp[k] = true;
      }
      i = j;
    }
    return { arr: A, dep: D, interp: interp, n: n, a: a };
  }

  function tripStopTimes(feed, tripId, opts) {
    var rec = feed._tripsById[tripId], off = 0, ti;
    if (rec) {
      ti = rec.ti;
    } else {
      var at = tripId.lastIndexOf("@");
      if (at < 0) return [];
      var base = feed._tripsById[tripId.substring(0, at)];
      var when = parseTime(tripId.substring(at + 1));
      if (!base || !base.freq || when < 0 || base.ti < 0) return [];
      ti = base.ti;
      off = when - feed.st.dep[feed.st.tripStart[ti]];
    }
    if (ti < 0) return [];
    var tf = timesFor(feed, ti, !!(opts && opts.interpolate)), st = feed.st, out = [];
    for (var i = 0; i < tf.n; i++) {
      var r = tf.a + i, tp = st.tp[r];
      out.push({
        stopId: st.stopIds[st.stop[r]], seq: st.seq[r],
        arr: tf.arr[i] >= 0 ? tf.arr[i] + off : -1,
        dep: tf.dep[i] >= 0 ? tf.dep[i] + off : -1,
        timepoint: tp === 255 ? -1 : tp,
        interpolated: !!(tf.interp && tf.interp[i])
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- departures and headways

  function departuresAtStop(feed, date, stopId) {
    var st = feed.st, ids = [stopId], i;
    var s = feed._stops[stopId];
    if (s) for (i = 0; i < s.children.length; i++) ids.push(s.children[i]);
    var mask = new Uint8Array(st.stopIds.length), any = false;
    for (i = 0; i < ids.length; i++) {
      var ix = feed._stopIdx[ids[i]];
      if (ix !== undefined) { mask[ix] = 1; any = true; }
    }
    if (!any) return [];
    var ents = dayEntries(feed, date).entries, out = [];
    for (i = 0; i < ents.length; i++) {
      var e = ents[i], a = st.tripStart[e.ti], b = st.tripStart[e.ti + 1];
      var tf = null;
      for (var r = a; r < b - 1; r++) {
        if (!mask[st.stop[r]]) continue;
        if (tf === null) tf = timesFor(feed, e.ti, true);
        var d = tf.dep[r - a];
        if (d >= 0) out.push(d + e.off);
      }
    }
    out.sort(function (p, q) { return p - q; });
    return out;
  }

  function medianHeadway(feed, date, stopId, fromSec, toSec) {
    var deps = departuresAtStop(feed, date, stopId).filter(function (t) { return t >= fromSec && t < toSec; });
    if (deps.length < 2) return null;
    var gaps = [];
    for (var i = 1; i < deps.length; i++) gaps.push(deps[i] - deps[i - 1]);
    gaps.sort(function (p, q) { return p - q; });
    var m = gaps.length;
    return m % 2 === 1 ? gaps[(m - 1) / 2] : (gaps[m / 2 - 1] + gaps[m / 2]) / 2;
  }

  // ---------------------------------------------------------------- patterns

  function patterns(feed, date, routeId) {
    var ents = filteredEntries(feed, date, { routeIds: [routeId] }), st = feed.st;
    var byKey = Object.create(null), list = [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i], stopsList = [];
      for (var r = st.tripStart[e.ti]; r < st.tripStart[e.ti + 1]; r++) stopsList.push(st.stopIds[st.stop[r]]);
      var key = e.trip.directionId + "|" + stopsList.join(",");
      var p = byKey[key];
      if (!p) { p = byKey[key] = { directionId: e.trip.directionId, stops: stopsList, trips: 0 }; list.push(p); }
      p.trips++;
    }
    list.sort(function (p, q) {
      if (p.trips !== q.trips) return q.trips - p.trips;
      if (p.stops.length !== q.stops.length) return q.stops.length - p.stops.length;
      if (p.directionId !== q.directionId) return p.directionId < q.directionId ? -1 : 1;
      var ps = p.stops.join(","), qs = q.stops.join(",");
      return ps < qs ? -1 : ps > qs ? 1 : 0;
    });
    return list;
  }

  function dominantPattern(feed, date, routeId, directionId) {
    var list = patterns(feed, date, routeId);
    var any = directionId === null || directionId === undefined;
    for (var i = 0; i < list.length; i++) {
      if (any || list[i].directionId === String(directionId)) return list[i];
    }
    return null;
  }

  // ---------------------------------------------------------------- summaries

  function routeDaySummary(feed, date) {
    var day = dayEntries(feed, date), byRoute = Object.create(null), ids = [];
    var total = { trips: 0, runningSec: 0, firstDep: null, lastArr: null };
    function add(o, t) {
      o.trips++;
      o.runningSec += t.end - t.start;
      if (o.firstDep === null || t.start < o.firstDep) o.firstDep = t.start;
      if (o.lastArr === null || t.end > o.lastArr) o.lastArr = t.end;
    }
    for (var i = 0; i < day.entries.length; i++) {
      var t = day.entries[i].trip;
      var o = byRoute[t.routeId];
      if (!o) { o = byRoute[t.routeId] = { trips: 0, runningSec: 0, firstDep: null, lastArr: null }; ids.push(t.routeId); }
      add(o, t);
      add(total, t);
    }
    ids.sort();
    var routes = {};
    for (i = 0; i < ids.length; i++) routes[ids[i]] = byRoute[ids[i]];
    return { date: date, routes: routes, total: total, invalidTrips: day.invalid.length };
  }

  // Maximum number of overlapping half-open [start, end) intervals and the earliest second it is reached.
  function maxOverlap(intervals) {
    var ev = [], i;
    for (i = 0; i < intervals.length; i++) {
      if (intervals[i][1] <= intervals[i][0]) continue;
      ev.push([intervals[i][0], 1]);
      ev.push([intervals[i][1], -1]);
    }
    ev.sort(function (p, q) { return p[0] - q[0]; });
    var cur = 0, peak = 0, at = null;
    i = 0;
    while (i < ev.length) {
      var t = ev[i][0];
      while (i < ev.length && ev[i][0] === t) { cur += ev[i][1]; i++; }
      if (cur > peak) { peak = cur; at = t; }
    }
    return { peak: peak, at: at };
  }

  function peakVehicles(feed, date, opts) {
    var layover = opts && typeof opts.layoverSec === "number" ? opts.layoverSec : DEFAULT_LAYOVER_SEC;
    var trips = dayEntries(feed, date).entries.map(function (e) { return e.trip; }), i;
    var sweepIv = [], hasBlock = false;
    for (i = 0; i < trips.length; i++) {
      sweepIv.push([trips[i].start, trips[i].end + layover]);
      if (trips[i].blockId !== "") hasBlock = true;
    }
    var sw = maxOverlap(sweepIv);
    var sweep = { peak: sw.peak, at: sw.at, layoverSec: layover };
    var block = null;
    if (hasBlock) {
      var groups = Object.create(null), keys = [];
      for (i = 0; i < trips.length; i++) {
        var t = trips[i];
        // Frequency runs share their template's block_id but are separate vehicles.
        var k = t.blockId !== "" && !t.generated ? "b:" + t.blockId : "t:" + t.tripId;
        var gr = groups[k];
        if (!gr) { gr = groups[k] = [t.start, t.end]; keys.push(k); }
        if (t.start < gr[0]) gr[0] = t.start;
        if (t.end > gr[1]) gr[1] = t.end;
      }
      var iv = keys.map(function (key) { return groups[key]; });
      var bl = maxOverlap(iv);
      block = { peak: bl.peak, at: bl.at };
    }
    var chosen = block || sweep;
    return {
      method: block ? "block" : "sweep", peak: chosen.peak, at: chosen.at,
      block: block, sweep: sweep
    };
  }

  function stopAccessibility(feed) {
    var out = {};
    var ids = Object.keys(feed._stops).sort();
    for (var i = 0; i < ids.length; i++) {
      var s = feed._stops[ids[i]];
      var v = s.wheelchair === "1" ? 1 : s.wheelchair === "2" ? 2 : 0;
      var inherited = false;
      if (v === 0 && s.parent !== "" && feed._stops[s.parent]) {
        var pw = feed._stops[s.parent].wheelchair;
        if (pw === "1" || pw === "2") { v = +pw; inherited = true; }
      }
      out[ids[i]] = { value: v, inherited: inherited };
    }
    return out;
  }

  function busiestDate(feed, type) {
    var range = dateRange(feed);
    if (!range) return null;
    var best = null, bestCount = -1, countBySet = Object.create(null);
    for (var d = range.start; d <= range.end; d = addDays(d, 1)) {
      if (dayType(feed, d).dayType !== type) continue;
      // Trip count depends only on which services run, so identical days share one expansion.
      var key = activeServices(feed, d).join("|");
      var c = countBySet[key];
      if (c === undefined) c = countBySet[key] = dayEntries(feed, d).entries.length;
      if (c > bestCount) { bestCount = c; best = d; }
    }
    return bestCount > 0 ? best : null;
  }

  // ---------------------------------------------------------------- details views

  // Median of a numeric array, null when empty. Sorts a copy so the caller's order is kept.
  function medianSec(gaps) {
    if (!gaps || gaps.length === 0) return null;
    var s = gaps.slice().sort(function (p, q) { return p - q; });
    var m = s.length;
    return m % 2 === 1 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
  }

  // trip_id -> trip_headsign, built once per feed. The first row of a repeated trip_id wins, the same
  // rule buildFeed applies to trips, so a headsign always comes from the trip the engine actually runs.
  function headsignMap(feed) {
    if (feed._headsigns) return feed._headsigns;
    var map = Object.create(null), t = feed.tables && feed.tables["trips.txt"];
    var rows = t ? t.rows : [], i;
    for (i = 0; i < rows.length; i++) {
      var id = g(rows[i], "trip_id");
      if (id !== "" && map[id] === undefined) map[id] = g(rows[i], "trip_headsign");
    }
    feed._headsigns = map;
    return map;
  }

  // A generated frequency run has no trips.txt row of its own, so it reads its template's headsign.
  function headsignOf(map, trip) {
    var h = map[trip.generated ? trip.templateId : trip.tripId];
    return typeof h === "string" ? h : "";
  }

  // Most common headsign in a tally of {text: count}. Ties go to the smaller text; "" when there is none.
  function topHeadsign(tally) {
    var best = "", bestN = 0, k;
    if (!tally) return "";
    for (k in tally) {
      var n = tally[k];
      if (n > bestN || (n === bestN && k < best)) { best = k; bestN = n; }
    }
    return best;
  }

  // Day parts read the way headwayBands reads them: unparsable starts are dropped and the rest sorted by
  // start, ties keeping the caller's order. Starts are printed as HH:MM so "6:00" and "06:00" agree.
  function dayPartList(dayParts) {
    var src = dayParts || DEFAULT_DAY_PARTS, out = [], i;
    for (i = 0; i < src.length; i++) {
      var p = src[i], ps = parseHM(p && p.start);
      if (ps < 0) continue;
      out.push({
        id: typeof p.id === "string" ? p.id : "",
        label: typeof p.label === "string" ? p.label : "",
        start: ps * 60,
        text: pad2(Math.floor(ps / 60)) + ":" + pad2(ps % 60),
        order: i
      });
    }
    out.sort(function (a, b) { return a.start !== b.start ? a.start - b.start : a.order - b.order; });
    return out;
  }

  // Index of the part a time belongs to: the last part whose start is at or before it. A time before the
  // first start belongs to the first part, so no departure is dropped. -1 when there are no parts.
  function partIndexOf(parts, sec) {
    if (parts.length === 0) return -1;
    var idx = 0, i;
    for (i = 1; i < parts.length; i++) if (parts[i].start <= sec) idx = i;
    return idx;
  }

  // Count and median headway for each part. times must be sorted ascending. A gap counts only when both of
  // its ends fall in the same part, so no gap straddles a part boundary.
  function partHeadways(times, parts) {
    var out = [], idx = [], i, p;
    for (p = 0; p < parts.length; p++) out.push({ count: 0, gaps: [] });
    for (i = 0; i < times.length; i++) {
      var pi = partIndexOf(parts, times[i]);
      idx.push(pi);
      if (pi < 0) continue;
      out[pi].count++;
      if (i > 0 && idx[i - 1] === pi) out[pi].gaps.push(times[i] - times[i - 1]);
    }
    for (p = 0; p < parts.length; p++) out[p].headwaySec = medianSec(out[p].gaps);
    return out;
  }

  function isPeakPart(id) { return id === "am" || id === "pm"; }
  function isOffPeakPart(id) { return id === "midday"; }

  // Median over the gaps of every part that matches. Peak and off-peak headways pool their parts' gaps
  // rather than averaging the part medians, so a long part does not count for less than a short one.
  function pooledHeadway(perPart, parts, matches) {
    var all = [], p;
    for (p = 0; p < parts.length; p++) if (matches(parts[p].id)) all = all.concat(perPart[p].gaps);
    return medianSec(all);
  }

  // Great-circle metres between two stops, rounded to whole metres; null when either lacks coordinates.
  function stopMeters(feed, idA, idB) {
    var a = feed._stops[idA], b = feed._stops[idB];
    if (!a || !b || typeof a.lat !== "number" || typeof a.lon !== "number" ||
        typeof b.lat !== "number" || typeof b.lon !== "number") return null;
    return Math.round(haversine(a.lat, a.lon, b.lat, b.lon));
  }

  // A real calendar date in YYYYMMDD form. The round trip matters: Date.UTC would quietly roll 20261340 over.
  function isRealDate(s) {
    if (typeof s !== "string" || !isDate(s)) return false;
    var y = +s.substring(0, 4), m = +s.substring(4, 6), d = +s.substring(6, 8);
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  // Whole days since the epoch for a YYYYMMDD date. Differences of two of these are exact day counts.
  function utcDay(s) {
    return Date.UTC(+s.substring(0, 4), +s.substring(4, 6) - 1, +s.substring(6, 8)) / 86400000;
  }

  // Every stop-time row at the stop, or at a child of it, on each trip running that date, the last row
  // included. Times are read as departuresAtStop reads them (interpolated, plus the frequency offset); a
  // blank time stays -1. Rows are ordered by the time a rider uses: a trip's last row by arrival, any other
  // row by departure. Rows with no such time sort last, then by trip id.
  function stopDepartures(feed, date, stopId, opts) {
    var st = feed.st, ids = [stopId], i;
    var s = feed._stops[stopId];
    if (s) for (i = 0; i < s.children.length; i++) ids.push(s.children[i]);
    var mask = new Uint8Array(st.stopIds.length), any = false;
    for (i = 0; i < ids.length; i++) {
      var ix = feed._stopIdx[ids[i]];
      if (ix !== undefined) { mask[ix] = 1; any = true; }
    }
    if (!any) return [];
    var ents = filteredEntries(feed, date, opts), hs = headsignMap(feed), out = [];
    for (i = 0; i < ents.length; i++) {
      var e = ents[i], a = st.tripStart[e.ti], b = st.tripStart[e.ti + 1], tf = null;
      for (var r = a; r < b; r++) {
        if (!mask[st.stop[r]]) continue;
        if (tf === null) tf = timesFor(feed, e.ti, true);
        var arr = tf.arr[r - a], dep = tf.dep[r - a];
        out.push({
          tripId: e.trip.tripId, routeId: e.trip.routeId, directionId: e.trip.directionId,
          headsign: headsignOf(hs, e.trip), stopId: st.stopIds[st.stop[r]],
          arr: arr >= 0 ? arr + e.off : -1, dep: dep >= 0 ? dep + e.off : -1,
          last: r === b - 1
        });
      }
    }
    out.sort(function (p, q) {
      var kp = p.last ? p.arr : p.dep, kq = q.last ? q.arr : q.dep;
      if ((kp < 0) !== (kq < 0)) return kp < 0 ? 1 : -1;
      if (kp !== kq) return kp - kq;
      return p.tripId < q.tripId ? -1 : p.tripId > q.tripId ? 1 : 0;
    });
    return out;
  }

  // Departures at a stop on the date (a trip's last row is an arrival, so it is left out), counted per
  // route and per day part. Headways use the combined departure list across routes, so the stop's
  // effective frequency is what a rider waiting there sees.
  function stopSummary(feed, date, stopId, opts) {
    var parts = dayPartList(opts && opts.dayParts);
    var rows = stopDepartures(feed, date, stopId, { routeIds: opts && opts.routeIds }), i;
    var deps = [], perRoute = Object.create(null), routeOrder = [];
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.last || row.dep < 0) continue;
      deps.push(row.dep);
      if (perRoute[row.routeId] === undefined) { perRoute[row.routeId] = 0; routeOrder.push(row.routeId); }
      perRoute[row.routeId]++;
    }
    deps.sort(function (p, q) { return p - q; });
    var heads = partHeadways(deps, parts), routes = [];
    for (i = 0; i < routeOrder.length; i++) routes.push({ routeId: routeOrder[i], departures: perRoute[routeOrder[i]] });
    routes.sort(function (p, q) {
      if (p.departures !== q.departures) return q.departures - p.departures;
      return p.routeId < q.routeId ? -1 : p.routeId > q.routeId ? 1 : 0;
    });
    var partRows = [];
    for (i = 0; i < parts.length; i++) {
      partRows.push({
        id: parts[i].id, label: parts[i].label, start: parts[i].text,
        departures: heads[i].count, headwaySec: heads[i].headwaySec
      });
    }
    return {
      departures: deps.length,
      routes: routes,
      span: deps.length > 0 ? { first: deps[0], last: deps[deps.length - 1] } : null,
      parts: partRows,
      peakHeadwaySec: pooledHeadway(heads, parts, isPeakPart),
      offPeakHeadwaySec: pooledHeadway(heads, parts, isOffPeakPart)
    };
  }

  // The stop's neighbours on each route and direction that serves it on the date. Neighbours come from the
  // route's most-used pattern for that direction, so they follow the order a rider sees, not one trip's
  // stop list. A stop served twice by one pattern takes its first position.
  function stopSpacing(feed, date, stopId, opts) {
    var rows = stopDepartures(feed, date, stopId, opts), i, j, k;
    var mask = Object.create(null), s = feed._stops[stopId];
    mask[stopId] = true;
    if (s) for (i = 0; i < s.children.length; i++) mask[s.children[i]] = true;
    var pairs = [], seen = Object.create(null);
    for (i = 0; i < rows.length; i++) {
      var key = JSON.stringify([rows[i].routeId, rows[i].directionId]);
      if (seen[key]) continue;
      seen[key] = true;
      pairs.push({ routeId: rows[i].routeId, directionId: rows[i].directionId });
    }
    pairs.sort(function (p, q) {
      if (p.routeId !== q.routeId) return p.routeId < q.routeId ? -1 : 1;
      return p.directionId < q.directionId ? -1 : p.directionId > q.directionId ? 1 : 0;
    });
    var patCache = Object.create(null), out = [];
    for (i = 0; i < pairs.length; i++) {
      var pr = pairs[i];
      if (patCache[pr.routeId] === undefined) patCache[pr.routeId] = patterns(feed, date, pr.routeId);
      var list = patCache[pr.routeId], stops = null, pos = -1;
      for (j = 0; j < list.length && pos < 0; j++) {
        if (list[j].directionId !== pr.directionId) continue;
        for (k = 0; k < list[j].stops.length; k++) {
          if (mask[list[j].stops[k]]) { stops = list[j].stops; pos = k; break; }
        }
      }
      if (pos < 0) continue;
      var prev = pos > 0 ? stops[pos - 1] : null, next = pos + 1 < stops.length ? stops[pos + 1] : null;
      out.push({
        routeId: pr.routeId, directionId: pr.directionId,
        prevStopId: prev, prevMeters: prev === null ? null : stopMeters(feed, stops[pos], prev),
        nextStopId: next, nextMeters: next === null ? null : stopMeters(feed, stops[pos], next)
      });
    }
    return out;
  }

  // One route's trips on the date, grouped by direction. Headways come from start times in each day part;
  // each pattern carries its most common non-blank headsign.
  function routeSchedule(feed, date, routeId, opts) {
    var parts = dayPartList(opts && opts.dayParts);
    var ents = filteredEntries(feed, date, { routeIds: [routeId] }), hs = headsignMap(feed), st = feed.st;
    var byDir = Object.create(null), dirOrder = [], tallies = Object.create(null), i, r;
    for (i = 0; i < ents.length; i++) {
      var e = ents[i], dir = e.trip.directionId, stopsList = [];
      for (r = st.tripStart[e.ti]; r < st.tripStart[e.ti + 1]; r++) stopsList.push(st.stopIds[st.stop[r]]);
      // Same key as patterns() builds, so each pattern finds its own headsign tally below.
      var key = dir + "|" + stopsList.join(","), text = headsignOf(hs, e.trip);
      var tally = tallies[key] || (tallies[key] = Object.create(null));
      if (text !== "") tally[text] = (tally[text] || 0) + 1;
      var rec = byDir[dir];
      if (!rec) { rec = byDir[dir] = { directionId: dir, trips: 0, runningSec: 0, starts: [] }; dirOrder.push(dir); }
      rec.trips++;
      rec.runningSec += e.trip.end - e.trip.start;
      rec.starts.push(e.trip.start);
    }
    var pats = patterns(feed, date, routeId);
    dirOrder.sort();
    var directions = [];
    for (i = 0; i < dirOrder.length; i++) {
      var d = byDir[dirOrder[i]], j;
      d.starts.sort(function (p, q) { return p - q; });
      var heads = partHeadways(d.starts, parts), partRows = [], dirPatterns = [];
      for (j = 0; j < parts.length; j++) {
        partRows.push({
          id: parts[j].id, label: parts[j].label, start: parts[j].text,
          trips: heads[j].count, headwaySec: heads[j].headwaySec
        });
      }
      for (j = 0; j < pats.length; j++) {
        if (pats[j].directionId !== d.directionId) continue;
        dirPatterns.push({
          stops: pats[j].stops, trips: pats[j].trips,
          headsign: topHeadsign(tallies[pats[j].directionId + "|" + pats[j].stops.join(",")])
        });
      }
      directions.push({
        directionId: d.directionId, trips: d.trips, runningSec: d.runningSec,
        span: d.starts.length > 0 ? { first: d.starts[0], last: d.starts[d.starts.length - 1] } : null,
        parts: partRows,
        peakHeadwaySec: pooledHeadway(heads, parts, isPeakPart),
        offPeakHeadwaySec: pooledHeadway(heads, parts, isOffPeakPart),
        patterns: dirPatterns
      });
    }
    return { trips: ents.length, directions: directions };
  }

  // Overview of the loaded feed: agencies, the service window and how many days of it remain, counts of
  // routes and stops, and the trips each of the three sample day types would run. Counts are of the whole
  // feed, not of one date.
  function feedOverview(feed, opts) {
    opts = opts || {};
    var dates = opts.dates || {}, i, k;
    var agencyT = feed.tables && feed.tables["agency.txt"], arows = agencyT ? agencyT.rows : [];
    var agencies = [];
    for (i = 0; i < arows.length; i++) {
      agencies.push({
        id: g(arows[i], "agency_id"), name: g(arows[i], "agency_name"),
        url: g(arows[i], "agency_url"), timezone: g(arows[i], "agency_timezone")
      });
    }
    var range = dateRange(feed);
    var daysLeft = null;
    if (range && isRealDate(opts.today)) daysLeft = utcDay(range.end) - utcDay(opts.today);
    var stops = 0, stations = 0;
    for (k in feed._stops) {
      var lt = feed._stops[k].locationType;
      if (lt === "" || lt === "0") stops++;
      else if (lt === "1") stations++;
    }
    var types = ["weekday", "saturday", "sunday"], dayTypes = [];
    for (i = 0; i < types.length; i++) {
      var d = dates[types[i]];
      if (typeof d !== "string") continue;
      dayTypes.push({ type: types[i], date: d, trips: tripsOnDate(feed, d).trips.length });
    }
    return {
      agencies: agencies,
      range: range ? { start: range.start, end: range.end } : null,
      daysLeft: daysLeft,
      routes: Object.keys(feed._routes).length,
      stops: stops,
      stations: stations,
      trips: feed._trips.length,
      dayTypes: dayTypes
    };
  }

  // ---------------------------------------------------------------- headway bands

  // Default cut points for turning departures into Service headway bands. The last part has no end,
  // so departures after 24:00 still fall in a part.
  var DEFAULT_DAY_PARTS = [
    { id: "early", label: "Early", start: "00:00" },
    { id: "am", label: "AM peak", start: "06:00" },
    { id: "midday", label: "Midday", start: "09:00" },
    { id: "pm", label: "PM peak", start: "15:00" },
    { id: "evening", label: "Evening", start: "18:00" },
    { id: "night", label: "Night", start: "21:00" }
  ];

  // Headways a planner would recognise. Tried first so bands get round numbers when they can.
  var HEADWAY_CANDIDATES = [2, 3, 4, 5, 6, 7.5, 8, 10, 12, 15, 20, 30, 40, 45, 60, 90, 120];

  // Band edges snap to 5-minute marks so a band in the editor reads cleanly.
  var BAND_EDGE_SEC = 300;

  // "H:MM" / "HH:MM" as minutes after midnight, or -1. Hour 24 is accepted, as Route Costing does.
  function parseHM(s) {
    if (typeof s !== "string") return -1;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return -1;
    var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    return h > 24 || min >= 60 ? -1 : h * 60 + min;
  }

  // Same parse and float hours as route-costing.js parseBandTime. Trip counts must reproduce Route
  // Costing's arithmetic bit for bit, so do not replace this with integer seconds.
  function parseBandClock(s) {
    if (typeof s !== "string") return NaN;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return NaN;
    var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (h < 0 || h > 24 || min < 0 || min >= 60) return NaN;
    return h + min / 60;
  }

  // Band length in minutes as Route Costing sees it: a band ending at or before its start wraps past midnight.
  function bandSpanMinutes(from, to) {
    var hrs = parseBandClock(to) - parseBandClock(from);
    if (hrs <= 0) hrs += 24;
    return hrs * 60;
  }

  function bandTripCount(from, to, headway) {
    if (typeof headway !== "number" || !(headway > 0)) return NaN;
    var span = bandSpanMinutes(from, to);
    if (!isFinite(span)) return NaN;
    return Math.ceil(span / headway);
  }

  // Seconds to "HH:MM" with the hour taken modulo 24, so a band after midnight reads 01:30, not 25:30.
  function bandClock(sec) {
    var mins = Math.floor(sec / 60);
    return pad2(Math.floor(mins / 60) % 24) + ":" + pad2(mins % 60);
  }

  function floorTo5(sec) { return Math.floor(sec / BAND_EDGE_SEC) * BAND_EDGE_SEC; }
  function ceilTo5(sec) { return Math.ceil(sec / BAND_EDGE_SEC) * BAND_EDGE_SEC; }

  // Headway for a band that must produce exactly n trips. Tries round headways first, then the largest
  // value with 1 to 4 decimals that still gives n (for n = 1 the rounded-up band length). The last
  // resort is the plain average, which can miss n by float error; the invariant test catches that.
  function bandFrequency(from, to, n) {
    var i, h;
    for (i = 0; i < HEADWAY_CANDIDATES.length; i++) {
      if (bandTripCount(from, to, HEADWAY_CANDIDATES[i]) === n) return HEADWAY_CANDIDATES[i];
    }
    var len = bandSpanMinutes(from, to), d, scale, k, top, bottom;
    for (d = 1; d <= 4; d++) {
      scale = Math.pow(10, d);
      if (n === 1) {
        h = Math.ceil(len * scale) / scale;
        if (bandTripCount(from, to, h) === 1) return h;
        continue;
      }
      // ceil(len / h) = n holds for h in [len / n, len / (n - 1)); scan down from the open upper end.
      top = Math.ceil(len / (n - 1) * scale);
      bottom = Math.max(1, Math.floor(len / n * scale) - 1);
      for (k = top; k >= bottom; k--) {
        h = k / scale;
        if (bandTripCount(from, to, h) === n) return h;
      }
    }
    return len / n;
  }

  // departures: departure times in seconds after service-day midnight (any order; negatives and
  // non-numbers are ignored). Returns [{from, to, frequency, trips, part}] for the parts that have
  // departures. A departure before the first part's start is counted in the first part so no trip is lost.
  function headwayBands(departures, dayParts) {
    var src = dayParts || DEFAULT_DAY_PARTS, parts = [], i;
    for (i = 0; i < src.length; i++) {
      var ps = parseHM(src[i] && src[i].start);
      if (ps >= 0) parts.push({ id: src[i].id, start: ps * 60 });
    }
    parts.sort(function (p, q) { return p.start - q.start; });
    var deps = [];
    if (Array.isArray(departures)) {
      for (i = 0; i < departures.length; i++) {
        var v = departures[i];
        if (typeof v === "number" && isFinite(v) && v >= 0) deps.push(v);
      }
    }
    if (deps.length === 0 || parts.length === 0) return [];
    deps.sort(function (p, q) { return p - q; });

    var groups = [], pi = 0;
    for (i = 0; i < deps.length; i++) {
      while (pi + 1 < parts.length && parts[pi + 1].start <= deps[i]) pi++;
      if (groups.length === 0 || groups[groups.length - 1].pi !== pi) groups.push({ pi: pi, deps: [] });
      groups[groups.length - 1].deps.push(deps[i]);
    }

    var bands = [];
    for (i = 0; i < groups.length; i++) {
      var g = groups[i], n = g.deps.length, startSec, endSec;
      startSec = i === 0 ? floorTo5(g.deps[0]) : parts[g.pi].start;
      if (i === groups.length - 1) endSec = ceilTo5(g.deps[n - 1]);
      else endSec = parts[g.pi + 1].start;
      if (endSec === startSec) endSec = startSec + BAND_EDGE_SEC;
      var from = bandClock(startSec), to = bandClock(endSec);
      bands.push({
        from: from, to: to, frequency: bandFrequency(from, to, n), trips: n, part: parts[g.pi].id
      });
    }
    return bands;
  }

  // Mean of end - start over entries that end after they start, in minutes to one decimal; null if none.
  function meanTripMinutes(trips) {
    if (!Array.isArray(trips)) return null;
    var sum = 0, n = 0;
    for (var i = 0; i < trips.length; i++) {
      var t = trips[i];
      var d = t ? t.end - t.start : NaN;
      if (isFinite(d) && d > 0) { sum += d; n++; }
    }
    if (n === 0) return null;
    return Math.round(sum / n / 60 * 10) / 10;
  }

  // Equal when the same number of bands have the same from, to and frequency (trips and part ignored).
  function bandsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      var x = a[i] || {}, y = b[i] || {};
      if (x.from !== y.from || x.to !== y.to || x.frequency !== y.frequency) return false;
    }
    return true;
  }

  // Test helper: 200 pseudo-random departure sets from a fixed LCG. Returns how many bands fail to
  // reproduce their own trip count through bandTripCount (must be 0) and how many bands were checked.
  function bandInvariant(seed) {
    var x = (+seed) >>> 0;
    function next() {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x / 4294967296;
    }
    var violations = 0, checked = 0;
    for (var s = 0; s < 200; s++) {
      var n = Math.floor(next() * 60);
      var grid = next() < 0.5 ? 60 : 1;
      var deps = [];
      for (var k = 0; k < n; k++) {
        if (next() < 0.1) deps.push(-1 - Math.floor(next() * 1000));
        else deps.push(Math.floor(next() * 130000 / grid) * grid);
      }
      var bands = headwayBands(deps, null);
      for (var b = 0; b < bands.length; b++) {
        checked++;
        if (bandTripCount(bands[b].from, bands[b].to, bands[b].frequency) !== bands[b].trips) violations++;
      }
    }
    return { violations: violations, checked: checked };
  }

  // ---------------------------------------------------------------- copy plan

  var PLAN_DAYS = ["weekday", "saturday", "sunday"];

  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }

  // What a copied Service would hold for one route: per shape, bands per day type, a run time, a
  // direction and the stop sequence, plus a per-day check against the timetable. Pure so the same
  // numbers can be pinned by golden cases. opts: { routeId, dates: {weekday, saturday, sunday},
  // dayParts }. A date that is not "YYYYMMDD" counts as absent.
  function serviceCopyPlan(feed, opts) {
    opts = opts || {};
    var routeId = opts.routeId, d, i, j;
    var dates = {}, unshaped = {};
    for (d = 0; d < PLAN_DAYS.length; d++) {
      var want = opts.dates && opts.dates[PLAN_DAYS[d]];
      dates[PLAN_DAYS[d]] = typeof want === "string" && isDate(want) ? want : null;
      unshaped[PLAN_DAYS[d]] = 0;
    }
    var plan = { routeId: routeId, dates: dates, shapes: [], unshaped: unshaped, reconciliation: [] };
    if (!feed || !feed._routes[routeId]) {
      for (d = 0; d < PLAN_DAYS.length; d++) {
        if (dates[PLAN_DAYS[d]]) plan.reconciliation.push(emptyReconRow(PLAN_DAYS[d], dates[PLAN_DAYS[d]]));
      }
      return plan;
    }

    var byShape = Object.create(null), order = [], seqCache = Object.create(null);
    function seqOf(trip) {
      var key = trip.templateId || trip.tripId;
      var hit = seqCache[key];
      if (!hit) {
        var st = tripStopTimes(feed, key), ids = [];
        for (var k = 0; k < st.length; k++) ids.push(st[k].stopId);
        hit = seqCache[key] = { ids: ids, joined: ids.join("\u0001") };
      }
      return hit;
    }
    for (d = 0; d < PLAN_DAYS.length; d++) {
      var day = PLAN_DAYS[d];
      if (!dates[day]) continue;
      var trips = tripsOnDate(feed, dates[day], { routeIds: [routeId] }).trips;
      for (i = 0; i < trips.length; i++) {
        var t = trips[i];
        if (!t.shapeId) { unshaped[day]++; continue; }
        var rec = byShape[t.shapeId];
        if (!rec) {
          rec = byShape[t.shapeId] = { shapeId: t.shapeId, days: { weekday: [], saturday: [], sunday: [] },
            dirs: Object.create(null), seqs: Object.create(null), total: 0 };
          order.push(rec);
        }
        rec.days[day].push(t);
        rec.dirs[t.directionId] = true;
        rec.total++;
        var sq = seqOf(t), s = rec.seqs[sq.joined];
        if (!s) s = rec.seqs[sq.joined] = { ids: sq.ids, joined: sq.joined, count: 0 };
        s.count++;
      }
    }

    order.sort(function (a, b) {
      if (a.total !== b.total) return b.total - a.total;
      return a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0;
    });

    for (i = 0; i < order.length; i++) {
      var r = order[i], service = {}, perDay = {}, bands = {};
      for (d = 0; d < PLAN_DAYS.length; d++) {
        var dn = PLAN_DAYS[d], list = r.days[dn], deps = [], run = 0;
        for (j = 0; j < list.length; j++) { deps.push(list[j].start); run += list[j].end - list[j].start; }
        var raw = headwayBands(deps, opts.dayParts || null), clean = [];
        for (j = 0; j < raw.length; j++) clean.push({ from: raw[j].from, to: raw[j].to, frequency: raw[j].frequency });
        bands[dn] = clean;
        perDay[dn] = { trips: list.length, runningSec: run };
      }
      var mirrors = bands.sunday.length > 0 && bandsEqual(bands.saturday, bands.sunday);
      service.weekday = bands.weekday;
      service.saturday = bands.saturday;
      service.sunday = mirrors ? [] : bands.sunday;
      service.sundayMirrorsSaturday = mirrors;

      var runTime = null, runTimeDay = null;
      for (d = 0; d < PLAN_DAYS.length && runTime === null; d++) {
        var m = meanTripMinutes(r.days[PLAN_DAYS[d]]);
        if (m !== null) { runTime = m; runTimeDay = PLAN_DAYS[d]; }
      }

      var dirKeys = Object.keys(r.dirs);
      var directionId = dirKeys.length === 1 && (dirKeys[0] === "0" || dirKeys[0] === "1") ? dirKeys[0] : "";

      var best = null;
      for (var sk in r.seqs) {
        var c = r.seqs[sk];
        if (!best || c.count > best.count ||
            (c.count === best.count && (c.ids.length > best.ids.length ||
              (c.ids.length === best.ids.length && c.joined < best.joined)))) best = c;
      }
      plan.shapes.push({
        shapeId: r.shapeId, directionId: directionId, service: service,
        runTime: runTime, runTimeDay: runTimeDay,
        stops: best ? best.ids.slice() : [], perDay: perDay
      });
    }

    for (d = 0; d < PLAN_DAYS.length; d++) {
      var dy = PLAN_DAYS[d];
      if (!dates[dy]) continue;
      var gtfsTrips = 0, copyTrips = 0, gtfsSec = 0, copyMin = 0;
      for (i = 0; i < plan.shapes.length; i++) {
        var sh = plan.shapes[i];
        var applied = getBands(sh.service, dy), n = 0;
        for (j = 0; j < applied.length; j++) n += bandTripCount(applied[j].from, applied[j].to, applied[j].frequency);
        gtfsTrips += sh.perDay[dy].trips;
        gtfsSec += sh.perDay[dy].runningSec;
        copyTrips += n;
        copyMin += n * (sh.runTime || 0);
      }
      var gtfsHours = round2(gtfsSec / 3600), copyHours = round2(copyMin / 60);
      var diffPct = gtfsSec > 0 ? round1((copyMin / 60 - gtfsSec / 3600) / (gtfsSec / 3600) * 100) : 0;
      plan.reconciliation.push({
        day: dy, date: dates[dy], gtfsTrips: gtfsTrips, copyTrips: copyTrips,
        gtfsHours: gtfsHours, copyHours: copyHours, diffPct: diffPct,
        tripsOk: gtfsTrips === copyTrips, hoursOk: Math.abs(diffPct) <= 3
      });
    }
    return plan;
  }

  function emptyReconRow(day, date) {
    return { day: day, date: date, gtfsTrips: 0, copyTrips: 0, gtfsHours: 0, copyHours: 0,
      diffPct: 0, tripsOk: true, hoursOk: true };
  }

  // The bands a day really gets: Sunday borrows Saturday's when the plan says it mirrors.
  function getBands(service, day) {
    if (day === "sunday" && service.sundayMirrorsSaturday) return service.saturday;
    return service[day];
  }

  var MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // "Mon Jan 12, 2026", built by hand so the text does not depend on the browser's locale.
  function dateText(date) {
    return WEEKDAY_ABBR[weekdayIndex(date)] + " " + MONTH_ABBR[+date.substring(4, 6) - 1] + " " +
      (+date.substring(6, 8)) + ", " + date.substring(0, 4);
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  // Plain-text check of a plan against the timetable, one line per day type plus a line for trips that
  // could not be copied. Trip counts must match exactly; hours only need to be within 3%.
  function reconciliationNote(plan, routeName) {
    var lines = [], name = routeName || (plan && plan.routeId) || "Route", byDay = {}, i, d;
    if (!plan) return "";
    for (i = 0; i < (plan.reconciliation || []).length; i++) byDay[plan.reconciliation[i].day] = plan.reconciliation[i];
    for (d = 0; d < PLAN_DAYS.length; d++) {
      var day = PLAN_DAYS[d], row = byDay[day], uns = (plan.unshaped && plan.unshaped[day]) || 0;
      var cap = day.charAt(0).toUpperCase() + day.slice(1);
      if (!row) {
        if (!plan.dates || !plan.dates[day]) lines.push(cap + ": no service.");
      } else if (row.gtfsTrips === 0 && row.copyTrips === 0) {
        if (uns === 0) lines.push(cap + ": no service.");
      } else {
        var head = name + " — " + cap + " (" + dateText(row.date) + "): ";
        if (!row.tripsOk) {
          lines.push(head + plural(row.gtfsTrips, "trip", "trips") + " in the timetable but " +
            plural(row.copyTrips, "trip", "trips") + " on the copy.");
        } else if (row.hoursOk) {
          lines.push(head + plural(row.copyTrips, "trip", "trips") + ", matches the timetable.");
        } else {
          lines.push(head + plural(row.copyTrips, "trip", "trips") + ", running hours " + row.copyHours.toFixed(2) +
            " on the copy vs " + row.gtfsHours.toFixed(2) + " in the timetable (" + (row.diffPct > 0 ? "+" : "") +
            row.diffPct.toFixed(1) + "%): trip times vary through the day and the copy uses one average run time.");
        }
      }
      if (uns > 0) {
        lines.push(uns === 1 ? "1 " + day + " trip has no shape and was not copied."
          : uns + " " + day + " trips have no shape and were not copied.");
      }
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- service hours, vehicles and cost

  var DAY_TYPES = ["weekday", "saturday", "sunday"];
  var DEFAULT_DAY_COUNTS = { weekday: 255, saturday: 52, sunday: 58 };
  var DEFAULT_RATE = 150;
  var DEFAULT_DEADHEAD_PCT = 15;

  function isFiniteNum(x) { return typeof x === "number" && isFinite(x); }

  function ownKey(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }

  // Layover settings for the service engine. Minutes are per round trip, so each one-way trip takes half;
  // the block gap limit stops a long gap (the bus went out of service) from counting as layover.
  function normLayover(lay) {
    var l = lay || {};
    return {
      mode: l.mode === "percent" ? "percent" : "minutes",
      value: isFiniteNum(l.value) && l.value >= 0 ? l.value : 10,
      maxBlockGapMin: isFiniteNum(l.maxBlockGapMin) && l.maxBlockGapMin >= 0 ? l.maxBlockGapMin : 60
    };
  }

  // A trip is blocked when it has a block_id and is a real trip; frequency runs share their template's
  // block_id but are separate vehicles.
  function isBlockedTrip(t) { return t.blockId !== "" && !t.generated; }

  function byStartThenId(trips) {
    return function (p, q) {
      var a = trips[p], b = trips[q];
      if (a.start !== b.start) return a.start - b.start;
      return a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0;
    };
  }

  // Layover in seconds for each trip, aligned with trips. Blocked trips take the gap to the next trip of
  // their block, computed over every trip on the date so a block shared by two routes still chains.
  // Other trips take the layover setting.
  function tripLayovers(trips, lay) {
    var out = [], groups = Object.create(null), keys = [], maxGap = lay.maxBlockGapMin * 60, i, j;
    for (i = 0; i < trips.length; i++) {
      var t = trips[i];
      out.push(0);
      if (isBlockedTrip(t)) {
        if (!groups[t.blockId]) { groups[t.blockId] = []; keys.push(t.blockId); }
        groups[t.blockId].push(i);
      } else if (lay.mode === "percent") {
        out[i] = Math.round((t.end - t.start) * lay.value / 100);
      } else {
        out[i] = Math.round(lay.value * 60 / 2);
      }
    }
    for (i = 0; i < keys.length; i++) {
      var idx = groups[keys[i]].sort(byStartThenId(trips));
      for (j = 0; j + 1 < idx.length; j++) {
        var gap = trips[idx[j + 1]].start - trips[idx[j]].end;
        out[idx[j]] = gap > 0 && gap <= maxGap ? gap : 0;
      }
    }
    return out;
  }

  // Vehicles needed at the busiest moment. items = [{trip, layoverSec}]. Blocked trips form one interval per
  // block (per route and block when perRoute), spanning the block's first start to last end; every other trip
  // is an interval from its start to its end plus its layover.
  function vehiclePeak(items, perRoute) {
    var groups = Object.create(null), keys = [], ivs = [], sweepN = 0, i;
    for (i = 0; i < items.length; i++) {
      var t = items[i].trip;
      if (isBlockedTrip(t)) {
        var k = (perRoute ? t.routeId + "\u0001" : "") + t.blockId;
        var g = groups[k];
        if (!g) { g = groups[k] = [t.start, t.end]; keys.push(k); }
        if (t.start < g[0]) g[0] = t.start;
        if (t.end > g[1]) g[1] = t.end;
      } else {
        ivs.push([t.start, t.end + items[i].layoverSec]);
        sweepN++;
      }
    }
    for (i = 0; i < keys.length; i++) ivs.push(groups[keys[i]]);
    var mo = maxOverlap(ivs);
    var method = items.length === 0 ? null : keys.length === 0 ? "sweep" : sweepN === 0 ? "block" : "mixed";
    return { peak: mo.peak, at: mo.at, method: method };
  }

  // One Row of routeServiceDay. Empty input gives zero sums and nulls for times and methods.
  function serviceRow(items, perRoute, deadheadPct) {
    var running = 0, layover = 0, blocked = 0, first = null, last = null, i;
    for (i = 0; i < items.length; i++) {
      var t = items[i].trip;
      running += t.end - t.start;
      layover += items[i].layoverSec;
      if (isBlockedTrip(t)) blocked++;
      if (first === null || t.start < first) first = t.start;
      if (last === null || t.end > last) last = t.end;
    }
    var n = items.length, revenue = running + layover, deadhead = Math.round(running * deadheadPct / 100);
    var pk = vehiclePeak(items, perRoute);
    return {
      trips: n, runningSec: running, layoverSec: layover, revenueSec: revenue,
      deadheadSec: deadhead, platformSec: revenue + deadhead,
      firstDep: first, lastArr: last, spanSec: first === null ? null : last - first,
      peakVehicles: pk.peak, peakAt: pk.at, peakMethod: pk.method,
      method: n === 0 ? null : blocked === 0 ? "setting" : blocked === n ? "block" : "mixed"
    };
  }

  // Hours, layover, deadhead and peak for one date and scope. Unknown dates and empty feeds give zero rows.
  function routeServiceDay(feed, date, opts) {
    var day = dayEntries(feed, date), all = [], i, f = routeFilter(opts || {}), invalid = 0;
    for (i = 0; i < day.entries.length; i++) all.push(day.entries[i].trip);
    for (i = 0; i < day.invalid.length; i++) {
      var tt = feed._tripsById[day.invalid[i]];
      if (!f || (tt && f[tt.routeId])) invalid++;
    }
    return serviceDayFromTrips(all, date, opts, invalid);
  }

  // The same figures from plain trip records {tripId, routeId, start, end, blockId, generated}, so drawn
  // Services' synthetic trips cost the same way as a feed's. `all` is every trip on the date: layovers are
  // taken across all of them, so a block shared with a route outside opts.routeIds still chains.
  function serviceDayFromTrips(all, date, opts, invalidTrips) {
    var o = opts || {}, lay = normLayover(o.layover);
    var dpct = isFiniteNum(o.deadheadPct) && o.deadheadPct >= 0 ? o.deadheadPct : DEFAULT_DEADHEAD_PCT;
    var f = routeFilter(o), i;
    all = all || [];
    var lays = tripLayovers(all, lay), items = [], byRoute = Object.create(null), ids = [];
    for (i = 0; i < all.length; i++) {
      if (f && !f[all[i].routeId]) continue;
      var it = { trip: all[i], layoverSec: lays[i] }, rid = all[i].routeId;
      items.push(it);
      if (!byRoute[rid]) { byRoute[rid] = []; ids.push(rid); }
      byRoute[rid].push(it);
    }
    ids.sort();
    var routes = {};
    for (i = 0; i < ids.length; i++) routes[ids[i]] = serviceRow(byRoute[ids[i]], true, dpct);
    var total = serviceRow(items, false, dpct);
    return { date: date, method: total.method, routes: routes, total: total, invalidTrips: invalidTrips || 0 };
  }

  // Sums of per-day service figures, weighted by mult (5 weekdays a week, or the editable day counts a year).
  function weightedSum(perDay, mult) {
    var s = { trips: 0, runningHrs: 0, revenueHrs: 0, platformHrs: 0, cost: 0 }, i, d;
    for (i = 0; i < DAY_TYPES.length; i++) {
      d = perDay[DAY_TYPES[i]];
      if (!d) continue;
      var m = mult[DAY_TYPES[i]];
      s.trips += m * d.trips;
      s.runningHrs += m * d.runningHrs;
      s.revenueHrs += m * d.revenueHrs;
      s.platformHrs += m * d.platformHrs;
      s.cost += m * d.cost;
    }
    return s;
  }

  function dayFigures(row, cost) {
    return {
      trips: row.trips,
      runningHrs: row.runningSec / 3600,
      layoverHrs: row.layoverSec / 3600,
      revenueHrs: row.revenueSec / 3600,
      deadheadHrs: row.deadheadSec / 3600,
      platformHrs: row.platformSec / 3600,
      spanHrs: row.spanSec === null ? null : row.spanSec / 3600,
      firstDep: row.firstDep,
      lastArr: row.lastArr,
      peakVehicles: row.peakVehicles,
      peakMethod: row.peakMethod,
      method: row.method,
      cost: cost
    };
  }

  // Weekly and annual service figures and cost for a service, one date per day type. Each route's cost is
  // its rate times its revenue or platform hours; the total's cost is the sum of those route costs, so
  // per-route rate overrides carry through.
  function serviceYear(feed, opts) {
    return serviceYearOf(function (date, o) {
      return routeServiceDay(feed, date, { routeIds: o.routeIds, layover: o.layover, deadheadPct: o.deadheadPct });
    }, opts);
  }

  // serviceYear over plain trips: dayTrips = { weekday: [trip, ...], saturday: ..., sunday: ... }, each
  // the trips running on opts.dates[type] (see serviceDayFromTrips for the trip fields).
  function serviceYearFromTrips(dayTrips, opts) {
    var dt = dayTrips || {};
    return serviceYearOf(function (date, o, type) {
      return serviceDayFromTrips(dt[type] || [], date,
        { routeIds: o.routeIds, layover: o.layover, deadheadPct: o.deadheadPct }, 0);
    }, opts);
  }

  // Test hook: serviceYearFromTrips fed with the feed's own trips must equal serviceYear.
  function serviceYearInvariant(feed, opts) {
    var o = opts || {}, dates = o.dates || {}, dt = {}, i;
    for (i = 0; i < DAY_TYPES.length; i++) {
      var d = dates[DAY_TYPES[i]];
      dt[DAY_TYPES[i]] = d ? tripsOnDate(feed, d).trips : [];
    }
    var a = JSON.stringify(serviceYear(feed, o)), b = serviceYearFromTrips(dt, o);
    // invalidTrips is a feed-only count; everything else must match.
    var bs = JSON.parse(JSON.stringify(b)), as = JSON.parse(a);
    for (i = 0; i < DAY_TYPES.length; i++) {
      if (as.days[DAY_TYPES[i]]) as.days[DAY_TYPES[i]].invalidTrips = 0;
    }
    return { equal: JSON.stringify(as) === JSON.stringify(bs), trips: b.total.annual.trips };
  }

  function serviceYearOf(dayOf, opts) {
    var o = opts || {}, dates = o.dates || {}, dc = o.dayCounts || {};
    var basis = o.rateBasis === "platform" ? "platform" : "revenue";
    var rate = isFiniteNum(o.rate) && o.rate >= 0 ? o.rate : DEFAULT_RATE;
    var counts = {}, dd = {}, days = {}, rd = {}, t, i, r;
    for (i = 0; i < DAY_TYPES.length; i++) {
      t = DAY_TYPES[i];
      counts[t] = isFiniteNum(dc[t]) && dc[t] >= 0 ? dc[t] : DEFAULT_DAY_COUNTS[t];
      dd[t] = typeof dates[t] === "string" && dates[t] !== "" ? dates[t] : null;
    }
    function rateFor(routeId) {
      var ov = o.rateOverrides;
      var v = ownKey(ov, routeId) ? ov[routeId] : undefined;
      if (typeof v === "number" && isFinite(v) && v > 0) return { rate: v, isOverride: true };
      return { rate: rate, isOverride: false };
    }
    function routeCost(row, rt) {
      return rt * (basis === "platform" ? row.platformSec / 3600 : row.revenueSec / 3600);
    }
    var seen = Object.create(null), seenIds = [];
    for (i = 0; i < DAY_TYPES.length; i++) {
      t = DAY_TYPES[i];
      if (dd[t] === null) { days[t] = null; continue; }
      rd[t] = dayOf(dd[t], o, t);
      days[t] = { date: dd[t], method: rd[t].method, invalidTrips: rd[t].invalidTrips };
      var ks = Object.keys(rd[t].routes);
      for (var j = 0; j < ks.length; j++) {
        if (!seen[ks[j]]) { seen[ks[j]] = true; seenIds.push(ks[j]); }
      }
    }
    seenIds.sort();
    var mult = { weekday: 5, saturday: 1, sunday: 1 };
    var routes = {};
    for (i = 0; i < seenIds.length; i++) {
      r = seenIds[i];
      var rt = rateFor(r), perDay = {}, peak = 0;
      for (var k = 0; k < DAY_TYPES.length; k++) {
        t = DAY_TYPES[k];
        var row = dd[t] !== null && ownKey(rd[t].routes, r) ? rd[t].routes[r] : null;
        perDay[t] = row ? dayFigures(row, routeCost(row, rt.rate)) : null;
        if (row && row.peakVehicles > peak) peak = row.peakVehicles;
      }
      var annualMult = { weekday: counts.weekday, saturday: counts.saturday, sunday: counts.sunday };
      routes[r] = {
        rate: rt.rate, rateIsOverride: rt.isOverride, perDay: perDay,
        weekly: weightedSum(perDay, mult), annual: weightedSum(perDay, annualMult), peakVehicles: peak
      };
    }
    var totPer = {}, tpeak = 0;
    for (i = 0; i < DAY_TYPES.length; i++) {
      t = DAY_TYPES[i];
      if (dd[t] === null) { totPer[t] = null; continue; }
      var cost = 0, rk = Object.keys(rd[t].routes);
      for (var m = 0; m < rk.length; m++) cost += routeCost(rd[t].routes[rk[m]], rateFor(rk[m]).rate);
      totPer[t] = dayFigures(rd[t].total, cost);
      if (rd[t].total.peakVehicles > tpeak) tpeak = rd[t].total.peakVehicles;
    }
    return {
      basis: basis, rate: rate, dayCounts: counts, dates: dd, days: days, routes: routes,
      total: {
        perDay: totPer,
        weekly: weightedSum(totPer, mult),
        annual: weightedSum(totPer, counts),
        peakVehicles: tpeak
      }
    };
  }

  // Calendar days in the feed's range on which each day type and each route runs. A route runs on a date
  // when one of its trips has stop times and its service is active that date. Services are resolved once
  // per date; no per-date trip expansion, since a feed can cover a year.
  function calendarDayCounts(feed, opts) {
    var o = opts || {}, f = routeFilter(o), range = dateRange(feed), i, j;
    var routeSvc = Object.create(null), routeOrder = [];
    for (i = 0; i < feed._trips.length; i++) {
      var t = feed._trips[i];
      if (!t.routeOk || t.ti < 0 || (f && !f[t.routeId])) continue;
      if (feed.st.tripStart[t.ti + 1] <= feed.st.tripStart[t.ti]) continue;
      if (!routeSvc[t.routeId]) { routeSvc[t.routeId] = Object.create(null); routeOrder.push(t.routeId); }
      routeSvc[t.routeId][t.serviceId] = true;
    }
    routeOrder.sort();
    var out = {
      start: null, end: null, days: 0,
      byType: { weekday: 0, saturday: 0, sunday: 0 },
      perYear: { weekday: 0, saturday: 0, sunday: 0 },
      routes: {}
    };
    for (j = 0; j < routeOrder.length; j++) out.routes[routeOrder[j]] = { weekday: 0, saturday: 0, sunday: 0 };
    if (!range) return out;
    out.start = range.start;
    out.end = range.end;
    var d;
    for (d = range.start; d <= range.end; d = addDays(d, 1)) {
      out.days++;
      var active = activeServices(feed, d), set = Object.create(null), type = dayType(feed, d).dayType, anyRun = false;
      for (i = 0; i < active.length; i++) set[active[i]] = true;
      for (j = 0; j < routeOrder.length; j++) {
        var svc = routeSvc[routeOrder[j]], hit = false;
        for (var s in svc) { if (set[s]) { hit = true; break; } }
        if (hit) { out.routes[routeOrder[j]][type]++; anyRun = true; }
      }
      if (anyRun) out.byType[type]++;
    }
    for (i = 0; i < DAY_TYPES.length; i++) {
      out.perYear[DAY_TYPES[i]] = out.days === 0 ? 0 : Math.round(out.byType[DAY_TYPES[i]] * 365 / out.days);
    }
    return out;
  }

  // ---------------------------------------------------------------- stop analysis

  var FEET_PER_METRE = 3.28084;
  var DEFAULT_SPACING_FT = [600, 750, 1320, 2640];
  var SPACING_BANDS = [
    { id: "very-close", label: "Very close" }, { id: "close", label: "Close" },
    { id: "target", label: "Target" }, { id: "wide", label: "Wide" }, { id: "very-wide", label: "Very wide" }
  ];

  // Four strictly rising positive numbers, else the defaults, so a half-edited settings row cannot
  // produce overlapping or empty bands.
  function spacingThresholds(t) {
    var ok = Array.isArray(t) && t.length === 4, i;
    for (i = 0; ok && i < 4; i++) {
      if (!isFiniteNum(t[i]) || !(t[i] > 0) || (i > 0 && !(t[i] > t[i - 1]))) ok = false;
    }
    return (ok ? t : DEFAULT_SPACING_FT).slice();
  }

  // Percentile of an ascending array by linear interpolation between ranks; null when empty.
  function percentile(sorted, p) {
    var n = sorted.length;
    if (n === 0) return null;
    var h = (n - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }

  function ascending(p, q) { return p - q; }

  function idFilter(ids) {
    if (!Array.isArray(ids)) return null;
    var m = Object.create(null);
    for (var i = 0; i < ids.length; i++) m[ids[i]] = true;
    return m;
  }

  // A stop that is itself a station, platform or entrance (any location_type but 0), or sits inside a
  // station.
  function isStationStop(feed, id) {
    var s = feed._stops[id];
    if (!s) return false;
    if (s.locationType !== "" && s.locationType !== "0") return true;
    var p = s.parent !== "" ? feed._stops[s.parent] : null;
    return !!p && p.locationType === "1";
  }

  // Great-circle feet, unrounded; null when either stop lacks coordinates.
  function stopFeet(feed, idA, idB) {
    var a = feed._stops[idA], b = feed._stops[idB];
    if (!a || !b || typeof a.lat !== "number" || typeof a.lon !== "number" ||
        typeof b.lat !== "number" || typeof b.lon !== "number") return null;
    return haversine(a.lat, a.lon, b.lat, b.lon) * FEET_PER_METRE;
  }

  // Each in-scope route that runs on the date with its most-used pattern per direction, routes and
  // directions sorted as strings. Same pick as dominantPattern, without rebuilding the pattern list per
  // direction.
  function dominantPatternsByRoute(feed, date, opts) {
    var ents = filteredEntries(feed, date, opts), seen = Object.create(null), ids = [], i, j;
    for (i = 0; i < ents.length; i++) {
      var rid = ents[i].trip.routeId;
      if (!seen[rid]) { seen[rid] = true; ids.push(rid); }
    }
    ids.sort();
    var out = [];
    for (i = 0; i < ids.length; i++) {
      var list = patterns(feed, date, ids[i]), done = Object.create(null), dirs = [];
      for (j = 0; j < list.length; j++) {
        if (!done[list[j].directionId]) { done[list[j].directionId] = list[j]; dirs.push(list[j].directionId); }
      }
      dirs.sort();
      var pats = [];
      for (j = 0; j < dirs.length; j++) pats.push({ directionId: dirs[j], stops: done[dirs[j]].stops });
      out.push({ routeId: ids[i], patterns: pats });
    }
    return out;
  }

  // Every non-final stop-time row of the day's in-scope trips, grouped by store stop index: departure
  // times (frequency offset applied, blanks interpolated as stopSummary reads them) and the distinct
  // routes. One pass over the store, no per-stop scans, so a 7,500-stop feed stays fast.
  function dayStopDepartures(feed, date, opts) {
    var st = feed.st, ents = filteredEntries(feed, date, opts), n = st.stopIds.length;
    var deps = [], routes = [], cache = Object.create(null), i, r, k;
    for (k = 0; k < n; k++) { deps.push(null); routes.push(null); }
    for (i = 0; i < ents.length; i++) {
      var e = ents[i], a = st.tripStart[e.ti], b = st.tripStart[e.ti + 1], rid = e.trip.routeId;
      if (b - a < 2) continue;
      var tf = cache[e.ti];
      if (!tf) tf = cache[e.ti] = timesFor(feed, e.ti, true);
      for (r = a; r < b - 1; r++) {
        var d = tf.dep[r - a];
        if (d < 0) continue;
        k = st.stop[r];
        if (deps[k] === null) { deps[k] = []; routes[k] = []; }
        deps[k].push(d + e.off);
        var rl = routes[k];
        if (rl[rl.length - 1] !== rid && rl.indexOf(rid) < 0) rl.push(rid);
      }
    }
    return { deps: deps, routes: routes };
  }

  function bandIndex(t, feet) {
    for (var i = 0; i < 4; i++) if (feet < t[i]) return i;
    return 4;
  }

  // Distance between consecutive stops on each route's most-used pattern, sorted into five bands. A pair
  // with a stop that has no coordinates is counted in `skipped`, not binned.
  function stopSpacingStats(feed, date, opts) {
    var o = opts || {}, t = spacingThresholds(o.thresholdsFt), sf = idFilter(o.stopIds);
    var recs = dominantPatternsByRoute(feed, date, o), list = [], skipped = 0, byRoute = [], i, j, k;
    for (i = 0; i < recs.length; i++) {
      var feet = [];
      for (j = 0; j < recs[i].patterns.length; j++) {
        var pat = recs[i].patterns[j];
        for (k = 0; k + 1 < pat.stops.length; k++) {
          var from = pat.stops[k], to = pat.stops[k + 1];
          if (sf && !sf[from] && !sf[to]) continue;
          var ft = stopFeet(feed, from, to);
          if (ft === null) { skipped++; continue; }
          list.push({ routeId: recs[i].routeId, directionId: pat.directionId, fromStopId: from, toStopId: to,
            feet: ft, band: SPACING_BANDS[bandIndex(t, ft)].id });
          feet.push(ft);
        }
      }
      if (feet.length > 0) {
        feet.sort(ascending);
        byRoute.push({ routeId: recs[i].routeId, segments: feet.length, medianFt: percentile(feet, 0.5) });
      }
    }
    var counts = [0, 0, 0, 0, 0], all = [], sum = 0, n = list.length;
    for (i = 0; i < n; i++) {
      counts[bandIndex(t, list[i].feet)]++;
      all.push(list[i].feet);
      sum += list[i].feet;
    }
    all.sort(ascending);
    var bands = [];
    for (i = 0; i < 5; i++) {
      bands.push({
        id: SPACING_BANDS[i].id, label: SPACING_BANDS[i].label,
        minFt: i === 0 ? 0 : t[i - 1], maxFt: i === 4 ? null : t[i],
        count: counts[i], share: n === 0 ? 0 : counts[i] / n
      });
    }
    return {
      thresholdsFt: t, segments: n, skipped: skipped, bands: bands,
      medianFt: percentile(all, 0.5), meanFt: n === 0 ? null : sum / n,
      p10Ft: percentile(all, 0.1), p90Ft: percentile(all, 0.9),
      routes: byRoute, list: list
    };
  }

  // Close consecutive stops whose removal would save time. The stop with fewer trips goes (the later one
  // on a tie); it must not end any route's main pattern, which that route needs, and neither stop may be in a station.
  // The kept stop may be an end: riders walk to it. Saved time is an upper bound, since it assumes every
  // trip stops at the removed stop.
  function consolidationCandidates(feed, date, opts) {
    var o = opts || {}, sf = idFilter(o.stopIds);
    var maxFt = isFiniteNum(o.maxFt) && o.maxFt > 0 ? o.maxFt : 600;
    var secPer = isFiniteNum(o.secondsPerStop) && o.secondsPerStop >= 0 ? o.secondsPerStop : 20;
    var recs = dominantPatternsByRoute(feed, date, o);
    var day = dayStopDepartures(feed, date, o), best = Object.create(null), order = [], i, j, k;
    function tripsAt(id) {
      var ix = feed._stopIdx[id];
      return ix === undefined || day.deps[ix] === null ? 0 : day.deps[ix].length;
    }
    // A stop that ends any route's main pattern stays, even where another route passes through it.
    var ends = Object.create(null);
    for (i = 0; i < recs.length; i++) {
      for (j = 0; j < recs[i].patterns.length; j++) {
        var ps0 = recs[i].patterns[j].stops;
        if (ps0.length) { ends[ps0[0]] = true; ends[ps0[ps0.length - 1]] = true; }
      }
    }
    for (i = 0; i < recs.length; i++) {
      for (j = 0; j < recs[i].patterns.length; j++) {
        var stops = recs[i].patterns[j].stops, last = stops.length - 1;
        for (k = 0; k < last; k++) {
          var A = stops[k], B = stops[k + 1], feet = stopFeet(feed, A, B);
          if (feet === null || !(feet < maxFt)) continue;
          if (isStationStop(feed, A) || isStationStop(feed, B)) continue;
          var ta = tripsAt(A), tb = tripsAt(B);
          var removeA = ta < tb, rm = removeA ? A : B, rmPos = removeA ? k : k + 1;
          if (rmPos === 0 || rmPos === last || ends[rm]) continue;
          if (sf && !sf[rm]) continue;
          var cur = best[rm];
          if (cur && cur.feet <= feet) continue;
          if (!cur) order.push(rm);
          best[rm] = { removeStopId: rm, keepStopId: removeA ? B : A, feet: feet, trips: removeA ? ta : tb };
        }
      }
    }
    var out = [], saved = 0;
    for (i = 0; i < order.length; i++) {
      var c = best[order[i]], rids = [];
      for (j = 0; j < recs.length; j++) {
        var hit = false;
        for (k = 0; k < recs[j].patterns.length && !hit; k++) {
          var ps = recs[j].patterns[k].stops;
          for (var m = 0; m + 1 < ps.length; m++) {
            if ((ps[m] === c.removeStopId && ps[m + 1] === c.keepStopId) ||
                (ps[m] === c.keepStopId && ps[m + 1] === c.removeStopId)) { hit = true; break; }
          }
        }
        if (hit) rids.push(recs[j].routeId);
      }
      var sec = secPer * c.trips;
      saved += sec;
      out.push({ removeStopId: c.removeStopId, keepStopId: c.keepStopId, feet: c.feet, routeIds: rids,
        tripsPerDay: c.trips, savedSec: sec, extraWalkFt: c.feet });
    }
    out.sort(function (p, q) {
      if (p.savedSec !== q.savedSec) return q.savedSec - p.savedSec;
      return p.removeStopId < q.removeStopId ? -1 : p.removeStopId > q.removeStopId ? 1 : 0;
    });
    return { maxFt: maxFt, secondsPerStop: secPer, count: out.length, savedSecPerDay: saved, list: out };
  }

  // One row per stop with a departure that day, for every stop in a single pass. Numbers match stopSummary
  // for a stop with no children; a station's own id has no rows (its platforms carry them).
  function stopServiceTable(feed, date, opts) {
    var o = opts || {}, sf = idFilter(o.stopIds), parts = dayPartList(o.dayParts);
    var day = dayStopDepartures(feed, date, o), st = feed.st, out = [];
    for (var k = 0; k < day.deps.length; k++) {
      var deps = day.deps[k];
      if (deps === null) continue;
      var id = st.stopIds[k];
      if (sf && !sf[id]) continue;
      deps.sort(ascending);
      var heads = partHeadways(deps, parts), s = feed._stops[id];
      out.push({
        stopId: id, lat: s ? s.lat : null, lon: s ? s.lon : null,
        trips: deps.length, routes: day.routes[k].length,
        firstSec: deps[0], lastSec: deps[deps.length - 1],
        peakHeadwaySec: pooledHeadway(heads, parts, isPeakPart),
        offPeakHeadwaySec: pooledHeadway(heads, parts, isOffPeakPart)
      });
    }
    out.sort(function (p, q) { return p.stopId < q.stopId ? -1 : p.stopId > q.stopId ? 1 : 0; });
    return out;
  }

  // Test helper: stopServiceTable against stopSummary for every stop that has no children and is not a
  // station. Returns how many stops were compared and the ids that disagree (must be none).
  function stopTableInvariant(feed, date, opts) {
    var o = opts || {}, rows = stopServiceTable(feed, date, o), byId = Object.create(null), i;
    for (i = 0; i < rows.length; i++) byId[rows[i].stopId] = rows[i];
    var ids = Object.keys(feed._stops).sort(), checked = 0, bad = [];
    for (i = 0; i < ids.length; i++) {
      var s = feed._stops[ids[i]];
      if (s.children.length > 0 || isStationStop(feed, ids[i])) continue;
      checked++;
      var sum = stopSummary(feed, date, ids[i], { routeIds: o.routeIds, dayParts: o.dayParts }), row = byId[ids[i]];
      var ok;
      if (sum.departures === 0) ok = !row;
      else ok = !!row && row.trips === sum.departures && row.routes === sum.routes.length &&
        row.firstSec === sum.span.first && row.lastSec === sum.span.last &&
        row.peakHeadwaySec === sum.peakHeadwaySec && row.offPeakHeadwaySec === sum.offPeakHeadwaySec;
      if (!ok) bad.push(ids[i]);
    }
    return { checked: checked, mismatches: bad };
  }

  function wheelchairCounts() {
    return { stops: 0, stopsAccessible: 0, stopsNotAccessible: 0, stopsUnknown: 0,
      trips: 0, tripsAccessible: 0, tripsNotAccessible: 0, tripsUnknown: 0 };
  }

  // Wheelchair data completeness per route: its distinct stops by boarding value (a parent's value counts
  // when the stop has none) and its trips by wheelchair_accessible. A generated frequency run reads its
  // template trip.
  function wheelchairByRoute(feed, date, opts) {
    var ents = filteredEntries(feed, date, opts), st = feed.st, acc = stopAccessibility(feed);
    var byRoute = Object.create(null), ids = [], total = wheelchairCounts(), allStops = Object.create(null), i, r;
    function stopClass(stopIx) {
      var a = acc[st.stopIds[stopIx]], v = a ? a.value : 0;
      return v === 1 ? "stopsAccessible" : v === 2 ? "stopsNotAccessible" : "stopsUnknown";
    }
    for (i = 0; i < ents.length; i++) {
      var e = ents[i], rid = e.trip.routeId, rec = byRoute[rid];
      if (!rec) { rec = byRoute[rid] = { row: wheelchairCounts(), seen: Object.create(null), tis: Object.create(null) }; ids.push(rid); }
      var tpl = feed._tripsById[e.trip.generated ? e.trip.templateId : e.trip.tripId];
      var w = tpl ? tpl.wheelchair : "";
      var tk = w === "1" ? "tripsAccessible" : w === "2" ? "tripsNotAccessible" : "tripsUnknown";
      rec.row.trips++; rec.row[tk]++;
      total.trips++; total[tk]++;
      if (rec.tis[e.ti]) continue;
      rec.tis[e.ti] = true;
      for (r = st.tripStart[e.ti]; r < st.tripStart[e.ti + 1]; r++) {
        var si = st.stop[r];
        if (!rec.seen[si]) { rec.seen[si] = true; rec.row.stops++; rec.row[stopClass(si)]++; }
        if (!allStops[si]) { allStops[si] = true; total.stops++; total[stopClass(si)]++; }
      }
    }
    ids.sort();
    var routes = [];
    for (i = 0; i < ids.length; i++) {
      var row = byRoute[ids[i]].row;
      routes.push({ routeId: ids[i], stops: row.stops, stopsAccessible: row.stopsAccessible,
        stopsNotAccessible: row.stopsNotAccessible, stopsUnknown: row.stopsUnknown, trips: row.trips,
        tripsAccessible: row.tripsAccessible, tripsNotAccessible: row.tripsNotAccessible,
        tripsUnknown: row.tripsUnknown });
    }
    return { routes: routes, total: total };
  }

  // ---------------------------------------------------------------- feed health

  // Highest plausible speed (km/h) between two stops for a GTFS route_type, from the MobilityData
  // StopTimeTravelSpeedValidator table. A missing or unrecognised type gets the validator's 200 km/h default.
  function maxKphForRouteType(routeType) {
    var t = parseInt(routeType, 10);
    if (t === 0) return 100;
    if (t === 1 || t === 3 || t === 11 || t === 12) return 150;
    if (t === 2) return 500;
    if (t === 4) return 80;
    if (t === 5) return 30;
    if (t === 6 || t === 7) return 50;
    return 200;
  }

  // Metres from point p to segment a-b, each a [lon, lat]. Measured on a plane centred on p, which is
  // accurate at the scale of a stop and its shape. A zero-length segment is measured as a point.
  function metresToSegment(p, a, b) {
    var R = 6371008.8, k = Math.PI / 180;
    var kx = Math.cos(p[1] * k) * R * k, ky = R * k;
    var ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
    var dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var x = ax + t * dx, y = ay + t * dy;
    return Math.sqrt(x * x + y * y);
  }

  // The usable [lon, lat] points of one shape. Anything else (not an array, non-numeric pairs) is dropped,
  // so bad shape data reads as "no points" rather than throwing.
  function shapePoints(shapes, id) {
    var raw = shapes && Object.prototype.hasOwnProperty.call(shapes, id) ? shapes[id] : null;
    var out = [], i, p;
    if (!Array.isArray(raw)) return out;
    for (i = 0; i < raw.length; i++) {
      p = raw[i];
      if (p && typeof p[0] === "number" && typeof p[1] === "number" && isFinite(p[0]) && isFinite(p[1])) out.push(p);
    }
    return out;
  }

  // A blank shape_id never counts as having a shape, even if opts.shapes happens to carry a "" key.
  function hasShape(shapeSet, id) { return id !== "" && shapeSet[id] === true; }

  function hasCoords(s) { return !!s && typeof s.lat === "number" && typeof s.lon === "number"; }

  function healthExpiry(feed, today, max) {
    var check = { id: "expiry", label: "Feed expiry", status: "unknown", count: 0, checked: 0, examples: [], note: null };
    var end = null, source = null, fi = feed.tables["feed_info.txt"], range, i, fe, state, daysLeft;
    // Today is checked first, so a bad today argument is reported even when there is no end date.
    if (!isRealDate(today)) { check.note = "No valid today date."; return check; }
    if (fi) {
      for (i = 0; i < fi.rows.length; i++) {
        fe = g(fi.rows[i], "feed_end_date");
        if (isRealDate(fe)) { end = fe; source = "feed_info"; break; }
      }
    }
    if (end === null) {
      range = dateRange(feed);
      if (range && isRealDate(range.end)) { end = range.end; source = "calendar"; }
    }
    if (end === null) { check.note = "No end date in feed_info.txt or the calendar."; return check; }
    check.checked = 1;
    daysLeft = utcDay(end) - utcDay(today);
    if (end < today) state = "expired";
    else if (end < addDays(today, 7)) state = "7days";
    else if (end < addDays(today, 30)) state = "30days";
    else state = "ok";
    check.status = state === "expired" ? "error" : state === "ok" ? "ok" : "warning";
    check.count = state === "ok" ? 0 : 1;
    if (max >= 1) check.examples.push({ endDate: end, source: source, daysLeft: daysLeft, state: state });
    return check;
  }

  function healthShapes(feed, shapeSet, max) {
    var trips = feed._trips, i, t;
    var check = { id: "shapes", label: "Trips without a shape", status: "ok", count: 0, checked: trips.length, examples: [], note: null };
    for (i = 0; i < trips.length; i++) {
      t = trips[i];
      if (hasShape(shapeSet, t.shapeId)) continue;
      check.count++;
      if (check.examples.length < max) check.examples.push({ tripId: t.id, routeId: t.routeId, shapeId: t.shapeId });
    }
    check.status = check.count > 0 ? "warning" : "ok";
    return check;
  }

  function healthWheelchair(feed, max) {
    var check = { id: "wheelchair", label: "Stops without wheelchair data", status: "ok", count: 0, checked: 0, examples: [], note: null };
    var stopRows = feed.tables["stops.txt"] ? feed.tables["stops.txt"].rows : [];
    var seen = Object.create(null), i, sid, s, v, parent;
    for (i = 0; i < stopRows.length; i++) {
      sid = g(stopRows[i], "stop_id");
      if (sid === "" || seen[sid]) continue;
      seen[sid] = true;
      s = feed._stops[sid];
      if (!s || (s.locationType !== "" && s.locationType !== "0")) continue;
      check.checked++;
      v = s.wheelchair;
      parent = s.parent !== "" ? feed._stops[s.parent] : null;
      if (v !== "1" && v !== "2" && parent) v = parent.wheelchair;
      if (v === "1" || v === "2") continue;
      check.count++;
      if (check.examples.length < max) check.examples.push({ stopId: sid });
    }
    check.status = check.count > 0 ? "warning" : "ok";
    return check;
  }

  function healthSpeed(feed, max) {
    var check = { id: "speed", label: "Impossible speeds between stops", status: "ok", count: 0, checked: 0, examples: [],
      note: "Frequency-based trips are checked once, on their template times." };
    var st = feed.st, trips = feed._trips, i, r, end, a, b, route, maxKph, sec, kph, trip;
    for (i = 0; i < trips.length; i++) {
      trip = trips[i];
      if (trip.ti < 0) continue;
      route = feed._routes[trip.routeId];
      maxKph = maxKphForRouteType(route ? g(route, "route_type") : "");
      end = st.tripStart[trip.ti + 1];
      for (r = st.tripStart[trip.ti]; r + 1 < end; r++) {
        if (st.dep[r] < 0 || st.arr[r + 1] < 0) continue;
        a = feed._stops[st.stopIds[st.stop[r]]];
        b = feed._stops[st.stopIds[st.stop[r + 1]]];
        if (!hasCoords(a) || !hasCoords(b)) continue;
        check.checked++;
        // Times given to the whole minute may be rounded, so the true gap can be up to a minute longer
        // than it looks. A gap of zero or less is the same rounding at work, so it is taken as one minute.
        sec = st.arr[r + 1] - st.dep[r];
        if (sec <= 0) sec = 60;
        else if (st.arr[r + 1] % 60 === 0 && st.dep[r] % 60 === 0) sec += 60;
        kph = (haversine(a.lat, a.lon, b.lat, b.lon) / 1000) * 3600 / sec;
        if (kph <= maxKph) continue;
        check.count++;
        if (check.examples.length < max) {
          check.examples.push({ tripId: trip.id, routeId: trip.routeId, fromStopId: a.id, toStopId: b.id,
            kph: Math.round(kph * 10) / 10, maxKph: maxKph });
        }
      }
    }
    check.status = check.count > 0 ? "warning" : "ok";
    return check;
  }

  function healthShapeDistance(feed, shapeSet, shapeCount, shapes, max) {
    var check = { id: "shapeDistance", label: "Stops far from their shape", status: "ok", count: 0, checked: 0, examples: [], note: null };
    if (shapeCount === 0) { check.status = "unknown"; check.note = "No shapes loaded."; return check; }
    var st = feed.st, trips = feed._trips, seen = Object.create(null), pointsById = Object.create(null);
    var i, r, j, trip, pts, stopId, key, stop, p, d, dj;
    for (i = 0; i < trips.length; i++) {
      trip = trips[i];
      if (trip.ti < 0 || !hasShape(shapeSet, trip.shapeId)) continue;
      if (pointsById[trip.shapeId] === undefined) pointsById[trip.shapeId] = shapePoints(shapes, trip.shapeId);
      pts = pointsById[trip.shapeId];
      if (pts.length === 0) continue;
      for (r = st.tripStart[trip.ti]; r < st.tripStart[trip.ti + 1]; r++) {
        stopId = st.stopIds[st.stop[r]];
        key = trip.shapeId + "\u0001" + stopId;
        if (seen[key]) continue;
        stop = feed._stops[stopId];
        if (!hasCoords(stop)) continue;
        seen[key] = true;
        check.checked++;
        p = [stop.lon, stop.lat];
        d = metresToSegment(p, pts[0], pts[0]);
        for (j = 0; j + 1 < pts.length; j++) {
          dj = metresToSegment(p, pts[j], pts[j + 1]);
          if (dj < d) d = dj;
        }
        if (d <= 100) continue;
        check.count++;
        if (check.examples.length < max) check.examples.push({ stopId: stopId, shapeId: trip.shapeId, meters: Math.round(d) });
      }
    }
    check.status = check.count > 0 ? "warning" : "ok";
    return check;
  }

  function healthTimes(feed, max) {
    var st = feed.st, trips = feed._trips;
    var check = { id: "times", label: "Times that go backwards", status: "ok", count: 0, checked: 0, examples: [], note: null };
    var i, r, prevDep, trip;
    for (i = 0; i < trips.length; i++) {
      trip = trips[i];
      if (trip.ti < 0) continue;
      check.checked++;
      prevDep = -1;
      for (r = st.tripStart[trip.ti]; r < st.tripStart[trip.ti + 1]; r++) {
        if (st.arr[r] >= 0 && prevDep >= 0 && st.arr[r] < prevDep) {
          check.count++;
          if (check.examples.length < max) check.examples.push({ tripId: trip.id, stopSequence: st.seq[r], stopId: st.stopIds[st.stop[r]] });
        }
        if (st.dep[r] >= 0) prevDep = st.dep[r];
      }
    }
    check.status = check.count > 0 ? "error" : "ok";
    return check;
  }

  function healthAgency(feed, max) {
    var agencyTable = feed.tables["agency.txt"];
    var routeRows = feed.tables["routes.txt"] ? feed.tables["routes.txt"].rows : [];
    var agencies = agencyTable ? agencyTable.rows.length : 0;
    var check = { id: "agency", label: "Routes without agency_id", status: "ok", count: 0, checked: 0, examples: [], note: null };
    var seen = Object.create(null), i, rid;
    for (i = 0; i < routeRows.length; i++) {
      rid = g(routeRows[i], "route_id");
      if (rid === "" || seen[rid]) continue;
      seen[rid] = true;
      check.checked++;
      if (g(routeRows[i], "agency_id") !== "") continue;
      check.count++;
      if (check.examples.length < max) check.examples.push({ routeId: rid });
    }
    if (check.count > 0) {
      if (agencies > 1) check.status = "error";
      else {
        check.status = "warning";
        check.note = (agencies === 1 ? "One agency" : "No agency.txt rows") +
          ": agency_id is recommended (NTD reporting uses it).";
      }
    }
    return check;
  }

  // Seven read-only health checks in fixed order. Never throws on odd data: a check that cannot run reports
  // "unknown", and a bad item is skipped. opts = { today: "YYYYMMDD", shapes: {shapeId: [[lon, lat], ...]}, maxExamples }.
  function feedHealth(feed, opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    var max = typeof o.maxExamples === "number" && isFinite(o.maxExamples) && o.maxExamples >= 0 ? Math.floor(o.maxExamples) : 5;
    var shapes = o.shapes && typeof o.shapes === "object" ? o.shapes : null;
    var shapeSet = Object.create(null), shapeCount = 0, k;
    if (shapes) {
      for (k in shapes) {
        if (Object.prototype.hasOwnProperty.call(shapes, k)) { shapeSet[k] = true; shapeCount++; }
      }
    }
    return { checks: [
      healthExpiry(feed, o.today, max),
      healthShapes(feed, shapeSet, max),
      healthWheelchair(feed, max),
      healthSpeed(feed, max),
      healthShapeDistance(feed, shapeSet, shapeCount, shapes, max),
      healthTimes(feed, max),
      healthAgency(feed, max)
    ] };
  }

  // ---------------------------------------------------------------- test helper

  function evaluate(texts, fnName, args) {
    var feed = feedFromTexts(texts);
    if (fnName === "problems") return feed.problems;
    if (fnName === "store") {
      var s = feed.st;
      return {
        rowCount: s.rowCount, badRows: s.badRows, duplicateRows: s.duplicateRows,
        tripIds: s.tripIds, stopIds: s.stopIds,
        seq: Array.from(s.seq), arr: Array.from(s.arr), dep: Array.from(s.dep),
        tp: Array.from(s.tp), tripStart: Array.from(s.tripStart)
      };
    }
    return window.GtfsSchedule[fnName].apply(null, [feed].concat(args || []));
  }

  window.GtfsSchedule = {
    parseTime: parseTime, formatTime: formatTime,
    CsvStream: CsvStream, parseCSV: parseCSV, _csvChunks: _csvChunks,
    StopTimesBuilder: StopTimesBuilder, buildFeed: buildFeed, feedFromTexts: feedFromTexts,
    dateRange: dateRange, activeServices: activeServices, dayType: dayType,
    tripsOnDate: tripsOnDate, tripStopTimes: tripStopTimes, departuresAtStop: departuresAtStop,
    medianHeadway: medianHeadway, patterns: patterns, dominantPattern: dominantPattern,
    routeDaySummary: routeDaySummary, peakVehicles: peakVehicles,
    stopAccessibility: stopAccessibility, busiestDate: busiestDate, evaluate: evaluate,
    DEFAULT_DAY_PARTS: DEFAULT_DAY_PARTS, bandTripCount: bandTripCount, headwayBands: headwayBands,
    meanTripMinutes: meanTripMinutes, bandsEqual: bandsEqual, _bandInvariant: bandInvariant,
    serviceCopyPlan: serviceCopyPlan, reconciliationNote: reconciliationNote,
    stopDepartures: stopDepartures, stopSummary: stopSummary, stopSpacing: stopSpacing,
    routeSchedule: routeSchedule, feedOverview: feedOverview,
    routeServiceDay: routeServiceDay, serviceYear: serviceYear,
    serviceDayFromTrips: serviceDayFromTrips, serviceYearFromTrips: serviceYearFromTrips, _serviceYearInvariant: serviceYearInvariant, calendarDayCounts: calendarDayCounts,
    stopSpacingStats: stopSpacingStats, consolidationCandidates: consolidationCandidates,
    stopServiceTable: stopServiceTable, wheelchairByRoute: wheelchairByRoute,
    feedHealth: feedHealth,
    _stopTableInvariant: stopTableInvariant,
    dayPartList: dayPartList, partHeadways: partHeadways, pooledHeadway: pooledHeadway,
    isPeakPart: isPeakPart, isOffPeakPart: isOffPeakPart, isStationStop: isStationStop
  };
})();
