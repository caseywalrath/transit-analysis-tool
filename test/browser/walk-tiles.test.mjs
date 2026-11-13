#!/usr/bin/env node
// test/browser/walk-tiles.test.mjs
//
// Behavior test for FLM walk tiles as a street source (js/core/walk-tiles.js,
// js/core/walk-tiles-source.js and the tile branch in js/core/road-network.js).
// Drives the real app in headless Chromium against the hand-written fixture
// release in test/fixtures/walk-tiles/fixture-release/ and asserts:
//
//   - the source is configured through the Add Data dialog by URL
//   - a Walkshed run reads the tiles for its area by itself and makes them
//     the live network with NO Overpass request
//   - the recorded extent is the rectangle of requested cells (so the modules'
//     coverage checks pass) and the run's status names the tile release
//   - the tile network is stored as a "walk-tiles" record
//   - an extent with no tile reports "Outside the prepared FLM area" and
//     leaves the live network alone
//   - while the source is active, a stored Overpass network never silently
//     replaces it
//   - forgetting the source brings back "Download streets for this area"
//   - the URL setting survives a page refresh
//   - an unreadable tile fails the whole load (never an empty cell)
//
// USAGE
//   NODE_PATH=/opt/node-tools/node_modules node test/browser/walk-tiles.test.mjs
//
// Exits 0 when every check passes, 1 otherwise (same contract as run-golden.mjs).

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/walk-tiles.test.mjs");

const FIXTURE_PATH = "/test/fixtures/walk-tiles/fixture-release";
// On fixture segment A, in cell 7499_12975. A 5-minute walk at 2.8 mph reaches
// about 0.0044 degrees of longitude, so the required extent crosses the
// -105.00 cell edge and both fixture tiles are needed.
const POINT = { lng: -105.003, lat: 39.755 };

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

async function waitFor(page, expr, timeout = 20000) {
  try {
    await page.waitForFunction(expr, { timeout });
    return true;
  } catch (e) {
    return false;
  }
}

async function storedRecords(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("mat-network-cache");
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("networks")) { db.close(); return resolve([]); }
      const r = db.transaction("networks", "readonly").objectStore("networks").getAll();
      r.onsuccess = () => {
        const out = r.result.map((x) => ({ id: x.id, source: x.source, label: x.label }));
        db.close();
        resolve(out);
      };
      r.onerror = () => { db.close(); resolve([]); };
    };
    req.onerror = () => resolve([]);
  }));
}

async function waitForStored(page, pred, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = [];
  while (Date.now() < deadline) {
    last = await storedRecords(page);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

async function setInput(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { id, value });
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  const base = "http://127.0.0.1:" + port;
  const fixtureUrl = base + FIXTURE_PATH;

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

    let overpassHits = 0;
    let breakTile = false;
    const tileRequests = [];
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("overpass-api.de")) {
        overpassHits++;
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ elements: [] }) });
        return true;
      }
      if (url.includes(FIXTURE_PATH + "/network/")) {
        tileRequests.push(url);
        if (breakTile && url.endsWith("/network/7500_12975.json")) {
          route.fulfill({ status: 200, contentType: "application/json", body: "{ this is not JSON" });
          return true;
        }
      }
      return false;
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());

    await page.goto(base + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });

    check("engine and source modules loaded",
      await page.evaluate(() => !!(window.WalkTiles && App.walkTilesSource && typeof App.loadRoadNetworkFromTiles === "function")));
    check("no tile source on a clean first visit", !(await page.evaluate(() => App.walkTilesSource.isActive())));

    // ---- 1. Configure the source by URL through the Add Data dialog ----
    await page.click("#add-data-btn");
    await page.click("#ad-walk-tiles");
    check("dialog opens from the Add Data menu",
      await page.evaluate(() => document.getElementById("walk-tiles-popup").style.display !== "none"));
    await page.fill("#wtUrl", fixtureUrl + "/");
    await page.click("#wtUseUrl");
    const active = await waitFor(page, "App.walkTilesSource.isActive()");
    check("URL source becomes active", active, await page.evaluate(() => App.walkTilesSource.releaseId()));
    const info = await page.evaluate(() => document.getElementById("wtInfo").textContent);
    check("dialog shows the release details",
      info.includes("fixture-release") && info.includes("-105.006") && info.includes("Hand-written test fixture"), info.slice(0, 160));
    const stored = await page.evaluate(() => localStorage.getItem("mat-walk-tiles-source"));
    check("URL remembered for this browser", stored === JSON.stringify({ kind: "url", url: fixtureUrl }), String(stored));
    // A failed attempt must stay readable in the dialog (the status line clears
    // itself) and must leave the working source in place.
    await page.fill("#wtUrl", base + "/test/fixtures");
    await page.click("#wtUseUrl");
    await waitFor(page, "document.getElementById('wtInfo').textContent.includes('Could not read manifest.json')", 10000);
    const failInfo = await page.evaluate(() => document.getElementById("wtInfo").textContent);
    check("a failed attempt is shown in the dialog and keeps the working source",
      failInfo.includes("Could not read manifest.json") && failInfo.includes("fixture-release") &&
      await page.evaluate(() => App.walkTilesSource.isActive()), failInfo.slice(0, 120));

    await page.click("#walk-tiles-popup-close");
    check("dialog closes",
      await page.evaluate(() => document.getElementById("walk-tiles-popup").style.display === "none"));

    // ---- 2. Walkshed offers tiles instead of a download ----
    await page.evaluate(({ lat, lng }) => App.addPoint(lng, lat), POINT);
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.waitForSelector("#wsComputeBtn", { timeout: 10000 });
    await setInput(page, "wsMinutes", "5");
    await setInput(page, "wsMinutes2", "");
    await setInput(page, "wsSpeed", "2.8");
    // With a source set, Calculate reads the tiles itself: no second button.
    await page.locator("#wsComputeBtn").click();
    const loadedStatus = await waitStatus(page, "FLM tile segments loaded");
    check("tiles loaded status",
      loadedStatus === "3 FLM tile segments loaded from 2 tiles (fixture-release) — local routing enabled", String(loadedStatus));
    check("network is loaded", await page.evaluate(() => App.roadNetworkLoaded()));
    check("no Overpass request was made", overpassHits === 0, "hits=" + overpassHits);
    check("each needed tile was requested once", tileRequests.length === 2, tileRequests.join(" "));
    check("live network is tagged with the tile release",
      await page.evaluate(() => App.roadNetworkTileRelease()) === "fixture-release");

    const extent = await page.evaluate(({ lat, lng }) => {
      const ex = App.getRoadDownloadExtent();
      return ex ? { bbox: turf.bbox(ex), contains: turf.booleanPointInPolygon([lng, lat], ex) } : null;
    }, POINT);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    check("recorded extent is the rectangle of requested cells and contains the point",
      !!extent && extent.contains && near(extent.bbox[0], -105.01) && near(extent.bbox[1], 39.75) &&
      near(extent.bbox[2], -104.99) && near(extent.bbox[3], 39.76), JSON.stringify(extent));

    // The run restarts by itself after the load; wait for it to finish.
    const finished = await waitFor(page,
      "/Calculated|No walksheds produced/.test(document.getElementById('wsStatusText').textContent)", 30000);
    const wsStatus = await page.evaluate(() => document.getElementById("wsStatusText").textContent);
    check("Walkshed run finished on the tile network and names the source",
      finished && wsStatus.includes("Calculated") && wsStatus.includes("Streets: FLM tiles fixture-release.") &&
      wsStatus.includes("outside the prepared FLM area"), wsStatus);

    // The fixture's prepared area is a single line of latitude, so any walk
    // budget reaches past it: the panel must say results may be clipped.
    const edgeWarn = await page.evaluate(() => {
      const el = document.getElementById("wsCoverageWarn");
      return el.style.display === "none" ? "" : el.textContent;
    });
    check("panel warns when the walk budget reaches past the prepared area",
      edgeWarn.includes("outside the prepared FLM area"), edgeWarn);

    const recs = await waitForStored(page, (r) => r.some((x) => x.source === "walk-tiles"));
    const tileRec = recs.find((x) => x.source === "walk-tiles");
    check("tile network stored as a walk-tiles record with an area id",
      !!tileRec && tileRec.label === "fixture-release" && tileRec.id.indexOf("bbox:") === 0, JSON.stringify(recs));

    // ---- 3. An extent with no tile ----
    const outside = await page.evaluate(async () => {
      const ok = await App.fetchRoadNetworkForExtent(turf.bboxPolygon([-100.005, 40.002, -100.002, 40.005]));
      return { ok, loaded: App.roadNetworkLoaded(), rel: App.roadNetworkTileRelease(), err: App.walkTilesLastError() };
    });
    check("extent outside the release reports the prepared area",
      outside.ok === false &&
      outside.err === "Outside the prepared FLM area (fixture-release). Prepared area: -105.006, 39.755 to -104.994, 39.755.",
      JSON.stringify(outside));
    check("a failed tile load leaves the live network alone", outside.loaded && outside.rel === "fixture-release");

    // ---- 4. Area restore while the source is active ----
    const restoreTile = await page.evaluate(async () => {
      App.unloadRoadNetwork();
      const ok = await App.restoreNetworkCovering(turf.bboxPolygon([-105.004, 39.754, -105.002, 39.756]));
      return { ok, rel: App.roadNetworkTileRelease() };
    });
    check("a stored tile network of the active release restores by area",
      restoreTile.ok === true && restoreTile.rel === "fixture-release", JSON.stringify(restoreTile));

    const guard = await page.evaluate(async () => {
      App.unloadRoadNetwork();
      const bb = [-105.02, 39.74, -104.98, 39.77];
      await App.networkStore.save({
        id: "bbox:" + bb.map((v) => v.toFixed(3)).join(","), savedAt: Date.now() + 1000, source: "overpass", label: "",
        featureCount: 1, extent: turf.bboxPolygon(bb),
        geojson: JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature",
          properties: { highway: "residential" },
          geometry: { type: "LineString", coordinates: [[-105.004, 39.755], [-105.002, 39.755]] } }] })
      });
      const need = turf.bboxPolygon([-105.004, 39.754, -105.002, 39.756]);
      const whileActive = await App.restoreNetworkCovering(need);
      const loadedWhileActive = App.roadNetworkLoaded();
      return { whileActive, loadedWhileActive };
    });
    check("a newer stored Overpass network does not replace the tile source",
      guard.whileActive === false && guard.loadedWhileActive === false, JSON.stringify(guard));

    // ---- 5. Forget the source ----
    await page.evaluate(() => { window.__statusLog.length = 0; App.walkTilesSource.clear(); });
    const forgot = await waitStatus(page, "FLM tile source forgotten", 5000);
    check("forgetting the source says loaded streets stay",
      forgot === "FLM tile source forgotten. Loaded streets stay until replaced.", String(forgot));
    check("source inactive and setting removed", await page.evaluate(() =>
      !App.walkTilesSource.isActive() && localStorage.getItem("mat-walk-tiles-source") === null));

    const afterForget = await page.evaluate(async () => {
      const ok = await App.restoreNetworkCovering(turf.bboxPolygon([-105.004, 39.754, -105.002, 39.756]));
      const rel = App.roadNetworkTileRelease();
      App.unloadRoadNetwork();
      await App.networkStore.clear();
      return { ok, rel };
    });
    check("with no source, the stored Overpass network restores and is not tagged as tiles",
      afterForget.ok === true && afterForget.rel === "", JSON.stringify(afterForget));

    // The inputs collapsed after the successful run, so the button is not
    // visible to a real click; the handler is what is under test here.
    await page.evaluate(() => document.getElementById("wsComputeBtn").click());
    await waitFor(page, "document.getElementById('wsDownloadBtn').style.display !== 'none'", 10000);
    const btnAfter = await page.evaluate(() => {
      const b = document.getElementById("wsDownloadBtn");
      return { shown: b.style.display !== "none", text: b.textContent.trim() };
    });
    check("after forgetting and unloading, Walkshed offers a download again",
      btnAfter.shown && btnAfter.text === "Download streets for this area", JSON.stringify(btnAfter));
    check("still no Overpass request", overpassHits === 0, "hits=" + overpassHits);

    // ---- 6. The URL setting survives a refresh ----
    const again = await page.evaluate((u) => App.walkTilesSource.useUrl(u), fixtureUrl);
    check("source can be set again", again && again.ok === true, JSON.stringify(again));
    check("a button already on screen is relabelled when the source changes",
      await page.evaluate(() => document.getElementById("wsDownloadBtn").textContent.trim()) === "Load FLM tiles for this area");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    check("URL source restored after page refresh",
      await waitFor(page, "App.walkTilesSource.isActive() && App.walkTilesSource.releaseId() === 'fixture-release'", 10000));

    // ---- 7. An unreadable tile fails the whole load ----
    breakTile = true;
    const broken = await page.evaluate(async () => {
      const ok = await App.fetchRoadNetworkForExtent(turf.bboxPolygon([-105.007, 39.752, -104.998, 39.758]));
      return { ok, loaded: App.roadNetworkLoaded(), err: App.walkTilesLastError() };
    });
    breakTile = false;
    check("an unreadable tile is a load failure, not an empty cell",
      broken.ok === false && broken.loaded === false &&
      broken.err.indexOf("FLM tile network/7500_12975.json could not be read: ") === 0, JSON.stringify(broken));

    // ---- 8. A remembered address that cannot be read is said on screen ----
    const badUrl = base + "/test/fixtures/no-such-release";
    await page.evaluate((u) => localStorage.setItem("mat-walk-tiles-source", JSON.stringify({ kind: "url", url: u })), badUrl);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    const unreadable = await waitStatus(page, "FLM tile address could not be read", 10000);
    check("an unreadable remembered address is reported at startup",
      !!unreadable && unreadable.includes(badUrl) && !(await page.evaluate(() => App.walkTilesSource.isActive())), String(unreadable));
    await page.click("#add-data-btn");
    await page.click("#ad-walk-tiles");
    check("the dialog offers the remembered address back for a retry",
      await page.evaluate(() => document.getElementById("wtUrl").value) === badUrl);

    await page.evaluate(async () => { App.walkTilesSource.clear(); await App.networkStore.clear(); });

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
