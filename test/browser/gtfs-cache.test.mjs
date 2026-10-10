#!/usr/bin/env node
// test/browser/gtfs-cache.test.mjs
//
// Behavior test for the GTFS feed IndexedDB cache (js/core/gtfs-store.js + the
// persistFeed / restoreCachedGTFS block in js/projects/gtfs.js). Drives the real
// app in headless Chromium and asserts:
//
//   - a loaded feed survives a page refresh (stops, shapes, route index back)
//   - the stop selection and hidden routes come back with it
//   - the status line says the feed was restored from the last session
//   - Build vs No-Build: loading a second ZIP makes IT the one restored on
//     refresh, the stop selection survives the swap, and the store keeps both
//   - the store is capped at MAX_ENTRIES (oldest dropped) and re-loading the
//     same file name replaces its copy
//   - Remove layer (clearGTFS) empties the store and the feed does NOT come back
//   - an unreadable stored copy is dropped instead of failing on every refresh
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see
// test/browser/README.md (NODE_PATH points at a Playwright install).

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-cache.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

// Same status-history trick as network-cache.test.mjs: setStatus clears after
// 5s, so an init script records every change instead of polling the live DOM.
async function waitStatus(page, substr, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = await page.evaluate((s) => (window.__statusLog || []).find((t) => t.includes(s)) || null, substr);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function storeNames(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("mat-gtfs-cache");
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("feeds")) { db.close(); return resolve([]); }
      const r = db.transaction("feeds", "readonly").objectStore("feeds").index("savedAt").getAllKeys();
      r.onsuccess = () => { const n = r.result; db.close(); resolve(n); };
      r.onerror = () => { db.close(); resolve(null); };
    };
    req.onerror = () => resolve(null);
  }));
}
async function waitForNames(page, expected, timeout = 5000) {
  const want = JSON.stringify(expected);
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await storeNames(page);
    if (JSON.stringify(last) === want) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

// A tiny feed. `tag` changes the stop set so the two scenario feeds differ.
function feedFiles(stopIds) {
  const rows = stopIds.map((id, i) => [id, "C" + id, "Stop " + id, 38.806 + i * 0.002, -104.80, 0, ""].join(","));
  return {
    "stops.txt": "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n" + rows.join("\n") + "\n",
    "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS1,38.80,-104.81,1\nS1,38.80,-104.79,2\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,shape_id,direction_id\nr1,svc,t1,Down,S1,0\n",
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,One,One Line,3\n"
  };
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(() => {
      window.__statusLog = [];
      document.addEventListener("DOMContentLoaded", () => {
        const el = document.getElementById("status");
        if (!el) return;
        new MutationObserver(() => { const t = el.textContent; if (t) window.__statusLog.push(t); })
          .observe(el, { childList: true, characterData: true, subtree: true });
      });
    });
    await routeVendoredAssets(context, port, () => false);

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const url = "http://127.0.0.1:" + port + "/index.html";
    const ready = () => page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    const reload = async () => { await page.reload({ waitUntil: "load" }); await ready(); };
    const loadFeed = (name, stopIds) => page.evaluate(async ([name, files]) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      return App.loadGTFSFile(new File([blob], name, { type: "application/zip" }));
    }, [name, feedFiles(stopIds)]);
    const feedStops = () => page.evaluate(() => {
      const d = App.serializeGTFSData();
      return d && d["stops.txt"] ? d["stops.txt"].rows.map((r) => r.stop_id).join(",") : null;
    });

    await page.goto(url, { waitUntil: "load" });
    await ready();
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    check("gtfs-store module loaded and supported",
      await page.evaluate(() => !!(App.gtfsStore && App.gtfsStore.supported() && typeof App.restoreCachedGTFS === "function")));
    check("clean first visit has no feed and an empty store",
      (await feedStops()) === null && JSON.stringify(await storeNames(page)) === "[]");

    // ---- 1. Load No-Build, select stops, hide the route; refresh ----
    check("load resolves true", (await loadFeed("nobuild.zip", ["s1", "s2", "s3"])) === true);
    await page.evaluate(() => { App.gtfsStops.set(["s1", "s3", "gone"]); App.gtfsSetRouteHidden("r1", true); });
    check("feed written to IndexedDB", JSON.stringify(await waitForNames(page, ["nobuild.zip"])) === '["nobuild.zip"]');

    // The session autosave is debounced (500ms); let it land before refreshing.
    await page.waitForTimeout(900);

    await reload();
    check("status says the feed was restored from the last session",
      !!(await waitStatus(page, "restored from last session: nobuild.zip")));
    await page.waitForFunction("App.gtfsStops.isAvailable().ok", { timeout: 15000 });
    check("feed back after refresh (same stops)", (await feedStops()) === "s1,s2,s3");
    check("stops and shapes layers on the map",
      await page.evaluate(() => !!(App.map.getLayer("gtfs-stops-layer") && App.map.getLayer("gtfs-shapes-layer"))));
    check("route index rebuilt", await page.evaluate(() => !!(App.gtfsRouteIndex() && App.gtfsRouteIndex().length === 1)));
    check("stop selection survives (including the id missing from the feed)",
      await page.evaluate(() => App.gtfsStops.ids().slice().sort().join(",")) === "gone,s1,s3");
    check("stop counts: 3 selected, 2 in this feed",
      await page.evaluate(() => JSON.stringify(App.gtfsStops.count())) === JSON.stringify({ total: 3, inFeed: 2 }));
    check("hidden route is re-applied to the restored feed",
      await page.evaluate(() => App.gtfsHiddenState().routes.join(",")) === "r1");

    // ---- 2. Build vs No-Build: swap feeds ----
    await loadFeed("build.zip", ["s1", "s2", "s4"]);
    check("swap replaced the active feed", (await feedStops()) === "s1,s2,s4");
    check("stop selection kept across the swap, s3 now reads as not in this feed",
      (await page.evaluate(() => JSON.stringify(App.gtfsStops.count()))) === JSON.stringify({ total: 3, inFeed: 1 }));
    check("hidden routes reset for the new feed", await page.evaluate(() => App.gtfsHiddenState().routes.length) === 0);
    check("store holds both feeds", JSON.stringify(await waitForNames(page, ["nobuild.zip", "build.zip"])) === '["nobuild.zip","build.zip"]');

    await page.waitForTimeout(900); // debounced autosave
    await reload();
    await page.waitForFunction("App.gtfsStops.isAvailable().ok", { timeout: 15000 });
    check("the most recently loaded feed (Build) is the one restored", (await feedStops()) === "s1,s2,s4");
    check("stop selection still intact after the second refresh",
      await page.evaluate(() => App.gtfsStops.ids().slice().sort().join(",")) === "gone,s1,s3");

    // ---- 3. Store hygiene ----
    await loadFeed("third.zip", ["s9"]);
    check("store caps at MAX_ENTRIES, dropping the oldest",
      JSON.stringify(await waitForNames(page, ["build.zip", "third.zip"])) === '["build.zip","third.zip"]');
    await loadFeed("build.zip", ["s1", "s2", "s4"]);
    check("re-loading a stored file name replaces its copy and makes it newest",
      JSON.stringify(await waitForNames(page, ["third.zip", "build.zip"])) === '["third.zip","build.zip"]');

    // ---- 4. A feed from another source wins over the cache ----
    const noOverride = await page.evaluate(async () => (await App.restoreCachedGTFS()) === false);
    check("restoreCachedGTFS does nothing when a feed is already loaded", noOverride);

    // ---- 5. Remove layer empties the store; no resurrection ----
    await page.evaluate(() => App.clearGTFS());
    check("clearGTFS emptied the store", JSON.stringify(await waitForNames(page, [])) === "[]");
    await reload();
    await page.waitForTimeout(1500);
    check("a removed feed does not come back after refresh", (await feedStops()) === null);

    // ---- 6. A load cannot write back after a clear ----
    await page.evaluate(async ([files]) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      const p = App.loadGTFSFile(new File([blob], "race.zip", { type: "application/zip" }));
      await p;
      App.clearGTFS(); // before the deferred write has had a chance to land
    }, [feedFiles(["s1"])]);
    await page.waitForTimeout(800);
    check("a feed cleared right after loading is not written back",
      JSON.stringify(await storeNames(page)) === "[]");

    // ---- 7. Unreadable stored copy is dropped, not retried forever ----
    await page.evaluate(() => App.gtfsStore.save("junk.zip", new TextEncoder().encode("not a zip").buffer));
    check("junk record stored", JSON.stringify(await waitForNames(page, ["junk.zip"])) === '["junk.zip"]');
    await reload();
    await page.waitForTimeout(1500);
    check("unreadable copy: no feed loaded", (await feedStops()) === null);
    check("unreadable copy: removed from the store", JSON.stringify(await waitForNames(page, [])) === "[]");

    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer();
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + (failed.length
    ? "FAIL — " + failed.length + "/" + results.length + " checks failed"
    : "PASS — " + results.length + "/" + results.length + " checks passed"));
  process.exit(failed.length ? 1 : 0);
})();
