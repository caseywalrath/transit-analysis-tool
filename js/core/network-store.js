/* Road-network offline store (IndexedDB) — App.networkStore.
 * The network is expensive to re-fetch from Overpass and far too large for
 * localStorage, so it gets its own database. Strictly an optimization: every
 * failure is swallowed, and browsers may evict the store at any time, so
 * callers always fall back to a fresh download.
 * Do NOT copy the _idbTx/await helper shape of cache.js's Recent Projects
 * store — see _withStore().
 * Detail: docs/reference/road-network.md
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
  // requests synchronously (or from another request's onsuccess) — never after
  // an await. A transaction deactivates when control returns to the event loop,
  // so await-then-touch throws TransactionInactiveError whenever the main thread
  // is busy — i.e. at page startup, exactly when this store is read.
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

  // Store one network, then trim to MAX_ENTRIES. A failed write (realistically
  // quota) retries once after dropping every OTHER stored network; a second
  // failure is logged and ignored.
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
