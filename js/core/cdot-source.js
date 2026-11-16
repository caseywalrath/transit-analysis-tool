/* CDOT road-layer source — App.cdotSource.
 * Remembers whether CDOT's public road layers should answer street requests
 * (and which layers), fetches every page of those layers for a list of boxes,
 * and wires the "CDOT Road Layers" dialog. Knows nothing about graphs or the
 * road network: the caller turns the returned GeoJSON into streets.
 * The setting is per browser (localStorage), never in the session file: a
 * session is shared with other people and this is a personal choice of source.
 * Detail: docs/cdot-roads-plan.md.
 */
(function () {
  "use strict";

  var App = window.App = window.App || {};

  var STORAGE_KEY = "mat-cdot-source";
  var ALLOWED = [7, 14, 17];
  var DEFAULT_LAYERS = [14, 17];
  var MAX_PAGES = 50;
  var HOST = "dtdapps.codot.gov";
  // Read at call time through App.cdotSource._timeoutMs so a test can shorten it.
  var TIMEOUT_MS = 60000;

  // In-memory value: still works for the session when storage throws.
  var _active = false;
  var _layers = DEFAULT_LAYERS.slice();

  function setStatus(text) {
    if (typeof App.setStatus === "function") App.setStatus(text);
  }

  function tilesHaveSource() {
    return !!(App.walkTilesSource && typeof App.walkTilesSource.hasSource === "function" &&
      App.walkTilesSource.hasSource());
  }

  function normaliseLayers(ids) {
    var out = [];
    if (!Array.isArray(ids)) return out;
    for (var i = 0; i < ids.length; i++) {
      var v = ids[i];
      if (typeof v !== "number" && typeof v !== "string") continue;
      if (typeof v === "string" && v.trim() === "") continue;
      var n = Number(v);
      if (ALLOWED.indexOf(n) !== -1 && out.indexOf(n) === -1) out.push(n);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: _active, layers: _layers.slice() }));
    } catch (e) { /* private mode: the choice lasts for this session only */ }
  }

  function isActive() { return _active; }

  function layers() { return _layers.slice(); }

  // String sort on purpose: "14+17+7", matching the text in the design brief.
  function layersKey() { return layers().map(String).sort().join("+"); }

  // Every setting change ends here.
  function afterChange() {
    renderInfo();
    if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();
    if (App.walkTilesSource && typeof App.walkTilesSource.renderInfo === "function") {
      App.walkTilesSource.renderInfo();
    }
    // Open analysis panels relabel their "load streets" button from these. Not
    // App.notifyProject(): that marks results stale, and the loaded streets
    // have not changed. The tiles event is kept because existing panels
    // listen to it.
    try { document.dispatchEvent(new CustomEvent("street-source-changed")); } catch (e) { /* no DOM events */ }
    try { document.dispatchEvent(new CustomEvent("walk-tiles-source-changed")); } catch (e2) { /* no DOM events */ }
  }

  function setActive(on) {
    var next = !!on;
    var changed = next !== _active;
    _active = next;
    if (changed) {
      persist();
      if (next) {
        setStatus("CDOT will supply streets for new downloads. Loaded streets stay until replaced." +
          (tilesHaveSource() ? " FLM tile source paused." : ""));
      } else if (App.walkTilesSource && typeof App.walkTilesSource.isActive === "function" &&
          App.walkTilesSource.isActive()) {
        setStatus("FLM tiles will supply streets for new downloads.");
      } else {
        setStatus("OpenStreetMap will supply streets for new downloads.");
      }
    }
    afterChange();
  }

  function setLayers(ids) {
    var next = normaliseLayers(ids);
    if (next.length === 0) return false;
    _layers = next;
    persist();
    afterChange();
    return true;
  }

  function restore() {
    var active = false;
    var lyr = DEFAULT_LAYERS.slice();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
          active = obj.active === true;
          var stored = normaliseLayers(obj.layers);
          if (stored.length) lyr = stored;
        }
      }
    } catch (e) { /* storage unavailable or malformed: defaults */ }
    _active = active;
    _layers = lyr;
    afterChange();
  }

  // ---- Fetch ----

  function messageOf(e) {
    return (e && e.message) || String(e) || "unknown error";
  }

  function validBox(b) {
    if (!Array.isArray(b) || b.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (typeof b[i] !== "number" || !isFinite(b[i])) return false;
    }
    return true;
  }

  // One request. Resolves { page } or { error }; never rejects.
  async function requestPage(layerId, url, n) {
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, App.cdotSource._timeoutMs);
    try {
      var resp;
      try {
        resp = await fetch(url, { signal: controller.signal });
      } catch (e) {
        if (timedOut) return { error: "CDOT road download failed: layer " + layerId + " page " + n + " timed out after 60 s" };
        return { error: "CDOT road download failed: could not reach " + HOST + " (" + messageOf(e) + ")" };
      }
      if (!resp.ok) {
        return { error: "CDOT road download failed: layer " + layerId + " returned HTTP " + resp.status };
      }
      var page;
      try {
        page = await resp.json();
      } catch (e2) {
        if (timedOut) return { error: "CDOT road download failed: layer " + layerId + " page " + n + " timed out after 60 s" };
        return { error: "CDOT road download failed: layer " + layerId + " page " + n + ": response is not JSON" };
      }
      // ArcGIS reports many query errors as HTTP 200 with an error body; its
      // message says far more than "not a FeatureCollection".
      if (page && page.error && typeof page.error === "object") {
        return { error: "CDOT road download failed: layer " + layerId + " page " + n + ": server error " +
          (page.error.code != null ? page.error.code + " " : "") + (page.error.message || "") };
      }
      return { page: page };
    } finally {
      clearTimeout(timer);
    }
  }

  function fetchExtent(boxes, progress) {
    return fetchExtentInner(boxes, progress).catch(function (e) {
      return { ok: false, error: "CDOT road download failed: " + messageOf(e) };
    });
  }

  async function fetchExtentInner(boxes, progress) {
    var list = Array.isArray(boxes) && boxes.length && !validBox(boxes) ? boxes : [boxes];
    var valid = [];
    for (var b = 0; b < list.length; b++) {
      if (validBox(list[b])) valid.push(list[b]);
    }
    if (!valid.length) return { ok: false, error: "CDOT road download failed: no area to download" };

    var ids = layers();
    var failure = null;
    var requests = 0;

    function say(text) {
      if (typeof progress !== "function") return;
      try { progress(text); } catch (e) { /* progress is cosmetic */ }
    }

    async function runLayer(layerId) {
      var all = [];
      for (var k = 0; k < valid.length; k++) {
        var offset = 0;
        var n = 1;
        for (;;) {
          if (failure) return null;
          say("Downloading CDOT roads… layer " + layerId + " page " + n +
            (valid.length > 1 ? " (area " + (k + 1) + " of " + valid.length + ")" : ""));
          requests++;
          var r = await requestPage(layerId, window.CdotRoads.pageUrl(layerId, valid[k], offset), n);
          if (r.error) { if (!failure) failure = r.error; return null; }
          var check = window.CdotRoads.validatePage(r.page);
          if (!check.ok) {
            if (!failure) failure = "CDOT road download failed: layer " + layerId + " page " + n + ": " + check.error;
            return null;
          }
          for (var i = 0; i < r.page.features.length; i++) all.push(r.page.features[i]);
          if (!window.CdotRoads.hasMore(r.page)) break;
          if (n >= MAX_PAGES) {
            if (!failure) failure = "CDOT road download stopped: layer " + layerId + " exceeded " + MAX_PAGES + " pages; the area is too large.";
            return null;
          }
          n++;
          // By what the page held, not the page size: a server that cuts a page
          // short and still sets the flag would otherwise make us skip features.
          offset += r.page.features.length || window.CdotRoads.PAGE_SIZE;
        }
      }
      return { layerId: layerId, features: all };
    }

    var results = await Promise.all(ids.map(runLayer));
    if (failure) return { ok: false, error: failure };
    var merged = window.CdotRoads.toRoadGeoJSON(results);
    return { ok: true, geojson: merged.geojson, report: merged.report, requests: requests };
  }

  // ---- Dialog ----

  function addLine(parent, text) {
    var div = document.createElement("div");
    div.textContent = text;
    parent.appendChild(div);
    return div;
  }

  function renderInfo() {
    if (typeof document === "undefined" || !document.getElementById) return;
    var i;
    for (i = 0; i < ALLOWED.length; i++) {
      var cb = document.getElementById("cdotLayer" + ALLOWED[i]);
      if (cb) cb.checked = _layers.indexOf(ALLOWED[i]) !== -1;
    }
    var useBtn = document.getElementById("cdotUse");
    if (useBtn) {
      useBtn.textContent = _active
        ? (App.walkTilesSource && App.walkTilesSource.hasSource && App.walkTilesSource.hasSource()
          ? "Using CDOT — switch back to FLM tiles"
          : "Using CDOT — switch back to OpenStreetMap")
        : "Use CDOT for street downloads";
    }
    var info = document.getElementById("cdotInfo");
    if (!info) return;
    while (info.firstChild) info.removeChild(info.firstChild);
    if (_active) {
      addLine(info, "Layers in use: " + layersKey());
      addLine(info, "Per browser setting; not saved in the session file.");
      if (tilesHaveSource()) addLine(info, "FLM tile source paused.");
    } else {
      addLine(info, "OpenStreetMap supplies streets unless an FLM tile source is set.");
    }
    if (_layers.indexOf(7) !== -1) {
      addLine(info, "Highways layer is on: its lines join local streets only where endpoints happen to meet.");
    }
  }

  function wireDialog() {
    var popup = document.getElementById("cdot-popup");
    if (!popup) return;

    var closeBtn = document.getElementById("cdot-popup-close");
    if (closeBtn) closeBtn.addEventListener("click", function () { popup.style.display = "none"; });

    var msg = document.getElementById("cdotLayerMsg");
    ALLOWED.forEach(function (id) {
      var cb = document.getElementById("cdotLayer" + id);
      if (!cb) return;
      cb.addEventListener("change", function () {
        var checked = [];
        ALLOWED.forEach(function (other) {
          var el = document.getElementById("cdotLayer" + other);
          if (el && el.checked) checked.push(other);
        });
        if (setLayers(checked)) {
          if (msg) msg.style.display = "none";
        } else {
          cb.checked = true;
          if (msg) {
            msg.textContent = "Choose at least one layer.";
            msg.style.display = "";
          }
        }
      });
    });

    var useBtn = document.getElementById("cdotUse");
    if (useBtn) useBtn.addEventListener("click", function () { setActive(!isActive()); });
  }

  App.cdotSource = {
    isActive: isActive,
    layers: layers,
    layersKey: layersKey,
    setActive: setActive,
    setLayers: setLayers,
    fetchExtent: fetchExtent,
    restore: restore,
    renderInfo: renderInfo,
    _timeoutMs: TIMEOUT_MS
  };

  wireDialog();
})();
