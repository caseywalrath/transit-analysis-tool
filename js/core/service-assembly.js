// js/core/service-assembly.js
// Shared transit-service assembly for Route Costing, Trip Builder, and any
// future module that needs to bucket drawn routes/lines by attributes.serviceId.
// No DOM access. Depends on App.routes, App.lines, and turf (CDN).
//
// Exports:
//   App.buildTransitServices(options) → Service[]
//   App.getEffectiveServiceBands(service, day) → bands[]
//   App.directionSummary(svc) / App.hasBlockingWarnings(svc) — convenience.
//   App.migrateServiceKey(key, arraysByType) → string | null — upgrades a
//     legacy index-based solo key to the ID-based format (see below).
//
// A Service is { key, name, isGroup, patterns: [...], warnings: [...] }.
// A pattern is the per-feature record emitted by collectPattern().
//
// Service keys (persisted by Route Costing / Trip Builder):
//   paired: "service-<serviceId>"            (serviceId is a stable string)
//   solo:   "solo-<type>-id<stable ID>"      e.g. "solo-route-id12"
// The solo key is built from the feature's stable ID (properties.routeIdx /
// lineIdx), NOT its array index, so it survives deleting or merging an earlier
// feature (docs/feature-merge-plan.md Phase 4b). The old format was
// "solo-<type>-<arrayIndex>" ("solo-route-3"); the "id" infix makes the two
// formats impossible to confuse, and migrateServiceKey upgrades a legacy one.

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // Valid direction opposites for 2-pattern Services (3+ pattern Services have no pair rule) (sorted, "|"-joined key).
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
    var fid = feature.properties && feature.properties[App.FEATURE_ID_PROP[type]];
    return {
      featureType:  type,
      featureIndex: idx,   // derived at assembly time; resolve by featureId for anything long-lived
      featureId:    (typeof fid === "number") ? fid : null,
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

    // 3+ patterns (docs/gtfs-route-browser-plan.md "Phase 3 design"): each
    // pattern is costed as its own one-way trip stream, so the opposite-pair
    // rule cannot apply. Instead every pattern needs a one-way direction —
    // "Both" (also what a blank direction reads as) would be ambiguous.
    if (ps.length >= 3) {
      ps.forEach(function (p) {
        if (p.direction === "Both") {
          svc.warnings.push({ level: "error",
            msg: "\"" + p.name + "\" needs a one-way direction (NB/SB/EB/WB/Inbound/Outbound/Loop/CW/CCW) — " +
                 "in a Service with 3+ patterns each pattern is one direction of travel." });
        }
      });
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

  // ID-based solo key; falls back to the legacy index form only for a feature
  // with no stable ID (none exist after cache.applyState / the draw paths).
  function soloKey(type, id, idx) {
    return (typeof id === "number") ? ("solo-" + type + "-id" + id) : ("solo-" + type + "-" + idx);
  }

  // Upgrade a legacy "solo-<type>-<arrayIndex>" key to "solo-<type>-id<ID>".
  // MUST be called while the array index still points at the feature that was
  // selected when the key was saved — i.e. inside a module's cache apply()
  // hook, which runs after cache.applyState pushed the features in saved order.
  // Returns the key unchanged when it is not a legacy solo key (new-format and
  // "service-…" keys pass through, so this is idempotent), and null for a
  // legacy key whose index no longer resolves to a feature with an ID.
  // arraysByType defaults to the live App arrays.
  function migrateServiceKey(key, arraysByType) {
    if (typeof key !== "string") return null;
    var m = /^solo-(route|line)-(\d+)$/.exec(key);
    if (!m) return key;
    var arrs = arraysByType || { route: App.routes, line: App.lines };
    var ref = App._featureRefIn ? App._featureRefIn(arrs, m[1], parseInt(m[2], 10)) : null;
    return ref ? soloKey(ref.type, ref.id, -1) : null;
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
          key:      soloKey(type, p.featureId, idx),
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
  App.migrateServiceKey          = migrateServiceKey;
  App.getEffectiveServiceBands   = getEffectiveServiceBands;
  App.directionSummary           = directionSummary;
  App.hasBlockingWarnings        = hasBlockingWarnings;
})();
