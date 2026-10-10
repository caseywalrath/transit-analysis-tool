// js/core/textboxes.js
// Draggable, resizable text box annotations placed on the map by click-and-drag.
// Exports: see the Exports block at the end of the file.

(function () {
  var App = window.App = window.App || {};

  var textBoxes = [];
  var _markers  = [];   // parallel array of maplibregl.Marker instances
  var _tbCounter = 0;

  var FONT_SIZES = { Small: 12, Medium: 16, Large: 22, XL: 30 };
  var DEFAULT_BG        = "#ffffff";
  var DEFAULT_TEXT      = "#000000";
  var DEFAULT_FONT_SIZE = "Medium";

  /* ---- Marker element builder ---- */

  function _buildMarkerEl(feature) {
    var p = feature.properties;

    var outer = document.createElement("div");
    outer.className = "map-textbox";
    outer.style.width  = (p.width  || 200) + "px";
    outer.style.height = (p.height || 100) + "px";
    outer.style.background = p.bgColor   || DEFAULT_BG;
    outer.style.color      = p.textColor || DEFAULT_TEXT;

    var handle = document.createElement("div");
    handle.className = "map-textbox-handle";

    var ta = document.createElement("textarea");
    ta.className = "map-textbox-content";
    ta.value = p.text || "";
    ta.style.fontSize = (FONT_SIZES[p.fontSize] || FONT_SIZES[DEFAULT_FONT_SIZE]) + "px";
    ta.style.color = p.textColor || DEFAULT_TEXT;

    // Prevent map pan/drag when interacting with the text box (including the resize handle)
    outer.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    outer.addEventListener("mousedown",   function (e) { e.stopPropagation(); });

    // Prevent map interactions while the user types or clicks inside the textarea
    ta.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    ta.addEventListener("mousedown",   function (e) { e.stopPropagation(); });
    ta.addEventListener("click",       function (e) { e.stopPropagation(); });

    ta.addEventListener("input", function () {
      feature.properties.text = ta.value;
      if (App.cache && typeof App.cache.save === "function") App.cache.save();
    });

    // Let Enter/Shift+Enter insert newlines; prevent app-level key handlers from firing
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.stopPropagation(); }
      if (e.key === "Escape") { ta.blur(); }
    });

    var resizeHandle = document.createElement("div");
    resizeHandle.className = "map-textbox-resize";

    outer.appendChild(handle);
    outer.appendChild(ta);
    outer.appendChild(resizeHandle);
    return outer;
  }

  /* ---- Context menu ---- */

  function _wireContextMenu(el, feature) {
    el.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var idx = textBoxes.indexOf(feature);
      if (idx < 0 || typeof App.showContextMenu !== "function") return;
      var isHidden = !!feature.properties.hidden;
      App.showContextMenu(e.clientX, e.clientY, [
        {
          label: "Attributes",
          action: function () { App.openAttrPopup("textbox", idx, feature); }
        },
        {
          label: "Duplicate",
          action: function () {
            if (App.undo && !App.undo.isRestoring()) App.undo.push();
            duplicateTextBox(idx);
          }
        },
        {
          label: isHidden ? "Show" : "Hide",
          action: function () {
            feature.properties.hidden = !feature.properties.hidden;
            renderTextBoxMarkers();
            if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
            if (App.cache && typeof App.cache.save === "function") App.cache.save();
          }
        },
        {
          label: "Delete",
          action: function () { removeTextBox(idx); }
        }
      ]);
    });
  }

  /* ---- Custom drag via the handle bar ---- */

  function _wireDrag(marker, feature) {
    var el = marker.getElement();
    var handle = el && el.querySelector(".map-textbox-handle");
    if (!handle) return;

    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      var startX    = e.clientX;
      var startY    = e.clientY;
      var startPoint = App.map.project(marker.getLngLat());

      function onMove(me) {
        var dx = me.clientX - startX;
        var dy = me.clientY - startY;
        marker.setLngLat(App.map.unproject([startPoint.x + dx, startPoint.y + dy]));
      }

      function onUp(me) {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup",   onUp);
        var dx = me.clientX - startX;
        var dy = me.clientY - startY;
        var ll = App.map.unproject([startPoint.x + dx, startPoint.y + dy]);
        marker.setLngLat(ll);
        feature.geometry.coordinates = [ll.lng, ll.lat];
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
      }

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup",   onUp);
    });
  }

  /* ---- Custom resize via the bottom-right handle ---- */

  function _wireResize(outer, feature) {
    var rh = outer.querySelector(".map-textbox-resize");
    if (!rh) return;

    rh.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      var startX = e.clientX;
      var startY = e.clientY;
      var startW = outer.offsetWidth;
      var startH = outer.offsetHeight;

      function onMove(me) {
        outer.style.width  = Math.max(60, startW + (me.clientX - startX)) + "px";
        outer.style.height = Math.max(40, startH + (me.clientY - startY)) + "px";
      }

      function onUp() {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup",   onUp);
        feature.properties.width  = outer.offsetWidth;
        feature.properties.height = outer.offsetHeight;
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
      }

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup",   onUp);
    });
  }

  /* ---- Marker creation ---- */

  function _createMarker(feature) {
    var el = _buildMarkerEl(feature);
    _wireContextMenu(el, feature);

    var marker = new maplibregl.Marker({ element: el, draggable: false, anchor: "top-left" })
      .setLngLat(feature.geometry.coordinates)
      .addTo(App.map);

    _wireDrag(marker, feature);
    _wireResize(el, feature);
    return marker;
  }

  /* ---- Public API ---- */

  function addTextBox(lon, lat, width, height) {
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    _tbCounter++;
    var feature = {
      type: "Feature",
      properties: {
        name:       "Text Box " + _tbCounter,
        textBoxIdx: _tbCounter,
        text:       "",
        width:      width  || 200,
        height:     height || 100,
        fontSize:   DEFAULT_FONT_SIZE,
        bgColor:    DEFAULT_BG,
        textColor:  DEFAULT_TEXT,
        color:      DEFAULT_BG,
        hidden:     false,
        attributes: {
          fontSize:  DEFAULT_FONT_SIZE,
          bgColor:   DEFAULT_BG,
          textColor: DEFAULT_TEXT
        }
      },
      geometry: { type: "Point", coordinates: [lon, lat] }
    };
    textBoxes.push(feature);
    _markers.push(_createMarker(feature));
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function removeTextBox(index) {
    if (index < 0 || index >= textBoxes.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    if (_markers[index]) _markers[index].remove();
    textBoxes.splice(index, 1);
    _markers.splice(index, 1);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  function clearTextBoxes() {
    for (var i = 0; i < _markers.length; i++) {
      if (_markers[i]) _markers[i].remove();
    }
    textBoxes.length = 0;
    _markers.length  = 0;
    _tbCounter = 0;
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function undoLastTextBox() {
    if (textBoxes.length === 0) return;
    var last = _markers.pop();
    if (last) last.remove();
    textBoxes.pop();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function duplicateTextBox(index) {
    if (index < 0 || index >= textBoxes.length) return;
    var src = textBoxes[index];
    _tbCounter++;
    var feature = {
      type: "Feature",
      properties: {
        name:       "Text Box " + _tbCounter,
        textBoxIdx: _tbCounter,
        text:       src.properties.text,
        width:      src.properties.width,
        height:     src.properties.height,
        fontSize:   src.properties.fontSize,
        bgColor:    src.properties.bgColor,
        textColor:  src.properties.textColor,
        color:      src.properties.color,
        hidden:     false,
        attributes: {
          fontSize:  src.properties.fontSize,
          bgColor:   src.properties.bgColor,
          textColor: src.properties.textColor
        }
      },
      geometry: {
        type: "Point",
        coordinates: [src.geometry.coordinates[0] + 0.002, src.geometry.coordinates[1]]
      }
    };
    textBoxes.push(feature);
    _markers.push(_createMarker(feature));
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  function renderTextBoxMarkers() {
    for (var i = 0; i < _markers.length; i++) {
      if (_markers[i]) _markers[i].remove();
    }
    _markers.length = 0;

    if (textBoxes.length > 0) {
      var maxIdx = 0;
      for (var j = 0; j < textBoxes.length; j++) {
        if ((textBoxes[j].properties.textBoxIdx || 0) > maxIdx) {
          maxIdx = textBoxes[j].properties.textBoxIdx;
        }
      }
      _tbCounter = maxIdx;
    }

    for (var k = 0; k < textBoxes.length; k++) {
      var marker;
      if (textBoxes[k].properties.hidden) {
        var el = _buildMarkerEl(textBoxes[k]);
        _wireContextMenu(el, textBoxes[k]);
        marker = new maplibregl.Marker({ element: el, draggable: false, anchor: "top-left" })
          .setLngLat(textBoxes[k].geometry.coordinates);
        _wireDrag(marker, textBoxes[k]);
        _wireResize(el, textBoxes[k]);
      } else {
        marker = _createMarker(textBoxes[k]);
      }
      _markers.push(marker);
    }

    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function updateTextBoxAppearance(index) {
    if (index < 0 || index >= textBoxes.length) return;
    var p  = textBoxes[index].properties;
    var m  = _markers[index];
    if (!m) return;
    var outer = m.getElement();
    if (!outer) return;
    var ta = outer.querySelector(".map-textbox-content");

    outer.style.background = p.bgColor   || DEFAULT_BG;
    outer.style.color      = p.textColor || DEFAULT_TEXT;
    if (ta) {
      ta.style.fontSize = (FONT_SIZES[p.fontSize] || FONT_SIZES[DEFAULT_FONT_SIZE]) + "px";
      ta.style.color    = p.textColor || DEFAULT_TEXT;
    }
    p.color = p.bgColor || DEFAULT_BG;
  }

  /* ---- Draw-to-create (mousedown → drag → release) ---- */

  function _initDrawMode() {
    App.map.on("mousedown", function (e) {
      if (App.drawMode !== "textbox") return;

      if (e.originalEvent) e.originalEvent.preventDefault();
      App.map.dragPan.disable();

      var mapRect    = App.map.getContainer().getBoundingClientRect();
      var startMapX  = e.point.x;
      var startMapY  = e.point.y;
      var screenX0   = mapRect.left + startMapX;
      var screenY0   = mapRect.top  + startMapY;

      var preview = document.createElement("div");
      preview.className = "map-textbox-preview";
      preview.style.cssText =
        "left:" + screenX0 + "px;top:" + screenY0 + "px;width:0;height:0;";
      document.body.appendChild(preview);

      function onMove(me) {
        var dx = me.clientX - screenX0;
        var dy = me.clientY - screenY0;
        preview.style.left   = Math.min(screenX0, me.clientX) + "px";
        preview.style.top    = Math.min(screenY0, me.clientY) + "px";
        preview.style.width  = Math.abs(dx) + "px";
        preview.style.height = Math.abs(dy) + "px";
      }

      function onUp(me) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        preview.remove();
        App.map.dragPan.enable();

        var dx = me.clientX - screenX0;
        var dy = me.clientY - screenY0;
        var w  = Math.max(60, Math.abs(dx));
        var h  = Math.max(40, Math.abs(dy));

        // Anchor point = top-left corner of the drag rectangle
        var anchorMapX  = dx >= 0 ? startMapX : startMapX + dx;
        var anchorMapY  = dy >= 0 ? startMapY : startMapY + dy;
        var ll = App.map.unproject([anchorMapX, anchorMapY]);

        addTextBox(ll.lng, ll.lat, w, h);

        App.drawMode = null;
        var btn = document.querySelector('[data-mode="textbox"]');
        if (btn) btn.classList.remove("active");

        if (typeof App.notifyProject === "function") App.notifyProject();
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  }

  // map.js runs before this module, so App.map is guaranteed available
  _initDrawMode();

  /* ---- Exports ---- */
  App.textBoxes               = textBoxes;
  App.addTextBox              = addTextBox;
  App.removeTextBox           = removeTextBox;
  App.clearTextBoxes          = clearTextBoxes;
  App.undoLastTextBox         = undoLastTextBox;
  App.duplicateTextBox        = duplicateTextBox;
  App.renderTextBoxMarkers    = renderTextBoxMarkers;
  App.updateTextBoxAppearance = updateTextBoxAppearance;

}());
