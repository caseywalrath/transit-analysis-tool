// js/core/undo.js
// Undo/redo stack using full-state snapshots from cache.js.
// Depends on: App.cache (cache.js) — collectState, applyState.
// Exports: App.undo

(function () {
  var App = window.App;
  var _undoStack = [];
  var _redoStack = [];
  var MAX_STACK = 50;
  var _restoring = false;
  var _batchDepth = 0;

  function snapshot() {
    return JSON.parse(JSON.stringify(App.cache.collectState("light")));
  }

  function push() {
    if (_restoring || _batchDepth > 0) return;
    _undoStack.push(snapshot());
    if (_undoStack.length > MAX_STACK) _undoStack.shift();
    _redoStack.length = 0;
    updateButtons();
  }

  function undo() {
    if (_undoStack.length === 0) return;
    _redoStack.push(snapshot());
    var state = _undoStack.pop();
    restore(state);
    updateButtons();
  }

  function redo() {
    if (_redoStack.length === 0) return;
    _undoStack.push(snapshot());
    var state = _redoStack.pop();
    restore(state);
    updateButtons();
  }

  function restore(state) {
    _restoring = true;
    try {
      App.cache.applyState(state);
      if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
      App.cache.save();
    } finally {
      _restoring = false;
    }
  }

  function updateButtons() {
    var undoBtn = document.getElementById("undo-btn");
    var redoBtn = document.getElementById("redo-btn");
    var isDrawing = (typeof App._lineDrawingInProgress === "function" && App._lineDrawingInProgress()) ||
                    (typeof App._routeDrawingInProgress === "function" && App._routeDrawingInProgress()) ||
                    (typeof App._polygonDrawingInProgress === "function" && App._polygonDrawingInProgress());
    if (undoBtn) undoBtn.disabled = (_undoStack.length === 0) && !isDrawing;
    if (redoBtn) redoBtn.disabled = (_redoStack.length === 0);
  }

  // Run fn as ONE undo step: one snapshot now, and every push() inside fn is a
  // no-op (e.g. several App.addLineFromCoords calls). Returns fn's result.
  function batch(fn) {
    push();
    _batchDepth++;
    try { return fn(); } finally { _batchDepth--; }
  }

  function isRestoring() { return _restoring; }

  App.undo = {
    push: push,
    batch: batch,
    undo: undo,
    redo: redo,
    canUndo: function () { return _undoStack.length > 0; },
    canRedo: function () { return _redoStack.length > 0; },
    updateButtons: updateButtons,
    isRestoring: isRestoring
  };
})();
