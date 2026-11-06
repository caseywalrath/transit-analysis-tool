#!/usr/bin/env python3
"""Build test/fixtures/sample.gpkg, a small deterministic GeoPackage.

Run with `python3 -I test/fixtures/make-gpkg-fixture.py`. The file is deleted and
rewritten next to this script, and the output is byte-identical on every run.

Tables and the rule each one exercises (see "Reading a GeoPackage" and
"Projection resolution" in docs/gpkg-import-plan.md):

  gpkg_spatial_ref_sys   SRS lookup for every srs_id used below (4326, 26913, -1, 0, 999001).
  gpkg_contents          Layer list: 'features', 'attributes' and 'tiles' data types.
  gpkg_geometry_columns  Geometry column per feature table.
  pts_utm                UTM points (projection rule 3); BOOLEAN, JSON-text, NULL attributes.
  lines_wgs              WGS 84 lines (rule 1); one little-endian and one big-endian blob.
  polys_utm              MultiPolygon column holding a Polygon with a hole and a MultiPolygon;
                         envelope type 1 (GeoPackage order minx, maxx, miny, maxy).
  mixed_z                Point with Z plus a LineString in a GEOMETRY column (Z flag handling).
  empty_geom             Empty-flagged point with NaN coordinates, plus a NULL geometry.
  weird_srs              srs 999001 with a non-WKT definition (projection rule 4, unknown).
  undef_ok               srs -1 with lon/lat coordinates (rule 5, accepted as lon/lat).
  undef_bad              srs 0 with projected coordinates (rule 5, rejected).
  notes                  'attributes' data type: listed in gpkg_contents but not a feature layer.
  tiles_tbl              'tiles' data type with no backing table: must be listed as unsupported.
"""

import os
import sqlite3
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'sample.gpkg')


def wkb_point(x, y, le=True, z=None):
    bo = '<' if le else '>'
    if z is None:
        return struct.pack(bo + 'BIdd', 1 if le else 0, 1, x, y)
    return struct.pack(bo + 'BIddd', 1 if le else 0, 1001, x, y, z)


def wkb_line(coords, le=True):
    bo = '<' if le else '>'
    b = struct.pack(bo + 'BII', 1 if le else 0, 2, len(coords))
    for x, y in coords:
        b += struct.pack(bo + 'dd', x, y)
    return b


def wkb_polygon(rings, le=True):
    bo = '<' if le else '>'
    b = struct.pack(bo + 'BII', 1 if le else 0, 3, len(rings))
    for ring in rings:
        b += struct.pack(bo + 'I', len(ring))
        for x, y in ring:
            b += struct.pack(bo + 'dd', x, y)
    return b


def wkb_multipolygon(polys, le=True):
    bo = '<' if le else '>'
    b = struct.pack(bo + 'BII', 1 if le else 0, 6, len(polys))
    for rings in polys:
        b += wkb_polygon(rings, le)
    return b


def gp_blob(wkb, env_type=0, envelope=(), empty=False, le=True):
    flags = (1 if le else 0) | (env_type << 1) | (16 if empty else 0)
    bo = '<' if le else '>'
    return b'GP' + bytes([0, flags]) + struct.pack(bo + 'i', 0) + \
        b''.join(struct.pack(bo + 'd', v) for v in envelope) + wkb


def square(minx, maxx, miny, maxy):
    return [(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy), (minx, miny)]


def bounds(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def add_feature_layer(conn, table, srs_id, geom_type, z, m, columns, rows, envelope):
    col_defs = ''.join(', ' + c for c in columns)
    conn.execute('CREATE TABLE ' + table + ' (fid INTEGER PRIMARY KEY, geom BLOB' + col_defs + ')')
    placeholders = ', '.join(['?'] * (2 + len(columns)))
    for row in rows:
        conn.execute('INSERT INTO ' + table + ' VALUES (' + placeholders + ')', row)
    conn.execute(
        'INSERT INTO gpkg_contents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (table, 'features', table, '', '2026-01-01T00:00:00Z',
         envelope[0] if envelope else None, envelope[1] if envelope else None,
         envelope[2] if envelope else None, envelope[3] if envelope else None, srs_id))
    conn.execute(
        'INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, ?, ?)',
        (table, 'geom', geom_type, srs_id, z, m))


def build(path):
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    # Small pages keep the fixture under 50 KB; the page size must be set before the first table exists.
    conn.execute('PRAGMA page_size = 1024')
    conn.execute('PRAGMA application_id = 0x47504B47')
    conn.execute('PRAGMA user_version = 10300')

    conn.execute('CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, '
                 'organization TEXT, organization_coordsys_id INTEGER, definition TEXT, description TEXT)')
    conn.execute('CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, '
                 'identifier TEXT, description TEXT, last_change TEXT, min_x REAL, min_y REAL, '
                 'max_x REAL, max_y REAL, srs_id INTEGER)')
    conn.execute('CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, '
                 'geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER)')

    srs_rows = [
        ('WGS 84', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84"]', ''),
        ('NAD83 / UTM zone 13N', 26913, 'EPSG', 26913, 'PROJCS["NAD83 / UTM zone 13N"]', ''),
        ('Undefined geographic SRS', -1, 'NONE', -1, 'undefined', ''),
        ('Undefined cartesian SRS', 0, 'NONE', 0, 'undefined', ''),
        ('Not a real SRS', 999001, 'NONE', 999001, 'NOT A REAL WKT', ''),
    ]
    conn.executemany('INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)', srs_rows)

    # pts_utm: UTM points; flag is BOOLEAN, info holds JSON text, note is NULL on one row.
    pts = [(500000.0, 4400000.0), (501000.0, 4400000.0), (500000.0, 4401000.0)]
    add_feature_layer(
        conn, 'pts_utm', 26913, 'POINT', 0, 0,
        ['name TEXT', 'flag BOOLEAN', 'info TEXT', 'note TEXT'],
        [
            (1, gp_blob(wkb_point(500000.0, 4400000.0)), 'center', 1, '{"a":1,"b":[2,3]}', None),
            (2, gp_blob(wkb_point(501000.0, 4400000.0)), 'east', 0, 'plain', 'n'),
            (3, gp_blob(wkb_point(500000.0, 4401000.0)), 'north', 1, None, 'n'),
        ],
        bounds(pts))

    # lines_wgs: one little-endian and one big-endian blob.
    line1 = [(-105.0, 39.7), (-104.9, 39.8)]
    line2 = [(-105.1, 39.6), (-105.0, 39.65), (-104.95, 39.7)]
    add_feature_layer(
        conn, 'lines_wgs', 4326, 'LINESTRING', 0, 0,
        ['label TEXT'],
        [
            (1, gp_blob(wkb_line(line1, le=True), le=True), 'le'),
            (2, gp_blob(wkb_line(line2, le=False), le=False), 'be'),
        ],
        bounds(line1 + line2))

    # polys_utm: row 1 a Polygon with a hole, row 2 a MultiPolygon of two squares.
    # Envelopes use GeoPackage order (minx, maxx, miny, maxy) and envelope type 1.
    poly_outer = square(499000.0, 501000.0, 4399000.0, 4401000.0)
    poly_hole = square(499500.0, 500500.0, 4399500.0, 4400500.0)
    multi_a = square(502000.0, 502500.0, 4399000.0, 4399500.0)
    multi_b = square(503000.0, 503500.0, 4399000.0, 4399500.0)
    all_poly_pts = poly_outer + poly_hole + multi_a + multi_b
    add_feature_layer(
        conn, 'polys_utm', 26913, 'MULTIPOLYGON', 0, 0,
        ['label TEXT'],
        [
            (1, gp_blob(wkb_polygon([poly_outer, poly_hole]), env_type=1,
                        envelope=(499000.0, 501000.0, 4399000.0, 4401000.0)), 'holed'),
            (2, gp_blob(wkb_multipolygon([[multi_a], [multi_b]]), env_type=1,
                        envelope=(502000.0, 503500.0, 4399000.0, 4399500.0)), 'two'),
        ],
        bounds(all_poly_pts))

    # mixed_z: a Point with Z and a LineString in one GEOMETRY column.
    mixed_line = [(-105.0, 39.75), (-104.99, 39.76)]
    add_feature_layer(
        conn, 'mixed_z', 4326, 'GEOMETRY', 2, 0,
        ['label TEXT'],
        [
            (1, gp_blob(wkb_point(-105.0, 39.75, z=1600.0)), 'pointz'),
            (2, gp_blob(wkb_line(mixed_line)), 'line'),
        ],
        bounds([(-105.0, 39.75)] + mixed_line))

    # empty_geom: an empty-flagged point with NaN coordinates, and a NULL geometry.
    nan = float('nan')
    add_feature_layer(
        conn, 'empty_geom', 4326, 'POINT', 0, 0,
        ['label TEXT'],
        [
            (1, gp_blob(wkb_point(nan, nan), empty=True), 'empty'),
            (2, None, 'null'),
        ],
        None)

    # weird_srs: srs 999001 with a non-WKT definition.
    add_feature_layer(
        conn, 'weird_srs', 999001, 'POINT', 0, 0,
        ['label TEXT'],
        [(1, gp_blob(wkb_point(1.0, 2.0)), 'odd')],
        (1.0, 2.0, 1.0, 2.0))

    # undef_ok: undefined SRS (-1) with lon/lat coordinates.
    add_feature_layer(
        conn, 'undef_ok', -1, 'POINT', 0, 0,
        ['label TEXT'],
        [(1, gp_blob(wkb_point(-105.0, 39.75)), 'lonlat')],
        (-105.0, 39.75, -105.0, 39.75))

    # undef_bad: undefined SRS (0) with projected coordinates.
    add_feature_layer(
        conn, 'undef_bad', 0, 'POINT', 0, 0,
        ['label TEXT'],
        [(1, gp_blob(wkb_point(500000.0, 4400000.0)), 'projected')],
        (500000.0, 4400000.0, 500000.0, 4400000.0))

    # notes: an attribute-only table, listed in gpkg_contents but not a feature layer.
    conn.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)')
    conn.execute('INSERT INTO notes VALUES (1, ?)', ('fixture notes',))
    conn.execute('INSERT INTO gpkg_contents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                 ('notes', 'attributes', 'notes', '', '2026-01-01T00:00:00Z',
                  None, None, None, None, None))

    # tiles_tbl: a tiles entry with no backing table.
    conn.execute('INSERT INTO gpkg_contents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                 ('tiles_tbl', 'tiles', 'tiles_tbl', '', '2026-01-01T00:00:00Z',
                  None, None, None, None, None))

    conn.commit()
    conn.execute('VACUUM')
    conn.close()


if __name__ == '__main__':
    build(OUT)
    print('wrote ' + OUT)
