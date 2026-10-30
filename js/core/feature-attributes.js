// js/core/feature-attributes.js
// Attributes dock (left edge of the map, follows the selection) plus ATTR_FIELDS and the
// shared editors. Schema is duplicated in js/projects/attribute-summary.js: change both together.
// Detail: docs/reference/drawing-and-features.md
// Exports:
//   App.openAttrDock([featureType, featureIndex, feature])  (no args = current selection)
//   App.closeAttrDock([{keepSelection}])  (also clears the selection unless keepSelection)
//   App.syncAttrDock()   (re-target an open dock to the selection; never opens it)
//   App.isAttrDockOpen(), App.isAttrDockPinned(), App.attrDockInset()
//   App.getAttrDockFeature()  → { featureType, featureIndex } | null

(function () {
  var App = window.App = window.App || {};

  var TYPE_LABELS = {
    route:   "Route",
    line:    "Line",
    point:   "Point",
    polygon: "Polygon",
    label:   "Label",
    textbox: "Text Box"
  };

  // Service schedule day sections, rendered in this order
  var SERVICE_DAYS = [
    { id: "weekday",  label: "Weekday"  },
    { id: "saturday", label: "Saturday" },
    { id: "sunday",   label: "Sunday"   }
  ];

  // Transit-service fields shared by routes and lines (a Line can be attributed
  // as a transit pattern too). Tagged with a section so the dock renders a
  // "Transit service" header before them.
  var TRANSIT_FIELDS = [
    { key: "group",     label: "Group",     type: "text",   placeholder: "e.g. Corridor A", groupPicker: true, hidden: true },
    { key: "direction", label: "Direction", type: "select", options: ["Both","NB","SB","EB","WB","Inbound","Outbound","Loop","CW","CCW"] },
    { key: "mode",      label: "Mode",      type: "select", options: ["Bus","BRT","Light Rail","Streetcar"] },
    { key: "serviceId", label: "Service",   type: "text",   placeholder: "e.g. Blue Line", servicePicker: true },
    { key: "avgSpeed",  label: "Avg speed", type: "number", unit: "mph", defaultValue: 14 },
    { key: "runTime",   label: "Run time",  type: "number", unit: "min", placeholder: "e.g. 45" }
  ].map(function (f) { f.section = "Transit service"; return f; });

  // Per-feature buffer radius: study-area geometry, not appearance. Unlike every other field it lives on
  // feature.properties._bufferRadius, NOT feature.properties.attributes — the
  // type "buffer-radius" is rendered by App.buildBufferRadiusControl, which
  // never touches `attributes`.
  // skipIf: multi-select editing leaves walkshed points out (their buffer is
  // replaced by the walkshed; see js/core/attr-bulk.js R5).
  var BUFFER_FIELD = { key: "bufferRadius", label: "Buffer", type: "buffer-radius", section: "Study area",
                       skipIf: { attr: "serviceAreaType", equals: "walkshed" } };

  var ROUTE_FIELDS = TRANSIT_FIELDS.concat([BUFFER_FIELD]);

  // Fired when a Line's Walk network role changes (Not part of network <-> Walk
  // connector); re-welds the walk graph.
  function onNetworkRoleChange() {
    if (typeof App.refreshNetworkConnectors === "function") App.refreshNetworkConnectors();
  }

  // Lines share every Route field (a Line can be attributed as a transit
  // pattern too) plus one Walk network field Routes never get — Routes
  // already follow existing streets, so "connect this to the walk network"
  // is meaningless for them. See docs/archive/network-connectors-plan.md §2.
  var LINE_FIELDS = TRANSIT_FIELDS.concat([
    { key: "networkRole", label: "Walk network", type: "select", section: "Walk network",
      options: ["", "connector"],
      optionLabels: { "": "Not part of network", "connector": "Walk connector" },
      onChange: onNetworkRoleChange },
    BUFFER_FIELD
  ]);

  // Field definitions per feature type.
  // Supported types: "text", "number", "select", "checkboxes"
  var ATTR_FIELDS = {
    route: ROUTE_FIELDS,
    line:  LINE_FIELDS,
    point: [
      { key: "group",            label: "Group",    type: "text", placeholder: "e.g. North Corridor", groupPicker: true, hidden: true },
      // bulk: false = identity field, never edited across a multi-selection;
      // bulk: "replace" = complex editor, seeded from the first feature when Mixed.
      { key: "stopId",           label: "Stop ID",       type: "text", placeholder: "e.g. 1042", bulk: false },
      { key: "associatedRoutes", label: "Routes", bulk: "replace"                                 },
      { key: "serviceAreaType",  label: "Service area", type: "select", section: "Study area",
        options: ["", "walkshed"],
        optionLabels: { "": "Circular buffer", "walkshed": "Walkshed" },
        onChange: onServiceAreaChange },
      BUFFER_FIELD
    ],
    polygon: [
      { key: "group",  label: "Group",  type: "text", placeholder: "e.g. Study Area", groupPicker: true, hidden: true },
      { key: "notes",  label: "Notes",  type: "text", placeholder: "" }
    ],
    label: [
      { key: "labelGroup", label: "Label Group", type: "text",   placeholder: "e.g. Route Numbers", hidden: true },
      { key: "fontSize",   label: "Size",        type: "select", options: ["Small","Medium","Large","XL"] },
      { key: "bgColor",    label: "Background",  type: "color" },
      { key: "textColor",  label: "Text Color",  type: "color" }
    ],
    textbox: [
      { key: "fontSize",   label: "Size",        type: "select", options: ["Small","Medium","Large","XL"] },
      { key: "bgColor",    label: "Background",  type: "color" },
      { key: "textColor",  label: "Text Color",  type: "color" }
    ]
  };

  function saveAttrCache() {
    if (_muteSave) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  // Fired when a point's Service area type changes (Circular buffer ↔ Walkshed).
  // Recompute any walkshed-flagged points and rebuild buffers so the study-area
  // union (and every downstream demographic module) reflects the change. When no
  // road network is loaded the point stays flagged but falls back to its circle
  // until a walkshed is computed in the Walkshed module.
  function onServiceAreaChange() {
    if (typeof App.ensurePointWalksheds === "function") App.ensurePointWalksheds();
    if (typeof App.refreshBuffers === "function") App.refreshBuffers();
    if (typeof App.refreshBufferRadiusControls === "function") App.refreshBufferRadiusControls();
    if (typeof App.notifyProject === "function") App.notifyProject();
  }

  /* ---- Buffer radius control (shared with Attribute Summary) ---- */
  //
  // App.buildBufferRadiusControl(type, feature, opts) -> element (with .refresh())
  //   type: "point" | "line" | "route".  opts: { note: bool }
  // Shows the type default (Feature Settings) muted until
  // feature.properties._bufferRadius is set; the x clears the override. Reads
  // and writes properties._bufferRadius only (never attributes). The feature is
  // held as a stable {type, id} ref and resolved on every write.
  //
  // Timing: the buffers are rebuilt live on every tick (so the map follows a
  // drag), but the undo snapshot, cache save and App.notifyProject() (which
  // makes analysis modules mark themselves stale) happen once per GESTURE:
  // one drag, one +/- click, one typed value. A click/typed change is flushed on
  // the next tick; a drag is flushed on mouseup.
  //
  // A point flagged serviceAreaType "walkshed" has its buffer replaced by the
  // walkshed (points.js rebuildBuffers), so the control is disabled for it.
  var BUFFER_DEFAULT_KEYS = { point: "bufferRadius", line: "lineBufferRadius", route: "routeBufferRadius" };
  var BUFFER_ARRAYS = { point: "points", line: "lines", route: "routes" };
  var BUFFER_STEPS_FALLBACK = [0, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  var WALKSHED_NOTE = "Walkshed replaces the buffer";
  var _bufferControls = [];

  function typeDefaultBuffer(type) {
    var v = (App.featureSettings || {})[BUFFER_DEFAULT_KEYS[type]];
    return v != null ? v : 0;
  }

  // Rebuild one type's buffers at its type default (per-feature overrides are
  // applied inside the rebuild functions).
  function rebuildBuffersForType(type) {
    var fn = { point: "rebuildBuffers", line: "rebuildLineBuffers", route: "rebuildRouteBuffers" }[type];
    if (fn && typeof App[fn] === "function") App[fn](typeDefaultBuffer(type));
  }
  App.rebuildBuffersForType = rebuildBuffersForType;

  function buildBufferRadiusControl(type, feature, opts) {
    opts = opts || {};
    var arr = App[BUFFER_ARRAYS[type]] || [];
    var ref = App.featureRef(type, arr.indexOf(feature));
    var wrap = document.createElement("div");
    wrap.className = "fp-buffer-ctl";
    if (!ref) return wrap;

    function props() { var f = App.featureById(ref.type, ref.id); return f ? f.properties : null; }
    function isWalkshed() {
      var p = props();
      return type === "point" && !!p && !!p.attributes && p.attributes.serviceAreaType === "walkshed";
    }
    function currentValue() {
      var p = props();
      return (p && p._bufferRadius != null) ? p._bufferRadius : typeDefaultBuffer(type);
    }

    var dirty = false, dragging = false, timer = null;
    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!dirty) return;
      dirty = false;
      if (App.cache && typeof App.cache.save === "function") App.cache.save();
      if (typeof App.notifyProject === "function") App.notifyProject();
    }
    function schedule() {
      if (dragging || timer) return;
      timer = setTimeout(flush, 0);
    }
    function pushUndo() {
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
    }

    var scrubber = App.buildScrubber({
      values: App.BUFFER_RADIUS_STEPS || BUFFER_STEPS_FALLBACK,
      unit: "mi",
      value: currentValue(),
      onChange: function (v) {
        var p = props(); if (!p || isWalkshed()) return;
        if (!dirty) { pushUndo(); dirty = true; }
        p._bufferRadius = v;
        rebuildBuffersForType(type);
        syncState();
        schedule();
      }
    });
    wrap.appendChild(scrubber);

    // A drag spans mousedown..mouseup on the control; flush once at the end.
    scrubber.addEventListener("mousedown", function () {
      dragging = true;
      var up = function () {
        document.removeEventListener("mouseup", up, true);
        dragging = false;
        flush();
      };
      document.addEventListener("mouseup", up, true);
    });

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "lp-style-clear";
    clearBtn.title = "Clear override (use the default buffer radius)";
    clearBtn.setAttribute("aria-label", "Clear buffer override");
    clearBtn.textContent = "\u00d7";
    clearBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var p = props(); if (!p || p._bufferRadius == null) return;
      flush();
      pushUndo();
      delete p._bufferRadius;
      rebuildBuffersForType(type);
      scrubber.refresh(currentValue());
      syncState();
      dirty = true;
      flush();
    });
    wrap.appendChild(clearBtn);

    var note = null;
    if (opts.note) {
      note = document.createElement("span");
      note.className = "fp-buffer-note";
      note.textContent = WALKSHED_NOTE;
      wrap.appendChild(note);
    }

    function syncState() {
      var p = props();
      var has = !!p && p._bufferRadius != null;
      var ws = isWalkshed();
      wrap.classList.toggle("is-inherited", !has);
      wrap.classList.toggle("is-disabled", ws);
      wrap.title = ws ? WALKSHED_NOTE : "";
      clearBtn.style.display = (has && !ws) ? "" : "none";
      Array.prototype.forEach.call(scrubber.querySelectorAll("input,button"), function (el) { el.disabled = ws; });
      if (note) note.style.display = ws ? "" : "none";
    }
    wrap.refresh = function () {
      scrubber.refresh(currentValue());
      syncState();
    };
    syncState();
    if (_bufferControls.length > 40) _bufferControls = _bufferControls.filter(function (c) { return c.isConnected; });
    _bufferControls.push(wrap);
    return wrap;
  }
  App.buildBufferRadiusControl = buildBufferRadiusControl;

  // Re-sync every live control (e.g. after a point's Service area type changes).
  App.refreshBufferRadiusControls = function () {
    _bufferControls = _bufferControls.filter(function (c) { return c.isConnected; });
    _bufferControls.forEach(function (c) { c.refresh(); });
  };

  function buildBufferField(field, feature, featureType) {
    return { el: buildBufferRadiusControl(featureType, feature, { note: true }), unit: null };
  }

  /* ---- Field builders ---- */

  function buildSelect(field, attrs) {
    var sel = document.createElement("select");
    sel.className = "fp-attr-input";
    var val = attrs[field.key];
    var noVal = (val === undefined || val === null || val === "");
    field.options.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = (field.optionLabels && (opt in field.optionLabels))
        ? field.optionLabels[opt]
        : (opt === "" ? "—" : opt);
      if (opt === "" ? noVal : val === opt) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      attrs[field.key] = sel.value === "" ? null : sel.value;
      saveAttrCache();
      if (typeof field.onChange === "function") field.onChange(attrs);
    });
    return { el: sel, unit: null };
  }

  function buildCheckboxes(field, attrs) {
    var checked = Array.isArray(attrs[field.key]) ? attrs[field.key] : [];
    var wrapper = document.createElement("div");
    wrapper.className = "fp-attr-checks";
    field.options.forEach(function (opt) {
      var lbl = document.createElement("label");
      lbl.className = "fp-attr-check-label";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked.indexOf(opt) >= 0;
      cb.addEventListener("change", function () {
        var cur = Array.isArray(attrs[field.key]) ? attrs[field.key].slice() : [];
        if (cb.checked) {
          if (cur.indexOf(opt) < 0) cur.push(opt);
        } else {
          cur = cur.filter(function (x) { return x !== opt; });
        }
        attrs[field.key] = cur;
        saveAttrCache();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode("\u00a0" + opt));
      wrapper.appendChild(lbl);
    });
    return { el: wrapper, unit: null };
  }

  function buildRoutePickerContent(attrs) {
    var container = document.createElement("div");
    container.className = "fp-route-picker";

    var routes = App.routes || [];
    var lines  = App.lines  || [];

    if (!routes.length && !lines.length) {
      var msg = document.createElement("span");
      msg.className = "fp-attr-unit";
      msg.textContent = "No routes or lines drawn";
      container.appendChild(msg);
      return container;
    }

    var current = attrs.associatedRoutes || [];

    function makeCheck(featureType, feature, idProp) {
      var fid  = feature.properties[idProp];
      var name = feature.properties.name;
      var lbl  = document.createElement("label");
      lbl.className = "fp-route-picker-label";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = current.some(function (r) {
        return r.featureType === featureType && r.featureId === fid;
      });
      cb.addEventListener("change", function () {
        var cur = attrs.associatedRoutes || [];
        if (cb.checked) {
          cur = cur.concat([{ featureType: featureType, featureId: fid, name: name }]);
        } else {
          cur = cur.filter(function (r) {
            return !(r.featureType === featureType && r.featureId === fid);
          });
        }
        attrs.associatedRoutes = cur;
        saveAttrCache();
      });
      var dot = document.createElement("span");
      dot.className = "fp-route-picker-dot";
      dot.style.background = App.resolveFeatureColor(featureType, feature);
      lbl.appendChild(cb);
      lbl.appendChild(dot);
      lbl.appendChild(document.createTextNode("\u00a0" + name));
      container.appendChild(lbl);
    }

    routes.forEach(function (r) { makeCheck("route", r, "routeIdx"); });
    lines.forEach(function  (l) { makeCheck("line",  l, "lineIdx");  });

    return container;
  }

  // Compact pill button that shows the count of associated routes.
  // Clicking opens the route-picker popup.
  function buildRouteBadge(attrs, anchorRefresh) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fp-route-badge";
    function refresh() {
      var n = (attrs.associatedRoutes || []).length;
      btn.textContent = n === 0 ? "Add routes" : n === 1 ? "1 route" : (n + " routes");
      if (anchorRefresh) anchorRefresh(n);
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      App.openRoutePickerPopup(attrs, btn, refresh);
    });
    refresh();
    return { el: btn, unit: null, refresh: refresh };
  }

  function buildTextOrNumber(field, attrs) {
    var inp = document.createElement("input");
    inp.type = field.type === "number" ? "number" : "text";
    inp.className = "fp-attr-input";
    if (field.placeholder) inp.placeholder = field.placeholder;
    if (field.type === "number") { inp.min = "0"; inp.step = "1"; }
    var val = attrs[field.key];
    inp.value = (val !== undefined && val !== null) ? val : "";
    inp.addEventListener("change", function () {
      attrs[field.key] = field.type === "number"
        ? (inp.value !== "" ? parseFloat(inp.value) : null)
        : inp.value;
      saveAttrCache();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") inp.blur();
    });
    return { el: inp, unit: field.unit || null };
  }

  function buildGroupPicker(field, attrs, feature) {
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "fp-attr-input";
    if (field.placeholder) inp.placeholder = field.placeholder;
    var val = attrs[field.key];
    inp.value = (val !== undefined && val !== null) ? val : "";

    // Build/refresh a shared datalist with all existing group names
    var dlId = "fp-rg-datalist";
    var dl = document.getElementById(dlId);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = dlId;
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    var seen = {};
    (App.routes || []).forEach(function (r) {
      var g = r.properties.attributes && r.properties.attributes.routeGroup;
      if (g && !seen[g]) {
        seen[g] = true;
        var opt = document.createElement("option");
        opt.value = g;
        dl.appendChild(opt);
      }
    });
    inp.setAttribute("list", dlId);

    inp.addEventListener("change", function () {
      var newVal = inp.value.trim();
      if (newVal) {
        attrs[field.key] = newVal;
        // Inherit color from an existing route in the same group
        var existingColor = null;
        (App.routes || []).forEach(function (r) {
          if (!existingColor && r.properties.color && r.properties !== feature.properties) {
            var g = r.properties.attributes && r.properties.attributes.routeGroup;
            if (g === newVal) existingColor = r.properties.color;
          }
        });
        if (existingColor) {
          feature.properties.color = existingColor;
          rebuildBuffersForType("route");
        }
      } else {
        delete attrs[field.key];
      }
      saveAttrCache();
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") inp.blur();
    });
    return { el: inp, unit: null };
  }

  function buildGenericGroupPicker(field, attrs, featureType) {
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "fp-attr-input";
    if (field.placeholder) inp.placeholder = field.placeholder;
    var val = attrs[field.key];
    inp.value = (val !== undefined && val !== null) ? val : "";

    var TYPE_TO_ARRAY = { point: "points", line: "lines", polygon: "polygons" };
    var dlId = "fp-" + featureType + "-group-datalist";
    var dl = document.getElementById(dlId);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = dlId;
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    var seen = {};
    (App[TYPE_TO_ARRAY[featureType]] || []).forEach(function (f) {
      var g = f.properties.attributes && f.properties.attributes[field.key];
      if (g && !seen[g]) {
        seen[g] = true;
        var opt = document.createElement("option");
        opt.value = g;
        dl.appendChild(opt);
      }
    });
    inp.setAttribute("list", dlId);

    inp.addEventListener("change", function () {
      var newVal = inp.value.trim();
      if (newVal) {
        attrs[field.key] = newVal;
      } else {
        delete attrs[field.key];
      }
      saveAttrCache();
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") inp.blur();
    });
    return { el: inp, unit: null };
  }

  function buildColorPicker(field, attrs, feature) {
    var btn = document.createElement("button");
    btn.className = "fp-attr-color-swatch";
    btn.style.background = attrs[field.key] || (field.key === "textColor" ? "#ffffff" : "#1a202c");
    btn.title = field.label;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App.openColorPicker === "function") {
        App.openColorPicker(btn, attrs[field.key] || btn.style.background, function (newColor) {
          attrs[field.key] = newColor;
          btn.style.background = newColor;
          // Sync bgColor → feature.properties for swatch display
          if (field.key === "bgColor") { feature.properties.bgColor = newColor; feature.properties.color = newColor; }
          if (field.key === "textColor") feature.properties.textColor = newColor;
          saveAttrCache();
          // Fire change event so body-level listener can update marker appearance
          btn.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
    });
    return { el: btn, unit: null };
  }

  function buildLabelGroupPicker(field, attrs, feature) {
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "fp-attr-input";
    if (field.placeholder) inp.placeholder = field.placeholder;
    var val = attrs[field.key];
    inp.value = (val !== undefined && val !== null) ? val : "";

    var dlId = "fp-lg-datalist";
    var dl = document.getElementById(dlId);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = dlId;
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    var seen = {};
    (App.labels || []).forEach(function (l) {
      var g = l.properties.attributes && l.properties.attributes.labelGroup;
      if (g && !seen[g]) {
        seen[g] = true;
        var opt = document.createElement("option");
        opt.value = g;
        dl.appendChild(opt);
      }
    });
    inp.setAttribute("list", dlId);

    inp.addEventListener("change", function () {
      var newVal = inp.value.trim();
      if (newVal) {
        attrs[field.key] = newVal;
        // Inherit color from an existing label in the same group
        var existingColor = null;
        (App.labels || []).forEach(function (l) {
          if (!existingColor && l.properties.color && l.properties !== feature.properties) {
            var g = l.properties.attributes && l.properties.attributes.labelGroup;
            if (g === newVal) existingColor = l.properties.color;
          }
        });
        if (existingColor) {
          feature.properties.color = existingColor;
          feature.properties.bgColor = existingColor;
          if (typeof App.updateLabelAppearance === "function") {
            var idx = (App.labels || []).indexOf(feature);
            if (idx >= 0) App.updateLabelAppearance(idx);
          }
        }
      } else {
        delete attrs[field.key];
      }
      saveAttrCache();
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") inp.blur();
    });
    return { el: inp, unit: null };
  }

  function buildUniversalGroupPicker(field, attrs, feature, featureType) {
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "fp-attr-input";
    if (field.placeholder) inp.placeholder = field.placeholder;
    var val = attrs[field.key];
    inp.value = (val !== undefined && val !== null) ? val : "";

    // Build datalist with all existing universal group names across all feature types
    var dlId = "fp-universal-group-datalist";
    var dl = document.getElementById(dlId);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = dlId;
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    var seen = {};
    var allArrays = [App.points || [], App.lines || [], App.routes || [], App.polygons || []];
    allArrays.forEach(function (arr) {
      arr.forEach(function (f) {
        var g = f.properties.attributes && f.properties.attributes.group;
        if (g && !seen[g]) {
          seen[g] = true;
          var opt = document.createElement("option");
          opt.value = g;
          dl.appendChild(opt);
        }
      });
    });
    inp.setAttribute("list", dlId);

    inp.addEventListener("change", function () {
      var newVal = inp.value.trim();
      if (newVal) {
        attrs[field.key] = newVal;
        // Inherit color from an existing feature in the same group (any type)
        var existingColor = null;
        allArrays.forEach(function (arr) {
          arr.forEach(function (f) {
            if (!existingColor && f.properties.color && f.properties !== feature.properties) {
              var g = f.properties.attributes && f.properties.attributes.group;
              if (g === newVal) existingColor = f.properties.color;
            }
          });
        });
        if (existingColor) {
          feature.properties.color = existingColor;
          // Trigger re-render for this feature type
          if (typeof App.updateFeatureColor === "function") {
            // Find this feature's index in its array
            var arrMap = { point: App.points, line: App.lines, route: App.routes, polygon: App.polygons };
            var arr = arrMap[featureType] || [];
            var idx = arr.indexOf(feature);
            if (idx >= 0) App.updateFeatureColor(featureType, idx, existingColor);
          }
        }
      } else {
        delete attrs[field.key];
      }
      saveAttrCache();
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") inp.blur();
    });
    return { el: inp, unit: null };
  }

  // Route + Line only datalist for the Service field. Suggestions come from
  // existing serviceId values on routes and lines (not points/polygons).
  // Same color-inheritance side effect as the universal group picker so that
  // pattern pairs (e.g. NB + SB) under one Service share a color automatically.
  function buildServicePicker(field, attrs, feature, featureType) {
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "fp-attr-input";
    if (field.placeholder) inp.placeholder = field.placeholder;
    var val = attrs[field.key];
    inp.value = (val !== undefined && val !== null) ? val : "";

    var dlId = "fp-service-datalist";
    var dl = document.getElementById(dlId);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = dlId;
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    var seen = {};
    var routeArrays = [App.routes || [], App.lines || []];
    routeArrays.forEach(function (arr) {
      arr.forEach(function (f) {
        var s = f.properties.attributes && f.properties.attributes.serviceId;
        if (s && !seen[s]) {
          seen[s] = true;
          var opt = document.createElement("option");
          opt.value = s;
          dl.appendChild(opt);
        }
      });
    });
    inp.setAttribute("list", dlId);

    inp.addEventListener("change", function () {
      var newVal = inp.value.trim();
      if (newVal) {
        attrs[field.key] = newVal;
        var existingColor = null;
        routeArrays.forEach(function (arr) {
          arr.forEach(function (f) {
            if (!existingColor && f.properties.color && f.properties !== feature.properties) {
              var s = f.properties.attributes && f.properties.attributes.serviceId;
              if (s === newVal) existingColor = f.properties.color;
            }
          });
        });
        if (existingColor) {
          feature.properties.color = existingColor;
          if (typeof App.updateFeatureColor === "function") {
            var arrMap = { route: App.routes, line: App.lines };
            var arr = arrMap[featureType] || [];
            var idx = arr.indexOf(feature);
            if (idx >= 0) App.updateFeatureColor(featureType, idx, existingColor);
          }
        }
      } else {
        delete attrs[field.key];
      }
      saveAttrCache();
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") inp.blur();
    });
    return { el: inp, unit: null };
  }

  /* ---- Service schedule (Weekday / Saturday / Sunday time bands) ---- */

  function _emptyBand() {
    return { from: "", to: "", frequency: null };
  }

  function _ensureService(attrs) {
    if (!attrs.service) {
      attrs.service = {
        weekday:  [_emptyBand()],
        saturday: [],
        sunday:   [],
        sundayMirrorsSaturday: false
      };
    } else {
      if (!Array.isArray(attrs.service.weekday))  attrs.service.weekday  = [];
      if (!Array.isArray(attrs.service.saturday)) attrs.service.saturday = [];
      if (!Array.isArray(attrs.service.sunday))   attrs.service.sunday   = [];
    }
    return attrs.service;
  }

  function buildServiceSchedule(attrs) {
    var svc = _ensureService(attrs);

    var container = document.createElement("div");
    container.className = "fp-svc";

    var sectionEls = {}; // id → { bandsEl, addBtn, mirrorWrap }

    SERVICE_DAYS.forEach(function (day) {
      var section = document.createElement("div");
      section.className = "fp-svc-section";
      section.dataset.day = day.id;

      // "+ Add time band" sits on the day's title line, not its own row.
      var title = document.createElement("div");
      title.className = "fp-svc-section-title";
      var titleText = document.createElement("span");
      titleText.textContent = day.label;
      title.appendChild(titleText);
      section.appendChild(title);

      var header = document.createElement("div");
      header.className = "fp-svc-header";
      ["FROM", "TO", "FREQUENCY"].forEach(function (h) {
        var s = document.createElement("span");
        s.textContent = h;
        header.appendChild(s);
      });
      section.appendChild(header);

      var bandsEl = document.createElement("div");
      bandsEl.className = "fp-svc-bands";
      section.appendChild(bandsEl);

      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "fp-svc-add";
      addBtn.textContent = "+ Add time band";
      addBtn.addEventListener("click", function () {
        svc[day.id].push(_emptyBand());
        renderBands(day.id);
        saveAttrCache();
      });
      title.appendChild(addBtn);

      sectionEls[day.id] = { bandsEl: bandsEl, addBtn: addBtn, section: section };
      container.appendChild(section);
    });

    // Mirror Saturday toggle (inside the Sunday section)
    var sundaySection = sectionEls.sunday.section;
    var mirrorWrap = document.createElement("label");
    mirrorWrap.className = "fp-svc-mirror";
    var mirrorCb = document.createElement("input");
    mirrorCb.type = "checkbox";
    mirrorCb.checked = !!svc.sundayMirrorsSaturday;
    mirrorWrap.appendChild(mirrorCb);
    mirrorWrap.appendChild(document.createTextNode(" Mirror Saturday"));
    sundaySection.appendChild(mirrorWrap);
    sectionEls.sunday.mirrorCb = mirrorCb;

    var mirrorPreview = document.createElement("div");
    mirrorPreview.className = "fp-svc-mirror-preview";
    sundaySection.insertBefore(mirrorPreview, sectionEls.sunday.bandsEl.nextSibling);
    sectionEls.sunday.mirrorPreview = mirrorPreview;

    mirrorCb.addEventListener("change", function () {
      svc.sundayMirrorsSaturday = mirrorCb.checked;
      applySundayMirrorState();
      saveAttrCache();
    });

    function renderBand(dayId, bandIdx) {
      var band = svc[dayId][bandIdx];
      var row = document.createElement("div");
      row.className = "fp-svc-band";

      var fromInp = document.createElement("input");
      fromInp.type = "text";
      fromInp.className = "fp-svc-time";
      fromInp.placeholder = "HH:MM";
      fromInp.maxLength = 5;
      fromInp.pattern = "^([01][0-9]|2[0-3]):[0-5][0-9]$";
      fromInp.value = band.from || "";
      fromInp.addEventListener("input", function () {
        var v = fromInp.value.replace(/[^0-9:]/g, "");
        if (/^\d{2}$/.test(v)) v = v + ":";
        fromInp.value = v;
      });
      fromInp.addEventListener("blur", function () {
        band.from = /^\d{2}:\d{2}$/.test(fromInp.value) ? fromInp.value : "";
        if (dayId === "saturday") refreshSundayMirrorPreview();
        saveAttrCache();
      });

      var toInp = document.createElement("input");
      toInp.type = "text";
      toInp.className = "fp-svc-time";
      toInp.placeholder = "HH:MM";
      toInp.maxLength = 5;
      toInp.pattern = "^([01][0-9]|2[0-3]):[0-5][0-9]$";
      toInp.value = band.to || "";
      toInp.addEventListener("input", function () {
        var v = toInp.value.replace(/[^0-9:]/g, "");
        if (/^\d{2}$/.test(v)) v = v + ":";
        toInp.value = v;
      });
      toInp.addEventListener("blur", function () {
        band.to = /^\d{2}:\d{2}$/.test(toInp.value) ? toInp.value : "";
        if (dayId === "saturday") refreshSundayMirrorPreview();
        saveAttrCache();
      });

      var everyInp = document.createElement("input");
      everyInp.type = "number";
      everyInp.className = "fp-svc-every";
      everyInp.min = "1";
      everyInp.step = "1";
      everyInp.value = (band.frequency != null) ? band.frequency : "";
      everyInp.addEventListener("change", function () {
        band.frequency = everyInp.value !== "" ? parseFloat(everyInp.value) : null;
        if (dayId === "saturday") refreshSundayMirrorPreview();
        saveAttrCache();
      });

      var unit = document.createElement("span");
      unit.className = "fp-svc-unit";
      unit.textContent = "min";

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "fp-svc-del";
      delBtn.title = "Remove time band";
      delBtn.innerHTML = "&times;";
      delBtn.addEventListener("click", function () {
        svc[dayId].splice(bandIdx, 1);
        renderBands(dayId);
        if (dayId === "saturday") refreshSundayMirrorPreview();
        saveAttrCache();
      });

      row.appendChild(fromInp);
      row.appendChild(toInp);
      row.appendChild(everyInp);
      row.appendChild(unit);
      row.appendChild(delBtn);
      return row;
    }

    function renderBands(dayId) {
      var bandsEl = sectionEls[dayId].bandsEl;
      bandsEl.innerHTML = "";
      svc[dayId].forEach(function (_, i) {
        bandsEl.appendChild(renderBand(dayId, i));
      });
    }

    function refreshSundayMirrorPreview() {
      if (!svc.sundayMirrorsSaturday) return;
      var preview = sectionEls.sunday.mirrorPreview;
      preview.innerHTML = "";
      if (!svc.saturday.length) {
        var empty = document.createElement("div");
        empty.className = "fp-svc-mirror-empty";
        empty.textContent = "Saturday has no service bands.";
        preview.appendChild(empty);
        return;
      }
      svc.saturday.forEach(function (band) {
        var row = document.createElement("div");
        row.className = "fp-svc-band fp-svc-band-readonly";
        var f = document.createElement("span"); f.className = "fp-svc-time-ro"; f.textContent = band.from || "—";
        var t = document.createElement("span"); t.className = "fp-svc-time-ro"; t.textContent = band.to || "—";
        var e = document.createElement("span"); e.className = "fp-svc-every-ro"; e.textContent = (band.frequency != null) ? band.frequency : "—";
        var u = document.createElement("span"); u.className = "fp-svc-unit";   u.textContent = "min";
        row.appendChild(f); row.appendChild(t); row.appendChild(e); row.appendChild(u);
        preview.appendChild(row);
      });
    }

    function applySundayMirrorState() {
      var s = sectionEls.sunday;
      if (svc.sundayMirrorsSaturday) {
        s.bandsEl.style.display = "none";
        s.addBtn.style.display = "none";
        s.mirrorPreview.style.display = "";
        refreshSundayMirrorPreview();
      } else {
        s.bandsEl.style.display = "";
        s.addBtn.style.display = "";
        s.mirrorPreview.style.display = "none";
        s.mirrorPreview.innerHTML = "";
      }
    }

    // Initial render
    SERVICE_DAYS.forEach(function (day) { renderBands(day.id); });
    applySundayMirrorState();

    return container;
  }

  function buildFieldInput(field, attrs, feature, featureType) {
    if (field.type === "buffer-radius") return buildBufferField(field, feature, featureType);
    if (field.key === "associatedRoutes") return buildRouteBadge(attrs);
    if (field.type === "select")      return buildSelect(field, attrs);
    if (field.type === "checkboxes")  return buildCheckboxes(field, attrs);
    if (field.type === "color")       return buildColorPicker(field, attrs, feature);
    if (field.groupPicker)            return buildUniversalGroupPicker(field, attrs, feature, featureType);
    if (field.servicePicker)          return buildServicePicker(field, attrs, feature, featureType);
    if (field.key === "labelGroup")   return buildLabelGroupPicker(field, attrs, feature);
    return buildTextOrNumber(field, attrs);
  }

  function buildRow(labelText, inputEl, unitText) {
    var row = document.createElement("div");
    row.className = "fp-attr-row";
    var lbl = document.createElement("label");
    lbl.className = "fp-attr-label";
    lbl.textContent = labelText;
    row.appendChild(lbl);
    row.appendChild(inputEl);
    if (unitText) {
      var unit = document.createElement("span");
      unit.className = "fp-attr-unit";
      unit.textContent = unitText;
      row.appendChild(unit);
    }
    return row;
  }

  function fmtLength(miles) {
    if (miles < 0.1) {
      var ft = miles * 5280;
      return ft < 10 ? ft.toFixed(1) + " ft" : Math.round(ft) + " ft";
    }
    return miles < 10 ? miles.toFixed(2) + " mi" : miles.toFixed(1) + " mi";
  }

  function fmtArea(sqMeters) {
    var acres   = sqMeters * 0.000247105;
    var sqMiles = sqMeters * 3.861e-7;
    if (acres < 1)   return Math.round(sqMeters).toLocaleString() + " m\u00B2";
    if (acres < 640) return acres.toFixed(1) + " acres";
    return sqMiles.toFixed(2) + " mi\u00B2";
  }

  function buildReadOnlyValue(text) {
    var span = document.createElement("span");
    span.className = "fp-attr-unit";
    span.textContent = text;
    return span;
  }

  /* ---- Attributes dock (singleton, left edge of the map) ---- */
  //
  // The dock shows the current selection: one feature's attributes, or a member
  // list for a multi-selection. Gestures (map click, Features-list row click,
  // finishing a drawing) OPEN it via App.openAttrDock; selection changes only
  // RE-TARGET an already-open dock via App.syncAttrDock, so a programmatic
  // selection never pops it open. Closing it clears the selection, keeping the
  // two in step. Text boxes are the one exception: they are not selectable, so a
  // text-box dock lives without a selection until something else is clicked.

  var _dockEl  = null;
  var _cur     = null;   // { type, index, feature } shown, or { multi: true, list }
  var _closing = false;  // re-entrance guard: closeAttrDock → clearSelection → syncAttrDock

  var LS_PINNED    = "attrDock.pinned";
  var LS_COLLAPSED = "attrDock.collapsed";

  function lsGet(key) {
    try { return window.localStorage.getItem(key) === "1"; } catch (e) { return false; }
  }
  function lsSet(key, on) {
    try { window.localStorage.setItem(key, on ? "1" : "0"); } catch (e) {}
  }

  function featureFor(type, index) {
    var arr = { point: App.points, line: App.lines, route: App.routes, polygon: App.polygons,
                label: App.labels, textbox: App.textBoxes }[type];
    return (arr && arr[index]) || null;
  }

  var ICON_PIN = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6l-1 5 3 3H5l3-3z"></path><line x1="10" y1="11" x2="10" y2="17"></line></svg>';
  var ICON_COLLAPSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><polyline points="12,5 7,10 12,15"></polyline></svg>';

  function buildDockEl() {
    if (_dockEl) return;

    var el = document.createElement("aside");
    el.id = "attr-dock";
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Feature attributes");
    el.style.display = "none";

    var header = document.createElement("div");
    header.className = "ad-header";
    var headRow = document.createElement("div");
    headRow.className = "ad-head-row";
    header.appendChild(headRow);

    var swatchSlot = document.createElement("div");
    swatchSlot.className = "ad-swatch-slot";
    headRow.appendChild(swatchSlot);

    var titles = document.createElement("div");
    titles.className = "ad-titles";
    // The feature name, edited in place (read-only for a multi-selection).
    var titleEl = document.createElement("input");
    titleEl.type = "text";
    titleEl.className = "ad-title";
    titleEl.setAttribute("aria-label", "Name");
    titleEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") titleEl.blur();
      if (e.key === "Escape") { titleEl.value = titleEl.defaultValue; titleEl.blur(); e.stopPropagation(); }
    });
    var typeEl = document.createElement("div");
    typeEl.className = "ad-type";
    titles.appendChild(titleEl);
    titles.appendChild(typeEl);
    headRow.appendChild(titles);

    var actions = document.createElement("div");
    actions.className = "ad-actions";

    function iconBtn(cls, html, label) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ad-btn " + cls;
      b.innerHTML = html;
      b.setAttribute("aria-label", label);
      b.title = label;
      return b;
    }

    var pinBtn = iconBtn("ad-pin", ICON_PIN, "Pin open");
    pinBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setPinned(!el.classList.contains("ad-pinned"));
    });
    actions.appendChild(pinBtn);

    var collapseBtn = iconBtn("ad-collapse", ICON_COLLAPSE, "Collapse attributes");
    collapseBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setCollapsed(!el.classList.contains("ad-collapsed"));
    });
    actions.appendChild(collapseBtn);

    var closeBtn = iconBtn("ad-close", "&times;", "Close attributes");
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeAttrDock();
    });
    actions.appendChild(closeBtn);
    headRow.appendChild(actions);

    // Feature actions (Zoom to, Duplicate, …), rebuilt per render.
    var toolbar = document.createElement("div");
    toolbar.className = "ad-toolbar";
    header.appendChild(toolbar);
    el.appendChild(header);

    var body = document.createElement("div");
    body.className = "ad-body";
    el.appendChild(body);

    // Docked inside the map row so it overlays the map's left edge and never
    // covers the toolbar or the Features panel.
    var host = document.getElementById("main-content") || document.body;
    host.appendChild(el);
    _dockEl = el;

    setPinned(lsGet(LS_PINNED));
    setCollapsed(lsGet(LS_COLLAPSED));
  }

  function setPinned(on) {
    if (!_dockEl) return;
    _dockEl.classList.toggle("ad-pinned", on);
    var b = _dockEl.querySelector(".ad-pin");
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.title = on ? "Unpin (map clicks close the panel)" : "Pin open";
    lsSet(LS_PINNED, on);
  }

  function setCollapsed(on) {
    if (!_dockEl) return;
    _dockEl.classList.toggle("ad-collapsed", on);
    var b = _dockEl.querySelector(".ad-collapse");
    b.setAttribute("aria-expanded", on ? "false" : "true");
    b.setAttribute("aria-label", on ? "Expand attributes" : "Collapse attributes");
    b.title = on ? "Expand" : "Collapse";
    lsSet(LS_COLLAPSED, on);
    syncAppClasses();
  }

  // #app classes let CSS move left-edge map controls clear of the dock.
  function syncAppClasses() {
    var app = document.getElementById("app");
    if (!app) return;
    var open = isDockOpen();
    app.classList.toggle("ad-open", open);
    app.classList.toggle("ad-rail", open && !!_dockEl && _dockEl.classList.contains("ad-collapsed"));
  }

  function isDockOpen() { return !!(_dockEl && _dockEl.style.display !== "none"); }

  // A half-typed value commits on blur ("change"); blur before the body is
  // replaced or hidden so closing the dock can never drop an edit.
  function commitActiveEdit() {
    var a = document.activeElement;
    if (_dockEl && a && _dockEl.contains(a) && typeof a.blur === "function") a.blur();
  }

  function freshBody() {
    // A new element per render: per-feature listeners on the body (cycle
    // estimate, label sync) must not outlive the feature they were built for.
    var old = _dockEl.querySelector(".ad-body");
    var body = document.createElement("div");
    body.className = "ad-body";
    old.parentNode.replaceChild(body, old);
    return body;
  }

  // Header: swatch, name, type line. onRename(newName) makes the name editable.
  function setHeader(title, typeText, swatchColor, swatchFn, onRename) {
    var titleEl = _dockEl.querySelector(".ad-title");
    titleEl.value = title;
    titleEl.defaultValue = title;
    titleEl.readOnly = !onRename;
    titleEl.title = onRename ? "Rename" : "";
    titleEl.onchange = onRename ? function () { onRename(titleEl.value); titleEl.defaultValue = titleEl.value; } : null;
    _dockEl.querySelector(".ad-type").textContent = typeText;
    var slot = _dockEl.querySelector(".ad-swatch-slot");
    slot.innerHTML = "";
    if (!swatchColor) return;
    var sw = document.createElement("button");
    sw.type = "button";
    sw.className = "ad-swatch";
    sw.style.background = swatchColor;
    sw.setAttribute("aria-label", "Appearance");
    sw.title = "Appearance";
    sw.addEventListener("click", function (e) {
      e.stopPropagation();
      swatchFn(sw);
    });
    slot.appendChild(sw);
  }

  // items: [{ label, action, cls?, title? }] → text buttons in the header toolbar.
  function setToolbar(items) {
    var bar = _dockEl.querySelector(".ad-toolbar");
    bar.innerHTML = "";
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ad-tool" + (it.cls ? " " + it.cls : "");
      b.textContent = it.label;
      if (it.title) b.title = it.title;
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        it.action(b);
      });
      bar.appendChild(b);
    });
  }

  /* ---- Collapsible sections (open/closed remembered per label) ---- */

  var LS_SECTIONS = "attrDock.closedSections";
  function closedSections() {
    try { return JSON.parse(window.localStorage.getItem(LS_SECTIONS) || "{}") || {}; } catch (e) { return {}; }
  }
  function rememberSection(label, closed) {
    var m = closedSections();
    if (closed) m[label] = true; else delete m[label];
    try { window.localStorage.setItem(LS_SECTIONS, JSON.stringify(m)); } catch (e) {}
  }

  // Appends a section to body and returns its content element.
  function addSection(body, label) {
    var sec = document.createElement("section");
    sec.className = "ad-section";
    sec.setAttribute("data-section", label);
    var head = document.createElement("button");
    head.type = "button";
    head.className = "ad-section-head";
    // Same ▾ caret as every other panel's disclosure (style.css .ad-caret).
    head.innerHTML = '<span class="ad-caret" aria-hidden="true">&#9662;</span>';
    var lbl = document.createElement("span");
    lbl.textContent = label;
    head.appendChild(lbl);
    var content = document.createElement("div");
    content.className = "ad-section-body";
    function setClosed(closed) {
      sec.classList.toggle("ad-section-closed", closed);
      head.setAttribute("aria-expanded", closed ? "false" : "true");
    }
    setClosed(!!closedSections()[label]);
    head.addEventListener("click", function () {
      var closed = !sec.classList.contains("ad-section-closed");
      setClosed(closed);
      rememberSection(label, closed);
    });
    sec.appendChild(head);
    sec.appendChild(content);
    body.appendChild(sec);
    return content;
  }

  /* ---- Overlapping features under the last map click ---- */

  // { anchor: {type,index}, others: [{type,index}] } set by editing.js just
  // before it opens the dock; shown only while the dock shows the anchor.
  var _overlaps = null;
  App.setAttrDockOverlaps = function (anchor, others) {
    _overlaps = (anchor && others && others.length) ? { anchor: anchor, others: others.slice() } : null;
  };

  function overlapItem(featureType, featureIndex) {
    if (!_overlaps || _overlaps.anchor.type !== featureType || _overlaps.anchor.index !== featureIndex) return null;
    var others = _overlaps.others.filter(function (o) { return featureFor(o.type, o.index); });
    if (!others.length) return null;
    return {
      label: others.length + " more here ▾",
      cls: "ad-tool-more",
      title: "Other features under the click",
      action: function (btn) {
        var r = btn.getBoundingClientRect();
        var all = [_overlaps.anchor].concat(others);
        App.showContextMenu(r.left, r.bottom + 4, others.map(function (o) {
          var f = featureFor(o.type, o.index);
          return {
            label: (f.properties.name || TYPE_LABELS[o.type]) + " · " + TYPE_LABELS[o.type],
            action: function () {
              App.setAttrDockOverlaps(o, all.filter(function (x) { return x !== o; }));
              if (typeof App.selectFeature === "function") App.selectFeature(o.type, o.index);
            }
          };
        }));
      }
    };
  }

  /* ---- Info sections ---- */

  // Read-only rows are tighter than editable field rows (no input box to fit).
  function infoRow(content, label, text) {
    var row = buildRow(label, buildReadOnlyValue(text), null);
    row.classList.add("ad-info-row");
    content.appendChild(row);
    return row;
  }

  function featureId(featureType, feature) {
    var prop = App.FEATURE_ID_PROP && App.FEATURE_ID_PROP[featureType];
    return prop ? feature.properties[prop] : null;
  }

  function buildMeasurements(body, featureType, feature, attrs) {
    var g = feature.geometry;
    if (!g || !g.coordinates) return;
    if (featureType === "point") {
      var c = addSection(body, "Measurements");
      infoRow(c, "Location", g.coordinates[1].toFixed(5) + ", " + g.coordinates[0].toFixed(5));
      return;
    }
    if (featureType === "route" || featureType === "line") {
      var lenMi = 0;
      try { if (g.coordinates.length >= 2) lenMi = turf.length(feature, { units: "miles" }); } catch (e) {}
      var m = addSection(body, "Measurements");
      var wps = feature.properties.waypoints;
      var nPts = featureType === "route" && Array.isArray(wps) ? wps.length : g.coordinates.length;
      infoRow(m, "Length", (lenMi > 0 ? fmtLength(lenMi) + " \u00B7 " : "") +
        nPts + (featureType === "route" ? " waypoints" : " vertices"));
      var cycleSpan = infoRow(m, "Cycle est.", "\u2014").querySelector(".fp-attr-unit");
      function refreshCycleEst() {
        var spd = parseFloat(attrs.avgSpeed);
        var rt  = parseFloat(attrs.runTime);
        var dir = attrs.direction || "Both";
        var isLoop = (dir === "Loop" || dir === "CW" || dir === "CCW");
        var isBoth = (dir === "Both");
        var label  = isBoth ? "cycle" : isLoop ? "loop" : "one-way";
        var parts  = [];
        if (spd > 0 && lenMi > 0) {
          var owMin  = lenMi / spd * 60;
          parts.push(Math.round(isBoth ? owMin * 2 : owMin) + " min " + label + " · speed");
        }
        if (rt > 0) parts.push(rt + " min " + label + " · manual");
        cycleSpan.textContent = parts.length ? parts.join("  ·  ") : "—";
      }
      refreshCycleEst();
      body.addEventListener("change", refreshCycleEst);
      return;
    }
    if (featureType === "polygon" && g.coordinates[0] && g.coordinates[0].length >= 3) {
      var ring = g.coordinates[0];
      var p = addSection(body, "Measurements");
      infoRow(p, "Area", fmtArea(turf.area(feature)));
      infoRow(p, "Perimeter", fmtLength(turf.length(turf.lineString(ring), { units: "miles" })) +
        " \u00B7 " + (ring.length - 1) + " vertices");
    }
  }

  function buildUsedIn(body, featureType, feature) {
    var id = featureId(featureType, feature);
    if (id == null || typeof App.describeFeatureUsage !== "function") return;
    var uses = App.describeFeatureUsage(featureType, id);
    var c = addSection(body, "Used in");
    if (!uses.length) {
      var none = document.createElement("div");
      none.className = "ad-empty";
      none.textContent = "Not used by any analysis";
      c.appendChild(none);
      return;
    }
    var ul = document.createElement("ul");
    ul.className = "ad-usage";
    uses.forEach(function (u) {
      var li = document.createElement("li");
      li.className = u.severity === "warn" ? "ad-usage-warn" : "";
      var mod = document.createElement("strong");
      mod.textContent = u.module;
      li.appendChild(mod);
      // Providers often repeat their module name at the start of the label.
      var text = u.label;
      if (u.module && text.indexOf(u.module) === 0) text = text.slice(u.module.length).replace(/^\s*[·:—-]\s*/, "");
      if (text) li.appendChild(document.createTextNode((u.module ? " — " : "") + text));
      ul.appendChild(li);
    });
    c.appendChild(ul);
  }

  function buildDetails(body, featureType, featureIndex, feature, attrs) {
    var c = addSection(body, "Details");
    var id = featureId(featureType, feature);
    if (id != null) infoRow(c, "Feature ID", (TYPE_LABELS[featureType] || featureType) + " " + id);
    var grp = attrs.group || attrs.labelGroup;
    if (grp) infoRow(c, "Group", grp);
    if (feature.properties.hidden) infoRow(c, "Visibility", "Hidden on the map");
    if (App.merge && App.merge.hasHistory && App.merge.hasHistory(featureType, featureIndex)) {
      var d = App.merge.describeUnmerge(featureType, featureIndex);
      var wrap = document.createElement("span");
      wrap.className = "ad-merged";
      wrap.appendChild(buildReadOnlyValue("Merged from " + (d.originals ? d.originals.length : "?") + " features"));
      var un = document.createElement("button");
      un.type = "button";
      un.className = "ad-link";
      un.textContent = "Unmerge…";
      un.addEventListener("click", function () { App.merge.openUnmergeDialog(featureType, featureIndex); });
      wrap.appendChild(un);
      var mr = buildRow("Merge", wrap, null);
      mr.classList.add("ad-info-row");
      c.appendChild(mr);
    }
    // The Attribute Summary link sits at the end of Details (not a separate
    // footer) to keep a typical route's dock within one screen.
    buildFooter(c);
  }

  function buildFooter(body) {
    var foot = document.createElement("div");
    foot.className = "ad-footer";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ad-link";
    b.textContent = "Open in Attribute Summary";
    b.addEventListener("click", function () {
      if (typeof App.openAttributeSummary === "function") App.openAttributeSummary();
    });
    foot.appendChild(b);
    body.appendChild(foot);
  }

  var DUPLICATE_FNS = { point: "duplicatePoint", line: "duplicateLine", route: "duplicateRoute",
                        polygon: "duplicatePolygon", label: "duplicateLabel" };

  function singleToolbar(featureType, featureIndex, feature) {
    var items = [];
    var drawn = !!(App.FEATURE_ID_PROP && App.FEATURE_ID_PROP[featureType]);
    if (drawn && App.bulkFeatures) {
      items.push({ label: "Zoom to", action: function () {
        App.bulkFeatures.zoomTo([{ type: featureType, index: featureIndex }]);
      } });
    }
    var dup = App[DUPLICATE_FNS[featureType]];
    if (typeof dup === "function") {
      items.push({ label: "Duplicate", action: function () {
        if (featureType === "label" && App.undo && !App.undo.isRestoring()) App.undo.push();
        dup(featureIndex);
      } });
    }
    if (drawn && App.bulkFeatures) {
      var hidden = !!feature.properties.hidden;
      items.push({ label: hidden ? "Show" : "Hide", action: function () {
        App.bulkFeatures.setHidden([{ type: featureType, index: featureIndex }], !hidden);
        renderSingle(featureType, featureIndex, feature);
      } });
    }
    if (drawn && typeof App.deleteFeature === "function") {
      items.push({ label: "Delete", cls: "ad-tool-danger", action: function () {
        App.deleteFeature(featureType, featureIndex);
      } });
    }
    var more = overlapItem(featureType, featureIndex);
    if (more) items.push(more);
    return items;
  }

  function renameFeature(featureType, featureIndex, feature, name) {
    feature.properties.name = name;
    // Keep the feature row's fp-name display in sync
    var items = document.querySelectorAll(".fp-item");
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (el.dataset.featureType === featureType &&
          parseInt(el.dataset.featureIndex, 10) === featureIndex) {
        var rowName = el.querySelector(".fp-name");
        if (rowName) rowName.textContent = name;
        break;
      }
    }
    // For labels, name IS the displayed map text — update the marker
    if (featureType === "label" && typeof App.updateLabelAppearance === "function") {
      App.updateLabelAppearance(featureIndex);
    }
    saveAttrCache();
  }

  function renderSingle(featureType, featureIndex, feature) {
    if (_overlaps && (_overlaps.anchor.type !== featureType || _overlaps.anchor.index !== featureIndex)) _overlaps = null;
    setHeader(feature.properties.name || "",
      TYPE_LABELS[featureType] || featureType,
      App.resolveFeatureColor(featureType, feature),
      function (sw) {
        if (typeof App.openAppearancePopup === "function") {
          App.openAppearancePopup(sw, featureType, featureIndex, {
            onChange: function () { sw.style.background = App.resolveFeatureColor(featureType, feature); }
          });
        }
      },
      function (name) { renameFeature(featureType, featureIndex, feature, name); });
    _dockEl.querySelector(".ad-title").placeholder = TYPE_LABELS[featureType] || featureType;
    setToolbar(singleToolbar(featureType, featureIndex, feature));

    var body = freshBody();

    // Lazy-init attributes
    if (!feature.properties.attributes) feature.properties.attributes = {};
    var attrs = feature.properties.attributes;

    // Seed field defaults for any missing values (e.g. avgSpeed = 14 mph)
    var typeFields = ATTR_FIELDS[featureType] || [];
    var seededDefault = false;
    typeFields.forEach(function (f) {
      if (f.defaultValue !== undefined && (attrs[f.key] === undefined || attrs[f.key] === null || attrs[f.key] === "")) {
        attrs[f.key] = f.defaultValue;
        seededDefault = true;
      }
    });
    if (seededDefault) saveAttrCache();

    // Fields without a `section` go in a leading "Attributes" section.
    var current = null, currentLabel = null;
    typeFields.forEach(function (field) {
      if (field.hidden) return;
      var label = field.section || "Attributes";
      if (label !== currentLabel) {
        current = addSection(body, label);
        currentLabel = label;
      }
      var result = buildFieldInput(field, attrs, feature, featureType);
      current.appendChild(buildRow(field.label, result.el, result.unit));
    });

    // Service schedule (routes and lines only) — full-width
    if (featureType === "route" || featureType === "line") {
      addSection(body, "Service schedule").appendChild(buildServiceSchedule(attrs));
    }

    buildMeasurements(body, featureType, feature, attrs);
    buildUsedIn(body, featureType, feature);
    buildDetails(body, featureType, featureIndex, feature, attrs);

    // Label/textbox: sync attribute changes to marker appearance
    if (featureType === "label" || featureType === "textbox") {
      body.addEventListener("change", function () {
        if (attrs.fontSize  !== undefined) feature.properties.fontSize  = attrs.fontSize;
        if (attrs.bgColor   !== undefined) { feature.properties.bgColor = attrs.bgColor; feature.properties.color = attrs.bgColor; }
        if (attrs.textColor !== undefined) feature.properties.textColor = attrs.textColor;
        var updFn = featureType === "label" ? App.updateLabelAppearance : App.updateTextBoxAppearance;
        if (typeof updFn === "function") updFn(featureIndex);
      });
    }

    _cur = { type: featureType, index: featureIndex, feature: feature };
  }

  /* ---- Multi-selection: shared-field editing (rules in js/core/attr-bulk.js) ---- */

  // The service schedule is not an ATTR_FIELDS row (it renders full-width), so
  // multi mode adds it as a pseudo-field for routes and lines.
  var SERVICE_PSEUDO = { key: "service", label: "Service schedule", type: "service", bulk: "replace", section: "Service schedule" };
  function bulkFieldsByType() {
    var out = {};
    Object.keys(ATTR_FIELDS).forEach(function (t) {
      out[t] = (t === "route" || t === "line") ? ATTR_FIELDS[t].concat([SERVICE_PSEUDO]) : ATTR_FIELDS[t];
    });
    return out;
  }
  function fieldDef(type, key) {
    var list = bulkFieldsByType()[type] || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  // Inner saveAttrCache() calls are muted while a seeded "Replace all…" editor
  // is open: they edit a scratch copy, and the one real undo step is taken
  // when the copy is applied.
  var _muteSave = false;

  // Write value to every eligible item as ONE undo step, run each distinct
  // field onChange once, then save / refresh / re-render the dock.
  function bulkWrite(items, key, value) {
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    var hooks = [], types = {};
    items.forEach(function (it) {
      var field = fieldDef(it.type, key);
      if (!field || !window.AttrBulk.eligible(field, it.feature)) return;
      var p = it.feature.properties;
      types[it.type] = true;
      if (field.type === "buffer-radius") {
        if (value === null) delete p._bufferRadius; else p._bufferRadius = value;
      } else {
        if (!p.attributes) p.attributes = {};
        var v = (value && typeof value === "object") ? JSON.parse(JSON.stringify(value)) : value;
        if (v === null || v === "") delete p.attributes[key]; else p.attributes[key] = v;
        // Labels mirror their style attributes onto properties for the marker.
        if (it.type === "label" || it.type === "textbox") {
          if (key === "fontSize") p.fontSize = v;
          if (key === "bgColor") { p.bgColor = v; p.color = v; }
          if (key === "textColor") p.textColor = v;
          var upd = it.type === "label" ? App.updateLabelAppearance : App.updateTextBoxAppearance;
          if (typeof upd === "function") upd(it.index);
        }
      }
      if (typeof field.onChange === "function" && hooks.indexOf(field.onChange) < 0) hooks.push(field.onChange);
    });
    if (key === "bufferRadius") Object.keys(types).forEach(rebuildBuffersForType);
    hooks.forEach(function (fn) { try { fn(items[0].feature.properties.attributes || {}); } catch (e) {} });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (typeof App.notifyProject === "function") App.notifyProject();
    syncAttrDock();
  }

  // One editor row for a shared field. a = an AttrBulk.analyze entry.
  function buildBulkRow(a, items, field) {
    var mixed = a.state === "mixed";
    var none = a.state === "none";
    var el, unit = field.unit || null;
    function commit(v) { bulkWrite(items, a.key, v); }

    if (a.bulk === "replace") {
      el = document.createElement("button");
      el.type = "button";
      el.className = "ad-replace";
      el.textContent = mixed ? "Mixed · Replace all…" : "Edit all…";
      el.title = mixed ? "Opens with the first selected feature's values; saving copies them to all" : "";
      el.addEventListener("click", function () { openReplaceEditor(a, items, el); });
    } else if (a.type === "select") {
      el = document.createElement("select");
      el.className = "fp-attr-input";
      if (mixed) {
        var m = document.createElement("option");
        m.value = "\u0000mixed"; m.textContent = "Mixed"; m.disabled = true; m.selected = true;
        el.appendChild(m);
      }
      (field.options || []).forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt;
        o.textContent = (field.optionLabels && (opt in field.optionLabels)) ? field.optionLabels[opt] : (opt === "" ? "—" : opt);
        if (!mixed && (opt === "" ? (a.value === null || a.value === "") : a.value === opt)) o.selected = true;
        el.appendChild(o);
      });
      el.addEventListener("change", function () { commit(el.value === "" ? null : el.value); });
    } else if (a.type === "color") {
      el = document.createElement("button");
      el.type = "button";
      el.className = "fp-attr-color-swatch" + (mixed ? " ad-swatch-mixed" : "");
      if (!mixed) el.style.background = a.value || (a.key === "textColor" ? "#ffffff" : "#1a202c");
      el.title = mixed ? "Mixed" : field.label;
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        if (typeof App.openColorPicker === "function") {
          App.openColorPicker(el, a.value || "#1a202c", function (c) { commit(c); });
        }
      });
    } else if (a.type === "buffer-radius") {
      el = document.createElement("input");
      el.type = "number";
      el.min = "0"; el.step = "0.125";
      el.className = "fp-attr-input";
      el.placeholder = mixed ? "Mixed" : "Default";
      el.title = "Empty = the type's default radius";
      if (!mixed && a.value !== null) el.value = a.value;
      unit = "mi";
      el.addEventListener("change", function () {
        var v = el.value === "" ? null : parseFloat(el.value);
        commit(v === null || isNaN(v) ? null : Math.max(0, v));
      });
    } else {
      el = document.createElement("input");
      el.type = a.type === "number" ? "number" : "text";
      el.className = "fp-attr-input";
      if (a.type === "number") { el.min = "0"; el.step = "1"; }
      el.placeholder = mixed ? "Mixed" : (field.placeholder || "");
      if (!mixed && a.value !== null) el.value = a.value;
      if (a.key === "serviceId") el.setAttribute("list", "fp-service-datalist");
      el.addEventListener("change", function () {
        if (a.type === "number") commit(el.value === "" ? null : parseFloat(el.value));
        else commit(el.value.trim() === "" ? null : el.value.trim());
      });
    }
    el.addEventListener("keydown", function (e) { if (e.key === "Enter" && el.blur) el.blur(); });
    if (none) { el.disabled = true; el.title = "Not editable for these features"; }

    var row = buildRow(a.label, el, unit);
    if (!none && a.eligible < a.total) {
      var note = document.createElement("div");
      note.className = "ad-bulk-note";
      var skipped = a.total - a.eligible;
      note.textContent = "Skips " + skipped + (skipped === 1 ? " feature" : " features") +
        (a.key === "bufferRadius" ? " with a walkshed" : "");
      var wrap = document.createElement("div");
      wrap.appendChild(row);
      wrap.appendChild(note);
      return wrap;
    }
    return row;
  }

  // R6: edit a scratch copy seeded from the first eligible feature; on close,
  // copy it to every eligible feature if anything changed.
  function openReplaceEditor(a, items, anchor) {
    var seedItem = null;
    for (var i = 0; i < items.length; i++) {
      if (window.AttrBulk.eligible(fieldDef(items[i].type, a.key), items[i].feature)) { seedItem = items[i]; break; }
    }
    if (!seedItem) return;
    var seedAttrs = JSON.parse(JSON.stringify(seedItem.feature.properties.attributes || {}));
    var before = JSON.stringify(seedAttrs[a.key] === undefined ? null : seedAttrs[a.key]);
    _muteSave = true;
    // Closing the editor unchanged writes nothing, even when values were Mixed.
    function done() {
      _muteSave = false;
      var after = seedAttrs[a.key] === undefined ? null : seedAttrs[a.key];
      if (JSON.stringify(after) !== before) bulkWrite(items, a.key, after);
    }
    if (a.key === "service") {
      App.openTimeBandsPopup({ properties: { name: items.length + " features", attributes: seedAttrs } }, anchor, done);
    } else {
      App.openRoutePickerPopup(seedAttrs, anchor, done);
    }
  }

  function renderMulti(list) {
    _overlaps = null;
    setHeader(list.length + " features selected", "Selection", null, null, null);
    var usable = App.bulkFeatures ? App.bulkFeatures.usable(list) : [];
    setToolbar(usable.length && App.bulkFeatures
      ? App.bulkFeatures.groupMenuItems(usable).map(function (it) {
          return { label: it.label, action: it.action, cls: /^Delete/.test(it.label) ? "ad-tool-danger" : "" };
        })
      : []);
    var body = freshBody();

    var items = [];
    list.forEach(function (s) {
      var f = featureFor(s.type, s.index);
      if (f) items.push({ type: s.type, index: s.index, feature: f });
    });

    // Type chips: click one to narrow the selection to that type.
    var counts = window.AttrBulk.typeCounts(items);
    if (counts.length > 1) {
      var chips = document.createElement("div");
      chips.className = "ad-chips";
      counts.forEach(function (c) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "ad-chip";
        b.textContent = c.count + " " + (TYPE_LABELS[c.type] || c.type) + (c.count === 1 ? "" : "s");
        b.title = "Select only these";
        b.addEventListener("click", function () {
          var only = list.filter(function (s) { return s.type === c.type; });
          if (typeof App.setSelection === "function") App.setSelection(only);
        });
        chips.appendChild(b);
      });
      body.appendChild(chips);
    }

    var shared = window.AttrBulk.analyze(bulkFieldsByType(), items);
    if (!shared.length) {
      var hint = document.createElement("div");
      hint.className = "ad-empty";
      hint.textContent = counts.length > 1
        ? "These feature types share no attributes. Pick a type above to edit its fields."
        : "No attributes to edit together.";
      body.appendChild(hint);
    }
    var current = null, currentLabel = null;
    shared.forEach(function (a) {
      var label = a.section || "Attributes";
      if (label !== currentLabel) { current = addSection(body, label); currentLabel = label; }
      current.appendChild(buildBulkRow(a, items, fieldDef(items[0].type, a.key)));
    });

    // Totals
    var lenMi = 0, areaM2 = 0;
    items.forEach(function (it) {
      try {
        if (it.type === "line" || it.type === "route") lenMi += turf.length(it.feature, { units: "miles" });
        if (it.type === "polygon") areaM2 += turf.area(it.feature);
      } catch (e) {}
    });
    if (lenMi > 0 || areaM2 > 0) {
      var m = addSection(body, "Measurements");
      if (lenMi > 0) infoRow(m, "Total length", fmtLength(lenMi));
      if (areaM2 > 0) infoRow(m, "Total area", fmtArea(areaM2));
    }

    var ms = addSection(body, "Selection");
    var ul = document.createElement("ul");
    ul.className = "ad-members";
    items.forEach(function (s) {
      var f = s.feature;
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ad-member";
      var dot = document.createElement("span");
      dot.className = "ad-member-dot";
      try { dot.style.background = App.resolveFeatureColor(s.type, f); } catch (e) {}
      var nm = document.createElement("span");
      nm.className = "ad-member-name";
      nm.textContent = f.properties.name || (TYPE_LABELS[s.type] || s.type);
      var ty = document.createElement("span");
      ty.className = "ad-member-type";
      ty.textContent = TYPE_LABELS[s.type] || s.type;
      b.appendChild(dot); b.appendChild(nm); b.appendChild(ty);
      b.addEventListener("click", function () {
        if (typeof App.selectFeature === "function") App.selectFeature(s.type, s.index);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    ms.appendChild(ul);
    buildFooter(body);
    _cur = { multi: true, list: list.slice() };
  }

  function show() {
    _dockEl.style.display = "";
    syncAppClasses();
  }

  /* ---- Public API ---- */

  // Gesture entry point. With a target, shows that feature; without one, shows
  // the current selection.
  function openAttrDock(featureType, featureIndex, feature) {
    buildDockEl();
    commitActiveEdit();
    if (featureType) {
      feature = feature || featureFor(featureType, featureIndex);
      if (!feature) return;
      renderSingle(featureType, featureIndex, feature);
    } else {
      var sel = typeof App.getSelectedFeatures === "function" ? App.getSelectedFeatures() : [];
      if (!sel.length) return;
      if (sel.length === 1) {
        var f = featureFor(sel[0].type, sel[0].index);
        if (!f) return;
        renderSingle(sel[0].type, sel[0].index, f);
      } else {
        renderMulti(sel);
      }
    }
    show();
  }

  // opts.keepSelection: hide only (used when the selection already emptied).
  function closeAttrDock(opts) {
    if (!_dockEl || _closing) return;
    _closing = true;
    try {
      commitActiveEdit();
      _dockEl.style.display = "none";
      _cur = null;
      syncAppClasses();
      if (!(opts && opts.keepSelection) && typeof App.clearSelection === "function") App.clearSelection();
    } finally {
      _closing = false;
    }
  }

  // Follow the selection while open. Re-renders only when the shown feature
  // actually changed (index, or the object itself after an undo restore), so a
  // field being typed into is not rebuilt underneath the user.
  function syncAttrDock() {
    if (!isDockOpen() || _closing) return;
    var sel = typeof App.getSelectedFeatures === "function" ? App.getSelectedFeatures() : [];
    if (!sel.length) {
      if (_cur && _cur.type === "textbox" && featureFor("textbox", _cur.index) === _cur.feature) return;
      closeAttrDock({ keepSelection: true });
      return;
    }
    if (sel.length === 1) {
      var s = sel[0];
      var f = featureFor(s.type, s.index);
      if (!f) { closeAttrDock({ keepSelection: true }); return; }
      if (_cur && !_cur.multi && _cur.type === s.type && _cur.index === s.index && _cur.feature === f) return;
      commitActiveEdit();
      renderSingle(s.type, s.index, f);
      return;
    }
    commitActiveEdit();
    renderMulti(sel);
  }

  App.openAttrDock   = openAttrDock;
  App.closeAttrDock  = closeAttrDock;
  App.syncAttrDock   = syncAttrDock;
  App.isAttrDockOpen = isDockOpen;
  App.isAttrDockPinned = function () { return !!(_dockEl && _dockEl.classList.contains("ad-pinned")); };
  // The single feature shown → { featureType, featureIndex }, else null.
  App.getAttrDockFeature = function () {
    if (!isDockOpen() || !_cur || _cur.multi) return null;
    return { featureType: _cur.type, featureIndex: _cur.index };
  };
  // Width the dock currently covers on the map (0 when closed), for fit padding.
  App.attrDockInset = function () {
    return isDockOpen() ? _dockEl.getBoundingClientRect().width : 0;
  };

  // { key: defaultValue } for the fields the dock seeds into blank attributes
  // when it opens (used by Unmerge's "edited since merging" check).
  App.getAttrFieldDefaults = function (featureType) {
    var out = {};
    (ATTR_FIELDS[featureType] || []).forEach(function (f) {
      if (f.defaultValue !== undefined) out[f.key] = f.defaultValue;
    });
    return out;
  };
  // Re-read the header swatch after a color change made elsewhere (the
  // Appearance popover, a type-wide color set in the Layers tab).
  App.refreshAttrDockSwatch = function () {
    if (!isDockOpen() || !_cur || _cur.multi) return;
    var sw = _dockEl.querySelector(".ad-swatch");
    if (sw) sw.style.background = App.resolveFeatureColor(_cur.type, _cur.feature);
  };

  /* ---- Mini-popup singleton (used by Time Bands and Route Picker pills) ---- */

  var _miniEl = null;
  var _miniDrag = null;
  var _miniOnClose = null;

  function buildMiniEl() {
    if (_miniEl) return;
    var el = document.createElement("div");
    el.id = "fp-mini-popup";
    el.style.display = "none";

    var header = document.createElement("div");
    header.className = "fp-mini-popup-header";
    var titleEl = document.createElement("span");
    titleEl.className = "fp-mini-popup-title";
    header.appendChild(titleEl);
    var closeBtn = document.createElement("button");
    closeBtn.className = "fp-mini-popup-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closeMiniPopup(); });
    header.appendChild(closeBtn);
    el.appendChild(header);

    var body = document.createElement("div");
    body.className = "fp-mini-popup-body";
    el.appendChild(body);

    document.body.appendChild(el);
    _miniEl = el;

    header.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (e.target === closeBtn || closeBtn.contains(e.target)) return;
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      _miniDrag = { startX: e.clientX, startY: e.clientY, initLeft: rect.left, initTop: rect.top };
      header.classList.add("dragging");
    });
    document.addEventListener("mousemove", function (e) {
      if (!_miniDrag) return;
      var dx = e.clientX - _miniDrag.startX;
      var dy = e.clientY - _miniDrag.startY;
      var pw = el.offsetWidth || 280, ph = el.offsetHeight || 200;
      var left = Math.max(-(pw - 40), Math.min(_miniDrag.initLeft + dx, window.innerWidth - 40));
      var top  = Math.max(0,           Math.min(_miniDrag.initTop  + dy, window.innerHeight - 40));
      el.style.left = left + "px";
      el.style.top  = top  + "px";
    });
    document.addEventListener("mouseup", function () {
      if (_miniDrag) { _miniDrag = null; header.classList.remove("dragging"); }
    });
    // Capture phase + stopPropagation: one Escape closes only this topmost
    // layer, never the attributes dock or analysis panel underneath as well.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && _miniEl && _miniEl.style.display !== "none") {
        closeMiniPopup();
        e.stopPropagation();
      }
    }, true);
  }

  function openMiniPopup(opts) {
    buildMiniEl();
    _miniEl.querySelector(".fp-mini-popup-title").textContent = opts.title || "";
    var body = _miniEl.querySelector(".fp-mini-popup-body");
    body.innerHTML = "";
    if (opts.content) body.appendChild(opts.content);

    // Show first so we can measure size, then position.
    _miniEl.style.left = "-9999px";
    _miniEl.style.top  = "0";
    _miniEl.style.display = "";

    var pw = _miniEl.offsetWidth  || 280;
    var ph = _miniEl.offsetHeight || 200;
    var left, top;
    if (opts.anchor && opts.anchor.getBoundingClientRect) {
      var r = opts.anchor.getBoundingClientRect();
      left = r.left;
      top  = r.bottom + 6;
      if (left + pw > window.innerWidth - 8)  left = window.innerWidth  - pw - 8;
      if (top  + ph > window.innerHeight - 8) top  = Math.max(8, r.top - ph - 6);
    } else {
      left = Math.max(8, (window.innerWidth  - pw) / 2);
      top  = Math.max(8, (window.innerHeight - ph) / 2);
    }
    _miniEl.style.left = Math.round(left) + "px";
    _miniEl.style.top  = Math.round(top)  + "px";

    _miniOnClose = (typeof opts.onClose === "function") ? opts.onClose : null;
  }

  function closeMiniPopup() {
    if (_miniEl) _miniEl.style.display = "none";
    var fn = _miniOnClose;
    _miniOnClose = null;
    if (typeof fn === "function") { try { fn(); } catch (e) {} }
  }

  /* ---- Public exports for the Attribute Summary module ---- */

  // Open the time-bands editor for a route/line feature in the mini-popup.
  // The same buildServiceSchedule UI used inside the attributes dock
  // is mounted here (Weekday / Saturday / Sunday with Mirror Saturday checkbox).
  App.openTimeBandsPopup = function (feature, anchor, onChange) {
    if (!feature || !feature.properties) return;
    if (!feature.properties.attributes) feature.properties.attributes = {};
    var content = buildServiceSchedule(feature.properties.attributes);
    openMiniPopup({
      title: "Time Bands — " + (feature.properties.name || ""),
      content: content,
      anchor: anchor,
      onClose: function () { if (typeof onChange === "function") onChange(); }
    });
  };

  // Open the route-picker checklist for a point feature in the mini-popup.
  // `attrs` is the point's `properties.attributes` object; the picker mutates
  // `attrs.associatedRoutes` directly.
  App.openRoutePickerPopup = function (attrs, anchor, onChange) {
    if (!attrs) return;
    var content = buildRoutePickerContent(attrs);
    openMiniPopup({
      title: "Routes",
      content: content,
      anchor: anchor,
      onClose: function () { if (typeof onChange === "function") onChange(); }
    });
  };

  // Generic mini-popup opener — any module can mount its own content node in
  // the shared `#fp-mini-popup` singleton. Same dialog as the time-bands and
  // route-picker mini-popups (320px, draggable header, Escape closes).
  // `opts` = { title, content (DOM node), anchor (DOM element), onClose (fn) }.
  App.openMiniPopup = function (opts) { openMiniPopup(opts || {}); };

  // Close the mini-popup if it's open. Safe to call when not open.
  App.closeMiniPopup = function () { closeMiniPopup(); };

  // Build the Weekday / Saturday / Sunday time-bands editor for a route/line
  // feature and return the DOM node. Same widget mounted by the per-feature
  // attribute popup and `App.openTimeBandsPopup` — modules embedding their own
  // attribute editors should use this rather than reimplementing the bands UI.
  App.buildServiceScheduleEditor = function (feature) {
    if (!feature || !feature.properties) return null;
    if (!feature.properties.attributes) feature.properties.attributes = {};
    return buildServiceSchedule(feature.properties.attributes);
  };

  // Build the `N routes` pill for a point feature. Returns the button DOM.
  // Used by the Attribute Summary module to show a compact, clickable badge.
  App.buildPointRouteBadge = function (pointFeature) {
    if (!pointFeature || !pointFeature.properties) return null;
    if (!pointFeature.properties.attributes) pointFeature.properties.attributes = {};
    return buildRouteBadge(pointFeature.properties.attributes).el;
  };

  // Build a compact "Bands (Wd · Sa · Su)" button for a route/line feature.
  // Click opens the same Time Bands mini-popup used by the per-feature popup.
  App.buildTimeBandsBadge = function (feature) {
    if (!feature || !feature.properties) return null;
    if (!feature.properties.attributes) feature.properties.attributes = {};
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fp-bands-badge";
    function refresh() {
      var svc = feature.properties.attributes.service || {};
      var w = (svc.weekday  || []).length;
      var s = (svc.saturday || []).length;
      var u = svc.sundayMirrorsSaturday ? s : (svc.sunday || []).length;
      var total = w + s + u;
      btn.textContent = total === 0 ? "Add bands" : (w + " · " + s + " · " + u);
      btn.title = "Time bands — Weekday: " + w + ", Saturday: " + s + ", Sunday: " + u +
                  (svc.sundayMirrorsSaturday ? " (mirrors Sat)" : "");
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      App.openTimeBandsPopup(feature, btn, refresh);
    });
    refresh();
    return btn;
  };

})();
