// Golden cases for the pure GeoPackage decoder (window.GeoPackage,
// js/core/geopackage.js). Geometry cells are built here byte by byte so each
// case pins one header/WKB variant: envelope sizes, byte orders, ISO Z/M type
// codes, EWKB flags, empty geometries and collections.

function f64(v, le) { const b = Buffer.alloc(8); le ? b.writeDoubleLE(v) : b.writeDoubleBE(v); return [...b]; }
function u32(v, le) { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); return [...b]; }
function i32(v, le) { const b = Buffer.alloc(4); le ? b.writeInt32LE(v) : b.writeInt32BE(v); return [...b]; }

// GeoPackage header: magic, version 0, flags, srs_id, envelope doubles.
function header({ srs = 4326, env = 0, empty = false, le = true } = {}) {
  const flags = (le ? 1 : 0) | (env << 1) | (empty ? 0x10 : 0);
  const sizes = [0, 4, 6, 6, 8];
  const out = [0x47, 0x50, 0, flags, ...i32(srs, le)];
  for (let i = 0; i < sizes[env]; i++) out.push(...f64(i, le));
  return out;
}
const pts = (coords, le, dims = 2) => coords.flatMap((c) => {
  const out = [...f64(c[0], le), ...f64(c[1], le)];
  for (let d = 2; d < dims; d++) out.push(...f64(c[d] ?? 0, le));
  return out;
});
const wkbPoint = (c, le = true, type = 1, dims = 2) => [le ? 1 : 0, ...u32(type, le), ...pts([c], le, dims)];
const wkbLine = (cs, le = true, type = 2, dims = 2) => [le ? 1 : 0, ...u32(type, le), ...u32(cs.length, le), ...pts(cs, le, dims)];
const wkbPoly = (rings, le = true) => [le ? 1 : 0, ...u32(3, le), ...u32(rings.length, le),
  ...rings.flatMap((r) => [...u32(r.length, le), ...pts(r, le)])];
const wkbMulti = (type, parts, le = true) => [le ? 1 : 0, ...u32(type, le), ...u32(parts.length, le), ...parts.flat()];

const LINE = [[-105.0, 39.75], [-104.99, 39.751], [-104.98, 39.752]];
const RING = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

export default {
  scripts: ["js/core/geopackage.js"],
  cases: [
    // ---- parseGeometry: headers ----
    { id: "point-le-no-envelope", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbPoint([-105.0004685, 39.7529095])]] },
    { id: "point-be-header-and-wkb", call: "GeoPackage.parseGeometry", args: [[...header({ le: false }), ...wkbPoint([-105.1, 39.6], false)]] },
    { id: "line-xy-envelope-32", call: "GeoPackage.parseGeometry", args: [[...header({ env: 1 }), ...wkbLine(LINE)]] },
    { id: "line-xyz-envelope-48", call: "GeoPackage.parseGeometry", args: [[...header({ env: 2 }), ...wkbLine(LINE)]] },
    { id: "line-xyzm-envelope-64", call: "GeoPackage.parseGeometry", args: [[...header({ env: 4 }), ...wkbLine(LINE)]] },
    { id: "srs-id-zero-kept", call: "GeoPackage.parseGeometry", args: [[...header({ srs: 0 }), ...wkbPoint([1, 2])]] },
    { id: "empty-flag-null-geometry", call: "GeoPackage.parseGeometry", args: [[...header({ empty: true }), ...wkbPoint([NaN, NaN])]] },
    { id: "nan-point-null-geometry", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbPoint([NaN, NaN])]] },

    // ---- parseGeometry: WKB variants (Z/M dropped to 2-D) ----
    { id: "iso-point-z-1001", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbPoint([1, 2, 99], true, 1001, 3)]] },
    { id: "iso-line-zm-3002", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbLine([[1, 2, 3, 4], [5, 6, 7, 8]], true, 3002, 4)]] },
    { id: "ewkb-point-z-flag", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbPoint([3, 4, 5], true, 0x80000001, 3)]] },
    { id: "polygon-with-hole", call: "GeoPackage.parseGeometry",
      args: [[...header(), ...wkbPoly([RING, [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]]])]] },
    { id: "multipoint", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbMulti(4, [wkbPoint([1, 1]), wkbPoint([2, 2])])]] },
    { id: "multilinestring", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbMulti(5, [wkbLine(LINE), wkbLine([[0, 0], [1, 1]])])]] },
    { id: "multipolygon", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbMulti(6, [wkbPoly([RING])])]] },
    { id: "geometry-collection", call: "GeoPackage.parseGeometry", args: [[...header(), ...wkbMulti(7, [wkbPoint([1, 1]), wkbLine([[0, 0], [1, 1]])])]] },

    // ---- geometryKind / flattenGeometry ----
    { id: "kind-multilinestring-line", call: "GeoPackage.geometryKind", args: [{ type: "MultiLineString", coordinates: [] }] },
    { id: "kind-multipoint-point", call: "GeoPackage.geometryKind", args: [{ type: "MultiPoint", coordinates: [] }] },
    { id: "kind-null", call: "GeoPackage.geometryKind", args: [null] },
    { id: "flatten-collection", call: "GeoPackage.flattenGeometry",
      args: [{ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 1] },
        { type: "GeometryCollection", geometries: [{ type: "LineString", coordinates: [[0, 0], [1, 1]] }] }] }] },

    // ---- isLonLatSrs ----
    { id: "srs-epsg-4326", call: "GeoPackage.isLonLatSrs", args: [{ srsId: 4326, organization: "EPSG", organizationCoordsysId: 4326 }] },
    { id: "srs-lowercase-epsg", call: "GeoPackage.isLonLatSrs", args: [{ srsId: 4326, organization: "epsg", organizationCoordsysId: 4326 }] },
    { id: "srs-ogc-crs84", call: "GeoPackage.isLonLatSrs", args: [{ srsId: 100, organization: "OGC", organizationCoordsysId: 84 }] },
    { id: "srs-undefined-geographic", call: "GeoPackage.isLonLatSrs", args: [{ srsId: 0 }] },
    { id: "srs-state-plane-rejected", call: "GeoPackage.isLonLatSrs", args: [{ srsId: 2232, organization: "EPSG", organizationCoordsysId: 2232 }] },
    { id: "srs-undefined-cartesian-rejected", call: "GeoPackage.isLonLatSrs", args: [{ srsId: -1, organization: "NONE", organizationCoordsysId: -1 }] },
    { id: "srs-missing-rejected", call: "GeoPackage.isLonLatSrs", args: [null] },

    // ---- pickColorField ----
    { id: "color-seconds-field", call: "GeoPackage.pickColorField",
      args: [["node_id", "seconds"], [{ node_id: "a", seconds: 12 }, { node_id: "b", seconds: 300.5 }, { node_id: "c", seconds: null }]] },
    { id: "color-text-seconds-parsed", call: "GeoPackage.pickColorField",
      args: [["node_id", "remaining_seconds"], [{ remaining_seconds: "40" }, { remaining_seconds: "7.5" }, { remaining_seconds: "n/a" }]] },
    { id: "color-skips-all-null-candidate", call: "GeoPackage.pickColorField",
      args: [["seconds", "minutes"], [{ seconds: null, minutes: 3 }, { seconds: "", minutes: 9 }]] },
    { id: "color-none-without-time-column", call: "GeoPackage.pickColorField",
      args: [["name", "length_ft"], [{ name: "x", length_ft: 10 }]] },

    // ---- bboxLooksLonLat / formatValue ----
    { id: "bbox-denver-ok", call: "GeoPackage.bboxLooksLonLat", args: [[-105.007, 39.747, -104.993, 39.757]] },
    { id: "bbox-state-plane-rejected", call: "GeoPackage.bboxLooksLonLat", args: [[3140000, 1690000, 3150000, 1700000]] },
    { id: "format-float-rounded", call: "GeoPackage.formatValue", args: [39.78539575832313] },
    { id: "format-integer", call: "GeoPackage.formatValue", args: [1047066333] },
    { id: "format-null-empty", call: "GeoPackage.formatValue", args: [null] },
    { id: "format-text", call: "GeoPackage.formatValue", args: ["way/1/segment/0"] },
  ],
};
