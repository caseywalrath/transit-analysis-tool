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
//
// WHY THIS HARNESS EXISTS
// The golden harness (test/run-golden.mjs) pins pure math only, by design, and
// test/ui-screens/capture.mjs compares pixels. Neither can see a wrong runtime
// behavior in the browser. This file was written after an IndexedDB transaction
// went inactive under page-startup load and made the cache silently return "no
// stored network" — a bug invisible to both existing harnesses.
//
// KNOWN DUPLICATION — see docs/browser-test-harness-plan.md
// The static-server / vendored-CDN / Chromium-resolution plumbing below is
// copied from test/ui-screens/capture.mjs. It is duplicated on purpose for now
// so the proven test could land; Phase 1 of that plan extracts it into a shared
// test/browser/harness.mjs that both files import. Until then, a CDN version
// bump has to be made in BOTH this file's VENDOR_MAP and capture.mjs's.
//
// USAGE (same NODE_PATH dance as capture.mjs — this repo has no npm install)
//   mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null
//   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
//   NODE_PATH=/tmp/pw-install/node_modules node test/browser/network-cache.test.mjs
//
// Exits 0 when every check passes, 1 otherwise (same contract as run-golden.mjs).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const VENDOR_DIR = join(REPO_ROOT, "test", "ui-screens", "vendor");

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch (e) {
  console.error("Could not load the 'playwright' package (" + e.message + ").");
  console.error("Install it once outside the repo and point NODE_PATH at it:");
  console.error("  mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null");
  console.error("  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright");
  console.error("  NODE_PATH=/tmp/pw-install/node_modules node test/browser/network-cache.test.mjs");
  process.exit(1);
}
const { chromium } = playwright;

const CHROMIUM_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  "/opt/pw-browsers/chromium"
].filter(Boolean);

function resolveExecutablePath() {
  for (const p of CHROMIUM_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's own managed browser
}

// Pinned CDN assets, served from test/ui-screens/vendor so the run works with
// no network access. Must stay in sync with capture.mjs's copy until Phase 1.
const VENDOR_MAP = new Map([
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js", { file: "maplibre-gl.js", type: "application/javascript" }],
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css", { file: "maplibre-gl.css", type: "text/css" }],
  ["https://unpkg.com/@turf/turf@6.5.0/turf.min.js", { file: "turf.min.js", type: "application/javascript" }],
  ["https://unpkg.com/pako@2.1.0/dist/pako.min.js", { file: "pako.min.js", type: "application/javascript" }],
  ["https://unpkg.com/papaparse@5.4.1/papaparse.min.js", { file: "papaparse.min.js", type: "application/javascript" }],
  ["https://unpkg.com/jszip@3.10.1/dist/jszip.min.js", { file: "jszip.min.js", type: "application/javascript" }],
  ["https://unpkg.com/shapefile@0.6.6/dist/shapefile.js", { file: "shapefile.js", type: "application/javascript" }]
]);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function waitForHttpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const req = http.get({ host: "127.0.0.1", port, path: "/index.html", timeout: 1000 }, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("static server never became ready on port " + port));
        setTimeout(attempt, 100);
      });
      req.on("timeout", () => req.destroy());
    })();
  });
}

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
// miss a message entirely. An init script records every status change into
// window.__statusLog instead; this reads that history.
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

(async () => {
  const port = await findFreePort();
  const pythonExecutable = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const server = spawn(pythonExecutable, ["-m", "http.server", String(port)], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "ignore"]
  });

  let browser;
  try {
    await waitForHttpReady(port, 10000);
    browser = await chromium.launch({
      executablePath: resolveExecutablePath(),
      headless: true,
      args: ["--no-sandbox"]
    });

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
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.includes("overpass-api.de")) {
        overpassHits++;
        return route.fulfill({ status: 200, contentType: "application/json", body: overpassPayload() });
      }
      const v = VENDOR_MAP.get(url);
      if (v) return route.fulfill({ status: 200, contentType: v.type, body: readFileSync(join(VENDOR_DIR, v.file)) });
      if (url.startsWith("http://127.0.0.1:" + port + "/") || url.startsWith("http://localhost:" + port + "/")) {
        return route.continue();
      }
      return route.abort();
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

    // persistNetwork defers via setTimeout(0) then writes async.
    await page.waitForTimeout(1500);
    check("network written to IndexedDB", (await idbCount(page)) === 1, "records=" + (await idbCount(page)));

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
    await page.waitForTimeout(800);
    check("clearRoadNetwork emptied the store", (await idbCount(page)) === 0,
      "records=" + (await idbCount(page)));
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForTimeout(1200);
    check("cleared network does not resurrect on refresh",
      !(await page.evaluate(() => App.roadNetworkLoaded())));

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
    server.kill();
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + (failed.length
    ? "FAIL — " + failed.length + "/" + results.length + " checks failed"
    : "PASS — " + results.length + "/" + results.length + " checks passed"));
  process.exit(failed.length ? 1 : 0);
})();
