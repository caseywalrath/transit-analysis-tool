// js/core/labels.js
// Map label management: text labels rendered as MapLibre Markers with custom HTML.
// Depends on: App.map (map.js), maplibregl (CDN).
// Exports: see the Exports block at the end of the file.

(function () {
  var App = window.App = window.App || {};

  var labels = [];
  var _markers = [];   // parallel array of maplibregl.Marker instances
  var _labelCounter = 0;

  var FONT_SIZES = { Small: 12, Medium: 16, Large: 22, XL: 30 };
  var DEFAULT_BG    = "#1a202c";
  var DEFAULT_TEXT_COLOR = "#ffffff";
  var DEFAULT_FONT_SIZE  = "Medium";

  /* ---- Marker element builder ---- */

  function _buildMarkerEl(feature) {
    var p = feature.properties;
    var div = document.createElement("div");
    div.className = "map-label";
    div.textContent = p.name || "";
    div.style.background = p.bgColor || DEFAULT_BG;
    div.style.color = p.textColor || DEFAULT_TEXT_COLOR;
    div.style.fontSize = (FONT_SIZES[p.fontSize] || FONT_SIZES[DEFAULT_FONT_SIZE]) + "px";
    return div;
  }

  function _wireContextMenu(el, feature) {
    el.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var idx = App.labels.indexOf(feature);
      if (idx < 0 || typeof App.showContextMenu !== "function") return;
      var isHidden = !!feature.properties.hidden;
      App.showContextMenu(e.clientX, e.clientY, [
        {
          label: "Attributes",
          action: function () { App.openAttrPopup("label", idx, feature); }
        },
        {
          label: "Duplicate",
          action: function () {
            if (App.undo && !App.undo.isRestoring()) App.undo.push();
            App.duplicateLabel(idx);
          }
        },
        {
          label: isHidden ? "Show" : "Hide",
          action: function () {
            feature.properties.hidden = !feature.properties.hidden;
            App.renderLabelMarkers();
            if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
            if (App.cache && typeof App.cache.save === "function") App.cache.save();
          }
        },
        {
          label: "Delete",
          action: function () { App.removeLabel(idx); }
        }
      ]);
    });
  }

  function _createMarker(feature, index) {
    var el = _buildMarkerEl(feature);
    _wireContextMenu(el, feature);
    var coords = feature.geometry.coordinates;
    var marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(coords)
      .addTo(App.map);

    marker.on("dragend", function () {
      if (App.undo && !App.undo.isRestoring()) App.undo.push();
      var lngLat = marker.getLngLat();
      feature.geometry.coordinates = [lngLat.lng, lngLat.lat];
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
      if (App.cache && typeof App.cache.save === "function") App.cache.save();
    });

    return marker;
  }

  /* ---- Public API ---- */

  function addLabel(lon, lat) {
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    _labelCounter++;
    var feature = {
      type: "Feature",
      properties: {
        name: "Label " + _labelCounter,
        labelIdx: _labelCounter,
        fontSize: DEFAULT_FONT_SIZE,
        bgColor: DEFAULT_BG,
        textColor: DEFAULT_TEXT_COLOR,
        color: DEFAULT_BG,
        hidden: false,
        attributes: {
          fontSize: DEFAULT_FONT_SIZE,
          bgColor: DEFAULT_BG,
          textColor: DEFAULT_TEXT_COLOR
        }
      },
      geometry: { type: "Point", coordinates: [lon, lat] }
    };
    labels.push(feature);
    var marker = _createMarker(feature, labels.length - 1);
    _markers.push(marker);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (typeof App.openAttrPopup === "function") App.openAttrPopup("label", labels.length - 1, feature);
  }

  function removeLabel(index) {
    if (index < 0 || index >= labels.length) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    if (_markers[index]) _markers[index].remove();
    labels.splice(index, 1);
    _markers.splice(index, 1);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function clearLabels() {
    for (var i = 0; i < _markers.length; i++) {
      if (_markers[i]) _markers[i].remove();
    }
    labels.length = 0;
    _markers.length = 0;
    _labelCounter = 0;
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function undoLastLabel() {
    if (labels.length === 0) return;
    var last = _markers.pop();
    if (last) last.remove();
    labels.pop();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function moveLabel(index, lng, lat) {
    if (index < 0 || index >= labels.length) return;
    labels[index].geometry.coordinates = [lng, lat];
    if (_markers[index]) _markers[index].setLngLat([lng, lat]);
  }

  function duplicateLabel(index) {
    if (index < 0 || index >= labels.length) return;
    var src = labels[index];
    _labelCounter++;
    var feature = {
      type: "Feature",
      properties: {
        name: "Label " + _labelCounter,
        labelIdx: _labelCounter,
        fontSize: src.properties.fontSize,
        bgColor: src.properties.bgColor,
        textColor: src.properties.textColor,
        color: src.properties.color,
        hidden: false,
        attributes: {
          fontSize: src.properties.fontSize,
          bgColor: src.properties.bgColor,
          textColor: src.properties.textColor
        }
      },
      geometry: {
        type: "Point",
        coordinates: [
          src.geometry.coordinates[0] + 0.002,
          src.geometry.coordinates[1]
        ]
      }
    };
    // Copy label group if set
    if (src.properties.attributes && src.properties.attributes.labelGroup) {
      feature.properties.attributes.labelGroup = src.properties.attributes.labelGroup;
    }
    labels.push(feature);
    var marker = _createMarker(feature, labels.length - 1);
    _markers.push(marker);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  function renderLabelMarkers() {
    // Remove all existing markers
    for (var i = 0; i < _markers.length; i++) {
      if (_markers[i]) _markers[i].remove();
    }
    _markers.length = 0;

    // Rebuild counter from existing labels
    if (labels.length > 0) {
      var maxIdx = 0;
      for (var j = 0; j < labels.length; j++) {
        if (labels[j].properties.labelIdx > maxIdx) {
          maxIdx = labels[j].properties.labelIdx;
        }
      }
      _labelCounter = maxIdx;
    }

    // Create markers for all non-hidden labels
    for (var k = 0; k < labels.length; k++) {
      var marker;
      if (labels[k].properties.hidden) {
        // Create marker but don't add to map
        var el = _buildMarkerEl(labels[k]);
        _wireContextMenu(el, labels[k]);
        marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(labels[k].geometry.coordinates);
        // Wire dragend even for hidden markers (in case they become visible later)
        (function (feat) {
          marker.on("dragend", function () {
            var lngLat = marker.getLngLat();
            feat.geometry.coordinates = [lngLat.lng, lngLat.lat];
            if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
            if (App.cache && typeof App.cache.save === "function") App.cache.save();
          });
        })(labels[k]);
      } else {
        marker = _createMarker(labels[k], k);
      }
      _markers.push(marker);
    }

    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  function updateLabelAppearance(index) {
    if (index < 0 || index >= labels.length) return;
    var p = labels[index].properties;
    var marker = _markers[index];
    if (!marker) return;

    var el = marker.getElement();
    if (!el) return;
    var labelEl = el.querySelector(".map-label") || el;
    labelEl.textContent = p.name || "";
    labelEl.style.background = p.bgColor || DEFAULT_BG;
    labelEl.style.color = p.textColor || DEFAULT_TEXT_COLOR;
    labelEl.style.fontSize = (FONT_SIZES[p.fontSize] || FONT_SIZES[DEFAULT_FONT_SIZE]) + "px";

    // Sync feature.properties.color with bgColor for swatch display
    p.color = p.bgColor || DEFAULT_BG;
  }

  /* ---- Exports ---- */

  App.labels = labels;
  App.addLabel = addLabel;
  App.removeLabel = removeLabel;
  App.clearLabels = clearLabels;
  App.undoLastLabel = undoLastLabel;
  App.moveLabel = moveLabel;
  App.duplicateLabel = duplicateLabel;
  App.renderLabelMarkers = renderLabelMarkers;
  App.updateLabelAppearance = updateLabelAppearance;

})();
