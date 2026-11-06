// js/core/geopackage.js — window.GeoPackage: pure GeoPackage decoding helpers.
//
// A GeoPackage (.gpkg) is a SQLite database; gpkg-import.js opens it with
// sql.js and hands each geometry cell (a byte array) to parseGeometry() here.
// This file never touches App, the map, the DOM or sql.js, so the golden
// harness can load it alone (test/cases/geopackage.mjs).
//
// Geometry cell layout (OGC GeoPackage 1.2+, "GeoPackageBinary"):
//   "GP" | version | flags | srs_id (int32) | envelope (0/32/48/64 bytes) | WKB
// flags: bit 0 = header byte order (1 = little-endian), bits 1-3 = envelope
// kind, bit 4 = empty geometry. The WKB body carries its own byte order.

(function () {
  // Envelope byte sizes by flags bits 1-3 (0 = none, 1 = xy, 2 = xyz, 3 = xym, 4 = xyzm).
  var ENVELOPE_BYTES = [0, 32, 48, 48, 64];

  var WKB_TYPES = {
    1: "Point", 2: "LineString", 3: "Polygon", 4: "MultiPoint",
    5: "MultiLineString", 6: "MultiPolygon", 7: "GeometryCollection"
  };

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input && typeof input.length === "number") return new Uint8Array(input);
    return null;
  }

  // WKB reader. Handles ISO type codes (1001 = Point Z, 2001 = M, 3001 = ZM)
  // and EWKB high-bit flags (PostGIS-style writers); Z/M ordinates are read
  // and dropped since the map is 2-D.
  function WkbReader(bytes, offset) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }
  WkbReader.prototype.u32 = function (le) {
    var v = this.view.getUint32(this.pos, le); this.pos += 4; return v;
  };
  WkbReader.prototype.f64 = function (le) {
    var v = this.view.getFloat64(this.pos, le); this.pos += 8; return v;
  };
  WkbReader.prototype.geometry = function () {
    var le = this.view.getUint8(this.pos) === 1; this.pos += 1;
    var raw = this.u32(le);
    var hasZ = false, hasM = false;
    if (raw & 0x80000000) hasZ = true;
    if (raw & 0x40000000) hasM = true;
    if (raw & 0x20000000) this.pos += 4; // EWKB embedded SRID
    raw = raw & 0x0FFFFFFF;
    var dimCode = Math.floor(raw / 1000);
    if (dimCode === 1 || dimCode === 3) hasZ = true;
    if (dimCode === 2 || dimCode === 3) hasM = true;
    var code = raw % 1000;
    var type = WKB_TYPES[code];
    if (!type) throw new Error("Unsupported WKB geometry type " + raw);
    var dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
    var self = this;
    function point() {
      var x = self.f64(le), y = self.f64(le);
      self.pos += 8 * (dims - 2);
      return [x, y];
    }
    function ring() {
      var n = self.u32(le), out = new Array(n);
      for (var i = 0; i < n; i++) out[i] = point();
      return out;
    }
    function rings() {
      var n = self.u32(le), out = new Array(n);
      for (var i = 0; i < n; i++) out[i] = ring();
      return out;
    }
    function children() {
      var n = self.u32(le), out = [];
      for (var i = 0; i < n; i++) out.push(self.geometry());
      return out;
    }
    switch (type) {
      case "Point": {
        var p = point();
        // WKB has no empty-point marker except NaN ordinates.
        return (isNaN(p[0]) || isNaN(p[1])) ? null : { type: "Point", coordinates: p };
      }
      case "LineString": return { type: "LineString", coordinates: ring() };
      case "Polygon": return { type: "Polygon", coordinates: rings() };
      case "MultiPoint":
        return { type: "MultiPoint", coordinates: children().filter(Boolean).map(function (g) { return g.coordinates; }) };
      case "MultiLineString":
        return { type: "MultiLineString", coordinates: children().map(function (g) { return g.coordinates; }) };
      case "MultiPolygon":
        return { type: "MultiPolygon", coordinates: children().map(function (g) { return g.coordinates; }) };
      default:
        return { type: "GeometryCollection", geometries: children().filter(Boolean) };
    }
  };

  // Decode one geometry cell → { srsId, geometry } where geometry is a GeoJSON
  // geometry object, or null for an empty geometry. Throws on a malformed cell.
  function parseGeometry(input) {
    var bytes = toBytes(input);
    if (!bytes || bytes.length < 8) throw new Error("Geometry cell is too short");
    if (bytes[0] !== 0x47 || bytes[1] !== 0x50) throw new Error("Geometry cell has no GeoPackage header");
    var flags = bytes[3];
    var headerLE = (flags & 1) === 1;
    var envKind = (flags >> 1) & 7;
    if (envKind > 4) throw new Error("Invalid GeoPackage envelope flag " + envKind);
    var empty = (flags & 0x10) !== 0;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var srsId = view.getInt32(4, headerLE);
    if (empty) return { srsId: srsId, geometry: null };
    var start = 8 + ENVELOPE_BYTES[envKind];
    var geometry = new WkbReader(bytes, start).geometry();
    return { srsId: srsId, geometry: geometry };
  }

  // Simple geometry family for map styling: "point" | "line" | "polygon" | null.
  function geometryKind(geometry) {
    if (!geometry) return null;
    switch (geometry.type) {
      case "Point": case "MultiPoint": return "point";
      case "LineString": case "MultiLineString": return "line";
      case "Polygon": case "MultiPolygon": return "polygon";
      default: return null;
    }
  }

  // Split a GeometryCollection into its point/line/polygon members so each
  // can be drawn on the matching map layer. Other geometries pass through.
  function flattenGeometry(geometry) {
    if (!geometry) return [];
    if (geometry.type !== "GeometryCollection") return [geometry];
    var out = [];
    (geometry.geometries || []).forEach(function (g) { out = out.concat(flattenGeometry(g)); });
    return out;
  }

  // Whether an SRS row describes plain longitude/latitude WGS 84, which the
  // map can draw without reprojection. srs_id 0 is GeoPackage's "undefined
  // geographic" SRS and is treated as lon/lat.
  function isLonLatSrs(srs) {
    if (!srs) return false;
    if (srs.srsId === 0) return true;
    var org = String(srs.organization || "").toUpperCase();
    var code = Number(srs.organizationCoordsysId);
    if (org === "EPSG" && code === 4326) return true;
    if (org === "OGC" && (code === 84 || String(srs.organizationCoordsysId).toUpperCase() === "CRS84")) return true;
    return false;
  }

  function finite(v) { return typeof v === "number" && isFinite(v); }

  // Numeric value of a cell, or null. Numeric-looking text counts (some
  // writers store times as TEXT, e.g. "125.5").
  function numericValue(v) {
    if (finite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Number(v);
    return null;
  }

  // Pick the column to color a layer by: the first column whose name looks
  // like a travel time / cost (seconds, minutes, time, cost) and that holds at
  // least one numeric value. Returns { field, min, max, count } or null.
  var COLOR_FIELD_RE = /(second|minute|^sec|_sec|time|cost)/i;
  function pickColorField(columns, rows) {
    var names = (columns || []).filter(function (c) { return COLOR_FIELD_RE.test(c); });
    for (var i = 0; i < names.length; i++) {
      var f = names[i], min = Infinity, max = -Infinity, count = 0;
      for (var r = 0; r < rows.length; r++) {
        var v = numericValue(rows[r] ? rows[r][f] : null);
        if (v === null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        count++;
      }
      if (count > 0) return { field: f, min: min, max: max, count: count };
    }
    return null;
  }

  // True when every coordinate of a bounding box [w, s, e, n] is a plausible
  // longitude/latitude — catches a projected layer mislabeled as lon/lat.
  function bboxLooksLonLat(bb) {
    if (!bb || bb.length !== 4 || !bb.every(finite)) return false;
    return bb[0] >= -180 && bb[2] <= 180 && bb[1] >= -90 && bb[3] <= 90;
  }

  // Display text for a cell value in popups and the table viewer.
  function formatValue(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") {
      if (Number.isInteger(v)) return String(v);
      return String(Math.round(v * 1000) / 1000);
    }
    if (v instanceof Uint8Array) return "(binary, " + v.length + " bytes)";
    return String(v);
  }

  window.GeoPackage = {
    parseGeometry: parseGeometry,
    geometryKind: geometryKind,
    flattenGeometry: flattenGeometry,
    isLonLatSrs: isLonLatSrs,
    numericValue: numericValue,
    pickColorField: pickColorField,
    bboxLooksLonLat: bboxLooksLonLat,
    formatValue: formatValue
  };
})();
