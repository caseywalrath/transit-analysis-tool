#!/usr/bin/env node
// test/browser/gtfs-feed-health.test.mjs
//
// Behavior test for the Feed health tab of GTFS Service Analysis (js/projects/gtfs-service-analysis.js)
// against the real app in headless Chromium and the mini fixture (test/fixtures/gtfs/mini):
//
//   - the tab exists, shows its empty hint, and Check feed renders the seven engine checks
//   - each Found count equals GtfsSchedule.feedHealth run in the page; rows expand to examples
//   - the GTFS Overview repeats the result; the CSV has the expected lines
//   - a replaced or cleared feed drops the result
//
// Set GSA_SHOTS_DIR to a folder to also save screenshots of the open panel there (light and dark).
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see test/browser/README.md.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-feed-health.test.mjs");

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

    const loadMini = (files) => page.evaluate(async (fs) => {
      const zip = new JSZip();
      Object.keys(fs).forEach((k) => zip.file(k, fs[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      return App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
    }, files);
    const loaded = await loadMini(mini);
    if (loaded !== true) throw new Error("mini feed did not load");

    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, name) });
    };
    const rows = () => page.evaluate(() => Array.from(document.querySelectorAll("#gsaHealthResults .gsa-health-row"))
      .map((tr) => ({ id: tr.getAttribute("data-check"), cells: Array.from(tr.children).map((c) => c.textContent.trim()) })));
    const runCheck = async () => {
      await page.click("#gsaRunHealth");
      await page.waitForSelector("#gsaHealthResults .gsa-health-row", { timeout: 10000 });
    };
    const overviewLine = () => page.evaluate(() => {
      const b = document.getElementById("gtfsHealth");
      return b ? { hidden: b.hidden, text: b.textContent } : null;
    });

    await page.evaluate(() => App.openModulePopup("gtfs-service-analysis"));
    await page.waitForSelector("#gsaRunHealth", { state: "attached", timeout: 10000 });

    // 1
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".gsa-tabs .rf-tab")).map((b) => b.textContent.trim()));
    check("1. tab-present: four tabs, the last labelled Feed health",
      tabs.length === 4 && tabs[3] === "Feed health", JSON.stringify(tabs));

    // 2
    await page.click('.gsa-tabs .rf-tab[data-tab="health"]');
    await page.waitForSelector("#gsaRunHealth", { state: "visible", timeout: 5000 });
    const hint = await page.locator("#gsaEmptyState").textContent();
    const hintShown = await page.evaluate(() => getComputedStyle(document.getElementById("gsaEmptyState")).display !== "none");
    check("2. empty-hint: before a run the health tab shows No feed check yet.",
      hintShown && /No feed check yet\./.test(hint), hint);

    // 3
    await runCheck();
    const r1 = await rows();
    const expectedIds = ["expiry", "shapes", "wheelchair", "speed", "shapeDistance", "times", "agency"];
    const engine = await page.evaluate(() => GtfsSchedule.feedHealth(App.gtfsSchedule(),
      { today: App.gtfsToday(), shapes: App.gtfsShapeCoords() }).checks.map((c) => ({ id: c.id, label: c.label, count: c.count })));
    check("3. seven-rows: 7 rows with labels in engine order",
      r1.length === 7 && r1.every((r, i) => r.id === expectedIds[i] && r.cells[0].replace(/^[▸▾]\s*/, "") === engine[i].label),
      JSON.stringify(r1.map((r) => [r.id, r.cells[0]])));

    // 4
    check("4. counts-match-engine: each Found equals the engine's count",
      r1.length === 7 && r1.every((r, i) => r.cells[2] === engine[i].count.toLocaleString("en-US")),
      JSON.stringify(r1.map((r) => r.cells[2])) + " vs " + JSON.stringify(engine.map((c) => c.count)));

    // 5
    const withExamples = await page.evaluate(() => {
      const b = document.querySelector("#gsaHealthResults .gsa-health-row .gsa-caret");
      return b ? b.closest("tr").getAttribute("data-check") : null;
    });
    let subRows = 0;
    if (withExamples) {
      await page.click('#gsaHealthResults tr[data-check="' + withExamples + '"] .gsa-caret');
      subRows = await page.evaluate(() => document.querySelectorAll("#gsaHealthResults .gsa-detail .gsa-sub-table tbody tr").length);
    }
    check("5. expand-examples: the first row with a caret expands to a sub-table with >= 1 body row",
      !!withExamples && subRows >= 1, withExamples + " rows " + subRows);

    await shot("feed-health-light.png");
    await page.evaluate(() => document.body.classList.add("dark-mode"));
    await page.waitForTimeout(500); // let the theme colour transitions finish before the shot
    await shot("feed-health-dark.png");
    await page.evaluate(() => document.body.classList.remove("dark-mode"));

    // 6
    // The Overview line lives in the GTFS popup, which is only in the DOM while that panel is open.
    await page.evaluate(() => App.openModulePopup("gtfs"));
    await page.waitForSelector("#gtfsHealth", { state: "attached", timeout: 10000 });
    const line = await overviewLine();
    check("6. overview-line: #gtfsHealth is shown and starts with Feed health:",
      !!line && line.hidden === false && /^Feed health:/.test(line.text), JSON.stringify(line));

    // 7
    await page.evaluate(() => {
      window.__blobs = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b) => { window.__blobs.push(b); return orig.call(URL, b); };
    });
    await page.evaluate(() => App.openModulePopup("gtfs-service-analysis"));
    await page.waitForSelector("#gsaHealthResults .gsa-csv", { timeout: 5000 });
    await page.click("#gsaHealthResults .gsa-csv");
    await page.waitForFunction(() => window.__blobs.length >= 1, null, { timeout: 5000 });
    const csv = await page.evaluate(() => window.__blobs[window.__blobs.length - 1].text());
    const lines = csv.trim().split("\n");
    const hashes = lines.filter((l) => l.startsWith("# ")).length;
    const rest = lines.filter((l) => !l.startsWith("# "));
    check("7. csv: 2 # lines, a header line and 7 data lines",
      hashes === 2 && /^check,status,found,checked,examples$/.test(rest[0]) && rest.length === 8,
      hashes + " # lines, " + rest.length + " other: " + rest[0]);

    // 8
    await loadMini(mini);
    await page.waitForFunction(() => document.getElementById("gsaHealthResults").children.length === 0, null, { timeout: 5000 })
      .catch(() => {});
    const afterReload = await page.evaluate(() => ({
      kids: document.getElementById("gsaHealthResults").children.length,
      empty: getComputedStyle(document.getElementById("gsaEmptyState")).display !== "none" &&
        /No feed check yet\./.test(document.getElementById("gsaEmptyState").textContent)
    }));
    await page.evaluate(() => App.openModulePopup("gtfs"));
    await page.waitForSelector("#gtfsHealth", { state: "attached", timeout: 10000 });
    const line2 = await overviewLine();
    check("8. dropped-on-new-feed: a new feed empties the results, shows the hint and hides #gtfsHealth",
      afterReload.kids === 0 && afterReload.empty && !!line2 && line2.hidden === true,
      JSON.stringify(afterReload) + " " + JSON.stringify(line2));

    // 9
    await page.evaluate(() => App.openModulePopup("gtfs-service-analysis"));
    await page.waitForSelector("#gsaRunHealth", { state: "visible", timeout: 10000 });
    await page.click('.gsa-tabs .rf-tab[data-tab="health"]');
    await runCheck();
    await page.evaluate(() => App.clearGTFS());
    const kids = await page.evaluate(() => document.getElementById("gsaHealthResults").children.length);
    check("9. clear: clearing the feed empties the results, with no uncaught page errors",
      kids === 0 && errors.length === 0, "children " + kids + " " + errors.join(" | ").slice(0, 300));
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
