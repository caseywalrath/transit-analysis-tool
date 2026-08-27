// js/core/features.js
// Right-side feature panel: lists all points, lines, routes, polygons
// with editable names, per-item color swatches, and per-item delete buttons.
// Depends on: App.points (points.js), App.lines (lines.js),
//             App.polygons (polygons.js).
// Exports: refreshFeaturePanel, openColorPicker, updateFeatureColor

(function () {
  var App = window.App = window.App || {};

  // Tracks which route groups the user has manually collapsed.
  // Persists across refreshFeaturePanel() calls (survives DOM rebuilds).
  var _expandedGroups = {};

  // Tracks which feature-type sections the user has collapsed this session.
  // Default is expanded; only collapsed sections are stored.
  var _collapsedSections = {};

  // Universal group key for cross-type grouping (labels keep their own key)
  var UNIVERSAL_GROUP_KEY = "group";
  var LABEL_GROUP_KEY = "labelGroup";

  // ---- Features list sort state (Tier 1: Name / Type / Date added / Group) ----
  // Display-only — never reorders App.points/lines/routes/polygons. Applies to
  // the main unified Features list only; the Labels and Text section (built by
  // populateLabelGroupedList) is out of scope and always sorts by name.
  var TYPE_RANK = { point: 0, line: 1, route: 2, polygon: 3 };
  var SORT_MODES = [
    { id: "name",  label: "Name" },
    { id: "type",  label: "Type" },
    { id: "added", label: "Date added" },
    { id: "group", label: "Group" }
  ];
  var _sortMode   = "name";
  var _sortAsc    = true;
  var _showGroups = true;
  var _hiddenLast = false;

  var TYPE_LABELS_LOCAL = {
    point: "Point", line: "Line",
    route: "Route", polygon: "Polygon", label: "Label"
  };

  var CHEVRON_SVG = '&#9662;';

  // Type icon SVGs — use currentColor so the icon reflects feature.properties.color
  var TYPE_ICON_SVGS = {
    point:   '<svg width="11" height="11" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
    line:    '<svg width="11" height="11" viewBox="0 0 24 24"><line x1="4" y1="19" x2="20" y2="5" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>',
    route:   '<svg width="11" height="11" viewBox="0 0 24 24"><path d="M4 18 Q8 6 14 10 Q20 14 20 6" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/><circle cx="4" cy="18" r="2.5" fill="currentColor"/></svg>',
    polygon: '<svg width="11" height="11" viewBox="0 0 24 24"><polygon points="12,4 21,10 18,20 6,20 3,10" fill="currentColor"/></svg>',
    label:   '<svg width="11" height="11" viewBox="0 0 24 24"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-4 4z" fill="currentColor"/></svg>'
  };

  var GEAR_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06' +
    'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4' +
    'a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15' +
    'a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82' +
    'l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3' +
    'a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83' +
    'l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09' +
    'a1.65 1.65 0 0 0-1.51 1z"/>' +
    '</svg>';

  var COPY_SVG =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
    '</svg>';

  var EYE_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
    '<circle cx="12" cy="12" r="3"/>' +
    '</svg>';

  var EYE_OFF_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' +
    'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19' +
    'm-6.72-1.07a3 3 0 1 1-4.24-4.24"/>' +
    '<line x1="1" y1="1" x2="23" y2="23"/>' +
    '</svg>';

  var TRASH_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '</svg>';

  /* ---- Color picker (singleton popover) ---- */

  var PICKER_COLORS = [
    "#feb2b2","#fbd38d","#faf089","#9ae6b4","#bee3f8","#e9d8fd",
    "#fc8181","#f6ad55","#f6e05e","#68d391","#63b3ed","#b794f4",
    "#e53e3e","#dd6b20","#d69e2e","#319795","#3182ce","#805ad5",
    "#c53030","#c05621","#b7791f","#276749","#2b6cb0","#553c9a",
    "#ffffff","#e2e8f0","#a0aec0","#718096","#4a5568","#000000"
  ];

  var _picker = null;
  var _pickerCallback = null;
  var _pickerAnchor = null;

  function buildPicker() {
    if (_picker) return;
    var el = document.createElement("div");
    el.id = "fp-color-picker";
    el.style.display = "none";

    var grid = document.createElement("div");
    grid.className = "fp-cp-grid";
    PICKER_COLORS.forEach(function (c) {
      var cell = document.createElement("button");
      cell.className = "fp-cp-cell";
      cell.style.background = c;
      cell.title = c;
      cell.setAttribute("aria-label", "Select color " + c);
      cell.addEventListener("click", function (e) {
        e.stopPropagation();
        selectPickerColor(c);
      });
      grid.appendChild(cell);
    });
    el.appendChild(grid);

    var hexRow = document.createElement("div");
    hexRow.className = "fp-cp-hex-row";
    var hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.className = "fp-cp-hex-input";
    hexInput.placeholder = "#rrggbb";
    hexInput.maxLength = 7;
    var applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.className = "fp-cp-apply";
    applyBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var val = hexInput.value.trim();
      if (val.charAt(0) !== "#") val = "#" + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        selectPickerColor(val.toLowerCase());
      } else {
        hexInput.style.outline = "2px solid red";
        setTimeout(function () { hexInput.style.outline = ""; }, 1200);
      }
    });
    hexInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") applyBtn.click();
    });
    hexInput.addEventListener("input", function () {
      hexInput.style.outline = "";
    });
    hexRow.appendChild(hexInput);
    hexRow.appendChild(applyBtn);
    el.appendChild(hexRow);

    document.body.appendChild(el);
    _picker = el;

    // Close on outside click (capture phase to beat stopPropagation on swatches)
    document.addEventListener("click", function (e) {
      if (!_picker || _picker.style.display === "none") return;
      if (!_picker.contains(e.target) && e.target !== _pickerAnchor) {
        closeColorPicker();
      }
    }, true);
  }

  function openColorPicker(anchorEl, currentColor, callback) {
    buildPicker();
    _pickerCallback = callback;
    _pickerAnchor = anchorEl;

    var hexInput = _picker.querySelector(".fp-cp-hex-input");
    hexInput.value = currentColor || "";
    hexInput.style.outline = "";

    _picker.style.display = "block";

    var rect = anchorEl.getBoundingClientRect();
    var pw = _picker.offsetWidth || 192;
    var ph = _picker.offsetHeight || 240;
    var top = rect.bottom + 4;
    var left = rect.left;

    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
    if (left < 4) left = 4;
    if (top < 4) top = 4;

    _picker.style.left = left + "px";
    _picker.style.top = top + "px";
  }

  function closeColorPicker() {
    if (_picker) _picker.style.display = "none";
    _pickerAnchor = null;
    _pickerCallback = null;
  }

  function selectPickerColor(hex) {
    if (_pickerCallback) _pickerCallback(hex);
    closeColorPicker();
  }

  App.openColorPicker = openColorPicker;

  /* ---- Feature color update (called by per-feature swatches) ---- */

  App.updateFeatureColor = function (featureType, featureIndex, newColor) {
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    if (featureType === "point") {
      if (App.points[featureIndex]) App.points[featureIndex].properties.color = newColor;
      if (typeof App.renderPointLayers === "function") App.renderPointLayers();
    } else if (featureType === "line") {
      App.lines[featureIndex].properties.color = newColor;
      var lr = (App.featureSettings && App.featureSettings.lineBufferRadius != null) ? App.featureSettings.lineBufferRadius : 0;
      App.rebuildLineBuffers(lr);
      App.renderLineLayers();
    } else if (featureType === "route") {
      App.routes[featureIndex].properties.color = newColor;
      var rr = (App.featureSettings && App.featureSettings.routeBufferRadius != null) ? App.featureSettings.routeBufferRadius : 0;
      App.rebuildRouteBuffers(rr);
      App.renderRouteLayers();
    } else if (featureType === "polygon") {
      App.polygons[featureIndex].properties.color = newColor;
      App.renderPolygonLayers();
    } else if (featureType === "label") {
      App.labels[featureIndex].properties.color = newColor;
      App.labels[featureIndex].properties.bgColor = newColor;
      if (App.labels[featureIndex].properties.attributes) {
        App.labels[featureIndex].properties.attributes.bgColor = newColor;
      }
      if (typeof App.updateLabelAppearance === "function") App.updateLabelAppearance(featureIndex);
    }
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  };

  /* ---- Default color helper ---- */

  function getTypeDefaultColor(featureType) {
    var sc = App.sectionColors && App.sectionColors[featureType];
    if (sc) return sc;
    var defaults = { point: "#2b6cb0", line: "#e53e3e", route: "#319795", polygon: "#b0c4de", label: "#1a202c" };
    return defaults[featureType] || "#999999";
  }

  /* ---- Natural sort helper ---- */

  function naturalSort(a, b) {
    var re = /(\d+)|(\D+)/g;
    var ap = String(a || "").match(re) || [];
    var bp = String(b || "").match(re) || [];
    for (var i = 0; i < Math.max(ap.length, bp.length); i++) {
      if (i >= ap.length) return -1;
      if (i >= bp.length) return 1;
      var aIsNum = /^\d+$/.test(ap[i]);
      var bIsNum = /^\d+$/.test(bp[i]);
      if (aIsNum && bIsNum) {
        var d = parseInt(ap[i], 10) - parseInt(bp[i], 10);
        if (d !== 0) return d;
      } else {
        var c = ap[i].toLowerCase().localeCompare(bp[i].toLowerCase());
        if (c !== 0) return c;
      }
    }
    return 0;
  }

  /* ---- Visibility helpers ---- */

  function rerenderForType(ft) {
    if (ft === "route") {
      var rr = (App.featureSettings && App.featureSettings.routeBufferRadius != null) ? App.featureSettings.routeBufferRadius : 0;
      if (typeof App.rebuildRouteBuffers === "function") App.rebuildRouteBuffers(rr);
    } else if (ft === "line") {
      var lr = (App.featureSettings && App.featureSettings.lineBufferRadius != null) ? App.featureSettings.lineBufferRadius : 0;
      if (typeof App.rebuildLineBuffers === "function") App.rebuildLineBuffers(lr);
    } else if (ft === "point") {
      var sr = (App.featureSettings && App.featureSettings.bufferRadius != null) ? App.featureSettings.bufferRadius : 0;
      if (typeof App.rebuildBuffers === "function") App.rebuildBuffers(sr);
    } else if (ft === "polygon") {
      if (typeof App.renderPolygonLayers === "function") App.renderPolygonLayers();
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    } else if (ft === "label") {
      if (typeof App.renderLabelMarkers === "function") App.renderLabelMarkers();
    } else if (ft === "textbox") {
      if (typeof App.renderTextBoxMarkers === "function") App.renderTextBoxMarkers();
    }
  }

  /* ---- Context menu ---- */

  var _ctxMenu = null;

  function showContextMenu(x, y, options) {
    if (_ctxMenu) _ctxMenu.remove();
    var menu = document.createElement("div");
    menu.id = "fp-context-menu";
    options.forEach(function (opt) {
      // Divider: a plain hairline separator, or (with a label) a section
      // heading row. Neither is clickable.
      if (opt.divider) {
        var div = document.createElement("div");
        div.className = "fp-ctx-divider" + (opt.label ? " fp-ctx-divider-label" : "");
        if (opt.label) div.textContent = opt.label;
        menu.appendChild(div);
        return;
      }
      var btn = document.createElement("button");
      // "checked" is a tri-state concept: only options that explicitly pass
      // a boolean get the checkmark gutter, so plain {label, action} callers
      // (the per-feature context menu, the Layers panel's ⋯ menu) render
      // exactly as before.
      if (typeof opt.checked === "boolean") {
        btn.classList.add("fp-ctx-checkable");
        if (opt.checked) btn.classList.add("fp-ctx-checked");
      }
      btn.textContent = opt.label;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.remove();
        _ctxMenu = null;
        opt.action();
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    _ctxMenu = menu;
    var mw = menu.offsetWidth || 160;
    var mh = menu.offsetHeight || 80;
    var left = Math.min(x, window.innerWidth  - mw - 8);
    var top  = Math.min(y, window.innerHeight - mh - 8);
    menu.style.left = Math.max(4, left) + "px";
    menu.style.top  = Math.max(4, top)  + "px";
    setTimeout(function () {
      document.addEventListener("click", function close(e) {
        if (!menu.contains(e.target)) { menu.remove(); _ctxMenu = null; }
        document.removeEventListener("click", close);
      });
    }, 0);
  }

  /* ---- Group / ungroup helpers ---- */

  function getFeatureByTypeIndex(type, index) {
    var map = { point: "points", line: "lines", route: "routes", polygon: "polygons", label: "labels" };
    var arr = App[map[type]];
    return arr ? arr[index] : null;
  }

  function goToFeature(featureType, featureIndex) {
    var feature = getFeatureByTypeIndex(featureType, featureIndex);
    if (!feature || !feature.geometry) return;
    var geom = feature.geometry;
    if (geom.type === "Point") {
      App.map.flyTo({ center: geom.coordinates, zoom: Math.max(App.map.getZoom(), 14), duration: 500 });
    } else {
      var bbox = turf.bbox(feature);
      App.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 500 });
    }
  }

  // Feature arrays relevant to a given group key: labels only group with
  // labels (LABEL_GROUP_KEY); points/lines/routes/polygons share the
  // universal key (UNIVERSAL_GROUP_KEY) and can group across those types.
  function getGroupArrays(key) {
    return key === LABEL_GROUP_KEY
      ? [App.labels || []]
      : [App.points || [], App.lines || [], App.routes || [], App.polygons || []];
  }

  function generateGroupName(isLabel) {
    var key = isLabel ? LABEL_GROUP_KEY : UNIVERSAL_GROUP_KEY;
    var prefix = isLabel ? "Label Group " : "Group ";
    var existing = {};
    getGroupArrays(key).forEach(function (arr) {
      arr.forEach(function (f) {
        var g = f.properties.attributes && f.properties.attributes[key];
        if (g) existing[g] = true;
      });
    });
    var n = 1;
    while (existing[prefix + n]) n++;
    return prefix + n;
  }

  // One entry per distinct existing group name under `key`, with a member
  // count and a representative color (first member found with a color).
  function collectGroupSummaries(key) {
    var byName = {};
    getGroupArrays(key).forEach(function (arr) {
      arr.forEach(function (f) {
        var g = f.properties.attributes && f.properties.attributes[key];
        if (!g) return;
        if (!byName[g]) byName[g] = { name: g, count: 0, color: null };
        byName[g].count++;
        if (!byName[g].color && f.properties.color) byName[g].color = f.properties.color;
      });
    });
    var names = Object.keys(byName);
    names.sort(naturalSort);
    return names.map(function (n) { return byName[n]; });
  }

  // Resolves a { type, index } selection snapshot to direct feature object
  // references up front, so a picker left open across a later panel
  // re-render/index-shift still acts on the right features.
  function resolveSelection(selected) {
    var out = [];
    selected.forEach(function (s) {
      var feat = getFeatureByTypeIndex(s.type, s.index);
      if (feat) out.push({ type: s.type, feature: feat });
    });
    return out;
  }

  // Shared "do it" step for both New Group and existing-group picker rows.
  function assignFeaturesToGroup(resolved, key, name) {
    if (!name || !resolved.length) return;
    // Prefer the color already established by the target group (if any);
    // otherwise fall back to the first resolved feature's own color.
    var inheritColor = null;
    getGroupArrays(key).forEach(function (arr) {
      arr.forEach(function (f) {
        if (!inheritColor && f.properties.color && f.properties.attributes &&
            f.properties.attributes[key] === name) {
          inheritColor = f.properties.color;
        }
      });
    });
    if (!inheritColor) {
      for (var i = 0; i < resolved.length; i++) {
        if (resolved[i].feature.properties.color) { inheritColor = resolved[i].feature.properties.color; break; }
      }
    }
    resolved.forEach(function (r) {
      var feat = r.feature;
      if (!feat.properties.attributes) feat.properties.attributes = {};
      feat.properties.attributes[key] = name;
      if (inheritColor) feat.properties.color = inheritColor;
    });
    var typesChanged = {};
    resolved.forEach(function (r) { typesChanged[r.type] = true; });
    Object.keys(typesChanged).forEach(function (t) { rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  // Builds the floating picker body: "+ New Group" plus a row per existing
  // group under `key`. Each row acts immediately and closes the popup.
  function buildGroupPickerContent(resolved, key) {
    var container = document.createElement("div");
    container.className = "fp-group-picker";

    var newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "fp-group-picker-new";
    newBtn.textContent = "+ New Group";
    newBtn.addEventListener("click", function () {
      assignFeaturesToGroup(resolved, key, generateGroupName(key === LABEL_GROUP_KEY));
      if (typeof App.closeMiniPopup === "function") App.closeMiniPopup();
    });
    container.appendChild(newBtn);

    var summaries = collectGroupSummaries(key);
    if (summaries.length) {
      var divider = document.createElement("div");
      divider.className = "fp-group-picker-divider";
      divider.textContent = "Existing groups";
      container.appendChild(divider);

      summaries.forEach(function (g) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "fp-group-picker-row";
        var dot = document.createElement("span");
        dot.className = "fp-group-picker-swatch";
        dot.style.background = g.color || "#999";
        row.appendChild(dot);
        row.appendChild(document.createTextNode(g.name + " (" + g.count + ")"));
        row.addEventListener("click", function () {
          assignFeaturesToGroup(resolved, key, g.name);
          if (typeof App.closeMiniPopup === "function") App.closeMiniPopup();
        });
        container.appendChild(row);
      });
    }

    return container;
  }

  // Opens the group picker anchored at the context-menu click point (x, y),
  // reusing App.openMiniPopup's viewport-clamped floating dialog so it can
  // never spill offscreen the way a hover-submenu could.
  function openGroupPicker(x, y, selected, key, anyInGroup) {
    if (typeof App.openMiniPopup !== "function") return;
    var resolved = resolveSelection(selected);
    if (!resolved.length) return;
    var anchor = document.createElement("span");
    anchor.style.cssText = "position:fixed;left:" + x + "px;top:" + y + "px;width:0;height:0;";
    document.body.appendChild(anchor);
    App.openMiniPopup({
      title: anyInGroup ? "Move to Group" : "Group",
      content: buildGroupPickerContent(resolved, key),
      anchor: anchor,
      onClose: function () { anchor.remove(); }
    });
  }

  function ungroupSelectedFeatures() {
    var selected = typeof App.getSelectedFeatures === "function" ? App.getSelectedFeatures() : [];
    selected.forEach(function (s) {
      var feat = getFeatureByTypeIndex(s.type, s.index);
      if (!feat || !feat.properties.attributes) return;
      // Clear universal group key (and legacy label key)
      delete feat.properties.attributes[UNIVERSAL_GROUP_KEY];
      if (s.type === "label") delete feat.properties.attributes[LABEL_GROUP_KEY];
    });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  /* ---- Feature panel item ---- */

  function buildItem(feature, featureType, featureIndex, onDelete) {
    var div = document.createElement("div");
    div.className = "fp-item";
    div.dataset.featureType  = featureType;
    div.dataset.featureIndex = featureIndex;

    // Visibility eye toggle
    var isHidden = !!feature.properties.hidden;
    if (isHidden) div.classList.add("fp-item-hidden");
    var eyeBtn = document.createElement("button");
    eyeBtn.className = "fp-visibility-btn" + (isHidden ? " fp-eye-off" : "");
    eyeBtn.title = isHidden ? "Show" : "Hide";
    eyeBtn.setAttribute("aria-label", isHidden ? "Show feature" : "Hide feature");
    eyeBtn.innerHTML = isHidden ? EYE_OFF_SVG : EYE_SVG;
    (function (btn, feat, ft) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        feat.properties.hidden = !feat.properties.hidden;
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
        rerenderForType(ft);
      });
    })(eyeBtn, feature, featureType);

    // Type icon — reflects feature color and opens the color picker on click
    var typeIcon = document.createElement("button");
    typeIcon.type = "button";
    typeIcon.className = "fp-type-icon";
    typeIcon.innerHTML = TYPE_ICON_SVGS[featureType] || "";
    typeIcon.title = "Change " + (TYPE_LABELS_LOCAL[featureType] || featureType) + " color";
    typeIcon.setAttribute("aria-label", typeIcon.title);
    var _currentColor = feature.properties.color || getTypeDefaultColor(featureType);
    typeIcon.style.color = _currentColor;
    (function (btn, ft, fi) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (typeof App.openColorPicker !== "function") return;
        var curColor = btn.style.color || getTypeDefaultColor(ft);
        App.openColorPicker(btn, curColor, function (newColor) {
          if (typeof App.updateFeatureColor === "function") {
            App.updateFeatureColor(ft, fi, newColor);
          }
          btn.style.color = newColor;
          if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        });
      });
    })(typeIcon, featureType, featureIndex);

    var input = document.createElement("span");
    input.className = "fp-name";
    input.textContent = feature.properties.name || "";

    // Duplicate button (labels only)
    var dupBtn = null;
    if (featureType === "label") {
      dupBtn = document.createElement("button");
      dupBtn.className = "fp-dup-btn";
      dupBtn.title = "Duplicate label";
      dupBtn.setAttribute("aria-label", "Duplicate label");
      dupBtn.innerHTML = COPY_SVG;
      (function (fi) {
        dupBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (typeof App.duplicateLabel === "function") App.duplicateLabel(fi);
        });
      })(featureIndex);
    }

    // Gear/attributes button
    var gearBtn = document.createElement("button");
    gearBtn.className = "fp-gear-btn";
    gearBtn.title = "Edit attributes";
    gearBtn.setAttribute("aria-label", "Edit feature attributes");
    gearBtn.innerHTML = GEAR_SVG;
    (function (ft, fi, feat) {
      gearBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (typeof App.openAttrPopup === "function") App.openAttrPopup(ft, fi, feat);
      });
    })(featureType, featureIndex, feature);

    var trashBtn = document.createElement("button");
    trashBtn.className = "fp-del-btn";
    trashBtn.title = "Delete feature";
    trashBtn.setAttribute("aria-label", "Delete feature");
    trashBtn.innerHTML = TRASH_SVG;
    trashBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      onDelete();
    });

    // Hover and click wiring
    div.addEventListener("mouseenter", function () {
      if (typeof App.setHoveredFeature === "function") App.setHoveredFeature(featureType, featureIndex);
    });
    div.addEventListener("mouseleave", function () {
      if (typeof App.clearHover === "function") App.clearHover();
    });
    div.addEventListener("click", function (e) {
      if (e.shiftKey) {
        if (typeof App.shiftSelectFeature === "function") App.shiftSelectFeature(featureType, featureIndex);
      } else if (e.ctrlKey || e.metaKey) {
        if (typeof App.toggleMultiSelect === "function") App.toggleMultiSelect(featureType, featureIndex);
      } else {
        if (typeof App.selectFeature === "function") App.selectFeature(featureType, featureIndex);
      }
    });

    div.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      // If this item isn't in the current selection, single-select it first
      if (typeof App.isFeatureSelected === "function" && !App.isFeatureSelected(featureType, featureIndex)) {
        if (typeof App.selectFeature === "function") App.selectFeature(featureType, featureIndex);
      }
      var selected = typeof App.getSelectedFeatures === "function" ? App.getSelectedFeatures() : [];
      if (!selected.length) return;
      var options = [];
      // Single-select: offer Attributes
      if (selected.length === 1 && selected[0].type === featureType && selected[0].index === featureIndex) {
        (function (ft, fi, feat) {
          options.push({ label: "Go To Feature", action: function () { goToFeature(ft, fi); } });
          options.push({ label: "Attributes", action: function () {
            if (typeof App.openAttrPopup === "function") App.openAttrPopup(ft, fi, feat);
          }});
          var dupFn = { point: App.duplicatePoint, line: App.duplicateLine,
                        route: App.duplicateRoute, polygon: App.duplicatePolygon,
                        label: App.duplicateLabel }[ft];
          if (typeof dupFn === "function") {
            options.push({ label: "Duplicate", action: function () { dupFn(fi); } });
          }
          options.push({ label: feat.properties.hidden ? "Show" : "Hide", action: function () {
            feat.properties.hidden = !feat.properties.hidden;
            if (App.cache && typeof App.cache.save === "function") App.cache.save();
            if (typeof App.rerenderForType === "function") App.rerenderForType(ft);
            if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
          }});
          options.push({ label: "Delete", action: function () { onDelete(); } });
        })(featureType, featureIndex, feature);
      }
      var anyInGroup = selected.some(function (s) {
        var feat = getFeatureByTypeIndex(s.type, s.index);
        if (!feat || !feat.properties.attributes) return false;
        return feat.properties.attributes[UNIVERSAL_GROUP_KEY] ||
               (s.type === "label" && feat.properties.attributes[LABEL_GROUP_KEY]);
      });
      // Labels and non-labels use separate group namespaces and can never
      // usefully share a group, so a mixed selection gets no Group action.
      var mixedLabelSelection = selected.some(function (s) { return s.type === "label"; }) &&
                                 selected.some(function (s) { return s.type !== "label"; });
      if (!mixedLabelSelection) {
        var groupKey = selected[0].type === "label" ? LABEL_GROUP_KEY : UNIVERSAL_GROUP_KEY;
        options.push({
          label: anyInGroup ? "Move to Group…" : "Group…",
          action: function () { openGroupPicker(e.clientX, e.clientY, selected, groupKey, anyInGroup); }
        });
      }
      if (anyInGroup) {
        options.push({ label: "Ungroup", action: ungroupSelectedFeatures });
      }
      if (options.length) showContextMenu(e.clientX, e.clientY, options);
    });

    // DOM order: [type-icon] [name] [dup?] [eye] [gear] [trash]
    // eye/gear/trash are all position:absolute overlay chips (see .fp-item
    // > .fp-visibility-btn / .fp-gear-btn / .fp-del-btn in style.css) so none
    // of them reserve flow space — the type icon and name get the full row
    // width until hover reveals the cluster on the right.
    div.appendChild(typeIcon);
    div.appendChild(input);
    if (dupBtn) div.appendChild(dupBtn);
    div.appendChild(eyeBtn);
    div.appendChild(gearBtn);
    div.appendChild(trashBtn);
    return div;
  }

  /* ---- Section-level color swatches (Labels section only) ---- */

  var _labelSwatchBuilt = false;

  function buildLabelSectionSwatch() {
    if (_labelSwatchBuilt) return;
    _labelSwatchBuilt = true;

    var headers = document.querySelectorAll(".fp-section-header");
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].textContent.trim() !== "Labels and Text") continue;
      var header = headers[i];

      var sw = document.createElement("button");
      sw.className = "fp-swatch fp-section-swatch";
      var initColor = (App.sectionColors && App.sectionColors.label) || null;
      if (initColor) { sw.style.background = initColor; }
      else { sw.classList.add("fp-swatch-neutral"); }
      sw.title = "Set color for all labels";
      sw.setAttribute("aria-label", "Set color for all labels");
      sw.addEventListener("click", function (e) {
        e.stopPropagation();
        App.openColorPicker(sw, (App.sectionColors && App.sectionColors.label) || "", function (newColor) {
          if (!App.sectionColors) App.sectionColors = {};
          App.sectionColors.label = newColor;
          sw.classList.remove("fp-swatch-neutral");
          sw.style.background = newColor;
          var labels = App.labels || [];
          if (labels.length > 0) {
            var doOverride = confirm("Apply this color to all existing labels too?\n(OK = override all, Cancel = new only)");
            if (doOverride) {
              labels.forEach(function (f) { f.properties.color = newColor; f.properties.bgColor = newColor; });
              if (typeof App.renderLabelMarkers === "function") App.renderLabelMarkers();
            }
            refreshFeaturePanel();
          }
          if (App.cache && typeof App.cache.save === "function") App.cache.save();
        });
      });
      header.insertBefore(sw, header.firstChild);

      // Collapse toggle for Labels and Text section
      var stog = document.createElement("button");
      stog.className = "fp-section-toggle open";
      stog.innerHTML = CHEVRON_SVG;
      stog.title = "Collapse Labels and Text";
      stog.setAttribute("aria-label", "Collapse Labels and Text");
      stog.setAttribute("aria-expanded", "true");
      header.appendChild(stog);

      (function (hdr, tog, swBtn) {
        function toggleSection(e) {
          if (e.target === swBtn || swBtn.contains(e.target)) return;
          e.stopPropagation();
          var listEl = document.getElementById("fp-labels");
          var tbEl   = document.getElementById("fp-textboxes");
          var isOpen = !_collapsedSections.label;
          if (isOpen) {
            _collapsedSections.label = true;
            if (listEl) listEl.style.display = "none";
            if (tbEl)   tbEl.style.display   = "none";
            tog.classList.remove("open");
            tog.setAttribute("aria-expanded", "false");
            tog.setAttribute("aria-label", "Expand Labels and Text");
          } else {
            delete _collapsedSections.label;
            if (listEl) listEl.style.display = "";
            if (tbEl)   tbEl.style.display   = "";
            tog.classList.add("open");
            tog.setAttribute("aria-expanded", "true");
            tog.setAttribute("aria-label", "Collapse Labels and Text");
          }
        }
        tog.addEventListener("click", toggleSection);
        hdr.addEventListener("click", toggleSection);
      })(header, stog, sw);
      break;
    }
  }

  /* ---- Shared group header builder (supports mixed-type groups) ---- */

  // items: array of { feature, type, index }
  // groupKey: UNIVERSAL_GROUP_KEY or LABEL_GROUP_KEY
  function buildMixedGroupHeader(groupName, items, groupKey) {
    var header = document.createElement("div");
    header.className = "fp-group-header";

    var toggle = document.createElement("button");
    toggle.className = "fp-group-toggle";
    toggle.innerHTML = CHEVRON_SVG;
    toggle.setAttribute("aria-label", "Toggle group " + groupName);
    toggle.setAttribute("aria-expanded", "false");
    header.appendChild(toggle);

    // Group-level visibility eye — appended later (after the name), as a
    // position:absolute overlay chip alongside the trash button, so it
    // doesn't reserve flow space and the swatch/name can shift left.
    var allHidden = items.every(function (it) { return !!it.feature.properties.hidden; });
    var groupEye = document.createElement("button");
    groupEye.className = "fp-visibility-btn" + (allHidden ? " fp-eye-off" : "");
    groupEye.innerHTML = allHidden ? EYE_OFF_SVG : EYE_SVG;
    groupEye.title = allHidden ? "Show all" : "Hide all";
    groupEye.setAttribute("aria-label", (allHidden ? "Show" : "Hide") + " group " + groupName);
    groupEye.addEventListener("click", function (e) {
      e.stopPropagation();
      var hideAll = !items.every(function (it) { return !!it.feature.properties.hidden; });
      var typesChanged = {};
      items.forEach(function (it) {
        if (hideAll) { it.feature.properties.hidden = true; }
        else { delete it.feature.properties.hidden; }
        typesChanged[it.type] = true;
      });
      if (App.cache && typeof App.cache.save === "function") App.cache.save();
      Object.keys(typesChanged).forEach(function (t) { rerenderForType(t); });
    });

    // Color swatch — applies color to all features in the group
    var firstColor = items[0].feature.properties.color || getTypeDefaultColor(items[0].type);
    header.style.borderLeftColor = firstColor;
    var sw = document.createElement("button");
    sw.className = "fp-swatch fp-item-swatch";
    sw.style.background = firstColor;
    sw.title = "Change color for all in group";
    sw.setAttribute("aria-label", "Change color for group " + groupName);
    sw.addEventListener("click", function (e) {
      e.stopPropagation();
      var curColor = items[0].feature.properties.color || getTypeDefaultColor(items[0].type);
      App.openColorPicker(sw, curColor, function (newColor) {
        sw.style.background = newColor;
        header.style.borderLeftColor = newColor;
        var typesChanged = {};
        items.forEach(function (it) {
          it.feature.properties.color = newColor;
          typesChanged[it.type] = true;
        });
        // Labels also need bgColor synced
        items.forEach(function (it) {
          if (it.type === "label") it.feature.properties.bgColor = newColor;
        });
        Object.keys(typesChanged).forEach(function (t) { rerenderForType(t); });
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
      });
    });
    header.appendChild(sw);

    var nameSpan = document.createElement("span");
    nameSpan.className = "fp-group-name";
    nameSpan.textContent = groupName;
    nameSpan.title = "Double-click to rename";
    nameSpan.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "fp-group-name-edit";
      inp.value = nameSpan.textContent;
      nameSpan.style.display = "none";
      header.insertBefore(inp, nameSpan.nextSibling);
      inp.focus();
      inp.select();
      function save() {
        var newName = inp.value.trim();
        inp.remove();
        nameSpan.style.display = "";
        if (newName && newName !== nameSpan.textContent) {
          items.forEach(function (it) {
            if (!it.feature.properties.attributes) it.feature.properties.attributes = {};
            it.feature.properties.attributes[groupKey] = newName;
          });
          if (App.cache && typeof App.cache.save === "function") App.cache.save();
          if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        }
      }
      inp.addEventListener("blur", save);
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") inp.blur();
        if (ev.key === "Escape") { inp.value = nameSpan.textContent; inp.blur(); }
      });
    });
    header.appendChild(nameSpan);

    header.appendChild(groupEye);

    // Group delete button
    var groupTrashBtn = document.createElement("button");
    groupTrashBtn.className = "fp-del-btn";
    groupTrashBtn.title = "Delete all features in group";
    groupTrashBtn.setAttribute("aria-label", "Delete group " + groupName);
    groupTrashBtn.innerHTML = TRASH_SVG;
    groupTrashBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var groupDiv = header.parentElement;
      if (!groupDiv) return;
      var existing = groupDiv.querySelector(".fp-group-delete-confirm");
      if (existing) { existing.style.display = ""; return; }
      var confirmDiv = document.createElement("div");
      confirmDiv.className = "fp-delete-confirm fp-group-delete-confirm";
      var text = document.createElement("span");
      text.textContent = "Delete all " + items.length + " feature(s) in group?";
      var yesBtn = document.createElement("button");
      yesBtn.className = "fp-attr-confirm-yes";
      yesBtn.textContent = "Delete";
      yesBtn.addEventListener("click", function (e2) {
        e2.stopPropagation();
        // Sort by type then descending index to avoid index shifting issues
        var byType = {};
        items.forEach(function (it) {
          if (!byType[it.type]) byType[it.type] = [];
          byType[it.type].push(it.index);
        });
        Object.keys(byType).forEach(function (t) {
          var sorted = byType[t].sort(function (a, b) { return b - a; });
          var fn = getRemoveFnForType(t);
          sorted.forEach(function (idx) { if (fn) fn(idx); });
        });
        if (typeof App.onFeatureDelete === "function") App.onFeatureDelete();
      });
      var noBtn = document.createElement("button");
      noBtn.className = "fp-attr-confirm-no";
      noBtn.textContent = "Cancel";
      noBtn.addEventListener("click", function (e2) {
        e2.stopPropagation();
        confirmDiv.style.display = "none";
      });
      confirmDiv.appendChild(text);
      confirmDiv.appendChild(yesBtn);
      confirmDiv.appendChild(noBtn);
      var body = groupDiv.querySelector(".fp-group-body");
      groupDiv.insertBefore(confirmDiv, body || null);
    });
    header.appendChild(groupTrashBtn);

    return header;
  }

  function getRemoveFnForType(type) {
    var map = {
      point:   App.removePoint,
      line:    App.removeLine,
      route:   App.removeRoute,
      polygon: App.removePolygon,
      label:   App.removeLabel,
      textbox: App.removeTextBox
    };
    return map[type] || function () {};
  }

  /* ---- Collect all non-label features into unified list ---- */

  // Monotonic cross-type creation counter backing the "Date added" sort key.
  // Stamped lazily here (not at each of the four creation sites) so every
  // add path \u2014 which already calls refreshFeaturePanel() \u2014 picks it up for
  // free, and a session restored from before this field existed gets a
  // sensible legacy fallback (collect order) instead of an error.
  var _featureSeq = 0;

  function collectAllFeatures() {
    var all = [];
    (App.points || []).forEach(function (f, i) { all.push({ feature: f, type: "point", index: i }); });
    (App.lines    || []).forEach(function (f, i) { all.push({ feature: f, type: "line",    index: i }); });
    (App.routes   || []).forEach(function (f, i) { all.push({ feature: f, type: "route",   index: i }); });
    (App.polygons || []).forEach(function (f, i) { all.push({ feature: f, type: "polygon", index: i }); });

    // Seed the counter above the highest seq already present, then stamp
    // anything still missing one. Two passes so a restored session never
    // hands out a duplicate seq to a freshly-stamped feature.
    var i;
    for (i = 0; i < all.length; i++) {
      var p = all[i].feature.properties;
      if (typeof p.seq === "number" && p.seq >= _featureSeq) _featureSeq = p.seq + 1;
    }
    for (i = 0; i < all.length; i++) {
      var q = all[i].feature.properties;
      if (typeof q.seq !== "number") q.seq = _featureSeq++;
    }

    return all;
  }

  function featureSortKey(item) {
    var name = item.feature.properties.name || "";
    // Empty names sort to end
    return name ? name : "\uffff" + item.type + item.index;
  }

  // Name-only sort, unchanged from before the sort feature existed. Used by
  // the Labels and Text section (out of scope for user-selectable sorting)
  // and as the internal tiebreaker below.
  function sortItems(arr) {
    arr.sort(function (a, b) {
      return naturalSort(featureSortKey(a), featureSortKey(b));
    });
  }

  // ---- Mode-aware sort for the main Features list only ----
  // Rules: missing values for the active key always sink to the bottom in
  // both directions; name is always the final tiebreaker; descending
  // reverses the primary key only (never the tiebreaker, never the
  // missing-values rule).

  function sortValueForMode(item, modeId) {
    if (modeId === "type") {
      var r = TYPE_RANK[item.type];
      return { has: true, val: (r != null ? r : 99) };
    }
    if (modeId === "added") {
      var seq = item.feature.properties.seq;
      return (typeof seq === "number") ? { has: true, val: seq } : { has: false, val: null };
    }
    if (modeId === "group") {
      var g = item.feature.properties.attributes && item.feature.properties.attributes[UNIVERSAL_GROUP_KEY];
      return g ? { has: true, val: g } : { has: false, val: null };
    }
    // "name" (default/fallback)
    var name = item.feature.properties.name;
    return name ? { has: true, val: name } : { has: false, val: null };
  }

  function compareFeatureItems(a, b) {
    // Hidden-last sinks hidden features to the bottom ahead of everything
    // else, and stays sunk regardless of _sortAsc — same reasoning as the
    // missing-values rule below (a toggle for "out of the way," not a
    // reversible sort key).
    if (_hiddenLast) {
      var ah = !!a.feature.properties.hidden, bh = !!b.feature.properties.hidden;
      if (ah !== bh) return ah ? 1 : -1;
    }
    var av = sortValueForMode(a, _sortMode);
    var bv = sortValueForMode(b, _sortMode);
    if (av.has !== bv.has) return av.has ? -1 : 1;
    if (av.has) {
      var primary = (_sortMode === "added")
        ? (av.val - bv.val)
        : naturalSort(String(av.val), String(bv.val));
      if (!_sortAsc) primary = -primary;
      if (primary !== 0) return primary;
    }
    return naturalSort(featureSortKey(a), featureSortKey(b));
  }

  // Sorts `arr` in place by the current user-selected sort mode. Only used
  // by the main unified Features list \u2014 labels always use sortItems().
  function sortFeatureItems(arr) {
    arr.sort(compareFeatureItems);
  }

  /* ---- Build item wrapper with delete wiring ---- */

  function buildItemWrapperUnified(item, inGroup) {
    var wrapper = document.createElement("div");
    wrapper.className = "fp-item-wrapper" + (inGroup ? " fp-pattern" : "");
    var onDelete = (function (ft, idx) {
      return function () {
        if (typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen()) {
          var pf = typeof App.getAttrPopupFeature === "function" ? App.getAttrPopupFeature() : null;
          if (pf && pf.featureType === ft && pf.featureIndex === idx) App.closeAttrPopup();
        }
        var fn = getRemoveFnForType(ft);
        if (fn) fn(idx);
        if (typeof App.onFeatureDelete === "function") App.onFeatureDelete();
      };
    })(item.type, item.index);
    wrapper.appendChild(buildItem(item.feature, item.type, item.index, onDelete));
    return wrapper;
  }

  /* ---- Unified feature list rendering ---- */

  function populateUnifiedList() {
    var el = document.getElementById("fp-features");
    if (!el) return;
    el.innerHTML = "";

    var all = collectAllFeatures();
    if (!all.length) return;

    if (!_showGroups) {
      // Flattened view: no group headers, one continuous sorted list. This
      // is what makes a non-name sort (Type, Date added) read as a single
      // ranking instead of restarting inside every group.
      sortFeatureItems(all);
      all.forEach(function (it) { el.appendChild(buildItemWrapperUnified(it, false)); });
      return;
    }

    // Separate into groups and ungrouped
    var groups = {};
    var ungrouped = [];
    for (var i = 0; i < all.length; i++) {
      var a = all[i].feature.properties.attributes;
      var g = a && a[UNIVERSAL_GROUP_KEY];
      if (g) {
        if (!groups[g]) groups[g] = [];
        groups[g].push(all[i]);
      } else {
        ungrouped.push(all[i]);
      }
    }

    var groupNames = Object.keys(groups);
    if (_hiddenLast) {
      // A group that's entirely hidden sinks below every other group, same
      // "out of the way" rule compareFeatureItems applies to individual rows.
      groupNames.sort(function (a, b) {
        var ah = groups[a].every(function (it) { return !!it.feature.properties.hidden; });
        var bh = groups[b].every(function (it) { return !!it.feature.properties.hidden; });
        if (ah !== bh) return ah ? 1 : -1;
        return naturalSort(a, b);
      });
    } else {
      groupNames.sort(naturalSort);
    }

    // Sort items within each group and ungrouped by the active sort mode
    groupNames.forEach(function (gn) { sortFeatureItems(groups[gn]); });
    sortFeatureItems(ungrouped);

    // Render groups
    groupNames.forEach(function (groupName) {
      var items = groups[groupName];
      var groupDiv = document.createElement("div");
      groupDiv.className = "fp-group";

      var header = buildMixedGroupHeader(groupName, items, UNIVERSAL_GROUP_KEY);
      groupDiv.appendChild(header);

      var body = document.createElement("div");
      body.className = "fp-group-body";
      items.forEach(function (it) { body.appendChild(buildItemWrapperUnified(it, true)); });
      groupDiv.appendChild(body);

      // Default collapsed
      body.style.display = "none";
      var expandKey = "group:" + groupName;
      var gtoggle = header.querySelector(".fp-group-toggle");
      if (_expandedGroups[expandKey]) {
        body.style.display = "";
        if (gtoggle) {
          gtoggle.classList.add("open");
          gtoggle.setAttribute("aria-expanded", "true");
        }
      }

      var sw = header.querySelector(".fp-item-swatch");
      var headerEye = header.querySelector(".fp-visibility-btn");
      var headerTrash = header.querySelector(".fp-del-btn");
      function toggleGroup(e) {
        if (sw && (e.target === sw || sw.contains(e.target))) return;
        if (headerEye && (e.target === headerEye || headerEye.contains(e.target))) return;
        if (headerTrash && (e.target === headerTrash || headerTrash.contains(e.target))) return;
        e.stopPropagation();
        var isOpen = body.style.display !== "none";
        body.style.display = isOpen ? "none" : "";
        if (gtoggle) {
          gtoggle.classList.toggle("open", !isOpen);
          gtoggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
        }
        if (isOpen) { delete _expandedGroups[expandKey]; }
        else { _expandedGroups[expandKey] = true; }
      }
      if (gtoggle) gtoggle.addEventListener("click", toggleGroup);
      header.addEventListener("click", toggleGroup);

      el.appendChild(groupDiv);
    });

    // Render ungrouped items
    ungrouped.forEach(function (it) {
      el.appendChild(buildItemWrapperUnified(it, false));
    });
  }

  /* ---- Label grouped list (labels stay in their own section) ---- */

  function populateLabelGroupedList() {
    var containerId = "fp-labels";
    var el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = "";
    var features = App.labels || [];
    if (!features.length) return;

    var groups = {};
    var ungrouped = [];
    for (var i = 0; i < features.length; i++) {
      var a = features[i].properties.attributes;
      var g = a && a[LABEL_GROUP_KEY];
      if (g) {
        if (!groups[g]) groups[g] = [];
        groups[g].push({ feature: features[i], type: "label", index: i });
      } else {
        ungrouped.push({ feature: features[i], type: "label", index: i });
      }
    }

    var groupNames = Object.keys(groups);
    if (groupNames.length === 0) {
      // Flat list
      sortItems(ungrouped);
      ungrouped.forEach(function (it) { el.appendChild(buildItemWrapperUnified(it, false)); });
      return;
    }

    groupNames.sort(naturalSort);
    groupNames.forEach(function (gn) { sortItems(groups[gn]); });
    sortItems(ungrouped);

    groupNames.forEach(function (groupName) {
      var items = groups[groupName];
      var groupDiv = document.createElement("div");
      groupDiv.className = "fp-group";

      var header = buildMixedGroupHeader(groupName, items, LABEL_GROUP_KEY);
      groupDiv.appendChild(header);

      var body = document.createElement("div");
      body.className = "fp-group-body";
      items.forEach(function (it) { body.appendChild(buildItemWrapperUnified(it, true)); });
      groupDiv.appendChild(body);

      body.style.display = "none";
      var expandKey = "label:" + groupName;
      var gtoggle = header.querySelector(".fp-group-toggle");
      if (_expandedGroups[expandKey]) {
        body.style.display = "";
        if (gtoggle) {
          gtoggle.classList.add("open");
          gtoggle.setAttribute("aria-expanded", "true");
        }
      }

      var sw = header.querySelector(".fp-item-swatch");
      var headerEye = header.querySelector(".fp-visibility-btn");
      var headerTrash = header.querySelector(".fp-del-btn");
      function toggleGroup(e) {
        if (sw && (e.target === sw || sw.contains(e.target))) return;
        if (headerEye && (e.target === headerEye || headerEye.contains(e.target))) return;
        if (headerTrash && (e.target === headerTrash || headerTrash.contains(e.target))) return;
        e.stopPropagation();
        var isOpen = body.style.display !== "none";
        body.style.display = isOpen ? "none" : "";
        if (gtoggle) {
          gtoggle.classList.toggle("open", !isOpen);
          gtoggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
        }
        if (isOpen) { delete _expandedGroups[expandKey]; }
        else { _expandedGroups[expandKey] = true; }
      }
      if (gtoggle) gtoggle.addEventListener("click", toggleGroup);
      header.addEventListener("click", toggleGroup);

      el.appendChild(groupDiv);
    });

    // Ungrouped labels
    ungrouped.forEach(function (it) { el.appendChild(buildItemWrapperUnified(it, false)); });
  }

  function populateTextBoxList() {
    var el = document.getElementById("fp-textboxes");
    if (!el) return;
    el.innerHTML = "";
    var tbs = App.textBoxes || [];
    for (var i = 0; i < tbs.length; i++) {
      el.appendChild(buildItemWrapperUnified({ feature: tbs[i], type: "textbox", index: i }, false));
    }
  }

  function applySectionCollapse() {
    if (_collapsedSections.label) {
      var el = document.getElementById("fp-labels");
      if (el) el.style.display = "none";
      var tbEl = document.getElementById("fp-textboxes");
      if (tbEl) tbEl.style.display = "none";
    }
  }

  function refreshFeaturePanel() {
    buildLabelSectionSwatch(); // no-op after first call
    initSettingsCollapse();    // no-op after first call
    populateUnifiedList();
    populateLabelGroupedList();
    populateTextBoxList();
    applySectionCollapse();
    if (typeof App.applyPanelHighlight === "function") App.applyPanelHighlight();
  }

  /* ---- Feature Settings collapse toggle ---- */

  var _settingsCollapseWired = false;

  function initSettingsCollapse() {
    if (_settingsCollapseWired) return;
    _settingsCollapseWired = true;

    var header = document.querySelector(".fp-settings-header");
    if (!header) return;

    // Add chevron toggle
    var stog = document.createElement("button");
    stog.className = "fp-section-toggle";
    stog.innerHTML = CHEVRON_SVG;
    stog.title = "Toggle Feature Settings";
    stog.setAttribute("aria-label", "Collapse Feature Settings");
    stog.setAttribute("aria-expanded", "true");
    stog.classList.add("open");
    header.appendChild(stog);

    var body = header.nextElementSibling; // .fp-settings-body

    function toggle(e) {
      e.stopPropagation();
      var isOpen = body && body.style.display !== "none";
      if (body) body.style.display = isOpen ? "none" : "";
      stog.classList.toggle("open", !isOpen);
      stog.setAttribute("aria-expanded", isOpen ? "false" : "true");
      stog.setAttribute("aria-label", isOpen ? "Expand Feature Settings" : "Collapse Feature Settings");
    }
    stog.addEventListener("click", toggle);
    header.addEventListener("click", toggle);
  }

  /* ---- Features list sort control (button + right-click menu) ---- */

  function saveFeatureSortState() {
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  function setSortMode(id) {
    // Re-selecting the active key is a no-op — direction has its own
    // explicit toggle, so a repeat click must not silently flip it.
    if (_sortMode === id) return;
    _sortMode = id;
    saveFeatureSortState();
    refreshFeaturePanel();
  }

  function setSortAsc(asc) {
    _sortAsc = asc;
    saveFeatureSortState();
    refreshFeaturePanel();
  }

  function setShowGroups(show) {
    _showGroups = show;
    saveFeatureSortState();
    refreshFeaturePanel();
  }

  function setHiddenLast(v) {
    _hiddenLast = v;
    saveFeatureSortState();
    refreshFeaturePanel();
  }

  function buildSortMenuOptions() {
    var options = [];
    options.push({ divider: true, label: "Sort by" });
    SORT_MODES.forEach(function (m) {
      options.push({
        label: m.label,
        checked: _sortMode === m.id,
        action: function () { setSortMode(m.id); }
      });
    });
    options.push({ divider: true });
    options.push({
      label: "Ascending",
      checked: _sortAsc,
      action: function () { setSortAsc(!_sortAsc); }
    });
    options.push({
      label: "Show groups",
      checked: _showGroups,
      action: function () { setShowGroups(!_showGroups); }
    });
    options.push({
      label: "Hidden features to bottom",
      checked: _hiddenLast,
      action: function () { setHiddenLast(!_hiddenLast); }
    });
    return options;
  }

  App.refreshFeaturePanel = refreshFeaturePanel;
  App.getTypeDefaultColor = getTypeDefaultColor;
  App.showContextMenu     = showContextMenu;
  App.rerenderForType     = rerenderForType;
  // Shared with the Layers panel so it can list/group drawn features
  // without duplicating the collection + grouping logic.
  App.collectDrawnFeatures = collectAllFeatures;
  App.UNIVERSAL_GROUP_KEY  = UNIVERSAL_GROUP_KEY;

  // Session-cache read/write hooks for the Features list sort state
  // (mirrors the featureSettings pattern — see js/core/cache.js).
  App.getFeatureSortState = function () {
    return { mode: _sortMode, asc: _sortAsc, showGroups: _showGroups, hiddenLast: _hiddenLast };
  };
  App.restoreFeatureSortState = function (s) {
    if (!s) return;
    if (typeof s.mode === "string" && SORT_MODES.some(function (m) { return m.id === s.mode; })) {
      _sortMode = s.mode;
    }
    if (typeof s.asc === "boolean") _sortAsc = s.asc;
    if (typeof s.showGroups === "boolean") _showGroups = s.showGroups;
    if (typeof s.hiddenLast === "boolean") _hiddenLast = s.hiddenLast;
  };

  // Wire the Features | Layers tab bar
  (function () {
    var tabBtns = document.querySelectorAll(".fp-tab-btn");
    if (!tabBtns.length) return;
    var sortBtn = document.getElementById("fp-sort-btn");
    function show(tab) {
      tabBtns.forEach(function (b) {
        var selected = b.getAttribute("data-fptab") === tab;
        b.classList.toggle("active", selected);
        b.setAttribute("aria-selected", selected ? "true" : "false");
      });
      var fEl = document.getElementById("fp-tab-features");
      var lEl = document.getElementById("fp-tab-layers");
      if (fEl) fEl.style.display = tab === "features" ? "" : "none";
      if (lEl) lEl.style.display = tab === "layers" ? "" : "none";
      // Sorting only applies to the Features list, not the Layers tab.
      if (sortBtn) sortBtn.style.display = tab === "features" ? "" : "none";
      if (tab === "layers" && typeof App.refreshLayersPanel === "function") {
        App.refreshLayersPanel();
      }
    }
    tabBtns.forEach(function (b) {
      b.addEventListener("click", function () { show(b.getAttribute("data-fptab")); });
    });
  })();

  // Wire the Features list sort control: the header icon button, and a
  // right-click on the header as a second path to the same menu.
  (function () {
    var btn = document.getElementById("fp-sort-btn");
    var header = document.querySelector(".fp-header");
    if (!btn && !header) return;
    if (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var rect = btn.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 4, buildSortMenuOptions());
      });
    }
    if (header) {
      header.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, buildSortMenuOptions());
      });
    }
  })();

  // Wire feature panel collapse toggle
  (function () {
    var btn = document.getElementById('fp-collapse-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var panel = document.getElementById('feature-panel');
      var collapsed = panel.classList.toggle('fp-collapsed');
      btn.title = collapsed ? 'Show panel' : 'Hide panel';
      btn.setAttribute('aria-label', collapsed ? 'Show feature panel' : 'Hide feature panel');
    });
  })();
})();
