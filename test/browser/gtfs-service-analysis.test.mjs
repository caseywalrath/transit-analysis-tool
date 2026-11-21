#!/usr/bin/env node
// test/browser/gtfs-service-analysis.test.mjs
//
// Behavior test for the GTFS Service Analysis panel (js/projects/gtfs-service-analysis.js) against the
// real app in headless Chromium and the mini fixture (test/fixtures/gtfs/mini):
//
//   - the Service & Cost table matches GtfsSchedule.serviceYear, sorts, searches and expands by day type
//   - route rate overrides, hidden routes and settings mark the result stale; Re-run applies them
//   - the CSV text, the route Cost tab and a Route Costing run on a copied Service agree with the table
//   - the Stops tab renders four sections, the map layers follow their toggles, clearing the feed ends both
//
// Set GSA_SHOTS_DIR to a folder to also save screenshots of the open panel there (light and dark).
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see test/browser/README.md.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-service-analysis.test.mjs");

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

// Parse one CSV line with quoted fields.
function csvCells(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

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

    const loaded = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      return App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
    }, mini);
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    check("0. mini feed loads and the day is Mon 2026-01-12",
      loaded === true && await page.evaluate(() => App.gtfsAnalysisDate.get()) === "20260112");

    // Same inputs the module builds from its defaults, with optional changes.
    const expectedYear = (changes) => page.evaluate((ch) => {
      const inputs = Object.assign({
        dates: App.gtfsRepresentativeDates(), dayCounts: { weekday: 255, saturday: 52, sunday: 58 },
        routeIds: App.gtfsScopeRouteIds(false), layover: { mode: "minutes", value: 10, maxBlockGapMin: 60 },
        deadheadPct: 15, rate: 150, rateBasis: "revenue", rateOverrides: {}
      }, ch || {});
      return GtfsSchedule.serviceYear(App.gtfsSchedule(), inputs);
    }, changes);
    const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
    const routeRows = () => page.evaluate(() => Array.from(document.querySelectorAll("#gsaServiceResults .gsa-route-row"))
      .map((tr) => ({ id: tr.getAttribute("data-route"), cells: Array.from(tr.children).map((c) => c.textContent) })));
    const rowIds = async () => (await routeRows()).map((r) => r.id);
    const statusText = () => page.evaluate(() => {
      const s = document.getElementById("gsaStatus");
      return s && s.style.display !== "none" ? s.textContent : "";
    });
    const clickRerun = () => page.locator("#gsaStatus .rf-status-rerun").click();
    const captureBlobs = () => page.evaluate(() => {
      window.__blobs = [];
      if (!URL.__orig) URL.__orig = URL.createObjectURL;
      URL.createObjectURL = (b) => { window.__blobs.push(b); return URL.__orig.call(URL, b); };
    });
    const lastBlobText = async (n) => {
      await page.waitForFunction((k) => window.__blobs.length >= k, n, { timeout: 5000 });
      return page.evaluate(async () => window.__blobs[window.__blobs.length - 1].text());
    };
    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, name) });
    };

    // 1
    await page.evaluate(() => App.openModulePopup("gtfs-service-analysis"));
    await page.waitForSelector("#gsaRunService", { state: "visible", timeout: 10000 });
    const hint = await page.locator("#gsaEmptyState").textContent();
    const emptyShown = await page.evaluate(() => getComputedStyle(document.getElementById("gsaEmptyState")).display !== "none");
    await page.click("#gsaRunService");
    await page.waitForSelector("#gsaServiceResults .gsa-route-row", { timeout: 10000 });
    const ids1 = (await rowIds()).sort().join(",");
    check("1. an empty hint shows before a run; Summarize service renders a row for B1, R1 and F1",
      emptyShown && /No service summary yet/.test(hint) && ids1 === "B1,F1,R1", "hint " + hint + " rows " + ids1);

    // 2
    const yr = await expectedYear();
    const rows2 = await routeRows();
    const bad2 = [];
    for (const r of rows2) {
      const e = yr.routes[r.id];
      const want = [String(Math.round(e.weekly.trips)), Math.round(e.annual.revenueHrs).toLocaleString("en-US"),
        Math.round(e.annual.platformHrs).toLocaleString("en-US"), String(e.peakVehicles)];
      const got = [r.cells[1], r.cells[2], r.cells[3], r.cells[4]];
      if (want.join("|") !== got.join("|") || r.cells[6] !== money(e.annual.cost)) {
        bad2.push(r.id + " want " + want.join("/") + " " + money(e.annual.cost) + " got " + got.join("/") + " " + r.cells[6]);
      }
    }
    const totalCell = await page.locator("#gsaServiceResults tfoot .gsa-total td").last().textContent();
    check("2. every route's cells and the total row equal GtfsSchedule.serviceYear with the same inputs",
      bad2.length === 0 && totalCell === money(yr.total.annual.cost), bad2.join("; ") + " total " + totalCell + " vs " + money(yr.total.annual.cost));
    await shot("service-collapsed-light.png");

    // 3
    const byTrips = Object.keys(yr.routes).sort((a, b) => yr.routes[b].weekly.trips - yr.routes[a].weekly.trips ||
      a.localeCompare(b));
    await page.click("#gsaServiceResults .gsa-sort[data-sort='trips']");
    const desc = await rowIds();
    await page.click("#gsaServiceResults .gsa-sort[data-sort='trips']");
    const asc = await rowIds();
    check("3a. sorting by Trips/wk reorders the rows, and a second click reverses them",
      desc.join(",") === byTrips.join(",") && asc.join(",") === byTrips.slice().reverse().join(","),
      "desc " + desc + " asc " + asc + " want " + byTrips);
    await page.fill("#gsaServiceResults .gsa-search", "air");
    const searched = await rowIds();
    await page.fill("#gsaServiceResults .gsa-search", "");
    check("3b. searching 'air' leaves only R1", searched.join(",") === "R1", searched.join(","));
    await page.click("#gsaServiceResults tr[data-route='B1'] .gsa-caret");
    const sub = await page.evaluate(() => {
      const d = document.querySelector("#gsaServiceResults tr[data-route='B1'] + tr.gsa-detail");
      return d ? Array.from(d.querySelectorAll("tr.gsa-subrow")).map((r) => r.getAttribute("data-day")) : [];
    });
    check("3c. expanding B1 shows three day-type sub-rows", sub.join(",") === "weekday,saturday,sunday", sub.join(","));
    await shot("service-expanded-light.png");

    // 4
    const r1Before = (await routeRows()).find((r) => r.id === "R1").cells[6];
    await page.fill("#gsaServiceResults tr[data-route='R1'] .gsa-rate-input", "300");
    await page.press("#gsaServiceResults tr[data-route='R1'] .gsa-rate-input", "Tab");
    const stale4 = await statusText();
    const unchanged = (await routeRows()).find((r) => r.id === "R1").cells[6] === r1Before;
    await clickRerun();
    const yr4 = await expectedYear({ rateOverrides: { R1: 300 } });
    const rows4 = await routeRows();
    const r1After = rows4.find((r) => r.id === "R1").cells[6];
    const total4 = await page.locator("#gsaServiceResults tfoot .gsa-total td").last().textContent();
    const bold = await page.evaluate(() => document.querySelector("#gsaServiceResults tr[data-route='R1'] .gsa-rate-input").classList.contains("gsa-rate-ov"));
    const saved = await page.evaluate(() => {
      const m = App.cache.collectState("full").moduleState;
      return m && m["gtfs-service-analysis"] ? m["gtfs-service-analysis"].rateOverrides : null;
    });
    check("4. a rate override marks the result stale; Re-run applies it to R1 and the total; it is saved in the session",
      /re-run/i.test(stale4) && unchanged && r1After === money(yr4.routes.R1.annual.cost) && r1After !== r1Before &&
      total4 === money(yr4.total.annual.cost) && bold && saved && saved.R1 === 300,
      JSON.stringify({ stale4, unchanged, r1Before, r1After, want: money(yr4.routes.R1.annual.cost), total4, bold, saved }));

    // 5
    await page.evaluate(() => App.gtfsSetRouteHidden("F1", true));
    const stale5 = await statusText();
    await clickRerun();
    const without = (await rowIds()).sort().join(",");
    await page.check("#gsaIncludeHidden");
    const stale5b = await statusText();
    await clickRerun();
    const withF1 = (await rowIds()).sort().join(",");
    check("5. hiding F1 marks the result stale; Re-run drops F1; Include hidden routes brings it back",
      /re-run/i.test(stale5) && without === "B1,R1" && /re-run/i.test(stale5b) && withF1 === "B1,F1,R1",
      without + " / " + withF1);
    await page.uncheck("#gsaIncludeHidden");
    await page.evaluate(() => App.gtfsSetRouteHidden("F1", false));

    // 6
    await captureBlobs();
    await page.click("#gsaServiceResults .gsa-csv");
    const csv = await lastBlobText(1);
    const lines = csv.trim().split("\n");
    const headerLines = lines.filter((l) => l.startsWith("# "));
    const dataLines = lines.filter((l) => !l.startsWith("# ")).slice(1);
    const perRoute = {};
    dataLines.forEach((l) => { const id = csvCells(l)[0]; perRoute[id] = (perRoute[id] || 0) + 1; });
    check("6. the CSV has the cost-basis, days and feed header lines, 5 rows per route and 5 system rows",
      headerLines.join("|") === "# Cost basis: rate × revenue hours|# Days per year: weekday 255, Saturday 52, Sunday 58|# Analysis date: 2026-01-12|# Dates used: weekday 2026-01-12, Saturday 2026-01-24, Sunday 2026-01-11" &&
      perRoute.B1 === 5 && perRoute.R1 === 5 && perRoute.F1 === 5 && perRoute.SYSTEM === 5 && dataLines.length === 20 &&
      dataLines.some((l) => /,override,/.test(l) && l.startsWith("R1,")),
      headerLines.join("|") + " counts " + JSON.stringify(perRoute));

    // 7
    const costTab = () => page.evaluate(() => {
      const row = document.querySelector("#attr-dock .gsa-cost-mini .gsa-cost-total");
      return row ? row.lastElementChild.textContent : null;
    });
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "route", routeId: "B1" }));
    await page.locator("#attr-dock .ad-tab", { hasText: "Cost" }).click();
    const tabCost = await costTab();
    const tableB1 = (await routeRows()).find((r) => r.id === "B1").cells[6];
    await page.evaluate(() => {
      const el = document.getElementById("gsaRate");
      el.value = "200";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const tabCost200 = await costTab();
    const yr200 = await expectedYear({ rate: 200 });
    await page.evaluate(() => {
      const el = document.getElementById("gsaRate");
      el.value = "150";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    check("7. the B1 Cost tab's annual cost equals the table's, and a new Cost per hour updates it at once",
      tabCost === tableB1 && tabCost200 === money(yr200.routes.B1.annual.cost) && tabCost200 !== tabCost && await costTab() === tableB1,
      JSON.stringify({ tabCost, tableB1, tabCost200, want200: money(yr200.routes.B1.annual.cost) }));
    await page.evaluate(() => App.closeAttrDock && App.closeAttrDock());

    // 8
    await page.click(".gsa-tabs .rf-tab[data-tab='stops']");
    await page.click("#gsaRunStops");
    await page.waitForSelector("#gsaStopsResults .gsa-section", { timeout: 10000 });
    await page.evaluate(() => document.querySelectorAll("#gsaStopsResults .gsa-section").forEach((d) => { d.open = true; }));
    const sums = await page.evaluate(() => Array.from(document.querySelectorAll("#gsaStopsResults .gsa-section"))
      .map((d) => d.querySelector(".gsa-sec-sum").textContent));
    check("8a. Analyze stops renders four sections, each with a one-line result",
      sums.length === 4 && sums.every((s) => s.trim().length > 0), JSON.stringify(sums));
    const nCand = await page.evaluate(() => GtfsSchedule.consolidationCandidates(App.gtfsSchedule(), "20260112",
      { routeIds: App.gtfsScopeRouteIds(false), maxFt: 600, secondsPerStop: 20 }).count);
    const candToggle = page.locator("#gsaStopsResults .gsa-cand-toggle");
    let candOk;
    if (nCand > 0) {
      await candToggle.check();
      candOk = await page.evaluate(() => !!App.map.getLayer("gsa-candidates-layer"));
    } else {
      candOk = await candToggle.isDisabled() && await page.evaluate(() => !App.map.getLayer("gsa-candidates-layer"));
    }
    check("8b. Show on map adds gsa-candidates-layer only when there are candidates, else the toggle is disabled",
      candOk, "candidates " + nCand);
    await page.locator("#gsaStopsResults .gsa-ramp-toggle").check();
    const rampOn = await page.evaluate(() => !!App.map.getLayer("gsa-stop-service-layer"));
    check("8c. the ramp toggle adds gsa-stop-service-layer and shows a legend",
      rampOn && await page.locator("#gsaStopsResults .gsa-legend-item").count() === 6);
    const spacingCsvOk = await (async () => {
      await captureBlobs();
      await page.locator("#gsaStopsResults .gsa-section[data-section='spacing'] .gsa-csv").click();
      const t = await lastBlobText(1);
      const n = t.trim().split("\n").filter((l) => !l.startsWith("# ")).length - 1;
      const want = await page.evaluate(() => GtfsSchedule.stopSpacingStats(App.gtfsSchedule(), "20260112",
        { routeIds: App.gtfsScopeRouteIds(false) }).segments);
      return n === want && want > 0 ? "" : "rows " + n + " want " + want;
    })();
    check("8d. the spacing CSV has one row per segment", spacingCsvOk === "", spacingCsvOk);
    await shot("stops-light.png");
    if (SHOTS) {
      await page.evaluate(() => document.body.classList.add("dark-mode"));
      await shot("stops-dark.png");
      await page.click(".gsa-tabs .rf-tab[data-tab='service']");
      await shot("service-expanded-dark.png");
      await page.evaluate(() => document.body.classList.remove("dark-mode"));
      await page.click(".gsa-tabs .rf-tab[data-tab='stops']");
    }

    // 9: Route Costing on a copied Service, same settings as this module's defaults.
    const ours = await expectedYear();
    const b1 = ours.routes.B1;
    await page.evaluate(() => App.gtfsCopy({ routeId: "B1", mode: "service" }));
    await page.evaluate(() => App.openModulePopup("route-costing"));
    await page.waitForSelector("#rcCostBtn", { state: "visible", timeout: 10000 });
    await page.waitForSelector("#rcServiceList input[type=checkbox]", { timeout: 10000 });
    await page.evaluate(() => {
      document.querySelectorAll("#rcServiceList input[type=checkbox]").forEach((c) => { c.checked = c.getAttribute("data-key") === "service-B1"; c.dispatchEvent(new Event("change", { bubbles: true })); });
    });
    await page.click("#rcCostBtn");
    await page.waitForFunction("!document.getElementById('rcExportCSV').disabled", { timeout: 10000 });
    await captureBlobs();
    await page.click("#rcExportCSV");
    const rcCsv = await lastBlobText(1);
    const rcRows = rcCsv.split("\n").filter((l) => l && !l.startsWith("#")).map(csvCells);
    const rcHead = rcRows[0], rcB1 = rcRows.filter((c) => c[0] === "B1");
    const col = (n) => rcHead.indexOf(n);
    const rcTotal = rcB1.find((c) => c[col("Day type")] === "Total");
    const rcDay = (d) => rcB1.find((c) => c[col("Day type")] === d);
    const dc = { Weekday: 255, Saturday: 52, Sunday: 58 };
    const rcTrips = Object.keys(dc).reduce((s, d) => s + Number(rcDay(d)[col("Trips")]) * dc[d], 0);
    const rc = { trips: rcTrips, running: Number(rcTotal[col("Annual running-hr")]), revenue: Number(rcTotal[col("Annual revenue-hr")]),
      platform: Number(rcTotal[col("Annual plat-hr")]), cost: Number(rcTotal[col("Annual cost ($)")]) };
    const mine = { trips: b1.annual.trips, running: b1.annual.runningHrs, revenue: b1.annual.revenueHrs,
      platform: b1.annual.platformHrs, cost: b1.annual.cost };
    const pct = (a, b) => (b ? ((a - b) / b * 100).toFixed(1) : "n/a") + "%";
    console.log("        cross-check B1 (this module vs Route Costing, annual):");
    ["trips", "running", "revenue", "platform", "cost"].forEach((k) => {
      console.log("          " + k.padEnd(9) + mine[k].toFixed(1).padStart(12) + rc[k].toFixed(1).padStart(12) + "   diff " + pct(mine[k], rc[k]));
    });
    const within5 = (k) => rc[k] !== 0 && Math.abs(mine[k] - rc[k]) / rc[k] <= 0.05;
    check("9a. B1 trips per year are equal in both tools", mine.trips === rc.trips, mine.trips + " vs " + rc.trips);
    check("9b. B1 running hours per year agree within 0.1 h per service day",
      Math.abs(mine.running - rc.running) <= 0.1 * 365, mine.running.toFixed(2) + " vs " + rc.running.toFixed(2));
    check("9c. B1 revenue hours, platform hours and cost agree within 5 % (layover differs by design: blocks here, the setting there)",
      within5("revenue") && within5("platform") && within5("cost"),
      "revenue " + pct(mine.revenue, rc.revenue) + ", platform " + pct(mine.platform, rc.platform) + ", cost " + pct(mine.cost, rc.cost));

    // 8 (continued): clearing the feed removes the layers and the results.
    await page.evaluate(() => App.openModulePopup("gtfs-service-analysis"));
    await page.waitForSelector("#gsaRunStops", { state: "visible", timeout: 10000 });
    await page.evaluate(() => App.clearGTFS());
    const cleared = await page.evaluate(() => ({
      ramp: !!App.map.getLayer("gsa-stop-service-layer"), cand: !!App.map.getLayer("gsa-candidates-layer"),
      stops: document.querySelector("#gsaStopsResults").children.length, service: document.querySelector("#gsaServiceResults").children.length
    }));
    check("8e. clearing the feed removes both map layers and the results",
      !cleared.ramp && !cleared.cand && cleared.stops === 0 && cleared.service === 0, JSON.stringify(cleared));

    // 10
    check("10. no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
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
