/* GeoPackage file offline store (IndexedDB).
 *
 * An imported .gpkg is a SQLite database that can run to tens of megabytes, far
 * too large for localStorage, so the session autosave in js/core/cache.js does not
 * carry it. This store keeps the ORIGINAL file bytes instead of the parsed layers:
 * restoring a file re-runs the same open path as a fresh import, so a restored
 * layer can never differ from one the user just opened. The only state kept beside
 * the bytes is which layers the user chose to show and their colors, because those
 * are choices rather than file contents.
 *
 * Same stance as js/core/gtfs-store.js and js/core/network-store.js: this is strictly
 * a convenience. Imported layers already draw whether or not a write lands, and
 * browsers may evict IndexedDB under storage pressure at any time, so every failure
 * path is swallowed (save and update report false) and the user simply imports the
 * file again.
 *
 * Records are keyed by file name, so re-importing the same file replaces its stored
 * copy. Two limits apply together: at most MAX_ENTRIES files, and at most MAX_BYTES
 * summed across them. Oldest files are dropped first. A single file larger than
 * MAX_BYTES is refused outright, because evicting everything else to make room for
 * it would still leave nothing stored.
 *
 * Record: { name, savedAt, size, bytes (ArrayBuffer), layers: [table names],
 *           colors: { table: { base: "#hex", color: "#hex" } } }  (base = reset color)
 * Every transaction goes through _withStore, which is subject to the
 * TransactionInactiveError rule documented in network-store.js: requests must be
 * issued synchronously or from another request's onsuccess, never after an await.
 */
(function () {
  var App = window.App;

  var IDB_NAME    = "mat-gpkg-cache";
  var IDB_VERSION = 1;
  var IDB_STORE   = "files";

  var MAX_ENTRIES = 3;
  var MAX_BYTES   = 100 * 1024 * 1024;

  function supported() { return !!window.indexedDB; }

  function _idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var store = db.createObjectStore(IDB_STORE, { keyPath: "name" });
          // Lets _prune() and list() order by age without sorting every stored file
          // in memory.
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

  // Delete oldest records until at most `maxCount` remain and their summed size is
  // within MAX_BYTES; `keepName` is never dropped. maxCount 0 drops every other
  // record, which is the retry path after a failed write. Whole records are read
  // because the size sum needs each record's size.
  function _prune(keepName, maxCount) {
    return _withStore("readwrite", function (store) {
      var req = store.index("savedAt").getAll(); // oldest -> newest
      req.onsuccess = function () {
        var recs = req.result || [];
        var count = recs.length;
        var total = 0;
        for (var j = 0; j < recs.length; j++) total += recs[j].size || 0;
        for (var i = 0; i < recs.length; i++) {
          if (count <= maxCount && total <= MAX_BYTES) break;
          if (recs[i].name === keepName) continue;
          store.delete(recs[i].name);
          count--;
          total -= recs[i].size || 0;
        }
      };
    });
  }

  function _put(record) {
    return _withStore("readwrite", function (store) { store.put(record); });
  }

  // Store one file, then trim back to MAX_ENTRIES and MAX_BYTES. A failed write
  // (quota is the realistic case) retries exactly once after dropping every OTHER
  // stored file; a second failure is logged and ignored.
  async function save(name, bytes, layers, colors) {
    if (!supported() || !name || !bytes) return false;
    var size = bytes.byteLength || 0;
    if (size > MAX_BYTES) return false;
    var record = {
      name: name,
      savedAt: Date.now(),
      size: size,
      bytes: bytes,
      layers: layers || [],
      colors: colors || {}
    };
    try {
      await _put(record);
    } catch (e) {
      // Only a failed write (quota is the realistic case) earns the
      // drop-everything-else retry; a failed trim afterwards must not wipe
      // files that are already stored.
      try {
        await _prune(name, 0);
        await _put(record);
      } catch (e2) {
        console.warn("GeoPackage cache: store failed —", (e2 && e2.message) || e2);
        return false;
      }
    }
    try { await _prune(name, MAX_ENTRIES); } catch (e3) { /* the next save trims again */ }
    return true;
  }

  // Stored files, newest first. Any failure reads as an empty store.
  async function list() {
    if (!supported()) return [];
    try {
      return await _withStore("readonly", function (store) {
        var req = store.index("savedAt").getAll(); // oldest -> newest
        return function () { return (req.result || []).slice().reverse(); };
      });
    } catch (e) {
      return [];
    }
  }

  // Replace the layer choice and colors of a stored file, keeping its bytes and
  // savedAt. An empty layers list means nothing is shown any more, so the file is
  // removed. Missing file resolves false.
  async function update(name, layers, colors) {
    if (!supported() || !name || !Array.isArray(layers)) return false;
    try {
      return await _withStore("readwrite", function (store) {
        var found = false;
        var getReq = store.get(name);
        getReq.onsuccess = function () {
          var rec = getReq.result;
          if (!rec) return;
          found = true;
          if (!layers.length) {
            store.delete(name);
          } else {
            store.put(Object.assign({}, rec, { layers: layers, colors: colors || {} }));
          }
        };
        return function () { return found; };
      });
    } catch (e) {
      return false;
    }
  }

  async function remove(name) {
    if (!supported() || !name) return false;
    try {
      await _withStore("readwrite", function (store) { store.delete(name); });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function clear() {
    if (!supported()) return false;
    try {
      await _withStore("readwrite", function (store) { store.clear(); });
      return true;
    } catch (e) {
      console.warn("GeoPackage cache: clear failed —", (e && e.message) || e);
      return false;
    }
  }

  App.gpkgStore = {
    supported: supported,
    save: save,
    list: list,
    update: update,
    remove: remove,
    clear: clear,
    MAX_ENTRIES: MAX_ENTRIES,
    MAX_BYTES: MAX_BYTES
  };
})();
