// js/core/feature-appearance.js
//
// Shared per-feature Appearance editing (docs/feature-appearance-plan.md, Phase 1).
//
//  - App.openAppearancePopup(anchorEl, type, index, opts) — the singleton
//    #fp-appearance-popover: color, opacity, width, offset (lines/routes) and
//    a Reset all button for ONE feature. Opened from the Features-pane type
//    icon, the Attributes popup swatch, the Layers-tab feature row swatch and
//    the Attribute Summary swatch.
//  - App.buildFeatureOverrideRows(type, feature, opts) — the opacity / width /
//    offset override rows (buffer radius is NOT here: it is geometry, edited in
//    the Attributes popup's Study area section via App.buildBufferRadiusControl).
//    The popover AND the Layers-tab per-feature
//    drawer both call this, so the "muted default until overridden, × clears"
//    cascade logic lives in exactly one place.
//
// Features are remembered by stable { type, id } ref and resolved on every
// read/write, so an undo/redo (which replaces the feature objects), a merge or
// a delete while the popover is open can never write to a stale object.
// Undo: one App.undo.push() per gesture (a scrub drag, a +/- click, a typed
// value, a ×), taken just before the first change of that gesture.
(function () {
  var App = window.App;

  var TYPE_LABELS = { point: "Point", line: "Line", route: "Route", polygon: "Polygon" };
  var RENDER_FNS = { point: "renderPointLayers", line: "renderLineLayers", route: "renderRouteLayers", polygon: "renderPolygonLayers" };
  var OPACITY_KEYS = { point: "pointOpacity", line: "lineOpacity", route: "routeOpacity" };
  var WIDTH_KEYS = { point: "pointLineWidth", line: "lineLineWidth", route: "routeLineWidth", polygon: "polygonLineWidth" };
  var WIDTH_LABELS = { point: "Size", line: "Weight", route: "Weight", polygon: "Width" };
  var OFFSET_STEPS = [-6, -3, 0, 3, 6];

  function rerender(ft) {
    var fn = RENDER_FNS[ft];
    if (fn && typeof App[fn] === "function") App[fn]();
  }
  function saveCache() {
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }
  function pushUndo() {
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
  }

  // Inverse of App._polyOpacityValues' fill component -> S (0-100).
  function invertPolyFill(fill) {
    if (fill <= 0.15) return Math.round(fill * 50 / 0.15);
    return Math.round(50 + (fill - 0.15) * 50 / 0.85);
  }

  // Live feature for a ref ({type, id}); null when deleted/merged away.
  function resolve(ref) {
    return ref ? App.featureById(ref.type, ref.id) : null;
  }

  // ------------------------------------------------------------------
  // Override rows
  // ------------------------------------------------------------------

  // One "<label> [- value +] [x]" row. `api` = {hasOverride, getValue, setValue,
  // clearValue}; `gesture` = shared {armed} flag object (see armUndo below).
  function buildOverrideRow(label, scrubCfg, api, gesture) {
    var row = document.createElement("div");
    row.className = "lp-style-row";

    var lab = document.createElement("span");
    lab.className = "lp-style-label";
    lab.textContent = label;
    row.appendChild(lab);

    var controlWrap = document.createElement("div");
    controlWrap.className = "lp-style-control";
    row.appendChild(controlWrap);

    // A gesture = one scrub drag, one +/- click, one typed value. Each of those
    // starts with a mousedown / click / change on the control; the first value
    // commit after it takes the single undo snapshot, the rest of a drag don't.
    function arm() { gesture.armed = true; }
    controlWrap.addEventListener("mousedown", arm, true);
    controlWrap.addEventListener("click", arm, true);
    controlWrap.addEventListener("change", arm, true);

    var scrubber = App.buildScrubber({
      min: scrubCfg.min, max: scrubCfg.max, step: scrubCfg.step,
      values: scrubCfg.values, unit: scrubCfg.unit,
      value: api.getValue(),
      onChange: function (v) {
        if (gesture.armed) { gesture.armed = false; pushUndo(); }
        api.setValue(v);
        setOverridden(true);
      }
    });
    controlWrap.appendChild(scrubber);

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "lp-style-clear";
    clearBtn.title = "Clear override (use default)";
    clearBtn.setAttribute("aria-label", "Clear " + label + " override");
    clearBtn.textContent = "×";
    clearBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      gesture.armed = false;
      pushUndo();
      api.clearValue();
      scrubber.refresh(api.getValue());
      setOverridden(false);
    });
    controlWrap.appendChild(clearBtn);

    function setOverridden(has) {
      row.classList.toggle("lp-inherited", !has);
      clearBtn.style.display = has ? "" : "none";
    }
    setOverridden(api.hasOverride());

    return row;
  }

  // Returns an array of DOM rows. opts: { onChange }.
  // onChange fires after every write (value change or clear).
  function buildFeatureOverrideRows(type, feature, opts) {
    opts = opts || {};
    var rows = [];
    var ref = App.featureRef(type, App[{ point: "points", line: "lines", route: "routes", polygon: "polygons" }[type]].indexOf(feature));
    if (!ref) return rows;
    var gesture = { armed: false };
    var FS = function () { return App.featureSettings || {}; };

    function props() { var f = resolve(ref); return f ? f.properties : null; }
    function changed() {
      rerender(type);
      saveCache();
      if (typeof opts.onChange === "function") opts.onChange();
    }
    // Guarded write: skips (and does nothing) if the feature is gone.
    function write(fn) { var p = props(); if (!p) return; fn(p); changed(); }

    // Opacity
    rows.push(buildOverrideRow("Opacity", { min: 0, max: 100, step: 1, unit: "%" }, {
      hasOverride: function () {
        var p = props(); if (!p) return false;
        return type === "polygon" ? p._fillOpacity != null : p._opacity != null;
      },
      getValue: function () {
        var p = props() || {};
        if (type === "polygon") {
          if (p._fillOpacity != null) return invertPolyFill(p._fillOpacity);
          var defFill = FS().polygonFillOpacity != null ? FS().polygonFillOpacity : 15;
          return invertPolyFill(defFill / 100);
        }
        if (p._opacity != null) return p._opacity * 100;
        return FS()[OPACITY_KEYS[type]] != null ? FS()[OPACITY_KEYS[type]] : 100;
      },
      setValue: function (v) {
        write(function (p) {
          if (type === "polygon") {
            var pc = App._polyOpacityValues(v);
            p._fillOpacity = pc.fill;
            p._borderOpacity = pc.border;
          } else {
            p._opacity = v / 100;
          }
        });
      },
      clearValue: function () {
        write(function (p) {
          delete p._opacity;
          delete p._fillOpacity;
          delete p._borderOpacity;
        });
      }
    }, gesture));

    // Width / size
    rows.push(buildOverrideRow(WIDTH_LABELS[type], { min: 0, max: 5, step: 0.1, unit: "×" }, {
      hasOverride: function () { var p = props(); return !!p && p._lineWidth != null; },
      getValue: function () {
        var p = props() || {};
        if (p._lineWidth != null) return p._lineWidth;
        return FS()[WIDTH_KEYS[type]] != null ? FS()[WIDTH_KEYS[type]] : 1;
      },
      setValue: function (v) { write(function (p) { p._lineWidth = v; }); },
      clearValue: function () { write(function (p) { delete p._lineWidth; }); }
    }, gesture));

    // Offset (lines and routes only)
    if (type === "line" || type === "route") {
      rows.push(buildOverrideRow("Offset", { values: OFFSET_STEPS, unit: "px" }, {
        hasOverride: function () { var p = props(); return !!p && !!p._offsetManual; },
        getValue: function () { var p = props(); return (p && p._offset != null) ? p._offset : 0; },
        setValue: function (v) {
          write(function (p) { p._offset = v; p._offsetManual = true; });
        },
        clearValue: function () {
          write(function (p) { delete p._offset; delete p._offsetManual; });
          var oCb = document.getElementById("offsetOverlap");
          if (oCb && oCb.checked && typeof App.computeOverlapOffsets === "function") App.computeOverlapOffsets();
        }
      }, gesture));
    }

    return rows;
  }
  App.buildFeatureOverrideRows = buildFeatureOverrideRows;

  // ------------------------------------------------------------------
  // Popover
  // ------------------------------------------------------------------
  var _pop = null;        // the element, or null when closed
  var _ref = null;        // { type, id }
  var _anchor = null;
  var _opts = null;
  var _listenersOn = false;
  var _closedByOutside = null;   // { key, at } — lets the opener's click act as a toggle

  function isOpen() { return !!_pop; }
  App.isAppearancePopupOpen = isOpen;

  function closePopup() {
    if (_pop && _pop.parentNode) _pop.parentNode.removeChild(_pop);
    _pop = null; _ref = null; _anchor = null; _opts = null;
  }
  App.closeAppearancePopup = closePopup;

  function hasOwnAppearance(p) {
    return p.color || p._opacity != null || p._fillOpacity != null || p._borderOpacity != null ||
      p._lineWidth != null || !!p._offsetManual;
  }

  function notifyChange() {
    if (_opts && typeof _opts.onChange === "function") _opts.onChange();
  }

  // Refresh the other surfaces that show this feature's color.
  function refreshColorSurfaces() {
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (typeof App.refreshAttrPopupSwatch === "function") App.refreshAttrPopupSwatch();
  }

  function setColor(hex) {
    var idx = App.resolveFeatureRef(_ref);
    if (idx < 0) { closePopup(); return; }
    App.updateFeatureColor(_ref.type, idx, hex);   // one undo step, rerender, cache, Layers refresh
    refreshColorSurfaces();
    notifyChange();
    render();
  }

  function resetAll() {
    var idx = App.resolveFeatureRef(_ref);
    if (idx < 0) { closePopup(); return; }
    var feat = resolve(_ref);
    if (!hasOwnAppearance(feat.properties)) return;
    var type = _ref.type;
    // One snapshot for the whole reset (batch makes updateFeatureColor's own push a no-op).
    App.undo.batch(function () {
      var p = resolve(_ref).properties;
      if (p.color) App.updateFeatureColor(type, idx, "");
      p = resolve(_ref).properties;
      delete p._opacity; delete p._fillOpacity; delete p._borderOpacity;
      delete p._lineWidth;
      if (p._offsetManual) { delete p._offset; delete p._offsetManual; }
      rerender(type);
      var oCb = document.getElementById("offsetOverlap");
      if (oCb && oCb.checked && typeof App.computeOverlapOffsets === "function") App.computeOverlapOffsets();
    });
    saveCache();
    refreshColorSurfaces();
    notifyChange();
    render();
  }

  // (Re)build the popover's contents for the current ref.
  function render() {
    if (!_pop) return;
    var feat = resolve(_ref);
    if (!feat) { closePopup(); return; }
    var type = _ref.type;
    _pop.innerHTML = "";

    var head = document.createElement("div");
    head.className = "fa-head";
    var title = document.createElement("span");
    title.className = "fa-title";
    title.textContent = "Appearance — " + (feat.properties.name || TYPE_LABELS[type]);
    head.appendChild(title);
    var x = document.createElement("button");
    x.type = "button";
    x.className = "fa-close";
    x.setAttribute("aria-label", "Close");
    x.textContent = "×";
    x.addEventListener("click", function (e) { e.stopPropagation(); closePopup(); });
    head.appendChild(x);
    _pop.appendChild(head);

    var body = document.createElement("div");
    body.className = "fa-body";

    // Color
    var cur = App.resolveFeatureColor(type, feat);
    var colorRow = document.createElement("div");
    colorRow.className = "lp-style-row fa-color-row" + (feat.properties.color ? "" : " lp-inherited");
    var cl = document.createElement("span");
    cl.className = "lp-style-label";
    cl.textContent = "Color";
    colorRow.appendChild(cl);
    var cc = document.createElement("div");
    cc.className = "lp-style-control";
    var sw = document.createElement("span");
    sw.className = "fa-color-swatch";
    sw.style.background = cur;
    sw.title = cur;
    cc.appendChild(sw);
    if (feat.properties.color) {
      var cx = document.createElement("button");
      cx.type = "button";
      cx.className = "lp-style-clear";
      cx.title = "Clear color override (use default)";
      cx.setAttribute("aria-label", "Clear Color override");
      cx.textContent = "×";
      cx.addEventListener("click", function (e) { e.stopPropagation(); setColor(""); });
      cc.appendChild(cx);
    }
    colorRow.appendChild(cc);
    body.appendChild(colorRow);
    body.appendChild(App.buildColorPickerBody(feat.properties.color || "", function (hex) { setColor(hex); }));

    // Opacity / width / offset
    buildFeatureOverrideRows(type, feat, { onChange: notifyChange }).forEach(function (r) { body.appendChild(r); });

    _pop.appendChild(body);

    var foot = document.createElement("div");
    foot.className = "fa-foot";
    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "lp-style-reset fa-reset";
    reset.textContent = "Reset all";
    reset.addEventListener("click", function (e) { e.stopPropagation(); resetAll(); });
    foot.appendChild(reset);
    _pop.appendChild(foot);
  }

  function position() {
    if (!_pop) return;
    var rect = _anchor && _anchor.getBoundingClientRect ? _anchor.getBoundingClientRect() : { left: 80, bottom: 80, top: 80, right: 80 };
    var pw = _pop.offsetWidth || 232, ph = _pop.offsetHeight || 320;
    var left = rect.left;
    var top = rect.bottom + 6;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    _pop.style.left = Math.round(left) + "px";
    _pop.style.top = Math.round(top) + "px";
  }

  function installListeners() {
    if (_listenersOn) return;
    _listenersOn = true;
    // Outside mousedown closes (the anchor is excluded: its own click toggles).
    document.addEventListener("mousedown", function (e) {
      if (!_pop) return;
      if (_pop.contains(e.target)) return;
      // Remember what was open: the same swatch's click (which follows this
      // mousedown) must toggle it closed, not reopen it. The swatch is often
      // rebuilt by a panel refresh, so this is keyed by feature, not by element.
      _closedByOutside = { type: _ref.type, id: _ref.id, at: Date.now() };
      closePopup();
    }, true);
    document.addEventListener("keydown", function (e) {
      if (!_pop) return;
      if (e.key === "Escape") {
        closePopup();
        e.stopPropagation();
        return;
      }
      // Undo/redo replaces the feature objects: rebuild from the live feature
      // once the undo has run (closes if the feature no longer exists).
      var k = (e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) {
        setTimeout(render, 0);
      }
    }, true);
  }

  function openAppearancePopup(anchorEl, type, index, opts) {
    if (!App.FEATURE_ID_PROP[type]) return;
    var ref = App.featureRef(type, index);
    if (!ref) return;
    var same = _pop && _ref && _ref.type === ref.type && _ref.id === ref.id;
    if (same) { closePopup(); return; }
    var co = _closedByOutside;
    _closedByOutside = null;
    if (co && co.type === ref.type && co.id === ref.id && Date.now() - co.at < 500) return;
    closePopup();
    // Only one floating editor at a time.
    if (typeof App._closeFpSlider === "function") App._closeFpSlider();
    var picker = document.getElementById("fp-color-picker");
    if (picker) picker.style.display = "none";

    _ref = ref; _anchor = anchorEl; _opts = opts || {};
    _pop = document.createElement("div");
    _pop.id = "fp-appearance-popover";
    _pop.className = "fa-popover";
    _pop.setAttribute("role", "dialog");
    _pop.setAttribute("aria-label", "Appearance");
    document.body.appendChild(_pop);
    installListeners();
    render();
    position();
  }
  App.openAppearancePopup = openAppearancePopup;
})();
