// js/core/analysis-checklist.js
// Shared helpers for analysis-module feature checklists that must cope with
// features hidden on the map (docs/hidden-features-analysis-plan.md).
// Depends on: App namespace only. DOM is touched only inside the functions.
// Load right after module-buffers.js.

(function () {
  var App = window.App = window.App || {};

  var HIDDEN_TIP = "Hidden on the map — show it in the Layers tab, or turn on Include hidden.";

  // Apply or remove the hidden-feature styling on one checklist row.
  // Hidden + includeHidden off: checkbox disabled, row muted, tag + tooltip.
  // Hidden + includeHidden on: checkbox enabled, tag kept, no tooltip/mute.
  // Never touches checkboxEl.checked — the saved selection is left alone.
  function decorateHiddenRow(rowEl, checkboxEl, feature, includeHidden) {
    var isHidden = !!(feature && feature.properties && feature.properties.hidden);
    var disable = isHidden && !includeHidden;
    if (checkboxEl) checkboxEl.disabled = disable;
    if (!rowEl) return;
    rowEl.classList.toggle("ac-hidden", disable);
    var tag = rowEl.querySelector(".ac-hidden-tag");
    if (isHidden) {
      if (!tag) {
        tag = document.createElement("span");
        tag.className = "ac-hidden-tag";
        tag.textContent = "hidden";
        rowEl.appendChild(tag);
      }
    } else if (tag) {
      tag.remove();
    }
    if (disable) rowEl.title = HIDDEN_TIP;
    else rowEl.removeAttribute("title");
  }

  // Small inline "Include hidden" checkbox + label, meant to follow the
  // `Select all | Clear` links. opts = { id, checked, onChange(bool) }.
  function buildIncludeHiddenToggle(opts) {
    opts = opts || {};
    var label = document.createElement("label");
    label.className = "ac-include-hidden";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    if (opts.id) cb.id = opts.id;
    cb.checked = !!opts.checked;
    cb.addEventListener("change", function () {
      if (typeof opts.onChange === "function") opts.onChange(cb.checked);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" Include hidden"));
    return label;
  }

  // Standard wording. hiddenCount is a number or the builders' { included, skipped }.
  // Returns { error, notes }: error for "selection built nothing because everything
  // is hidden"; notes for the results line when hidden features were included.
  function hiddenSelectionMessage(hiddenCount) {
    var n = (hiddenCount && typeof hiddenCount === "object")
      ? (hiddenCount.included || 0) : (hiddenCount || 0);
    return {
      error: "Selected features are hidden — show them in the Layers tab, or turn on Include hidden.",
      notes: n > 0 ? "Includes " + n + " feature" + (n === 1 ? "" : "s") + " hidden on the map." : ""
    };
  }

  App.decorateHiddenRow = decorateHiddenRow;
  App.buildIncludeHiddenToggle = buildIncludeHiddenToggle;
  App.hiddenSelectionMessage = hiddenSelectionMessage;
})();
