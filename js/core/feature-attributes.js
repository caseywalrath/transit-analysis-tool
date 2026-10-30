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
  var BUFFER_FIELD = { key: "bufferRadius", label: "Buffer", type: "buffer-radius", section: "Study area" };

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
      { key: "stopId",           label: "Stop ID",       type: "text", placeholder: "e.g. 1042" },
      { key: "associatedRoutes", label: "Routes"                                                 },
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

      var title = document.createElement("div");
      title.className = "fp-svc-section-title";
      title.textContent = day.label;
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
      section.appendChild(addBtn);

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
    sundaySection.insertBefore(mirrorPreview, sectionEls.sunday.addBtn);
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

    var swatchSlot = document.createElement("div");
    swatchSlot.className = "ad-swatch-slot";
    header.appendChild(swatchSlot);

    var titles = document.createElement("div");
    titles.className = "ad-titles";
    var titleEl = document.createElement("div");
    titleEl.className = "ad-title";
    var typeEl = document.createElement("div");
    typeEl.className = "ad-type";
    titles.appendChild(titleEl);
    titles.appendChild(typeEl);
    header.appendChild(titles);

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
    header.appendChild(actions);
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

  function setHeader(title, typeText, swatchColor, swatchFn) {
    _dockEl.querySelector(".ad-title").textContent = title;
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

  function renderSingle(featureType, featureIndex, feature) {
    setHeader(feature.properties.name || (TYPE_LABELS[featureType] || featureType),
      TYPE_LABELS[featureType] || featureType,
      App.resolveFeatureColor(featureType, feature),
      function (sw) {
        if (typeof App.openAppearancePopup === "function") {
          App.openAppearancePopup(sw, featureType, featureIndex, {
            onChange: function () { sw.style.background = App.resolveFeatureColor(featureType, feature); }
          });
        }
      });

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

    // Name row (always present)
    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "fp-attr-input";
    nameInput.value = feature.properties.name || "";
    nameInput.addEventListener("change", function () {
      feature.properties.name = nameInput.value;
      _dockEl.querySelector(".ad-title").textContent = nameInput.value || (TYPE_LABELS[featureType] || featureType);
      // Keep the feature row's fp-name display in sync
      var items = document.querySelectorAll(".fp-item");
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        if (el.dataset.featureType === featureType &&
            parseInt(el.dataset.featureIndex, 10) === featureIndex) {
          var rowName = el.querySelector(".fp-name");
          if (rowName) rowName.textContent = nameInput.value;
          break;
        }
      }
      // For labels, name IS the displayed map text — update the marker
      if (featureType === "label" && typeof App.updateLabelAppearance === "function") {
        App.updateLabelAppearance(featureIndex);
      }
      saveAttrCache();
    });
    nameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") nameInput.blur();
    });
    body.appendChild(buildRow("Name", nameInput, null));

    // A field with a new `section` value gets a header row before it.
    var lastSection = null;
    typeFields.forEach(function (field) {
      if (field.hidden) return;
      if (field.section && field.section !== lastSection) {
        var sectionHeader = document.createElement("div");
        sectionHeader.className = "fp-attr-section";
        sectionHeader.textContent = field.section;
        body.appendChild(sectionHeader);
        lastSection = field.section;
      }
      var result = buildFieldInput(field, attrs, feature, featureType);
      body.appendChild(buildRow(field.label, result.el, result.unit));
    });

    // Service schedule (routes and lines only) — full-width, below regular fields
    if (featureType === "route" || featureType === "line") {
      body.appendChild(buildServiceSchedule(attrs));
    }

    // Computed measurements + cycle estimate (routes and lines only)
    if (featureType === "route" || featureType === "line") {
      var _rcLenMi = 0;
      try {
        if (feature.geometry && feature.geometry.coordinates &&
            feature.geometry.coordinates.length >= 2)
          _rcLenMi = turf.length(feature, { units: "miles" });
      } catch (e) {}
      if (_rcLenMi > 0) {
        body.appendChild(buildRow("Length", buildReadOnlyValue(fmtLength(_rcLenMi)), null));
      }

      var cycleSpan = buildReadOnlyValue("—");
      body.appendChild(buildRow("Cycle est.", cycleSpan, null));

      (function (span, len) {
        function refreshCycleEst() {
          var spd = parseFloat(attrs.avgSpeed);
          var rt  = parseFloat(attrs.runTime);
          var dir = attrs.direction || "Both";
          var isLoop = (dir === "Loop" || dir === "CW" || dir === "CCW");
          var isBoth = (dir === "Both");
          var label  = isBoth ? "cycle" : isLoop ? "loop" : "one-way";
          var parts  = [];
          if (spd > 0 && len > 0) {
            var owMin  = len / spd * 60;
            var cycMin = isBoth ? owMin * 2 : owMin;
            parts.push(Math.round(cycMin) + " min " + label + " · speed");
          }
          if (rt > 0) {
            parts.push(rt + " min " + label + " · manual");
          }
          span.textContent = parts.length ? parts.join("  ·  ") : "—";
        }
        refreshCycleEst();
        body.addEventListener("change", refreshCycleEst);
      })(cycleSpan, _rcLenMi);
    }

    if (featureType === "polygon" &&
        feature.geometry && feature.geometry.coordinates &&
        feature.geometry.coordinates[0] &&
        feature.geometry.coordinates[0].length >= 3) {
      var ring    = feature.geometry.coordinates[0];
      var perimMi = turf.length(turf.lineString(ring), { units: "miles" });
      var areaSqM = turf.area(feature);
      body.appendChild(buildRow("Perimeter", buildReadOnlyValue(fmtLength(perimMi)), null));
      body.appendChild(buildRow("Area",      buildReadOnlyValue(fmtArea(areaSqM)),   null));
    }

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

  // Multi-selection: a member list (shared-field editing is a later step).
  // Clicking a member narrows the selection to it.
  function renderMulti(list) {
    setHeader(list.length + " features selected", "Selection", null, null);
    var body = freshBody();
    var ul = document.createElement("ul");
    ul.className = "ad-members";
    list.forEach(function (s) {
      var f = featureFor(s.type, s.index);
      if (!f) return;
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
    body.appendChild(ul);
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
