// js/projects/trip-builder.js
// Trip Builder: generates a high-level trip schedule for each Service from
// the underlying Route/Line attributes (Direction, Time Bands, Frequency,
// Run time, Avg speed). Two-column popup like Route Costing — left lists
// every Service, right shows side-by-side Start/End tables per direction
// per day type. Trips are direction-independent: each pattern's bands drive
// its own column, so paired NB/SB use their own attributes; a solo "Both"
// emits identical times into derived Outbound* / Inbound* columns.
//
// Depends on: App namespace, App.popup, App.cache (session persistence),
//             turf (for feature length when avg speed is the runtime source).
// No public API.

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Module-local state ----

  var _services       = null;   // last App.buildTransitServices() result
  var _selectedKey    = null;   // string | null — currently selected Service.key
  var _tripsByService = {};     // key -> { weekday:[col,...], saturday:[...], sunday:[...] }
                                //         each col = { direction, withAsterisk, color, patternName, trips:[{startMin,endMin}] }
  var _detailsOpen    = false;  // expandable header state (per selected service)
  var _stale          = false;
  var _initialized    = false;

  // ---- DOM guard ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "trip-builder";
  }

  // ---- Tiny escapers ----

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
  }

  // ---- Status pill ----

  function setStatus(msg, kind) {
    if (!isPopupVisible()) return;
    // Translate legacy kinds to the standardized status palette.
    var k = kind === "ok"   ? "done"  :
            kind === "warn" ? "stale" :
            kind || "";
    App.renderModuleState({
      statusEl: "tbStatus",
      status: msg ? { kind: k, message: msg } : null
    });
  }

  // Stale banner with a working Re-run (Generate) button (shared pattern).
  function showStale() {
    if (!isPopupVisible()) return;
    App.renderModuleState({ statusEl: "tbStatus", stale: true, onRerun: runGenerate });
  }

  // Context-aware onboarding/empty hint shown when no Service is selected.
  function emptyHint() {
    var n = (App.routes || []).length + (App.lines || []).length;
    if (!n) {
      return { need: "Draw a route or line to begin.",
               action: "Then select it here — you can set Direction, Time Bands, and Run time without leaving this panel." };
    }
    return { need: "Select a Service from the left to view or set up its trip schedule.",
             action: "Services marked \"Needs setup\" are missing attributes — select one to fill them in." };
  }

  // ---- Service assembly ----
  // Lives in js/core/service-assembly.js — call App.buildTransitServices()
  // (defaults to runtimeMode "either", which matches Trip Builder's lenient
  // semantics: a pattern needs runTime OR avgSpeed, runTime wins).

  // ---- Runtime resolver ----
  // runTime wins if > 0; else fall back to length / avgSpeed. Returns minutes.

  function oneWayRuntimeMin(pattern) {
    if (pattern.runTime > 0) return pattern.runTime;
    if (pattern.avgSpeed > 0 && pattern.lengthMiles > 0) {
      return (pattern.lengthMiles / pattern.avgSpeed) * 60;
    }
    return 0;
  }

  function runtimeSource(pattern) {
    if (pattern.runTime > 0) return "runTime";
    if (pattern.avgSpeed > 0 && pattern.lengthMiles > 0) return "speed";
    return "none";
  }

  // ---- Direction column resolver (Q4 + Q6 ordering) ----
  // Returns one entry per Start/End table column (1 or 2 columns per Service).

  // Order rank for column display per Q6:
  //   NB before SB, EB before WB, Inbound before Outbound, CW before CCW,
  //   Outbound* before Inbound* (derived from "Both"), Loop is solo.
  var DIRECTION_ORDER = {
    "NB": 1, "SB": 2,
    "EB": 1, "WB": 2,
    "Inbound": 2, "Outbound": 1,
    "CW": 1, "CCW": 2,
    "Loop": 1,
    "Outbound*": 1, "Inbound*": 2
  };

  function resolveColumns(svc) {
    var cols = [];
    var ps = svc.patterns;

    if (ps.length === 2) {
      // Paired — one column per pattern, label = each pattern's actual direction.
      ps.forEach(function (p) {
        cols.push({
          direction:    p.direction,
          label:        p.direction,
          withAsterisk: false,
          color:        p.color,
          patternName:  p.name,
          pattern:      p
        });
      });
    } else {
      // Solo — single pattern.
      var p = ps[0];
      if (p.direction === "Both") {
        // Derived: emit Outbound* and Inbound* using the same pattern. Trips
        // are simultaneous (same bands → same start times), per Q2.
        cols.push({
          direction:    "Outbound*", label: "Outbound*", withAsterisk: true,
          color: p.color, patternName: p.name, pattern: p
        });
        cols.push({
          direction:    "Inbound*",  label: "Inbound*",  withAsterisk: true,
          color: p.color, patternName: p.name, pattern: p
        });
      } else {
        // Loop / CW / CCW — single column, no opposite (Q4).
        cols.push({
          direction:    p.direction, label: p.direction, withAsterisk: false,
          color: p.color, patternName: p.name, pattern: p
        });
      }
    }

    // Stable sort per Q6 ordering rank.
    cols.sort(function (a, b) {
      var ra = DIRECTION_ORDER[a.direction] || 99;
      var rb = DIRECTION_ORDER[b.direction] || 99;
      return ra - rb;
    });

    return cols;
  }

  // ---- Trip generation ----

  // Parse "HH:MM" → minutes-from-midnight, or NaN on bad input.
  function parseHHMMtoMin(s) {
    if (typeof s !== "string") return NaN;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return NaN;
    var h  = parseInt(m[1], 10);
    var mn = parseInt(m[2], 10);
    if (h < 0 || h > 24 || mn < 0 || mn >= 60) return NaN;
    return h * 60 + mn;
  }

  // Format minutes-from-midnight (mod 1440) → "H:MM". Q3: clean format, no "+1d".
  function formatMin(mins) {
    var t = ((mins % 1440) + 1440) % 1440;
    var h = Math.floor(t / 60);
    var m = Math.floor(t - h * 60);
    return h + ":" + (m < 10 ? "0" : "") + m;
  }

  // Build the trips array for one pattern × one day type.
  // Returns sorted [{ startMin, endMin }] in absolute minutes (may exceed 1440
  // if a band wraps past midnight; format() takes mod 1440 for display).
  function generateTripsForPattern(pattern, day, runtimeMin) {
    var svc   = pattern.service || {};
    var bands = App.getEffectiveServiceBands(svc, day);
    var trips = [];

    var MAX_TRIPS_PER_BAND = 1500;
    bands.forEach(function (b) {
      var headway = parseFloat(b && b.frequency);
      if (!(headway > 0)) return;             // blank/0 → "no service in band"
      // Clamp to the UI's minimum (1 min) so a malformed import can't freeze the browser.
      if (headway < 1) headway = 1;
      var fromMin = parseHHMMtoMin(b && b.from);
      var toMin   = parseHHMMtoMin(b && b.to);
      if (!isFinite(fromMin) || !isFinite(toMin)) return;
      // Midnight wrap (e.g. 22:00 → 02:00).
      if (toMin <= fromMin) toMin += 1440;
      // Generate from the band start, stepping by headway, while < band end.
      // Q5: trips whose end exceeds the band end are still emitted.
      var emitted = 0;
      for (var t = fromMin; t < toMin; t += headway) {
        trips.push({ startMin: t, endMin: t + runtimeMin });
        if (++emitted >= MAX_TRIPS_PER_BAND) break;
      }
    });

    trips.sort(function (a, b) { return a.startMin - b.startMin; });
    return trips;
  }

  // Build all trip columns for the selected service.
  // Returns { weekday:[col,...], saturday:[...], sunday:[...] } where each
  // col carries direction metadata + its trips array for that day.
  function generateAllTrips(svc) {
    var cols = resolveColumns(svc);
    var DAYS = ["weekday", "saturday", "sunday"];
    var out  = { weekday: [], saturday: [], sunday: [] };

    DAYS.forEach(function (day) {
      cols.forEach(function (c) {
        var rtMin = oneWayRuntimeMin(c.pattern);
        var trips = generateTripsForPattern(c.pattern, day, rtMin);
        out[day].push({
          direction:    c.direction,
          label:        c.label,
          withAsterisk: c.withAsterisk,
          color:        c.color,
          patternName:  c.patternName,
          runtimeMin:   rtMin,
          trips:        trips
        });
      });
    });

    return out;
  }

  // ---- Service list (left column) ----

  function buildServiceList() {
    var el = document.getElementById("tbServiceList");
    if (!el) return;

    var services = App.buildTransitServices();
    _services = services;

    if (!services.length) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">' +
        'No routes or lines drawn. Draw a Route or Line on the map, then select it here to set its schedule attributes.</div>';
      return;
    }

    // If selection no longer exists, drop it.
    if (_selectedKey && !services.some(function (s) { return s.key === _selectedKey; })) {
      _selectedKey = null;
      _detailsOpen = false;
    }

    var html = "";
    services.forEach(function (svc) {
      var blocked    = App.hasBlockingWarnings(svc);
      var isSelected = (svc.key === _selectedKey);
      var typeBadge  = svc.isGroup
        ? '<span class="rc-pill rc-pill-group">Paired</span>'
        : '<span class="rc-pill rc-pill-solo">Solo</span>';
      // The chip and the warning tooltip both key off hasBlockingWarnings(),
      // so a blocked row gets one signal (the chip, carrying the tooltip)
      // instead of a redundant triangle + chip pair. Non-blocking warnings
      // (none exist today, but service-assembly.js's `level` field leaves
      // room for one) still get the plain triangle badge.
      var warnIcon = "";
      var tip = svc.warnings.length
        ? svc.warnings.map(function (w) { return w.msg; }).join(" \n")
        : "";
      if (blocked) {
        warnIcon = ' <span class="tb-svc-setup-chip" title="' + escapeAttr(tip) + '">Needs setup</span>';
      } else if (svc.warnings.length) {
        warnIcon = ' <span class="rc-warn-badge" title="' + escapeAttr(tip) + '">&#9888;</span>';
      }

      // Show a small color stripe based on the first pattern's color so the
      // user can quickly match the left list to their map.
      var stripeColor = (svc.patterns[0] && svc.patterns[0].color) || "#aaa";
      var stripe = '<span class="tb-svc-stripe" style="background:' + escapeAttr(stripeColor) + ';"></span>';

      html +=
        '<div class="tb-svc-row' +
            (blocked ? ' tb-svc-blocked' : '') +
            (isSelected ? ' tb-svc-selected' : '') +
            '" data-key="' + escapeAttr(svc.key) + '">' +
          stripe +
          '<span class="tb-svc-main">' +
            '<span class="tb-svc-name">' + escapeHTML(svc.name) + warnIcon + '</span>' +
            '<span class="tb-svc-meta">' +
              typeBadge + ' ' +
              escapeHTML(App.directionSummary(svc)) + ' &middot; ' +
              svc.patterns.length + ' pattern' + (svc.patterns.length === 1 ? '' : 's') +
            '</span>' +
          '</span>' +
        '</div>';
    });
    el.innerHTML = html;

    // Wire row clicks (event delegation kept simple — re-bound on every rebuild).
    var rows = el.querySelectorAll(".tb-svc-row");
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        row.addEventListener("click", function () {
          var key = row.getAttribute("data-key");
          selectService(key);
        });
      })(rows[i]);
    }
  }

  function selectService(key) {
    _selectedKey = key;
    _detailsOpen = false;
    setStatus(null);
    // Re-render the left list to update the highlighted row, then the right.
    buildServiceList();
    renderRightSide();
  }

  // Rebuild services from current feature state, re-resolve the selection by
  // pattern identity (the key may have changed if serviceId was edited), and
  // re-render both columns. Called after any edit made inside the mini-popup.
  // `anchor` is { featureType, featureIndex } of the pattern that anchors the
  // selection — normally the first pattern of the Service being edited.
  function refreshAfterEdit(anchor) {
    if (App.cache) App.cache.save();

    var oldKey = _selectedKey;
    var services = App.buildTransitServices();
    _services = services;

    if (anchor) {
      var found = null;
      services.forEach(function (s) {
        s.patterns.forEach(function (p) {
          if (p.featureType === anchor.featureType &&
              p.featureIndex === anchor.featureIndex) found = s;
        });
      });
      if (found) _selectedKey = found.key;
    }

    // Drop trips belonging to a key that no longer exists (the Service was
    // re-keyed or split) — its composition changed, so the trips are invalid.
    if (oldKey && oldKey !== _selectedKey &&
        !services.some(function (s) { return s.key === oldKey; })) {
      delete _tripsByService[oldKey];
    }

    if (_selectedKey && _tripsByService[_selectedKey]) {
      _stale = true;
      showStale();
    }
    if (!isPopupVisible()) return;
    buildServiceList();
    renderRightSide();
  }

  // ---- Right column: header + Generate button + tables ----

  function getSelectedService() {
    if (!_selectedKey || !_services) return null;
    for (var i = 0; i < _services.length; i++) {
      if (_services[i].key === _selectedKey) return _services[i];
    }
    return null;
  }

  function renderRightSide() {
    var empty   = document.getElementById("tbEmptyState");
    var hdr     = document.getElementById("tbHeader");
    var setup   = document.getElementById("tbSetup");
    var actions = document.getElementById("tbActions");
    var results = document.getElementById("tbResults");
    var exptRow = document.getElementById("tbExportRow");
    if (!empty || !hdr || !setup || !actions || !results || !exptRow) return;

    var svc = getSelectedService();
    if (!svc) {
      hdr.style.display      = "none";
      setup.style.display    = "none";
      actions.style.display  = "none";
      results.style.display  = "none";
      exptRow.style.display  = "none";
      App.renderModuleState({
        statusEl: "tbStatus", emptyEl: "tbEmptyState", empty: true, hint: emptyHint()
      });
      return;
    }

    empty.style.display    = "none";
    hdr.style.display      = "";
    actions.style.display  = "";

    renderServiceHeader(svc);

    if (App.hasBlockingWarnings(svc)) {
      setup.style.display   = "";
      results.style.display = "none";
      exptRow.style.display = "none";
      results.innerHTML     = "";
      setExportEnabled(false);
      renderSetupPanel(svc);
      var gen = document.getElementById("tbGenerateBtn");
      if (gen) {
        gen.disabled = true;
        gen.title = "Fill in the missing attributes above to generate trips.";
      }
      return;
    }
    setup.style.display = "none";
    var gen2 = document.getElementById("tbGenerateBtn");
    if (gen2) { gen2.disabled = false; gen2.title = ""; }

    var stored = _tripsByService[svc.key];
    if (stored) {
      results.style.display = "";
      exptRow.style.display = "";
      renderResults(svc, stored);
      setExportEnabled(true);
    } else {
      results.style.display = "none";
      exptRow.style.display = "none";
      results.innerHTML = "";
      setExportEnabled(false);
    }
  }

  // Render the blocking warnings as an actionable checklist plus a button that
  // opens the SAME editor the header's Edit button opens.
  function renderSetupPanel(svc) {
    var el = document.getElementById("tbSetup");
    if (!el) return;
    var items = svc.warnings
      .filter(function (w) { return w.level === "error"; })
      .map(function (w) { return '<li>' + escapeHTML(w.msg) + '</li>'; })
      .join("");
    el.innerHTML =
      '<p><b>This Service needs a few attributes before trips can be generated.</b></p>' +
      '<ul class="tb-setup-list">' + items + '</ul>' +
      '<button id="tbSetupBtn" type="button" class="rf-action-primary">' +
        'Set up this Service' +
      '</button>' +
      '<p class="tiny u-muted">Changes here edit the Route/Line attributes directly ' +
      '&mdash; the same fields as the per-feature Attributes popup.</p>';
    var btn = document.getElementById("tbSetupBtn");
    if (btn) btn.addEventListener("click", function () { openEditPopup(svc, btn); });
  }

  // Resolve the underlying feature object for a Service pattern. Used by the
  // Edit popup, which mutates `feature.properties.attributes` directly.
  function getFeatureFromPattern(p) {
    if (!p) return null;
    var arr = (p.featureType === "route") ? App.routes : App.lines;
    return (arr && arr[p.featureIndex]) || null;
  }

  // Merge sorted intervals; "touch or overlap" → join. Returns minutes-pair list.
  function mergeIntervals(intervals) {
    if (!intervals.length) return [];
    intervals.sort(function (a, b) { return a.from - b.from; });
    var out = [intervals[0]];
    for (var i = 1; i < intervals.length; i++) {
      var prev = out[out.length - 1];
      var cur  = intervals[i];
      if (cur.from <= prev.to) {
        prev.to = Math.max(prev.to, cur.to);
      } else {
        out.push(cur);
      }
    }
    return out;
  }

  // Test-only: expose the pure schedule helpers to the golden harness
  // (test/run-golden.mjs). Guarded by __MAT_TEST__ so it has no effect in the
  // browser. See test/README.md.
  if (typeof window !== "undefined" && window.__MAT_TEST__) {
    App._tbTest = {
      parseHHMMtoMin: parseHHMMtoMin,
      formatMin: formatMin,
      mergeIntervals: mergeIntervals
    };
  }

  // Build the per-day rollup used by the summary table.
  // For each day: Span string, Frequency string, Run Time string, Avg Speed string.
  // For paired services, values are combined across patterns (slash-joined when
  // they differ; single value when they match).
  function summarizeService(svc) {
    var DAYS = ["weekday", "saturday", "sunday"];
    var out = {};

    // Run Time + Avg Speed are pattern attributes (not day-specific). Compute once.
    var rtVals = [];
    var spVals = [];
    svc.patterns.forEach(function (p) {
      var rt = oneWayRuntimeMin(p);
      var src = runtimeSource(p);
      if (rt > 0) {
        var rtStr = Math.round(rt) + " min";
        if (src === "speed") rtStr = "~" + rtStr;
        rtVals.push(rtStr);
      } else {
        rtVals.push("—");
      }
      spVals.push(p.avgSpeed > 0 ? (Math.round(p.avgSpeed * 10) / 10) + " mph" : "—");
    });
    var rtAllSame = rtVals.every(function (v) { return v === rtVals[0]; });
    var spAllSame = spVals.every(function (v) { return v === spVals[0]; });
    var runTimeStr  = rtAllSame ? rtVals[0] : rtVals.join(" / ");
    var avgSpeedStr = spAllSame ? spVals[0] : spVals.join(" / ");

    DAYS.forEach(function (day) {
      // Collect intervals + headways across all patterns for this day.
      var intervals = [];
      var freqs = [];
      svc.patterns.forEach(function (p) {
        var bands = App.getEffectiveServiceBands(p.service, day);
        bands.forEach(function (b) {
          var fromMin = parseHHMMtoMin(b && b.from);
          var toMin   = parseHHMMtoMin(b && b.to);
          if (isFinite(fromMin) && isFinite(toMin)) {
            // Midnight wrap: extend `to` by 1440 so merge math works.
            if (toMin <= fromMin) toMin += 1440;
            intervals.push({ from: fromMin, to: toMin });
          }
          var f = parseFloat(b && b.frequency);
          if (isFinite(f) && f > 0 && freqs.indexOf(f) < 0) freqs.push(f);
        });
      });

      var spanStr = "";
      if (intervals.length) {
        var merged = mergeIntervals(intervals);
        spanStr = merged.map(function (iv) {
          return formatMin(iv.from) + " – " + formatMin(iv.to);
        }).join(", ");
      }

      var freqStr = "";
      if (freqs.length) {
        freqs.sort(function (a, b) { return a - b; });
        freqStr = freqs.join("/") + " min";
      }

      out[day] = {
        hasService: intervals.length > 0,
        span:       spanStr   || "—",
        frequency:  freqStr   || "—",
        runTime:    runTimeStr,
        avgSpeed:   avgSpeedStr
      };
    });

    return out;
  }

  function buildSummaryTableHTML(svc) {
    var rollup = summarizeService(svc);
    var rows = [
      { key: "weekday",  label: "Weekday"  },
      { key: "saturday", label: "Saturday" },
      { key: "sunday",   label: "Sunday"   }
    ];
    var html =
      '<table class="tb-summary">' +
        '<thead><tr>' +
          '<th></th>' +
          '<th>Span</th>' +
          '<th>Frequency</th>' +
          '<th>Run Time</th>' +
          '<th>Avg Speed</th>' +
        '</tr></thead>' +
        '<tbody>';
    rows.forEach(function (r) {
      var d = rollup[r.key];
      var rowCls = d.hasService ? "" : " class=\"tb-summary-empty\"";
      html +=
        '<tr' + rowCls + '>' +
          '<td class="tb-summary-day-label">' + r.label + '</td>' +
          '<td>' + escapeHTML(d.span)      + '</td>' +
          '<td>' + escapeHTML(d.frequency) + '</td>' +
          '<td>' + escapeHTML(d.runTime)   + '</td>' +
          '<td>' + escapeHTML(d.avgSpeed)  + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function renderServiceHeader(svc) {
    var hdr = document.getElementById("tbHeader");
    if (!hdr) return;

    var stripeColor = (svc.patterns[0] && svc.patterns[0].color) || "#888";
    var typeBadge = svc.isGroup
      ? '<span class="rc-pill rc-pill-group">Paired</span>'
      : '<span class="rc-pill rc-pill-solo">Solo</span>';

    var caret = _detailsOpen ? "&#9662;" : "&#9656;"; // ▾ / ▸

    var detailsHTML = "";
    svc.patterns.forEach(function (p) {
      var rtMin = oneWayRuntimeMin(p);
      var src   = runtimeSource(p);
      var srcLabel = src === "runTime" ? "manual run time"
                   : src === "speed"   ? "from " + (Math.round(p.avgSpeed * 10) / 10) + " mph"
                   : "—";
      var lenStr   = (p.lengthMiles > 0) ? (Math.round(p.lengthMiles * 100) / 100) + " mi" : "—";
      var headways = listHeadways(p);
      detailsHTML +=
        '<li>' +
          '<span class="tb-pat-color" style="background:' + escapeAttr(p.color) + ';"></span>' +
          '<b>' + escapeHTML(p.name) + '</b> ' +
          '(' + escapeHTML(p.direction) + ') &middot; ' +
          'one-way ' + (rtMin > 0 ? Math.round(rtMin) + ' min' : '—') +
          ' <span class="tiny" style="color:var(--muted);">(' + srcLabel + ')</span> &middot; ' +
          'length ' + lenStr +
          (headways ? ' &middot; headways ' + escapeHTML(headways) : '') +
        '</li>';
    });
    if (!detailsHTML) detailsHTML = '<li class="tiny" style="color:var(--muted);">No patterns.</li>';

    hdr.innerHTML =
      '<div class="tb-header" style="border-left-color:' + escapeAttr(stripeColor) + ';">' +
        '<button id="tbHeaderToggle" type="button" class="tb-header-toggle" title="Toggle details">' + caret + '</button>' +
        '<div class="tb-header-name">' + escapeHTML(svc.name) + '</div>' +
        '<div class="tb-header-meta">' +
          typeBadge + ' ' +
          escapeHTML(App.directionSummary(svc)) + ' &middot; ' +
          svc.patterns.length + ' pattern' + (svc.patterns.length === 1 ? '' : 's') +
        '</div>' +
        '<div class="tb-header-actions">' +
          '<button id="tbEditBtn" type="button" class="tb-edit-btn" title="Edit service attributes">' +
            '&#9998; Edit' +
          '</button>' +
        '</div>' +
        '<div class="tb-header-details' + (_detailsOpen ? ' tb-open' : '') + '">' +
          buildSummaryTableHTML(svc) +
          '<ul>' + detailsHTML + '</ul>' +
        '</div>' +
      '</div>';

    var toggle = document.getElementById("tbHeaderToggle");
    if (toggle) toggle.addEventListener("click", function () {
      _detailsOpen = !_detailsOpen;
      renderServiceHeader(svc);
    });
    var editBtn = document.getElementById("tbEditBtn");
    if (editBtn) editBtn.addEventListener("click", function () {
      openEditPopup(svc, editBtn);
    });
  }

  // ---- Truncated Edit popup ----
  // Mounts inside the shared #fp-mini-popup (App.openMiniPopup). Each pattern
  // gets its own block: Service id, Direction select, Run time, Avg speed,
  // time-bands editor (App.buildServiceScheduleEditor). All inputs mutate
  // feature.properties.attributes directly. On every change, save to cache,
  // rebuild Services, re-resolve the selection, and re-render both columns
  // live (see refreshAfterEdit). On popup close, fire App.notifyProject() so
  // other modules pick up the changes.

  var DIRECTION_OPTIONS = [
    "Both", "NB", "SB", "EB", "WB", "Inbound", "Outbound", "Loop", "CW", "CCW"
  ];

  function buildEditPatternBlock(pattern, isFirst) {
    var feature = getFeatureFromPattern(pattern);
    if (!feature) return null;
    if (!feature.properties.attributes) feature.properties.attributes = {};
    var attrs = feature.properties.attributes;

    var block = document.createElement("div");
    block.className = "tb-edit-block" + (isFirst ? "" : " tb-edit-block-sep");

    // Section header: pattern name + direction badge
    var hdr = document.createElement("div");
    hdr.className = "tb-edit-pattern-hdr";
    hdr.innerHTML =
      '<span class="tb-pat-color" style="background:' + escapeAttr(pattern.color) + ';"></span>' +
      '<b>' + escapeHTML(pattern.name) + '</b>' +
      ' <span class="tiny" style="color:var(--muted);">(' + escapeHTML(pattern.direction) + ')</span>';
    block.appendChild(hdr);

    // Service id — the pairing key. Reuses the shared autocomplete datalist
    // created by the per-feature attributes popup (js/core/feature-attributes.js)
    // or Attribute Summary, whichever mounted first this session.
    var svcRow = document.createElement("div");
    svcRow.className = "fp-attr-row";
    var svcLabel = document.createElement("label");
    svcLabel.className = "fp-attr-label";
    svcLabel.textContent = "Service";
    var svcInp = document.createElement("input");
    svcInp.type = "text";
    svcInp.className = "fp-attr-input";
    svcInp.placeholder = "e.g. Blue Line";
    svcInp.title = "Two Routes/Lines sharing a Service id are paired into one Service.";
    svcInp.value = attrs.serviceId != null ? attrs.serviceId : "";
    var dlId = "fp-service-datalist";
    if (!document.getElementById(dlId)) {
      var dl = document.createElement("datalist");
      dl.id = dlId;
      document.body.appendChild(dl);
    }
    svcInp.setAttribute("list", dlId);
    // CHANGE only (blur / Enter), never "input" — see the note below.
    svcInp.addEventListener("change", function () {
      var v = svcInp.value.trim();
      if (v === "") delete attrs.serviceId; else attrs.serviceId = v;
    });
    svcRow.appendChild(svcLabel);
    svcRow.appendChild(svcInp);
    block.appendChild(svcRow);

    var svcHint = document.createElement("div");
    svcHint.className = "tiny u-muted tb-edit-hint";
    svcHint.textContent = "Give two features the same Service id to pair them " +
                          "(e.g. an NB and an SB pattern). Leave blank for a standalone Service.";
    block.appendChild(svcHint);

    // Direction
    // Critical detail: the Service id field above binds on "change", not
    // "input" like every field below — typing "Blue Line" must not re-key
    // (and re-render) the Service on every keystroke. The container-level
    // onAttrChange listener (set up in openEditPopup) listens for both
    // "input" and "change", so the refresh still fires once the value lands.
    var dirRow = document.createElement("div");
    dirRow.className = "fp-attr-row";
    var dirLabel = document.createElement("label");
    dirLabel.className = "fp-attr-label";
    dirLabel.textContent = "Direction";
    var dirSel = document.createElement("select");
    dirSel.className = "fp-attr-input";
    DIRECTION_OPTIONS.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if ((attrs.direction || "Both") === opt) o.selected = true;
      dirSel.appendChild(o);
    });
    dirSel.addEventListener("change", function () {
      attrs.direction = dirSel.value;
    });
    dirRow.appendChild(dirLabel);
    dirRow.appendChild(dirSel);
    block.appendChild(dirRow);

    // Run time
    var rtRow = document.createElement("div");
    rtRow.className = "fp-attr-row";
    var rtLabel = document.createElement("label");
    rtLabel.className = "fp-attr-label";
    rtLabel.textContent = "Run time";
    var rtInp = document.createElement("input");
    rtInp.type = "number";
    rtInp.className = "fp-attr-input";
    rtInp.placeholder = "min";
    rtInp.min = 0;
    rtInp.step = "any";
    if (attrs.runTime != null && attrs.runTime !== "") rtInp.value = attrs.runTime;
    rtInp.addEventListener("input", function () {
      attrs.runTime = (rtInp.value === "") ? null : parseFloat(rtInp.value);
    });
    var rtUnit = document.createElement("span");
    rtUnit.className = "tiny";
    rtUnit.style.color = "var(--muted)";
    rtUnit.textContent = "min";
    rtRow.appendChild(rtLabel);
    rtRow.appendChild(rtInp);
    rtRow.appendChild(rtUnit);
    block.appendChild(rtRow);

    // Avg speed
    var spRow = document.createElement("div");
    spRow.className = "fp-attr-row";
    var spLabel = document.createElement("label");
    spLabel.className = "fp-attr-label";
    spLabel.textContent = "Avg speed";
    var spInp = document.createElement("input");
    spInp.type = "number";
    spInp.className = "fp-attr-input";
    spInp.placeholder = "mph";
    spInp.min = 0;
    spInp.step = "any";
    if (attrs.avgSpeed != null && attrs.avgSpeed !== "") spInp.value = attrs.avgSpeed;
    spInp.addEventListener("input", function () {
      attrs.avgSpeed = (spInp.value === "") ? null : parseFloat(spInp.value);
    });
    var spUnit = document.createElement("span");
    spUnit.className = "tiny";
    spUnit.style.color = "var(--muted)";
    spUnit.textContent = "mph";
    spRow.appendChild(spLabel);
    spRow.appendChild(spInp);
    spRow.appendChild(spUnit);
    block.appendChild(spRow);

    // Time bands editor (shared widget)
    var bandsLabel = document.createElement("div");
    bandsLabel.className = "tb-edit-bands-label";
    bandsLabel.textContent = "Time Bands";
    block.appendChild(bandsLabel);
    if (typeof App.buildServiceScheduleEditor === "function") {
      var bandsEditor = App.buildServiceScheduleEditor(feature);
      if (bandsEditor) block.appendChild(bandsEditor);
    } else {
      var fallback = document.createElement("div");
      fallback.className = "tiny";
      fallback.style.color = "var(--muted)";
      fallback.textContent = "Time bands editor unavailable.";
      block.appendChild(fallback);
    }

    return block;
  }

  // Known cosmetic limitation (accepted, not fixed): if editing the Service id
  // below re-keys or splits this Service while the popup is open, this
  // popup's title and its set of pattern blocks go stale until reopened. The
  // fields still bind to the correct underlying feature.properties.attributes
  // objects, so nothing is lost or mis-written — rebuilding the popup content
  // mid-edit would destroy whatever the user is currently typing.
  function openEditPopup(svc, anchorBtn) {
    if (!svc || !svc.patterns || !svc.patterns.length) return;
    if (typeof App.openMiniPopup !== "function") return;

    var anchorPattern = svc.patterns[0]
      ? { featureType: svc.patterns[0].featureType, featureIndex: svc.patterns[0].featureIndex }
      : null;

    var content = document.createElement("div");
    content.className = "tb-edit-popup-body";

    svc.patterns.forEach(function (p, idx) {
      var block = buildEditPatternBlock(p, idx === 0);
      if (block) content.appendChild(block);
    });

    // Live re-render of the whole right column (and the left list, since a
    // Service id edit can re-key or split the Service) on every input/change
    // inside the popup.
    function onAttrChange() { refreshAfterEdit(anchorPattern); }
    content.addEventListener("input",  onAttrChange);
    content.addEventListener("change", onAttrChange);

    App.openMiniPopup({
      title:   "Edit — " + svc.name,
      content: content,
      anchor:  anchorBtn,
      onClose: function () {
        // Broadcast to other modules (Feature Panel, Attribute Summary, etc.).
        if (typeof App.notifyProject === "function") App.notifyProject();
      }
    });
  }

  // Build a compact "headways" string for one pattern: "WD 15/30 · Sa 30 · Su 60".
  function listHeadways(p) {
    var svc = p.service || {};
    var labels = { weekday: "WD", saturday: "Sa", sunday: "Su" };
    var parts = [];
    ["weekday", "saturday", "sunday"].forEach(function (day) {
      var bands = App.getEffectiveServiceBands(svc, day);
      var hws = [];
      bands.forEach(function (b) {
        var f = parseFloat(b && b.frequency);
        if (isFinite(f) && f > 0 && hws.indexOf(f) < 0) hws.push(f);
      });
      if (hws.length) {
        hws.sort(function (a, b) { return a - b; });
        parts.push(labels[day] + " " + hws.join("/"));
      }
    });
    return parts.join(" · ");
  }

  function renderResults(svc, byDay) {
    var wrap = document.getElementById("tbResults");
    if (!wrap) return;

    var DAYS = [
      { key: "weekday",  label: "Weekday"  },
      { key: "saturday", label: "Saturday" },
      { key: "sunday",   label: "Sunday"   }
    ];

    var html = "";
    var rendered = 0;
    DAYS.forEach(function (d) {
      var cols = byDay[d.key] || [];
      var hasAnyTrips = cols.some(function (c) { return c.trips.length > 0; });
      if (!hasAnyTrips) return;

      rendered++;
      html += '<div class="tb-day-section">';
      html += '<div class="tb-day-label">' + d.label + '</div>';
      html += '<div class="tb-day-grid" style="grid-template-columns:repeat(' + cols.length + ',minmax(0,1fr));">';

      cols.forEach(function (col, ci) {
        html += '<div class="tb-direction-table-wrap">';
        html += '<div class="tb-direction-header" style="border-left-color:' + escapeAttr(col.color) + ';">' +
                  '<span>' + escapeHTML(col.label) + '</span>' +
                  '<span class="tb-direction-meta">' +
                    col.trips.length + ' trip' + (col.trips.length === 1 ? '' : 's') +
                    (col.runtimeMin > 0 ? ' &middot; ' + Math.round(col.runtimeMin) + ' min one-way' : '') +
                  '</span>' +
                '</div>';
        html += '<table class="tb-trip-table">';
        html +=   '<thead><tr>' +
                    '<th class="tb-trip-num">#</th>' +
                    '<th>Start</th>' +
                    '<th>End</th>' +
                    '<th class="tb-del-cell" aria-label="Delete"></th>' +
                  '</tr></thead>';
        html +=   '<tbody>';
        if (col.trips.length === 0) {
          html += '<tr><td colspan="4" class="tb-no-bands">No service in any band.</td></tr>';
        } else {
          col.trips.forEach(function (t, ti) {
            html += '<tr>' +
              '<td class="tb-trip-num">' + (ti + 1) + '</td>' +
              '<td class="tb-time">' + formatMin(t.startMin) + '</td>' +
              '<td class="tb-time">' + formatMin(t.endMin)   + '</td>' +
              '<td class="tb-del-cell">' +
                '<button class="tb-del-btn" type="button" title="Delete trip" ' +
                  'data-day="' + d.key + '" data-col="' + ci + '" data-trip="' + ti + '">&#128465;</button>' +
              '</td>' +
            '</tr>';
          });
        }
        html +=   '</tbody>';
        html += '</table>';
        html += '</div>'; // .tb-direction-table-wrap
      });

      html += '</div>'; // .tb-day-grid
      html += '</div>'; // .tb-day-section
    });

    if (!rendered) {
      html = '<div class="tiny" style="color:var(--muted);padding:8px 0;">' +
        'No trips were generated. Check that the selected Service has Time Bands with non-zero Frequency.</div>';
    }

    wrap.innerHTML = html;

    // Wire delete buttons.
    var dels = wrap.querySelectorAll(".tb-del-btn");
    for (var i = 0; i < dels.length; i++) {
      dels[i].addEventListener("click", function () {
        var day  = this.getAttribute("data-day");
        var ci   = parseInt(this.getAttribute("data-col"), 10);
        var ti   = parseInt(this.getAttribute("data-trip"), 10);
        deleteTrip(day, ci, ti);
      });
    }
  }

  function deleteTrip(day, colIdx, tripIdx) {
    var svc = getSelectedService();
    if (!svc) return;
    var stored = _tripsByService[svc.key];
    if (!stored || !stored[day] || !stored[day][colIdx]) return;
    stored[day][colIdx].trips.splice(tripIdx, 1);
    renderResults(svc, stored);
    if (App.cache) App.cache.save();
  }

  // ---- Generate button ----

  function runGenerate() {
    var svc = getSelectedService();
    if (!svc) {
      setStatus("Select a Service first.", "warn");
      return;
    }
    if (App.hasBlockingWarnings(svc)) {
      setStatus("This Service has blocking warnings — see attribute warnings.", "warn");
      return;
    }
    var byDay = generateAllTrips(svc);
    _tripsByService[svc.key] = byDay;
    _stale = false;

    var totalTrips = 0;
    ["weekday", "saturday", "sunday"].forEach(function (day) {
      (byDay[day] || []).forEach(function (col) { totalTrips += col.trips.length; });
    });
    setStatus("Generated " + totalTrips + " trip" + (totalTrips === 1 ? "" : "s") + ".", "ok");

    renderRightSide();
    if (App.cache) App.cache.save();
  }

  // ---- Export ----

  function setExportEnabled(on) {
    var btn = document.getElementById("tbExportCSV");
    if (btn) btn.disabled = !on;
  }

  function csvRow(arr) {
    return arr.map(function (v) {
      var s = (v == null) ? "" : String(v);
      if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(",");
  }

  function exportCSV() {
    var svc = getSelectedService();
    if (!svc) return;
    var byDay = _tripsByService[svc.key];
    if (!byDay) return;

    var lines = [];
    lines.push(csvRow(["Service", "Day", "Direction", "Trip #", "Start", "End", "Runtime (min)"]));

    var DAY_LABELS = { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday" };
    ["weekday", "saturday", "sunday"].forEach(function (day) {
      (byDay[day] || []).forEach(function (col) {
        col.trips.forEach(function (t, ti) {
          lines.push(csvRow([
            svc.name,
            DAY_LABELS[day],
            col.label,                            // includes "*" for derived directions
            ti + 1,
            formatMin(t.startMin),
            formatMin(t.endMin),
            Math.round(col.runtimeMin)
          ]));
        });
      });
    });

    var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    var safeName = (svc.name || "service").replace(/[^a-z0-9_-]+/gi, "_");
    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href = url;
    a.download = "trip-builder_" + safeName + "_" + stamp + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  // ---- Lifecycle ----

  function init(/* core */) {
    if (_initialized) return;
    _initialized = true;

    var byId = function (id) { return document.getElementById(id); };

    if (byId("tbGenerateBtn")) byId("tbGenerateBtn").addEventListener("click", runGenerate);
    if (byId("tbExportCSV"))   byId("tbExportCSV").addEventListener("click",   exportCSV);
  }

  function onOpen(/* core */) {
    buildServiceList();
    renderRightSide();
    if (_stale && _selectedKey && _tripsByService[_selectedKey]) {
      showStale();
    } else {
      setStatus(null);
    }
  }

  function onClose(/* core */) {
    // No cleanup; state lives in closure.
  }

  async function update(/* core */) {
    if (!isPopupVisible()) {
      // Drawing/editing happened with the popup closed — just mark stale so
      // we show a warning the next time the user opens it.
      _stale = true;
      return;
    }
    buildServiceList();
    renderRightSide();
    if (_selectedKey && _tripsByService[_selectedKey]) {
      _stale = true;
      showStale();
    }
  }

  function clearAll() {
    _tripsByService = {};
    _selectedKey    = null;
    _detailsOpen    = false;
    _stale          = false;
    if (!isPopupVisible()) return;
    buildServiceList();
    renderRightSide();
    setStatus(null);
  }

  // ---- Session persistence ----

  function saveTbState(/* mode */) {
    return {
      version:        1,
      selectedKey:    _selectedKey,
      tripsByService: _tripsByService     // small enough to persist as-is
    };
  }

  function restoreTbState(data) {
    if (!data) return;
    if (typeof data.selectedKey === "string") _selectedKey = data.selectedKey;
    if (data.tripsByService && typeof data.tripsByService === "object") {
      _tripsByService = data.tripsByService;
    }
  }

  // ---- Register module ----

  App.registerModule({
    id:         "trip-builder",
    name:       "Trip Builder",
    enabled:    true,
    popupWidth: 1140,
    popupHTML:  "projects/trip-builder-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:   function ()     { clearAll(); },
    update:  async function (core) { await update(core); }
  });

  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("trip-builder", {
      collect: saveTbState,
      apply:   restoreTbState
    });
  }
})();
