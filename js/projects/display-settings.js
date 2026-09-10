(function () {
  var App = window.App = window.App || {};

  var SLIDERS = [
    { id: "ds-pointOpacity",      key: "pointOpacity",      def: 100, min: 0, max: 100, step: 1,   unit: "%",  onChange: function () { App.applyFeatureOpacity("point"); } },
    { id: "ds-lineOpacity",       key: "lineOpacity",       def: 100, min: 0, max: 100, step: 1,   unit: "%",  onChange: function () { App.applyFeatureOpacity("line"); } },
    { id: "ds-routeOpacity",      key: "routeOpacity",      def: 100, min: 0, max: 100, step: 1,   unit: "%",  onChange: function () { App.applyFeatureOpacity("route"); } },
    { id: "ds-polygonOpacity",    key: "polygonOpacity",    def: 50,  min: 0, max: 100, step: 1,   unit: "%",  onChange: function () { App.applyFeatureOpacity("polygon"); } },
    { id: "ds-bufferOpacity",     key: "bufferOpacity",     def: 50,  min: 0, max: 100, step: 1,   unit: "%",  onChange: function () { App.applyFeatureOpacity("buffer"); } },
    { id: "ds-pointLineWidth",    key: "pointLineWidth",    def: 1,   min: 0, max: 5, step: 0.1, unit: "×", onChange: function () { App.applyLineWidth("point"); } },
    { id: "ds-lineLineWidth",     key: "lineLineWidth",     def: 1,   min: 0, max: 5, step: 0.1, unit: "×", onChange: function () { App.applyLineWidth("line"); } },
    { id: "ds-routeLineWidth",    key: "routeLineWidth",    def: 1,   min: 0, max: 5, step: 0.1, unit: "×", onChange: function () { App.applyLineWidth("route"); } },
    { id: "ds-polygonLineWidth",  key: "polygonLineWidth",  def: 1,   min: 0, max: 5, step: 0.1, unit: "×", onChange: function () { App.applyLineWidth("polygon"); } },
    { id: "ds-bufferLineWidth",   key: "bufferLineWidth",   def: 1,   min: 0, max: 5, step: 0.1, unit: "×", onChange: function () { App.applyBufferLineWidth(); } }
  ];

  function valueToIdx(val, values) {
    var best = 0, dist = Infinity;
    for (var i = 0; i < values.length; i++) {
      var d = Math.abs(values[i] - val);
      if (d < dist) { dist = d; best = i; }
    }
    return best;
  }

  function fmt(v, cfg) {
    if (cfg.values) return parseFloat(v.toFixed(3)) + " " + cfg.unit;
    if (cfg.unit === "%") return Math.round(v) + "%";
    if (cfg.step < 1) return parseFloat(v).toFixed(1) + cfg.unit;
    return Math.round(v) + cfg.unit;
  }

  function syncSliders() {
    SLIDERS.forEach(function (cfg) {
      if (!cfg._el) return;
      var v = App.featureSettings[cfg.key];
      cfg._el.value = cfg.values ? valueToIdx(v, cfg.values) : v;
      if (cfg._valEl) cfg._valEl.textContent = fmt(v, cfg);
    });
  }

  function wireSliders() {
    SLIDERS.forEach(function (cfg) {
      var el = document.getElementById(cfg.id);
      if (!el) return;
      cfg._el = el;
      cfg._valEl = el.parentNode.querySelector(".ds-val");

      if (cfg.values) {
        el.min = 0;
        el.max = cfg.values.length - 1;
        el.step = 1;
      } else {
        el.min = cfg.min;
        el.max = cfg.max;
        el.step = cfg.step;
      }

      el.addEventListener("input", function () {
        var v = cfg.values ? cfg.values[parseInt(el.value)] : parseFloat(el.value);
        App.featureSettings[cfg.key] = v;
        if (cfg._valEl) cfg._valEl.textContent = fmt(v, cfg);
        cfg.onChange(v);
        if (typeof App.cache !== "undefined") App.cache.save();
      });

      el.addEventListener("dblclick", function () {
        App.featureSettings[cfg.key] = cfg.def;
        el.value = cfg.values ? valueToIdx(cfg.def, cfg.values) : cfg.def;
        if (cfg._valEl) cfg._valEl.textContent = fmt(cfg.def, cfg);
        cfg.onChange(cfg.def);
        if (typeof App.cache !== "undefined") App.cache.save();
      });
    });

    var resetBtn = document.getElementById("ds-reset-all");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        SLIDERS.forEach(function (cfg) {
          App.featureSettings[cfg.key] = cfg.def;
          cfg.onChange(cfg.def);
        });
        syncSliders();
        if (typeof App.cache !== "undefined") App.cache.save();
      });
    }
  }

  App._syncDisplaySliders = syncSliders;

  App.registerModule({
    id: "display-settings",
    name: "Display Settings",
    enabled: true,
    system: true,
    popupWidth: 520,
    popupHTML: "projects/display-settings-popup.html",
    init: function () { wireSliders(); syncSliders(); },
    onOpen: function () { syncSliders(); }
  });
})();
