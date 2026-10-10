#!/usr/bin/env node
// test/browser/network-cache.test.mjs
//
// Behavior test for the road-network IndexedDB cache (js/core/network-store.js
// + the offline-persistence block in js/core/road-network.js). Drives the real
// app in headless Chromium against a stubbed Overpass endpoint and asserts the
// invariants that would otherwise rot silently:
//
//   - a downloaded network survives a page refresh with no Overpass request
//   - restore bumps the network epoch, so every epoch-keyed module cache
//     (Walkshed, Transit Travelshed) invalidates exactly as it would after a
//     fresh fetch — a restored network must never validate geometry a previous
//     page load computed against it
//   - the recorded download extent is restored too, so Transit Travelshed's
//     coverage check keeps working
//   - a >48h old network adds the "Re-download to refresh." nudge
//   - an explicit clear empties the store and does NOT resurrect on refresh
//   - the store dedupes by download area and prunes to MAX_ENTRIES
//   - unload (Layers panel Remove, Add Data ×, toolbar Clear) keeps the stored
//     copy, and a Walkshed run afterwards restores it with NO Overpass request
//   - "Delete downloaded streets" (confirmed) and Reset Session empty the store;
//     Reset also clears excluded streets and crossing settings
//   - findCovering() only returns an entry whose extent contains the request
//
// WHY THIS HARNESS EXISTS
// The golden harness (test/run-golden.mjs) pins pure math only, by design, and
// test/ui-screens/capture.mjs compares pixels. Neither can see a wrong runtime
// behavior in the browser. This file was written after an IndexedDB transaction
// went inactive under page-startup load and made the cache silently return "no
// stored network" — a bug invisible to both existing harnesses.
//
// Shared plumbing (Playwright loading, Chromium resolution, vendored-CDN
// route interception, the static server) lives in test/browser/harness.mjs —
// see docs/archive/browser-test-harness-plan.md.
//
// USAGE (same NODE_PATH dance as capture.mjs — this repo has no npm install)
//   mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null
//   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
//   NODE_PATH=/tmp/pw-install/node_modules node test/browser/network-cache.test.mjs
//
// Exits 0 when every check passes, 1 otherwise (same contract as run-golden.mjs).

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/network-cache.test.mjs");

// A tiny but real 4x4 street grid over the app's default view, returned for any
// Overpass query. Enough to build a graph and flood a walkshed; small enough to
// keep the run fast and deterministic.
function overpassPayload() {
  const lat0 = 38.8339, lng0 = -104.8214;
  const d = 0.004;
  const elements = [];
  let id = 1000;
  for (let i = 0; i < 4; i++) {
    const lat = lat0 + i * d;
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "EW " + i },
      geometry: [0, 1, 2, 3].map((j) => ({ lat, lon: lng0 + j * d })) });
  }
  for (let j = 0; j < 4; j++) {
    const lon = lng0 + j * d;
    elements.push({ type: "way", id: id++, tags: { highway: "residential", name: "NS " + j },
      geometry: [0, 1, 2, 3].map((i) => ({ lat: lat0 + i * d, lon })) });
  }
  return JSON.stringify({ elements });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

// App.setStatus clears the status line after 5s, so polling the live DOM can
// miss a message entirely (this cost a debugging cycle during development).
// An init script records every status change into window.__statusLog instead;
// this reads that history. Keep this comment wherever this helper ends up.
async function waitStatus(page, substr, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = await page.evaluate((s) => (window.__statusLog || []).find((t) => t.includes(s)) || null, substr);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function idbCount(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("mat-network-cache");
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("networks")) { db.close(); return resolve(0); }
      const r = db.transaction("networks", "readonly").objectStore("networks").getAllKeys();
      r.onsuccess = () => { const n = r.result.length; db.close(); resolve(n); };
      r.onerror = () => { db.close(); resolve(-1); };
    };
    req.onerror = () => resolve(-1);
  }));
}

// Polls idbCount(page) until it equals `expected` or the deadline passes.
// Replaces a fixed sleep for "wait for the deferred IndexedDB write/clear to
// land" — see docs/archive/browser-test-harness-plan.md Phase 3.
async function waitForIdbCount(page, expected, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = -2;
  while (Date.now() < deadline) {
    last = await idbCount(page);
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

// There is no event for "restoreCachedNetwork() decided not to run" — a
// cleared store legitimately produces zero status messages on the next load,
// so there is nothing to poll *for*. This waits for the status log to become
// non-empty (restore activity actually happened) or the deadline, whichever
// comes first, rather than always sleeping the full bound like a flat
// waitForTimeout would. In the common case (nothing restored) it still spends
// the whole timeout — that is expected and is why this stays a bounded wait
// rather than a real polled assertion (docs/archive/browser-test-harness-plan.md
// Phase 3).
async function waitForStatusActivity(page, timeout = 1200) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const len = await page.evaluate(() => (window.__statusLog || []).length);
    if (len > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
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
        new MutationObserver(() => {
          const t = el.textContent;
          if (t) window.__statusLog.push(t);
        }).observe(el, { childList: true, characterData: true, subtree: true });
      });
    });

    // Vendor the CDN assets, stub Overpass, abort every other remote host
    // (tiles, Census, OSRM, fonts) so the run is offline-safe and fast.
    let overpassHits = 0;
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("overpass-api.de")) {
        overpassHits++;
        route.fulfill({ status: 200, contentType: "application/json", body: overpassPayload() });
        return true;
      }
      return false;
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    // fetchRoadNetwork() confirms before a large-area download; auto-accept.
    page.on("dialog", (d) => d.accept());

    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });

    check("network-store module loaded",
      await page.evaluate(() => !!(window.App.networkStore && window.App.networkStore.supported())));
    check("restoreCachedNetwork exported",
      await page.evaluate(() => typeof window.App.restoreCachedNetwork === "function"));
    check("no network loaded on a clean first visit",
      !(await page.evaluate(() => App.roadNetworkLoaded())));

    // ---- 1. Download a network ----
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });
    const epochAfterDownload = await page.evaluate(() => App.roadNetworkEpoch());
    check("download built a graph", await page.evaluate(() => App.roadNetworkLoaded()),
      "overpass hits=" + overpassHits);

    // persistNetwork defers via setTimeout(0) then writes async — poll for the
    // write to land instead of guessing at a fixed delay.
    const countAfterDownload = await waitForIdbCount(page, 1);
    check("network written to IndexedDB", countAfterDownload === 1, "records=" + countAfterDownload);

    // ---- 2. Reload: it should come back without touching Overpass ----
    const hitsBeforeReload = overpassHits;
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    const restoredStatus = await waitStatus(page, "restored from cache");
    check("network restored after page refresh", await page.evaluate(() => App.roadNetworkLoaded()));
    check("restore made no Overpass request", overpassHits === hitsBeforeReload,
      "hits " + hitsBeforeReload + " -> " + overpassHits);
    check("fresh (<48h) restore reports age, no re-download nag",
      !!restoredStatus && !restoredStatus.includes("Re-download"), JSON.stringify(restoredStatus));
    check("download extent restored (Travelshed coverage check still works)",
      await page.evaluate(() => !!App.getRoadDownloadExtent()));
    check("walk network layer rendered from restored graph",
      await page.evaluate(() => !!App.map.getLayer("walk-network-line")));
    check("a walkshed computes against the restored graph",
      await page.evaluate(() => {
        const r = App.computeWalkshed([-104.8194, 38.8399], 0.8, {});
        return !!(r && r.polygon && r.reachableCount > 0);
      }));

    // ---- 3. Epoch must advance across the reload (stale-snapshot guard) ----
    const epochAfterRestore = await page.evaluate(() => App.roadNetworkEpoch());
    check("restore bumped the network epoch (walkshed/travelshed caches invalidate)",
      epochAfterRestore > 0,
      "download epoch=" + epochAfterDownload + ", restore epoch=" + epochAfterRestore);

    // ---- 4. Age > 48h should add the re-download nudge ----
    await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open("mat-network-cache");
      req.onsuccess = () => {
        const db = req.result;
        const store = db.transaction("networks", "readwrite").objectStore("networks");
        const all = store.getAll();
        all.onsuccess = () => {
          const rec = all.result[0];
          rec.savedAt = Date.now() - 5 * 24 * 3600 * 1000;
          const put = store.put(rec);
          put.onsuccess = () => { db.close(); resolve(); };
        };
      };
    }));
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 25000 }).catch(() => {});
    const staleStatus = await waitStatus(page, "restored from cache");
    check("stale (>48h) restore tells the user to re-download",
      !!staleStatus && staleStatus.includes("Re-download") && staleStatus.includes("5 days"),
      JSON.stringify(staleStatus));

    // ---- 5. Explicit clear must drop the stored copy (no resurrection) ----
    await page.evaluate(() => App.clearRoadNetwork());
    const countAfterClear = await waitForIdbCount(page, 0);
    check("clearRoadNetwork emptied the store", countAfterClear === 0, "records=" + countAfterClear);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await waitForStatusActivity(page, 1200);
    check("cleared network does not resurrect on refresh",
      !(await page.evaluate(() => App.roadNetworkLoaded())));

    // ---- 5b. Unload keeps the stored copy; a Walkshed run restores it ----
    const GRID = { lat: 38.8339 + 0.006, lng: -104.8214 + 0.006 }; // stub grid centre
    await page.evaluate(({ lat, lng }) => App.map.jumpTo({ center: [lng, lat], zoom: 14 }), GRID);
    await page.waitForFunction("App.map.loaded()", { timeout: 10000 });
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });
    check("grid-area network stored", (await waitForIdbCount(page, 1)) === 1);

    // Sidewalk coverage Remove drops only the overlay, and a routine rebuild
    // (exclusion change) must not bring it back.
    const sw = await page.evaluate(() => {
      const before = !!App.map.getLayer("sidewalk-coverage-line");
      App.removeSidewalkCoverageLayer();
      App.setExcludedWays([]);
      return { before, after: !!App.map.getLayer("sidewalk-coverage-line"), loaded: App.roadNetworkLoaded() };
    });
    check("Sidewalk coverage Remove drops only the overlay", sw.before && !sw.after && sw.loaded, JSON.stringify(sw));

    await page.evaluate(() => App.unloadRoadNetwork());
    check("unload removes the network from analysis", !(await page.evaluate(() => App.roadNetworkLoaded())));
    check("unload removes the walk network layer", !(await page.evaluate(() => !!App.map.getLayer("walk-network-line"))));
    check("unload keeps the IndexedDB entry", (await waitForIdbCount(page, 1)) === 1);

    const hitsBeforeRun = overpassHits;
    await page.evaluate(({ lat, lng }) => App.addPoint(lng, lat), GRID);
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#wsMinutes").fill("15");
    await page.locator("#wsMinutes2").fill("");
    await page.locator("#wsMinutes3").fill("");
    await page.locator("#wsComputeBtn").click();
    const ran = await page.waitForFunction(
      () => { const s = App.map.getSource("walkshed-src"); return s && s._data && s._data.features.length > 0; },
      { timeout: 20000 }
    ).then(() => true, () => false);
    check("walkshed run after unload restores the stored network", await page.evaluate(() => App.roadNetworkLoaded()));
    check("walkshed run after unload produced a walkshed", ran,
      await page.evaluate(() => (document.getElementById("wsStatus") || {}).textContent || ""));
    check("a network load brings the Sidewalk coverage overlay back",
      await page.evaluate(() => !!App.map.getLayer("sidewalk-coverage-line")));
    check("walkshed run after unload made no Overpass request", overpassHits === hitsBeforeRun,
      "hits " + hitsBeforeRun + " -> " + overpassHits);

    // ---- 5c. "Delete downloaded streets" (Layers panel, confirmed) ----
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    await page.locator('#fp-tab-layers button[aria-label="More actions for Walk network"]')
      .waitFor({ state: "attached", timeout: 10000 });
    await page.evaluate(() => {
      document.querySelector('#fp-tab-layers button[aria-label="More actions for Walk network"]').click();
    });
    await page.locator("#fp-context-menu").waitFor({ state: "visible", timeout: 5000 });
    const items = await page.evaluate(() => Array.from(document.querySelectorAll("#fp-context-menu button")).map((b) => b.textContent));
    check("Walk network menu offers Remove layer and Delete downloaded streets",
      items.includes("Remove layer") && items.includes("Delete downloaded streets"), JSON.stringify(items));
    let dialogs = 0;
    const countDialog = () => { dialogs++; };
    page.on("dialog", countDialog);
    await page.evaluate(() => {
      Array.from(document.querySelectorAll("#fp-context-menu button")).find((b) => b.textContent === "Delete downloaded streets").click();
    });
    check("Delete downloaded streets removes the stored copy", (await waitForIdbCount(page, 0)) === 0);
    check("Delete downloaded streets unloads the network", !(await page.evaluate(() => App.roadNetworkLoaded())));
    check("Delete downloaded streets asks for confirmation", dialogs === 1, "dialogs=" + dialogs);
    page.off("dialog", countDialog);

    // ---- 5d. Reset Session empties the store and the street settings ----
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 20000 });
    await waitForIdbCount(page, 1);
    await page.evaluate(() => {
      App.setExcludedWays([1000]);
      App.networkSettings.crossingMajorSec = 30;
      App.networkSettings.crossingMinorSec = 10;
      App.networkSettings.snapToleranceFt = 120;
    });
    await page.click("#reset");
    const afterReset = await waitForIdbCount(page, 0);
    const ns = await page.evaluate(() => JSON.parse(JSON.stringify(App.networkSettings)));
    check("Reset Session empties the network store", afterReset === 0, "records=" + afterReset);
    check("Reset Session unloads the network", !(await page.evaluate(() => App.roadNetworkLoaded())));
    check("Reset Session clears excluded streets", ns.excludedWayIds.length === 0, JSON.stringify(ns));
    check("Reset Session restores crossing and snap defaults",
      ns.crossingMajorSec === 0 && ns.crossingMinorSec === 0 && ns.snapToleranceFt === 50, JSON.stringify(ns));

    // ---- 5e. findCovering: only an extent that contains the request ----
    const cov = await page.evaluate(async () => {
      const mk = (bb, savedAt) => ({
        id: "bbox:" + bb.map((v) => v.toFixed(3)).join(","), savedAt, source: "overpass", label: "", featureCount: 1,
        extent: turf.bboxPolygon(bb), geojson: JSON.stringify({ type: "FeatureCollection", features: [] })
      });
      const t = Date.now();
      await App.networkStore.save(mk([-105.0, 39.0, -104.9, 39.1], t - 3000)); // big, older
      await App.networkStore.save(mk([-104.97, 39.03, -104.93, 39.07], t - 1000)); // small, newer
      await App.networkStore.save({ id: "file:x.geojson", savedAt: t, source: "file", label: "x", featureCount: 1,
        extent: null, geojson: "{}" }); // newest, but no known extent
      const id = async (bb) => { const r = await App.networkStore.findCovering(bb); return r ? r.id : null; };
      const out = {
        inner: await id([-104.96, 39.04, -104.94, 39.06]),
        wide: await id([-104.99, 39.01, -104.91, 39.09]),
        outside: await id([-104.95, 39.05, -104.85, 39.15]),
        feature: await id(turf.bboxPolygon([-104.96, 39.04, -104.94, 39.06]))
      };
      await App.networkStore.clear();
      return out;
    });
    check("findCovering prefers the newest covering entry", cov.inner === "bbox:-104.970,39.030,-104.930,39.070", JSON.stringify(cov));
    check("findCovering skips entries that don't contain the request", cov.wide === "bbox:-105.000,39.000,-104.900,39.100", JSON.stringify(cov));
    check("findCovering returns null when nothing covers", cov.outside === null, JSON.stringify(cov));
    check("findCovering accepts a GeoJSON extent", cov.feature === cov.inner, JSON.stringify(cov));

    // ---- 6. Store hygiene: dedupe by area, cap at MAX_ENTRIES, newest wins ----
    const hygiene = await page.evaluate(async () => {
      const mk = (id, savedAt, n) => ({
        id, savedAt, source: "overpass", label: "", featureCount: n,
        extent: null, geojson: JSON.stringify({ type: "FeatureCollection", features: [] })
      });
      const t = Date.now();
      // Same id written twice must replace, not accumulate.
      await App.networkStore.save(mk("bbox:A", t - 5000, 1));
      await App.networkStore.save(mk("bbox:A", t - 4000, 2));
      const afterDupe = await App.networkStore.latest();
      // Five distinct areas must prune down to MAX_ENTRIES, keeping the newest.
      for (let i = 0; i < 5; i++) await App.networkStore.save(mk("bbox:" + i, t + i * 1000, i));
      const count = await new Promise((resolve) => {
        const r = indexedDB.open("mat-network-cache");
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction("networks", "readonly").objectStore("networks").getAllKeys();
          q.onsuccess = () => { const n = q.result.length; db.close(); resolve(n); };
        };
      });
      const newest = await App.networkStore.latest();
      return { dupeCount: afterDupe.featureCount, count, newestId: newest.id, max: App.networkStore.MAX_ENTRIES };
    });
    check("re-saving the same area replaces its stored copy",
      hygiene.dupeCount === 2, JSON.stringify(hygiene));
    check("store prunes to MAX_ENTRIES, keeping the newest",
      hygiene.count === hygiene.max && hygiene.newestId === "bbox:4", JSON.stringify(hygiene));

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
