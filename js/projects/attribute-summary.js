// js/projects/attribute-summary.js
// Attribute Summary — view and edit every drawn feature's attributes in one place.
// Opened from the Feature Settings panel (right side), not from the Analysis dropdown.
// Registered with `system: true` so the Analysis panel skips it.
(function () {
  var App = window.App = window.App || {};

  var DIRECTIONS = ["", "Both", "NB", "SB", "EB", "WB", "Inbound", "Outbound", "Loop", "CW", "CCW"];
  var MODES      = ["", "Bus", "BRT", "Light Rail", "Streetcar"];
  var FONT_SIZES = ["Small", "Medium", "Large", "XL"];

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "attribute-summary";
  }

  function el(id) { return document.getElementById(id); }

  function saveAndRefreshFeaturePanel() {
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function pushLayer(featureType) {
    var fnName = {
      point:   "renderPointLayers",
      line:    "renderLineLayers",
      route:   "renderRouteLayers",
      polygon: "renderPolygonLayers"
    }[featureType];
    if (fnName && typeof App[fnName] === "function") App[fnName]();
  }

  /* ---- Multi-select + bulk edit (Routes & Lines only) ---- */

  // Selected feature indices per type. Survives cell edits (which don't rebuild
  // the grid); cleared by renderAll() on structural change unless preserved.
  var _selected = { line: new Set(), route: new Set() };

  function tableIdForType(type) {
    return type === "line" ? "asLinesTable" : "asRoutesTable";
  }

  function makeCheckbox(cls) {
    var c = document.createElement("input");
    c.type = "checkbox";
    c.className = cls;
    return c;
  }

  function updateBulkBar(type) {
    var bar = el("as-bulk-bar-" + type);
    if (!bar) return;
    var n = _selected[type].size;
    bar.style.display = n > 0 ? "" : "none";
    var c = bar.querySelector(".as-bulk-count");
    if (c) c.textContent = n + " selected";
  }

  function syncRowChecks(type) {
    var tbl = el(tableIdForType(type));
    if (!tbl) return;
    tbl.querySelectorAll(".as-row:not(.as-row-header)").forEach(function (r) {
      var i = parseInt(r.dataset.featureIndex, 10);
      var on = _selected[type].has(i);
      var cb = r.querySelector(".as-rowcheck");
      if (cb) cb.checked = on;
      r.classList.toggle("as-selected", on);
    });
    var selAll = tbl.querySelector(".as-rowcheck-all");
    if (selAll) {
      var total = tbl.querySelectorAll(".as-row:not(.as-row-header)").length;
      selAll.checked = total > 0 && _selected[type].size === total;
    }
    updateBulkBar(type);
  }

  function onRowToggle(type, idx, row, checked) {
    if (checked) _selected[type].add(idx); else _selected[type].delete(idx);
    row.classList.toggle("as-selected", checked);
    syncRowChecks(type);
  }

  function toggleAll(type, count, checked) {
    _selected[type].clear();
    if (checked) { for (var i = 0; i < count; i++) _selected[type].add(i); }
    syncRowChecks(type);
  }

  function clearSelectionType(type) {
    _selected[type].clear();
    syncRowChecks(type);
  }

  function buildBulkBar(type) {
    var bar = document.createElement("div");
    bar.className = "as-bulk-bar";
    bar.id = "as-bulk-bar-" + type;
    bar.style.display = "none";

    var count = document.createElement("span");
    count.className = "as-bulk-count";
    bar.appendChild(count);

    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "as-bulk-edit-btn";
    editBtn.textContent = "Bulk edit…";
    editBtn.addEventListener("click", function () { openBulkEditForm(type); });
    bar.appendChild(editBtn);

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "as-bulk-clear-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", function () { clearSelectionType(type); });
    bar.appendChild(clearBtn);

    return bar;
  }

  // ---- Bulk-edit form (per-field include checkboxes) ----
  function openBulkEditForm(type) {
    var indices = Array.from(_selected[type]);
    if (!indices.length) return;
    var arr = (type === "line") ? (App.lines || []) : (App.routes || []);

    var form = document.createElement("div");
    form.className = "as-bulk-form";
    var fields = [];

    function addField(key, label, inputEl, readFn, opts) {
      opts = opts || {};
      var frow = document.createElement("div");
      frow.className = "as-bulk-frow";
      var lab = document.createElement("label");
      lab.className = "as-bulk-flabel";
      lab.textContent = label;
      frow.appendChild(lab);
      frow.appendChild(inputEl);
      form.appendChild(frow);
      fields.push({ key: key, read: readFn, opts: opts });
    }

    function plainSelect(options) {
      var s = document.createElement("select");
      s.className = "as-input as-select";
      options.forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = o; opt.textContent = o === "" ? "—" : o;
        s.appendChild(opt);
      });
      return s;
    }
    function numInput(ph) {
      var i = document.createElement("input");
      i.type = "number"; i.className = "as-input as-input-num"; i.min = 0; i.step = "any";
      if (ph) i.placeholder = ph;
      return i;
    }
    function textInput(ph) {
      var i = document.createElement("input");
      i.type = "text"; i.className = "as-input";
      if (ph) i.placeholder = ph;
      return i;
    }

    var dirSel = plainSelect(DIRECTIONS);
    addField("direction", "Direction", dirSel, function () { return dirSel.value || null; });
    var modeSel = plainSelect(MODES);
    addField("mode", "Mode", modeSel, function () { return modeSel.value || null; });
    var spd = numInput("14");
    addField("avgSpeed", "Avg speed (mph)", spd, function () { return spd.value !== "" ? parseFloat(spd.value) : null; });
    var rt = numInput("e.g. 45");
    addField("runTime", "Run time (min)", rt, function () { return rt.value !== "" ? parseFloat(rt.value) : null; });
    var grp = textInput("e.g. Corridor A");
    addField("group", "Group", grp, function () { return grp.value.trim() || null; });

    // Time bands — reuse the shared editor against a throwaway carrier feature.
    // Snapshot the editor's default service so we can tell whether the user
    // actually changed the bands (blank/untouched = no change, like other fields).
    var carrier = { properties: { attributes: {} } };
    var bandsWrap = document.createElement("div");
    bandsWrap.className = "as-bulk-bands";
    if (typeof App.buildServiceScheduleEditor === "function") {
      bandsWrap.appendChild(App.buildServiceScheduleEditor(carrier));
    }
    var bandsSnapshot = JSON.stringify(carrier.properties.attributes.service || null);
    addField("service", "Time bands", bandsWrap, function () {
      var cur = JSON.stringify(carrier.properties.attributes.service || null);
      return cur === bandsSnapshot ? null : carrier.properties.attributes.service;
    }, { isBands: true });

    var applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "as-bulk-apply";
    applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", function () { applyBulk(type, indices, fields); });
    form.appendChild(applyBtn);

    var label = (type === "line") ? "line" : "route";
    if (typeof App.openMiniPopup === "function") {
      App.openMiniPopup({
        title: "Bulk edit " + indices.length + " " + label + (indices.length > 1 ? "s" : ""),
        content: form,
        anchor: el("as-bulk-bar-" + type)
      });
    }
  }

  function applyBulk(type, indices, fields) {
    var arr = (type === "line") ? (App.lines || []) : (App.routes || []);
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    indices.forEach(function (i) {
      var feat = arr[i];
      if (!feat) return;
      if (!feat.properties.attributes) feat.properties.attributes = {};
      var a = feat.properties.attributes;
      fields.forEach(function (f) {
        var val = f.read();
        // Blank / unchanged inputs are skipped — only changed values are written.
        if (val == null || val === "") return;
        if (f.opts.isBands) {
          a.service = JSON.parse(JSON.stringify(val)); // deep clone per feature
        } else {
          a[f.key] = val;
        }
      });
    });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    renderAll({ preserveSelection: true });
    if (typeof App.closeMiniPopup === "function") App.closeMiniPopup();
  }

  /* ---- Copy Attributes (Points / Lines / Routes / Polygons) ---- */
  // A small "copy" icon button on each row opens #asCopyModal, letting the
  // user copy that row's (the source's) attribute values onto one or more
  // other compatible features. Routes and Lines share one target pool (same
  // attribute schema); Points and Polygons only target their own type.
  // `serviceId` is deliberately excluded — it's the Route Costing / Trip
  // Builder pairing key, and copying it onto other routes/lines would
  // silently merge them into the same Service.

  var COPY_FIELDS_POINT = [
    { key: "group",            label: "Group",              kind: "text" },
    { key: "serviceAreaType",  label: "Service Area Type",  kind: "select" },
    { key: "stopId",           label: "Stop ID",             kind: "text" },
    { key: "associatedRoutes", label: "Associated Routes",   kind: "routearray" }
  ];
  var COPY_FIELDS_ROUTELIKE = [
    { key: "group",       label: "Group",        kind: "text" },
    { key: "direction",   label: "Direction",    kind: "select" },
    { key: "mode",        label: "Mode",         kind: "select" },
    { key: "avgSpeed",    label: "Avg Speed",    kind: "number" },
    { key: "runTime",     label: "Run Time",     kind: "number" },
    { key: "service",     label: "Time Bands",   kind: "bands" },
    { key: "networkRole", label: "Walk Network", kind: "select" }
  ];
  var COPY_FIELDS_POLYGON = [
    { key: "group", label: "Group", kind: "text" },
    { key: "notes", label: "Notes", kind: "text" }
  ];
  var COPY_FIELD_DEFS = {
    point:   COPY_FIELDS_POINT,
    line:    COPY_FIELDS_ROUTELIKE,
    route:   COPY_FIELDS_ROUTELIKE,
    polygon: COPY_FIELDS_POLYGON
  };

  function copyFieldGetValue(fieldDef, attrs) {
    return attrs ? attrs[fieldDef.key] : undefined;
  }

  function copyFieldHasValue(fieldDef, attrs) {
    var v = attrs ? attrs[fieldDef.key] : undefined;
    if (fieldDef.kind === "number")     return v != null && !isNaN(v);
    if (fieldDef.kind === "routearray") return Array.isArray(v) && v.length > 0;
    if (fieldDef.kind === "bands") {
      if (!v) return false;
      var w = (v.weekday  || []).length;
      var s = (v.saturday || []).length;
      var u = v.sundayMirrorsSaturday ? s : (v.sunday || []).length;
      return (w + s + u) > 0;
    }
    return v != null && v !== ""; // text / select
  }

  function copyFieldSetValue(fieldDef, attrs, val) {
    if (fieldDef.kind === "bands" || fieldDef.kind === "routearray") {
      attrs[fieldDef.key] = JSON.parse(JSON.stringify(val)); // deep clone per target
    } else {
      attrs[fieldDef.key] = val;
    }
  }

  function copySourceArray(type) {
    if (type === "point")   return App.points   || [];
    if (type === "polygon") return App.polygons || [];
    if (type === "line")    return App.lines    || [];
    if (type === "route")   return App.routes   || [];
    return [];
  }

  var _COPY_ATTRS_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="8" height="8" rx="1.5"/><path d="M3.5 10.5V4a1.5 1.5 0 0 1 1.5-1.5h6.5"/></svg>';

  function buildCopyButton(featureType, idx, feat) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fp-sib";
    var noun = featureType === "point" ? "points" : featureType === "polygon" ? "polygons" : "routes/lines";
    btn.title = "Copy attributes to other " + noun;
    btn.innerHTML = _COPY_ATTRS_SVG;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openCopyModal(featureType, idx);
    });
    return btn;
  }

  // Which feature is the current copy source ({ type, idx }) while the modal is open.
  var _copySource = null;

  function getCopyTargets(sourceType, sourceIdx) {
    var targets = [];
    if (sourceType === "line" || sourceType === "route") {
      (App.routes || []).forEach(function (f, i) {
        if (!(sourceType === "route" && i === sourceIdx)) targets.push({ type: "route", idx: i, feat: f });
      });
      (App.lines || []).forEach(function (f, i) {
        if (!(sourceType === "line" && i === sourceIdx)) targets.push({ type: "line", idx: i, feat: f });
      });
    } else {
      copySourceArray(sourceType).forEach(function (f, i) {
        if (i !== sourceIdx) targets.push({ type: sourceType, idx: i, feat: f });
      });
    }
    return targets;
  }

  function buildCopyAttrChecklist(sourceType, sourceAttrs) {
    var wrap = document.createElement("div");
    wrap.className = "as-copy-attr-list";
    var fields = COPY_FIELD_DEFS[sourceType] || [];

    fields.forEach(function (fd) {
      var has = copyFieldHasValue(fd, sourceAttrs);
      var row = document.createElement("label");
      row.className = "as-copy-attr-row" + (has ? "" : " as-copy-attr-disabled");

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.disabled = !has;
      cb.setAttribute("data-field-key", fd.key);
      cb.addEventListener("change", updateCopyState);
      row.appendChild(cb);

      var span = document.createElement("span");
      span.textContent = fd.label;
      row.appendChild(span);

      if (!has) {
        var hint = document.createElement("span");
        hint.className = "as-copy-attr-hint";
        hint.textContent = "(no value to copy)";
        row.appendChild(hint);
      }

      wrap.appendChild(row);
    });

    if (!fields.length) {
      wrap.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No copyable attributes.</div>';
    }
    return wrap;
  }

  function buildCopyTargetChecklist(sourceType, sourceIdx) {
    var col = document.createElement("div");

    var actions = document.createElement("div");
    actions.className = "rf-feature-select-actions";
    actions.style.marginBottom = "4px";
    var selAll = document.createElement("a");
    selAll.href = "#"; selAll.textContent = "Select all";
    var selNone = document.createElement("a");
    selNone.href = "#"; selNone.textContent = "Clear";
    actions.appendChild(selAll);
    actions.appendChild(document.createTextNode(" "));
    var sep = document.createElement("span");
    sep.style.color = "var(--muted)";
    sep.textContent = "|";
    actions.appendChild(sep);
    actions.appendChild(document.createTextNode(" "));
    actions.appendChild(selNone);
    col.appendChild(actions);

    var list = document.createElement("div");
    list.className = "rf-feature-checklist";
    list.id = "asCopyTargetList";

    var targets = getCopyTargets(sourceType, sourceIdx);
    if (!targets.length) {
      var noun = sourceType === "point" ? "points" : sourceType === "polygon" ? "polygons" : "routes or lines";
      list.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No other ' + noun + ' to copy to.</div>';
    } else {
      targets.forEach(function (t) {
        var row = document.createElement("div");
        row.className = "rf-feature-check-row";

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.setAttribute("data-type", t.type);
        cb.setAttribute("data-idx", String(t.idx));
        cb.addEventListener("change", updateCopyState);

        var lbl = document.createElement("label");
        lbl.style.cssText = "flex:1;cursor:pointer;";
        lbl.textContent = (t.feat.properties && t.feat.properties.name) ||
          (t.type.charAt(0).toUpperCase() + t.type.slice(1) + " " + (t.idx + 1));
        lbl.addEventListener("click", function (e) { e.preventDefault(); cb.checked = !cb.checked; updateCopyState(); });

        row.appendChild(cb);
        row.appendChild(lbl);

        if (sourceType === "route" || sourceType === "line") {
          var badgeEl = document.createElement("span");
          badgeEl.className = "rf-feature-type-badge";
          badgeEl.textContent = t.type === "route" ? "R" : "L";
          row.appendChild(badgeEl);
        }

        list.appendChild(row);
      });
    }
    col.appendChild(list);

    selAll.addEventListener("click", function (e) {
      e.preventDefault();
      list.querySelectorAll("input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
      updateCopyState();
    });
    selNone.addEventListener("click", function (e) {
      e.preventDefault();
      list.querySelectorAll("input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
      updateCopyState();
    });

    return col;
  }

  function computeOverwriteWarning(checkedFieldDefs, sourceAttrs, targets) {
    if (!checkedFieldDefs.length || !targets.length) return null;
    var affectedLabels = [];
    var affectedTargetKeys = {};
    checkedFieldDefs.forEach(function (fd) {
      if (!copyFieldHasValue(fd, sourceAttrs)) return; // blank source → nothing will be written for this field
      var anyConflict = false;
      targets.forEach(function (t) {
        var tAttrs = (t.feat.properties && t.feat.properties.attributes) || {};
        if (copyFieldHasValue(fd, tAttrs)) {
          anyConflict = true;
          affectedTargetKeys[t.type + ":" + t.idx] = true;
        }
      });
      if (anyConflict) affectedLabels.push(fd.label);
    });
    if (!affectedLabels.length) return null;
    var count = Object.keys(affectedTargetKeys).length;
    return {
      count: count,
      total: targets.length,
      labels: affectedLabels,
      message: count + " of " + targets.length + " selected targets already have data for: " +
        affectedLabels.join(", ") + ". Applying will overwrite these values."
    };
  }

  function buildCopyModalContent(sourceType, sourceIdx, sourceFeat) {
    var sourceAttrs = sourceFeat.properties.attributes || {};
    var wrap = document.createElement("div");

    var columns = document.createElement("div");
    columns.className = "as-copy-columns";

    var attrCol = document.createElement("div");
    attrCol.className = "as-copy-col";
    var attrTitle = document.createElement("div");
    attrTitle.className = "rf-section-title";
    attrTitle.textContent = "Attributes to copy";
    attrCol.appendChild(attrTitle);
    attrCol.appendChild(buildCopyAttrChecklist(sourceType, sourceAttrs));

    var targetCol = document.createElement("div");
    targetCol.className = "as-copy-col";
    var targetTitle = document.createElement("div");
    targetTitle.className = "rf-section-title";
    targetTitle.textContent = "Copy to";
    targetCol.appendChild(targetTitle);
    targetCol.appendChild(buildCopyTargetChecklist(sourceType, sourceIdx));

    columns.appendChild(attrCol);
    columns.appendChild(targetCol);
    wrap.appendChild(columns);

    var warn = document.createElement("div");
    warn.className = "as-copy-warning";
    warn.id = "asCopyWarning";
    warn.style.display = "none";
    wrap.appendChild(warn);

    return wrap;
  }

  function updateCopyState() {
    var modal = el("asCopyModal");
    if (!modal || !_copySource) return;
    var sourceType = _copySource.type, sourceIdx = _copySource.idx;
    var sourceFeat = copySourceArray(sourceType)[sourceIdx];
    if (!sourceFeat) { closeCopyModal(); return; }
    var sourceAttrs = sourceFeat.properties.attributes || {};
    var fieldDefs = COPY_FIELD_DEFS[sourceType] || [];

    var checkedFieldDefs = [];
    modal.querySelectorAll(".as-copy-attr-list input[type=checkbox]:checked").forEach(function (cb) {
      var key = cb.getAttribute("data-field-key");
      for (var i = 0; i < fieldDefs.length; i++) {
        if (fieldDefs[i].key === key) { checkedFieldDefs.push(fieldDefs[i]); break; }
      }
    });

    var checkedTargets = [];
    modal.querySelectorAll("#asCopyTargetList input[type=checkbox]:checked").forEach(function (cb) {
      var t = cb.getAttribute("data-type");
      var i = parseInt(cb.getAttribute("data-idx"), 10);
      var feat = copySourceArray(t)[i];
      if (feat) checkedTargets.push({ type: t, idx: i, feat: feat });
    });

    var warnEl = el("asCopyWarning");
    if (warnEl) {
      var summary = computeOverwriteWarning(checkedFieldDefs, sourceAttrs, checkedTargets);
      if (summary) {
        warnEl.textContent = summary.message;
        warnEl.style.display = "";
      } else {
        warnEl.style.display = "none";
      }
    }

    var applyBtn = el("asCopyApplyBtn");
    if (applyBtn) {
      var n = checkedTargets.length;
      applyBtn.disabled = !(checkedFieldDefs.length > 0 && n > 0);
      applyBtn.textContent = n > 0 ? ("Apply to " + n + " feature" + (n === 1 ? "" : "s")) : "Apply";
    }
  }

  function openCopyModal(sourceType, sourceIdx) {
    var sourceFeat = copySourceArray(sourceType)[sourceIdx];
    if (!sourceFeat) return;
    if (!sourceFeat.properties.attributes) sourceFeat.properties.attributes = {};

    _copySource = { type: sourceType, idx: sourceIdx };

    var titleEl = el("asCopyModalTitle");
    if (titleEl) titleEl.textContent = "Copy Attributes — " + (sourceFeat.properties.name || "");

    var bodyEl = el("asCopyModalBody");
    if (bodyEl) {
      bodyEl.innerHTML = "";
      bodyEl.appendChild(buildCopyModalContent(sourceType, sourceIdx, sourceFeat));
    }

    updateCopyState();

    var modal = el("asCopyModal");
    if (modal) modal.style.display = "";
  }

  function closeCopyModal() {
    var modal = el("asCopyModal");
    if (modal) modal.style.display = "none";
    _copySource = null;
  }

  function applyCopyAttributes() {
    if (!_copySource) return;
    var sourceType = _copySource.type, sourceIdx = _copySource.idx;
    var sourceFeat = copySourceArray(sourceType)[sourceIdx];
    var modal = el("asCopyModal");
    if (!sourceFeat || !modal) { closeCopyModal(); return; }
    var sourceAttrs = sourceFeat.properties.attributes || {};
    var fieldDefs = COPY_FIELD_DEFS[sourceType] || [];

    var checkedFieldDefs = [];
    modal.querySelectorAll(".as-copy-attr-list input[type=checkbox]:checked").forEach(function (cb) {
      var key = cb.getAttribute("data-field-key");
      for (var i = 0; i < fieldDefs.length; i++) {
        if (fieldDefs[i].key === key) { checkedFieldDefs.push(fieldDefs[i]); break; }
      }
    });

    var targets = [];
    modal.querySelectorAll("#asCopyTargetList input[type=checkbox]:checked").forEach(function (cb) {
      var t = cb.getAttribute("data-type");
      var i = parseInt(cb.getAttribute("data-idx"), 10);
      var feat = copySourceArray(t)[i];
      if (feat) targets.push(feat);
    });

    if (!checkedFieldDefs.length || !targets.length) return;

    if (App.undo && !App.undo.isRestoring()) App.undo.push();

    var touchedServiceAreaType = false;
    targets.forEach(function (feat) {
      if (!feat.properties.attributes) feat.properties.attributes = {};
      var attrs = feat.properties.attributes;
      checkedFieldDefs.forEach(function (fd) {
        if (!copyFieldHasValue(fd, sourceAttrs)) return; // blank source — skip, never overwrite with emptiness
        copyFieldSetValue(fd, attrs, copyFieldGetValue(fd, sourceAttrs));
        if (fd.key === "serviceAreaType") touchedServiceAreaType = true;
      });
    });

    // serviceAreaType has side effects (walkshed geometry) normally triggered
    // by its cell's own onChange handler — replicate them since we wrote the
    // attribute directly.
    if (touchedServiceAreaType) {
      if (typeof App.ensurePointWalksheds === "function") App.ensurePointWalksheds();
      if (typeof App.refreshBuffers === "function") App.refreshBuffers();
    }

    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    renderAll({ preserveSelection: true });
    closeCopyModal();

    if (touchedServiceAreaType && typeof App.notifyProject === "function") App.notifyProject();
  }

  /* ---- Cell builders ---- */

  function buildSwatchCell(featureType, featureIndex, feature) {
    var sw = document.createElement("button");
    sw.type = "button";
    sw.className = "as-swatch";
    sw.title = "Change color";
    sw.style.background = feature.properties.color ||
      (typeof App.getTypeDefaultColor === "function" ? App.getTypeDefaultColor(featureType) : "#999");
    sw.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App.openColorPicker !== "function") return;
      App.openColorPicker(sw, feature.properties.color || sw.style.background, function (newColor) {
        feature.properties.color = newColor;
        sw.style.background = newColor;
        if (typeof App.updateFeatureColor === "function") {
          App.updateFeatureColor(featureType, featureIndex, newColor);
        }
        saveAndRefreshFeaturePanel();
      });
    });
    return sw;
  }

  function buildTextCell(getValue, setValue, opts) {
    opts = opts || {};
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "as-input";
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    if (opts.title) inp.title = opts.title;
    inp.value = getValue() != null ? getValue() : "";
    inp.addEventListener("change", function () {
      setValue(inp.value);
    });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") inp.blur(); });
    return inp;
  }

  function buildNumberCell(getValue, setValue, opts) {
    opts = opts || {};
    var inp = document.createElement("input");
    inp.type = "number";
    inp.className = "as-input as-input-num";
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    if (opts.title) inp.title = opts.title;
    if (opts.min  != null) inp.min  = opts.min;
    if (opts.step != null) inp.step = opts.step;
    var v = getValue();
    inp.value = (v != null && v !== "") ? v : "";
    inp.addEventListener("change", function () {
      setValue(inp.value !== "" ? parseFloat(inp.value) : null);
    });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") inp.blur(); });
    return inp;
  }

  function buildSelectCell(options, getValue, setValue, opts) {
    opts = opts || {};
    var sel = document.createElement("select");
    sel.className = "as-input as-select";
    if (opts.title) sel.title = opts.title;
    var current = getValue();
    var noVal = (current == null || current === "");
    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o;
      opt.textContent = (opts.labels && (o in opts.labels)) ? opts.labels[o] : (o === "" ? "—" : o);
      if (o === "" ? noVal : current === o) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () {
      setValue(sel.value === "" ? null : sel.value);
    });
    return sel;
  }

  function buildColorSwatchCell(getValue, setValue, opts) {
    opts = opts || {};
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "as-swatch";
    btn.title = opts.title || "Change color";
    btn.style.background = getValue() || opts.defaultColor || "#1a202c";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App.openColorPicker !== "function") return;
      App.openColorPicker(btn, getValue() || btn.style.background, function (newColor) {
        btn.style.background = newColor;
        setValue(newColor);
      });
    });
    return btn;
  }

  /* ---- Section renderers ---- */

  function appendCell(row, content, className) {
    var cell = document.createElement("div");
    cell.className = "as-cell" + (className ? " " + className : "");
    if (typeof content === "string") cell.textContent = content;
    else if (content) cell.appendChild(content);
    row.appendChild(cell);
    return cell;
  }

  // Header row builder
  function buildHeader(columns) {
    var hdr = document.createElement("div");
    hdr.className = "as-row as-row-header";
    columns.forEach(function (col) {
      var c = document.createElement("div");
      c.className = "as-cell as-cell-header" + (col.cls ? " " + col.cls : "");
      c.textContent = col.label;
      if (col.title) c.title = col.title;
      hdr.appendChild(c);
    });
    return hdr;
  }

  /* ---- Points ---- */

  function renderPoints(container) {
    var rows = App.points || [];
    if (!rows.length) return false;
    container.innerHTML = "";
    container.appendChild(buildHeader([
      { label: "" },
      { label: "Name" },
      { label: "Service", title: "Service area type (Circular buffer or Walkshed)" },
      { label: "ID",     title: "Stop ID" },
      { label: "Routes", title: "Associated routes / lines" },
      { label: "",       cls: "as-col-copy", title: "Copy attributes" }
    ]));
    container.firstChild.classList.add("as-grid-points");

    rows.forEach(function (feat, idx) {
      var row = document.createElement("div");
      row.className = "as-row as-grid-points";
      row.dataset.featureType = "point";
      row.dataset.featureIndex = String(idx);

      if (!feat.properties.attributes) feat.properties.attributes = {};
      var attrs = feat.properties.attributes;

      appendCell(row, buildSwatchCell("point", idx, feat), "as-cell-swatch");
      appendCell(row, buildTextCell(
        function () { return feat.properties.name; },
        function (v) { feat.properties.name = v; saveAndRefreshFeaturePanel(); }
      ));
      appendCell(row, buildSelectCell(["", "walkshed"],
        function () { return attrs.serviceAreaType; },
        function (v) {
          if (v == null || v === "") delete attrs.serviceAreaType;
          else attrs.serviceAreaType = v;
          if (typeof App.ensurePointWalksheds === "function") App.ensurePointWalksheds();
          if (typeof App.refreshBuffers === "function") App.refreshBuffers();
          saveAndRefreshFeaturePanel();
          if (typeof App.notifyProject === "function") App.notifyProject();
        },
        { title: "Circular buffer or Walkshed", labels: { "": "Buffer", "walkshed": "Walkshed" } }
      ));
      appendCell(row, buildTextCell(
        function () { return attrs.stopId; },
        function (v) {
          if (v === "" || v == null) delete attrs.stopId;
          else attrs.stopId = v;
          saveAndRefreshFeaturePanel();
        },
        { placeholder: "e.g. 1042" }
      ));
      var badge = (typeof App.buildPointRouteBadge === "function")
        ? App.buildPointRouteBadge(feat)
        : document.createTextNode("—");
      appendCell(row, badge, "as-cell-badge");
      appendCell(row, buildCopyButton("point", idx, feat), "as-col-copy");

      container.appendChild(row);
    });
    return true;
  }

  /* ---- Lines / Routes (shared) ---- */

  function renderLineLike(container, featureType, features, gridClass) {
    if (!features.length) return false;
    container.innerHTML = "";

    // Selection action bar (hidden until rows are checked).
    container.appendChild(buildBulkBar(featureType));

    var hdr = buildHeader([
      { label: "", cls: "as-col-check" },
      { label: "" },
      { label: "Name" },
      { label: "Direction", cls: "as-col-narrow" },
      { label: "Mode",      cls: "as-col-narrow" },
      { label: "Service" },
      { label: "Avg Spd",   cls: "as-col-num", title: "Average speed (mph)" },
      { label: "RunT",      cls: "as-col-num", title: "Run time (minutes, one-way / loop)" },
      { label: "Bands",     cls: "as-col-narrow", title: "Time bands — Weekday · Saturday · Sunday counts" },
      { label: "Net",       cls: "as-col-narrow", title: "Walk network role (Lines only — see the Walk network section of the Attributes popup)" },
      { label: "",          cls: "as-col-copy", title: "Copy attributes" }
    ]);
    hdr.classList.add(gridClass);
    var selAll = makeCheckbox("as-rowcheck as-rowcheck-all");
    selAll.title = "Select all";
    selAll.addEventListener("change", function () { toggleAll(featureType, features.length, selAll.checked); });
    hdr.children[0].appendChild(selAll);
    container.appendChild(hdr);

    features.forEach(function (feat, idx) {
      var row = document.createElement("div");
      row.className = "as-row " + gridClass;
      row.dataset.featureType = featureType;
      row.dataset.featureIndex = String(idx);
      if (_selected[featureType].has(idx)) row.classList.add("as-selected");

      if (!feat.properties.attributes) feat.properties.attributes = {};
      var attrs = feat.properties.attributes;

      var cb = makeCheckbox("as-rowcheck");
      cb.checked = _selected[featureType].has(idx);
      (function (i, rowEl, box) {
        box.addEventListener("change", function () { onRowToggle(featureType, i, rowEl, box.checked); });
      })(idx, row, cb);
      appendCell(row, cb, "as-col-check");

      appendCell(row, buildSwatchCell(featureType, idx, feat), "as-cell-swatch");
      appendCell(row, buildTextCell(
        function () { return feat.properties.name; },
        function (v) { feat.properties.name = v; saveAndRefreshFeaturePanel(); }
      ));
      appendCell(row, buildSelectCell(DIRECTIONS,
        function () { return attrs.direction; },
        function (v) {
          if (v == null) delete attrs.direction; else attrs.direction = v;
          saveAndRefreshFeaturePanel();
        },
        { title: "Direction" }
      ), "as-col-narrow");
      appendCell(row, buildSelectCell(MODES,
        function () { return attrs.mode; },
        function (v) {
          if (v == null) delete attrs.mode; else attrs.mode = v;
          saveAndRefreshFeaturePanel();
        },
        { title: "Mode" }
      ), "as-col-narrow");
      appendCell(row, buildServiceIdCell(attrs, feat, featureType, idx));
      appendCell(row, buildNumberCell(
        function () { return attrs.avgSpeed; },
        function (v) {
          if (v == null) delete attrs.avgSpeed; else attrs.avgSpeed = v;
          saveAndRefreshFeaturePanel();
        },
        { placeholder: "14", min: 0, step: "any", title: "Average speed (mph)" }
      ), "as-col-num");
      appendCell(row, buildNumberCell(
        function () { return attrs.runTime; },
        function (v) {
          if (v == null) delete attrs.runTime; else attrs.runTime = v;
          saveAndRefreshFeaturePanel();
        },
        { placeholder: "—", min: 0, step: "any", title: "Run time (min)" }
      ), "as-col-num");
      var bandsBtn = (typeof App.buildTimeBandsBadge === "function")
        ? App.buildTimeBandsBadge(feat)
        : document.createTextNode("—");
      appendCell(row, bandsBtn, "as-col-narrow as-cell-badge");
      if (featureType === "line") {
        appendCell(row, buildSelectCell(["", "connector"],
          function () { return attrs.networkRole; },
          function (v) {
            if (v == null) delete attrs.networkRole; else attrs.networkRole = v;
            saveAndRefreshFeaturePanel();
            if (typeof App.refreshNetworkConnectors === "function") App.refreshNetworkConnectors();
          },
          { title: "Walk network role", labels: { "": "—", "connector": "Connector" } }
        ), "as-col-narrow");
      } else {
        appendCell(row, "—", "as-col-narrow as-cell-muted");
      }
      appendCell(row, buildCopyButton(featureType, idx, feat), "as-col-copy");

      container.appendChild(row);
    });
    updateBulkBar(featureType);
    return true;
  }

  // Service field is a text input with the shared autocomplete datalist
  // so colored/grouped service ids continue to share suggestions.
  function buildServiceIdCell(attrs, feature, featureType, featureIndex) {
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "as-input";
    inp.placeholder = "e.g. Blue Line";
    inp.title = "Service (pairing key for Route Costing)";
    inp.value = attrs.serviceId != null ? attrs.serviceId : "";

    // Reuse the shared datalist created by the per-feature popup
    var dlId = "fp-service-datalist";
    var dl = document.getElementById(dlId);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = dlId;
      document.body.appendChild(dl);
    }
    function refreshDatalist() {
      dl.innerHTML = "";
      var seen = {};
      [App.routes || [], App.lines || []].forEach(function (arr) {
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
    }
    refreshDatalist();
    inp.setAttribute("list", dlId);

    inp.addEventListener("change", function () {
      var newVal = inp.value.trim();
      if (newVal) {
        attrs.serviceId = newVal;
        // Inherit color from existing route/line with same serviceId
        var existingColor = null;
        [App.routes || [], App.lines || []].forEach(function (arr) {
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
            App.updateFeatureColor(featureType, featureIndex, existingColor);
          }
        }
      } else {
        delete attrs.serviceId;
      }
      refreshDatalist();
      saveAndRefreshFeaturePanel();
    });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") inp.blur(); });
    return inp;
  }

  /* ---- Polygons ---- */

  function renderPolygons(container) {
    var rows = App.polygons || [];
    if (!rows.length) return false;
    container.innerHTML = "";
    container.appendChild(buildHeader([
      { label: "" },
      { label: "Name" },
      { label: "Notes" },
      { label: "", cls: "as-col-copy", title: "Copy attributes" }
    ]));
    container.firstChild.classList.add("as-grid-polygons");

    rows.forEach(function (feat, idx) {
      var row = document.createElement("div");
      row.className = "as-row as-grid-polygons";
      row.dataset.featureType = "polygon";
      row.dataset.featureIndex = String(idx);

      if (!feat.properties.attributes) feat.properties.attributes = {};
      var attrs = feat.properties.attributes;

      appendCell(row, buildSwatchCell("polygon", idx, feat), "as-cell-swatch");
      appendCell(row, buildTextCell(
        function () { return feat.properties.name; },
        function (v) { feat.properties.name = v; saveAndRefreshFeaturePanel(); }
      ));
      appendCell(row, buildTextCell(
        function () { return attrs.notes; },
        function (v) {
          if (v === "" || v == null) delete attrs.notes;
          else attrs.notes = v;
          saveAndRefreshFeaturePanel();
        },
        { placeholder: "" }
      ));
      appendCell(row, buildCopyButton("polygon", idx, feat), "as-col-copy");

      container.appendChild(row);
    });
    return true;
  }

  /* ---- Text Boxes & Labels ---- */

  function renderMarkers(container, featureType, features, gridClass, updateFn) {
    if (!features.length) return false;
    container.innerHTML = "";
    container.appendChild(buildHeader([
      { label: "Name" },
      { label: "Size",       cls: "as-col-narrow" },
      { label: "Background", cls: "as-col-narrow" },
      { label: "Text",       cls: "as-col-narrow" }
    ]));
    container.firstChild.classList.add(gridClass);

    features.forEach(function (feat, idx) {
      var row = document.createElement("div");
      row.className = "as-row " + gridClass;
      row.dataset.featureType = featureType;
      row.dataset.featureIndex = String(idx);

      if (!feat.properties.attributes) feat.properties.attributes = {};
      var attrs = feat.properties.attributes;

      appendCell(row, buildTextCell(
        function () { return feat.properties.name; },
        function (v) {
          feat.properties.name = v;
          if (typeof updateFn === "function") updateFn(idx);
          saveAndRefreshFeaturePanel();
        }
      ));
      appendCell(row, buildSelectCell(FONT_SIZES,
        function () { return attrs.fontSize || feat.properties.fontSize; },
        function (v) {
          attrs.fontSize = v;
          feat.properties.fontSize = v;
          if (typeof updateFn === "function") updateFn(idx);
          saveAndRefreshFeaturePanel();
        },
        { title: "Font size" }
      ), "as-col-narrow");
      appendCell(row, buildColorSwatchCell(
        function () { return attrs.bgColor || feat.properties.bgColor; },
        function (v) {
          attrs.bgColor = v;
          feat.properties.bgColor = v;
          feat.properties.color   = v;
          if (typeof updateFn === "function") updateFn(idx);
          saveAndRefreshFeaturePanel();
        },
        { title: "Background color", defaultColor: "#1a202c" }
      ), "as-col-narrow as-cell-swatch");
      appendCell(row, buildColorSwatchCell(
        function () { return attrs.textColor || feat.properties.textColor; },
        function (v) {
          attrs.textColor = v;
          feat.properties.textColor = v;
          if (typeof updateFn === "function") updateFn(idx);
          saveAndRefreshFeaturePanel();
        },
        { title: "Text color", defaultColor: "#ffffff" }
      ), "as-col-narrow as-cell-swatch");

      container.appendChild(row);
    });
    return true;
  }

  /* ---- Top-level render ---- */

  function showSection(name, visible) {
    var sec = document.querySelector('.as-section[data-section="' + name + '"]');
    if (sec) sec.style.display = visible ? "" : "none";
  }

  function renderAll(opts) {
    if (!isPopupVisible()) return;

    // Selection clears on structural re-render (add/delete shifts indices);
    // bulk-apply passes preserveSelection so checkboxes survive the rebuild.
    if (!(opts && opts.preserveSelection)) {
      _selected.line.clear();
      _selected.route.clear();
    }

    var any = false;
    var pointsTbl   = el("asPointsTable");
    var linesTbl    = el("asLinesTable");
    var routesTbl   = el("asRoutesTable");
    var polysTbl    = el("asPolygonsTable");
    var tbTbl       = el("asTextboxesTable");
    var lblTbl      = el("asLabelsTable");

    var hasP = pointsTbl && renderPoints(pointsTbl);
    var hasL = linesTbl  && renderLineLike(linesTbl,  "line",  App.lines  || [], "as-grid-routelike");
    var hasR = routesTbl && renderLineLike(routesTbl, "route", App.routes || [], "as-grid-routelike");
    var hasG = polysTbl  && renderPolygons(polysTbl);
    var hasT = tbTbl     && renderMarkers(tbTbl, "textbox", App.textBoxes || [], "as-grid-marker", App.updateTextBoxAppearance);
    var hasB = lblTbl    && renderMarkers(lblTbl, "label",   App.labels    || [], "as-grid-marker", App.updateLabelAppearance);

    showSection("point",   !!hasP);
    showSection("line",    !!hasL);
    showSection("route",   !!hasR);
    showSection("polygon", !!hasG);
    showSection("textbox", !!hasT);
    showSection("label",   !!hasB);

    any = hasP || hasL || hasR || hasG || hasT || hasB;
    var emptyEl = el("asEmpty");
    if (emptyEl) emptyEl.style.display = any ? "none" : "";
  }

  /* ---- Module registration ---- */

  App.registerModule({
    id: "attribute-summary",
    name: "Attribute Summary",
    enabled: true,
    system: true,           // skip in Analysis sidebar dropdown
    popupWidth: 1000,
    popupHTML: "projects/attribute-summary-popup.html",

    init: function (/* core */) {
      // App.notifyProject() (called after feature add/delete and cache restore)
      // invokes our update() hook, which re-renders. Nothing else to wire here
      // besides the Copy Attributes modal's Cancel/Apply buttons.
      var cancelBtn = el("asCopyCancelBtn");
      if (cancelBtn) cancelBtn.addEventListener("click", closeCopyModal);
      var applyBtn = el("asCopyApplyBtn");
      if (applyBtn) applyBtn.addEventListener("click", applyCopyAttributes);
    },

    onOpen: function (/* core */) {
      renderAll();
    },

    onClose: function (/* core */) {
      // Feature state lives on the features themselves — nothing to clean up
      // there, but close the Copy Attributes modal so it doesn't pop back up
      // the next time this popup opens.
      closeCopyModal();
    },

    update: function (/* core */) {
      // Called when features add/delete or external state changes.
      if (isPopupVisible()) renderAll();
    }
  });

})();
