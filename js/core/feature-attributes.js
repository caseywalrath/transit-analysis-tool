// js/core/feature-attributes.js
// Per-feature attribute popup: floating draggable dialog (singleton).
// Only one popup open at a time; opening a different feature replaces content.
// Exports:
//   App.openAttrPopup(featureType, featureIndex, feature)
//   App.closeAttrPopup()
//   App.isAttrPopupOpen()
//   App.getAttrPopupFeature()  → { featureType, featureIndex } | null

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

  // Shared route/line fields — line mirrors route exactly
  var ROUTE_FIELDS = [
    { key: "group",     label: "Group",     type: "text",   placeholder: "e.g. Corridor A", groupPicker: true, hidden: true },
    { key: "direction", label: "Direction", type: "select", options: ["Both","NB","SB","EB","WB","Inbound","Outbound","Loop","CW","CCW"] },
    { key: "mode",      label: "Mode",      type: "select", options: ["Bus","BRT","Light Rail","Streetcar"] },
    { key: "serviceId", label: "Service",   type: "text",   placeholder: "e.g. Blue Line", servicePicker: true },
    { key: "avgSpeed",  label: "Avg speed", type: "number", unit: "mph", defaultValue: 14 },
    { key: "runTime",   label: "Run time",  type: "number", unit: "min", placeholder: "e.g. 45" }
  ];

  // Field definitions per feature type.
  // Supported types: "text", "number", "select", "checkboxes"
  var ATTR_FIELDS = {
    route: ROUTE_FIELDS,
    line:  ROUTE_FIELDS,
    point: [
      { key: "group",            label: "Group",    type: "text", placeholder: "e.g. North Corridor", groupPicker: true, hidden: true },
      { key: "serviceAreaType",  label: "Service area", type: "select",
        options: ["", "walkshed"],
        optionLabels: { "": "Circular buffer", "walkshed": "Walkshed" },
        onChange: onServiceAreaChange },
      { key: "stopId",           label: "Stop ID",       type: "text", placeholder: "e.g. 1042" },
      { key: "associatedRoutes", label: "Routes"                                                 }
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
    if (typeof App.notifyProject === "function") App.notifyProject();
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
      dot.style.background = feature.properties.color || "#aaa";
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
          var rrEl = document.getElementById("routeBufferRadius");
          var rr = rrEl ? parseFloat(rrEl.value) : 0.5; if (isNaN(rr)) rr = 0.5;
          if (typeof App.rebuildRouteBuffers === "function") App.rebuildRouteBuffers(rr);
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

  /* ---- Floating popup singleton ---- */

  var _popupEl     = null;   // DOM element, created once
  var _currentType = null;   // featureType currently shown
  var _currentIdx  = null;   // featureIndex currently shown
  var _dragState   = null;   // { startX, startY, initLeft, initTop } while dragging

  function buildPopupEl() {
    if (_popupEl) return;

    var el = document.createElement("div");
    el.id = "fp-attr-popup";
    el.style.display = "none";
    el.style.left = "24px";
    el.style.top  = "60px";

    // Header
    var header = document.createElement("div");
    header.className = "fp-attr-popup-header";

    var titleRow = document.createElement("div");
    titleRow.className = "fp-attr-popup-title-row";

    var titleEl = document.createElement("span");
    titleEl.className = "fp-attr-popup-title";
    titleRow.appendChild(titleEl);

    var headerActions = document.createElement("div");
    headerActions.className = "fp-attr-popup-actions";

    var collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "fp-attr-popup-collapse";
    collapseBtn.setAttribute("aria-label", "Collapse attributes");
    collapseBtn.setAttribute("aria-expanded", "true");
    collapseBtn.title = "Collapse";
    collapseBtn.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><polyline points="5,12 10,7 15,12"></polyline></svg>';
    collapseBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setAttrPopupCollapsed(!_popupEl.classList.contains("fp-attr-popup-collapsed"));
    });
    headerActions.appendChild(collapseBtn);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "fp-attr-popup-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.setAttribute("aria-label", "Close attributes");
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeAttrPopup();
    });
    headerActions.appendChild(closeBtn);
    titleRow.appendChild(headerActions);
    header.appendChild(titleRow);

    // Feature appearance controls are kept on their own left-aligned row so
    // the title and window controls stay easy to scan.
    var controls = document.createElement("div");
    controls.className = "fp-attr-popup-controls";
    header.appendChild(controls);
    el.appendChild(header);

    // Body
    var body = document.createElement("div");
    body.className = "fp-attr-popup-body";
    el.appendChild(body);

    document.body.appendChild(el);
    _popupEl = el;

    // ---- Drag support ----
    header.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest(".fp-attr-popup-actions, .fp-attr-popup-controls")) return;
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      _dragState = {
        startX:   e.clientX,
        startY:   e.clientY,
        initLeft: rect.left,
        initTop:  rect.top
      };
      header.classList.add("dragging");
    });

    document.addEventListener("mousemove", function (e) {
      if (!_dragState) return;
      var dx = e.clientX - _dragState.startX;
      var dy = e.clientY - _dragState.startY;
      applyClampedPosition(_dragState.initLeft + dx, _dragState.initTop + dy);
    });

    document.addEventListener("mouseup", function () {
      if (_dragState) {
        _dragState = null;
        var hdr = _popupEl && _popupEl.querySelector(".fp-attr-popup-header");
        if (hdr) hdr.classList.remove("dragging");
      }
    });

    // ---- Escape key ----
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && _popupEl && _popupEl.style.display !== "none") {
        closeAttrPopup();
      }
    });

    // ---- Window resize: keep popup within viewport ----
    window.addEventListener("resize", function () {
      if (_popupEl && _popupEl.style.display !== "none") {
        var r = _popupEl.getBoundingClientRect();
        applyClampedPosition(r.left, r.top);
      }
    });
  }

  function applyClampedPosition(left, top) {
    if (!_popupEl) return;
    var pw = _popupEl.offsetWidth  || 320;
    var ph = _popupEl.offsetHeight || 200;
    var minVisible = 40; // keep at least 40px of the popup visible on each side
    left = Math.max(-(pw - minVisible), Math.min(left, window.innerWidth  - minVisible));
    top  = Math.max(0,                  Math.min(top,  window.innerHeight - minVisible));
    _popupEl.style.left = left + "px";
    _popupEl.style.top  = top  + "px";
  }

  function setAttrPopupCollapsed(collapsed) {
    if (!_popupEl) return;
    _popupEl.classList.toggle("fp-attr-popup-collapsed", collapsed);
    var btn = _popupEl.querySelector(".fp-attr-popup-collapse");
    if (!btn) return;
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-label", collapsed ? "Expand attributes" : "Collapse attributes");
    btn.title = collapsed ? "Expand" : "Collapse";
  }

  // SVG icons for per-feature override buttons
  var _OVR_OPACITY_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6" stroke-dasharray="3 2"/></svg>';
  var _OVR_BUFFER_SVG  = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></svg>';
  var _OVR_WIDTH_SVG   = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="2" y1="8" x2="14" y2="8" stroke-width="2.5"/></svg>';
  var _OVR_OFFSET_SVG  = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="6" x2="14" y2="6"/><line x1="2" y1="10" x2="14" y2="10"/></svg>';
  var _OVR_DEFAULT_SVG = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 6.5A4 4 0 1 1 8 2.5"/><polyline points="8 0.5 10.5 2.5 8 4.5"/></svg>';

  // Push updated feature GeoJSON data to MapLibre source so data-driven
  // paint expressions pick up any changed feature.properties immediately.
  // (The wrapped render functions also re-apply paint expressions via _wrapRender.)
  function _pushFeatureLayer(ft) {
    var fnName = { point: "renderPointLayers", line: "renderLineLayers",
                   route: "renderRouteLayers", polygon: "renderPolygonLayers" }[ft];
    if (fnName && typeof App[fnName] === "function") App[fnName]();
  }

  // Inverse of _polyOpacityValues fill component → returns S (0–100)
  function _invertPolyFillOpacity(fill) {
    if (fill <= 0.15) return Math.round(fill * 50 / 0.15);
    return Math.round(50 + (fill - 0.15) * 50 / 0.85);
  }

  // Build the per-feature override icons container (opacity / buffer / width / offset / reset).
  // Used by the per-feature attribute popup AND the Attribute Summary module.
  // Returns a DOM div (`.fp-attr-overrides`) wired with click handlers, or null
  // for label/textbox features (which have no per-feature overrides in this app).
  function buildOverridesContainer(featureType, feature) {
    if (featureType === "label" || featureType === "textbox") return null;

    var TYPE_KEYS = {
      point:   { opacityKey: "pointOpacity",   widthKey: "pointLineWidth",   bufferKey: "bufferRadius" },
      line:    { opacityKey: "lineOpacity",     widthKey: "lineLineWidth",    bufferKey: "lineBufferRadius" },
      route:   { opacityKey: "routeOpacity",    widthKey: "routeLineWidth",   bufferKey: "routeBufferRadius" },
      polygon: { opacityKey: "polygonOpacity",  widthKey: "polygonLineWidth", bufferKey: null }
    };
    var REBUILD_FNS = {
      point:  function (v) { if (typeof App.rebuildBuffers      === "function") App.rebuildBuffers(v); },
      line:   function (v) { if (typeof App.rebuildLineBuffers  === "function") App.rebuildLineBuffers(v); },
      route:  function (v) { if (typeof App.rebuildRouteBuffers === "function") App.rebuildRouteBuffers(v); },
      polygon: null
    };
    var keys = TYPE_KEYS[featureType] || TYPE_KEYS.point;
    var rebuildFn = REBUILD_FNS[featureType] || null;

    var overrides = document.createElement("div");
    overrides.className = "fp-attr-overrides";

    // Opacity
    var opacityBtn = document.createElement("button");
    opacityBtn.type = "button";
    opacityBtn.className = "fp-sib";
    opacityBtn.title = "Per-feature opacity";
    opacityBtn.innerHTML = _OVR_OPACITY_SVG;
    if (feature.properties._opacity != null || feature.properties._fillOpacity != null) {
      opacityBtn.classList.add("fp-sib-has-override");
    }
    (function (btn, feat, ft, ok) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var curVal;
        if (ft === "polygon") {
          curVal = (feat.properties._fillOpacity != null)
            ? _invertPolyFillOpacity(feat.properties._fillOpacity)
            : (App.featureSettings && App.featureSettings.polygonFillOpacity != null
                 ? _invertPolyFillOpacity(App.featureSettings.polygonFillOpacity / 100)
                 : 50);
        } else {
          curVal = (feat.properties._opacity != null)
            ? feat.properties._opacity * 100
            : (App.featureSettings ? App.featureSettings[ok] : 100);
        }
        if (typeof App._openFpSlider === "function") {
          App._openFpSlider(btn, {
            min: 0, max: 100, step: 1, unit: "%",
            value: curVal,
            onChange: function (S) {
              if (ft === "polygon") {
                var pc = App._polyOpacityValues(S);
                feat.properties._fillOpacity   = pc.fill;
                feat.properties._borderOpacity = pc.border;
              } else {
                feat.properties._opacity = S / 100;
              }
              btn.classList.add("fp-sib-has-override");
              _pushFeatureLayer(ft);
              if (typeof App.cache !== "undefined") App.cache.save();
            }
          });
        }
      });
    })(opacityBtn, feature, featureType, keys.opacityKey);
    overrides.appendChild(opacityBtn);

    // Buffer (not for polygons)
    if (featureType !== "polygon") {
      var bufferBtn = document.createElement("button");
      bufferBtn.type = "button";
      bufferBtn.className = "fp-sib";
      bufferBtn.title = "Per-feature buffer radius";
      bufferBtn.innerHTML = _OVR_BUFFER_SVG;
      if (feature.properties._bufferRadius != null) {
        bufferBtn.classList.add("fp-sib-has-override");
      }
      (function (btn, feat, bk, rbFn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var curVal = (feat.properties._bufferRadius != null)
            ? feat.properties._bufferRadius
            : (App.featureSettings ? App.featureSettings[bk] : 0);
          if (typeof App._openFpSlider === "function") {
            App._openFpSlider(btn, {
              values: (App.BUFFER_RADIUS_STEPS || [0,0.125,0.25,0.5,0.75,1,1.25,1.5,1.75,2]), unit: "mi",
              value: curVal,
              onChange: function (v) {
                feat.properties._bufferRadius = v;
                btn.classList.add("fp-sib-has-override");
                if (rbFn) rbFn(App.featureSettings ? App.featureSettings[bk] : 0);
                if (typeof App.cache !== "undefined") App.cache.save();
              }
            });
          }
        });
      })(bufferBtn, feature, keys.bufferKey, rebuildFn);
      overrides.appendChild(bufferBtn);
    }

    // Width
    var widthBtn = document.createElement("button");
    widthBtn.type = "button";
    widthBtn.className = "fp-sib";
    widthBtn.title = "Per-feature line width";
    widthBtn.innerHTML = _OVR_WIDTH_SVG;
    if (feature.properties._lineWidth != null) {
      widthBtn.classList.add("fp-sib-has-override");
    }
    (function (btn, feat, ft, wk) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var curVal = (feat.properties._lineWidth != null)
          ? feat.properties._lineWidth
          : (App.featureSettings ? App.featureSettings[wk] : 1);
        if (typeof App._openFpSlider === "function") {
          App._openFpSlider(btn, {
            min: 0, max: 5, step: 0.1, unit: "×",
            value: curVal,
            onChange: function (v) {
              feat.properties._lineWidth = v;
              btn.classList.add("fp-sib-has-override");
              _pushFeatureLayer(ft);
              if (typeof App.cache !== "undefined") App.cache.save();
            }
          });
        }
      });
    })(widthBtn, feature, featureType, keys.widthKey);
    overrides.appendChild(widthBtn);

    // Offset (routes and lines only)
    if (featureType === "route" || featureType === "line") {
      var OFFSET_STEPS = [-6, -3, 0, 3, 6];
      var offsetBtn = document.createElement("button");
      offsetBtn.type = "button";
      offsetBtn.className = "fp-sib";
      offsetBtn.title = "Per-feature offset (perpendicular to line)";
      offsetBtn.innerHTML = _OVR_OFFSET_SVG;
      if (feature.properties._offsetManual) {
        offsetBtn.classList.add("fp-sib-has-override");
      }
      (function (btn, feat, ft) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var curVal = (feat.properties._offset != null) ? feat.properties._offset : 0;
          if (typeof App._openFpSlider === "function") {
            App._openFpSlider(btn, {
              values: OFFSET_STEPS, unit: "px",
              value: curVal,
              onChange: function (v) {
                feat.properties._offset = v;
                feat.properties._offsetManual = true;
                btn.classList.add("fp-sib-has-override");
                _pushFeatureLayer(ft);
                if (typeof App.cache !== "undefined") App.cache.save();
              }
            });
          }
        });
      })(offsetBtn, feature, featureType);
      overrides.appendChild(offsetBtn);
    }

    // Reset
    var defaultBtn = document.createElement("button");
    defaultBtn.type = "button";
    defaultBtn.className = "fp-sib";
    defaultBtn.title = "Reset to global defaults";
    defaultBtn.innerHTML = _OVR_DEFAULT_SVG;
    (function (btn, feat, ft, bk, rbFn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        delete feat.properties._opacity;
        delete feat.properties._fillOpacity;
        delete feat.properties._borderOpacity;
        delete feat.properties._lineWidth;
        delete feat.properties._bufferRadius;
        delete feat.properties._offset;
        delete feat.properties._offsetManual;
        _pushFeatureLayer(ft);
        if (rbFn) rbFn(App.featureSettings ? (App.featureSettings[bk] || 0) : 0);
        var oCb = document.getElementById("offsetOverlap");
        if (oCb && oCb.checked && typeof App.computeOverlapOffsets === "function") {
          App.computeOverlapOffsets();
        }
        if (typeof App.cache !== "undefined") App.cache.save();
        if (typeof App._closeFpSlider === "function") App._closeFpSlider();
        overrides.querySelectorAll(".fp-sib-has-override").forEach(function (el) {
          el.classList.remove("fp-sib-has-override");
        });
      });
    })(defaultBtn, feature, featureType, keys.bufferKey, rebuildFn);
    overrides.appendChild(defaultBtn);

    return overrides;
  }

  function populatePopupBody(featureType, featureIndex, feature) {
    buildPopupEl();

    // Update header title
    _popupEl.querySelector(".fp-attr-popup-title").textContent =
      (TYPE_LABELS[featureType] || featureType) + " Attributes";

    // Update or create color swatch in the left-aligned appearance-controls row.
    var headerEl = _popupEl.querySelector(".fp-attr-popup-header");
    var controlsEl = headerEl.querySelector(".fp-attr-popup-controls");
    var existingSwatch = controlsEl.querySelector(".fp-attr-popup-swatch");
    if (existingSwatch) existingSwatch.remove();
    var featureColor = feature.properties.color ||
      (typeof App.getTypeDefaultColor === "function" ? App.getTypeDefaultColor(featureType) : "#999");
    var hdrSwatch = document.createElement("button");
    hdrSwatch.className = "fp-attr-popup-swatch";
    hdrSwatch.style.background = featureColor;
    hdrSwatch.setAttribute("aria-label", "Change color");
    hdrSwatch.title = "Change color";
    (function (sw, ft, fi, feat) {
      sw.addEventListener("click", function (e) {
        e.stopPropagation();
        if (typeof App.openColorPicker === "function") {
          App.openColorPicker(sw, feat.properties.color || sw.style.background, function (newColor) {
            feat.properties.color = newColor;
            sw.style.background = newColor;
            if (typeof App.updateFeatureColor === "function") App.updateFeatureColor(ft, fi, newColor);
          });
        }
      });
    })(hdrSwatch, featureType, featureIndex, feature);
    controlsEl.appendChild(hdrSwatch);

    // Remove existing overrides container, then rebuild it
    var existingOverrides = controlsEl.querySelector(".fp-attr-overrides");
    if (existingOverrides) existingOverrides.remove();

    var overrides = buildOverridesContainer(featureType, feature) || (function () {
      var d = document.createElement("div");
      d.className = "fp-attr-overrides";
      return d;
    })();
    controlsEl.appendChild(overrides);

    // Clear and rebuild body
    var body = _popupEl.querySelector(".fp-attr-popup-body");
    body.innerHTML = "";

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

    // Type-specific fields
    var fields = ATTR_FIELDS[featureType] || [];
    fields.forEach(function (field) {
      if (field.hidden) return;
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

    _currentType = featureType;
    _currentIdx  = featureIndex;
  }

  /* ---- Public API ---- */

  App.openAttrPopup = function (featureType, featureIndex, feature) {
    buildPopupEl();

    // Toggle: clicking gear on the same feature closes the popup
    if (_popupEl.style.display !== "none" &&
        _currentType === featureType && _currentIdx === featureIndex) {
      closeAttrPopup();
      return;
    }

    var wasOpen = (_popupEl.style.display !== "none");
    populatePopupBody(featureType, featureIndex, feature);

    // Only reset position when opening fresh (preserve dragged position when switching features)
    if (!wasOpen) {
      setAttrPopupCollapsed(false);
      _popupEl.style.left = "24px";
      _popupEl.style.top  = "60px";
    }
    _popupEl.style.display = "";
  };

  function closeAttrPopup() {
    if (_popupEl) _popupEl.style.display = "none";
    _currentType = null;
    _currentIdx  = null;
  }

  App.closeAttrPopup    = closeAttrPopup;
  App.isAttrPopupOpen   = function () { return !!(_popupEl && _popupEl.style.display !== "none"); };
  App.getAttrPopupFeature = function () {
    if (!App.isAttrPopupOpen()) return null;
    return { featureType: _currentType, featureIndex: _currentIdx };
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
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && _miniEl && _miniEl.style.display !== "none") closeMiniPopup();
    });
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
  // The same buildServiceSchedule UI used inside the per-feature attribute popup
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

  // Build a `.fp-attr-overrides` container with the per-feature override icons
  // (opacity / buffer / width / offset / reset). Returns null for label/textbox.
  App.buildOverrideIcons = function (featureType, feature) {
    return buildOverridesContainer(featureType, feature);
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
