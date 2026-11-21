#!/usr/bin/env node
// test/browser/gtfs-details.test.mjs
//
// Behavior test for the GTFS stop and route details in the attributes dock (Trips, Spacing, Stops,
// Schedule tabs) and the Overview tab of the GTFS Feed Attributes panel (js/projects/gtfs.js), against
// the real app in headless Chromium and the mini fixture (test/fixtures/gtfs/mini).
//
//   - a map click on a stop opens its view; the tabs follow the analysis date and hidden routes
//   - the route Stops tab links back to a stop; Escape, an empty-map click, a drawn feature and
//     clearing the feed each end the view
//   - the Overview tab shows the feed's agency and counts; the parts-of-the-day editor validates
//     its input and the setting is saved with the session
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see test/browser/README.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-details.test.mjs");

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

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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

    const dockKey = () => page.evaluate(() => App.getDockViewKey());
    const tabTexts = () => page.evaluate(() =>
      Array.from(document.querySelectorAll("#attr-dock .ad-tab")).map((b) => b.textContent));
    const clickTab = (label) => page.locator("#attr-dock .ad-tab", { hasText: label }).click();
    const tripRows = () => page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .gtfs-dt-trips tbody tr"))
      .map((tr) => Array.from(tr.children).map((td) => td.textContent)));
    const summaryOf = (stopId, date) => page.evaluate(([s, d]) =>
      GtfsSchedule.stopSummary(App.gtfsSchedule(), d, s, {}).departures, [stopId, date]);
    const waitMapIdle = () => page.waitForFunction("!App.map.isMoving() && App.map.loaded()", { timeout: 10000 });
    // Container pixel of a lon/lat plus the container's page offset, for real mouse clicks.
    const screenPoint = (lonLat) => page.evaluate((ll) => {
      const p = App.map.project(ll), r = App.map.getContainer().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    }, lonLat);

    // 1
    await page.evaluate(() => App.map.jumpTo({ center: [-104.98, 39.74], zoom: 15 }));
    await waitMapIdle();
    await page.waitForFunction("App.map.getLayer('gtfs-stops-layer')", { timeout: 10000 });
    const s2 = await screenPoint([-104.98, 39.74]);
    await page.mouse.click(s2.x, s2.y);
    await page.waitForFunction("App.getDockViewKey() === 'gtfs:stop:S2'", { timeout: 5000 }).catch(() => {});
    check("1. clicking stop S2 on the map opens its view", await dockKey() === "gtfs:stop:S2", "key " + await dockKey());

    // 2
    const tabs2 = await tabTexts();
    check("2. a stop shows Details, Trips and Spacing tabs", tabs2.join(",") === "Details,Trips,Spacing", tabs2.join(","));

    // 3
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S1" }));
    await clickTab("Trips");
    const dep1 = await summaryOf("S1", "20260112");
    const rows3 = await tripRows();
    const sumText = await page.locator("#attr-dock .gtfs-dt-summary").first().textContent();
    check("3. S1 Trips lists one row per departure and the summary states the count",
      dep1 === 21 && rows3.length === dep1 && sumText.includes(dep1 + " departures"),
      "departures " + dep1 + ", rows " + rows3.length + ", summary " + sumText.slice(0, 80));

    // 4
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S3" }));
    await clickTab("Trips");
    await page.locator("#attr-dock .gtfs-dt-seg", { hasText: "Arrivals" }).click();
    const arr = await tripRows();
    check("4. Arrivals at S3 lists B1 trips", arr.length >= 1 && arr.some((r) => r[1] === "B1"), JSON.stringify(arr.slice(0, 3)));

    // 5
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S1" }));
    await clickTab("Trips");
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260124"));
    const depSat = await summaryOf("S1", "20260124");
    const rows5 = await tripRows();
    check("5. changing the date redraws the open Trips tab", depSat === 5 && rows5.length === depSat,
      "Saturday departures " + depSat + ", rows " + rows5.length);

    // 6
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    const before6 = (await tripRows()).filter((r) => r[1] === "F1").length;
    await page.evaluate(() => App.gtfsSetRouteHidden("F1", true));
    const hidden6 = (await tripRows()).filter((r) => r[1] === "F1").length;
    await page.locator("#attr-dock .gtfs-dt-hidden input").check();
    const shown6 = (await tripRows()).filter((r) => r[1] === "F1").length;
    check("6. hiding F1 drops its rows; Show hidden routes brings them back",
      before6 === 18 && hidden6 === 0 && shown6 === 18, before6 + " / " + hidden6 + " / " + shown6);
    await page.evaluate(() => App.gtfsSetRouteHidden("F1", false));

    // 7
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S2" }));
    await clickTab("Spacing");
    const sp = await page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .gtfs-dt-table tbody tr"))
      .map((tr) => Array.from(tr.children).map((td) => td.textContent)));
    check("7. S2 Spacing lists both B1 directions with distances",
      sp.length === 2 && sp.map((r) => r[0] + "/" + r[1]).sort().join(",") === "B1/Direction 0,B1/Direction 1" &&
      sp.every((r) => /(ft|mi)$/.test(r[2]) && /(ft|mi)$/.test(r[3])), JSON.stringify(sp));

    // 8
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "route", routeId: "B1" }));
    const rtabs = await tabTexts();
    await clickTab("Stops");
    const names = await page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .gtfs-dt-stops"))[0]
      ? Array.from(document.querySelectorAll("#attr-dock .gtfs-dt-stops")[0].querySelectorAll(".gtfs-dt-link")).map((b) => b.textContent) : []);
    check("8. a route shows Details, Stops, Schedule; Stops lists S1, S2, S3 in direction order",
      rtabs.join(",") === "Details,Stops,Schedule,Cost" &&
      names.join("|") === "Main St & 1st Ave, Shared|Main St & 5th Ave|Main St & 9th Ave", rtabs.join(",") + " " + names.join("|"));

    // 9
    await page.locator("#attr-dock .gtfs-dt-link", { hasText: "5th Ave" }).first().click();
    check("9. a stop link in Stops switches the dock to that stop", await dockKey() === "gtfs:stop:S2", "key " + await dockKey());

    // 10
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "route", routeId: "B1" }));
    await clickTab("Schedule");
    const schedText = await page.locator("#attr-dock .ad-tab-pane").textContent();
    const wk = await page.evaluate(() => GtfsSchedule.tripsOnDate(App.gtfsSchedule(), "20260112", { routeIds: ["B1"] }).trips.length);
    const wkCell = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#attr-dock .gtfs-dt-table tbody tr"))
        .find((tr) => tr.children[0].textContent === "Weekday");
      return row ? row.children[2].textContent : null;
    });
    check("10. Schedule has a By day type table with the weekday trip count",
      schedText.includes("By day type") && wk === 5 && wkCell === String(wk), "weekday trips " + wk + ", cell " + wkCell);

    // 11
    await page.keyboard.press("Escape");
    check("11. Escape closes the dock", await page.evaluate(() => App.isAttrDockOpen()) === false);

    // 12
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S2" }));
    const empty = await screenPoint([-104.975, 39.7455]);
    await page.mouse.click(empty.x, empty.y);
    await page.waitForFunction("App.getDockViewKey() === null", { timeout: 3000 }).catch(() => {});
    check("12. clicking empty map closes the GTFS view", await dockKey() === null, "key " + await dockKey());

    // 13
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S2" }));
    const drawn = await page.evaluate(() => {
      App.addPointWithOpts(-104.95, 39.76, {});
      const i = App.points.length - 1;
      App.selectFeature("point", i);
      App.openAttrDock();
      return { open: App.isAttrDockOpen(), key: App.getDockViewKey() };
    });
    check("13. selecting a drawn point replaces the GTFS view", drawn.open === true && drawn.key === null, JSON.stringify(drawn));
    await page.keyboard.press("Escape");

    // 14
    await page.evaluate(() => App.openModulePopup("gtfs"));
    await page.locator("#gtfsOverviewBody .gtfs-ov-agency").waitFor({ state: "visible", timeout: 10000 });
    const ov = await page.evaluate(() => {
      const stat = Array.from(document.querySelectorAll("#gtfsOverviewBody .gtfs-ov-stat"))
        .find((s) => s.querySelector(".gtfs-ov-label").textContent === "Routes");
      return {
        text: document.getElementById("gtfsOverviewBody").textContent,
        routes: stat ? stat.querySelector(".gtfs-ov-num").textContent : null,
        active: document.querySelector(".gtfs-ptab.active").getAttribute("data-tab"),
        filesHidden: document.querySelector('.gtfs-ptab-pane[data-tab="files"]').hidden
      };
    });
    check("14. Overview is the first tab and shows the agency and 3 routes",
      ov.active === "overview" && ov.filesHidden === true && ov.text.includes("Mini Test Transit") && ov.routes === "3",
      JSON.stringify(ov).slice(0, 300));

    // 15
    const setPart = (i, v) => page.evaluate(([n, val]) => {
      const inp = document.getElementById("gtfsDayPart" + n);
      inp.value = val;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }, [i, v]);
    await setPart(1, "07:00");
    const okStart = await page.evaluate(() => App.gtfsDayParts.get()[1].start);
    await setPart(2, "05:00");
    const bad = await page.evaluate(() => ({
      parts: App.gtfsDayParts.get().map((p) => p.start),
      msg: document.getElementById("gtfsDayPartsMsg").textContent,
      shown: document.getElementById("gtfsDayPart2").value
    }));
    check("15. an AM-peak start of 07:00 is accepted; an out-of-order start is refused with a message",
      okStart === "07:00" && bad.parts[1] === "07:00" && bad.parts[2] !== "05:00" &&
      bad.msg.includes("must start after") && bad.shown === bad.parts[2], okStart + " " + JSON.stringify(bad));

    // 16
    await page.evaluate(() => App.cache.save());
    const saved = await page.waitForFunction(() => {
      const s = localStorage.getItem("mat-session") || "";
      const m = /"dayParts":\[([^\]]*)\]/.exec(s);
      return m ? m[1] : null;
    }, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    check("16. the parts of the day are saved with the session", !!saved && saved.includes('"07:00"'), String(saved));
    await page.evaluate(() => App.gtfsDayParts.reset());

    // 17
    await page.evaluate(() => App.gtfsOpenDetails({ kind: "stop", stopId: "S1" }));
    const openKey = await dockKey();
    await page.evaluate(() => App.clearGTFS());
    const afterClear = await dockKey();
    const emptyShown = await page.evaluate(() => document.getElementById("gtfsOverviewEmpty").style.display !== "none");
    check("17. clearing the feed closes the GTFS view and the Overview shows its empty state",
      openKey === "gtfs:stop:S1" && afterClear === null && emptyShown, openKey + " -> " + afterClear + ", empty " + emptyShown);

    check("18. no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
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
