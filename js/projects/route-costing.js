// js/projects/route-costing.js
// Route Costing: high-level transit service costing module. Reads feature
// attributes (length, avg speed, direction, service bands) and module-wide
// Costing Settings to estimate daily/annual operating cost, trips, rev-hrs,
// plat-hrs, and peak vehicles per Service.
//
// Depends on: App namespace, App.popup, App.cache (session persistence).
// Step 2: skeleton — registration, popup wiring, Settings modal only.
// No public API.

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Defaults (module-wide costing settings) ----

  var DEFAULT_SETTINGS = {
    costPerHour:    150,    // $ per platform hour
    deadheadPct:    15,     // % added to revenue hours to get platform hours
    layoverMode:    "minutes", // "minutes" | "percent"
    layoverValue:   10,     // minutes or percent (per mode)
    daysWeekday:    255,
    daysSaturday:   52,
    daysSunday:     58,
    spareRatio:     15,     // % added to peak vehicles for planning fleet
    costBasisYear:  "",     // free-text label (e.g. "2024 NTD")
    runtimeMode:    "speed" // "speed" | "runTime"
  };

  // ---- Module-local state ----

  var _settings        = Object.assign({}, DEFAULT_SETTINGS);
  var _pendingSettings = null;    // temp copy while Settings modal is open
  var _lastServices    = null;    // last-assembled Service[] from App.buildTransitServices()
  var _lastResult      = null;    // { services:[...], summary:{...}, settings } (Step 5)
  var _stale           = false;
  var _running         = false;
  var _initialized     = false;

  var _interlineGroups   = [];   // [{ id, name, serviceKeys:[], days:{weekday,saturday,sunday} }]
  var _pendingInterlines = null; // temp copy while Interlines modal is open
  var _ilGroupCounter    = 0;    // auto-increment for unique group IDs

  // ---- DOM guard: only touch DOM when this module's popup is open ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "route-costing";
  }

  // ---- Status ----

  function setStatus(msg, kind) {
    if (!isPopupVisible()) return;
    // Translate legacy kinds to the standardized status palette.
    var k = kind === "ok"   ? "done"  :
            kind === "warn" ? "stale" :
            kind || "";
    App.renderModuleState({
      statusEl: "rcStatus",
      status: msg ? { kind: k, message: msg } : null
    });
  }

  // Stale banner with a working Re-run button (shared pattern).
  function showStale() {
    if (!isPopupVisible()) return;
    App.renderModuleState({ statusEl: "rcStatus", stale: true, onRerun: runCosting });
  }

  // Context-aware onboarding/empty hint shown when there are no results.
  function emptyHint() {
    var n = (App.routes || []).length + (App.lines || []).length;
    if (!n) {
      return { need: "Draw a route or line to begin.",
               action: "Then set its Direction, Time Bands, and Run time / Avg speed in Attributes." };
    }
    return { need: "Select one or more Services and click Cost Services.",
             action: "Services are assembled from drawn routes/lines sharing a Service id." };
  }

  // ---- Costing Settings modal ----

  function openSettingsModal() {
    _pendingSettings = Object.assign({}, _settings);
    syncSettingsToInputs(_pendingSettings);
    var modal = document.getElementById("rcSettingsModal");
    if (modal) modal.style.display = "flex";
  }

  function closeSettingsModal(confirm) {
    if (confirm) {
      _settings = Object.assign({}, _pendingSettings);
      buildServiceChecklist();   // re-validate against new runtimeMode
      if (_lastResult) markStale();
      if (App.cache) App.cache.save();
    }
    _pendingSettings = null;
    var modal = document.getElementById("rcSettingsModal");
    if (modal) modal.style.display = "none";
  }

  function resetSettingsToDefaults() {
    _pendingSettings = Object.assign({}, DEFAULT_SETTINGS);
    syncSettingsToInputs(_pendingSettings);
  }

  // ---- Interlines modal ----

  function openInterlinesModal() {
    _pendingInterlines = _interlineGroups.map(function (g) {
      return {
        id:          g.id,
        name:        g.name,
        serviceKeys: g.serviceKeys.slice(),
        days:        Object.assign({}, g.days)
      };
    });
    renderInterlinesModal();
    var modal = document.getElementById("rcInterlinesModal");
    if (modal) modal.style.display = "flex";
  }

  function closeInterlinesModal(confirm) {
    if (confirm) {
      _interlineGroups = _pendingInterlines || [];
      if (_lastResult) markStale();
      if (App.cache) App.cache.save();
    }
    _pendingInterlines = null;
    var modal = document.getElementById("rcInterlinesModal");
    if (modal) modal.style.display = "none";
  }

  function renderInterlinesModal() {
    var el = document.getElementById("rcInterlineGroupsList");
    if (!el) return;

    if (!_lastServices || !_lastServices.length) {
      el.innerHTML = '<div class="tiny" style="color:var(--muted);padding:8px 0;">No Services available. Draw routes or lines and set their attributes first.</div>';
      return;
    }

    if (!_pendingInterlines || !_pendingInterlines.length) {
      el.innerHTML = '<div class="tiny" style="color:var(--muted);padding:8px 0;">No interline groups defined. Click &ldquo;+ Add Group&rdquo; to create one.</div>';
      return;
    }

    var validServices = (_lastServices || []).filter(function (s) { return !App.hasBlockingWarnings(s); });

    var html = "";
    _pendingInterlines.forEach(function (grp, gidx) {
      html += '<div class="rc-interline-group" data-gidx="' + gidx + '">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
      html += '<input class="rf-select rc-il-name" type="text"' +
              ' placeholder="Group name (e.g. Route 10/12 Interline)"' +
              ' value="' + escapeAttr(grp.name) + '" style="flex:1;">';
      html += '<button class="rf-btn-sm rc-il-remove" type="button" data-gidx="' + gidx + '">Remove</button>';
      html += '</div>';
      // Day-type applicability
      html += '<div class="tiny" style="margin-bottom:4px;color:var(--muted);">Applies on:</div>';
      html += '<div style="display:flex;gap:12px;margin-bottom:8px;">';
      ["weekday", "saturday", "sunday"].forEach(function (day) {
        var label = day.charAt(0).toUpperCase() + day.slice(1);
        html += '<label class="tiny" style="display:flex;gap:4px;align-items:center;">' +
          '<input type="checkbox" class="rc-il-day" data-gidx="' + gidx + '" data-day="' + day + '"' +
          (grp.days[day] ? ' checked' : '') + '> ' + label + '</label>';
      });
      html += '</div>';
      // Member service checkboxes
      html += '<div class="tiny" style="margin-bottom:4px;color:var(--muted);">Member Services (select 2+):</div>';
      html += '<div style="display:flex;flex-direction:column;gap:3px;max-height:120px;overflow-y:auto;">';
      validServices.forEach(function (svc) {
        var checked = grp.serviceKeys.indexOf(svc.key) >= 0;
        html += '<label class="tiny" style="display:flex;gap:4px;align-items:center;">' +
          '<input type="checkbox" class="rc-il-member" data-gidx="' + gidx +
          '" data-key="' + escapeAttr(svc.key) + '"' + (checked ? ' checked' : '') + '> ' +
          escapeHTML(svc.name) + '</label>';
      });
      html += '</div>';
      html += '</div>'; // .rc-interline-group
    });

    el.innerHTML = html;

    // Wire remove buttons
    var removeBtns = el.querySelectorAll(".rc-il-remove");
    for (var i = 0; i < removeBtns.length; i++) {
      removeBtns[i].addEventListener("click", function () {
        var idx = parseInt(this.getAttribute("data-gidx"), 10);
        _pendingInterlines.splice(idx, 1);
        renderInterlinesModal();
      });
    }

    // Wire name inputs (use closure to capture index at bind time)
    var nameInputs = el.querySelectorAll(".rc-il-name");
    for (var j = 0; j < nameInputs.length; j++) {
      (function (input) {
        input.addEventListener("input", function () {
          var idx = parseInt(
            input.closest(".rc-interline-group").getAttribute("data-gidx"), 10);
          _pendingInterlines[idx].name = input.value;
        });
      })(nameInputs[j]);
    }

    // Wire day checkboxes
    var dayCbs = el.querySelectorAll(".rc-il-day");
    for (var k = 0; k < dayCbs.length; k++) {
      dayCbs[k].addEventListener("change", function () {
        var idx = parseInt(this.getAttribute("data-gidx"), 10);
        var day = this.getAttribute("data-day");
        _pendingInterlines[idx].days[day] = this.checked;
      });
    }

    // Wire member checkboxes
    var memberCbs = el.querySelectorAll(".rc-il-member");
    for (var m = 0; m < memberCbs.length; m++) {
      memberCbs[m].addEventListener("change", function () {
        var idx = parseInt(this.getAttribute("data-gidx"), 10);
        var key = this.getAttribute("data-key");
        var grp = _pendingInterlines[idx];
        if (this.checked) {
          if (grp.serviceKeys.indexOf(key) < 0) grp.serviceKeys.push(key);
        } else {
          grp.serviceKeys = grp.serviceKeys.filter(function (k) { return k !== key; });
        }
      });
    }
  }

  function syncSettingsToInputs(s) {
    var byId = function (id) { return document.getElementById(id); };
    if (byId("rcCostPerHour"))   byId("rcCostPerHour").value   = s.costPerHour;
    if (byId("rcDeadheadPct"))   byId("rcDeadheadPct").value   = s.deadheadPct;
    if (byId("rcLayoverValue"))  byId("rcLayoverValue").value  = s.layoverValue;
    if (byId("rcDaysWeekday"))   byId("rcDaysWeekday").value   = s.daysWeekday;
    if (byId("rcDaysSaturday"))  byId("rcDaysSaturday").value  = s.daysSaturday;
    if (byId("rcDaysSunday"))    byId("rcDaysSunday").value    = s.daysSunday;
    if (byId("rcSpareRatio"))    byId("rcSpareRatio").value    = s.spareRatio;
    if (byId("rcCostBasisYear")) byId("rcCostBasisYear").value = s.costBasisYear || "";
    var radios = document.querySelectorAll('input[name="rcLayoverMode"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = (radios[i].value === s.layoverMode);
    }
    var rtRadios = document.querySelectorAll('input[name="rcRuntimeMode"]');
    for (var j = 0; j < rtRadios.length; j++) {
      rtRadios[j].checked = (rtRadios[j].value === (s.runtimeMode || "speed"));
    }
    updateLayoverUnitLabel();
    updateDaysSum();
  }

  function readSettingsFromInputs() {
    var byId = function (id) { return document.getElementById(id); };
    var num = function (el, def) {
      var v = el ? parseFloat(el.value) : NaN;
      return isFinite(v) ? v : def;
    };
    var mode = "minutes";
    var radios = document.querySelectorAll('input[name="rcLayoverMode"]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) { mode = radios[i].value; break; }
    }
    _pendingSettings = {
      costPerHour:   num(byId("rcCostPerHour"),   DEFAULT_SETTINGS.costPerHour),
      deadheadPct:   num(byId("rcDeadheadPct"),   DEFAULT_SETTINGS.deadheadPct),
      layoverMode:   mode,
      layoverValue:  num(byId("rcLayoverValue"),  DEFAULT_SETTINGS.layoverValue),
      daysWeekday:   num(byId("rcDaysWeekday"),   DEFAULT_SETTINGS.daysWeekday),
      daysSaturday:  num(byId("rcDaysSaturday"),  DEFAULT_SETTINGS.daysSaturday),
      daysSunday:    num(byId("rcDaysSunday"),    DEFAULT_SETTINGS.daysSunday),
      spareRatio:    num(byId("rcSpareRatio"),    DEFAULT_SETTINGS.spareRatio),
      costBasisYear: (byId("rcCostBasisYear") && byId("rcCostBasisYear").value) || "",
      runtimeMode:   (function () {
        var els = document.querySelectorAll('input[name="rcRuntimeMode"]');
        for (var i = 0; i < els.length; i++) { if (els[i].checked) return els[i].value; }
        return "speed";
      })()
    };
  }

  function updateLayoverUnitLabel() {
    var label = document.getElementById("rcLayoverValueLabel");
    if (!label) return;
    var mode = "minutes";
    var radios = document.querySelectorAll('input[name="rcLayoverMode"]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) { mode = radios[i].value; break; }
    }
    label.textContent = (mode === "percent") ? "Layover (% of round-trip)" : "Layover (min)";
  }

  function updateDaysSum() {
    var byId = function (id) { return document.getElementById(id); };
    var sum = (parseFloat(byId("rcDaysWeekday")  && byId("rcDaysWeekday").value)  || 0)
            + (parseFloat(byId("rcDaysSaturday") && byId("rcDaysSaturday").value) || 0)
            + (parseFloat(byId("rcDaysSunday")   && byId("rcDaysSunday").value)   || 0);
    var out = byId("rcDaysSum");
    var wrap = byId("rcDaysSumWarn");
    if (out) out.textContent = Math.round(sum);
    if (wrap) wrap.style.color = (sum > 366) ? "#c0392b" : "";
  }

  // ---- Service assembly ----
  // Lives in js/core/service-assembly.js — call App.buildTransitServices({ runtimeMode })
  // for service assembly, and App.directionSummary / App.hasBlockingWarnings
  // for the helpers.

  // ---- Checklist rendering ----

  function buildServiceChecklist() {
    var el = document.getElementById("rcServiceList");
    if (!el) return;

    // Capture existing check state so a rebuild from update() preserves user choices
    var prev = {};
    var prevBoxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < prevBoxes.length; i++) {
      prev[prevBoxes[i].getAttribute("data-key")] = prevBoxes[i].checked;
    }

    var services = App.buildTransitServices({ runtimeMode: _settings.runtimeMode });
    _lastServices = services;

    if (!services.length) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">' +
        'No routes or lines drawn. Draw features and set their attributes (direction, speed, service bands) to cost.</div>';
      return;
    }

    var html = "";
    services.forEach(function (svc) {
      var blocked = App.hasBlockingWarnings(svc);
      var checkedAttr = (prev[svc.key] === false) ? "" : "checked";
      var warnIcon = "";
      if (svc.warnings.length) {
        var tip = svc.warnings.map(function (w) { return w.msg; }).join(" \n");
        warnIcon = ' <span class="rc-warn-badge" title="' + escapeAttr(tip) + '">&#9888;</span>';
      }
      var typeBadge = svc.isGroup
        ? '<span class="rc-pill rc-pill-group">Paired</span>'
        : '<span class="rc-pill rc-pill-solo">Solo</span>';

      html +=
        '<label class="rc-service-row' + (blocked ? ' rc-service-blocked' : '') + '">' +
          '<input type="checkbox" data-key="' + escapeAttr(svc.key) + '" ' + checkedAttr + '>' +
          '<span class="rc-service-main">' +
            '<span class="rc-service-name">' + escapeHTML(svc.name) + warnIcon + '</span>' +
            '<span class="rc-service-meta">' +
              typeBadge + ' ' +
              escapeHTML(App.directionSummary(svc)) + ' &middot; ' +
              svc.patterns.length + ' pattern' + (svc.patterns.length === 1 ? '' : 's') +
            '</span>' +
          '</span>' +
        '</label>';
    });
    el.innerHTML = html;
  }

  function getSelectedServices() {
    if (!_lastServices) return [];
    var el = document.getElementById("rcServiceList");
    if (!el) return [];
    var checks = {};
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      checks[boxes[i].getAttribute("data-key")] = boxes[i].checked;
    }
    return _lastServices.filter(function (s) { return checks[s.key]; });
  }

  // ---- Cost math (pure functions) ----

  function parseBandTime(s) {
    if (typeof s !== "string") return NaN;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return NaN;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    if (h < 0 || h > 24 || min < 0 || min >= 60) return NaN;
    return h + min / 60;
  }

  function emptyDay() {
    return { trips: 0, revHrs: 0, miles: 0, platHrs: 0, cost: 0 };
  }

  // One-way runtime per pattern, in hours — speed-based.
  function oneWayRuntimeHrs(pattern) {
    if (!(pattern.avgSpeed > 0)) return 0;
    return pattern.lengthMiles / pattern.avgSpeed;
  }

  // One-way runtime per pattern, in hours — respects runtimeMode setting.
  function oneWayRuntimeHrsFromSettings(pattern, settings) {
    if (settings.runtimeMode === "runTime")
      return (pattern.runTime > 0) ? pattern.runTime / 60 : 0;
    return (pattern.avgSpeed > 0) ? pattern.lengthMiles / pattern.avgSpeed : 0;
  }

  // Compute round-trip runtime and round-trip miles for a Service.
  // - 2-pattern: sum both one-ways / sum both lengths.
  // - 1-pattern "Both": double one-way / double length.
  // - 1-pattern Loop/CW/CCW: one-way is already the full cycle; length is unchanged.
  function computeRoundTrip(svc, settings) {
    var ps = svc.patterns;
    var oneWays = ps.map(function (p) { return oneWayRuntimeHrsFromSettings(p, settings); });
    var lenSum  = ps.reduce(function (s, p) { return s + p.lengthMiles; }, 0);
    var oneWaySum = oneWays.reduce(function (s, v) { return s + v; }, 0);

    if (ps.length === 2) {
      return { rtHrs: oneWaySum, rtMiles: lenSum, oneWays: oneWays };
    }
    // Single pattern
    var d = ps[0].direction;
    if (d === "Both") {
      return { rtHrs: 2 * oneWays[0], rtMiles: 2 * ps[0].lengthMiles, oneWays: oneWays };
    }
    // Loop / CW / CCW — one-way IS the full cycle
    return { rtHrs: oneWays[0], rtMiles: ps[0].lengthMiles, oneWays: oneWays };
  }

  function computeLayoverHrs(rtHrs, settings) {
    if (settings.layoverMode === "percent") {
      return rtHrs * (settings.layoverValue / 100);
    }
    return settings.layoverValue / 60;  // minutes → hours
  }

  // Test-only: expose the pure cost-math helpers to the golden harness
  // (test/run-golden.mjs). Guarded by __MAT_TEST__ so it has no effect in the
  // browser. See test/README.md.
  if (typeof window !== "undefined" && window.__MAT_TEST__) {
    App._rcTest = {
      parseBandTime: parseBandTime,
      oneWayRuntimeHrs: oneWayRuntimeHrs,
      oneWayRuntimeHrsFromSettings: oneWayRuntimeHrsFromSettings,
      computeRoundTrip: computeRoundTrip,
      computeLayoverHrs: computeLayoverHrs
    };
  }

  // Compute one Service's full cost picture. Returns a result object.
  // If the Service has blocking warnings, returns { skipped:true, warnings, name }.
  function computeService(svc, settings) {
    if (App.hasBlockingWarnings(svc)) {
      return {
        name: svc.name,
        key: svc.key,
        isGroup: svc.isGroup,
        skipped: true,
        warnings: svc.warnings,
        directionSummary: App.directionSummary(svc),
        patternCount: svc.patterns.length
      };
    }

    var rt = computeRoundTrip(svc, settings);
    var layHrs = computeLayoverHrs(rt.rtHrs, settings);
    var cycleHrs = rt.rtHrs + layHrs;

    // tripsPerCycle: how many one-way trips constitute one cycle (for layover allocation)
    // - Paired (2 patterns): 2 (one of each direction per cycle)
    // - Solo "Both": 2 (out and back per cycle)
    // - Solo Loop/CW/CCW: 1 (the one-way IS the full cycle)
    var tripsPerCycle = (svc.patterns.length === 2) ? 2
                      : (svc.patterns[0].direction === "Both") ? 2
                      : 1;

    var DAYS = ["weekday", "saturday", "sunday"];
    var perDay = {
      weekday:  { minHeadway: Infinity, trips: 0, revHrs: 0, miles: 0 },
      saturday: { minHeadway: Infinity, trips: 0, revHrs: 0, miles: 0 },
      sunday:   { minHeadway: Infinity, trips: 0, revHrs: 0, miles: 0 }
    };
    var bandRows = [];

    DAYS.forEach(function (day) {
      svc.patterns.forEach(function (p, pi) {
        var bands = App.getEffectiveServiceBands(p.service, day);
        bands.forEach(function (b) {
          var headway = parseFloat(b && b.frequency);
          if (!(headway > 0)) return;  // skip blank/0 headways (= "no service in this band")

          var from = parseBandTime(b && b.from);
          var to   = parseBandTime(b && b.to);
          if (!isFinite(from) || !isFinite(to)) return;

          var hrs = to - from;
          if (hrs <= 0) hrs += 24;  // handle midnight wrap (e.g. 22:00 → 02:00)
          if (!(hrs > 0)) return;

          var trips     = Math.ceil(hrs * 60 / headway);
          var oneWayHr  = rt.oneWays[pi];
          var bandRevHr = trips * oneWayHr;
          var bandMiles = trips * p.lengthMiles;

          perDay[day].trips   += trips;
          perDay[day].revHrs  += bandRevHr;
          perDay[day].miles   += bandMiles;

          if (headway < perDay[day].minHeadway) perDay[day].minHeadway = headway;

          bandRows.push({
            day:         day,
            patternName: p.name,
            patternIdx:  pi,
            from:        b.from,
            to:          b.to,
            hours:       hrs,
            headwayMin:  headway,
            trips:       trips,
            revHrs:      bandRevHr
          });
        });
      });
    });

    var dh = settings.deadheadPct / 100;
    var daysMap = {
      weekday:  settings.daysWeekday  || 0,
      saturday: settings.daysSaturday || 0,
      sunday:   settings.daysSunday   || 0
    };

    // Per-day-type cost breakdown — explicit layover + deadhead.
    // platHrs = revHrs + layoverHrs + deadheadHrs (where deadhead% applies to revHrs only).
    DAYS.forEach(function (day) {
      var d = perDay[day];
      d.cycles      = (tripsPerCycle > 0) ? (d.trips / tripsPerCycle) : 0;
      d.layoverHrs  = d.cycles * layHrs;
      d.deadheadHrs = d.revHrs * dh;
      d.platHrs     = d.revHrs + d.layoverHrs + d.deadheadHrs;
      d.cost        = d.platHrs * settings.costPerHour;
      d.annualCost  = d.cost    * daysMap[day];
      // Per-day fleet
      if (isFinite(d.minHeadway) && d.minHeadway > 0) {
        d.peakVehiclesRaw     = (cycleHrs * 60) / d.minHeadway;
        d.peakVehiclesRounded = Math.ceil(d.peakVehiclesRaw);
      } else {
        d.minHeadway = null;
        d.peakVehiclesRaw = 0;
        d.peakVehiclesRounded = 0;
      }
      d.hasService = d.trips > 0;
    });

    // Annual aggregates (sum across day types with their day counts).
    var annual = { revHrs: 0, platHrs: 0, layoverHrs: 0, deadheadHrs: 0,
                   cost: 0, trips: 0, miles: 0 };
    DAYS.forEach(function (day) {
      var d  = perDay[day];
      var dd = daysMap[day];
      annual.revHrs      += d.revHrs      * dd;
      annual.platHrs     += d.platHrs     * dd;
      annual.layoverHrs  += d.layoverHrs  * dd;
      annual.deadheadHrs += d.deadheadHrs * dd;
      annual.cost        += d.cost        * dd;
      annual.trips       += d.trips       * dd;
      annual.miles       += d.miles       * dd;
    });

    // System-level peak vehicles = max across day types (the busiest day drives fleet size).
    var peakPulloutMax = Math.max(
      perDay.weekday.peakVehiclesRounded,
      perDay.saturday.peakVehiclesRounded,
      perDay.sunday.peakVehiclesRounded
    );
    var peakRawMax = Math.max(
      perDay.weekday.peakVehiclesRaw,
      perDay.saturday.peakVehiclesRaw,
      perDay.sunday.peakVehiclesRaw
    );

    // Backwards-compat aliases used by older code paths during transition.
    var daily = {
      weekday:  perDay.weekday,
      saturday: perDay.saturday,
      sunday:   perDay.sunday
    };
    var minHeadwayAcrossAll = Math.min(
      perDay.weekday.minHeadway  || Infinity,
      perDay.saturday.minHeadway || Infinity,
      perDay.sunday.minHeadway   || Infinity
    );

    return {
      name:             svc.name,
      key:              svc.key,
      isGroup:          svc.isGroup,
      skipped:          false,
      warnings:         svc.warnings,
      patternCount:     svc.patterns.length,
      directionSummary: App.directionSummary(svc),

      rtMiles:          rt.rtMiles,
      oneWayHrs:        rt.oneWays,
      runTimeMin:       rt.rtHrs * 60,
      cycleMin:         cycleHrs * 60,
      layoverMin:       layHrs * 60,
      tripsPerCycle:    tripsPerCycle,
      peakHeadwayMin:   isFinite(minHeadwayAcrossAll) ? minHeadwayAcrossAll : null,

      perDay: perDay,
      daily:  daily,    // alias of perDay (legacy key)
      annual: annual,

      peakVehiclesRaw:      peakRawMax,
      peakVehiclesRounded:  peakPulloutMax,

      bandBreakdown: bandRows
    };
  }

  function computeSystemSummary(serviceResults, settings, intGroups) {
    var DAYS = ["weekday", "saturday", "sunday"];
    var emptyDayAgg = function () {
      return {
        services: 0, dailyTrips: 0, dailyRevHrs: 0, dailyPlatHrs: 0,
        dailyLayoverHrs: 0, dailyDeadheadHrs: 0, dailyCost: 0, dailyMiles: 0,
        annualTrips: 0, annualRevHrs: 0, annualPlatHrs: 0, annualMiles: 0, annualCost: 0,
        fleetSumRounded: 0, fleetSumRaw: 0
      };
    };
    var out = {
      servicesScored:  0,
      servicesSkipped: 0,
      perDay: { weekday: emptyDayAgg(), saturday: emptyDayAgg(), sunday: emptyDayAgg() },
      total: {
        annualTrips: 0, annualRevHrs: 0, annualPlatHrs: 0, annualMiles: 0, annualCost: 0
      },
      daysMap: {
        weekday:  settings.daysWeekday  || 0,
        saturday: settings.daysSaturday || 0,
        sunday:   settings.daysSunday   || 0
      },
      spareRatioPct: settings.spareRatio,
      costBasisYear: settings.costBasisYear || ""
    };

    serviceResults.forEach(function (r) {
      if (r.skipped) { out.servicesSkipped++; return; }
      out.servicesScored++;

      // Per-day-type aggregation
      DAYS.forEach(function (day) {
        var d = r.perDay[day];
        var agg = out.perDay[day];
        if (d.hasService) agg.services++;
        agg.dailyTrips        += d.trips;
        agg.dailyRevHrs       += d.revHrs;
        agg.dailyPlatHrs      += d.platHrs;
        agg.dailyLayoverHrs   += d.layoverHrs;
        agg.dailyDeadheadHrs  += d.deadheadHrs;
        agg.dailyCost         += d.cost;
        agg.dailyMiles        += d.miles;
        agg.fleetSumRounded   += d.peakVehiclesRounded;
        agg.fleetSumRaw       += d.peakVehiclesRaw;  // accumulate raw for ceil later
      });

      // Annual totals
      out.total.annualTrips    += r.annual.trips;
      out.total.annualRevHrs   += r.annual.revHrs;
      out.total.annualPlatHrs  += r.annual.platHrs;
      out.total.annualMiles    += r.annual.miles;
      out.total.annualCost     += r.annual.cost;
    });

    // Per-day annual aggregates (= daily × days/year of that type) and fleetSumRaw ceiling
    DAYS.forEach(function (day) {
      var agg = out.perDay[day];
      var dd  = out.daysMap[day];
      agg.annualTrips    = agg.dailyTrips    * dd;
      agg.annualRevHrs   = agg.dailyRevHrs   * dd;
      agg.annualPlatHrs  = agg.dailyPlatHrs  * dd;
      agg.annualMiles    = agg.dailyMiles    * dd;
      agg.annualCost     = agg.dailyCost     * dd;
      agg.fleetSumRaw    = Math.ceil(agg.fleetSumRaw);
      agg.interlineGap   = agg.fleetSumRounded - agg.fleetSumRaw;
    });

    // System-wide fleet metrics — the fleet you must own = max across day types.
    // System-wide fleet metrics
    out.peakFleetRounded   = Math.max(out.perDay.weekday.fleetSumRounded,
                                       out.perDay.saturday.fleetSumRounded,
                                       out.perDay.sunday.fleetSumRounded);
    out.peakFleetInterlined = Math.max(out.perDay.weekday.fleetSumRaw,
                                        out.perDay.saturday.fleetSumRaw,
                                        out.perDay.sunday.fleetSumRaw);
    out.peakInterlineGap   = out.peakFleetRounded - out.peakFleetInterlined;

    // Interline effect: subtract declared pool savings from fleet totals
    var ilEffect = computeInterlinesEffect(serviceResults, intGroups || []);
    out.interlineEffect = ilEffect;
    DAYS.forEach(function (day) {
      var agg = out.perDay[day];
      var savings = ilEffect ? (ilEffect.savingsPerDay[day] || 0) : 0;
      agg.interlinedFleet   = Math.max(0, agg.fleetSumRounded - savings);
      agg.interlinedSavings = savings;
    });

    // Fleet after declared interlines
    out.hasInterlines = !!(ilEffect && ilEffect.groupResults.length);
    out.peakFleetAfterInterlines = Math.max(
      out.perDay.weekday.interlinedFleet,
      out.perDay.saturday.interlinedFleet,
      out.perDay.sunday.interlinedFleet
    );
    out.fleetWithSpares = Math.ceil(
      (out.hasInterlines ? out.peakFleetAfterInterlines : out.peakFleetRounded)
      * (1 + settings.spareRatio / 100)
    );

    return out;
  }

  function computeInterlinesEffect(serviceResults, intGroups) {
    if (!intGroups || !intGroups.length) return null;

    var DAYS = ["weekday", "saturday", "sunday"];
    var resultMap = {};
    serviceResults.forEach(function (r) { if (!r.skipped) resultMap[r.key] = r; });

    var groupResults = [];
    var savingsPerDay = { weekday: 0, saturday: 0, sunday: 0 };

    intGroups.forEach(function (grp) {
      var members = grp.serviceKeys
        .map(function (k) { return resultMap[k]; })
        .filter(Boolean);
      if (members.length < 2) return;

      var gResult = {
        id:      grp.id,
        name:    grp.name,
        members: members.map(function (m) { return m.name; }),
        days:    {}
      };

      DAYS.forEach(function (day) {
        if (!grp.days[day]) return;
        var memberPeaks = members.map(function (m) {
          return m.perDay[day].peakVehiclesRounded || 0;
        });
        var standaloneSum = memberPeaks.reduce(function (a, b) { return a + b; }, 0);
        var poolMax       = Math.max.apply(null, memberPeaks);
        var savings       = standaloneSum - poolMax;
        gResult.days[day] = { standaloneSum: standaloneSum, poolMax: poolMax, savings: savings };
        savingsPerDay[day] += savings;
      });

      groupResults.push(gResult);
    });

    return { groupResults: groupResults, savingsPerDay: savingsPerDay };
  }

  // ---- Rendering ----

  function fmtInt(v) {
    if (!isFinite(v)) return "—";
    return Math.round(v).toLocaleString();
  }
  function fmtDec(v, digits) {
    if (!isFinite(v)) return "—";
    return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtMoney(v) {
    if (!isFinite(v)) return "—";
    return "$" + Math.round(v).toLocaleString();
  }
  function fmtHeadway(v) {
    if (v == null || !isFinite(v)) return "—";
    return Math.round(v) + " min";
  }
  var DAY_LABELS = { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday" };

  function renderResultsTable(serviceResults) {
    var wrap = document.getElementById("rcResultsTable");
    if (!wrap) return;

    if (!serviceResults.length) {
      wrap.innerHTML = '<div class="tiny" style="color:var(--muted);">No services selected.</div>';
      return;
    }

    var html = "";

    // Skipped services first (outside the per-day tables)
    var skipped = serviceResults.filter(function (r) { return r.skipped; });
    if (skipped.length) {
      html += '<div class="rc-section-label" style="margin-top:0;">Skipped</div>';
      html += '<table class="rc-table"><tbody>';
      skipped.forEach(function (r) {
        var tip = (r.warnings || []).map(function (w) { return w.msg; }).join(" \n");
        html +=
          '<tr class="rc-row rc-row-skipped">' +
            '<td>' +
              '<span class="rc-warn-badge" title="' + escapeAttr(tip) + '">&#9888;</span> ' +
              escapeHTML(r.name) +
              ' <span class="rc-service-meta">(skipped)</span>' +
            '</td>' +
            '<td class="rc-skip-note">' + escapeHTML((r.warnings[0] && r.warnings[0].msg) || "Skipped") + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
    }

    var scored = serviceResults.filter(function (r) { return !r.skipped; });
    if (!scored.length) {
      wrap.innerHTML = html || '<div class="tiny" style="color:var(--muted);">No services selected.</div>';
      return;
    }

    // Per-day tables (Weekday | Saturday | Sunday)
    var dayLabels = { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday" };
    ["weekday", "saturday", "sunday"].forEach(function (day) {
      var dayRows = scored.filter(function (r) { return r.perDay[day].hasService; });
      html += '<div class="rc-section-label" style="margin-top:18px;">' + dayLabels[day] + '</div>';
      if (!dayRows.length) {
        html += '<div class="tiny" style="color:var(--muted);">No service on ' + dayLabels[day] + '.</div>';
        return;
      }
      html += renderPerDayTable(dayRows, day);
    });

    // Total table
    html += '<div class="rc-section-label" style="margin-top:18px;">Total (annualized)</div>';
    html += renderTotalTable(scored);

    wrap.innerHTML = html;

    // Wire expand toggling on Total table only (band breakdown lives there)
    var mainRows = wrap.querySelectorAll('tr.rc-row-main[data-totalrow]');
    for (var i = 0; i < mainRows.length; i++) {
      mainRows[i].addEventListener("click", function () {
        var idx = this.getAttribute("data-idx");
        var details = wrap.querySelector('tr.rc-row-details[data-idx="' + idx + '"]');
        if (!details) return;
        var isOpen = details.style.display !== "none";
        details.style.display = isOpen ? "none" : "";
        var caret = this.querySelector(".rc-caret");
        if (caret) caret.innerHTML = isOpen ? "&#9656;" : "&#9662;";
      });
    }
  }

  function renderPerDayTable(rows, day) {
    var head = '<tr>' +
      '<th>Service</th>' +
      '<th class="rc-num">RT mi</th>' +
      '<th class="rc-num">Frequency</th>' +
      '<th class="rc-num">Run time (min)</th>' +
      '<th class="rc-num">Cycle time (min)</th>' +
      '<th class="rc-num">Trips</th>' +
      '<th class="rc-num">Daily rev-hr</th>' +
      '<th class="rc-num">Daily plat-hr</th>' +
      '<th class="rc-num">Annual cost</th>' +
      '<th class="rc-num">Peak pullout</th>' +
      '</tr>';
    var body = "";
    rows.forEach(function (r) {
      var d = r.perDay[day];
      body +=
        '<tr class="rc-row">' +
          '<td>' +
            '<span class="rc-service-name">' + escapeHTML(r.name) + '</span>' +
            '<div class="rc-service-meta">' + escapeHTML(r.directionSummary) +
            ' &middot; ' + r.patternCount + ' pattern' + (r.patternCount === 1 ? '' : 's') + '</div>' +
          '</td>' +
          '<td class="rc-num">' + fmtDec(r.rtMiles, 2) + '</td>' +
          '<td class="rc-num">' + fmtHeadway(d.minHeadway) + '</td>' +
          '<td class="rc-num">' + fmtInt(r.runTimeMin) + '</td>' +
          '<td class="rc-num">' + fmtInt(r.cycleMin) + '</td>' +
          '<td class="rc-num">' + fmtInt(d.trips) + '</td>' +
          '<td class="rc-num">' + fmtDec(d.revHrs, 1) + '</td>' +
          '<td class="rc-num">' + fmtDec(d.platHrs, 1) + '</td>' +
          '<td class="rc-num rc-cost">' + fmtMoney(d.annualCost) + '</td>' +
          '<td class="rc-num">' + fmtInt(d.peakVehiclesRounded) + '</td>' +
        '</tr>';
    });
    return '<table class="rc-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function renderTotalTable(rows) {
    var head = '<tr>' +
      '<th style="width:18px;"></th>' +
      '<th>Service</th>' +
      '<th class="rc-num">RT mi</th>' +
      '<th class="rc-num">Annual trips</th>' +
      '<th class="rc-num">Annual rev-hr</th>' +
      '<th class="rc-num">Annual plat-hr</th>' +
      '<th class="rc-num">Annual cost</th>' +
      '<th class="rc-num" title="Max across day types">Peak pullout</th>' +
      '</tr>';
    var body = "";
    rows.forEach(function (r, idx) {
      body +=
        '<tr class="rc-row rc-row-main" data-idx="' + idx + '" data-totalrow="1">' +
          '<td class="rc-caret">&#9656;</td>' +
          '<td>' +
            '<span class="rc-service-name">' + escapeHTML(r.name) + '</span>' +
            '<div class="rc-service-meta">' + escapeHTML(r.directionSummary) +
            ' &middot; ' + r.patternCount + ' pattern' + (r.patternCount === 1 ? '' : 's') + '</div>' +
          '</td>' +
          '<td class="rc-num">' + fmtDec(r.rtMiles, 2) + '</td>' +
          '<td class="rc-num">' + fmtInt(r.annual.trips) + '</td>' +
          '<td class="rc-num">' + fmtInt(r.annual.revHrs) + '</td>' +
          '<td class="rc-num">' + fmtInt(r.annual.platHrs) + '</td>' +
          '<td class="rc-num rc-cost">' + fmtMoney(r.annual.cost) + '</td>' +
          '<td class="rc-num">' + fmtInt(r.peakVehiclesRounded) + '</td>' +
        '</tr>' +
        '<tr class="rc-row-details" data-idx="' + idx + '" style="display:none;">' +
          '<td></td>' +
          '<td colspan="7">' + buildBandBreakdownHTML(r) + '</td>' +
        '</tr>';
    });
    return '<table class="rc-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function buildBandBreakdownHTML(r) {
    if (!r.bandBreakdown || !r.bandBreakdown.length) {
      return '<div class="tiny" style="color:var(--muted);">No service bands.</div>';
    }
    // Group rows by day for readability
    var byDay = { weekday: [], saturday: [], sunday: [] };
    r.bandBreakdown.forEach(function (row) { byDay[row.day].push(row); });

    var html = '<table class="rc-band-table"><thead><tr>' +
      '<th>Day</th><th>Pattern</th><th>Band</th><th class="rc-num">Headway</th>' +
      '<th class="rc-num">Hours</th><th class="rc-num">Trips</th>' +
      '<th class="rc-num">Rev-hr</th><th class="rc-num">Peak veh</th>' +
      '</tr></thead><tbody>';

    ["weekday", "saturday", "sunday"].forEach(function (day) {
      byDay[day].forEach(function (b, i) {
        var peakVeh = Math.ceil((r.cycleMin) / b.headwayMin);
        html +=
          '<tr>' +
            '<td>' + (i === 0 ? DAY_LABELS[day] : '') + '</td>' +
            '<td>' + escapeHTML(b.patternName) + '</td>' +
            '<td>' + escapeHTML(b.from) + '&ndash;' + escapeHTML(b.to) + '</td>' +
            '<td class="rc-num">' + fmtHeadway(b.headwayMin) + '</td>' +
            '<td class="rc-num">' + fmtDec(b.hours, 1) + '</td>' +
            '<td class="rc-num">' + fmtInt(b.trips) + '</td>' +
            '<td class="rc-num">' + fmtDec(b.revHrs, 1) + '</td>' +
            '<td class="rc-num">' + fmtInt(peakVeh) + '</td>' +
          '</tr>';
      });
    });

    html += '</tbody></table>';

    // Show per-day totals line (uses new perDay shape with explicit layover/deadhead)
    var wk = r.perDay.weekday, sa = r.perDay.saturday, su = r.perDay.sunday;
    html += '<div class="rc-day-totals tiny">' +
      'Daily totals — ' +
      'Wk: ' + fmtInt(wk.trips) + ' trips, ' + fmtDec(wk.revHrs, 1) + ' rev-hr, ' + fmtMoney(wk.cost) + ' &middot; ' +
      'Sa: ' + fmtInt(sa.trips) + ' trips, ' + fmtDec(sa.revHrs, 1) + ' rev-hr, ' + fmtMoney(sa.cost) + ' &middot; ' +
      'Su: ' + fmtInt(su.trips) + ' trips, ' + fmtDec(su.revHrs, 1) + ' rev-hr, ' + fmtMoney(su.cost) +
      '</div>';
    return html;
  }

  function renderSummaryTable(summary) {
    var wrap = document.getElementById("rcSummaryTable");
    if (!wrap) return;
    if (!summary) { wrap.innerHTML = ""; return; }

    var wk = summary.perDay.weekday, sa = summary.perDay.saturday, su = summary.perDay.sunday;
    var t  = summary.total;
    var DASH = '<span class="tiny" style="color:var(--muted);">—</span>';

    // Each row: [label, wk-cell, sa-cell, su-cell, total-cell]
    var rows = [
      ["Days/year",            fmtInt(summary.daysMap.weekday),  fmtInt(summary.daysMap.saturday),  fmtInt(summary.daysMap.sunday),  fmtInt(summary.daysMap.weekday + summary.daysMap.saturday + summary.daysMap.sunday)],
      ["Services in operation",fmtInt(wk.services),              fmtInt(sa.services),               fmtInt(su.services),             fmtInt(summary.servicesScored)],
      ["Daily trips",          fmtInt(wk.dailyTrips),            fmtInt(sa.dailyTrips),             fmtInt(su.dailyTrips),           DASH],
      ["Daily rev-hr",         fmtDec(wk.dailyRevHrs, 1),        fmtDec(sa.dailyRevHrs, 1),         fmtDec(su.dailyRevHrs, 1),       DASH],
      ["Daily plat-hr",        fmtDec(wk.dailyPlatHrs, 1),       fmtDec(sa.dailyPlatHrs, 1),        fmtDec(su.dailyPlatHrs, 1),      DASH],
      ["Daily cost",           fmtMoney(wk.dailyCost),           fmtMoney(sa.dailyCost),            fmtMoney(su.dailyCost),          DASH],
      ["Annual trips",         fmtInt(wk.annualTrips),           fmtInt(sa.annualTrips),            fmtInt(su.annualTrips),          fmtInt(t.annualTrips)],
      ["Annual rev-hr",        fmtInt(wk.annualRevHrs),          fmtInt(sa.annualRevHrs),           fmtInt(su.annualRevHrs),         fmtInt(t.annualRevHrs)],
      ["Annual plat-hr",       fmtInt(wk.annualPlatHrs),         fmtInt(sa.annualPlatHrs),          fmtInt(su.annualPlatHrs),        fmtInt(t.annualPlatHrs)],
      ["Annual rev miles",     fmtInt(wk.annualMiles),           fmtInt(sa.annualMiles),            fmtInt(su.annualMiles),          fmtInt(t.annualMiles)],
      ["Annual operating cost",fmtMoney(wk.annualCost),          fmtMoney(sa.annualCost),           fmtMoney(su.annualCost),         fmtMoney(t.annualCost)],
      ["Peak pullout (ΣServices)", fmtInt(wk.fleetSumRounded),   fmtInt(sa.fleetSumRounded),        fmtInt(su.fleetSumRounded),      fmtInt(summary.peakFleetRounded)]
    ];

    // Fleet rows: interline-aware if groups are defined, theoretical otherwise
    if (summary.hasInterlines) {
      var ilEffect = summary.interlineEffect;
      ilEffect.groupResults.forEach(function (grp) {
        var wkS  = grp.days.weekday  ? fmtInt(grp.days.weekday.savings)  : DASH;
        var saS  = grp.days.saturday ? fmtInt(grp.days.saturday.savings) : DASH;
        var suS  = grp.days.sunday   ? fmtInt(grp.days.sunday.savings)   : DASH;
        var totS = Math.max(
          grp.days.weekday  ? (grp.days.weekday.savings  || 0) : 0,
          grp.days.saturday ? (grp.days.saturday.savings || 0) : 0,
          grp.days.sunday   ? (grp.days.sunday.savings   || 0) : 0
        );
        rows.push(["  Pool: " + grp.name, wkS, saS, suS, fmtInt(totS)]);
      });
      rows.push(["Fleet — after interlines",
        fmtInt(wk.interlinedFleet), fmtInt(sa.interlinedFleet), fmtInt(su.interlinedFleet),
        fmtInt(summary.peakFleetAfterInterlines)]);
    } else {
      rows.push(["Fleet — interlined min",
        fmtInt(wk.fleetSumRaw),  fmtInt(sa.fleetSumRaw),  fmtInt(su.fleetSumRaw),
        fmtInt(summary.peakFleetInterlined)]);
      rows.push(["Interline opportunity",
        fmtInt(wk.interlineGap), fmtInt(sa.interlineGap), fmtInt(su.interlineGap),
        fmtInt(summary.peakInterlineGap)]);
    }
    rows.push(["Fleet — planning total (with " + summary.spareRatioPct + "% spares)",
      DASH, DASH, DASH, fmtInt(summary.fleetWithSpares)]);

    var html = '<table class="rc-summary-table"><thead><tr>' +
      '<th></th>' +
      '<th class="rc-num">Weekday</th>' +
      '<th class="rc-num">Saturday</th>' +
      '<th class="rc-num">Sunday</th>' +
      '<th class="rc-num">Total</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>' +
        '<th>' + escapeHTML(r[0]) + '</th>' +
        '<td class="rc-num">' + r[1] + '</td>' +
        '<td class="rc-num">' + r[2] + '</td>' +
        '<td class="rc-num">' + r[3] + '</td>' +
        '<td class="rc-num"><b>' + r[4] + '</b></td>' +
        '</tr>';
    });
    html += '</tbody></table>';

    if (summary.servicesSkipped) {
      html += '<div class="tiny" style="margin-top:6px;color:var(--muted);">' +
        summary.servicesSkipped + ' service' + (summary.servicesSkipped === 1 ? '' : 's') + ' skipped (see warnings).</div>';
    }
    if (summary.costBasisYear) {
      html += '<div class="tiny" style="margin-top:4px;color:var(--muted);">Cost basis: ' + escapeHTML(summary.costBasisYear) + '</div>';
    }

    wrap.innerHTML = html;
  }

  function showResultsSection(show) {
    var results = document.getElementById("rcResults");
    if (results) results.style.display = show ? "" : "none";
    if (show) {
      var empty = document.getElementById("rcEmptyState");
      if (empty) empty.style.display = "none";
    } else {
      App.renderModuleState({
        statusEl: "rcStatus", emptyEl: "rcEmptyState", empty: true, hint: emptyHint()
      });
    }
  }

  function setExportEnabled(enabled) {
    var btn = document.getElementById("rcExportCSV");
    if (btn) btn.disabled = !enabled;
  }

  // ---- CSV export ----

  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvRow(arr) { return arr.map(csvCell).join(","); }

  function round1(v) { return isFinite(v) ? Math.round(v * 10) / 10 : ""; }
  function round2(v) { return isFinite(v) ? Math.round(v * 100) / 100 : ""; }
  function roundI(v) { return isFinite(v) ? Math.round(v) : ""; }

  function exportCSV() {
    if (!_lastResult) return;
    var settings = _lastResult.settings;
    var services = _lastResult.services;
    var summary  = _lastResult.summary;

    var now = new Date();
    var stamp = now.getFullYear() + "-" +
                String(now.getMonth() + 1).padStart(2, "0") + "-" +
                String(now.getDate()).padStart(2, "0") + "_" +
                String(now.getHours()).padStart(2, "0") +
                String(now.getMinutes()).padStart(2, "0");

    var lines = [];
    lines.push("# Route Costing Export");
    lines.push("# Generated: " + now.toISOString());
    if (settings.costBasisYear) lines.push("# Cost basis: " + settings.costBasisYear);
    lines.push("# Cost per platform hour ($): " + settings.costPerHour);
    lines.push("# Deadhead %: " + settings.deadheadPct);
    lines.push("# Layover: " + settings.layoverValue +
               (settings.layoverMode === "percent" ? "% of round-trip" : " min"));
    lines.push("# Days/year Wk/Sa/Su: " +
               settings.daysWeekday + "/" + settings.daysSaturday + "/" + settings.daysSunday);
    lines.push("# Spare ratio %: " + settings.spareRatio);
    lines.push("");

    // Per-Service rows — one row per (service, day type) plus a Total row per service.
    // Daily columns blank on Total row; per-day rows show that day's annual contribution.
    lines.push(csvRow([
      "Service","Type","Patterns","Day type",
      "RT mi","Frequency (min)","Run time (min)","Layover (min)","Cycle time (min)",
      "Trips","Daily rev-hr","Daily plat-hr","Daily layover hr","Daily deadhead hr",
      "Daily rev mi","Daily plat mi","Daily deadhead mi","Daily cost ($)",
      "Annual rev-hr","Annual plat-hr","Annual rev mi","Annual plat mi","Annual cost ($)",
      "Peak veh (raw)","Peak pullout (rounded)",
      "Skipped","Warnings"
    ]));

    var DAY_NAME = { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday" };
    var dayOrder = ["weekday", "saturday", "sunday"];
    var dh = settings.deadheadPct / 100;

    services.forEach(function (r) {
      if (r.skipped) {
        var warnStr = (r.warnings || []).map(function (w) { return w.msg; }).join(" | ");
        lines.push(csvRow([
          r.name, r.isGroup ? "Paired" : "Solo", r.patternCount, "—",
          "","","","","",
          "","","","","",
          "","","","",
          "","","","","",
          "","",
          "YES", warnStr
        ]));
        return;
      }

      dayOrder.forEach(function (day) {
        var d  = r.perDay[day];
        var ddays = (day === "weekday")  ? (settings.daysWeekday  || 0)
                  : (day === "saturday") ? (settings.daysSaturday || 0)
                  :                        (settings.daysSunday   || 0);
        var dailyDeadheadMi = d.miles * dh;
        var dailyPlatMi     = d.miles + dailyDeadheadMi;
        var annRevHr  = d.revHrs   * ddays;
        var annPlatHr = d.platHrs  * ddays;
        var annRevMi  = d.miles    * ddays;
        var annPlatMi = dailyPlatMi * ddays;

        lines.push(csvRow([
          r.name, r.isGroup ? "Paired" : "Solo", r.patternCount, DAY_NAME[day],
          round2(r.rtMiles), roundI(d.minHeadway), roundI(r.runTimeMin),
          roundI(r.layoverMin), roundI(r.cycleMin),
          roundI(d.trips), round1(d.revHrs), round1(d.platHrs),
          round1(d.layoverHrs), round1(d.deadheadHrs),
          round1(d.miles), round1(dailyPlatMi), round1(dailyDeadheadMi),
          roundI(d.cost),
          roundI(annRevHr), roundI(annPlatHr), roundI(annRevMi), roundI(annPlatMi),
          roundI(d.annualCost),
          round1(d.peakVehiclesRaw), roundI(d.peakVehiclesRounded),
          "", ""
        ]));
      });

      // Total row — annuals only; daily/per-day cells blank
      var totalDeadheadMi = r.annual.miles * dh;
      var totalPlatMi     = r.annual.miles + totalDeadheadMi;
      lines.push(csvRow([
        r.name, r.isGroup ? "Paired" : "Solo", r.patternCount, "Total",
        round2(r.rtMiles), "", roundI(r.runTimeMin), roundI(r.layoverMin), roundI(r.cycleMin),
        "", "", "", "", "",
        "", "", "", "",
        roundI(r.annual.revHrs), roundI(r.annual.platHrs),
        roundI(r.annual.miles), roundI(totalPlatMi),
        roundI(r.annual.cost),
        round1(r.peakVehiclesRaw), roundI(r.peakVehiclesRounded),
        "", ""
      ]));
    });

    lines.push("");
    lines.push("# System Summary");
    lines.push(csvRow(["Metric","Weekday","Saturday","Sunday","Total"]));
    var wk = summary.perDay.weekday, sa = summary.perDay.saturday,
        su = summary.perDay.sunday, tot = summary.total;
    lines.push(csvRow(["Days/year", summary.daysMap.weekday, summary.daysMap.saturday, summary.daysMap.sunday,
      summary.daysMap.weekday + summary.daysMap.saturday + summary.daysMap.sunday]));
    lines.push(csvRow(["Services in operation", wk.services, sa.services, su.services, summary.servicesScored]));
    lines.push(csvRow(["Daily trips", roundI(wk.dailyTrips), roundI(sa.dailyTrips), roundI(su.dailyTrips), ""]));
    lines.push(csvRow(["Daily rev-hr", round1(wk.dailyRevHrs), round1(sa.dailyRevHrs), round1(su.dailyRevHrs), ""]));
    lines.push(csvRow(["Daily plat-hr", round1(wk.dailyPlatHrs), round1(sa.dailyPlatHrs), round1(su.dailyPlatHrs), ""]));
    lines.push(csvRow(["Daily cost ($)", roundI(wk.dailyCost), roundI(sa.dailyCost), roundI(su.dailyCost), ""]));
    lines.push(csvRow(["Annual trips", roundI(wk.annualTrips), roundI(sa.annualTrips), roundI(su.annualTrips), roundI(tot.annualTrips)]));
    lines.push(csvRow(["Annual rev-hr", roundI(wk.annualRevHrs), roundI(sa.annualRevHrs), roundI(su.annualRevHrs), roundI(tot.annualRevHrs)]));
    lines.push(csvRow(["Annual plat-hr", roundI(wk.annualPlatHrs), roundI(sa.annualPlatHrs), roundI(su.annualPlatHrs), roundI(tot.annualPlatHrs)]));
    lines.push(csvRow(["Annual rev miles", roundI(wk.annualMiles), roundI(sa.annualMiles), roundI(su.annualMiles), roundI(tot.annualMiles)]));
    lines.push(csvRow(["Annual operating cost ($)", roundI(wk.annualCost), roundI(sa.annualCost), roundI(su.annualCost), roundI(tot.annualCost)]));
    lines.push(csvRow(["Peak pullout (ΣServices)", wk.fleetSumRounded, sa.fleetSumRounded, su.fleetSumRounded, summary.peakFleetRounded]));
    lines.push(csvRow(["Fleet — interlined min", wk.fleetSumRaw, sa.fleetSumRaw, su.fleetSumRaw, summary.peakFleetInterlined]));
    lines.push(csvRow(["Interline opportunity (gap)", wk.interlineGap, sa.interlineGap, su.interlineGap, summary.peakInterlineGap]));
    lines.push(csvRow(["Fleet — planning total (with " + summary.spareRatioPct + "% spares)", "", "", "", summary.fleetWithSpares]));
    lines.push(csvRow(["Services skipped", "", "", "", summary.servicesSkipped]));
    if (settings.costBasisYear) lines.push(csvRow(["Cost basis", "", "", "", settings.costBasisYear]));

    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href = url;
    a.download = "route-costing_" + stamp + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  // ---- Small escapers (no external dep) ----

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
  }

  function runCosting() {
    if (_running) return;
    _running = true;
    var selected = getSelectedServices();
    if (!selected.length) {
      setStatus("Select at least one Service.", "warn");
      _running = false;
      return;
    }
    var results = selected.map(function (svc) { return computeService(svc, _settings); });
    var summary = computeSystemSummary(results, _settings, _interlineGroups);
    _lastResult = { services: results, summary: summary, settings: Object.assign({}, _settings) };
    _stale = false;

    var scored  = summary.servicesScored;
    var skipped = summary.servicesSkipped;
    var msg = "Costed " + scored + " service" + (scored === 1 ? "" : "s");
    if (skipped > 0) msg += " (" + skipped + " skipped — see warnings)";
    setStatus(msg, scored > 0 ? "ok" : "warn");

    renderResultsTable(results);
    renderSummaryTable(summary);
    showResultsSection(true);
    setExportEnabled(scored > 0);

    if (App.cache) App.cache.save();
    _running = false;
  }

  function markStale() {
    _stale = true;
    showStale();
  }

  // ---- Lifecycle ----

  function init(/* core */) {
    if (_initialized) return;
    _initialized = true;

    var byId = function (id) { return document.getElementById(id); };

    // Settings modal open
    if (byId("rcSettingsBtn")) {
      byId("rcSettingsBtn").addEventListener("click", openSettingsModal);
    }

    // Interlines modal
    if (byId("rcInterlinesBtn")) {
      byId("rcInterlinesBtn").addEventListener("click", openInterlinesModal);
    }
    if (byId("rcInterlinesConfirm")) {
      byId("rcInterlinesConfirm").addEventListener("click", function () {
        closeInterlinesModal(true);
      });
    }
    if (byId("rcInterlinesCancel")) {
      byId("rcInterlinesCancel").addEventListener("click", function () {
        closeInterlinesModal(false);
      });
    }
    if (byId("rcInterlinesClear")) {
      byId("rcInterlinesClear").addEventListener("click", function () {
        _pendingInterlines = [];
        renderInterlinesModal();
      });
    }
    if (byId("rcAddInterlineGroup")) {
      byId("rcAddInterlineGroup").addEventListener("click", function () {
        if (!_pendingInterlines) _pendingInterlines = [];
        _pendingInterlines.push({
          id:          "ilg-" + (++_ilGroupCounter),
          name:        "",
          serviceKeys: [],
          days:        { weekday: true, saturday: false, sunday: false }
        });
        renderInterlinesModal();
      });
    }
    // Settings modal actions
    if (byId("rcSettingsConfirm")) {
      byId("rcSettingsConfirm").addEventListener("click", function () {
        readSettingsFromInputs();
        closeSettingsModal(true);
      });
    }
    if (byId("rcSettingsCancel")) {
      byId("rcSettingsCancel").addEventListener("click", function () {
        closeSettingsModal(false);
      });
    }
    if (byId("rcResetSettings")) {
      byId("rcResetSettings").addEventListener("click", resetSettingsToDefaults);
    }
    // Layover mode radios — flip unit label live
    var radios = document.querySelectorAll('input[name="rcLayoverMode"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener("change", updateLayoverUnitLabel);
    }
    // Days sum live updater
    ["rcDaysWeekday","rcDaysSaturday","rcDaysSunday"].forEach(function (id) {
      if (byId(id)) byId(id).addEventListener("input", updateDaysSum);
    });

    // Cost Services button
    if (byId("rcCostBtn")) {
      byId("rcCostBtn").addEventListener("click", runCosting);
    }

    // CSV export
    if (byId("rcExportCSV")) {
      byId("rcExportCSV").addEventListener("click", exportCSV);
    }

    // Select all / Clear checklist helpers (checkboxes populated in Step 3)
    if (byId("rcSelectAll")) {
      byId("rcSelectAll").addEventListener("click", function (e) {
        e.preventDefault();
        var boxes = document.querySelectorAll("#rcServiceList input[type=checkbox]");
        for (var j = 0; j < boxes.length; j++) boxes[j].checked = true;
        if (App.cache) App.cache.save();
      });
    }
    if (byId("rcSelectNone")) {
      byId("rcSelectNone").addEventListener("click", function (e) {
        e.preventDefault();
        var boxes = document.querySelectorAll("#rcServiceList input[type=checkbox]");
        for (var j = 0; j < boxes.length; j++) boxes[j].checked = false;
        if (App.cache) App.cache.save();
      });
    }

    // Persist selection changes (event-delegation survives checklist rebuilds)
    if (byId("rcServiceList")) {
      byId("rcServiceList").addEventListener("change", function (e) {
        if (e.target && e.target.type === "checkbox" && App.cache) App.cache.save();
      });
    }
  }

  function onOpen(/* core */) {
    buildServiceChecklist();
    // Refresh settings inputs (in case they haven't been touched yet)
    syncSettingsToInputs(_settings);
    setStatus(null);

    if (_lastResult) {
      renderResultsTable(_lastResult.services);
      renderSummaryTable(_lastResult.summary);
      showResultsSection(true);
      setExportEnabled(_lastResult.summary.servicesScored > 0);
      if (_stale) showStale();
    } else {
      showResultsSection(false);
      setExportEnabled(false);
    }
  }

  function onClose(/* core */) {
    // No cleanup; state lives in closure.
  }

  async function update(/* core */) {
    if (!isPopupVisible()) return;
    buildServiceChecklist();
  }

  function clearAll() {
    _lastResult = null;
    _interlineGroups = [];
    _stale = false;
    if (!isPopupVisible()) return;
    showResultsSection(false);
    setExportEnabled(false);
    var rt = document.getElementById("rcResultsTable");
    var st = document.getElementById("rcSummaryTable");
    if (rt) rt.innerHTML = "";
    if (st) st.innerHTML = "";
    setStatus(null);
  }

  // ---- Session persistence ----

  function getSelectedServiceKeys() {
    var el = document.getElementById("rcServiceList");
    if (!el) return null;
    var boxes = el.querySelectorAll("input[type=checkbox]");
    if (!boxes.length) return null;
    var keys = [];
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) keys.push(boxes[i].getAttribute("data-key"));
    }
    return keys;
  }

  var _restoredSelectedKeys = null;  // set by apply(); consumed by buildServiceChecklist

  function saveRcState(/* mode */) {
    var data = {
      version:        3,   // v3: solo Service keys are ID-based ("solo-route-id12"); v2: per-day-type structure
      settings:       Object.assign({}, _settings),
      selectedKeys:   getSelectedServiceKeys(),
      interlineGroups: _interlineGroups.map(function (g) {
        return { id: g.id, name: g.name, serviceKeys: g.serviceKeys.slice(), days: Object.assign({}, g.days) };
      }),
      lastSummary:    null
    };
    if (_lastResult) {
      // Strip bandBreakdown (large + reconstructible) in light mode; keep per-service totals.
      data.lastSummary = {
        settings: Object.assign({}, _lastResult.settings),
        summary:  Object.assign({}, _lastResult.summary),
        services: _lastResult.services.map(function (r) {
          if (r.skipped) {
            return {
              name: r.name, key: r.key, isGroup: r.isGroup,
              skipped: true, warnings: r.warnings,
              patternCount: r.patternCount, directionSummary: r.directionSummary
            };
          }
          return {
            name: r.name, key: r.key, isGroup: r.isGroup,
            skipped: false, patternCount: r.patternCount,
            directionSummary: r.directionSummary,
            rtMiles: r.rtMiles, runTimeMin: r.runTimeMin,
            cycleMin: r.cycleMin, layoverMin: r.layoverMin,
            tripsPerCycle: r.tripsPerCycle,
            peakHeadwayMin: r.peakHeadwayMin,
            perDay: r.perDay,
            daily: r.perDay,   // legacy alias; always equal to perDay
            annual: r.annual,
            peakVehiclesRaw: r.peakVehiclesRaw,
            peakVehiclesRounded: r.peakVehiclesRounded,
            bandBreakdown: []  // dropped from persistence; re-run to recompute
          };
        })
      };
    }
    return data;
  }

  // Upgrade legacy index-based solo keys ("solo-route-3") to ID-based ones
  // ("solo-route-id12"), dropping any that no longer resolve. Valid only inside
  // apply(): cache.applyState has already pushed the features in their saved
  // order, so a legacy index still points at the feature that was selected.
  function migrateKeyList(keys) {
    var out = [];
    keys.forEach(function (k) {
      var mk = App.migrateServiceKey(k);
      if (mk) out.push(mk);
    });
    return out;
  }

  function restoreRcState(data) {
    if (!data) return;
    if (data.settings) {
      _settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    }
    if (Array.isArray(data.selectedKeys)) {
      // Migrate legacy "group-…" keys (pre-Service rename) to "service-…"
      // so checkbox selections survive the upgrade.
      _restoredSelectedKeys = migrateKeyList(data.selectedKeys.map(function (k) {
        return (typeof k === "string" && k.indexOf("group-") === 0)
          ? "service-" + k.slice(6)
          : k;
      }));
    }
    if (Array.isArray(data.interlineGroups)) {
      _interlineGroups = data.interlineGroups.map(function (g) {
        return {
          id:          g.id || ("ilg-" + (++_ilGroupCounter)),
          name:        g.name || "",
          serviceKeys: Array.isArray(g.serviceKeys) ? migrateKeyList(g.serviceKeys) : [],
          days:        Object.assign({ weekday: true, saturday: false, sunday: false }, g.days || {})
        };
      });
    }
    // Restore lastSummary only if it's v2-shaped (has perDay on each service).
    // v1 summaries are silently dropped — user will re-run to repopulate.
    if (data.lastSummary && Array.isArray(data.lastSummary.services) &&
        data.version >= 2) {
      _lastResult = {
        settings: Object.assign({}, data.lastSummary.settings || _settings),
        summary:  data.lastSummary.summary || {},
        services: data.lastSummary.services
      };
      // Same legacy-key upgrade for the per-Service rows (kept verbatim when a
      // legacy index no longer resolves — the row is display-only).
      _lastResult.services.forEach(function (r) {
        var mk = App.migrateServiceKey(r.key);
        if (mk) r.key = mk;
      });
    }
  }

  // Hook restored selection into buildServiceChecklist.
  var _origBuildServiceChecklist = buildServiceChecklist;
  buildServiceChecklist = function () {
    _origBuildServiceChecklist();
    if (_restoredSelectedKeys) {
      var el = document.getElementById("rcServiceList");
      if (el) {
        var boxes = el.querySelectorAll("input[type=checkbox]");
        var lookup = {};
        _restoredSelectedKeys.forEach(function (k) { lookup[k] = true; });
        for (var i = 0; i < boxes.length; i++) {
          boxes[i].checked = !!lookup[boxes[i].getAttribute("data-key")];
        }
      }
      _restoredSelectedKeys = null;  // consume once
    }
  };

  // ---- Register module ----

  App.registerModule({
    id:         "route-costing",
    name:       "Route Costing",
    enabled:    true,
    popupWidth: 1240,
    popupHTML:  "projects/route-costing-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:   function ()     { clearAll(); },
    update:  async function (core) { await update(core); }
  });

  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("route-costing", {
      collect: saveRcState,
      apply:   restoreRcState
    });
  }

})();
