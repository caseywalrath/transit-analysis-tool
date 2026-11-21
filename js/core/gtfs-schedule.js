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
        shapeId: g(rows[i], "shape_id"),
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
    routeSchedule: routeSchedule, feedOverview: feedOverview
  };
})();
