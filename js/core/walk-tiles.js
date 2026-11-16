// js/core/walk-tiles.js
// Pure reader for FLM walk tiles, contract walk-tiles v0 (window.WalkTiles).
// Validates the release manifest, picks the tiles that cover a set of grid
// cells, merges their segment records and converts the result into the
// LineString FeatureCollection that the road-network builder accepts.
// CONSTRAINT: plain-value code only (no geometry library, no DOM, no network
// calls, no app state) so the golden harness can load it into a bare vm
// sandbox. Nothing here throws on bad input; failures come back as
// { ok: false, error } or as null / [] results.
// Cell arithmetic uses scaled integers (1e7 per degree) rather than raw
// floating-point division, so a coordinate exactly on a cell edge lands in
// the cell the contract names. Detail: docs/reference/road-network.md, "FLM walk tiles".

(function () {
  "use strict";

  var CELL_DEG = 0.01;
  var MAX_COL = 35999;
  var MAX_ROW = 17999;
  var SCALE = 1e7;        // contract coordinate_scale: seven decimal places
  var CELL_SCALED = 1e5;  // one cell in scaled units

  // Contract order of the eleven segment fields. Canonical text (used to
  // compare copies) is built in this order, so key order in a file never
  // makes two identical copies look different.
  var SEGMENT_KEYS = [
    "id", "from", "to", "len_ft", "dir", "coords",
    "way_id", "hwy", "name", "sidewalk", "footway"
  ];

  function reject(message) {
    return { ok: false, error: message };
  }

  function isNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  function isPlainObject(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x);
  }

  function hasOwn(o, key) {
    return Object.prototype.hasOwnProperty.call(o, key);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function cellKey(col, row) {
    return col + "_" + row;
  }

  // Cell index of a west or south edge value. A value that is an exact
  // multiple of one cell lies on the boundary, and the contract's cells are
  // closed, so the cell below also takes the segment: the index drops by one
  // unless it is already 0. `origin` is -180 for longitude and -90 for latitude.
  function lowIndex(deg, origin) {
    var scaled = Math.round((deg - origin) * SCALE);
    var idx = Math.floor(scaled / CELL_SCALED);
    if (scaled % CELL_SCALED === 0 && idx > 0) idx = idx - 1;
    return idx;
  }

  // Cell index of an east or north edge value. Floor already lands in the
  // cell beyond an exact edge, and the loop covers every index from the
  // minimum to the maximum, so no adjustment is needed here.
  function highIndex(deg, origin) {
    return Math.floor(Math.round((deg - origin) * SCALE) / CELL_SCALED);
  }

  function cellOf(lon, lat) {
    if (!isNum(lon) || !isNum(lat)) return null;
    var col = Math.floor(Math.round((lon + 180) * SCALE) / CELL_SCALED);
    var row = Math.floor(Math.round((lat + 90) * SCALE) / CELL_SCALED);
    return { col: clamp(col, 0, MAX_COL), row: clamp(row, 0, MAX_ROW) };
  }

  function cellsForBbox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return [];
    for (var k = 0; k < 4; k++) {
      if (!isNum(bbox[k])) return [];
    }
    var w = bbox[0];
    var s = bbox[1];
    var e = bbox[2];
    var n = bbox[3];
    if (w > e || s > n) return [];
    var c0 = clamp(lowIndex(w, -180), 0, MAX_COL);
    var c1 = clamp(highIndex(e, -180), 0, MAX_COL);
    var r0 = clamp(lowIndex(s, -90), 0, MAX_ROW);
    var r1 = clamp(highIndex(n, -90), 0, MAX_ROW);
    var out = [];
    for (var col = c0; col <= c1; col++) {
      for (var row = r0; row <= r1; row++) {
        out.push({ col: col, row: row });
      }
    }
    return out;
  }

  function bboxOfCells(cells) {
    if (!Array.isArray(cells) || cells.length === 0) return null;
    // Limits start unset (null), not at Infinity, so the first valid cell
    // seeds them. A cell that is not a usable { col, row } makes the whole
    // result null rather than a box built from partial input.
    var minCol = null;
    var maxCol = null;
    var minRow = null;
    var maxRow = null;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!isPlainObject(c) || !isNum(c.col) || !isNum(c.row)) return null;
      if (minCol === null || c.col < minCol) minCol = c.col;
      if (maxCol === null || c.col > maxCol) maxCol = c.col;
      if (minRow === null || c.row < minRow) minRow = c.row;
      if (maxRow === null || c.row > maxRow) maxRow = c.row;
    }
    // 180 and 90 degrees in scaled units, written out so the formula reads
    // as the contract states it (cell corner = index * 100000 - offset).
    return [
      (minCol * CELL_SCALED - 1800000000) / SCALE,
      (minRow * CELL_SCALED - 900000000) / SCALE,
      ((maxCol + 1) * CELL_SCALED - 1800000000) / SCALE,
      ((maxRow + 1) * CELL_SCALED - 900000000) / SCALE
    ];
  }

  // Cells touched by any of several boxes, each cell once. Sorted so the same
  // set of points always yields the same list, which keeps stored records and
  // golden values stable. A box that is not usable adds no cells.
  function cellsForBboxes(bboxes) {
    if (!Array.isArray(bboxes)) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < bboxes.length; i++) {
      var cells = cellsForBbox(bboxes[i]);
      for (var j = 0; j < cells.length; j++) {
        var key = cellKey(cells[j].col, cells[j].row);
        if (seen[key] === true) continue;
        seen[key] = true;
        out.push(cells[j]);
      }
    }
    out.sort(function (a, b) { return (a.col - b.col) || (a.row - b.row); });
    return out;
  }

  // One rectangle of whole cells per box, in first-seen order. Two points
  // whose boxes fall in the same cells give one rectangle, not two copies,
  // so the map outline never draws the same box twice.
  function cellRectsForBboxes(bboxes) {
    if (!Array.isArray(bboxes)) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < bboxes.length; i++) {
      var cells = cellsForBbox(bboxes[i]);
      if (cells.length === 0) continue;
      var rect = bboxOfCells(cells);
      if (!rect) continue;
      var id = rect.join(",");
      if (seen[id] === true) continue;
      seen[id] = true;
      out.push(rect);
    }
    return out;
  }

  // The "col_row" keys of a cell list, in the given order. These are the
  // keys stored with a tile load, so the answer to "is this cell loaded"
  // never depends on how the cells were produced.
  function cellKeys(cells) {
    if (!Array.isArray(cells)) return [];
    var out = [];
    for (var i = 0; i < cells.length; i++) {
      if (isPlainObject(cells[i])) out.push(cellKey(cells[i].col, cells[i].row));
    }
    return out;
  }

  function validBbox(b) {
    if (!Array.isArray(b) || b.length !== 4) return false;
    for (var k = 0; k < 4; k++) {
      if (!isNum(b[k])) return false;
    }
    return b[0] <= b[2] && b[1] <= b[3];
  }

  function validTileEntry(t) {
    if (!isPlainObject(t)) return false;
    if (!Number.isSafeInteger(t.col) || t.col < 0 || t.col > MAX_COL) return false;
    if (!Number.isSafeInteger(t.row) || t.row < 0 || t.row > MAX_ROW) return false;
    return t.path === "network/" + t.col + "_" + t.row + ".json";
  }

  function allStrings(list) {
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== "string") return false;
    }
    return true;
  }

  // Checks run in the contract's order and stop at the first failure, so the
  // error text always names the field a reader should look at first. Unknown
  // extra fields are deliberately accepted: the tool reads only what it needs.
  function validateManifest(obj) {
    if (!isPlainObject(obj)) return reject("manifest: not an object");
    if (obj.format !== "walk-tiles") return reject('format: expected "walk-tiles"');
    if (obj.version !== 0) return reject("version: expected 0");
    if (typeof obj.release_id !== "string" || obj.release_id === "") {
      return reject("release_id: missing");
    }
    if (!isPlainObject(obj.grid) || obj.grid.cell_size_degrees !== CELL_DEG) {
      return reject("grid.cell_size_degrees: expected 0.01");
    }
    if (!isPlainObject(obj.coverage) || !validBbox(obj.coverage.bbox)) {
      return reject("coverage.bbox: expected [west, south, east, north]");
    }
    if (!Array.isArray(obj.tiles) || obj.tiles.length === 0) {
      return reject("tiles: expected a non-empty list");
    }
    for (var i = 0; i < obj.tiles.length; i++) {
      if (!validTileEntry(obj.tiles[i])) return reject("tiles[" + i + "]: invalid entry");
    }
    if (typeof obj.attribution !== "string" || obj.attribution === "") {
      return reject("attribution: missing");
    }
    if (!Array.isArray(obj.limitations) || !allStrings(obj.limitations)) {
      return reject("limitations: expected a list of strings");
    }
    return { ok: true, manifest: obj };
  }

  // Manifest entries whose cell is in `cells`. The lookup is built once from
  // the requested cells, so the manifest is walked a single time.
  function tilesForCells(manifest, cells) {
    if (!isPlainObject(manifest) || !Array.isArray(manifest.tiles) || !Array.isArray(cells)) {
      return [];
    }
    // Null-prototype objects: a plain {} would answer true for keys such as
    // "constructor" and could match a cell that was never requested.
    var wanted = Object.create(null);
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (isPlainObject(c)) wanted[cellKey(c.col, c.row)] = true;
    }
    var out = [];
    for (var t = 0; t < manifest.tiles.length; t++) {
      var tile = manifest.tiles[t];
      if (isPlainObject(tile) && wanted[cellKey(tile.col, tile.row)] === true) {
        out.push(tile);
      }
    }
    return out;
  }

  function validCoords(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return false;
    for (var i = 0; i < coords.length; i++) {
      var p = coords[i];
      if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) return false;
    }
    return true;
  }

  // Returns an error text for one segment record, or null when it is valid.
  // Every record is checked before dedupe, so a bad copy is never hidden
  // behind a good one with the same id.
  function segmentProblem(rec) {
    if (!isPlainObject(rec)) return "segment ?: not an object";
    var label = typeof rec.id === "string" ? rec.id : "?";
    for (var k = 0; k < SEGMENT_KEYS.length; k++) {
      if (!hasOwn(rec, SEGMENT_KEYS[k])) {
        return "segment " + label + ": missing " + SEGMENT_KEYS[k];
      }
    }
    if (typeof rec.id !== "string" || rec.id === "") return "segment ?: missing id";
    if (!isNum(rec.len_ft) || rec.len_ft <= 0) return "segment " + rec.id + ": invalid len_ft";
    if (!(rec.dir === "both" || rec.dir === "forward" || rec.dir === "reverse")) {
      return "segment " + rec.id + ": invalid dir";
    }
    if (!validCoords(rec.coords)) return "segment " + rec.id + ": invalid coords";
    return null;
  }

  // Canonical text of a record: the eleven fields in contract order. Two
  // copies agree when these strings are equal.
  function canonicalText(rec) {
    var o = {};
    for (var k = 0; k < SEGMENT_KEYS.length; k++) {
      o[SEGMENT_KEYS[k]] = rec[SEGMENT_KEYS[k]];
    }
    return JSON.stringify(o);
  }

  // Segments are kept whole, so a line can extend past its own tile; the
  // merge never clips or re-cuts geometry.
  function mergeTiles(tileObjects) {
    if (!Array.isArray(tileObjects)) return reject("tiles: expected a list");
    var segments = [];
    // id -> first copy seen. Canonical text is built only when an id repeats
    // (segments crossing a cell edge), not for every record of a large load.
    var seen = Object.create(null);
    var copies = 0;
    for (var t = 0; t < tileObjects.length; t++) {
      var tile = tileObjects[t];
      if (!isPlainObject(tile) || !Array.isArray(tile.segments)) {
        return reject("tile " + t + ": no segments list");
      }
      for (var s = 0; s < tile.segments.length; s++) {
        var rec = tile.segments[s];
        copies++;
        var problem = segmentProblem(rec);
        if (problem) return reject(problem);
        var first = seen[rec.id];
        if (first) {
          if (canonicalText(first) !== canonicalText(rec)) {
            return reject("conflicting copies of segment " + rec.id);
          }
        } else {
          seen[rec.id] = rec;
          segments.push(rec);
        }
      }
    }
    return { ok: true, segments: segments, copies: copies };
  }

  // The street-exclusion feature compares numeric way ids with Set.has, and
  // the Overpass path always supplies numbers, so a safe-integer id is stored
  // as a number. Anything else keeps its original text.
  function wayIdOf(wayId) {
    if (/^[0-9]+$/.test(wayId)) {
      var n = Number(wayId);
      if (Number.isSafeInteger(n)) return n;
    }
    return wayId;
  }

  function toRoadGeoJSON(segments) {
    var features = [];
    if (!Array.isArray(segments)) return { type: "FeatureCollection", features: features };
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      // Only records that passed mergeTiles are expected here. Skipping a
      // non-object keeps the "never throws" rule for stray input.
      if (!isPlainObject(seg)) continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: seg.coords },
        properties: {
          highway: seg.hwy,
          // The FLM rules already decided walkability. Without this, the
          // road-network builder would block a trunk or motorway segment that
          // FLM accepted.
          foot: "yes",
          name: seg.name,
          sidewalk: seg.sidewalk,
          footway: seg.footway,
          wayId: wayIdOf(seg.way_id),
          flmId: seg.id,
          lenFt: seg.len_ft,
          dir: seg.dir
        }
      });
    }
    return { type: "FeatureCollection", features: features };
  }

  window.WalkTiles = {
    CELL_DEG: CELL_DEG,
    cellOf: cellOf,
    cellsForBbox: cellsForBbox,
    bboxOfCells: bboxOfCells,
    cellsForBboxes: cellsForBboxes,
    cellRectsForBboxes: cellRectsForBboxes,
    cellKeys: cellKeys,
    validateManifest: validateManifest,
    tilesForCells: tilesForCells,
    mergeTiles: mergeTiles,
    toRoadGeoJSON: toRoadGeoJSON
  };

})();
