// js/core/gtfs-export.js
// GTFS export engine (window.GtfsExport). Turns the drawn Services, as plain data, into the text of a GTFS
// feed: { files: [{ name, text }], counts, warnings }. The trips are AnalysisNetwork.proposalTrips output, so
// the feed describes the same departures the travel-time analyses use.
// A headway band whose headway is a whole number of seconds is written as one template trip plus one
// exact_times=1 frequency window. A reader that expands the window gets the same departures and no trip is
// run twice. Any other band is written trip by trip.
// CONSTRAINT: plain values only. window.AnalysisNetwork is read inside build at call time, never at load
// time, so the golden harness can load this file with analysis-network.js alone. ES5 syntax, like js/.

(function () {
  "use strict";

  // Day types in the order the feed writes them. days runs Monday to Sunday, as calendar.txt does.
  var DAY_TYPES = [
    { dayType: "weekday", serviceId: "WK", days: [1, 1, 1, 1, 1, 0, 0] },
    { dayType: "saturday", serviceId: "SA", days: [0, 0, 0, 0, 0, 1, 0] },
    { dayType: "sunday", serviceId: "SU", days: [0, 0, 0, 0, 0, 0, 1] }
  ];

  var URL_RE = /^https?:\/\/\S+$/;
  var TIMEZONE_RE = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+)$/;
  var DATE_RE = /^\d{8}$/;
  var HEX_RE = /^[0-9A-F]{6}$/;

  // Plain numbers only: null must not pass as a coordinate, so typeof is checked before isFinite.
  function isNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  // Trimmed text of an input field; a missing field reads as "".
  function str(x) {
    return x === null || x === undefined ? "" : String(x).trim();
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // Whole seconds after midnight as HH:MM:SS. Hours past 24 are kept: GTFS writes trips after midnight that way.
  function hms(sec) {
    var s = Math.round(sec);
    return pad2(Math.floor(s / 3600)) + ":" + pad2(Math.floor((s % 3600) / 60)) + ":" + pad2(s % 60);
  }

  // A value holding a comma, a quote or a line break is quoted, with its quotes doubled, or the row splits.
  function csvField(v) {
    var s = v === null || v === undefined ? "" : String(v);
    return /[,"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csvRow(values) {
    var out = [], i;
    for (i = 0; i < values.length; i++) out.push(csvField(values[i]));
    return out.join(",");
  }

  // One feed file: the header line, then one line per row, every line ending in a newline.
  function csvFile(name, header, rows) {
    var lines = [csvRow(header)], i;
    for (i = 0; i < rows.length; i++) lines.push(csvRow(rows[i]));
    return { name: name, text: lines.join("\n") + "\n" };
  }

  function daysInMonth(y, m) {
    if (m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
    return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
  }

  // A real calendar date in YYYYMMDD. February 30 is refused, and leap years are counted.
  function isRealDate(s) {
    if (!DATE_RE.test(s)) return false;
    var y = parseInt(s.substring(0, 4), 10);
    var m = parseInt(s.substring(4, 6), 10);
    var d = parseInt(s.substring(6, 8), 10);
    return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }

  // The line of a pattern: points that are not two finite numbers are dropped, then consecutive repeats.
  // A repeat would give a zero-length segment that some readers reject.
  function cleanShape(shape) {
    var out = [], i, p, last;
    if (!Array.isArray(shape)) return out;
    for (i = 0; i < shape.length; i++) {
      p = shape[i];
      if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) continue;
      last = out.length ? out[out.length - 1] : null;
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push([p[0], p[1]]);
    }
    return out;
  }

  // A pattern's directionId, trimmed. A blank or missing one reads as "0", the way proposalTrips reads it.
  function directionOf(x) {
    var s = str(x);
    return s === "" ? "0" : s;
  }

  // Trips of one direction keep the order proposalTrips gave them; directions are listed in the order they first appear.
  function groupByDirection(list) {
    var groups = [], index = Object.create(null), i, t, g;
    for (i = 0; i < list.length; i++) {
      t = list[i];
      g = index[t.directionId];
      if (g === undefined) {
        g = [];
        index[t.directionId] = g;
        groups.push(g);
      }
      g.push(t);
    }
    return groups;
  }

  // Stop data for a stop id: the first route, in input order, whose proposal lists that id.
  function findStop(routes, id) {
    var i, j, list;
    for (i = 0; i < routes.length; i++) {
      list = routes[i] && routes[i].proposal && Array.isArray(routes[i].proposal.stops) ? routes[i].proposal.stops : [];
      for (j = 0; j < list.length; j++) {
        if (list[j] && String(list[j].id) === id) return list[j];
      }
    }
    return null;
  }

  // The first free trip id: the base, then base-2, base-3 and so on. Two bands can start a trip at the same time.
  function uniqueId(out, base) {
    var id = base, n = 2;
    while (out.usedIds[id]) {
      id = base + "-" + n;
      n++;
    }
    out.usedIds[id] = true;
    return id;
  }

  // The shape id a written trip uses, registered on the shape's first use so shapes.txt holds only used shapes.
  // A trip running against a two-way pattern gets the reversed line. A pattern with no line gives "" and one warning.
  function shapeIdFor(out, pc, tripDir) {
    if (pc.points.length < 2) {
      if (!pc.warned) {
        pc.warned = true;
        out.warnings.push('Service "' + pc.routeId + '" pattern ' + pc.pid + ' has no line shape.');
      }
      return "";
    }
    var reversed = pc.both && tripDir !== pc.patDir;
    var id = pc.routeId + "-" + pc.pid + (reversed ? "-r" : "");
    if (!out.shapeSeen[id]) {
      out.shapeSeen[id] = true;
      out.shapes.push({ id: id, points: reversed ? pc.points.slice().reverse() : pc.points });
    }
    return id;
  }

  // Writes one trip: its trips.txt row, its stop_times rows and its shape. Returns the trip id it wrote.
  function writeTrip(out, pc, trip, serviceId) {
    var id = uniqueId(out, pc.routeId + "-" + serviceId + "-" + pc.pid + "-" + trip.directionId + "-" + trip.dep[0]);
    var n = trip.stops.length, k, stopId;
    out.trips.push([pc.routeId, serviceId, id, trip.directionId, shapeIdFor(out, pc, trip.directionId)]);
    out.dayUsed[serviceId] = true;
    for (k = 0; k < n; k++) {
      stopId = trip.stops[k];
      // Only the first and last stops are timepoints: the stops between them are interpolated, not timed.
      out.stopTimes.push([id, hms(trip.arr[k]), hms(trip.dep[k]), stopId, k + 1, k === 0 || k === n - 1 ? 1 : 0]);
      if (!out.stopSeen[stopId]) {
        out.stopSeen[stopId] = true;
        out.stopOrder.push(stopId);
      }
    }
    return id;
  }

  // A copy of the pattern that carries only this one band, so proposalTrips makes exactly this band's trips.
  // The input pattern is never changed.
  function singleBandPattern(pattern, day, band, patDir) {
    var copy = {}, bands = {}, key;
    for (key in pattern) {
      if (Object.prototype.hasOwnProperty.call(pattern, key)) copy[key] = pattern[key];
    }
    bands[day.dayType] = [band];
    copy.bands = bands;
    copy.directionId = patDir;
    return copy;
  }

  // A headway is whole seconds when it is within a millionth of a second of a whole number.
  // Frequency windows carry whole seconds only, so a fractional headway cannot become one.
  function isWholeHeadway(headSec) {
    return Math.abs(headSec - Math.round(headSec)) < 1e-6 && Math.round(headSec) >= 60;
  }

  // One headway band of one pattern on one day type. Each direction is written as one template trip plus a
  // frequency window when the band qualifies, otherwise trip by trip.
  function writeBand(out, pc, day, band, frequencies) {
    var list = window.AnalysisNetwork.proposalTrips(
      { key: pc.routeId, patterns: [singleBandPattern(pc.pattern, day, band, pc.patDir)] },
      day.dayType
    );
    var groups = groupByDirection(list);
    var headSec = parseFloat(band.frequency) * 60;
    var g, group, first, last, k, tripId;
    for (g = 0; g < groups.length; g++) {
      group = groups[g];
      out.tripsRepresented += group.length;
      if (frequencies && group.length >= 2 && isWholeHeadway(headSec)) {
        first = group[0];
        last = group[group.length - 1];
        tripId = writeTrip(out, pc, first, day.serviceId);
        out.frequencies.push([tripId, hms(first.dep[0]), hms(last.dep[0] + Math.round(headSec)), Math.round(headSec), 1]);
      } else {
        for (k = 0; k < group.length; k++) writeTrip(out, pc, group[k], day.serviceId);
      }
    }
  }

  // Writes every trip of one pattern: each day type in order, each band in array order.
  function writePattern(out, routeId, pattern, frequencies) {
    var pc = {
      routeId: routeId,
      pattern: pattern,
      pid: str(pattern.id),
      patDir: directionOf(pattern.directionId),
      both: !!pattern.both,
      points: cleanShape(pattern.shape),
      warned: false
    };
    var d, b, bands;
    for (d = 0; d < DAY_TYPES.length; d++) {
      bands = pattern.bands && Array.isArray(pattern.bands[DAY_TYPES[d].dayType]) ? pattern.bands[DAY_TYPES[d].dayType] : [];
      for (b = 0; b < bands.length; b++) {
        if (bands[b] && typeof bands[b] === "object") writeBand(out, pc, DAY_TYPES[d], bands[b], frequencies);
      }
    }
  }

  // routes.txt row for one Service. A color is six hex digits; its text is white on a dark color, black otherwise.
  function routeRow(routeId, route, agencyId) {
    var shortName = str(route.shortName);
    var longName = str(route.longName);
    var type = parseInt(route.routeType, 10);
    var color = str(route.color).replace(/^#/, "").toUpperCase();
    var text = "";
    if (!HEX_RE.test(color)) color = "";
    if (color !== "") {
      var lum = 0.299 * parseInt(color.substr(0, 2), 16) + 0.587 * parseInt(color.substr(2, 2), 16) +
        0.114 * parseInt(color.substr(4, 2), 16);
      text = lum < 140 ? "FFFFFF" : "000000";
    }
    return [
      routeId, agencyId, shortName,
      shortName === "" && longName === "" ? routeId : longName,
      isNaN(type) ? 3 : type, color, text
    ];
  }

  // Input is checked in the order the export dialog reports it. Throws an Error with the dialog's text.
  function build(input) {
    var inp = input || {};
    var ag = inp.agency || {};
    var agency = {
      id: str(ag.id) || "A1",
      name: str(ag.name),
      url: str(ag.url),
      timezone: str(ag.timezone),
      lang: str(ag.lang),
      phone: str(ag.phone)
    };
    var startDate = str(inp.startDate);
    var endDate = str(inp.endDate);
    var feedVersion = str(inp.feedVersion);
    var routes = inp.routes;
    var frequencies = !!inp.frequencies;

    if (agency.name === "") throw new Error("Enter the agency name.");
    if (!URL_RE.test(agency.url)) throw new Error("Agency URL must start with http:// or https://.");
    if (!TIMEZONE_RE.test(agency.timezone)) throw new Error("Enter a time zone such as America/Denver.");
    if (!isRealDate(startDate) || !isRealDate(endDate)) throw new Error("Enter start and end dates.");
    if (endDate < startDate) throw new Error("The end date is before the start date.");
    if (!Array.isArray(routes) || routes.length === 0) throw new Error("Choose at least one Service.");

    var out = {
      trips: [],
      stopTimes: [],
      frequencies: [],
      shapes: [],
      shapeSeen: Object.create(null),
      usedIds: Object.create(null),
      dayUsed: Object.create(null),
      stopOrder: [],
      stopSeen: Object.create(null),
      tripsRepresented: 0,
      warnings: []
    };
    var kept = [];
    var r, i, j, route, routeId, before, written, patterns, label;

    for (r = 0; r < routes.length; r++) {
      route = routes[r] || {};
      routeId = str(route.routeId);
      before = out.trips.length;
      patterns = route.proposal && Array.isArray(route.proposal.patterns) ? route.proposal.patterns : [];
      for (i = 0; i < patterns.length; i++) {
        if (patterns[i] && typeof patterns[i] === "object") writePattern(out, routeId, patterns[i], frequencies);
      }
      written = out.trips.length - before;
      if (written === 0) {
        label = str(route.shortName) || str(route.longName) || routeId;
        out.warnings.push('Service "' + label + '" has no trips in its headway bands and was left out.');
      } else {
        kept.push({ routeId: routeId, route: route });
      }
    }

    if (out.trips.length === 0) {
      throw new Error("No trips to export: the selected Services have no headway bands with service.");
    }

    // Stop rows are written in the order the trips first use them. The name counter follows output order.
    var stopRows = [], nameless = 0, stopId, stop, name;
    for (j = 0; j < out.stopOrder.length; j++) {
      stopId = out.stopOrder[j];
      stop = findStop(routes, stopId);
      if (!stop || !isNum(stop.lat) || !isNum(stop.lon)) throw new Error('Stop "' + stopId + '" has no location.');
      name = str(stop.name);
      if (name === "") {
        nameless++;
        name = "Stop " + nameless;
      }
      stopRows.push([stopId, name, stop.lat.toFixed(6), stop.lon.toFixed(6)]);
    }

    var routeRows = [];
    for (i = 0; i < kept.length; i++) routeRows.push(routeRow(kept[i].routeId, kept[i].route, agency.id));

    var calendarRows = [];
    for (i = 0; i < DAY_TYPES.length; i++) {
      if (out.dayUsed[DAY_TYPES[i].serviceId]) {
        calendarRows.push([DAY_TYPES[i].serviceId].concat(DAY_TYPES[i].days, [startDate, endDate]));
      }
    }

    var shapeRows = [], pts;
    for (i = 0; i < out.shapes.length; i++) {
      pts = out.shapes[i].points;
      for (j = 0; j < pts.length; j++) {
        // Stored as [lon, lat], the order GeoJSON uses.
        shapeRows.push([out.shapes[i].id, pts[j][1].toFixed(6), pts[j][0].toFixed(6), j + 1]);
      }
    }

    var files = [
      csvFile("agency.txt",
        ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone"],
        [[agency.id, agency.name, agency.url, agency.timezone, agency.lang, agency.phone]]),
      csvFile("stops.txt", ["stop_id", "stop_name", "stop_lat", "stop_lon"], stopRows),
      csvFile("routes.txt",
        ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"],
        routeRows),
      csvFile("trips.txt", ["route_id", "service_id", "trip_id", "direction_id", "shape_id"], out.trips),
      csvFile("stop_times.txt",
        ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "timepoint"],
        out.stopTimes),
      csvFile("calendar.txt",
        ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
        calendarRows)
    ];
    if (shapeRows.length) {
      files.push(csvFile("shapes.txt", ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], shapeRows));
    }
    if (out.frequencies.length) {
      files.push(csvFile("frequencies.txt",
        ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"], out.frequencies));
    }
    files.push(csvFile("feed_info.txt",
      ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
      [[agency.name, agency.url, agency.lang || "en", startDate, endDate, feedVersion]]));

    return {
      files: files,
      counts: {
        routes: routeRows.length,
        stops: stopRows.length,
        trips: out.trips.length,
        tripsRepresented: out.tripsRepresented,
        stopTimes: out.stopTimes.length,
        shapes: out.shapes.length,
        frequencies: out.frequencies.length
      },
      warnings: out.warnings
    };
  }

  // Golden and dialog entry point: the build result, or { error } with the message a refused input shows.
  function evaluate(input) {
    try {
      return build(input);
    } catch (e) {
      return { error: e.message };
    }
  }

  window.GtfsExport = { build: build, hms: hms, csvRow: csvRow, evaluate: evaluate };

})();
