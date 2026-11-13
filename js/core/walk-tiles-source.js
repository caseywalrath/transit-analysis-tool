/* FLM walk-tiles source — App.walkTilesSource.
 * Remembers where the FLM tile release lives (an address, or a folder picked
 * on disk), reads manifest.json and single tile files from it, and wires the
 * "FLM Walk Tiles" dialog. Knows nothing about graphs or the road network.
 * The address is a per-browser setting in localStorage (never in the session
 * file: a session is shared with other people and a disk path means nothing
 * to them). A picked folder is never remembered, because a directory handle
 * would need its own IndexedDB store and a permission prompt after reload.
 * Detail: docs/reference/road-network.md, "FLM walk tiles".
 */
(function () {
  "use strict";

  var App = window.App = window.App || {};

  var STORAGE_KEY = "mat-walk-tiles-source";
  var MAX_CACHED_TILES = 64;
  // Tile paths come from a validated manifest, but readTile also accepts
  // arbitrary callers; this is the only shape that is ever turned into a
  // file name or URL.
  var TILE_PATH_RE = /^network\/\d+_\d+\.json$/;

  // Source state. _source is null, or one of
  //   { kind: "url", url }
  //   { kind: "handle", name, dir }      dir = release FileSystemDirectoryHandle
  //   { kind: "files", name, prefix, lookup }
  var _source = null;
  var _manifest = null;

  // Two counters, deliberately separate. _attempt is bumped by every
  // useUrl/useFolder/clear/restore call, so a slow manifest read that finishes
  // after a newer call began cannot overwrite that call's state. _gen is bumped
  // only when the source really changes: a FAILED attempt must leave the
  // current source fully working, including its tile reads still in flight.
  var _attempt = 0;
  var _gen = 0;

  var _tileCache = new Map();
  var _inflight = new Map();

  function setStatus(text) {
    if (typeof App.setStatus === "function") App.setStatus(text);
  }

  function messageOf(e) {
    return (e && e.message) ? e.message : String(e);
  }

  function readSetting() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && obj.kind === "url" && typeof obj.url === "string" && obj.url) return obj;
    } catch (e) { /* storage unavailable or malformed: treat as no setting */ }
    return null;
  }

  function writeSetting(url) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind: "url", url: url }));
    } catch (e) { /* private mode: the address is just not remembered */ }
  }

  function removeSetting() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  function resetCaches() {
    _tileCache = new Map();
    _inflight = new Map();
  }

  function isActive() {
    return !!(_source && _manifest);
  }

  function describe() {
    if (!isActive()) return null;
    if (_source.kind === "url") return { kind: "url", url: _source.url };
    return { kind: "folder", name: _source.name };
  }

  // Every successful source change and clear() ends here.
  function afterChange() {
    _gen++;
    resetCaches();
    renderInfo();
    if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();
    // Open analysis panels relabel their "load streets" button from this. Not
    // App.notifyProject(): that marks results stale, and the loaded streets
    // have not changed.
    try { document.dispatchEvent(new CustomEvent("walk-tiles-source-changed")); } catch (e) { /* no DOM events */ }
  }

  function invalid(validation) {
    return { ok: false, error: "This folder is not a walk-tiles release: " + validation.error };
  }

  var SUPERSEDED = { ok: false, error: "Superseded by a newer source choice." };

  // ---- URL backend ----

  function normaliseUrl(raw) {
    var u = String(raw == null ? "" : raw).trim();
    u = u.replace(/\/manifest\.json$/, "");
    u = u.replace(/\/+$/, "");
    return u;
  }

  async function fetchManifest(url) {
    try {
      var resp = await fetch(url + "/manifest.json", { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return { ok: true, json: await resp.json() };
    } catch (e) {
      return { ok: false, error: "Could not read manifest.json at " + url + ": " + messageOf(e) };
    }
  }

  async function useUrl(rawUrl) {
    // Checked before the attempt counter moves: an empty submit must not
    // cancel a good manifest read (e.g. the startup restore) still in flight.
    var url = normaliseUrl(rawUrl);
    if (!url) return { ok: false, error: "Enter the tile folder address first." };
    var attempt = ++_attempt;
    try {
      var read = await fetchManifest(url);
      if (attempt !== _attempt) return SUPERSEDED;
      if (!read.ok) return read;
      var validation = window.WalkTiles.validateManifest(read.json);
      if (!validation.ok) return invalid(validation);
      _source = { kind: "url", url: url };
      _manifest = validation.manifest;
      writeSetting(url);
      afterChange();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  }

  async function restore() {
    var attempt = ++_attempt;
    try {
      var setting = readSetting();
      if (!setting) return false;
      var url = normaliseUrl(setting.url);
      if (!url) return false;
      var read = await fetchManifest(url);
      if (attempt !== _attempt) return false;
      var validation = read.ok ? window.WalkTiles.validateManifest(read.json) : null;
      if (!read.ok || !validation.ok) {
        // The stored setting stays: the server may simply not be running yet.
        // Said on screen too, because without the source the analysis panels
        // quietly offer an OpenStreetMap download instead.
        console.warn("FLM tile source not restored: " + (read.ok ? validation.error : read.error));
        setStatus("FLM tile address could not be read (" + url + "). Open Add Data \u2192 FLM Walk Tiles to retry.");
        renderInfo();
        return false;
      }
      _source = { kind: "url", url: url };
      _manifest = validation.manifest;
      afterChange();
      return true;
    } catch (e) {
      console.warn("FLM tile source not restored: " + messageOf(e));
      return false;
    }
  }

  // ---- Folder backend ----

  var NOT_FOUND = "This folder is not a walk-tiles release: manifest.json not found";
  var NOT_RELEASE_ITSELF = "Pick the release folder itself, not its parent.";
  var NOT_JSON = "This folder is not a walk-tiles release: manifest.json is not valid JSON";

  function isMissing(e) {
    return !!e && (e.name === "NotFoundError" || e.name === "TypeMismatchError");
  }

  // Picks the folder holding manifest.json: the picked one, or its only
  // child that has one.
  async function findReleaseDir(handle) {
    try {
      return { dir: handle, file: await handle.getFileHandle("manifest.json") };
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    var found = [];
    for await (var entry of handle.values()) {
      if (entry.kind !== "directory") continue;
      try {
        found.push({ dir: entry, file: await entry.getFileHandle("manifest.json") });
      } catch (e2) {
        if (!isMissing(e2)) throw e2;
      }
    }
    if (found.length > 1) return { error: NOT_RELEASE_ITSELF };
    if (found.length === 0) return { error: NOT_FOUND };
    return found[0];
  }

  async function openHandle(handle) {
    var rel = await findReleaseDir(handle);
    if (rel.error) return { ok: false, error: rel.error };
    var json;
    try {
      json = JSON.parse(await (await rel.file.getFile()).text());
    } catch (e) {
      return { ok: false, error: NOT_JSON };
    }
    return { ok: true, json: json, source: { kind: "handle", name: rel.dir.name, dir: rel.dir } };
  }

  async function openFiles(files) {
    var lookup = Object.create(null);
    var count = 0;
    var twoPart = "";
    var threePart = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var rp = f && f.webkitRelativePath;
      if (!rp) continue;
      lookup[rp] = f;
      count++;
      var parts = rp.split("/");
      if (parts.length === 2 && parts[1] === "manifest.json" && !twoPart) {
        twoPart = parts[0] + "/";
      } else if (parts.length === 3 && parts[2] === "manifest.json") {
        threePart.push(parts[0] + "/" + parts[1] + "/");
      }
    }
    if (count === 0) return { ok: false, error: "No folder was chosen." };
    var prefix = twoPart;
    if (!prefix) {
      if (threePart.length > 1) return { ok: false, error: NOT_RELEASE_ITSELF };
      if (threePart.length === 0) return { ok: false, error: NOT_FOUND };
      prefix = threePart[0];
    }
    var json;
    try {
      json = JSON.parse(await lookup[prefix + "manifest.json"].text());
    } catch (e) {
      return { ok: false, error: NOT_JSON };
    }
    var names = prefix.split("/").filter(function (s) { return s !== ""; });
    return {
      ok: true,
      json: json,
      source: { kind: "files", name: names[names.length - 1], prefix: prefix, lookup: lookup }
    };
  }

  async function useFolder(opts) {
    var attempt = ++_attempt;
    try {
      var opened;
      if (opts && opts.handle) {
        opened = await openHandle(opts.handle);
      } else if (opts && opts.files && opts.files.length) {
        opened = await openFiles(opts.files);
      } else {
        return { ok: false, error: "No folder was chosen." };
      }
      if (attempt !== _attempt) return SUPERSEDED;
      if (!opened.ok) return opened;
      var validation = window.WalkTiles.validateManifest(opened.json);
      if (!validation.ok) return invalid(validation);
      _source = opened.source;
      _manifest = validation.manifest;
      // A reload must not silently bring back an older address.
      removeSetting();
      afterChange();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  }

  // ---- Tile reads ----

  // Each backend resolves to the parsed tile, or throws an Error whose
  // message is only the reason; readTile adds the path prefix.
  async function readFromUrl(src, path) {
    var resp = await fetch(src.url + "/" + path);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }

  async function readFromHandle(src, path) {
    try {
      var netDir = await src.dir.getDirectoryHandle("network");
      var fh = await netDir.getFileHandle(path.slice("network/".length));
      return JSON.parse(await (await fh.getFile()).text());
    } catch (e) {
      if (isMissing(e)) throw new Error("file not found");
      throw e;
    }
  }

  async function readFromFiles(src, path) {
    var file = src.lookup[src.prefix + path];
    if (!file) throw new Error("file not found");
    return JSON.parse(await file.text());
  }

  function fail(path, reason) {
    return new Error("FLM tile " + path + " could not be read: " + reason);
  }

  function readTile(path) {
    if (!isActive()) return Promise.reject(fail(path, "no tile source is set"));
    if (typeof path !== "string" || !TILE_PATH_RE.test(path)) {
      return Promise.reject(fail(path, "not a valid tile path"));
    }
    if (_tileCache.has(path)) return Promise.resolve(_tileCache.get(path));
    if (_inflight.has(path)) return _inflight.get(path);

    var gen = _gen;
    var src = _source;
    var backend = src.kind === "url" ? readFromUrl
      : (src.kind === "handle" ? readFromHandle : readFromFiles);

    var promise = backend(src, path).then(function (tile) {
      return { tile: tile };
    }, function (err) {
      return { err: err };
    }).then(function (r) {
      // Settled results are looked at only after the source check, so a
      // stale answer is never cached or handed to the caller.
      if (_inflight.get(path) === promise) _inflight.delete(path);
      if (gen !== _gen) throw fail(path, "the tile source changed");
      if (r.err) throw fail(path, messageOf(r.err));
      _tileCache.set(path, r.tile);
      if (_tileCache.size > MAX_CACHED_TILES) {
        _tileCache.delete(_tileCache.keys().next().value);
      }
      return r.tile;
    });
    _inflight.set(path, promise);
    return promise;
  }

  // ---- Clear ----

  function clear() {
    _attempt++;
    var wasActive = isActive();
    removeSetting();
    _source = null;
    _manifest = null;
    afterChange();
    if (wasActive) setStatus("FLM tile source forgotten. Loaded streets stay until replaced.");
  }

  // ---- Dialog info ----

  function addLine(parent, text) {
    var div = document.createElement("div");
    div.textContent = text;
    parent.appendChild(div);
    return div;
  }

  function renderInfo() {
    var urlInput = document.getElementById("wtUrl");
    var info = document.getElementById("wtInfo");
    var d = describe();
    if (urlInput && d && d.kind === "url") urlInput.value = d.url;
    // A remembered address that failed to load is offered back for a retry.
    if (urlInput && !d && !urlInput.value) {
      var remembered = readSetting();
      if (remembered) urlInput.value = remembered.url;
    }
    if (!info) return;
    while (info.firstChild) info.removeChild(info.firstChild);
    if (!d) return;

    var m = _manifest;
    addLine(info, "Release: " + m.release_id +
      (d.kind === "url" ? " (address)" : " (folder: " + d.name + ")"));
    var b = m.coverage.bbox;
    addLine(info, "Prepared area: " + b[0].toFixed(3) + ", " + b[1].toFixed(3) +
      " to " + b[2].toFixed(3) + ", " + b[3].toFixed(3));
    addLine(info, "Tiles: " + m.tiles.length);
    if (typeof m.default_speed_mph === "number") {
      addLine(info, "Default speed: " + m.default_speed_mph + " mph (set speed in the analysis panel)");
    }

    var data = addLine(info, "Data: ");
    var url = m.attribution_url;
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      var a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = m.attribution;
      data.appendChild(a);
    } else {
      data.appendChild(document.createTextNode(m.attribution));
    }
    if (typeof m.license === "string") data.appendChild(document.createTextNode(", " + m.license));

    if (typeof m.distribution_status === "string") {
      addLine(info, "Status: " + m.distribution_status);
    }
    var ul = document.createElement("ul");
    for (var i = 0; i < m.limitations.length; i++) {
      var li = document.createElement("li");
      li.textContent = m.limitations[i];
      ul.appendChild(li);
    }
    info.appendChild(ul);
  }

  // ---- Dialog wiring ----

  function report(result) {
    if (result.ok) setStatus("FLM tile source set: " + releaseId());
    else setStatus(result.error);
  }

  function releaseId() {
    return isActive() ? _manifest.release_id : "";
  }

  function wireDialog() {
    var popup = document.getElementById("walk-tiles-popup");
    if (!popup) return;

    var closeBtn = document.getElementById("walk-tiles-popup-close");
    var useBtn = document.getElementById("wtUseUrl");
    var urlInput = document.getElementById("wtUrl");
    var pickBtn = document.getElementById("wtPickFolder");
    var folderInput = document.getElementById("wtFolderInput");
    var clearBtn = document.getElementById("wtClear");

    if (closeBtn) {
      closeBtn.addEventListener("click", function () { popup.style.display = "none"; });
    }

    async function submitUrl() {
      // The disabled check also stops Enter from starting a second read.
      if (!urlInput || !useBtn || useBtn.disabled) return;
      useBtn.disabled = true;
      try {
        setStatus("Reading FLM tile manifest…");
        report(await useUrl(urlInput.value));
      } finally {
        useBtn.disabled = false;
      }
    }
    if (useBtn) useBtn.addEventListener("click", submitUrl);
    if (urlInput) {
      urlInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") submitUrl();
      });
    }

    if (pickBtn) {
      pickBtn.addEventListener("click", async function () {
        if (typeof window.showDirectoryPicker !== "function") {
          if (folderInput) folderInput.click();
          return;
        }
        var handle;
        try {
          handle = await window.showDirectoryPicker({ mode: "read" });
        } catch (e) {
          if (e && e.name === "AbortError") return;
          setStatus("Could not open the folder: " + messageOf(e));
          return;
        }
        report(await useFolder({ handle: handle }));
      });
    }

    if (folderInput) {
      folderInput.addEventListener("change", async function () {
        var result = await useFolder({ files: folderInput.files });
        report(result);
        // Reset after reading so the same folder can be picked again; the
        // File objects already captured stay readable.
        folderInput.value = "";
      });
    }

    if (clearBtn) clearBtn.addEventListener("click", clear);
  }

  App.walkTilesSource = {
    isActive: isActive,
    manifest: function () { return isActive() ? _manifest : null; },
    releaseId: releaseId,
    describe: describe,
    useUrl: useUrl,
    useFolder: useFolder,
    readTile: readTile,
    clear: clear,
    restore: restore,
    renderInfo: renderInfo
  };

  wireDialog();
})();
