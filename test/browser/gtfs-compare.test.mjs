#!/usr/bin/env node
// test/browser/gtfs-compare.test.mjs
//
// Behavior test for the Compare tab of GTFS Service Analysis (js/projects/gtfs-service-analysis.js)
// against the real app in headless Chromium and the mini fixture (test/fixtures/gtfs/mini):
//
//   - tab order, the file prompt, the change table for a second ZIP (R1 trips removed, B1 renamed B1X)
//   - the counts line against ServiceCompare run in the page, the stubbed Census tiles, the CSV
//   - a changed input marks the result stale and Re-run clears it
//   - drawn-Services mode (a copied B1 Service replaces B1) and the hand-off to Title VI
//
// Census is stubbed (App.countPeopleNearStops) so the test uses no network.
// Set GSA_SHOTS_DIR to a folder to also save screenshots of the open panel there (light and dark).
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see test/browser/README.md.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-compare.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (pass || !detail ? "" : "  — " + detail));
}

const MINI_DIR = join(REPO_ROOT, "test", "fixtures", "gtfs", "mini");
const MINI_FILES = ["agency", "calendar", "calendar_dates", "frequencies", "routes", "shapes", "stop_times", "stops", "trips"]
  .map((n) => n + ".txt");
const mini = {};
MINI_FILES.forEach((f) => { mini[f] = readFileSync(join(MINI_DIR, f), "utf8"); });

// Build feed: no R1 trips, and route B1 renamed B1X (its short name stays B1).
const build = Object.assign({}, mini);
build["trips.txt"] = mini["trips.txt"].split("\n").filter((l) => !/^R1,/.test(l)).map((l) => l.replace(/^B1,/, "B1X,")).join("\n");
build["routes.txt"] = mini["routes.txt"].split("\n").map((l) => l.replace(/^B1,/, "B1X,")).join("\n");

const SHOTS = process.env.GSA_SHOTS_DIR || "";

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1900, height: 1000 } });
    await routeVendoredAssets(context, port, () => false);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    const zipBase64 = (files) => page.evaluate(async (fs) => {
      const zip = new JSZip();
      Object.keys(fs).forEach((k) => zip.file(k, fs[k]));
      return zip.generateAsync({ type: "base64" });
    }, files);
    const loaded = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return App.loadGTFSFile(new File([bin], "mini.zip", { type: "application/zip" }));
    }, await zipBase64(mini));
    if (loaded !== true) throw new Error("mini feed did not load");
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    // No network: residents = stops x 100, blocks = stops, no jobs.
    await page.evaluate(() => {
      App.countPeopleNearStops = async (stops) => ({ residents: stops.length * 100, jobs: null, blocks: stops.length, note: null });
    });

    const buildB64 = await zipBase64(build);
    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, name) });
    };
    const statusText = () => page.evaluate(() => {
      const s = document.getElementById("gsaStatus");
      return s && s.style.display !== "none" ? s.textContent : "";
    });
    const cmpRows = () => page.evaluate(() => Array.from(document.querySelectorAll("#gsaCompareResults .gsa-cmp-row"))
      .map((tr) => Array.from(tr.children).map((c) => c.textContent.replace(/^[▸▾]\s*/, "").trim())));
    const runCompare = async () => {
      await page.click("#gsaRunCompare");
      await page.waitForSelector("#gsaCompareResults .gsa-cmp-table", { timeout: 20000 });
    };

    await page.evaluate(() => App.openModulePopup("gtfs-service-analysis"));
    await page.waitForSelector("#gsaRunCompare", { state: "attached", timeout: 10000 });

    // 1
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".gsa-tabs .rf-tab")).map((b) => b.textContent.trim()));
    check("1. tab-order: tabs are Service & Cost, Stops, Compare, Feed health",
      JSON.stringify(tabs) === JSON.stringify(["Service & Cost", "Stops", "Compare", "Feed health"]), JSON.stringify(tabs));

    // 2
    await page.click('.gsa-tabs .rf-tab[data-tab="compare"]');
    await page.waitForSelector("#gsaRunCompare", { state: "visible", timeout: 5000 });
    await page.click("#gsaRunCompare");
    const msg = await statusText();
    check("2. feed-mode-needs-file: Compare with no file asks for a GTFS ZIP",
      /Choose a GTFS ZIP to compare with\./.test(msg), msg);

    // 3
    await page.setInputFiles("#gsaCompareFile", { name: "build.zip", mimeType: "application/zip", buffer: Buffer.from(buildB64, "base64") });
    await runCompare();
    await page.selectOption("#gsaCompareFilter", "all");
    const rows = await cmpRows();
    const b1 = rows.find((r) => r[0] === "B1"), r1 = rows.find((r) => r[0] === "R1");
    check("3. feed-rows: B1 is matched by short name and Unchanged; R1 is Removed",
      !!b1 && b1[1] === "Unchanged" && b1[2] === "short name" && !!r1 && r1[1] === "Removed",
      JSON.stringify(rows.map((r) => r.slice(0, 3))));

    // 4
    const expected = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const other = await App.gtfsReadOtherFeed(new File([bin], "build.zip", { type: "application/zip" }));
      const inputs = {
        dates: App.gtfsRepresentativeDates(), dayCounts: { weekday: 255, saturday: 52, sunday: 58 },
        routeIds: App.gtfsScopeRouteIds(false), layover: { mode: "minutes", value: 10, maxBlockGapMin: 60 },
        deadheadPct: 15, rate: 150, rateBasis: "revenue", rateOverrides: {}
      };
      const nb = App.feedServiceSummary(App.gtfsSchedule(), { label: "a", dates: inputs.dates, routeIds: inputs.routeIds, service: inputs });
      const b = App.feedServiceSummary(other.feed, { label: "b", preferDates: inputs.dates, service: inputs });
      const c = ServiceCompare.compare(nb, b, { pairs: b.pairs }).counts;
      return { counts: c.added + " added · " + c.removed + " removed · " + c.changed + " changed · " + c.unchanged + " unchanged",
        nbStops: nb.stops.length, bStops: b.stops.length, rows: ServiceCompare.compare(nb, b, { pairs: b.pairs }).rows.length };
    }, buildB64);
    const countsLine = await page.evaluate(() => (document.querySelector('#gsaCompareResults [data-gsa="cmp-counts"]') || {}).textContent);
    check("4. feed-matches-engine: the counts line equals ServiceCompare on the same inputs",
      countsLine === expected.counts, countsLine + " vs " + expected.counts);

    // 5
    const tile = await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll("#gsaCompareResults .gsa-tile"))
        .find((x) => /^Residents/.test(x.querySelector(".gsa-tile-lbl").textContent));
      return t ? t.querySelector(".gsa-tile-val").textContent : null;
    });
    const wantTile = (expected.nbStops * 100).toLocaleString("en-US") + " → " + (expected.bStops * 100).toLocaleString("en-US");
    check("5. people-tiles: the Residents tile shows the stubbed numbers", tile === wantTile, tile + " vs " + wantTile);

    // Screenshots: one row expanded.
    await page.click("#gsaCompareResults .gsa-cmp-row .gsa-caret");
    await shot("compare-light.png");
    await page.evaluate(() => document.body.classList.add("dark-mode"));
    await page.waitForTimeout(500); // let the theme colour transitions finish before the shot
    await shot("compare-dark.png");
    await page.evaluate(() => document.body.classList.remove("dark-mode"));

    // 6
    await page.evaluate(() => {
      window.__blobs = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b) => { window.__blobs.push(b); return orig.call(URL, b); };
    });
    await page.click("#gsaCompareResults .gsa-csv");
    await page.waitForFunction(() => window.__blobs.length >= 1, null, { timeout: 5000 });
    const csv = await page.evaluate(() => window.__blobs[window.__blobs.length - 1].text());
    const lines = csv.trim().split("\n");
    const hashes = lines.filter((l) => l.startsWith("# ")).length;
    const rest = lines.filter((l) => !l.startsWith("# "));
    check("6. csv: 4 # lines, a header, one line per row and a Total line",
      hashes === 4 && /^Route,Status,Matched by,/.test(rest[0]) && rest.length === 1 + expected.rows + 1 && /^Total,/.test(rest[rest.length - 1]),
      hashes + " # lines, " + rest.length + " other (rows " + expected.rows + "): " + rest[0]);

    // 7
    await page.click("#gsaComparePeople");
    const stale = await statusText();
    await page.locator("#gsaStatus .rf-status-rerun").click();
    await page.waitForFunction(() => !document.querySelector("#gsaCompareResults .gsa-tile-lbl") ||
      !Array.from(document.querySelectorAll("#gsaCompareResults .gsa-tile-lbl")).some((e) => /^Residents/.test(e.textContent)), null, { timeout: 20000 });
    const after = await statusText();
    check("7. stale-on-change: unticking the people box shows the stale banner; Re-run clears it",
      /out of date|changed|stale|Re-run/i.test(stale) && after === "", JSON.stringify([stale, after]));

    // 8
    await page.evaluate(() => App.gtfsCopy({ routeId: "B1", mode: "service" }));
    await page.click('input[name="gsaCompareMode"][value="drawn"]');
    await page.waitForSelector("#gsaCompareServices .gsa-cmp-replace", { timeout: 5000 });
    const sels = await page.evaluate(() => Array.from(document.querySelectorAll("#gsaCompareServices .gsa-cmp-replace")).map((s) => s.value));
    await page.click("#gsaComparePeople");
    await runCompare();
    await page.selectOption("#gsaCompareFilter", "all");
    const rows2 = await cmpRows();
    const rb1 = rows2.find((r) => r[0] === "B1");
    check("8. drawn-mode: one Service defaulting to B1; Compare gives a B1 row replaced by the drawn Service",
      sels.length === 1 && sels[0] === "B1" && !!rb1 && rb1[2] === "Replaced by drawn Service",
      JSON.stringify(sels) + " " + JSON.stringify(rows2.map((r) => r.slice(0, 3))));

    // 9
    const boxes = await page.evaluate(() => document.querySelectorAll("#gsaCompareResults .gsa-cmp-send input").length);
    let noteText = "";
    if (boxes) {
      const idx = await page.evaluate(() => Array.from(document.querySelectorAll("#gsaCompareResults .gsa-cmp-send tbody tr"))
        .findIndex((tr) => tr.children[1].textContent === "B1"));
      const target = idx >= 0 ? idx : 0;
      const cb = page.locator("#gsaCompareResults .gsa-cmp-send tbody tr").nth(target).locator("input");
      if (!(await cb.isChecked())) await cb.check();
      await page.click("#gsaSendTitleVi");
      noteText = await page.evaluate(() => document.getElementById("gsaCompareResults").textContent);
    }
    check("9. title-vi: ticking a changed row and pressing Create Title VI scenario shows the Added note",
      /Added “Build vs No-Build/.test(noteText), boxes + " send rows; " + noteText.slice(-200));

    // 10
    check("10. no-page-errors", errors.length === 0, errors.join(" | ").slice(0, 300));
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
