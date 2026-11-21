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
    stopAccessibility: stopAccessibility, busiestDate: busiestDate, evaluate: evaluate
  };
})();
