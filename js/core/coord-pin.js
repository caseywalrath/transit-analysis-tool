// coord-pin.js — click the empty map to pin its lat/lon beside the scale bar,
// and the right-click "Copy coordinates" menu item (App.coordPin).
// Temporary like the Measure tool: never saved with the session.
(function () {
  "use strict";
  var App = window.App;
  var DECIMALS = 6;

  var box = null, textEl = null, marker = null;

  function fmt(lngLat) {
    return lngLat.lat.toFixed(DECIMALS) + ", " + lngLat.lng.toFixed(DECIMALS);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    }
    legacyCopy(text);
    return Promise.resolve();
  }

  // Fallback for file:// pages, where the async clipboard API may be blocked.
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing more to try */ }
    document.body.removeChild(ta);
  }

  function ensureBox() {
    if (box) return box;
    var scale = document.querySelector("#map .maplibregl-ctrl-scale");
    if (!scale) return null;
    box = document.createElement("div");
    box.className = "maplibregl-ctrl coord-pin";
    box.hidden = true;
    box.innerHTML =
      '<span class="coord-pin-text" title="Lat, Lon — select to copy"></span>' +
      '<button type="button" class="coord-pin-btn coord-pin-copy" title="Copy coordinates" aria-label="Copy coordinates">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      '</button>' +
      '<button type="button" class="coord-pin-btn coord-pin-close" title="Clear (Esc)" aria-label="Clear coordinates">×</button>';
    textEl = box.querySelector(".coord-pin-text");
    // Keep clicks and drags inside the box from reaching the map.
    ["mousedown", "click", "dblclick", "contextmenu"].forEach(function (ev) {
      box.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    var copyBtn = box.querySelector(".coord-pin-copy");
    copyBtn.addEventListener("click", function () {
      copyText(textEl.textContent).then(function () {
        copyBtn.classList.add("copied");
        setTimeout(function () { copyBtn.classList.remove("copied"); }, 900);
      });
    });
    box.querySelector(".coord-pin-close").addEventListener("click", clear);
    // Sit on the scale bar's row (see .coord-pin in style.css).
    scale.parentNode.insertBefore(box, scale.nextSibling);
    return box;
  }

  function pin(lngLat) {
    if (!ensureBox()) return;
    textEl.textContent = fmt(lngLat);
    box.hidden = false;
    if (!marker) {
      var el = document.createElement("div");
      el.className = "coord-pin-marker";
      marker = new maplibregl.Marker({ element: el });
    }
    marker.setLngLat(lngLat).addTo(App.map);
  }

  function clear() {
    if (box) box.hidden = true;
    if (marker) marker.remove();
  }

  function isPinned() { return !!(box && !box.hidden); }

  function hitsDrawnFeature(point) {
    var ids = [];
    if (typeof App.pointLayerIds === "function") ids = ids.concat(App.pointLayerIds());
    if (typeof App.lineStyleLayerIds === "function") ids = ids.concat(App.lineStyleLayerIds());
    ids.push("polygons-fill");
    ids = ids.filter(function (id) { return App.map.getLayer(id); });
    if (!ids.length) return false;
    try { return App.map.queryRenderedFeatures(point, { layers: ids }).length > 0; }
    catch (e) { return false; }
  }

  function init() {
    var map = App.map;
    if (!map) return;
    map.on("click", function (e) {
      var oe = e.originalEvent || {};
      if (App.drawMode || oe.shiftKey || oe.ctrlKey || oe.metaKey) return;
      if (hitsDrawnFeature(e.point)) return; // clicking a feature selects it; leave the pin alone
      pin(e.lngLat);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !isPinned()) return;
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      clear();
    });
  }

  // Menu item shared by the empty-map and feature right-click menus (editing.js).
  function menuItem(lngLat) {
    return { label: "Copy coordinates", action: function () { copyText(fmt(lngLat)); pin(lngLat); } };
  }

  App.coordPin = { pin: pin, clear: clear, isPinned: isPinned, format: fmt, copy: copyText, menuItem: menuItem };

  init();
})();
