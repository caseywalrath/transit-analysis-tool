/* Road-network offline store (IndexedDB).
 *
 * The downloaded street network is the one piece of session state that is both
 * expensive to reacquire — the public Overpass endpoint frequently fails and
 * needs several retries — and far too large for localStorage (tens of MB on a
 * city-scale download). It therefore lives in its own IndexedDB database rather
 * than riding the session cache in js/core/cache.js.
 *
 * Everything here is strictly an optimization: the in-memory network is already
 * built and usable whether or not a write lands, so every failure path is
 * swallowed rather than surfaced. Browsers may also evict IndexedDB under
 * storage pressure at any time, so a cached network must never be assumed to
 * be there — callers always fall back to a fresh download.
 *
 * Helper shape (_idbOpen/_idbTx/_idbRequest, async/await, errors swallowed)
 * deliberately mirrors the Recent Projects store in js/core/cache.js.
 */
(function () {
  var App = window.App;

  var IDB_NAME    = "mat-network-cache";
  var IDB_VERSION = 1;
  var IDB_STORE   = "networks";

  // How many distinct networks to retain. Each is tens of MB, and the realistic
  // working set is "the area I'm analyzing now, plus the one I was on before".
  var MAX_ENTRIES = 3;

  function supported() { return !!window.indexedDB; }

  function _idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var store = db.createObjectStore(IDB_STORE, { keyPath: "id" });
          // Lets prune()/latest() order by age reading keys only, never pulling
          // every stored network's geojson string into memory to sort it.
          store.createIndex("savedAt", "savedAt");
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  // Run one transaction. `fn` receives the object store and MUST issue its
  // requests synchronously (or from another request's onsuccess, where the
  // transaction is still active) — never after an await. An IndexedDB
  // transaction deactivates as soon as control returns to the event loop, so
  // awaiting a request and then touching the store again throws
  // TransactionInactiveError whenever the main thread is busy enough to push
  // the continuation past a task boundary. That is exactly the situation at
  // page startup, where this store's whole reason for existing is to be read.
  // `fn` may return a zero-arg getter for the value to resolve with, collected
  // after the transaction commits.
  function _withStore(mode, fn) {
    return _idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, out;
        try {
          tx = db.transaction(IDB_STORE, mode);
          out = fn(tx.objectStore(IDB_STORE));
        } catch (e) {
          db.close();
          reject(e);
          return;
        }
        tx.oncomplete = function () { db.close(); resolve(typeof out === "function" ? out() : out); };
        tx.onerror    = function () { var err = tx.error; db.close(); reject(err); };
        tx.onabort    = function () { var err = tx.error || new Error("transaction aborted"); db.close(); reject(err); };
      });
    });
  }

  // Delete oldest entries until at most `keep` remain. `keepId` is never
  // dropped, so the network just written always survives its own prune.
  // Reads keys only — a getAll() would deserialize every stored network.
  function _prune(keepId, keep) {
    return _withStore("readwrite", function (store) {
      var keysReq = store.index("savedAt").getAllKeys(); // oldest -> newest
      keysReq.onsuccess = function () {
        var ids = keysReq.result || [];
        var excess = ids.length - keep;
        for (var i = 0; i < ids.length && excess > 0; i++) {
          if (ids[i] === keepId) continue;
          store.delete(ids[i]);
          excess--;
        }
      };
    });
  }

  function _put(record) {
    return _withStore("readwrite", function (store) { store.put(record); });
  }

  // Store one network, then trim the store back to MAX_ENTRIES.
  // A failed write (quota exceeded is the realistic case — these records are
  // large) retries exactly once after dropping every OTHER stored network,
  // which is the only recovery available to us; a second failure is logged and
  // otherwise ignored.
  async function save(record) {
    if (!supported() || !record || !record.id) return false;
    try {
      await _put(record);
      await _prune(record.id, MAX_ENTRIES);
      return true;
    } catch (e) {
      try {
        await _prune(record.id, 0);
        await _put(record);
        return true;
      } catch (e2) {
        console.warn("Road network cache: store failed —", (e2 && e2.message) || e2);
        return false;
      }
    }
  }

  // The most recently stored network, or null. Reads the key list first and
  // fetches only the winning record, so the other stored networks' geojson
  // strings are never deserialized. The get() is issued from the key request's
  // onsuccess, where the transaction is still active — see _withStore().
  async function latest() {
    if (!supported()) return null;
    try {
      return await _withStore("readonly", function (store) {
        var found = null;
        var keysReq = store.index("savedAt").getAllKeys();
        keysReq.onsuccess = function () {
          var ids = keysReq.result || [];
          if (!ids.length) return;
          var getReq = store.get(ids[ids.length - 1]);
          getReq.onsuccess = function () { found = getReq.result || null; };
        };
        return function () { return found; };
      });
    } catch (e) {
      return null;
    }
  }

  async function clear() {
    if (!supported()) return false;
    try {
      await _withStore("readwrite", function (store) { store.clear(); });
      return true;
    } catch (e) {
      console.warn("Road network cache: clear failed —", (e && e.message) || e);
      return false;
    }
  }

  App.networkStore = {
    supported: supported,
    save: save,
    latest: latest,
    clear: clear,
    MAX_ENTRIES: MAX_ENTRIES
  };
})();
