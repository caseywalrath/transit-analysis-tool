#!/usr/bin/env node
// test/browser/gtfs-copy-service.test.mjs
//
// Behavior test for "Copy as grouped Service" with a timetable (App.gtfsCopy mode "service" in
// js/projects/gtfs.js, plans from js/core/gtfs-schedule.js), against the real app in headless Chromium:
//
//   - bands, run time, direction and serviceId land on one Line per shape, and the copy's trip count
//     per day equals the timetable's (the same arithmetic Route Costing uses)
//   - the route's stops become Points that remember their stop_id and the copied lines; copying again
//     reuses them; one undo removes the second copy and its stop links
//   - a frequency-only route copies with matching trip counts; stops:false adds no Points
//
// The mini fixture gives F1 no shape, so this test gives it one (SH_F1_0) before loading.
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see test/browser/README.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gtfs-copy-service.test.mjs");

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
mini["trips.txt"] = mini["trips.txt"].replace(/^(F1,.*,)(\r?)$/gm, "$1SH_F1_0$2");
mini["shapes.txt"] = mini["shapes.txt"].replace(/\s*$/, "\n") +
  "SH_F1_0,39.7400,-104.9900,1,0\nSH_F1_0,39.7300,-104.9900,2,1.1\n";

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
    check("0. mini feed loads", loaded === true);

    const lineInfo = (idxs) => page.evaluate((ix) => ix.map((i) => {
      const p = App.lines[i].properties, a = p.attributes || {};
      return { idx: i, id: p.lineIdx, name: p.name, serviceId: a.serviceId, direction: a.direction || "",
        runTime: a.runTime, avgSpeed: a.avgSpeed, service: a.service, notes: a.notes };
    }), idxs);
    const pointInfo = () => page.evaluate(() => App.points.map((p) => {
      const a = p.properties.attributes || {};
      return { name: p.properties.name, stopId: a.stopId, group: a.group,
        links: (a.associatedRoutes || []).map((r) => r.featureType + ":" + r.featureId).sort() };
    }));
    const bandTrips = (lines, day) => page.evaluate(([ls, d]) => ls.reduce((n, l) =>
      n + ((l.service && l.service[d]) || []).reduce((m, b) => m + GtfsSchedule.bandTripCount(b.from, b.to, b.frequency), 0), 0),
      [lines, day]);
    const shapedTrips = (routeId, day) => page.evaluate(([r, d]) => {
      const f = App.gtfsSchedule();
      const date = GtfsSchedule.busiestDate(f, d);
      return GtfsSchedule.tripsOnDate(f, date, { routeIds: [r] }).trips.filter((t) => t.shapeId).length;
    }, [routeId, day]);

    // 1
    check("1. gtfsHasSchedule(B1) is true", await page.evaluate(() => App.gtfsHasSchedule("B1")) === true);

    // 2-5
    const n0 = await page.evaluate(() => App.lines.length);
    const p0 = await page.evaluate(() => App.points.length);
    const made = await page.evaluate(() => { const r = App.gtfsCopy({ routeId: "B1", mode: "service" });
      window.__first = r; return { idx: Array.from(r), note: r.note, stops: r.stops }; });
    const L1 = await lineInfo(made.idx);
    check("2. one line per plan shape, each with serviceId, weekday bands and a run time",
      L1.length === 2 && L1.every((l) => l.serviceId === "B1" && l.service && l.service.weekday.length >= 1 && l.runTime > 0),
      JSON.stringify(L1));
    const wkExpected = await shapedTrips("B1", "weekday");
    const wkGot = await bandTrips(L1, "weekday");
    check("3. weekday band trips equal the timetable's shaped trips", wkGot === wkExpected && wkExpected > 0,
      "bands " + wkGot + " vs timetable " + wkExpected);
    check("3b. Saturday band trips equal the timetable's",
      await bandTrips(L1, "saturday") === await shapedTrips("B1", "saturday"));
    const dirs = L1.map((l) => l.direction).sort().join(",");
    // Route Costing defaults to speed mode, so the copy must cost there without setup too.
    const svc = await page.evaluate(() => App.buildTransitServices({ runtimeMode: "speed" }).filter((s) => s.key === "service-B1").map((s) => ({
      n: s.patterns.length, blocking: App.hasBlockingWarnings(s), warns: s.warnings.map((w) => w.msg) })));
    check("4. directions Outbound + Inbound, one Service, no blocking warnings in speed mode, avgSpeed set",
      dirs === "Inbound,Outbound" && svc.length === 1 && svc[0].n === 2 && svc[0].blocking === false &&
      L1.every((l) => l.avgSpeed > 0), dirs + " " + JSON.stringify(svc));
    const P1 = await pointInfo();
    const ids = L1.map((l) => "line:" + l.id).sort();
    check("5. three stop points, each with stopId and links to both lines",
      P1.length - p0 === 3 && ["S1", "S2", "S3"].every((s) => P1.some((p) => p.stopId === s && JSON.stringify(p.links) === JSON.stringify(ids) && p.group === "B1 stops")) &&
      made.stops.created === 3 && made.stops.reused === 0, JSON.stringify({ P1, stops: made.stops }));

    // 6
    const made2 = await page.evaluate(() => { const r = App.gtfsCopy({ routeId: "B1", mode: "service" });
      return { idx: Array.from(r), stops: r.stops, note: r.note }; });
    const L2 = await lineInfo(made2.idx);
    const P2 = await pointInfo();
    const ids2 = L1.concat(L2).map((l) => "line:" + l.id).sort();
    check("6. second copy adds no points and extends every stop's links",
      L2.length === 2 && L2.every((l) => l.serviceId === "B1 (2)") && P2.length === P1.length &&
      made2.stops.created === 0 && made2.stops.reused === 3 &&
      P2.every((p) => JSON.stringify(p.links) === JSON.stringify(ids2)), JSON.stringify({ P2, stops: made2.stops }));

    // 7
    await page.evaluate(() => App.undo.undo());
    const P3 = await pointInfo();
    check("7. one undo removes the second copy and its stop links",
      await page.evaluate(() => App.lines.length) === n0 + 2 && JSON.stringify(P3) === JSON.stringify(P1),
      "lines " + await page.evaluate(() => App.lines.length) + " (want " + (n0 + 2) + ")");

    // 8
    check("8. note names the weekday and its trip count",
      /weekday/i.test(made.note) && new RegExp(wkExpected + " trips").test(made.note) && /3 stops copied, 0 already on the map/.test(made.note),
      made.note);

    // 9
    check("9a. gtfsHasSchedule(F1) is true", await page.evaluate(() => App.gtfsHasSchedule("F1")) === true);
    const f1 = await page.evaluate(() => { const r = App.gtfsCopy({ routeId: "F1", mode: "service" });
      return { idx: Array.from(r), stops: r.stops, note: r.note }; });
    const LF = await lineInfo(f1.idx);
    const f1Exp = await shapedTrips("F1", "weekday");
    check("9. frequency route copies with bands whose trip count matches",
      LF.length === 1 && await bandTrips(LF, "weekday") === f1Exp && f1Exp > 0 && LF[0].direction === "Both" &&
      await bandTrips(LF, "saturday") === await shapedTrips("F1", "saturday"),
      JSON.stringify({ LF: LF[0], f1Exp, note: f1.note }));
    check("9b. F1's stop S1 is reused from the B1 copy; F2 is new",
      f1.stops.reused === 1 && f1.stops.created === 1, JSON.stringify(f1.stops));

    // 10
    const pBefore = await page.evaluate(() => App.points.length), lBefore = await page.evaluate(() => App.lines.length);
    const noStops = await page.evaluate(() => { const r = App.gtfsCopy({ routeId: "B1", mode: "service", stops: false });
      return { n: r.length, stops: r.stops, note: r.note }; });
    check("10. stops:false adds lines but no points",
      noStops.n === 2 && await page.evaluate(() => App.points.length) === pBefore &&
      await page.evaluate(() => App.lines.length) === lBefore + 2 && !/stops copied/.test(noStops.note),
      JSON.stringify(noStops));

    // 11
    check("11. gtfsHasSchedule is false for an unknown route",
      await page.evaluate(() => App.gtfsHasSchedule("nope")) === false);

    check("12. no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
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
