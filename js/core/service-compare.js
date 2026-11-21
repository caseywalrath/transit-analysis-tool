// js/core/service-compare.js
// Build vs No-Build service comparison engine (window.ServiceCompare) for the
// GTFS Service Analysis Compare tab. matchRoutes pairs the routes of two service
// summaries (an explicit pair list, then the same route key, then a unique short
// name, then a unique long name); compare turns the matches into per-route and
// total changes; precheck flags the changed routes that meet the Title VI
// major-change rules; csv lays the result out as a table.
// A service summary is { label, year, routes }: year is a serviceYear result from
// gtfs-schedule.js, and routes maps each route key to { id, shortName, longName, type }.
// CONSTRAINT: plain-value math only — no App, turf, DOM or map — so the golden
// harness can load it into a bare node:vm sandbox. ES5 syntax, like the rest of js/.

(function () {
  "use strict";

  // Column order of the table and the CSV.
  var METRICS = [
    { key: "trips", label: "Trips/yr" },
    { key: "runningHrs", label: "Running hr/yr" },
    { key: "revenueHrs", label: "Revenue hr/yr" },
    { key: "platformHrs", label: "Platform hr/yr" },
    { key: "cost", label: "Cost/yr" },
    { key: "peakVehicles", label: "Peak vehicles" },
    { key: "spanHrs", label: "Weekday span hr" }
  ];

  // Sums of the same figures can differ in the last bit, so a difference this small is no change.
  var CHANGE_EPSILON = 0.005;

  function isFiniteNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  // A missing or non-numeric figure counts as zero, so one bad field never breaks a comparison.
  function num(x) {
    return isFiniteNum(x) ? x : 0;
  }

  function text(x) {
    return typeof x === "string" ? x : "";
  }

  function nonBlank(x) {
    var s = text(x);
    return s.trim() !== "" ? s : "";
  }

  function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function orNull(x) {
    return x === undefined ? null : x;
  }

  function cell(x) {
    return x === null || x === undefined ? "" : x;
  }

  function round2(x) {
    return x === null ? null : Math.round(x * 100) / 100;
  }

  function ruleOn(rule) {
    return !!rule && !!rule.enabled;
  }

  // Null-safe read of a route record. A key the side does not list reads as empty.
  function routeOf(routes, key) {
    var r = hasOwn(routes, key) ? routes[key] : null;
    return r && typeof r === "object" ? r : {};
  }

  // Name shown for a matched or unmatched route: the a-side name when there is one, else the b-side.
  function displayName(aRoutes, bRoutes, aKey, bKey) {
    var r = aKey !== null ? routeOf(aRoutes, aKey) : routeOf(bRoutes, bKey);
    return nonBlank(r.shortName) || nonBlank(r.longName) || nonBlank(r.id) || (aKey !== null ? aKey : bKey);
  }

  // Matching form of a name: trimmed and lower-case, and a blank name never matches.
  function matchName(route, field) {
    return nonBlank(route[field]).trim().toLowerCase();
  }

  // Pairs the unmatched routes whose name is unique among the unmatched routes on both sides.
  // A name shared by two routes on either side cannot say which route is meant, so it never matches.
  function matchByName(aRoutes, bRoutes, aKeys, bKeys, aUsed, bUsed, field, how, out) {
    var countA = Object.create(null), countB = Object.create(null), bKeyOf = Object.create(null);
    var i, n;
    for (i = 0; i < aKeys.length; i++) {
      if (aUsed[aKeys[i]]) continue;
      n = matchName(routeOf(aRoutes, aKeys[i]), field);
      if (n !== "") countA[n] = (countA[n] || 0) + 1;
    }
    for (i = 0; i < bKeys.length; i++) {
      if (bUsed[bKeys[i]]) continue;
      n = matchName(routeOf(bRoutes, bKeys[i]), field);
      if (n !== "") {
        countB[n] = (countB[n] || 0) + 1;
        bKeyOf[n] = bKeys[i];
      }
    }
    for (i = 0; i < aKeys.length; i++) {
      if (aUsed[aKeys[i]]) continue;
      n = matchName(routeOf(aRoutes, aKeys[i]), field);
      if (n === "" || countA[n] !== 1 || countB[n] !== 1) continue;
      aUsed[aKeys[i]] = true;
      bUsed[bKeyOf[n]] = true;
      out.push({ a: aKeys[i], b: bKeyOf[n], how: how });
    }
  }

  // aRoutes, bRoutes: { key: { id, shortName, longName, type } }
  // pairs: [{ a, b }] the user matched by hand; b === null says the a route is gone in the Build.
  // Returns [{ a, b, how }], how being "pair", "id", "short", "long" or null (unmatched).
  // Sorted by display name so the table and the CSV read the same way.
  function matchRoutes(aRoutes, bRoutes, pairs) {
    var aMap = aRoutes && typeof aRoutes === "object" ? aRoutes : {};
    var bMap = bRoutes && typeof bRoutes === "object" ? bRoutes : {};
    var aKeys = Object.keys(aMap), bKeys = Object.keys(bMap);
    var aUsed = Object.create(null), bUsed = Object.create(null);
    var list = Array.isArray(pairs) ? pairs : [];
    var out = [];
    var i, p, k;

    // Pairs apply in the order the user made them. A pair naming a key that is not on its
    // side is ignored, so a stale pair cannot match or drop a route silently.
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (!p || typeof p.a !== "string" || !hasOwn(aMap, p.a) || aUsed[p.a]) continue;
      if (p.b === null) {
        aUsed[p.a] = true;
        out.push({ a: p.a, b: null, how: "pair" });
        continue;
      }
      if (typeof p.b !== "string" || !hasOwn(bMap, p.b) || bUsed[p.b]) continue;
      aUsed[p.a] = true;
      bUsed[p.b] = true;
      out.push({ a: p.a, b: p.b, how: "pair" });
    }

    // The same route key on both sides is the same route.
    for (i = 0; i < aKeys.length; i++) {
      k = aKeys[i];
      if (aUsed[k] || bUsed[k] || !hasOwn(bMap, k)) continue;
      aUsed[k] = true;
      bUsed[k] = true;
      out.push({ a: k, b: k, how: "id" });
    }

    matchByName(aMap, bMap, aKeys, bKeys, aUsed, bUsed, "shortName", "short", out);
    matchByName(aMap, bMap, aKeys, bKeys, aUsed, bUsed, "longName", "long", out);

    for (i = 0; i < aKeys.length; i++) {
      if (!aUsed[aKeys[i]]) out.push({ a: aKeys[i], b: null, how: null });
    }
    for (i = 0; i < bKeys.length; i++) {
      if (!bUsed[bKeys[i]]) out.push({ a: null, b: bKeys[i], how: null });
    }

    out.sort(function (x, y) {
      var c = displayName(aMap, bMap, x.a, x.b).localeCompare(displayName(aMap, bMap, y.a, y.b), undefined, { numeric: true });
      if (c !== 0) return c;
      // Equal names fall back to the keys, so two routes called "15" keep a fixed order.
      var kx = (x.a || "") + "\u0001" + (x.b || ""), ky = (y.a || "") + "\u0001" + (y.b || "");
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });
    return out;
  }

  function weekdaySpan(entry) {
    var pd = entry && entry.perDay;
    return pd && pd.weekday ? pd.weekday.spanHrs : null;
  }

  function figuresOf(annual, peakVehicles, span) {
    var a = annual && typeof annual === "object" ? annual : {};
    return {
      trips: num(a.trips),
      runningHrs: num(a.runningHrs),
      revenueHrs: num(a.revenueHrs),
      platformHrs: num(a.platformHrs),
      cost: num(a.cost),
      peakVehicles: num(peakVehicles),
      spanHrs: isFiniteNum(span) ? span : null
    };
  }

  // Figures for one route on one side. A null key means this side does not have the route at all:
  // a route added or removed is a change from or to zero service, so its span is zero too.
  // A key the summary lists with no entry in year.routes has no service in the year: its span is
  // unknown, so it stays null instead of reading as zero.
  function routeFigures(year, key) {
    if (key === null) return figuresOf(null, 0, 0);
    var yearRoutes = year && year.routes;
    if (!hasOwn(yearRoutes, key) || !yearRoutes[key]) return figuresOf(null, 0, null);
    var r = yearRoutes[key];
    return figuresOf(r.annual, r.peakVehicles, weekdaySpan(r));
  }

  function totalFigures(year) {
    var t = year && year.total && typeof year.total === "object" ? year.total : {};
    return figuresOf(t.annual, t.peakVehicles, weekdaySpan(t));
  }

  // Unrounded { a, b, diff, pct } per metric. A null side gives a null diff, and a zero base gives a null pct.
  function rawMetrics(aF, bF) {
    var out = {}, i, k, av, bv, diff;
    for (i = 0; i < METRICS.length; i++) {
      k = METRICS[i].key;
      av = aF[k];
      bv = bF[k];
      diff = av === null || bv === null ? null : bv - av;
      out[k] = { a: av, b: bv, diff: diff, pct: diff === null || !av ? null : diff / av * 100 };
    }
    return out;
  }

  function roundMetrics(raw) {
    var out = {}, i, k, m;
    for (i = 0; i < METRICS.length; i++) {
      k = METRICS[i].key;
      m = raw[k];
      out[k] = { a: round2(m.a), b: round2(m.b), diff: round2(m.diff), pct: round2(m.pct) };
    }
    return out;
  }

  // Status is decided on the unrounded diffs, so rounding never moves a route between statuses.
  function rowStatus(aKey, bKey, raw) {
    if (aKey === null) return "added";
    if (bKey === null) return "removed";
    for (var i = 0; i < METRICS.length; i++) {
      var d = raw[METRICS[i].key].diff;
      if (d !== null && Math.abs(d) > CHANGE_EPSILON) return "changed";
    }
    return "unchanged";
  }

  // noBuild, build: { label, year, routes }. opts: { pairs } (see matchRoutes).
  // Returns { rows, total: { metrics }, counts }.
  function compare(noBuild, build, opts) {
    var nb = noBuild || {}, bd = build || {};
    var aRoutes = nb.routes || {}, bRoutes = bd.routes || {};
    var matched = matchRoutes(aRoutes, bRoutes, opts ? opts.pairs : null);
    var counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    var rows = [];
    for (var i = 0; i < matched.length; i++) {
      var m = matched[i];
      var raw = rawMetrics(routeFigures(nb.year, m.a), routeFigures(bd.year, m.b));
      var status = rowStatus(m.a, m.b, raw);
      counts[status]++;
      rows.push({
        aKey: m.a,
        bKey: m.b,
        name: displayName(aRoutes, bRoutes, m.a, m.b),
        match: m.how,
        status: status,
        metrics: roundMetrics(raw)
      });
    }
    return {
      rows: rows,
      total: { metrics: roundMetrics(rawMetrics(totalFigures(nb.year), totalFigures(bd.year))) },
      counts: counts
    };
  }

  function metricPct(row, key) {
    var m = row.metrics ? row.metrics[key] : null;
    return m && isFiniteNum(m.pct) ? m.pct : null;
  }

  // A threshold is crossed when the absolute change is at least the threshold. An unknown
  // change (null) never crosses it.
  function overThreshold(rule, pct) {
    return ruleOn(rule) && isFiniteNum(pct) && isFiniteNum(rule.threshold) && Math.abs(pct) >= rule.threshold;
  }

  // rows: compare().rows. majorChange: { revenueHoursPct, spanHoursPct, routeElimination } in the
  // shape of TitleVI's default policy (js/projects/title-vi-engine.js). Unchanged rows are left out.
  function precheck(rows, majorChange) {
    var list = Array.isArray(rows) ? rows : [];
    var rules = majorChange && typeof majorChange === "object" ? majorChange : {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || row.status === "unchanged") continue;
      var revPct = metricPct(row, "revenueHrs");
      var spanPct = metricPct(row, "spanHrs");
      var triggers = [];
      if (overThreshold(rules.revenueHoursPct, revPct)) triggers.push("revenueHoursPct");
      if (overThreshold(rules.spanHoursPct, spanPct)) triggers.push("spanHoursPct");
      if (row.status === "removed" && ruleOn(rules.routeElimination)) triggers.push("routeElimination");
      out.push({
        aKey: orNull(row.aKey),
        bKey: orNull(row.bKey),
        name: cell(row.name),
        changeType: row.status === "added" ? "new_route" : row.status === "removed" ? "elimination" : "adjustment",
        revenueHoursPct: revPct,
        spanHoursPct: spanPct,
        triggers: triggers,
        suggested: triggers.length > 0
      });
    }
    return out;
  }

  function csvRow(name, status, match, metrics) {
    var out = [name, status, cell(match)];
    for (var i = 0; i < METRICS.length; i++) {
      var m = metrics ? metrics[METRICS[i].key] : null;
      out.push(cell(m ? m.a : null), cell(m ? m.b : null), cell(m ? m.diff : null), cell(m ? m.pct : null));
    }
    return out;
  }

  // result: compare() output. labels: { a, b } names for the two sides in the column headers.
  // Returns { header: [...], rows: [[...]] } with one row per result row and a final Total row.
  function csv(result, labels) {
    var res = result || {};
    var lb = labels || {};
    var aLabel = text(lb.a), bLabel = text(lb.b);
    var list = Array.isArray(res.rows) ? res.rows : [];
    var header = ["Route", "Status", "Matched by"];
    var out = [];
    var i, label;
    for (i = 0; i < METRICS.length; i++) {
      label = METRICS[i].label;
      header.push(label + " (" + aLabel + ")", label + " (" + bLabel + ")", label + " change", label + " change %");
    }
    for (i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      out.push(csvRow(cell(list[i].name), cell(list[i].status), list[i].match, list[i].metrics));
    }
    out.push(csvRow("Total", "", null, res.total ? res.total.metrics : null));
    return { header: header, rows: out };
  }

  // Golden entry point: evaluate("compare", [noBuild, build, opts]) runs ServiceCompare.compare.
  function evaluate(fn, args) {
    return ServiceCompare[fn].apply(null, args);
  }

  var ServiceCompare = {
    matchRoutes: matchRoutes,
    compare: compare,
    precheck: precheck,
    csv: csv,
    evaluate: evaluate
  };

  window.ServiceCompare = ServiceCompare;

})();
