// Golden cases for the pure GeoPackage reader (window.GpkgReader).
// Blobs are built below from explicit bytes so each case states its own layout.
// Golden arguments must be plain JSON, so every case passes hex strings or
// JSON text, and the reader's hex/JSON wrappers do the conversion.

// ---- byte builders (plain arrays of 0-255 numbers) ------------------------
function bytesOf(dv) {
  return Array.from(new Uint8Array(dv.buffer));
}
function u32(v, le) {
  var dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, v, le);
  return bytesOf(dv);
}
function i32(v, le) {
  var dv = new DataView(new ArrayBuffer(4));
  dv.setInt32(0, v, le);
  return bytesOf(dv);
}
function f64(v, le) {
  var dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, le);
  return bytesOf(dv);
}
function coordBytes(c, le) {
  var out = [];
  c.forEach((v) => { out = out.concat(f64(v, le)); });
  return out;
}
// Full WKB geometry: byte-order byte, uint32 type, body.
function wkb(le, type, body) {
  return [le ? 1 : 0].concat(u32(type, le), body);
}
function ptsBody(coords, le) {
  var out = u32(coords.length, le);
  coords.forEach((c) => { out = out.concat(coordBytes(c, le)); });
  return out;
}
function ringsBody(rings, le) {
  var out = u32(rings.length, le);
  rings.forEach((r) => { out = out.concat(ptsBody(r, le)); });
  return out;
}
// Members are already-encoded WKB arrays, so each keeps its own byte order.
function membersBody(members, le) {
  var out = u32(members.length, le);
  members.forEach((m) => { out = out.concat(m); });
  return out;
}
function point(c, le, type) {
  return wkb(le, type || 1, coordBytes(c, le));
}
function lineString(coords, le, type) {
  return wkb(le, type || 2, ptsBody(coords, le));
}
function polygon(rings, le) {
  return wkb(le, 3, ringsBody(rings, le));
}
function hex(bytes) {
  return bytes.map((b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

// GeoPackage blob: "GP", version, flags, srs_id, envelope, WKB.
// Envelope values are a junk number so a wrong skip shows up in the output.
var ENV_DOUBLES = [0, 4, 6, 6, 8];
function blob(opts) {
  var le = opts.le !== false;
  var envType = opts.envType || 0;
  var flags = (le ? 1 : 0) | (envType << 1) | (opts.empty ? 16 : 0);
  var srs = opts.srs !== undefined ? opts.srs : 4326;
  var bytes = [0x47, 0x50, 0, flags].concat(i32(srs, le));
  var count = ENV_DOUBLES[envType] || 0;
  for (var k = 0; k < count; k++) bytes = bytes.concat(f64(999.5, le));
  return hex(bytes.concat(opts.wkb || []));
}

// Fixtures reused across cases.
var P = [-105.25, 39.75];
var RING_OUTER = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
var RING_HOLE = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
var RING_B = [[20, 20], [24, 20], [24, 24], [20, 20]];

var COLUMNS = [
  { name: "fid", type: "INTEGER", pk: 1, isGeom: false },
  { name: "geom", type: "POINT", pk: 0, isGeom: true },
  { name: "open", type: "BOOLEAN", pk: 0, isGeom: false },
  { name: "closed", type: "BOOLEAN", pk: 0, isGeom: false },
  { name: "name", type: "TEXT", pk: 0, isGeom: false },
  { name: "missing", type: "TEXT", pk: 0, isGeom: false },
  { name: "raw", type: "BLOB", pk: 0, isGeom: false },
  { name: "props", type: "TEXT", pk: 0, isGeom: false },
  { name: "flag", type: "boolean", pk: 0, isGeom: false },
  { name: "count", type: "INTEGER", pk: 0, isGeom: false }
];
var ROW = [1, "GPxx", 1, 0, "Stop A", null, "AAEC", "{\"a\":1}", 1, 42];

export default {
  scripts: ["js/core/gpkg-reader.js"],
  cases: [
    // ---- Points and envelope types --------------------------------------
    { id: "point-le-no-envelope", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: point(P, true) })] },
    { id: "point-be", call: "GpkgReader.parseGeometryHex", args: [blob({ le: false, wkb: point(P, false) })] },
    { id: "point-envelope-type-1", call: "GpkgReader.parseGeometryHex", args: [blob({ envType: 1, wkb: point(P, true) })] },
    { id: "point-envelope-type-2", call: "GpkgReader.parseGeometryHex", args: [blob({ envType: 2, wkb: point(P, true) })] },
    { id: "point-envelope-type-3", call: "GpkgReader.parseGeometryHex", args: [blob({ envType: 3, wkb: point(P, true) })] },
    { id: "point-envelope-type-4", call: "GpkgReader.parseGeometryHex", args: [blob({ envType: 4, wkb: point(P, true) })] },
    { id: "point-empty-flag", call: "GpkgReader.parseGeometryHex", args: [blob({ empty: true })] },
    { id: "point-nan-is-empty", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: point([NaN, NaN], true) })] },
    { id: "point-one-nan-is-empty", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: point([NaN, 39.7], true) })] },
    // ExtendedGeoPackageBinary (flags bit 5): the payload is not decoded, so
    // the WKB after the header is never read (the point here is ignored).
    { id: "extended-binary-unsupported", call: "GpkgReader.parseGeometryHex", args: [hex([0x47, 0x50, 0, 0x21].concat(i32(4326, true), point(P, true)))] },
    // Flags 0x31 = extended + empty + little-endian: the empty bit wins.
    { id: "extended-binary-empty-bit-wins", call: "GpkgReader.parseGeometryHex", args: [hex([0x47, 0x50, 0, 0x31].concat(i32(4326, true)))] },

    // ---- Lines and polygons ------------------------------------------------
    { id: "linestring", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: lineString([[0, 0], [1.5, 2.5], [3, -4]], true) })] },
    { id: "polygon-with-hole", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: polygon([RING_OUTER, RING_HOLE], true) })] },
    // Zero-count bodies have nothing to draw: geometry null, reported as empty.
    { id: "linestring-zero-points", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: lineString([], true) })] },
    { id: "polygon-zero-rings", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: polygon([], true) })] },

    // ---- Multi types -------------------------------------------------------
    { id: "multipoint", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 4, membersBody([point([1, 2], true), point([3, 4], true)], true)) })] },
    { id: "multilinestring", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 5, membersBody([lineString([[0, 0], [1, 1]], true), lineString([[5, 5], [6, 7]], true)], true)) })] },
    { id: "multipolygon-two-parts", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 6, membersBody([polygon([RING_OUTER], true), polygon([RING_B], true)], true)) })] },
    { id: "multipolygon-be-member-in-le", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 6, membersBody([polygon([RING_OUTER], true), polygon([RING_B], false)], true)) })] },
    // A Multi* whose members are all empty has nothing left to draw.
    { id: "multipoint-only-nan-member", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 4, membersBody([point([NaN, NaN], true)], true)) })] },
    // Mismatched member types make the whole geometry unsupported.
    { id: "multipoint-contains-linestring", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 4, membersBody([point([1, 2], true), lineString([[0, 0], [1, 1]], true)], true)) })] },
    { id: "multipolygon-contains-point", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 6, membersBody([polygon([RING_OUTER], true), point(P, true)], true)) })] },

    // ---- Z and M dimensions -----------------------------------------------
    { id: "pointz-1001", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 1001, coordBytes([1, 2, 3], true)) })] },
    { id: "pointm-2001", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 2001, coordBytes([1, 2, 7], true)) })] },
    { id: "pointzm-3001", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 3001, coordBytes([1, 2, 3, 4], true)) })] },
    { id: "linestringz-1002", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: lineString([[0, 0, 9], [1, 1, 8]], true, 1002) })] },
    { id: "ewkb-pointz-flag", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 0x80000001, coordBytes([1, 2, 3], true)) })] },
    { id: "ewkb-srid-flag", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: [1].concat(u32(0x20000001, true), i32(4326, true), coordBytes(P, true)) })] },

    // ---- Collections and errors -------------------------------------------
    { id: "collection-with-point", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 7, membersBody([point([1, 2], true)], true)) })] },
    { id: "collection-nested-members-walked", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 7, membersBody([wkb(true, 7, membersBody([point([1, 2], true)], true)), point([3, 4], true)], true)) })] },
    { id: "try-valid-point-passthrough", call: "GpkgReader.tryParseGeometryHex", args: [blob({ wkb: point(P, true) })] },
    { id: "bad-magic", call: "GpkgReader.tryParseGeometryHex", args: ["5850" + blob({ wkb: point(P, true) }).slice(4)] },
    { id: "bad-envelope-type-5", call: "GpkgReader.tryParseGeometryHex", args: [blob({ envType: 5, wkb: point(P, true) })] },
    { id: "bad-envelope-type-7", call: "GpkgReader.tryParseGeometryHex", args: [blob({ envType: 7, wkb: point(P, true) })] },
    // Unknown WKB base types have no known length, so they are skipped rather than thrown.
    { id: "curvepolygon-type-10-unsupported", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 10, ringsBody([RING_OUTER], true)) })] },
    { id: "collection-with-circularstring-member", call: "GpkgReader.parseGeometryHex", args: [blob({ wkb: wkb(true, 7, membersBody([wkb(true, 8, ptsBody([[0, 0], [1, 1], [2, 0]], true)), point([1, 2], true)], true)) })] },
    { id: "hex-odd-length", call: "GpkgReader.tryParseGeometryHex", args: ["47500"] },
    { id: "hex-non-hex-digits", call: "GpkgReader.tryParseGeometryHex", args: ["47zz00000000"] },

    // ---- WKB byte counts (raw WKB, no GeoPackage header) -------------------
    // PointZ: 1 byte order + 4 type + 3 doubles x 8 = 29 bytes.
    { id: "wkb-bytes-pointz", call: "GpkgReader.wkbHexToGeoJSON", args: [hex(wkb(true, 1001, coordBytes([1, 2, 3], true)))] },
    // Outer collection header 1 + 4 + 4 (count) = 9. Inner collection:
    // 1 + 4 + 4 + Point 2D (1 + 4 + 16 = 21) = 30. LineString of 2 points,
    // 2D: 1 + 4 + 4 + 2 x 16 = 41. Total 9 + 30 + 41 = 80.
    { id: "wkb-bytes-nested-collection", call: "GpkgReader.wkbHexToGeoJSON", args: [hex(wkb(true, 7, membersBody([wkb(true, 7, membersBody([point([1, 2], true)], true)), lineString([[0, 0], [1, 1]], true)], true)))] },
    // MultiPoint whose first member is a LineString (wrong type, skipped):
    // the walk still has to step over it. 9 header + LineString 41 + Point 21 = 71.
    { id: "wkb-bytes-multipoint-mismatch-walked", call: "GpkgReader.wkbHexToGeoJSON", args: [hex(wkb(true, 4, membersBody([lineString([[0, 0], [1, 1]], true), point([1, 2], true)], true)))] },

    // ---- Attribute rows ----------------------------------------------------
    // Expected: fid (pk), geom (geometry) and the BLOB dropped; open/closed
    // converted from 0/1; NULL omitted; lower-case declared type converted;
    // JSON-object text kept as text.
    { id: "row-full-rules", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify(COLUMNS), JSON.stringify(ROW)] },
    { id: "row-boolean-zero-and-one", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify([{ name: "a", type: "BOOLEAN", pk: 0, isGeom: false }, { name: "b", type: "BOOLEAN", pk: 0, isGeom: false }]), JSON.stringify([0, 1])] },
    { id: "row-null-omitted", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify([{ name: "a", type: "TEXT", pk: 0, isGeom: false }]), JSON.stringify([null])] },
    { id: "row-blob-skipped", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify([{ name: "raw", type: "BLOB", pk: 0, isGeom: false }, { name: "t", type: "TEXT", pk: 0, isGeom: false }]), JSON.stringify(["AAEC", "kept"])] },
    { id: "row-pk-and-geom-skipped", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify([{ name: "fid", type: "INTEGER", pk: 1, isGeom: false }, { name: "geom", type: "POINT", pk: 0, isGeom: true }, { name: "x", type: "INTEGER", pk: 0, isGeom: false }]), JSON.stringify([7, "GPxx", 3])] },
    { id: "row-lowercase-boolean", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify([{ name: "flag", type: "boolean", pk: 0, isGeom: false }]), JSON.stringify([1])] },
    { id: "row-json-text-unchanged", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify([{ name: "props", type: "TEXT", pk: 0, isGeom: false }]), JSON.stringify(["{\"a\":1}"])] },
    { id: "row-blob-with-length-declared-type", call: "GpkgReader.rowToPropertiesJSON", args: [JSON.stringify([{ name: "raw", type: "BLOB(1024)", pk: 0, isGeom: false }, { name: "t", type: "TEXT", pk: 0, isGeom: false }]), JSON.stringify(["AAEC", "kept"])] },

    // ---- resolveProjection: each step of the resolution order ----------
    { id: "proj-srsid-4326", call: "GpkgReader.resolveProjection", args: [{ srs_id: 4326, organization: "EPSG", organization_coordsys_id: 4326, definition: "GEOGCS[...]" }, null] },
    { id: "proj-epsg-4326-lowercase-org", call: "GpkgReader.resolveProjection", args: [{ srs_id: 100, organization: "epsg", organization_coordsys_id: 4326, definition: "x" }, null] },
    { id: "proj-ogc-crs84", call: "GpkgReader.resolveProjection", args: [{ srs_id: 100, organization: "OGC", srs_name: "WGS 84 (CRS84)", organization_coordsys_id: 84, definition: "x" }, null] },
    { id: "proj-epsg-4269", call: "GpkgReader.resolveProjection", args: [{ srs_id: 4269, organization: "EPSG", organization_coordsys_id: 4269, definition: "x" }, null] },
    { id: "proj-epsg-3857", call: "GpkgReader.resolveProjection", args: [{ srs_id: 3857, organization: "EPSG", organization_coordsys_id: 3857, definition: "x" }, null] },
    { id: "proj-epsg-900913", call: "GpkgReader.resolveProjection", args: [{ srs_id: 900913, organization: "EPSG", organization_coordsys_id: 900913, definition: "x" }, null] },
    { id: "proj-nad83-utm-13n", call: "GpkgReader.resolveProjection", args: [{ srs_id: 26913, organization: "EPSG", organization_coordsys_id: 26913, definition: "x" }, null] },
    { id: "proj-nad83-utm-1n", call: "GpkgReader.resolveProjection", args: [{ srs_id: 26901, organization: "EPSG", organization_coordsys_id: 26901, definition: "x" }, null] },
    { id: "proj-nad83-utm-23n", call: "GpkgReader.resolveProjection", args: [{ srs_id: 26923, organization: "EPSG", organization_coordsys_id: 26923, definition: "x" }, null] },
    { id: "proj-wgs84-utm-1n", call: "GpkgReader.resolveProjection", args: [{ srs_id: 32601, organization: "EPSG", organization_coordsys_id: 32601, definition: "x" }, null] },
    { id: "proj-wgs84-utm-60n", call: "GpkgReader.resolveProjection", args: [{ srs_id: 32660, organization: "EPSG", organization_coordsys_id: 32660, definition: "x" }, null] },
    { id: "proj-wgs84-utm-1s", call: "GpkgReader.resolveProjection", args: [{ srs_id: 32701, organization: "EPSG", organization_coordsys_id: 32701, definition: "x" }, null] },
    { id: "proj-wgs84-utm-60s", call: "GpkgReader.resolveProjection", args: [{ srs_id: 32760, organization: "EPSG", organization_coordsys_id: 32760, definition: "x" }, null] },
    // Just outside each UTM range: fall through to the file's WKT, or refuse without one.
    { id: "proj-26900-falls-to-wkt", call: "GpkgReader.resolveProjection", args: [{ srs_id: 26900, organization: "EPSG", organization_coordsys_id: 26900, definition: "PROJCS[\"x\"]" }, null] },
    { id: "proj-26924-no-wkt-unsupported", call: "GpkgReader.resolveProjection", args: [{ srs_id: 26924, organization: "EPSG", organization_coordsys_id: 26924, definition: "" }, null] },
    { id: "proj-32661-undefined-wkt-unsupported", call: "GpkgReader.resolveProjection", args: [{ srs_id: 32661, organization: "EPSG", organization_coordsys_id: 32661, definition: "undefined" }, null] },
    { id: "proj-other-org-wkt", call: "GpkgReader.resolveProjection", args: [{ srs_id: 999001, organization: "NONE", organization_coordsys_id: 999001, definition: "NOT A REAL WKT" }, null] },
    { id: "proj-undefined-minus1-lonlat-envelope", call: "GpkgReader.resolveProjection", args: [{ srs_id: -1, organization: "NONE", organization_coordsys_id: -1, definition: "undefined" }, { minX: -105, minY: 39.7, maxX: -104.9, maxY: 39.8 }] },
    { id: "proj-undefined-0-projected-envelope", call: "GpkgReader.resolveProjection", args: [{ srs_id: 0, organization: "NONE", organization_coordsys_id: 0, definition: "undefined" }, { minX: 500000, minY: 4400000, maxX: 500000, maxY: 4400000 }] },
    { id: "proj-undefined-no-envelope", call: "GpkgReader.resolveProjection", args: [{ srs_id: -1, organization: "NONE", organization_coordsys_id: -1, definition: "undefined" }, null] },
    { id: "proj-undefined-srs-with-real-wkt", call: "GpkgReader.resolveProjection", args: [{ srs_id: 0, organization: "NONE", organization_coordsys_id: 0, definition: "PROJCS[\"y\"]" }, { minX: -1, minY: -1, maxX: 1, maxY: 1 }] },
    { id: "proj-null-row", call: "GpkgReader.resolveProjection", args: [null, null] },

    // ---- transformGeometry (affine stand-in for proj4) -------------------
    { id: "transform-point", call: "GpkgReader.transformGeometryAffine", args: [{ type: "Point", coordinates: [1, 2] }, 2, 3, 10, 20] },
    { id: "transform-polygon-hole", call: "GpkgReader.transformGeometryAffine", args: [{ type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] }, 1, 1, -100, 40] },
    { id: "transform-multipolygon", call: "GpkgReader.transformGeometryAffine", args: [{ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] }, 0.5, 0.5, 0, 0] },
    { id: "transform-null", call: "GpkgReader.transformGeometryAffine", args: [null, 1, 1, 0, 0] },
  ],
};
