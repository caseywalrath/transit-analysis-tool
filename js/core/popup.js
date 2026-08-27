// js/core/popup.js
// Generic analysis popup manager: opens module popups, floating map widgets.
// Depends on: App namespace (utils.js).
// Exports: App.popup.open, close, isOpen, currentModuleId,
//          App.popup.showFloatingWidget, App.popup.hideFloatingWidget

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Internal state ----

  var _currentModuleId = null;    // id of the module whose popup is open (or null)
  var _loadedModules = {};        // { moduleId: slotDOMNode } — per-module persistent body slot
  var _container = null;          // cached #module-popup element
  var _floatingWidgets = {};      // { widgetId: DOM element }
  var _widgetPositions = {};      // { widgetId: {top, left} } — remembered drag position, survives remove+recreate

  // ---- Drag state ----
  var _dragging = false;
  var _dragStartX = 0;
  var _dragStartY = 0;
  var _offsetX = 0;
  var _offsetY = 0;
  var _layoutMode = null;

  // Keep a usable portion of the title bar in view after a drag. The top edge
  // is stricter: it never moves above the browser viewport.
  var _minVisibleHeaderWidth = 120;
  var _minVisibleHeaderHeight = 32;

  function getContainer() {
    if (!_container) _container = document.getElementById("module-popup");
    return _container;
  }

  function applyPanelWidth(mod, mode, preservePosition) {
    var el = getContainer();
    if (!el || !mod) return;
    var dialog = el.querySelector(".module-popup-dialog");
    if (!dialog) return;

    var widths = mod.panelWidths || {};
    var width = widths[mode] || widths.setup || mod.popupWidth;
    dialog.style.width = width ? width + "px" : "";
    dialog.classList.toggle("module-popup-narrow", !!width && width <= 620);
    _layoutMode = mode;

    // Normal opens and explicit layout changes re-dock the panel. Input
    // expand/collapse passes preservePosition so editing does not interrupt a
    // user's chosen floating location, even when the width changes.
    if (!preservePosition) {
      _offsetX = 0;
      _offsetY = 0;
      dialog.style.transform = "";
    }
  }

  function applyDragOffset(dialog, nextX, nextY) {
    if (!dialog) return;
    var dialogRect = dialog.getBoundingClientRect();
    if (!dialogRect.width) return;

    // The rectangle reflects the *previous* offset. Remove that offset before
    // applying the proposed new one, so fast pointer movement cannot corrupt
    // the docked position used by the constraint.
    var baseTop = dialogRect.top - _offsetY;
    _offsetX = nextX;
    _offsetY = Math.max(-baseTop, nextY);
    dialog.style.transform = "translate(" + _offsetX + "px, " + _offsetY + "px)";
  }

  function restoreReachableHeader(dialog, header) {
    if (!dialog || !header) return;
    var dialogRect = dialog.getBoundingClientRect();
    var headerRect = header.getBoundingClientRect();
    if (!dialogRect.width || !headerRect.height) return;

    var nextX = _offsetX;
    var nextY = _offsetY;
    var visibleWidth = Math.min(_minVisibleHeaderWidth, dialogRect.width, window.innerWidth / 2);
    var visibleHeight = Math.min(_minVisibleHeaderHeight, headerRect.height, window.innerHeight / 2);

    if (dialogRect.right < visibleWidth) nextX += visibleWidth - dialogRect.right;
    else if (dialogRect.left > window.innerWidth - visibleWidth) nextX -= dialogRect.left - (window.innerWidth - visibleWidth);

    // The title bar may not leave through the bottom edge. Its top edge is
    // separately constrained while dragging, so no correction is needed above.
    if (headerRect.top > window.innerHeight - visibleHeight) {
      nextY -= headerRect.top - (window.innerHeight - visibleHeight);
    }
    applyDragOffset(dialog, nextX, nextY);
  }

  // ---- Popup lifecycle ----

  /**
   * Open a module popup.
   * @param {string} moduleId — must match a registered module's id
   * @param {Map} modules — the _modules Map from app.js
   * @param {function} buildCore — function that returns the core API object
   */
  async function open(moduleId, modules, buildCore) {
    var mod = modules.get(moduleId);
    if (!mod) { console.warn("popup.open: unknown module", moduleId); return; }
    if (!mod.popupHTML) { console.warn("popup.open: module has no popupHTML", moduleId); return; }

    var el = getContainer();
    if (!el) return;

    var dialog = el.querySelector(".module-popup-dialog");
    var titleEl = el.querySelector(".module-popup-title");
    var bodyEl = el.querySelector(".module-popup-body");
    if (!dialog || !bodyEl) return;

    // A freshly opened panel always starts expanded.
    setCollapsed(false);

    // If a different module was open, close it first
    if (_currentModuleId && _currentModuleId !== moduleId) {
      _close(modules, buildCore);
    }

    // Set title and initial setup width.
    if (titleEl) titleEl.textContent = mod.name || moduleId;
    applyPanelWidth(mod, "setup");

    // Hide all existing module slot divs (show only the active module's slot)
    var allSlots = bodyEl.querySelectorAll(".module-body-slot");
    for (var i = 0; i < allSlots.length; i++) allSlots[i].style.display = "none";

    // First open: create a dedicated slot div, fetch HTML, run init
    if (!_loadedModules[moduleId]) {
      var slotEl = document.createElement("div");
      slotEl.className = "module-body-slot";
      bodyEl.appendChild(slotEl);
      try {
        var resp = await fetch(mod.popupHTML);
        if (resp.ok) {
          slotEl.innerHTML = await resp.text();
        }
      } catch (e) {
        console.warn("popup.open: could not load HTML for", moduleId, e);
      }
      _loadedModules[moduleId] = slotEl;
      if (typeof mod.init === "function") {
        mod.init(buildCore());
      }
    }

    // Show this module's slot
    _loadedModules[moduleId].style.display = "";

    _currentModuleId = moduleId;
    el.style.display = "flex";

    // Call onOpen hook (every time popup opens)
    if (typeof mod.onOpen === "function") {
      mod.onOpen(buildCore());
    }
  }

  /**
   * Close the currently open popup.
   */
  function _close(modules, buildCore) {
    var el = getContainer();
    if (!el) return;
    el.style.display = "none";

    if (_currentModuleId && modules) {
      var mod = modules.get(_currentModuleId);
      if (mod && typeof mod.onClose === "function") {
        mod.onClose(buildCore());
      }
    }
    _currentModuleId = null;
    _layoutMode = null;
  }

  // Public close — takes no args, uses stored references (set at wiring time)
  var _modulesRef = null;
  var _buildCoreRef = null;

  function close() {
    _close(_modulesRef, _buildCoreRef);
  }

  function isOpen() {
    return _currentModuleId !== null;
  }

  function currentModuleId() {
    return _currentModuleId;
  }

  /**
   * Switch the active module between setup, results, and specialized workspace
   * widths. Modules call this after a successful run or tab transition.
   */
  function setLayoutMode(mode, preservePosition) {
    if (!_currentModuleId || !_modulesRef) return;
    var mod = _modulesRef.get(_currentModuleId);
    if (!mod) return;
    applyPanelWidth(mod, mode || "setup", preservePosition === true);
  }

  function layoutMode() {
    return _layoutMode;
  }

  // ---- Floating widgets ----

  /**
   * Make a floating widget's header a drag handle, repositioning the widget
   * (top/left, absolute within #map) as the pointer moves. Clamped to stay
   * fully inside the map viewport. The final position is remembered by
   * widgetId so a later removeFloatingWidget + showFloatingWidget (e.g. a
   * module's Clear then re-run) restores where the user left it.
   */
  function _makeWidgetDraggable(widget, header, widgetId) {
    var drag = null;

    header.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest(".floating-widget-close")) return;
      var mapEl = document.getElementById("map");
      if (!mapEl) return;
      var mapRect = mapEl.getBoundingClientRect();
      var widgetRect = widget.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: widgetRect.left - mapRect.left,
        startTop: widgetRect.top - mapRect.top
      };
      header.setPointerCapture(e.pointerId);
      header.classList.add("dragging");
    });

    header.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var mapEl = document.getElementById("map");
      if (!mapEl) return;
      var mapRect = mapEl.getBoundingClientRect();
      var maxLeft = Math.max(0, mapRect.width - widget.offsetWidth);
      var maxTop = Math.max(0, mapRect.height - widget.offsetHeight);
      var nl = Math.max(0, Math.min(maxLeft, drag.startLeft + (e.clientX - drag.startX)));
      var nt = Math.max(0, Math.min(maxTop, drag.startTop + (e.clientY - drag.startY)));
      widget.style.left = nl + "px";
      widget.style.top = nt + "px";
      widget.style.right = "auto";
      widget.style.bottom = "auto";
    });

    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.pointerId)) return;
      header.classList.remove("dragging");
      _widgetPositions[widgetId] = { top: widget.style.top, left: widget.style.left };
      drag = null;
    }
    header.addEventListener("pointerup", endDrag);
    header.addEventListener("pointercancel", endDrag);
  }

  /**
   * Show a floating widget over the map.
   * @param {string} widgetId — unique ID for this widget
   * @param {string} htmlFile — path to HTML fragment (fetched on first show)
   * @param {object} options — { position: "bottom-left", width: 160, title: "..." }
   */
  async function showFloatingWidget(widgetId, htmlFile, options) {
    options = options || {};

    // If already exists, just make it visible
    if (_floatingWidgets[widgetId]) {
      _floatingWidgets[widgetId].style.display = "";
      return;
    }

    // Create widget DOM
    var widget = document.createElement("div");
    widget.className = "floating-widget";
    widget.setAttribute("data-widget-id", widgetId);

    // Position — restore a remembered drag position for this widget id,
    // else fall back to the requested anchor corner.
    var saved = _widgetPositions[widgetId];
    if (saved) {
      widget.style.top = saved.top;
      widget.style.left = saved.left;
    } else {
      var pos = options.position || "bottom-left";
      if (pos === "bottom-left") {
        widget.style.bottom = "36px";
        widget.style.left = "10px";
      } else if (pos === "bottom-right") {
        widget.style.bottom = "36px";
        widget.style.right = "10px";
      } else if (pos === "top-left") {
        widget.style.top = "10px";
        widget.style.left = "10px";
      } else if (pos === "top-right") {
        widget.style.top = "10px";
        widget.style.right = "10px";
      }
    }

    if (options.width) widget.style.width = options.width + "px";

    // Build header + body
    var headerHTML = options.title
      ? '<div class="floating-widget-header">' +
          '<span class="floating-widget-title">' + options.title + '</span>' +
          '<button class="floating-widget-close" aria-label="Close">&times;</button>' +
        '</div>'
      : '';
    widget.innerHTML = headerHTML + '<div class="floating-widget-body"></div>';

    // Load content
    if (htmlFile) {
      try {
        var resp = await fetch(htmlFile);
        if (resp.ok) {
          widget.querySelector(".floating-widget-body").innerHTML = await resp.text();
        }
      } catch (e) {
        console.warn("floating widget load error:", e);
      }
    }

    // Close button
    var closeBtn = widget.querySelector(".floating-widget-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        widget.style.display = "none";
      });
    }

    // Drag-to-reposition by the header, if one was built (requires a title)
    var header = widget.querySelector(".floating-widget-header");
    if (header) {
      _makeWidgetDraggable(widget, header, widgetId);
    }

    // Append to map container (positioned absolutely within it)
    var mapEl = document.getElementById("map");
    if (mapEl) {
      mapEl.appendChild(widget);
    }
    _floatingWidgets[widgetId] = widget;
  }

  function hideFloatingWidget(widgetId) {
    var w = _floatingWidgets[widgetId];
    if (w) w.style.display = "none";
  }

  function removeFloatingWidget(widgetId) {
    var w = _floatingWidgets[widgetId];
    if (w && w.parentNode) w.parentNode.removeChild(w);
    delete _floatingWidgets[widgetId];
  }

  // ---- Popup drag support ----

  function setCollapsed(collapsed) {
    var el = getContainer();
    if (!el) return;
    var dialog = el.querySelector(".module-popup-dialog");
    var closeBtn = el.querySelector(".module-popup-close");
    // The popup container vertically centers the dialog. Anchor the compact
    // bar on the close button: collapse can shrink leftward, while the close
    // button and adjacent caret remain exactly where they were.
    var wasVisible = el.style.display !== "none" && dialog;
    var previousCloseRect = wasVisible && closeBtn ? closeBtn.getBoundingClientRect() : null;
    el.classList.toggle("module-popup-collapsed", collapsed);
    if (previousCloseRect && previousCloseRect.width) {
      var nextCloseRect = closeBtn.getBoundingClientRect();
      _offsetX += previousCloseRect.left - nextCloseRect.left;
      _offsetY += previousCloseRect.top - nextCloseRect.top;
      dialog.style.transform = "translate(" + _offsetX + "px, " + _offsetY + "px)";
    }
    var btn = el.querySelector(".module-popup-collapse");
    if (!btn) return;
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
    btn.title = collapsed ? "Expand" : "Collapse";
  }

  function initDrag() {
    var el = getContainer();
    if (!el) return;

    var header = el.querySelector(".module-popup-header");
    var dialog = el.querySelector(".module-popup-dialog");
    if (!header || !dialog) return;

    header.addEventListener("mousedown", function (e) {
      if (e.target.closest(".module-popup-close, .module-popup-collapse")) return;

      e.preventDefault();
      _dragging = true;
      _dragStartX = e.clientX - _offsetX;
      _dragStartY = e.clientY - _offsetY;

      header.classList.add("dragging");
      dialog.classList.add("dragging");
    });

    document.addEventListener("mousemove", function (e) {
      if (!_dragging) return;
      e.preventDefault();

      applyDragOffset(dialog, e.clientX - _dragStartX, e.clientY - _dragStartY);
    });

    document.addEventListener("mouseup", function () {
      if (!_dragging) return;
      _dragging = false;

      restoreReachableHeader(dialog, header);

      header.classList.remove("dragging");
      dialog.classList.remove("dragging");
    });
  }

  // ---- Wiring (called once from app.js on map load) ----

  function wire(modules, buildCore) {
    _modulesRef = modules;
    _buildCoreRef = buildCore;

    var el = getContainer();
    if (!el) return;

    // Close button
    var closeBtn = el.querySelector(".module-popup-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", close);
    }

    var collapseBtn = el.querySelector(".module-popup-collapse");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", function () {
        setCollapsed(!el.classList.contains("module-popup-collapsed"));
      });
    }

    // Initialize popup dragging
    initDrag();
  }

  // ---- Public API ----

  App.popup = {
    open: open,
    close: close,
    isOpen: isOpen,
    currentModuleId: currentModuleId,
    setLayoutMode: setLayoutMode,
    layoutMode: layoutMode,
    showFloatingWidget: showFloatingWidget,
    hideFloatingWidget: hideFloatingWidget,
    removeFloatingWidget: removeFloatingWidget,
    wire: wire
  };

})();
