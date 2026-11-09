// js/core/gpkg-filter-ui.js
// Fill and Filter controls for a GeoPackage layer's style drawer
// (App.gpkgBuildLayerControls). The rows are appended to the drawer body and
// report every change through ctx.onFillAlpha and ctx.onFilter. The module keeps
// no state and never touches the map: the caller re-renders the drawer after each
// change, so the rows built here are replaced rather than updated.
// CONSTRAINT: ES5. window.GpkgFilter and App.buildScrubber are read only inside
// gpkgBuildLayerControls, so this file can load before either is needed.

(function () {
  "use strict";
  var App = window.App;

  // Each value list needs its own datalist id. The counter only has to be unique
  // within the document, so it lives here and counts every row built.
  var listSeq = 0;

  // Each control stops its click, as the other drawer controls do, so the layer
  // row that holds the drawer does not also react to it.
  function stop(e) { e.stopPropagation(); }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addOption(select, value, text) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  }

  function findOp(GF, id) {
    for (var i = 0; i < GF.OPS.length; i++) {
      if (GF.OPS[i].id === id) return GF.OPS[i];
    }
    return null;
  }

  function buildFillRow(body, ctx) {
    var row = make("div", "lp-style-row");
    row.appendChild(make("span", "lp-style-label", "Fill"));

    var wrap = make("div", "lp-style-control");
    // The scrubber's buttons and input sit inside this wrapper, so one stop here
    // covers them all.
    wrap.addEventListener("click", stop);
    var scrubber = App.buildScrubber({
      min: 0,
      max: 100,
      step: 5,
      unit: "%",
      value: Math.round(ctx.fillAlpha * 100),
      onChange: function (v) { ctx.onFillAlpha(v / 100); }
    });
    var input = scrubber.querySelector("input");
    if (input) input.setAttribute("aria-label", "Fill for " + ctx.styleLabel);
    wrap.appendChild(scrubber);
    row.appendChild(wrap);
    body.appendChild(row);
  }

  function buildHead(body, ctx) {
    var head = make("div", "gp-filter-head", "Filter");
    var count = make("span", "gp-filter-count");
    if (ctx.filter) {
      count.textContent = ctx.matchCount.toLocaleString() + " of " +
        ctx.featureCount.toLocaleString() + " shown";
    }
    head.appendChild(count);
    body.appendChild(head);
  }

  App.gpkgBuildLayerControls = function (body, ctx) {
    var GF = window.GpkgFilter;
    var columns = ctx.columns || [];
    // The live condition rows, in order, including the blank last row. Removing a
    // row takes it out of this list, so later commits do not bring it back even
    // before the caller re-renders.
    var rows = [];

    // Reports the filter as the rows stand. normalize drops incomplete rows (the
    // blank row, or a value not typed yet) instead of rejecting the whole filter.
    function commit() {
      var list = [];
      for (var i = 0; i < rows.length; i++) {
        list.push({
          field: rows[i].field.value,
          op: rows[i].op.value,
          value: rows[i].value.value
        });
      }
      ctx.onFilter(GF.normalize({ conditions: list }));
    }

    function removeRow(row) {
      var i = rows.indexOf(row);
      if (i >= 0) rows.splice(i, 1);
      commit();
    }

    // Refills the row's datalist for its current field. An empty or "*" field has
    // no per-column values to suggest.
    function fillValues(row) {
      var list = row.list;
      while (list.firstChild) list.removeChild(list.firstChild);
      var field = row.field.value;
      if (field === "" || field === "*") return;
      var res = ctx.fieldValues(field);
      var values = res && res.values ? res.values : [];
      for (var i = 0; i < values.length; i++) {
        var opt = document.createElement("option");
        opt.value = values[i];
        opt.textContent = values[i];
        list.appendChild(opt);
      }
    }

    // Shows the value box only for operators that compare against a value, and
    // hints the list syntax for "is one of".
    function syncValue(row) {
      var info = findOp(GF, row.op.value);
      var needs = !info || info.needsValue;
      row.value.style.display = needs ? "" : "none";
      row.value.placeholder = row.op.value === "in" ? "a, b, c" : "value";
    }

    function addRow(cond, removable) {
      var root = make("div", "gp-filter-cond");

      var fieldSel = make("select", "lp-basemap-select gp-filter-field");
      fieldSel.setAttribute("aria-label", "Filter field for " + ctx.styleLabel);
      addOption(fieldSel, "", "Field…");
      for (var c = 0; c < columns.length; c++) addOption(fieldSel, columns[c], columns[c]);
      var fieldValue = cond ? cond.field : "";
      // "Any column" exists only for a condition that already uses it. It is made
      // by the table window's "Show matching on map", never picked here.
      if (fieldValue === "*") addOption(fieldSel, "*", "Any column");
      fieldSel.value = fieldValue;

      var opSel = make("select", "lp-basemap-select lp-select-sm gp-filter-op");
      opSel.setAttribute("aria-label", "Filter operator for " + ctx.styleLabel);
      for (var o = 0; o < GF.OPS.length; o++) addOption(opSel, GF.OPS[o].id, GF.OPS[o].label);
      opSel.value = cond ? cond.op : "eq";

      var valueInp = make("input", "gp-filter-value");
      valueInp.type = "text";
      valueInp.setAttribute("autocomplete", "off");
      valueInp.setAttribute("aria-label", "Filter value for " + ctx.styleLabel);
      valueInp.value = cond ? cond.value : "";

      listSeq += 1;
      var list = make("datalist");
      list.id = "gp-filter-values-" + listSeq;
      valueInp.setAttribute("list", list.id);

      root.appendChild(fieldSel);
      root.appendChild(opSel);
      root.appendChild(valueInp);
      root.appendChild(list);

      var row = { root: root, field: fieldSel, op: opSel, value: valueInp, list: list };

      if (removable) {
        var removeBtn = make("button", "lp-style-clear", "×");
        removeBtn.type = "button";
        removeBtn.title = "Remove condition";
        removeBtn.setAttribute("aria-label", "Remove filter condition");
        removeBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          removeRow(row);
        });
        root.appendChild(removeBtn);
      }

      // Field and operator changes commit at once. The value box commits on change
      // (Enter or blur), and Enter also commits from the keyboard directly.
      fieldSel.addEventListener("click", stop);
      fieldSel.addEventListener("change", function () {
        fillValues(row);
        commit();
      });
      opSel.addEventListener("click", stop);
      opSel.addEventListener("change", function () {
        syncValue(row);
        commit();
      });
      valueInp.addEventListener("click", stop);
      // Every key stops here, so typing in the box never reaches the app's shortcuts.
      valueInp.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      });
      valueInp.addEventListener("change", function () { commit(); });

      fillValues(row);
      syncValue(row);
      rows.push(row);
      body.appendChild(root);
    }

    if (ctx.hasPolygons) buildFillRow(body, ctx);
    buildHead(body, ctx);

    var conditions = (ctx.filter && ctx.filter.conditions) || [];
    for (var i = 0; i < conditions.length; i++) addRow(conditions[i], true);
    addRow(null, false);

    if (ctx.filter) {
      var reset = make("button", "lp-style-reset", "Clear filter");
      reset.type = "button";
      reset.addEventListener("click", function (e) {
        e.stopPropagation();
        ctx.onFilter(null);
      });
      body.appendChild(reset);
    }
  };
})();
