// js/core/service-assembly.js
// Shared transit-service assembly for Route Costing, Trip Builder, and any
// future module that needs to bucket drawn routes/lines by attributes.serviceId.
// No DOM access. Depends on App.routes, App.lines, and turf (CDN).
//
// Exports:
//   App.buildTransitServices(options) → Service[]
//   App.getEffectiveServiceBands(service, day) → bands[]
//   App.directionSummary(svc) / App.hasBlockingWarnings(svc) — convenience.
//
// A Service is { key, name, isGroup, patterns: [...], warnings: [...] }.
// A pattern is the per-feature record emitted by collectPattern().

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // Valid direction opposites for 2-pattern Services (sorted, "|"-joined key).
  var VALID_PAIR_KEYS = {
    "NB|SB":            true,
    "EB|WB":            true,
    "Inbound|Outbound": true,
    "CCW|CW":           true
  };

  // Single-pattern directions that represent a complete cycle.
  var SOLO_OK_DIRECTIONS = { "Both": true, "Loop": true, "CW": true, "CCW": true };

  function collectPattern(feature, type, idx) {
    var attrs = (feature.properties && feature.properties.attributes) || {};
    var name  = (feature.properties && feature.properties.name) ||
                (type.charAt(0).toUpperCase() + type.slice(1) + " " + (idx + 1));
    var lengthMi = 0;
    try { lengthMi = (typeof turf !== "undefined") ? turf.length(feature, { units: "miles" }) : 0; }
    catch (e) { lengthMi = 0; }
    var serviceId = attrs.serviceId ? String(attrs.serviceId).trim() : "";
    return {
      featureType:  type,
      featureIndex: idx,
      name:         name,
      color:        App.resolveFeatureColor(type, feature),
      direction:    attrs.direction || "Both",
      avgSpeed:     parseFloat(attrs.avgSpeed) || 0,
      runTime:      parseFloat(attrs.runTime)  || 0,   // one-way run time in minutes (manual)
      serviceId:    serviceId || null,
      lengthMiles:  lengthMi,
      service:      attrs.service || null
    };
  }

  function validateService(svc, runtimeMode) {
    var ps = svc.patterns;

    // Hard error: 3+ patterns assigned to one Service
    if (ps.length >= 3) {
      svc.warnings.push({
        level: "error",
        msg: ps.length + " patterns assigned to this Service — v1 supports max 2. Split into separate Services."
      });
      return;
    }

    // 2-pattern: must be valid opposites
    if (ps.length === 2) {
      var key = [ps[0].direction, ps[1].direction].sort().join("|");
      if (!VALID_PAIR_KEYS[key]) {
        svc.warnings.push({
          level: "error",
          msg: "Directions not valid opposites (" + ps[0].direction + " + " + ps[1].direction +
               "). Valid pairs: NB+SB, EB+WB, Inbound+Outbound, CW+CCW."
        });
      }
    }

    // 1-pattern: direction must represent a full cycle
    if (ps.length === 1 && !SOLO_OK_DIRECTIONS[ps[0].direction]) {
      svc.warnings.push({
        level: "error",
        msg: "Single-direction pattern (" + ps[0].direction + ") has no pair. " +
             "Set direction to Both, Loop, CW, or CCW, or pair with its opposite under one Service."
      });
    }

    // Missing runtime input — message + check depend on caller's mode.
    if (runtimeMode === "runTime") {
      ps.forEach(function (p) {
        if (!(p.runTime > 0)) {
          svc.warnings.push({ level: "error",
            msg: "\"" + p.name + "\" is missing Run time (Route Costing is in Run Time mode)." });
        }
      });
    } else if (runtimeMode === "speed") {
      ps.forEach(function (p) {
        if (!(p.avgSpeed > 0)) {
          svc.warnings.push({ level: "error",
            msg: "\"" + p.name + "\" is missing Avg speed." });
        }
      });
    } else {
      // "either" — at least one of the two must be present.
      ps.forEach(function (p) {
        if (!(p.runTime > 0) && !(p.avgSpeed > 0)) {
          svc.warnings.push({ level: "error",
            msg: "\"" + p.name + "\" is missing both Run time and Avg speed — set one." });
        }
      });
    }

    // No service bands with a headway defined on any pattern
    var hasAnyBand = ps.some(function (p) {
      var s = p.service || {};
      var any = function (arr) {
        return Array.isArray(arr) && arr.some(function (b) {
          var f = parseFloat(b && b.frequency);
          return isFinite(f) && f > 0;
        });
      };
      return any(s.weekday) || any(s.saturday) || any(s.sunday);
    });
    if (!hasAnyBand) {
      svc.warnings.push({
        level: "error",
        msg: "No service bands with a headway defined. Add bands via the Attributes popup."
      });
    }
  }

  function buildTransitServices(options) {
    var runtimeMode = (options && options.runtimeMode) || "either";

    var services = [];
    var buckets  = {};  // serviceId -> { name, patterns:[] }

    function add(feature, type, idx) {
      var p = collectPattern(feature, type, idx);
      if (p.serviceId) {
        if (!buckets[p.serviceId]) buckets[p.serviceId] = { name: p.serviceId, patterns: [] };
        buckets[p.serviceId].patterns.push(p);
      } else {
        services.push({
          key:      "solo-" + type + "-" + idx,
          name:     p.name,
          isGroup:  false,
          patterns: [p],
          warnings: []
        });
      }
    }

    (App.routes || []).forEach(function (f, i) { add(f, "route", i); });
    (App.lines  || []).forEach(function (f, i) { add(f, "line",  i); });

    Object.keys(buckets).sort().forEach(function (k) {
      var b = buckets[k];
      services.push({
        key:      "service-" + k,
        name:     b.name,
        isGroup:  true,
        patterns: b.patterns,
        warnings: []
      });
    });

    services.forEach(function (s) { validateService(s, runtimeMode); });
    return services;
  }

  // Resolve service.sundayMirrorsSaturday into the effective bands array.
  // When day === "sunday" and the flag is on, return Saturday's bands.
  // Otherwise return service[day] (or [] if missing). Tolerates service==null.
  function getEffectiveServiceBands(service, day) {
    if (!service) return [];
    if (day === "sunday" && service.sundayMirrorsSaturday) {
      return Array.isArray(service.saturday) ? service.saturday : [];
    }
    return Array.isArray(service[day]) ? service[day] : [];
  }

  function directionSummary(svc) {
    return svc.patterns.map(function (p) { return p.direction; }).join(" + ");
  }

  function hasBlockingWarnings(svc) {
    return svc.warnings.some(function (w) { return w.level === "error"; });
  }

  App.buildTransitServices       = buildTransitServices;
  App.getEffectiveServiceBands   = getEffectiveServiceBands;
  App.directionSummary           = directionSummary;
  App.hasBlockingWarnings        = hasBlockingWarnings;
})();
