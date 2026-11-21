#!/usr/bin/env node
// test/browser/gtfs-schedule.test.mjs
//
// Behavior test for the GTFS schedule store and the "day to analyze" setting
// (js/core/gtfs-schedule.js + js/projects/gtfs.js), against the real app in
// headless Chromium:
//
//   - the mini fixture loads into a schedule store with the expected busiest
//     weekday, day summary, date listener and date controls in the GTFS panel
//   - the stop_times viewer shows the columns the app keeps and the fixture's
//     row count (stop_times is columnar, so this path differs from other files)
//   - feed and chosen day survive a refresh (IndexedDB + session autosave)
//   - the session ZIP round trip, the legacy parsed-tables format, and the real
//     importFullState path all rebuild the same schedule
//   - a synthetic feed (test/perf/make-synthetic-feed.mjs) loads without
//     freezing the page and answers schedule queries
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see
// test/browser/README.md (NODE_PATH points at a Playwright install).

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-schedule.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const MINI_DIR = join(REPO_ROOT, "test", "fixtures", "gtfs", "mini");
const MINI_FILES = ["agency", "calendar", "calendar_dates", "frequencies", "routes", "shapes", "stop_times", "stops", "trips"]
  .map((n) => n + ".txt");
const mini = {};
MINI_FILES.forEach((f) => { mini[f] = readFileSync(join(MINI_DIR, f), "utf8"); });
const stopTimesRows = mini["stop_times.txt"].split(/\r?\n/).slice(1).filter((l) => l.trim() !== "").length;

const tmpDir = mkdtempSync(join(tmpdir(), "gtfs-sched-"));
const synthPath = join(tmpDir, "synth.zip");
const gen = spawnSync(process.execPath,
  [join(REPO_ROOT, "test", "perf", "make-synthetic-feed.mjs"), synthPath, "--scale", "0.25"], { encoding: "utf8" });
if (gen.status !== 0) {
  console.error("synthetic feed generation failed: " + (gen.stderr || gen.stdout));
  process.exit(2);
}
const synthBytes = readFileSync(synthPath);

async function newPage(browser, port, extraHandler) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await routeVendoredAssets(context, port, extraHandler || (() => false));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  return { context, page, errors };
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  const feedUrl = "http://127.0.0.1:" + port + "/__perf/feed.zip";
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const url = "http://127.0.0.1:" + port + "/index.html";
    const { page, errors } = await newPage(browser, port, async (route, u) => {
      if (u !== feedUrl) return false;
      await route.fulfill({ status: 200, contentType: "application/zip", body: synthBytes });
      return true;
    });
    const ready = () => page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });

    await page.goto(url, { waitUntil: "load" });
    await ready();
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    // ---- Mini feed ----
    const loaded = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      window.__zipSize = blob.size;
      return App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
    }, mini);
    check("1. mini feed loads and the schedule store exists",
      loaded === true && await page.evaluate(() => App.gtfsSchedule() !== null));

    const sum = (date) => page.evaluate((d) => {
      const s = GtfsSchedule.routeDaySummary(App.gtfsSchedule(), d).total;
      return { trips: s.trips, runningSec: s.runningSec };
    }, date);

    const def = await page.evaluate(() => App.gtfsAnalysisDate.get());
    check("2. default day is the busiest weekday", def === "20260130", "got " + def);

    const s12 = await sum("20260112");
    check("3. Mon 2026-01-12 summary: 25 trips, 26640 running seconds",
      s12.trips === 25 && s12.runningSec === 26640, JSON.stringify(s12));

    const dateCh = await page.evaluate(() => {
      window.__dateCalls = [];
      App.gtfsAnalysisDate.onChange((d) => window.__dateCalls.push(d));
      const ok = App.gtfsAnalysisDate.set("20260112");
      return { ok, now: App.gtfsAnalysisDate.get(), calls: window.__dateCalls.slice(), bad: App.gtfsAnalysisDate.set("bad") };
    });
    check("4. set() changes the day, notifies once, rejects bad input",
      dateCh.ok === true && dateCh.now === "20260112" && dateCh.calls.length === 1 &&
      dateCh.calls[0] === "20260112" && dateCh.bad === false, JSON.stringify(dateCh));

    await page.evaluate(() => App.openModulePopup("gtfs"));
    await page.locator("#gtfsDateControls").waitFor({ state: "visible", timeout: 10000 });
    const ctl = await page.evaluate(() => ({
      value: document.getElementById("gtfsAnalysisDate").value,
      min: document.getElementById("gtfsAnalysisDate").min,
      max: document.getElementById("gtfsAnalysisDate").max,
      desc: document.getElementById("gtfsAnalysisDateDesc").textContent
    }));
    check("5. date controls show the day, the feed range and a trip count",
      ctl.value === "2026-01-12" && ctl.min === "2026-01-05" && ctl.max === "2026-02-01" && ctl.desc.includes("25 trips"),
      JSON.stringify(ctl));

    await page.locator("#gtfsAnalysisDate").fill("2026-01-19");
    await page.locator("#gtfsAnalysisDate").dispatchEvent("change");
    const afterInput = await page.evaluate(() => ({
      d: App.gtfsAnalysisDate.get(), desc: document.getElementById("gtfsAnalysisDateDesc").textContent
    }));
    check("6. changing the date input updates the day and flags special service",
      afterInput.d === "20260119" && afterInput.desc.includes("special service"), JSON.stringify(afterInput));

    await page.locator("#gtfsFileList .gtfs-file-item", { hasText: "stop_times.txt" }).click();
    const tbl = await page.evaluate(() => ({
      heads: Array.from(document.querySelectorAll("#gtfsTableHead th")).map((th) => th.textContent).join(", "),
      meta: document.getElementById("gtfsTableMeta").textContent
    }));
    check("7. stop_times viewer shows the kept columns and the fixture row count",
      tbl.heads === "trip_id, arrival_time, departure_time, stop_id, stop_sequence, timepoint" &&
      tbl.meta.startsWith(stopTimesRows + " rows"), "fixture rows " + stopTimesRows + "; " + JSON.stringify(tbl));

    // The session autosave is debounced; wait until it has written the date.
    await page.waitForFunction(() => (localStorage.getItem("mat-session") || "").includes('"analysisDate":"20260119"'),
      null, { timeout: 10000 });
    await page.reload({ waitUntil: "load" });
    await ready();
    await page.waitForFunction("App.gtfsSchedule() !== null", { timeout: 15000 });
    check("8. after refresh the feed and the chosen day come back",
      await page.evaluate(() => App.gtfsAnalysisDate.get()) === "20260119");

    const zipInfo = await page.evaluate(async () => {
      const p = await App.serializeGTFSZip();
      return p ? { name: p.name, len: p.base64.length, zip: window.__zipSize } : null;
    });
    // __zipSize is lost on reload; the stored copy is the same ZIP, so measure it from the payload instead.
    const payloadOk = await page.evaluate(async () => {
      const p = await App.serializeGTFSZip();
      if (!p || !p.base64.length) return { ok: false };
      const bytes = Math.floor(p.base64.length * 3 / 4);
      window.__payload = p;
      return { ok: true, bytes, len: p.base64.length };
    });
    // Reference size: rebuild the same ZIP in the page and compare.
    const refSize = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      return (await zip.generateAsync({ type: "blob" })).size;
    }, mini);
    const bound = 2 * refSize * 4 / 3 + 1000;
    const clearedOk = await page.evaluate(() => { App.clearGTFS(); return App.gtfsSchedule() === null; });
    const restored = await page.evaluate(async () => App.restoreGTFSFromZip(window.__payload));
    const s12b = await sum("20260112");
    check("9. session ZIP round trip: payload size is sane and the feed restores",
      !!zipInfo && zipInfo.name === "mini.zip" && payloadOk.ok && payloadOk.len < bound &&
      clearedOk && restored === true && s12b.trips === 25,
      "base64 " + payloadOk.len + " chars, bound " + Math.round(bound) + ", restored " + restored + ", trips " + s12b.trips);

    const legacy = await page.evaluate(async () => {
      const data = App.serializeGTFSData();
      App.clearGTFS();
      const cleared = App.gtfsSchedule() === null;
      App.restoreGTFSFromData(data);
      const f = App.gtfsSchedule();
      if (!f) return { cleared, feed: false };
      return {
        cleared, feed: true,
        trips: GtfsSchedule.routeDaySummary(f, "20260112").total.trips,
        s1: GtfsSchedule.departuresAtStop(f, "20260112", "S1").length
      };
    });
    check("10. legacy parsed-tables session format restores the schedule",
      legacy.cleared && legacy.feed && legacy.trips === 25 && legacy.s1 === 21, JSON.stringify(legacy));

    // ---- Real import path (a session file carrying gtfsZip) ----
    // A feed restored from legacy tables has no ZIP to keep, so reload from the ZIP payload first.
    const imported = await page.evaluate(async () => {
      await App.restoreGTFSFromZip(window.__payload);
      App.gtfsAnalysisDate.set("20260112");
      const state = App.cache.collectState("full");
      state.exportType = "full-state";
      state.gtfsZip = await App.serializeGTFSZip();
      const json = JSON.stringify(state);
      App.clearGTFS();
      App.cache.importFullState(new File([json], "session.json", { type: "application/json" }));
      return true;
    });
    await page.waitForFunction("App.gtfsSchedule() !== null", { timeout: 15000 });
    const imp = await page.evaluate(() => ({
      trips: GtfsSchedule.routeDaySummary(App.gtfsSchedule(), "20260112").total.trips,
      date: App.gtfsAnalysisDate.get()
    }));
    check("11. importFullState restores the feed and the day from a session file",
      imported && imp.trips === 25 && imp.date === "20260112", JSON.stringify(imp));

    const clr = await page.evaluate(() => {
      const calls = [];
      const off = App.gtfsAnalysisDate.onChange((d) => calls.push(d));
      App.clearGTFS();
      off();
      return { sched: App.gtfsSchedule(), date: App.gtfsAnalysisDate.get(), calls };
    });
    check("12. clearGTFS empties the schedule and the day and notifies listeners",
      clr.sched === null && clr.date === null && clr.calls.length >= 1 && clr.calls[clr.calls.length - 1] === null,
      JSON.stringify(clr));

    // ---- Synthetic feed ----
    await page.evaluate(() => {
      window.__maxGap = 0;
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        if (now - last > window.__maxGap) window.__maxGap = now - last;
        last = now;
      }, 50);
    });
    const t0 = Date.now();
    const loadSynth = page.evaluate(async (u) => {
      const blob = await (await fetch(u)).blob();
      const ok = await App.loadGTFSFile(new File([blob], "synth.zip", { type: "application/zip" }));
      const deadline = performance.now() + 60000;
      while (performance.now() < deadline) {
        if ((App.map.getLayer("gtfs-shapes-layer") || App.map.getLayer("gtfs-stops-layer")) && App.map.loaded()) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return ok;
    }, feedUrl);
    const synthOk = await Promise.race([loadSynth, new Promise((r) => setTimeout(() => r("timeout"), 60000))]);
    check("13. synthetic feed loads within 60 s", synthOk === true, (Date.now() - t0) + " ms");

    const gap = await page.evaluate(() => window.__maxGap);
    check("14. page stays responsive while loading (largest tick gap < 1000 ms)", gap < 1000, "largest gap " + Math.round(gap) + " ms");

    const q = await page.evaluate(() => {
      const f = App.gtfsSchedule();
      if (!f) return null;
      const d = App.gtfsAnalysisDate.get();
      return { date: d, trips: GtfsSchedule.tripsOnDate(f, d).trips.length, method: GtfsSchedule.peakVehicles(f, d).method };
    });
    check("15. default day has trips and peak vehicles uses the block method",
      !!q && q.trips > 0 && q.method === "block", JSON.stringify(q));

    check("16. no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + (failed.length
    ? "FAIL — " + failed.length + "/" + results.length + " checks failed"
    : "PASS — " + results.length + "/" + results.length + " checks passed"));
  process.exit(failed.length ? 1 : 0);
})();
