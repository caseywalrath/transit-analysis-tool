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

  function syncSliders() {
    SLIDERS.forEach(function (cfg) {
      if (cfg._scrubber) cfg._scrubber.refresh(App.featureSettings[cfg.key]);
    });
  }

  function wireSliders() {
    SLIDERS.forEach(function (cfg) {
      var host = document.getElementById(cfg.id);
      if (!host || cfg._scrubber) return;

      cfg._scrubber = App.buildScrubber({
        min: cfg.min,
        max: cfg.max,
        step: cfg.step,
        unit: cfg.unit,
        value: App.featureSettings[cfg.key],
        onChange: function (v) {
          App.featureSettings[cfg.key] = v;
          cfg.onChange(v);
          if (typeof App.cache !== "undefined") App.cache.save();
        }
      });
      host.appendChild(cfg._scrubber);
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
    popupWidth: 860,
    popupHTML: "projects/display-settings-popup.html",
    init: function () { wireSliders(); syncSliders(); },
    onOpen: function () { syncSliders(); }
  });
})();
