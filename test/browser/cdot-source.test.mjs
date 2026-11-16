#!/usr/bin/env node
// test/browser/cdot-source.test.mjs
//
// Behavior test for CDOT road layers as a street source (js/core/cdot-roads.js,
// js/core/cdot-source.js and the CDOT branch in js/core/road-network.js).
// Drives the real app in headless Chromium. Every request to the CDOT host is
// answered from the trimmed real responses in test/fixtures/cdot/, chosen by
// layer id and resultOffset, so the test needs no network. Asserts:
//
//   - CDOT is switched on from the Add Data dialog and remembered per browser
//   - one Calculate press downloads layers 14 and 17 (two pages, one page),
//     makes them the live network with NO Overpass request, and runs
//   - the status texts, App.roadNetworkSource() and the stored "cdot" record
//   - two distant points send one query per point and the gap between them
//     is not reported as covered
//   - an HTTP 503 loads nothing and says so
//   - unchecking the last layer is refused
//   - an FLM tile source stands aside while CDOT is on, and choosing tiles
//     turns CDOT off
//   - switching CDOT off sends the next download to Overpass
//
// USAGE
//   NODE_PATH=/opt/node-tools/node_modules node test/browser/cdot-source.test.mjs
//
// Exits 0 when every check passes, 1 otherwise (same contract as run-golden.mjs).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/cdot-source.test.mjs");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cdot");
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
const PAGES = {
  "14:0": fixture("page14-1.json"),
  "14:3": fixture("page14-2.json"), // page14-1 holds 3 features
  "17:0": fixture("page17-1.json"),
  "7:0": fixture("page7-1.json"),
};
const TILE_FIXTURE_PATH = "/test/fixtures/walk-tiles/fixture-release";
// On WEWATTA ST, the first layer-14 fixture feature.
const POINT = { lng: -105.0074, lat: 39.7497 };
const FAR_POINT = { lng: -104.90, lat: 39.7497 };

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

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
        const out = r.result.map((x) => ({ id: x.id, source: x.source, label: x.label, boxes: x.boxes || null }));
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

async function openCdotDialog(page) {
  const open = await page.evaluate(() => document.getElementById("cdot-popup").style.display !== "none");
  if (open) return;
  await page.click("#add-data-btn");
  await page.click("#ad-cdot-roads");
}

const finishedExpr = "/Calculated|No walksheds produced|could not|failed/i.test(document.getElementById('wsStatusText').textContent)";

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  const base = "http://127.0.0.1:" + port;

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
    let fail14 = false;
    const cdotRequests = [];
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("overpass-api.de")) {
        overpassHits++;
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ elements: [] }) });
        return true;
      }
      if (url.startsWith("https://dtdapps.codot.gov/")) {
        const u = new URL(url);
        const layer = (u.pathname.match(/FeatureServer\/(\d+)\/query/) || [])[1];
        const offset = u.searchParams.get("resultOffset");
        cdotRequests.push({ layer, offset, geometry: u.searchParams.get("geometry") });
        if (fail14 && layer === "14") {
          route.fulfill({ status: 503, contentType: "text/plain", body: "Service Unavailable" });
          return true;
        }
        const body = PAGES[layer + ":" + offset];
        route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: body || JSON.stringify({ type: "FeatureCollection", features: [] }),
        });
        return true;
      }
      return false;
    });
    const count = (layer) => cdotRequests.filter((r) => r.layer === layer).length;

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());

    await page.goto(base + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });

    check("engine and source modules loaded",
      await page.evaluate(() => !!(window.CdotRoads && App.cdotSource && typeof App.loadRoadNetworkFromCdot === "function")));
    check("CDOT is off on a clean first visit", !(await page.evaluate(() => App.cdotSource.isActive())));

    // ---- 1. Switch CDOT on from the dialog ----
    await openCdotDialog(page);
    check("dialog opens from the Add Data menu",
      await page.evaluate(() => document.getElementById("cdot-popup").style.display !== "none"));
    await page.click("#cdotUse");
    check("CDOT becomes the street source", await page.evaluate(() => App.cdotSource.isActive()));
    const ui = await page.evaluate(() => ({
      btn: document.getElementById("cdotUse").textContent,
      info: document.getElementById("cdotInfo").textContent,
      stored: localStorage.getItem("mat-cdot-source"),
    }));
    check("button and info show the active state",
      ui.btn === "Using CDOT — switch back to OpenStreetMap" && ui.info.includes("Layers in use: 14+17") &&
      ui.info.includes("not saved in the session file"), JSON.stringify(ui));
    check("setting remembered for this browser",
      JSON.stringify(JSON.parse(ui.stored || "null")) === JSON.stringify({ active: true, layers: [14, 17] }), String(ui.stored));
    check("status says CDOT will supply streets",
      !!(await waitStatus(page, "CDOT will supply streets for new downloads.")));

    // Unchecking every layer must be refused.
    await page.click("#cdotLayer14");
    await page.click("#cdotLayer17");
    const refused = await page.evaluate(() => ({
      layers: App.cdotSource.layers(),
      c17: document.getElementById("cdotLayer17").checked,
      msg: document.getElementById("cdotLayerMsg").textContent,
      shown: document.getElementById("cdotLayerMsg").style.display !== "none",
    }));
    check("unchecking the last layer is refused",
      JSON.stringify(refused.layers) === "[17]" && refused.c17 && refused.shown && refused.msg === "Choose at least one layer.",
      JSON.stringify(refused));
    await page.click("#cdotLayer14");
    check("layers back to 14+17", await page.evaluate(() => App.cdotSource.layersKey()) === "14+17");
    await page.click("#cdot-popup-close");

    // ---- 2. One Calculate press downloads and runs ----
    await page.evaluate(({ lat, lng }) => App.addPoint(lng, lat), POINT);
    await page.evaluate(() => App.openModulePopup("walkshed"));
    await page.waitForSelector("#wsComputeBtn", { timeout: 10000 });
    await setInput(page, "wsMinutes", "5");
    await setInput(page, "wsMinutes2", "");
    await setInput(page, "wsSpeed", "3.1");
    await page.evaluate(() => { window.__statusLog.length = 0; });
    await page.evaluate(() => document.getElementById("wsComputeBtn").click());
    const loaded = await waitStatus(page, "CDOT road segments loaded");
    check("loaded status names the layers",
      loaded === "7 CDOT road segments loaded (layers 14+17) — local routing enabled", String(loaded));
    check("progress named the second page of layer 14",
      !!(await waitStatus(page, "Downloading CDOT roads… layer 14 page 2", 1000)));
    check("two requests to layer 14, one to layer 17, none to layer 7",
      count("14") === 2 && count("17") === 1 && count("7") === 0, JSON.stringify(cdotRequests));
    check("no Overpass request", overpassHits === 0, "hits=" + overpassHits);
    check("network loaded and tagged as CDOT",
      await page.evaluate(() => App.roadNetworkLoaded() && App.roadNetworkSource() === "cdot" && App.roadNetworkCdotLayers() === "14+17"));
    const ex = await page.evaluate(({ lat, lng }) => {
      const e = App.getRoadDownloadExtent();
      return e ? { contains: turf.booleanPointInPolygon([lng, lat], e), bbox: turf.bbox(e) } : null;
    }, POINT);
    check("download outline contains the point", !!ex && ex.contains, JSON.stringify(ex));
    // Box = walk reach (5 min at 3.1 mph = 0.416 km) plus the 0.5 km snap distance.
    const halfWidthKm = ex ? (ex.bbox[3] - ex.bbox[1]) / 2 * 111.195 : 0;
    check("box radius is walk reach plus snap distance (about 0.92 km)",
      Math.abs(halfWidthKm - 0.916) < 0.02, halfWidthKm.toFixed(3) + " km");
    const done = await waitFor(page, finishedExpr, 30000);
    const wsStatus = await page.evaluate(() => document.getElementById("wsStatusText").textContent);
    check("Walkshed run finished and names CDOT",
      done && wsStatus.includes("Calculated") && wsStatus.includes("Streets: CDOT 14+17."), wsStatus);

    const recs = await waitForStored(page, (r) => r.some((x) => x.source === "cdot"));
    const rec = recs.find((x) => x.source === "cdot");
    check("stored under one slot per layer set, with its box",
      !!rec && rec.id === "cdot:14+17" && rec.label === "14+17" && Array.isArray(rec.boxes) && rec.boxes.length === 1,
      JSON.stringify(recs));

    // ---- 3. Two distant points: one query per point ----
    await page.evaluate(({ lat, lng }) => { App.addPoint(lng, lat); App.notifyProject(); }, FAR_POINT);
    await waitFor(page, "document.querySelectorAll('#wsPointList input[type=checkbox]').length === 2", 10000);
    await page.evaluate(() => {
      for (const cb of document.querySelectorAll("#wsPointList input[type=checkbox]")) {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    const before = cdotRequests.length;
    await page.evaluate(() => { window.__statusLog.length = 0; });
    await page.evaluate(() => document.getElementById("wsComputeBtn").click());
    const twoLoaded = await waitStatus(page, "CDOT road segments loaded");
    const newReqs = cdotRequests.slice(before);
    const areas = new Set(newReqs.map((r) => r.geometry));
    check("two points send two areas per layer (layer 14: 2 pages each, layer 17: 1 each)",
      !!twoLoaded && areas.size === 2 && newReqs.filter((r) => r.layer === "14").length === 4 &&
      newReqs.filter((r) => r.layer === "17").length === 2, JSON.stringify(newReqs));
    check("overlapping answers kept once", twoLoaded === "7 CDOT road segments loaded (layers 14+17) — local routing enabled", String(twoLoaded));
    check("progress names the area", !!(await waitStatus(page, "(area 2 of 2)", 1000)));
    const cover = await page.evaluate(({ a, b }) => ({
      type: App.getRoadDownloadExtent().geometry.type,
      gap: App.roadNetworkCoversExtent(turf.bboxPolygon([-104.955, 39.749, -104.953, 39.751])),
      first: App.roadNetworkCoversExtent(turf.bboxPolygon([a.lng - 0.001, a.lat - 0.001, a.lng + 0.001, a.lat + 0.001])),
      second: App.roadNetworkCoversExtent(turf.bboxPolygon([b.lng - 0.001, b.lat - 0.001, b.lng + 0.001, b.lat + 0.001])),
    }), { a: POINT, b: FAR_POINT });
    check("outline is two rectangles", cover.type === "MultiPolygon", cover.type);
    check("gap between the points is not covered, both points are",
      cover.gap === false && cover.first === true && cover.second === true, JSON.stringify(cover));
    await waitFor(page, finishedExpr, 30000);

    // ---- 4. HTTP 503 loads nothing ----
    fail14 = true;
    const failed = await page.evaluate(async () => {
      App.unloadRoadNetwork();
      const ok = await App.fetchRoadNetworkForExtent(turf.bboxPolygon([-105.01, 39.745, -105.0, 39.752]));
      return { ok, loaded: App.roadNetworkLoaded(), err: App.cdotLastError() };
    });
    check("HTTP 503 is reported and nothing is loaded",
      failed.ok === false && !failed.loaded && failed.err === "CDOT road download failed: layer 14 returned HTTP 503",
      JSON.stringify(failed));
    fail14 = false;

    // ---- 5. FLM tiles stand aside while CDOT is on ----
    const tiles = await page.evaluate(async (url) => {
      const set = await App.walkTilesSource.useUrl(url);
      const afterTiles = { ok: set.ok, cdot: App.cdotSource.isActive(), tiles: App.walkTilesSource.isActive() };
      App.cdotSource.setActive(true);
      App.walkTilesSource.renderInfo();
      return {
        afterTiles,
        cdot: App.cdotSource.isActive(),
        tilesActive: App.walkTilesSource.isActive(),
        tilesHas: App.walkTilesSource.hasSource(),
        info: document.getElementById("wtInfo").textContent,
      };
    }, base + TILE_FIXTURE_PATH);
    check("choosing a tile source turns CDOT off",
      tiles.afterTiles.ok && !tiles.afterTiles.cdot && tiles.afterTiles.tiles, JSON.stringify(tiles.afterTiles));
    check("turning CDOT on pauses tiles without forgetting them",
      tiles.cdot && !tiles.tilesActive && tiles.tilesHas && tiles.info.includes("Paused while CDOT supplies streets"),
      JSON.stringify(tiles).slice(0, 300));
    check("status says the tile source is paused",
      !!(await waitStatus(page, "FLM tile source paused.", 2000)));
    await page.evaluate(() => { App.walkTilesSource.clear(); });

    // ---- 6. CDOT off: the next download goes to Overpass ----
    await openCdotDialog(page);
    await page.click("#cdotUse");
    check("CDOT switched off", !(await page.evaluate(() => App.cdotSource.isActive())));
    check("status says OpenStreetMap will supply streets",
      !!(await waitStatus(page, "OpenStreetMap will supply streets for new downloads.")));
    const reqBefore = cdotRequests.length;
    await page.evaluate(async () => {
      App.unloadRoadNetwork();
      await App.fetchRoadNetworkForExtent(turf.bboxPolygon([-104.80, 39.60, -104.79, 39.61]));
    });
    check("next download went to Overpass, not CDOT",
      overpassHits > 0 && cdotRequests.length === reqBefore, "overpass=" + overpassHits);

    await page.evaluate(async () => { await App.networkStore.clear(); localStorage.removeItem("mat-cdot-source"); });
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer();
  }

  const failedChecks = results.filter((r) => !r.pass);
  console.log("\n" + (failedChecks.length
    ? "FAIL — " + failedChecks.length + "/" + results.length + " checks failed"
    : "PASS — " + results.length + "/" + results.length + " checks passed"));
  process.exit(failedChecks.length ? 1 : 0);
})();
