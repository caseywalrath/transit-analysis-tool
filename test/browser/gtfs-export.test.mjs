#!/usr/bin/env node
// test/browser/gtfs-export.test.mjs
//
// Behavior test for the "Drawn Services as GTFS (ZIP)" export dialog (js/core/gtfs-export-ui.js), against the
// real app in headless Chromium: the Export menu entry, the Service checklist, the engine's error text, the
// downloaded ZIP's files, and a load-back through the app's own GTFS reader that must see the same trips on a
// date as the drawn Services give the analysis network.
//
// Set GEX_SHOTS_DIR to a folder to save light and dark screenshots of the dialog with a result showing.
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see test/browser/README.md.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, sleep, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-export.test.mjs");

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

const SHOTS = process.env.GEX_SHOTS_DIR || "";

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await routeVendoredAssets(context, port, () => false);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    let downloads = 0;
    page.on("download", () => { downloads++; });
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    await page.evaluate(() => { try { localStorage.removeItem("mat.gtfsExport.agency"); } catch (e) { /* ignore */ } });
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    const dlgVisible = () => page.evaluate(() => !document.getElementById("gex-dialog").hidden);
    const statusText = () => page.evaluate(() => document.getElementById("gex-status").textContent);
    const fill = async (agency, start, end) => {
      await page.fill("#gex-agency-name", agency.name);
      await page.fill("#gex-agency-url", agency.url);
      await page.fill("#gex-agency-tz", agency.tz);
      await page.fill("#gex-start", start);
      await page.fill("#gex-end", end);
    };
    // Clicks Export and resolves { status, bytes, name } (bytes null when no file arrived).
    const runExport = async (expectDownload) => {
      let dl = null;
      const waiter = expectDownload ? page.waitForEvent("download", { timeout: 15000 }) : null;
      await page.click("#gex-export");
      if (waiter) dl = await waiter;
      await page.waitForFunction("!document.getElementById('gex-export').disabled && " +
        "document.getElementById('gex-status').textContent !== 'Building…' && document.getElementById('gex-status').textContent !== ''",
      null, { timeout: 15000 });
      const status = await statusText();
      let bytes = null;
      if (dl) bytes = readFileSync(await dl.path());
      return { status, bytes, name: dl ? dl.suggestedFilename() : null };
    };
    const zipNames = (bytes) => page.evaluate(async (arr) => {
      const z = await JSZip.loadAsync(new Uint8Array(arr));
      return Object.keys(z.files).sort();
    }, Array.from(bytes));
    const loadBackCount = (bytes, date) => page.evaluate(async ([arr, d]) => {
      const other = await App.gtfsReadOtherFeed(new File([new Uint8Array(arr)], "x.zip"));
      return GtfsSchedule.tripsOnDate(other.feed, d).trips.length;
    }, [Array.from(bytes), date]);

    // 1
    await page.click("#export-btn");
    const menuText = await page.evaluate(() => {
      const b = document.querySelector('#export-dropdown button[data-format="gtfs-export"]');
      return b ? b.textContent.trim() : null;
    });
    await page.click('#export-dropdown button[data-format="gtfs-export"]');
    check("1. Export menu has 'Drawn Services as GTFS (ZIP)' and it opens #gex-dialog",
      menuText === "Drawn Services as GTFS (ZIP)" && await dlgVisible(), String(menuText));

    // 2
    const noSvc = await page.evaluate(() => ({
      text: document.getElementById("gex-services").textContent,
      disabled: document.getElementById("gex-export").disabled
    }));
    check("2. no Services: message shows and Export is disabled",
      noSvc.text === "Draw a Line or Route and assign it a Service with headway bands first." && noSvc.disabled === true,
      JSON.stringify(noSvc));

    // Load the mini feed and copy B1 into a Service.
    await page.keyboard.press("Escape");
    const loaded = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      return App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
    }, mini);
    const copied = await page.evaluate(() => Array.from(App.gtfsCopy({ routeId: "B1", mode: "service" })).length);

    // 3
    await page.evaluate(() => App.openGtfsExportDialog());
    await page.evaluate(() => App.openGtfsExportDialog());
    const rows = await page.evaluate(() => {
      const svcs = App.buildTransitServices();
      const boxes = Array.from(document.querySelectorAll("#gex-services input[type=checkbox]"));
      return {
        keys: svcs.map((s) => s.key), got: boxes.map((b) => b.value), checked: boxes.every((b) => b.checked && !b.disabled),
        disabledExport: document.getElementById("gex-export").disabled
      };
    });
    check("3. after copying B1: one checked row per Service (list rebuilt, not appended)",
      loaded === true && copied === 2 && rows.keys.length >= 1 && JSON.stringify(rows.keys) === JSON.stringify(rows.got) &&
      rows.checked && !rows.disabledExport, JSON.stringify(rows));

    // 4
    await fill({ name: "Test Transit", url: "example.org", tz: "America/Denver" }, "2026-01-01", "2026-12-31");
    const before4 = downloads;
    const r4 = await runExport(false);
    await sleep(300);
    check("4. bad agency URL: exact engine text and no download",
      r4.status === "Agency URL must start with http:// or https://." && downloads === before4, r4.status);

    // 5
    await page.fill("#gex-agency-url", "https://example.org");
    const r5 = await runExport(true);
    check("5. valid fields: drawn-services-gtfs-<start>.zip downloads and status starts 'Exported 1 routes'",
      r5.name === "drawn-services-gtfs-20260101.zip" && r5.status.indexOf("Exported 1 routes") === 0,
      r5.name + " | " + r5.status);

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      const dlg = page.locator("#gex-dialog");
      await dlg.screenshot({ path: join(SHOTS, "gex-dialog-light.png") });
      await page.evaluate(() => document.body.classList.add("dark-mode"));
      await sleep(500);
      await dlg.screenshot({ path: join(SHOTS, "gex-dialog-dark.png") });
      await page.evaluate(() => document.body.classList.remove("dark-mode"));
      await sleep(500);
    }

    // 6
    const names5 = await zipNames(r5.bytes);
    const need = ["agency", "stops", "routes", "trips", "stop_times", "calendar", "shapes", "feed_info"].map((n) => n + ".txt");
    const hasFreq = names5.indexOf("frequencies.txt") >= 0;
    const m = /\((\d+) departures\)/.exec(r5.status), t = /(\d+) trips in the file/.exec(r5.status);
    const bandsEligible = !!(m && t && Number(m[1]) > Number(t[1]));
    check("6. ZIP has agency, stops, routes, trips, stop_times, calendar, shapes, feed_info (+ frequencies when eligible)",
      need.every((n) => names5.indexOf(n) >= 0) && (!bandsEligible || hasFreq),
      names5.join(",") + " | eligible=" + bandsEligible);

    // 7
    const drawn = await page.evaluate(() => App.buildAnalysisNetwork({ gtfs: false, date: "20260112" }).counts.proposalTrips);
    const back5 = await loadBackCount(r5.bytes, "20260112");
    check("7. loaded back: trips on 20260112 equal the drawn trips on that date",
      drawn > 0 && back5 === drawn, "loaded back " + back5 + " vs drawn " + drawn);

    // 8
    await page.uncheck("#gex-frequencies");
    const r8 = await runExport(true);
    const names8 = await zipNames(r8.bytes);
    const back8 = await loadBackCount(r8.bytes, "20260112");
    check("8. headway windows off: no frequencies.txt and the same trip count on 20260112",
      names8.indexOf("frequencies.txt") < 0 && back8 === drawn, names8.join(",") + " | " + back8 + " vs " + drawn);

    // 9
    await page.keyboard.press("Escape");
    check("9. Escape closes the dialog", !(await dlgVisible()));

    // Not a numbered check: it only adds a failure when the page threw.
    if (errors.length) check("page errors", false, errors.join(" | ").slice(0, 300));
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
