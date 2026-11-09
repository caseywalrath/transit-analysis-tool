// js/core/gpkg-table.js
// Attribute-table window for tables imported from a GeoPackage. The window knows
// nothing about GeoPackage internals: the caller passes plain rows and decides
// what a row click does (zoom to a feature, or nothing for a plain table).
// Cell text comes from GpkgReader.formatValue. GpkgReader and App.popup are
// referenced only inside functions, so this file loads on its own.

(function () {
  "use strict";
  var App = window.App;

  var WIDGET_ID = "gpkg-table";
  // Drawing every row of a large table makes the window slow to open and to
  // filter, so only the first rows are drawn; the count line says so.
  var VIEW_ROWS = 500;

  // Bumped on every open and close. showFloatingWidget is async, so an earlier
  // open can finish after a later open or a close has started. That earlier open
  // must then do nothing, or it would fill the newer window with its rows.
  var _openSeq = 0;

  function esc(s) { return App.escapeHTML(s); }

  function widgetEl() {
    return document.querySelector('.floating-widget[data-widget-id="' + WIDGET_ID + '"]');
  }

  function countText(matchCount, filtered, shownCount, total, loadedCount, note) {
    var text = matchCount.toLocaleString() + (filtered ? " matching" : "") + " row" + (matchCount === 1 ? "" : "s");
    if (shownCount < matchCount) text += " · showing first " + shownCount.toLocaleString();
    if (total > loadedCount) text += " · file has " + total.toLocaleString() + ", only " + loadedCount.toLocaleString() + " loaded";
    if (note) text += " · " + note;
    return text;
  }

  function buildBody(widget, columns, rows, total, onRowClick, onApplyFilter, note) {
    var fmt = window.GpkgReader.formatValue;
    var clickable = !!onRowClick;

    widget.classList.add("gp-table-widget");
    var body = widget.querySelector(".floating-widget-body");
    body.innerHTML =
      '<div class="gp-table-tools">' +
        '<input type="search" class="gp-table-filter" placeholder="Filter rows (any column)" aria-label="Filter rows">' +
        '<span class="gp-table-count"></span>' +
        (onApplyFilter ? '<button type="button" class="rf-btn-sm gp-table-apply">Show matching on map</button>' : "") +
      "</div>" +
      '<div class="gp-table-scroll"><table class="gp-table' + (clickable ? " gp-table-spatial" : "") + '"><thead></thead><tbody></tbody></table></div>' +
      (clickable ? '<div class="gp-table-hint">Click a row to zoom to it.</div>' : "");

    var thead = body.querySelector("thead"), tbody = body.querySelector("tbody");
    var countEl = body.querySelector(".gp-table-count");
    var filterEl = body.querySelector(".gp-table-filter");
    var applyEl = body.querySelector(".gp-table-apply");
    thead.innerHTML = "<tr><th>#</th>" + columns.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";

    // Each row's searchable text is built once, on the first filter, not on
    // every keystroke: a layer's table can hold every feature of the layer.
    var rowText = null;
    function rowMatches(i, q) {
      if (!rowText) {
        rowText = rows.map(function (row) {
          return columns.map(function (c) { return fmt(row[c]).toLowerCase(); }).join("\u0000");
        });
      }
      return rowText[i].indexOf(q) >= 0;
    }

    function draw() {
      var q = filterEl.value.trim().toLowerCase();
      var matches = [];
      for (var i = 0; i < rows.length; i++) {
        if (q && !rowMatches(i, q)) continue;
        matches.push(i);
      }
      var shown = matches.slice(0, VIEW_ROWS);
      tbody.innerHTML = shown.map(function (i) {
        var r = rows[i];
        return '<tr data-row="' + i + '"><td>' + (i + 1) + "</td>" +
          columns.map(function (c) { return "<td>" + esc(fmt(r[c])) + "</td>"; }).join("") + "</tr>";
      }).join("");
      countEl.textContent = countText(matches.length, !!q, shown.length, total, rows.length, note);
      // An empty filter would hand the caller a condition that matches every row,
      // so the button waits for text to apply.
      if (applyEl) applyEl.disabled = !q;
    }

    var timer = null;
    filterEl.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(draw, 150);
    });
    // Keep typing in the filter from reaching the app's document-level keyboard handlers.
    filterEl.addEventListener("keydown", function (e) { e.stopPropagation(); });
    if (applyEl) {
      applyEl.addEventListener("click", function () { onApplyFilter(filterEl.value.trim()); });
    }

    if (clickable) {
      tbody.addEventListener("click", function (e) {
        var tr = e.target.closest("tr[data-row]");
        if (!tr) return;
        Array.prototype.forEach.call(tbody.querySelectorAll("tr.gp-row-active"), function (x) { x.classList.remove("gp-row-active"); });
        tr.classList.add("gp-row-active");
        onRowClick(Number(tr.getAttribute("data-row")));
      });
    }
    draw();
  }

  /**
   * Open the attribute-table window, replacing any open one.
   * @param {object} opts — { title, columns: [names], rows: [plain objects],
   *   total, onRowClick: function (rowIndex) | null,
   *   onApplyFilter: function (filterText) | absent (adds the "Show matching on map" button),
   *   note: string | absent (appended to the count line) }
   * @returns {Promise} resolves once the window is built (or superseded)
   */
  function gpkgOpenTable(opts) {
    opts = opts || {};
    var columns = opts.columns || [];
    var rows = opts.rows || [];
    var total = opts.total;
    var onRowClick = typeof opts.onRowClick === "function" ? opts.onRowClick : null;
    var onApplyFilter = typeof opts.onApplyFilter === "function" ? opts.onApplyFilter : null;
    var note = typeof opts.note === "string" ? opts.note : "";
    var seq = ++_openSeq;

    App.popup.removeFloatingWidget(WIDGET_ID);
    return App.popup.showFloatingWidget(WIDGET_ID, null, {
      position: "bottom-left", width: 560, title: esc(opts.title || "")
    }).then(function () {
      if (seq !== _openSeq) return;
      var widget = widgetEl();
      if (!widget) return;
      buildBody(widget, columns, rows, total, onRowClick, onApplyFilter, note);
      // The shared close button only hides a widget; this one holds a whole
      // layer's rows, so closing removes it and frees them.
      var closeBtn = widget.querySelector(".floating-widget-close");
      if (closeBtn) closeBtn.addEventListener("click", function () { gpkgCloseTable(); });
    });
  }

  function gpkgCloseTable() {
    _openSeq++;
    App.popup.removeFloatingWidget(WIDGET_ID);
  }

  App.gpkgOpenTable = gpkgOpenTable;
  App.gpkgCloseTable = gpkgCloseTable;

})();
