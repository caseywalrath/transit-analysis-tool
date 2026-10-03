// js/core/box-select.js
// Box select (drag a rectangle on the map to select features) —
// docs/archive/box-select-plan.md. Phase 1: pure hit-test helpers only. Phase 2 adds
// the drag tool to this same file.
//
// ---- Pure helpers (App.boxSelectGeom) ----
// No DOM, map, or turf access (so the golden harness loads this file as-is).
// Everything is in SCREEN-PIXEL coordinates: points are [x, y], a rect is
// {minX, minY, maxX, maxY}, a bbox has the same shape. Rect edges are inclusive.
// mode is "touch" (any part of the feature meets the box) or "within"
// (the whole feature is inside the box).

(function () {
  var App = window.App = window.App || {};

  function normRect(x0, y0, x1, y1) {
    return {
      minX: Math.min(x0, x1), minY: Math.min(y0, y1),
      maxX: Math.max(x0, x1), maxY: Math.max(y0, y1)
    };
  }

  function pointInRect(p, r) {
    return p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minY && p[1] <= r.maxY;
  }

  // Liang-Barsky clip: does any part of segment a-b lie in or touch r?
  // A zero-length segment degenerates to a point test.
  function segmentIntersectsRect(a, b, r) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return pointInRect(a, r);
    var t0 = 0, t1 = 1;
    var p = [-dx, dx, -dy, dy];
    var q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minY, r.maxY - a[1]];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false; // parallel to this edge and outside it
      } else {
        var t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else          { if (t < t0) return false; if (t < t1) t1 = t; }
      }
    }
    return t0 <= t1;
  }

  // Even-odd ray casting. The ring may or may not repeat its first vertex
  // (a repeated closing vertex adds a zero-length edge, which is harmless).
  function pointInRing(p, ring) {
    var inside = false, x = p[0], y = p[1];
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function bboxOf(pts) {
    if (!pts || !pts.length) return null;
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p[0] < b.minX) b.minX = p[0];
      if (p[0] > b.maxX) b.maxX = p[0];
      if (p[1] < b.minY) b.minY = p[1];
      if (p[1] > b.maxY) b.maxY = p[1];
    }
    return b;
  }

  // Quick pre-filter: can a feature with this bbox possibly touch r?
  function bboxIntersectsRect(bbox, r) {
    if (!bbox) return false;
    return bbox.minX <= r.maxX && bbox.maxX >= r.minX && bbox.minY <= r.maxY && bbox.maxY >= r.minY;
  }

  function lineHits(pts, r, mode) {
    if (!pts || !pts.length) return false;
    var i;
    if (mode === "within") {
      for (i = 0; i < pts.length; i++) if (!pointInRect(pts[i], r)) return false;
      return true;
    }
    for (i = 0; i < pts.length; i++) if (pointInRect(pts[i], r)) return true;
    for (i = 0; i < pts.length - 1; i++) if (segmentIntersectsRect(pts[i], pts[i + 1], r)) return true;
    return false;
  }

  // rings[0] = outer ring, rest = holes.
  function polygonHits(rings, r, mode) {
    if (!rings || !rings.length || !rings[0].length) return false;
    var outer = rings[0], i, k;
    if (mode === "within") {
      for (i = 0; i < outer.length; i++) if (!pointInRect(outer[i], r)) return false;
      return true;
    }
    // Touch: any ring edge/vertex meets the box (an edge test also closes
    // each ring, in case it does not repeat its first vertex).
    for (k = 0; k < rings.length; k++) {
      var ring = rings[k];
      for (i = 0; i < ring.length; i++) {
        if (pointInRect(ring[i], r)) return true;
        if (segmentIntersectsRect(ring[i], ring[(i + 1) % ring.length], r)) return true;
      }
    }
    // No edge touches: the box is either wholly inside the polygon or wholly
    // outside it (or inside a hole). Test the box centre.
    var c = [(r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2];
    if (!pointInRing(c, outer)) return false;
    for (k = 1; k < rings.length; k++) if (pointInRing(c, rings[k])) return false;
    return true;
  }

  App.boxSelectGeom = {
    normRect: normRect,
    pointInRect: pointInRect,
    segmentIntersectsRect: segmentIntersectsRect,
    pointInRing: pointInRing,
    bboxOf: bboxOf,
    bboxIntersectsRect: bboxIntersectsRect,
    lineHits: lineHits,
    polygonHits: polygonHits
  };

  // ---- Drag tool (Phase 2) ----
  // Active while App.drawMode === "box-select" (toolbar button / A key, wired by
  // the generic tool-button handler in app.js). Mouse events are intercepted on
  // window in the CAPTURE phase, so MapLibre never sees the mousedown: the map
  // does not pan, and there is no dragPan state to restore on exit. Wheel zoom
  // still works. Modifiers are read at release: Shift = add, Ctrl/Cmd = remove,
  // Alt = fully inside (default: touches). A drag under 4 px acts as a click.

  var MODE = "box-select";
  var CLICK_PX = 4;
  var _drag = null; // { x0, y0, x1, y1, rectEl, badgeEl, cache, raf }

  function isActive() { return App.drawMode === MODE; }

  function inMap(e) {
    var c = App.map && App.map.getCanvasContainer();
    return !!(c && e.target && c.contains(e.target));
  }

  // Map-container-relative pixel position of a mouse event.
  function localXY(e) {
    var r = App.map.getCanvasContainer().getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // Project every visible drawn feature to screen pixels once per drag (the
  // map cannot move during a drag, since its mousedown never arrives).
  function buildCache() {
    var map = App.map, out = [];
    function proj(c) { var p = map.project(c); return [p.x, p.y]; }
    function add(type, arr, fn) {
      (arr || []).forEach(function (f, i) {
        if (!f || !f.geometry || (f.properties && f.properties.hidden)) return;
        var shape = fn(f.geometry);
        if (shape) out.push({ type: type, index: i, kind: shape.kind, parts: shape.parts, bbox: shape.bbox });
      });
    }
    function lineShape(g) {
      var lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : null;
      if (!lines) return null;
      var parts = lines.map(function (l) { return l.map(proj); });
      return { kind: "line", parts: parts, bbox: bboxOf([].concat.apply([], parts)) };
    }
    function polyShape(g) {
      var polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
      if (!polys) return null;
      var parts = polys.map(function (rings) { return rings.map(function (r) { return r.map(proj); }); });
      var all = [];
      parts.forEach(function (rings) { all = all.concat(rings[0] || []); });
      return { kind: "polygon", parts: parts, bbox: bboxOf(all) };
    }
    add("point", App.points, function (g) {
      if (g.type !== "Point") return null;
      var p = proj(g.coordinates);
      return { kind: "point", parts: p, bbox: { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] } };
    });
    add("line", App.lines, lineShape);
    add("route", App.routes, lineShape);
    add("polygon", App.polygons, polyShape);
    return out;
  }

  // Features of the cache hit by rect r. For multi-part shapes, "touch" needs
  // any part to touch and "within" needs every part within.
  function hitTest(cache, r, mode) {
    return cache.filter(function (c) {
      if (!bboxIntersectsRect(c.bbox, r)) return false;
      if (c.kind === "point") return pointInRect(c.parts, r);
      var test = c.kind === "line" ? lineHits : polygonHits;
      return mode === "within"
        ? c.parts.every(function (p) { return test(p, r, "within"); })
        : c.parts.some(function (p) { return test(p, r, "touch"); });
    }).map(function (c) { return { type: c.type, index: c.index }; });
  }

  // Combine the hits with the current selection: "replace" | "add" | "remove".
  function combine(hits, op) {
    var cur = typeof App.getSelectedFeatures === "function" ? App.getSelectedFeatures() : [];
    function key(s) { return s.type + ":" + s.index; }
    if (op === "replace") return hits;
    var hitKeys = {};
    hits.forEach(function (h) { hitKeys[key(h)] = true; });
    if (op === "remove") return cur.filter(function (s) { return !hitKeys[key(s)]; });
    return cur.concat(hits.filter(function (h) {
      return !cur.some(function (s) { return key(s) === key(h); });
    }));
  }

  function currentRect() {
    return normRect(_drag.x0, _drag.y0, _drag.x1, _drag.y1);
  }

  function isClick() {
    return Math.abs(_drag.x1 - _drag.x0) < CLICK_PX && Math.abs(_drag.y1 - _drag.y0) < CLICK_PX;
  }

  function drawFeedback(altKey) {
    _drag.raf = 0;
    if (!_drag) return;
    var r = currentRect(), small = isClick();
    var s = _drag.rectEl.style;
    s.display = small ? "none" : "block";
    s.left = r.minX + "px"; s.top = r.minY + "px";
    s.width = (r.maxX - r.minX) + "px"; s.height = (r.maxY - r.minY) + "px";
    _drag.rectEl.classList.toggle("box-select-within", !!altKey);
    var b = _drag.badgeEl;
    if (small) { b.style.display = "none"; return; }
    var n = hitTest(_drag.cache, r, altKey ? "within" : "touch").length;
    b.textContent = n + (n === 1 ? " feature" : " features") + (altKey ? " (fully inside)" : "");
    b.style.display = "block";
    b.style.left = (_drag.x1 + 14) + "px";
    b.style.top = (_drag.y1 + 14) + "px";
  }

  function scheduleFeedback(altKey) {
    if (!_drag || _drag.raf) return;
    _drag.raf = requestAnimationFrame(function () { if (_drag) drawFeedback(altKey); });
  }

  function endDrag() {
    if (!_drag) return;
    if (_drag.raf) cancelAnimationFrame(_drag.raf);
    if (_drag.rectEl.parentNode) _drag.rectEl.parentNode.removeChild(_drag.rectEl);
    if (_drag.badgeEl.parentNode) _drag.badgeEl.parentNode.removeChild(_drag.badgeEl);
    _drag = null;
  }

  // Phase 4: Shift+drag starts a box even with the tool off (no other draw
  // mode active). MapLibre's own Shift+drag box zoom is disabled in map.js.
  function shiftStart(e) {
    return e.shiftKey && !App.drawMode;
  }

  function onMouseDown(e) {
    if (!inMap(e) || e.button !== 0) return; // right-click falls through to the map's contextmenu
    var viaShift = !isActive() && shiftStart(e);
    if (!isActive() && !viaShift) return;
    // This handler stops the event before the context menu's own outside-press
    // listener can see it, so close any open menu here.
    if (typeof App.closeContextMenu === "function") App.closeContextMenu();
    e.preventDefault();
    e.stopPropagation();
    endDrag();
    var p = localXY(e), container = App.map.getCanvasContainer();
    var rectEl = document.createElement("div");
    rectEl.className = "box-select-rect";
    rectEl.style.display = "none";
    var badgeEl = document.createElement("div");
    badgeEl.className = "box-select-badge";
    badgeEl.style.display = "none";
    container.appendChild(rectEl);
    container.appendChild(badgeEl);
    _drag = { x0: p[0], y0: p[1], x1: p[0], y1: p[1], rectEl: rectEl, badgeEl: badgeEl,
              cache: buildCache(), raf: 0, viaShift: viaShift };
  }

  function onMouseMove(e) {
    if (!_drag) return;
    e.stopPropagation();
    var p = localXY(e);
    _drag.x1 = p[0]; _drag.y1 = p[1];
    scheduleFeedback(e.altKey);
  }

  function onMouseUp(e) {
    if (!_drag) return;
    e.preventDefault();
    e.stopPropagation();
    var p = localXY(e);
    _drag.x1 = p[0]; _drag.y1 = p[1];
    // A Shift+drag started with the tool off: Shift was the trigger, so it
    // replaces (Ctrl still removes).
    var op = (e.ctrlKey || e.metaKey) ? "remove" : (e.shiftKey && !_drag.viaShift) ? "add" : "replace";
    if (_drag.viaShift) _swallowNextClick = true;
    var mode = e.altKey ? "within" : "touch";
    var r;
    if (isClick()) {
      // A click: whatever touches a small box around the cursor. Points win
      // over lines/polygons beneath them, matching a normal map click.
      var pad = 3;
      r = normRect(_drag.x1 - pad, _drag.y1 - pad, _drag.x1 + pad, _drag.y1 + pad);
      var under = hitTest(_drag.cache, r, "touch");
      var pts = under.filter(function (h) { return h.type === "point"; });
      var hits = (pts.length ? pts : under).slice(-1); // topmost = drawn last
      apply(hits, op, true);
    } else {
      apply(hitTest(_drag.cache, currentRect(), mode), op, false);
    }
    endDrag();
  }

  function apply(hits, op, wasClick) {
    var next = combine(hits, op);
    if (typeof App.setSelection === "function") App.setSelection(next);
    var n = next.length;
    App.setStatus(wasClick && !hits.length && op === "replace"
      ? "Selection cleared"
      : (n ? "Selected " + n + (n === 1 ? " feature" : " features") : "Nothing selected"));
  }

  // While the tool is on, the map gets no click/dblclick either (dblclick
  // would zoom; click would run draw-mode handlers).
  var _swallowNextClick = false;
  function swallow(e) {
    if (!inMap(e)) return;
    if (e.type === "click" && _swallowNextClick) {
      _swallowNextClick = false;
      e.stopPropagation(); e.preventDefault();
      return;
    }
    if (isActive()) { e.stopPropagation(); e.preventDefault(); }
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    if (_drag) { endDrag(); e.stopImmediatePropagation(); App.setStatus("Box select mode"); return; }
    if (isActive()) {
      e.stopImmediatePropagation();
      if (typeof App.exitDrawMode === "function") App.exitDrawMode();
      App.setStatus("Ready");
    }
  }

  // Guarded: the golden-test sandbox loads this file with no real window.
  if (typeof window.addEventListener === "function") {
  window.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("click", swallow, true);
  window.addEventListener("dblclick", swallow, true);
  window.addEventListener("keydown", onKeyDown, true);
  // If the tool is switched off mid-drag (shortcut key, another tool), drop the box.
  window.addEventListener("blur", endDrag);
  }

  // ---- Group actions on a multi-selection (Phase 3): App.bulkFeatures ----
  // Shared by the map right-click menu (editing.js), the Features-pane
  // right-click menu (features.js) and the Delete key (app.js). `list` is
  // [{type, index}]; labels and anything stale are ignored.

  var ARRAYS = { point: "points", line: "lines", route: "routes", polygon: "polygons" };
  var REMOVE = { point: "removePoint", line: "removeLine", route: "removeRoute", polygon: "removePolygon" };
  var NOUN = { point: ["point", "points"], line: ["line", "lines"], route: ["route", "routes"], polygon: ["polygon", "polygons"] };

  function featureOf(s) {
    var arr = ARRAYS[s.type] && App[ARRAYS[s.type]];
    return arr && s.index >= 0 && s.index < arr.length ? arr[s.index] : null;
  }

  function usable(list) {
    return (list || []).filter(function (s) { return !!featureOf(s); });
  }

  function typesOf(list) {
    var t = {};
    list.forEach(function (s) { t[s.type] = true; });
    return Object.keys(t);
  }

  // "2 points, 1 line"
  function describe(list) {
    var n = {};
    list.forEach(function (s) { n[s.type] = (n[s.type] || 0) + 1; });
    return ["point", "line", "route", "polygon"].filter(function (t) { return n[t]; })
      .map(function (t) { return n[t] + " " + NOUN[t][n[t] === 1 ? 0 : 1]; }).join(", ");
  }

  function afterChange(types) {
    types.forEach(function (t) { if (typeof App.rerenderForType === "function") App.rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
  }

  // True when the menu item should read "Hide" (any selected feature visible).
  function anyVisible(list) {
    return usable(list).some(function (s) { return !featureOf(s).properties.hidden; });
  }

  function setHidden(list, hidden) {
    list = usable(list);
    if (!list.length) return;
    if (App.undo) App.undo.push();
    list.forEach(function (s) { featureOf(s).properties.hidden = !!hidden; });
    afterChange(typesOf(list));
    if (typeof App.notifyProject === "function") App.notifyProject();
    App.setStatus((hidden ? "Hid " : "Showed ") + describe(list));
  }

  // One undo step. Splices each type from the highest index down so earlier
  // removals never shift a later target; then the same housekeeping a single
  // delete runs (App.onFeatureDelete: exit edit mode, clear selection,
  // refresh, notify modules, save).
  function remove(list) {
    list = usable(list);
    if (!list.length) return;
    if (typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen()) {
      var pf = typeof App.getAttrPopupFeature === "function" ? App.getAttrPopupFeature() : null;
      if (pf && list.some(function (s) { return s.type === pf.featureType && s.index === pf.featureIndex; })) App.closeAttrPopup();
    }
    var text = describe(list);
    var pointIds = list.filter(function (s) { return s.type === "point"; })
      .map(function (s) { return featureOf(s).properties.pointIdx; });
    var sorted = list.slice().sort(function (a, b) { return b.index - a.index; });
    function run() {
      sorted.forEach(function (s) {
        var fn = App[REMOVE[s.type]];
        if (typeof fn === "function") fn(s.index);
      });
    }
    if (App.undo && typeof App.undo.batch === "function") App.undo.batch(run); else run();
    if (pointIds.length && typeof App.dropPointWalksheds === "function") App.dropPointWalksheds(pointIds);
    if (typeof App.onFeatureDelete === "function") App.onFeatureDelete();
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
    App.setStatus("Deleted " + text);
  }

  function zoomTo(list) {
    list = usable(list);
    if (!list.length || !App.map || typeof turf === "undefined") return;
    var fc = { type: "FeatureCollection", features: list.map(featureOf) };
    var b = turf.bbox(fc);
    if (b[0] === b[2] && b[1] === b[3]) {
      App.map.flyTo({ center: [b[0], b[1]], zoom: Math.max(App.map.getZoom(), 14), duration: 500 });
    } else {
      App.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, duration: 500 });
    }
  }

  // Module references to the features about to be deleted (Title VI, RF, …).
  function usageFor(list) {
    var warn = [], info = [];
    if (typeof App.describeFeatureUsage !== "function") return { warn: warn, info: info };
    list.forEach(function (s) {
      var f = featureOf(s), idProp = App.FEATURE_ID_PROP && App.FEATURE_ID_PROP[s.type];
      var id = idProp ? f.properties[idProp] : null;
      if (id == null) return;
      var name = f.properties.name || describe([s]);
      App.describeFeatureUsage(s.type, id).forEach(function (u) {
        (u.severity === "warn" ? warn : info).push(name + " — " + u.label);
      });
    });
    return { warn: warn, info: info };
  }

  // Confirm, then remove. Uses the Merge/Split dialog shell.
  function confirmRemove(list) {
    list = usable(list);
    if (!list.length) return;
    var kit = App.merge && App.merge._dialogKit;
    if (!kit) { if (window.confirm("Delete " + describe(list) + "?")) remove(list); return; }
    if (kit.isOpen()) kit.closeDialog();
    if (typeof App.closeContextMenu === "function") App.closeContextMenu();
    var n = list.length;
    var shell = kit.buildShell("Delete " + n + (n === 1 ? " feature" : " features") + "?");
    var body = kit.el("div", "fm-section");
    body.appendChild(kit.el("div", null, "This deletes " + describe(list) + ". You can undo it with Ctrl+Z."));
    shell.box.appendChild(body);
    kit.renderUsage(shell.box, usageFor(list), "Also used by");
    var acts = kit.buildActions(shell.box, "Delete");
    acts.cancelBtn.addEventListener("click", function () { kit.closeDialog(); });
    acts.okBtn.addEventListener("click", function () { kit.closeDialog(); remove(list); });
    kit.installDialog(shell.overlay, shell.box, function () { kit.closeDialog(); remove(list); });
    acts.okBtn.focus();
  }

  // Menu items for a group (2+ selected). `mergeItem` (optional) is inserted
  // after Zoom, so each caller keeps its own Merge primary logic.
  function groupMenuItems(list, mergeItem) {
    list = usable(list);
    var n = list.length, vis = anyVisible(list);
    var items = [{ label: "Zoom to selection", action: function () { zoomTo(list); } }];
    if (mergeItem) items.push(mergeItem);
    items.push({ label: (vis ? "Hide " : "Show ") + n, action: function () { setHidden(list, vis); } });
    items.push({ label: "Delete " + n + (n === 1 ? " feature" : " features") + "\u2026", action: function () { confirmRemove(list); } });
    return items;
  }

  App.bulkFeatures = {
    usable: usable,
    describe: describe,
    anyVisible: anyVisible,
    setHidden: setHidden,
    remove: remove,
    confirmRemove: confirmRemove,
    zoomTo: zoomTo,
    groupMenuItems: groupMenuItems
  };

  App.boxSelect = {
    isActive: isActive,
    isDragging: function () { return !!_drag; },
    cancel: endDrag,
    _hitTest: hitTest,
    _buildCache: buildCache
  };
})();
