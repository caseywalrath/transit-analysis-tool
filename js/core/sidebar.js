// js/core/sidebar.js
// Dormant legacy sidebar manager (hidden, unused): registration, collapse/expand, render.
// Depends on: utils.js (App namespace must exist).
// Exports: App.sidebar

(function () {
  var App = window.App = window.App || {};

  // ---- Internal state ----

  var _panels = [];          // Array of { id, title, html, collapsed, order }
  var _container = null;     // #sidebar DOM element (resolved lazily)

  function getContainer() {
    if (!_container) {
      _container = document.getElementById("sidebar");
    }
    return _container;
  }

  // ---- Panel API ----

  /**
   * Register a panel.
   * @param {Object} config
   * @param {string} config.id        Unique panel identifier
   * @param {string} config.title     Display title for the panel header
   * @param {string} config.html      Inner HTML for the panel body
   * @param {boolean} [config.collapsed=false]  Start collapsed?
   * @param {number}  [config.order=100]        Sort order (lower = higher)
   */
  function addPanel(config) {
    if (!config || !config.id) return;

    // Replace if panel with same id already exists
    var idx = _indexById(config.id);
    var panel = {
      id: config.id,
      title: config.title || config.id,
      html: config.html || "",
      collapsed: !!config.collapsed,
      order: (config.order != null) ? config.order : 100
    };

    if (idx >= 0) {
      _panels[idx] = panel;
    } else {
      _panels.push(panel);
    }

    _panels.sort(function (a, b) { return a.order - b.order; });
    // Caller should call render() explicitly after registering panels
    // to avoid destroying event listeners on already-rendered panels.
  }

  /**
   * Remove a panel by id.
   */
  function removePanel(id) {
    var idx = _indexById(id);
    if (idx >= 0) {
      _panels.splice(idx, 1);
      // Remove just this panel's DOM node (preserves other panels' event listeners)
      var container = getContainer();
      if (container) {
        var node = container.querySelector('[data-panel-id="' + id + '"]');
        if (node) node.remove();
      }
    }
  }

  /**
   * Toggle a panel's collapsed state.
   */
  function toggle(id) {
    var idx = _indexById(id);
    if (idx >= 0) {
      _panels[idx].collapsed = !_panels[idx].collapsed;
      _applyCollapsed(id, _panels[idx].collapsed);
    }
  }

  /**
   * Rebuild the entire sidebar DOM from the registered panels array.
   */
  function render() {
    var container = getContainer();
    if (!container) return;

    container.innerHTML = "";

    if (_panels.length === 0) {
      container.innerHTML = '<div class="sb2-empty">No panels registered.</div>';
      return;
    }

    for (var i = 0; i < _panels.length; i++) {
      var p = _panels[i];
      container.appendChild(_buildPanelDOM(p));
    }
  }

  // ---- Internal helpers ----

  function _indexById(id) {
    for (var i = 0; i < _panels.length; i++) {
      if (_panels[i].id === id) return i;
    }
    return -1;
  }

  function _buildPanelDOM(panel) {
    var div = document.createElement("div");
    div.className = "sb2-panel" + (panel.collapsed ? " sb2-collapsed" : "");
    div.setAttribute("data-panel-id", panel.id);

    // Header
    var header = document.createElement("div");
    header.className = "sb2-panel-header";

    var title = document.createElement("span");
    title.className = "sb2-panel-title";
    title.textContent = panel.title;

    var toggleBtn = document.createElement("button");
    toggleBtn.className = "sb2-panel-toggle";
    toggleBtn.setAttribute("aria-expanded", panel.collapsed ? "false" : "true");
    toggleBtn.innerHTML = "&#9662;"; // ▾

    header.appendChild(title);
    header.appendChild(toggleBtn);

    // Click header to toggle
    header.addEventListener("click", function () {
      toggle(panel.id);
    });

    // Body
    var body = document.createElement("div");
    body.className = "sb2-panel-body";
    body.innerHTML = panel.html;

    div.appendChild(header);
    div.appendChild(body);

    return div;
  }

  function _applyCollapsed(id, collapsed) {
    var container = getContainer();
    if (!container) return;
    var el = container.querySelector('[data-panel-id="' + id + '"]');
    if (!el) return;

    if (collapsed) {
      el.classList.add("sb2-collapsed");
    } else {
      el.classList.remove("sb2-collapsed");
    }

    var btn = el.querySelector(".sb2-panel-toggle");
    if (btn) btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  // ---- Wire sidebar collapse toggle ----

  (function () {
    var btn = document.getElementById('sb-collapse-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var wrap = document.getElementById('sidebar-wrap');
      var collapsed = wrap.classList.toggle('sb-collapsed');
      btn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
      btn.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
    });
  })();

  // ---- Expose on App namespace ----

  App.sidebar = {
    addPanel: addPanel,
    removePanel: removePanel,
    toggle: toggle,
    render: render
  };
})();
