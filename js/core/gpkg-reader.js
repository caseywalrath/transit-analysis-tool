// js/core/gpkg-reader.js
// GeoPackage geometry blob and attribute row reader (window.GpkgReader).
// CONSTRAINT: plain-value parsing only — no DOM, map, sql.js or App state — so
// the golden harness can load it into a bare node:vm sandbox
// (test/cases/gpkg-reader.mjs). Format and projection rules:
// docs/reference/layers-and-styling.md, "GeoPackage import".

(function () {
  "use strict";

  // Envelope size in bytes, indexed by the 3-bit envelope type in the flags
  // byte. Types 5-7 are reserved; they are rejected rather than guessed at,
  // because the blob length after the header would be unknowable.
  var ENVELOPE_BYTES = [0, 32, 48, 48, 64];

  // Reads `count` coordinates of `dims` float64 values each. Only x and y are
  // kept: Z and M are parsed past so the following bytes line up, but they are
  // not part of the 2D output.
  function readCoords(view, p, le, dims, count) {
    var coords = [];
    for (var i = 0; i < count; i++) {
      coords.push([view.getFloat64(p, le), view.getFloat64(p + 8, le)]);
      p += dims * 8;
    }
    return { coords: coords, next: p };
  }

  // A uint32 count followed by that many coordinates (LineString, polygon ring).
  function readRun(view, p, le, dims) {
    var n = view.getUint32(p, le);
    return readCoords(view, p + 4, le, dims, n);
  }

  // Thrown for a WKB base type this reader does not know (CircularString,
  // CurvePolygon, MultiSurface, ...). Their byte lengths are unknown, so the
  // walk cannot continue past them; a shared instance lets parseGeometryBlob
  // tell this apart from a malformed blob, which must still throw.
  var UNSUPPORTED_WKB = new Error("Unsupported WKB geometry type");

  // Reads one complete WKB geometry starting at `offset`. Every nested geometry
  // carries its own byte-order byte and type, so each call reads its own header.
  // Returns { geometry, skipped, bytesRead, base }. geometry is null when there
  // is nothing to draw: a GeometryCollection (skipped "collection"), a
  // zero-length LineString or Polygon, an empty Point, a Multi* with no
  // surviving members, or a Multi* with a member of the wrong type (skipped
  // "unsupported"). base is the normalized base type, which a parent Multi*
  // needs to check its members when the member's geometry is null.
  function readWkb(view, offset) {
    var byteOrder = view.getUint8(offset);
    if (byteOrder !== 0 && byteOrder !== 1) throw new Error("Bad WKB byte order");
    var le = byteOrder === 1;
    var type = view.getUint32(offset + 1, le);
    var p = offset + 5;

    // EWKB flags (PostGIS-style) can appear on files written by other tools.
    // The SRID, when present, sits between the type and the coordinates.
    var hasZ = (type & 0x80000000) !== 0;
    var hasM = (type & 0x40000000) !== 0;
    var hasSrid = (type & 0x20000000) !== 0;
    if (hasSrid) p += 4;

    var code = type & 0x1fffffff;
    var base = code % 1000;
    var iso = Math.floor(code / 1000);
    if (iso === 1 || iso === 3) hasZ = true;
    if (iso === 2 || iso === 3) hasM = true;
    var dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

    var geometry = null;
    var skipped = null;
    var i, run, member, n;

    if (base === 1) {
      var pt = readCoords(view, p, le, dims, 1);
      p = pt.next;
      var c = pt.coords[0];
      // An empty Point is encoded as NaN coordinates. One NaN is enough: a
      // point with either coordinate missing has no position to draw.
      if (!(isNaN(c[0]) || isNaN(c[1]))) geometry = { type: "Point", coordinates: c };
    } else if (base === 2) {
      run = readRun(view, p, le, dims);
      p = run.next;
      // A zero-point LineString has nothing to draw and is reported as empty.
      if (run.coords.length > 0) geometry = { type: "LineString", coordinates: run.coords };
    } else if (base === 3) {
      n = view.getUint32(p, le);
      p += 4;
      var rings = [];
      for (i = 0; i < n; i++) {
        run = readRun(view, p, le, dims);
        p = run.next;
        rings.push(run.coords);
      }
      if (rings.length > 0) geometry = { type: "Polygon", coordinates: rings };
    } else if (base >= 4 && base <= 6) {
      // Each Multi* accepts one member base type. A mismatched member (a
      // LineString inside a MultiPoint, a nested collection, ...) makes the
      // whole geometry unsupported, but the members are still walked so the
      // byte count stays right for any enclosing collection.
      var wantBase = base - 3;
      var mismatch = false;
      n = view.getUint32(p, le);
      p += 4;
      var parts = [];
      for (i = 0; i < n; i++) {
        member = readWkb(view, p);
        p += member.bytesRead;
        if (member.base !== wantBase) {
          mismatch = true;
        } else if (member.geometry) {
          // An empty member (an empty Point, a zero-point LineString) is
          // dropped from the Multi type rather than kept as a null coordinate.
          parts.push(member.geometry.coordinates);
        }
      }
      if (mismatch) {
        skipped = "unsupported";
      } else if (parts.length > 0) {
        if (base === 4) geometry = { type: "MultiPoint", coordinates: parts };
        else if (base === 5) geometry = { type: "MultiLineString", coordinates: parts };
        else geometry = { type: "MultiPolygon", coordinates: parts };
      }
    } else if (base === 7) {
      // Not drawable, but the members must still be walked: the byte count
      // returned to the caller depends on them, and a member after a nested
      // collection would otherwise be read from the wrong offset.
      n = view.getUint32(p, le);
      p += 4;
      for (i = 0; i < n; i++) {
        member = readWkb(view, p);
        p += member.bytesRead;
      }
      skipped = "collection";
    } else {
      throw UNSUPPORTED_WKB;
    }

    return { geometry: geometry, skipped: skipped, bytesRead: p - offset, base: base };
  }

  // Public WKB entry point. view is a DataView over the WKB bytes. An unknown
  // base type throws UNSUPPORTED_WKB, because its length is unknown; callers
  // that want a reportable result should use parseGeometryBlob instead.
  function wkbToGeoJSON(view, offset) {
    var r = readWkb(view, offset);
    return { geometry: r.geometry, bytesRead: r.bytesRead, skipped: r.skipped };
  }

  // bytes: Uint8Array holding one GeoPackage geometry blob (header + WKB).
  // Returns { geometry, empty, skipped }; skipped is null, "collection", or
  // "unsupported" (an extended blob, an unknown WKB type, or a Multi* member of
  // the wrong type). Throws on a blob that is not a GeoPackage geometry, has a
  // reserved envelope type, or has a malformed WKB header.
  function parseGeometryBlob(bytes) {
    if (bytes.length < 8) throw new Error("Not a GeoPackage geometry");
    if (bytes[0] !== 0x47 || bytes[1] !== 0x50) throw new Error("Not a GeoPackage geometry");

    var flags = bytes[3];
    var envType = (flags >> 1) & 7;
    if (envType > 4) throw new Error("Bad envelope type");

    // Checked before the envelope is skipped, so an empty blob is still
    // reported as empty without reading its (absent) WKB.
    if (flags & 16) return { geometry: null, empty: true, skipped: null };

    // Bit 5 marks an extended encoding whose payload this reader does not
    // decode. Reading it as plain WKB would produce wrong coordinates.
    if (flags & 0x20) return { geometry: null, empty: false, skipped: "unsupported" };

    // The header's srs_id and envelope values are not used; the WKB carries
    // its own byte order, so bit 0 of flags does not apply here.
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var r;
    try {
      r = readWkb(view, 8 + ENVELOPE_BYTES[envType]);
    } catch (e) {
      if (e === UNSUPPORTED_WKB) return { geometry: null, empty: false, skipped: "unsupported" };
      throw e;
    }
    return {
      geometry: r.geometry,
      empty: r.geometry === null && r.skipped === null,
      skipped: r.skipped
    };
  }

  // columns: [{ name, type, pk, isGeom }], values: the matching array.
  // BOOLEAN stores 0/1 and is converted; BLOB is dropped because it cannot be
  // shown in a popup. A declared type that starts with BLOB (SQLite allows a
  // length, as in BLOB(1024)) is dropped the same way, as is a value that
  // arrives as a Uint8Array. NULL is omitted rather than shown as null.
  // Declared types are upper-cased first because SQLite stores them as written.
  function rowToProperties(columns, values) {
    var props = {};
    for (var i = 0; i < columns.length; i++) {
      var col = columns[i];
      if (col.pk || col.isGeom) continue;
      var v = values[i];
      if (v === null || v === undefined) continue;
      var type = String(col.type || "").toUpperCase();
      if (type.indexOf("BLOB") === 0 || v instanceof Uint8Array) continue;
      if (type === "BOOLEAN" && (v === 0 || v === 1)) v = v === 1;
      props[col.name] = v;
    }
    return props;
  }

  // Hex string to Uint8Array. Only an even-length string of hex digits is
  // accepted: parseInt would read "1g" as 1 and an odd length would silently
  // drop the last digit, either of which could parse as a wrong but valid blob.
  function hexToBytes(hex) {
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("Bad hex");
    var n = hex.length / 2;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  // Golden-test wrappers. Case arguments must be plain JSON, so these accept
  // strings and do the byte conversion here.
  function parseGeometryHex(hex) {
    return parseGeometryBlob(hexToBytes(hex));
  }

  // Raw WKB (no GeoPackage header) from hex, for checking how many bytes the
  // walk consumes. Trailing bytes after the geometry are not an error.
  function wkbHexToGeoJSON(hex) {
    var bytes = hexToBytes(hex);
    return wkbToGeoJSON(new DataView(bytes.buffer), 0);
  }

  // Like parseGeometryHex, but a parse error is returned as data so a golden
  // case can pin the error message (the runner records a throw as a failure).
  function tryParseGeometryHex(hex) {
    try {
      return parseGeometryHex(hex);
    } catch (e) {
      return { error: e.message };
    }
  }

  function rowToPropertiesJSON(columnsJson, valuesJson) {
    return rowToProperties(JSON.parse(columnsJson), JSON.parse(valuesJson));
  }

  // ---- Projection resolution ----------------------------------------------
  // Decides how a layer's coordinates become longitude/latitude, without
  // calling proj4 (the caller does that), so the rules stay golden-testable.
  // Common codes get a proj string built here, so the importer never needs a
  // network lookup; anything else falls back to the WKT stored in the file,
  // and anything unusable is refused: drawing projected metres as degrees
  // would put the layer off the coast of Africa with no warning.
  function resolveProjection(srsRow, envelope) {
    var row = srsRow || {};
    var srsId = Number(row.srs_id);
    var org = String(row.organization || "").toUpperCase();
    var code = Number(row.organization_coordsys_id);
    var orgLabel = (row.organization || "?") + ":" + (row.organization_coordsys_id != null ? row.organization_coordsys_id : "?");
    var isEpsg = org === "EPSG";

    // OGC CRS84 has no integer code, so it is recognized by name or WKT.
    var isCrs84 = org === "OGC" && /CRS ?84/i.test(String(row.srs_name || "") + " " + String(row.definition || ""));
    if (srsId === 4326 || (isEpsg && code === 4326) || isCrs84) {
      return { kind: "none", label: "WGS 84 (EPSG:4326)" };
    }
    // NAD83 and WGS 84 differ by about a metre: below what this map can show.
    if (isEpsg && code === 4269) return { kind: "none", label: "NAD83 (EPSG:4269)" };
    if (isEpsg && (code === 3857 || code === 900913)) {
      return { kind: "proj4", def: "EPSG:3857", label: "Web Mercator (EPSG:3857)" };
    }
    if (isEpsg && code >= 26901 && code <= 26923) {
      var nz = code - 26900;
      return { kind: "proj4", def: "+proj=utm +zone=" + nz + " +datum=NAD83 +units=m +no_defs",
        label: "NAD83 / UTM zone " + nz + "N (EPSG:" + code + ")" };
    }
    if (isEpsg && code >= 32601 && code <= 32660) {
      var wz = code - 32600;
      return { kind: "proj4", def: "+proj=utm +zone=" + wz + " +datum=WGS84 +units=m +no_defs",
        label: "WGS 84 / UTM zone " + wz + "N (EPSG:" + code + ")" };
    }
    if (isEpsg && code >= 32701 && code <= 32760) {
      var sz = code - 32700;
      return { kind: "proj4", def: "+proj=utm +zone=" + sz + " +south +datum=WGS84 +units=m +no_defs",
        label: "WGS 84 / UTM zone " + sz + "S (EPSG:" + code + ")" };
    }
    var def = row.definition;
    if (typeof def === "string" && def.trim() && def.trim().toLowerCase() !== "undefined") {
      return { kind: "wkt", def: def, label: orgLabel + " (from file)" };
    }
    // Checked after the WKT: some writers keep srs_id -1/0 but still store a real
    // definition, which is better evidence than the envelope.
    if (srsId === -1 || srsId === 0) {
      if (_envelopeIsLonLat(envelope)) {
        return { kind: "none", label: "Undefined (treated as longitude/latitude)" };
      }
      return { kind: "unsupported", label: "Undefined projection",
        error: "Undefined projection and coordinates are not longitude/latitude" };
    }
    return { kind: "unsupported", label: orgLabel, error: "Unknown projection (" + orgLabel + ")" };
  }

  // A missing envelope is not evidence of lon/lat, so it counts as "no".
  function _envelopeIsLonLat(env) {
    if (!env) return false;
    var v = [env.minX, env.minY, env.maxX, env.maxY];
    for (var i = 0; i < 4; i++) if (typeof v[i] !== "number" || !isFinite(v[i])) return false;
    return env.minX >= -180 && env.maxX <= 180 && env.minY >= -90 && env.maxY <= 90;
  }

  // Applies fn([x, y]) -> [lon, lat] to every coordinate; returns a new
  // geometry. The transform is a parameter so tests need no proj4.
  function transformGeometry(geometry, fn) {
    if (!geometry) return geometry;
    function walk(c) {
      return typeof c[0] === "number" ? fn(c) : c.map(walk);
    }
    return { type: geometry.type, coordinates: walk(geometry.coordinates) };
  }

  // Golden-test wrapper: an affine transform described by plain numbers.
  function transformGeometryAffine(geometry, sx, sy, dx, dy) {
    return transformGeometry(geometry, function (c) { return [c[0] * sx + dx, c[1] * sy + dy]; });
  }

  // Numeric value of a table cell, or null. Numeric-looking text counts: some
  // writers store times as TEXT (e.g. "125.5"), and the color ramp would miss them.
  function numericValue(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Number(v);
    return null;
  }

  // Chooses the column a layer's map ramp is colored by. Only travel-time and
  // cost names qualify, so an id or length column never recolors a layer, and
  // the first qualifying column with a numeric value wins so the choice is
  // stable for a given column order. Returns { field, min, max, count } or null.
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

  // Display text for a cell value in the attribute table and popups.
  function formatValue(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") {
      if (Number.isInteger(v)) return String(v);
      return String(Math.round(v * 1000) / 1000);
    }
    if (v instanceof Uint8Array) return "(binary, " + v.length + " bytes)";
    return String(v);
  }

  window.GpkgReader = {
    resolveProjection: resolveProjection,
    transformGeometry: transformGeometry,
    transformGeometryAffine: transformGeometryAffine,
    parseGeometryBlob: parseGeometryBlob,
    wkbToGeoJSON: wkbToGeoJSON,
    rowToProperties: rowToProperties,
    parseGeometryHex: parseGeometryHex,
    wkbHexToGeoJSON: wkbHexToGeoJSON,
    tryParseGeometryHex: tryParseGeometryHex,
    rowToPropertiesJSON: rowToPropertiesJSON,
    numericValue: numericValue,
    pickColorField: pickColorField,
    formatValue: formatValue
  };

})();
