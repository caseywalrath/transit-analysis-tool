#!/usr/bin/env node
// test/perf/gtfs-baseline.mjs
//
// Baseline measurement for loading a real GTFS ZIP into the real app: parse
// time, time until the map layers exist, longest main-thread freeze, JS heap
// growth and the GTFS share of a session export. Measurement only; it asserts
// nothing about the numbers. See test/perf/README.md.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/perf/gtfs-baseline.mjs <feed.zip> [--runs N]

import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "../browser/harness.mjs";

const USAGE = "Usage: NODE_PATH=/opt/node-tools/node_modules node test/perf/gtfs-baseline.mjs <path-to-feed.zip> [--runs N]";
const RUN_TIMEOUT_MS = 600000;
const MAP_TIMEOUT_MS = 300000;
const MB = 1024 * 1024;

const args = process.argv.slice(2);
let feedArg = null;
let runCount = 1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--runs") runCount = parseInt(args[++i], 10);
  else if (!feedArg) feedArg = args[i];
}
let zipBytes = null;
let feedPath = null;
try {
  if (!feedArg || !(runCount >= 1)) throw new Error("bad arguments");
  feedPath = resolve(feedArg);
  zipBytes = readFileSync(feedPath);
} catch (e) {
  console.error(USAGE);
  process.exit(2);
}
const feedName = basename(feedPath);
const zipSize = statSync(feedPath).size;

const { chromium } = loadPlaywright("test/perf/gtfs-baseline.mjs");

const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

async function heapMB(page, cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return usedSize / MB;
}

async function oneRun(browser, port) {
  const run = {
    parseMs: null, toMapMs: null, longestFreezeMs: null, longTaskCount: null, totalLongTaskMs: null,
    heapBeforeMB: null, heapAfterMB: null, heapDeltaMB: null, gtfsSessionChars: null, ok: false
  };
  // Fresh context per run so IndexedDB and caches never carry over.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    await context.addInitScript(() => {
      window.__statusLog = [];
      window.__longTasks = [];
      window.__longTaskSupported = false;
      try {
        new PerformanceObserver((list) => {
          list.getEntries().forEach((e) => window.__longTasks.push(e.duration));
        }).observe({ type: "longtask", buffered: true });
        window.__longTaskSupported = true;
      } catch (e) { /* longtask API unsupported */ }
    });
    const feedUrl = "http://127.0.0.1:" + port + "/__perf/feed.zip";
    await routeVendoredAssets(context, port, async (route, url) => {
      if (url !== feedUrl) return false;
      await route.fulfill({ status: 200, contentType: "application/zip", body: zipBytes });
      return true;
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    let crashed = null;
    page.on("crash", () => { crashed = "page crashed"; });

    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    const cdp = await context.newCDPSession(page);
    run.heapBeforeMB = await heapMB(page, cdp);

    const work = page.evaluate(async ({ url, name, mapTimeout }) => {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], name, { type: "application/zip" });
      window.__longTasks.length = 0;
      const t0 = performance.now();
      const result = await App.loadGTFSFile(file);
      const t1 = performance.now();
      const layersUp = () => !!(App.map.getLayer("gtfs-shapes-layer") || App.map.getLayer("gtfs-stops-layer")) && App.map.loaded();
      let t2 = null;
      while (performance.now() - t1 < mapTimeout) {
        if (layersUp()) { t2 = performance.now(); break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { result, parseMs: t1 - t0, toMapMs: t2 == null ? null : t2 - t0 };
    }, { url: feedUrl, name: feedName, mapTimeout: MAP_TIMEOUT_MS });
    work.catch(() => {}); // avoid an unhandled rejection if the timeout wins

    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("run timed out after " + RUN_TIMEOUT_MS / 1000 + " s")), RUN_TIMEOUT_MS); });
    let timing;
    try {
      timing = await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
    run.parseMs = round(timing.parseMs);
    run.toMapMs = round(timing.toMapMs);
    run.loadReturned = timing.result;

    // Let trailing long tasks (layer build, deferred IndexedDB write) land.
    await page.waitForTimeout(500);
    const lt = await page.evaluate(() => ({ supported: window.__longTaskSupported, durations: window.__longTasks.slice() }));
    if (lt.supported) {
      run.longTaskCount = lt.durations.length;
      run.longestFreezeMs = round(lt.durations.length ? Math.max(...lt.durations) : 0);
      run.totalLongTaskMs = round(lt.durations.reduce((a, b) => a + b, 0));
    }

    run.heapAfterMB = await heapMB(page, cdp);
    run.heapDeltaMB = round(run.heapAfterMB - run.heapBeforeMB);
    run.heapBeforeMB = round(run.heapBeforeMB);
    run.heapAfterMB = round(run.heapAfterMB);

    try {
      run.gtfsSessionChars = await page.evaluate(() => JSON.stringify({ gtfsData: App.serializeGTFSData() }).length);
    } catch (e) {
      run.gtfsSessionChars = null;
      run.sessionNote = "serializeGTFSData/stringify failed: " + String(e.message || e).slice(0, 200);
    }

    run.counts = await page.evaluate(() => {
      try {
        const d = App.serializeGTFSData() || {};
        const rows = (n) => (d[n] && d[n].rows ? d[n].rows.length : null);
        return { stops: rows("stops.txt"), trips: rows("trips.txt"), stop_times: rows("stop_times.txt"), shapes: rows("shapes.txt") };
      } catch (e) { return null; }
    });

    run.pageErrors = pageErrors.length;
    if (pageErrors.length) run.pageErrorSample = pageErrors[0].slice(0, 200);
    run.ok = timing.result === true && timing.toMapMs != null && !crashed;
    if (crashed) run.error = crashed;
  } catch (e) {
    run.error = String(e && e.message || e).slice(0, 300);
    run.ok = false;
  } finally {
    await context.close().catch(() => {});
  }
  return run;
}

(async () => {
  const { port, stop } = await startStaticServer();
  let browser;
  const runs = [];
  try {
    browser = await launchBrowser(chromium);
    for (let i = 0; i < runCount; i++) {
      console.log("--- run " + (i + 1) + "/" + runCount + " ---");
      const r = await oneRun(browser, port);
      runs.push(r);
      console.log("loadGTFSFile returned: " + r.loadReturned);
      console.log("parse (load promise):  " + r.parseMs + " ms");
      console.log("to map (layers+idle):  " + r.toMapMs + " ms");
      console.log("longest freeze:        " + r.longestFreezeMs + " ms (" + r.longTaskCount + " long tasks, " + r.totalLongTaskMs + " ms total)");
      console.log("JS heap before/after:  " + r.heapBeforeMB + " / " + r.heapAfterMB + " MB (delta " + r.heapDeltaMB + " MB)");
      console.log("GTFS part of session export: " + r.gtfsSessionChars + " chars" + (r.sessionNote ? " (" + r.sessionNote + ")" : ""));
      console.log("page errors: " + r.pageErrors + (r.pageErrorSample ? " e.g. " + r.pageErrorSample : ""));
      if (r.counts) console.log("rows: " + JSON.stringify(r.counts));
      if (r.error) console.log("error: " + r.error);
      console.log("feed: " + feedName + ", " + zipSize + " bytes, ok=" + r.ok);
    }
  } catch (e) {
    console.log("fatal: " + (e && e.message || e));
    runs.push({ ok: false, error: String(e && e.message || e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    stop();
  }
  console.log("RESULT " + JSON.stringify({ feed: feedName, zipBytes: zipSize, runs }));
  process.exit(runs.length && runs.every((r) => r.ok) ? 0 : 1);
})();
