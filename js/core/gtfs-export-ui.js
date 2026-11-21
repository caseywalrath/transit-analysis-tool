// js/core/gtfs-export-ui.js
// "Drawn Services as GTFS (ZIP)" export dialog (Export menu) and App.gtfsExportBlob.
// The dialog reuses the .gp-dialog frame; the file itself is built by GtfsExport.build from
// App.gtfsExportInput, so this file only gathers choices and hands the ZIP to the browser.
// Loads after analysis-network-source.js; JSZip and the engine are read at call time.

(function () {
  "use strict";

  var App = window.App;
  var AGENCY_KEY = "mat.gtfsExport.agency";
  var _wired = false;

  function el(id) { return document.getElementById(id); }

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // Local calendar date as the value of an <input type="date">.
  function dateValue(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function todayYmd() { return dateValue(new Date()).replace(/-/g, ""); }

  // Builds the feed and zips it. Engine errors reject, so the dialog can show their exact text.
  // Resolves { blob, result, skipped }.
  App.gtfsExportBlob = function (serviceKeys, opts) {
    var o = opts || {};
    return Promise.resolve().then(function () {
      var made = App.gtfsExportInput(serviceKeys, {
        includeHidden: true,
        agency: o.agency,
        startDate: o.startDate,
        endDate: o.endDate,
        frequencies: o.frequencies,
        feedVersion: todayYmd()
      });
      var result = window.GtfsExport.build(made.input);
      var zip = new JSZip();
      result.files.forEach(function (f) { zip.file(f.name, f.text); });
      return zip.generateAsync({ type: "blob", compression: "DEFLATE" }).then(function (blob) {
        return { blob: blob, result: result, skipped: made.skipped };
      });
    });
  };

  function setStatus(lines, isError) {
    var box = el("gex-status");
    box.textContent = "";
    box.classList.toggle("is-error", !!isError);
    (Array.isArray(lines) ? lines : [lines]).forEach(function (line) {
      var d = document.createElement("div");
      d.textContent = line;
      box.appendChild(d);
    });
  }

  function savedAgency() {
    try {
      var raw = localStorage.getItem(AGENCY_KEY);
      var a = raw ? JSON.parse(raw) : null;
      if (a && typeof a === "object") return a;
    } catch (e) { /* storage blocked or corrupt: use defaults */ }
    return null;
  }

  function defaultTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Denver";
    } catch (e) { return "America/Denver"; }
  }

  function fillServices() {
    var box = el("gex-services");
    var services = typeof App.buildTransitServices === "function" ? (App.buildTransitServices() || []) : [];
    box.textContent = "";
    if (!services.length) {
      box.textContent = "Draw a Line or Route and assign it a Service with headway bands first.";
      el("gex-export").disabled = true;
      return;
    }
    el("gex-export").disabled = false;
    services.forEach(function (svc) {
      var blocked = App.hasBlockingWarnings(svc);
      var label = document.createElement("label");
      label.className = "gex-svc";
      var box1 = document.createElement("input");
      box1.type = "checkbox";
      box1.value = svc.key;
      box1.checked = !blocked;
      box1.disabled = blocked;
      label.appendChild(box1);
      label.appendChild(document.createTextNode(" " + svc.name + (blocked ? " — needs setup" : "")));
      box.appendChild(label);
    });
  }

  function checkedKeys() {
    var out = [];
    var boxes = el("gex-services").querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked && !boxes[i].disabled) out.push(boxes[i].value);
    }
    return out;
  }

  // "2027-01-05" -> "20270105"; a blank date stays blank so the engine reports it.
  function compactDate(v) { return String(v || "").replace(/-/g, ""); }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // The click starts the save asynchronously; revoking in the same tick can cancel it.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function onExport() {
    var btn = el("gex-export");
    var agency = {
      name: el("gex-agency-name").value,
      url: el("gex-agency-url").value,
      timezone: el("gex-agency-tz").value,
      lang: el("gex-agency-lang").value
    };
    var startDate = compactDate(el("gex-start").value);
    var endDate = compactDate(el("gex-end").value);
    btn.disabled = true;
    setStatus("Building…", false);
    try { localStorage.setItem(AGENCY_KEY, JSON.stringify(agency)); } catch (e) { /* storage blocked: not remembered */ }
    App.gtfsExportBlob(checkedKeys(), {
      agency: agency, startDate: startDate, endDate: endDate, frequencies: el("gex-frequencies").checked
    }).then(function (res) {
      download(res.blob, "drawn-services-gtfs-" + startDate + ".zip");
      var c = res.result.counts;
      var lines = ["Exported " + c.routes + " routes, " + c.trips + " trips in the file (" + c.tripsRepresented +
        " departures), " + c.stops + " stops."];
      res.result.warnings.forEach(function (w) { lines.push(w); });
      res.skipped.forEach(function (s) { lines.push(s.name + ": " + s.reason); });
      setStatus(lines, false);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : String(err), true);
    }).then(function () {
      // Only the "no Services" state keeps the button off; a run never changes the list.
      btn.disabled = !el("gex-services").querySelector("input[type=checkbox]");
    });
  }

  function isOpen() { return !el("gex-dialog").hidden; }

  function close() {
    el("gex-dialog").hidden = true;
    document.removeEventListener("keydown", onKey, true);
  }

  // Capture phase and stopPropagation, so Escape closes only this dialog and not the attributes dock,
  // an analysis panel or an active drawing tool.
  function onKey(e) {
    if (e.key !== "Escape" || !isOpen()) return;
    e.stopPropagation();
    close();
  }

  function wire() {
    if (_wired) return;
    _wired = true;
    el("gex-cancel").addEventListener("click", close);
    el("gex-export").addEventListener("click", onExport);
  }

  App.openGtfsExportDialog = function () {
    wire();
    fillServices();
    var a = savedAgency() || {};
    el("gex-agency-name").value = a.name || "";
    el("gex-agency-url").value = a.url || "";
    el("gex-agency-tz").value = a.timezone || defaultTimeZone();
    el("gex-agency-lang").value = a.lang || "en";
    var today = new Date();
    var end = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate() - 1);
    el("gex-start").value = dateValue(today);
    el("gex-end").value = dateValue(end);
    setStatus("", false);
    el("gex-dialog").hidden = false;
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", onKey, true);
  };
})();
