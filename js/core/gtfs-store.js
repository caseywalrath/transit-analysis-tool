/* GTFS feed offline store (IndexedDB).
 *
 * A loaded GTFS feed is far too large for localStorage (stop_times.txt alone
 * can be millions of rows), so the session autosave in js/core/cache.js carries
 * only the stop selection and hidden-route sets, never the feed. This store
 * keeps the ORIGINAL ZIP bytes instead of the parsed tables: the ZIP is several
 * times smaller than the parsed rows, and re-parsing it on startup goes through
 * exactly the same loadGTFSFile() path as a fresh upload, so a restored feed can
 * never differ from an uploaded one.
 *
 * Same stance as js/core/network-store.js: this is strictly a convenience. The
 * in-memory feed is already loaded and usable whether or not a write lands, and
 * browsers may evict IndexedDB under storage pressure at any time, so every
 * failure path is swallowed and callers fall back to "upload the ZIP again".
 *
 * Records are keyed by file name, so re-loading the same ZIP replaces its stored
 * copy. MAX_ENTRIES keeps the last two feeds (Build and No-Build is the realistic
 * working set); only the most recently loaded one is restored at startup.
 *
 * Record: { name, savedAt, size, bytes (ArrayBuffer) }
 * Helper shape (_withStore, the TransactionInactiveError rule) is documented in
 * network-store.js — requests must be issued synchronously or from another
 * request's onsuccess, never after an await.
 */
(function () {
  var App = window.App;

  var IDB_NAME    = "mat-gtfs-cache";
  var IDB_VERSION = 1;
  var IDB_STORE   = "feeds";

  var MAX_ENTRIES = 2;

  function supported() { return !!window.indexedDB; }

  function _idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var store = db.createObjectStore(IDB_STORE, { keyPath: "name" });
          // Lets prune()/latest() order by age reading keys only, never pulling
          // every stored ZIP into memory to sort it.
          store.createIndex("savedAt", "savedAt");
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

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

  // Delete oldest entries until at most `keep` remain; `keepName` is never
  // dropped. Reads keys only.
  function _prune(keepName, keep) {
    return _withStore("readwrite", function (store) {
      var keysReq = store.index("savedAt").getAllKeys(); // oldest -> newest
      keysReq.onsuccess = function () {
        var names = keysReq.result || [];
        var excess = names.length - keep;
        for (var i = 0; i < names.length && excess > 0; i++) {
          if (names[i] === keepName) continue;
          store.delete(names[i]);
          excess--;
        }
      };
    });
  }

  function _put(record) {
    return _withStore("readwrite", function (store) { store.put(record); });
  }

  // Store one feed, then trim back to MAX_ENTRIES. A failed write (quota is the
  // realistic case) retries exactly once after dropping every OTHER stored feed;
  // a second failure is logged and ignored.
  async function save(name, bytes) {
    if (!supported() || !name || !bytes) return false;
    var record = { name: name, savedAt: Date.now(), size: bytes.byteLength || 0, bytes: bytes };
    try {
      await _put(record);
      await _prune(name, MAX_ENTRIES);
      return true;
    } catch (e) {
      try {
        await _prune(name, 0);
        await _put(record);
        return true;
      } catch (e2) {
        console.warn("GTFS cache: store failed —", (e2 && e2.message) || e2);
        return false;
      }
    }
  }

  // The most recently stored feed, or null. Fetches only the winning record.
  async function latest() {
    if (!supported()) return null;
    try {
      return await _withStore("readonly", function (store) {
        var found = null;
        var keysReq = store.index("savedAt").getAllKeys();
        keysReq.onsuccess = function () {
          var names = keysReq.result || [];
          if (!names.length) return;
          var getReq = store.get(names[names.length - 1]);
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
      console.warn("GTFS cache: clear failed —", (e && e.message) || e);
      return false;
    }
  }

  App.gtfsStore = {
    supported: supported,
    save: save,
    latest: latest,
    clear: clear,
    MAX_ENTRIES: MAX_ENTRIES
  };
})();
