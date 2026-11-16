// js/core/cdot-roads.js
// Pure engine for the CDOT road layers as a street source (window.CdotRoads).
// Builds the ArcGIS query URL for one page, checks one parsed page, maps the
// CDOT attributes onto the properties the road-network builder reads, and merges
// all pages of all layers into one LineString FeatureCollection.
// CONSTRAINT: plain-value code only (no geometry library, no DOM, no network
// calls, no app state) so the golden harness can load it into a bare vm sandbox.
// pageUrl is the only function that throws (its caller decides what to report);
// everything else returns { ok: false, error }, null, an empty collection or a count.

(function () {
  "use strict";

  var SERVICE = "https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer";

  // Matches the service's maxRecordCount, so a full page is always the server's
  // own page size and a shorter page means the layer has run out of features.
  var PAGE_SIZE = 2000;

  var LAYERS = {
    14: { name: "Local Roads", outFields: "OBJECTID,GISID,ROUTENAME,FUNCCLASSID" },
    17: { name: "Major Roads", outFields: "OBJECTID,GISID,ROUTENAME,FUNCCLASSID" },
    7: { name: "Highways", outFields: "OBJECTID,ROUTE,FUNCCLASS,ACCESS_,ROUTESIGN" }
  };

  // Which CDOT field carries the functional class, and the highway value for each
  // leading digit of that field. Layers 14 and 17 use the ID field; layer 7 has no
  // ID suffix. Values are the approved mapping in the design brief, section 4.
  var MAPPING = {
    14: { field: "FUNCCLASSID", values: { "7": "residential" } },
    17: {
      field: "FUNCCLASSID",
      values: { "2": "trunk", "3": "primary", "4": "secondary", "5": "tertiary", "6": "tertiary" }
    },
    7: {
      field: "FUNCCLASS",
      values: {
        "1": "motorway", "2": "trunk", "3": "primary", "4": "secondary",
        "5": "tertiary", "6": "tertiary", "7": "residential"
      }
    }
  };

  function hasOwn(o, key) {
    return Object.prototype.hasOwnProperty.call(o, key);
  }

  function isObject(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x);
  }

  function isFiniteNumber(x) {
    return typeof x === "number" && isFinite(x);
  }

  // A missing CDOT attribute becomes "" so it never shows up as the word "undefined"
  // in a class or a name.
  function text(v) {
    return v === null || v === undefined ? "" : String(v);
  }

  function knownLayer(layerId) {
    return hasOwn(LAYERS, String(layerId));
  }

  function isBbox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return false;
    for (var k = 0; k < 4; k++) {
      if (!isFiniteNumber(bbox[k])) return false;
    }
    return true;
  }

  // Parameter order is the order the server's URL examples use; the golden
  // test compares the whole string, so a reordering is a visible change.
  function pageUrl(layerId, bbox, offset) {
    if (!knownLayer(layerId)) throw new Error("Unknown CDOT layer " + layerId);
    if (!isBbox(bbox)) throw new Error("Invalid bbox");
    var off = offset === undefined || offset === null ? 0 : offset;
    var geometry = bbox.map(function (v) { return v.toFixed(6); }).join(",");
    var params = [
      ["where", "1=1"],
      ["geometry", geometry],
      ["geometryType", "esriGeometryEnvelope"],
      ["inSR", "4326"],
      ["spatialRel", "esriSpatialRelIntersects"],
      ["outFields", LAYERS[String(layerId)].outFields],
      ["outSR", "4326"],
      ["returnGeometry", "true"],
      ["returnZ", "false"],
      ["returnM", "false"],
      ["orderByFields", "OBJECTID"],
      ["resultOffset", String(off)],
      ["resultRecordCount", String(PAGE_SIZE)],
      ["f", "geojson"]
    ];
    var query = params.map(function (pair) {
      return pair[0] + "=" + encodeURIComponent(pair[1]);
    }).join("&");
    return SERVICE + "/" + String(layerId) + "/query?" + query;
  }

  // The server sets the flag at the top level and, in some responses, under
  // properties too. Either one means another page follows.
  function hasMore(page) {
    if (!isObject(page)) return false;
    if (page.exceededTransferLimit === true) return true;
    return isObject(page.properties) && page.properties.exceededTransferLimit === true;
  }

  // Returns "" when every position is valid, otherwise "malformed" or "range".
  // nesting 0 is a LineString (positions directly), 1 a MultiLineString (lines of positions).
  function coordinateProblem(coords, nesting) {
    if (!Array.isArray(coords)) return "malformed";
    var i;
    if (nesting > 0) {
      for (i = 0; i < coords.length; i++) {
        var inner = coordinateProblem(coords[i], nesting - 1);
        if (inner !== "") return inner;
      }
      return "";
    }
    for (i = 0; i < coords.length; i++) {
      var p = coords[i];
      if (!Array.isArray(p) || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) return "malformed";
      if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return "range";
    }
    return "";
  }

  // Checks run in the brief's order, page-wide: the whole page's geometry types
  // are checked before any coordinate, and coordinates before OBJECTID. A failing
  // page is never loaded, so the first error is the one the user sees.
  function validatePage(page) {
    if (!isObject(page) || page.type !== "FeatureCollection") {
      return { ok: false, error: "not a FeatureCollection" };
    }
    if (!Array.isArray(page.features)) {
      return { ok: false, error: "features is not an array" };
    }
    var i;
    for (i = 0; i < page.features.length; i++) {
      var geom = isObject(page.features[i]) ? page.features[i].geometry : null;
      var gt = isObject(geom) ? geom.type : undefined;
      if (gt !== "LineString" && gt !== "MultiLineString") {
        return { ok: false, error: "feature " + i + " has geometry type " + text(gt) };
      }
    }
    for (i = 0; i < page.features.length; i++) {
      var g = page.features[i].geometry;
      var problem = coordinateProblem(g.coordinates, g.type === "MultiLineString" ? 1 : 0);
      if (problem === "range") {
        return { ok: false, error: "feature " + i + " has a coordinate outside longitude/latitude range" };
      }
      if (problem === "malformed") {
        return { ok: false, error: "feature " + i + " has malformed coordinates" };
      }
    }
    for (i = 0; i < page.features.length; i++) {
      var props = page.features[i].properties;
      if (!isObject(props) || !isFiniteNumber(props.OBJECTID)) {
        return { ok: false, error: "feature " + i + " has no OBJECTID" };
      }
    }
    return { ok: true };
  }

  // Leading digit, not the whole string: CDOT writes the class as "7  Local" with
  // two spaces, and the digit is the part that is stable across the layers.
  function classify(layerId, properties) {
    var p = isObject(properties) ? properties : {};
    var key = String(layerId);
    if (key === "7") {
      // Access codes decide before the functional class, as the approved mapping requires.
      var access = text(p.ACCESS_).trim();
      if (access.indexOf("F-W") === 0) return { highway: "motorway", foot: "" };
      if (access.indexOf("E-X") === 0) return { highway: "trunk", foot: "" };
    }
    if (hasOwn(MAPPING, key)) {
      var lead = text(p[MAPPING[key].field]).trim().charAt(0);
      if (hasOwn(MAPPING[key].values, lead)) {
        return { highway: MAPPING[key].values[lead], foot: "" };
      }
    }
    return { highway: "unclassified", foot: "" };
  }

  // Input: one entry per layer, { layerId, features } with every page of that layer
  // already concatenated. A feature seen before (same layer and OBJECTID) is kept
  // once and counted as a duplicate. A feature with no numeric OBJECTID or no
  // geometry object is counted as skipped. Entries without a usable layerId are ignored.
  function toRoadGeoJSON(layerResults) {
    var features = [];
    var report = { perLayer: {}, unclassified: 0, duplicates: 0, skipped: 0 };
    if (!Array.isArray(layerResults)) {
      return { geojson: { type: "FeatureCollection", features: features }, report: report };
    }
    var seen = Object.create(null);
    for (var e = 0; e < layerResults.length; e++) {
      var entry = layerResults[e];
      if (!isObject(entry) || entry.layerId === null || entry.layerId === undefined) continue;
      var lid = Number(entry.layerId);
      if (!isFiniteNumber(lid)) continue;
      var key = String(lid);
      if (!hasOwn(report.perLayer, key)) report.perLayer[key] = 0;
      var list = Array.isArray(entry.features) ? entry.features : [];
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!isObject(f) || !isObject(f.geometry) || !isObject(f.properties) ||
            !isFiniteNumber(f.properties.OBJECTID)) {
          report.skipped++;
          continue;
        }
        var oid = f.properties.OBJECTID;
        var id = key + ":" + oid;
        if (seen[id] === true) {
          report.duplicates++;
          continue;
        }
        seen[id] = true;
        var props = f.properties;
        var cls = classify(lid, props);
        var cdotClass = hasOwn(MAPPING, key) ? text(props[MAPPING[key].field]) : "";
        features.push({
          type: "Feature",
          geometry: f.geometry,
          properties: {
            highway: cls.highway,
            foot: "",
            name: text(props.ROUTENAME) || text(props.ROUTE) || "",
            sidewalk: "",
            footway: "",
            // The layer offset keeps ids from layers 14 and 17 apart, and the
            // numeric form is what the street-exclusion set compares.
            wayId: lid * 100000000 + oid,
            cdotId: key + "/" + oid,
            gisId: text(props.GISID),
            cdotClass: cdotClass,
            layerId: lid
          }
        });
        report.perLayer[key]++;
        if (cls.highway === "unclassified") report.unclassified++;
      }
    }
    return { geojson: { type: "FeatureCollection", features: features }, report: report };
  }

  var CdotRoads = {
    SERVICE: SERVICE,
    PAGE_SIZE: PAGE_SIZE,
    LAYERS: LAYERS,
    pageUrl: pageUrl,
    hasMore: hasMore,
    validatePage: validatePage,
    classify: classify,
    toRoadGeoJSON: toRoadGeoJSON
  };

  // Test-only: the golden harness records return values, not thrown errors, so the
  // pageUrl error text is captured here. The guard is a bare name check, which the
  // browser never satisfies, so nothing extra is exposed in the app.
  if (typeof __MAT_TEST__ !== "undefined" && __MAT_TEST__) {
    CdotRoads._test = {
      pageUrlError: function (layerId, bbox, offset) {
        try {
          pageUrl(layerId, bbox, offset);
          return null;
        } catch (e) {
          return e.message;
        }
      }
    };
  }

  window.CdotRoads = CdotRoads;

})();
