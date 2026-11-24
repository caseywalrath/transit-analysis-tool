#!/usr/bin/env node
// test/browser/analysis-network.test.mjs
//
// App.buildAnalysisNetwork (js/core/analysis-network-source.js): the GTFS trips of the analysis date
// plus synthetic trips for drawn Services, with stop times by distance along the line. The drawn
// Service here is the mini feed's B1 copied with its schedule, so its band trip counts are known.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/analysis-network.test.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/analysis-network.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const MINI_DIR = join(REPO_ROOT, "test", "fixtures", "gtfs", "mini");
const mini = {};
["agency", "calendar", "calendar_dates", "frequencies", "routes", "shapes", "stop_times", "stops", "trips"]
  .forEach((n) => { mini[n + ".txt"] = readFileSync(join(MINI_DIR, n + ".txt"), "utf8"); });

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

    const empty = await page.evaluate(() => {
      const n = App.buildAnalysisNetwork({});
      return { stops: n.stops.length, trips: n.trips.length, notes: n.notes.length };
    });
    check("nothing loaded or drawn → empty network", empty.stops === 0 && empty.trips === 0 && empty.notes === 0, JSON.stringify(empty));

    const loaded = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      const ok = await App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
      App.gtfsAnalysisDate.set("20260112");
      return ok;
    }, mini);
    check("mini feed loads", loaded === true);

    const g = await page.evaluate(() => {
      const n = App.buildAnalysisNetwork({ proposals: false });
      const want = GtfsSchedule.tripsOnDate(App.gtfsSchedule(), "20260112", { routeIds: App.gtfsScopeRouteIds(false) }).trips.length;
      return { trips: n.trips.length, want, allG: n.trips.every((t) => t.source === "gtfs" && t.id.indexOf("g:") === 0),
        dayType: n.dayType, counts: n.counts };
    });
    check("GTFS only: one trip per trip on the date", g.trips === g.want && g.allG && g.dayType === "weekday", JSON.stringify(g));

    await page.evaluate(() => { window.__copy = App.gtfsCopy({ routeId: "B1", mode: "service" }); });
    const p = await page.evaluate(() => {
      const n = App.buildAnalysisNetwork({});
      const svcKeys = Object.keys(n.routes).filter((k) => n.routes[k].source === "drawn");
      const dTrips = n.trips.filter((t) => t.source === "drawn");
      const lines = Array.from(window.__copy).map((i) => App.lines[i]);
      const want = lines.reduce((s, l) => s + (l.properties.attributes.service.weekday || [])
        .reduce((m, b) => m + GtfsSchedule.bandTripCount(b.from, b.to, b.frequency), 0), 0);
      let ordered = true;
      dTrips.forEach((t) => {
        for (let i = 1; i < t.dep.length; i++) if (t.dep[i] < t.dep[i - 1]) ordered = false;
      });
      const rts = lines.map((l) => l.properties.attributes.runTime);
      const spans = dTrips.map((t) => (t.dep[t.dep.length - 1] - t.dep[0]) / 60);
      const dStops = n.stops.filter((s) => s.source === "drawn");
      const svc = AnalysisNetwork.stopService(n, App.gtfsDayParts.get());
      const dServed = svc.filter((r) => r.stopId.indexOf("d:") === 0).length;
      return { svcKeys, dTrips: dTrips.length, want, ordered, rts, maxSpan: Math.max.apply(null, spans),
        minSpan: Math.min.apply(null, spans), dStops: dStops.length, pointIds: dStops.every((s) => /^d:point-\d+$/.test(s.id)),
        notes: n.notes, skipped: n.proposalsSkipped, gTrips: n.trips.length - dTrips.length, dServed };
    });
    check("copied B1 becomes one drawn route key", p.svcKeys.length === 1, JSON.stringify(p.svcKeys));
    check("drawn trips = the weekday band trip count", p.dTrips === p.want && p.dTrips > 0, p.dTrips + " vs " + p.want);
    check("drawn stop times rise along the trip", p.ordered);
    check("first to last stop takes at most the run time", p.maxSpan <= Math.max.apply(null, p.rts) + 1e-9 && p.minSpan > 0,
      "span " + p.minSpan + "–" + p.maxSpan + " min, run times " + p.rts.join("/"));
    check("drawn stops are the copied stop Points", p.dStops > 0 && p.pointIds, p.dStops + " stops");
    check("results note the even-headway assumption", p.notes.length === 1 && /evenly spaced/.test(p.notes[0]));
    check("GTFS trips unchanged with proposals added", p.gTrips === g.trips);
    check("stopService counts drawn stops", p.dServed > 0 && p.dServed <= p.dStops);

    const h = await page.evaluate(() => {
      Array.from(window.__copy).forEach((i) => { App.lines[i].properties.hidden = true; });
      const a = App.buildAnalysisNetwork({});
      const b = App.buildAnalysisNetwork({ includeHidden: true });
      Array.from(window.__copy).forEach((i) => { App.lines[i].properties.hidden = false; });
      const only = App.buildAnalysisNetwork({ gtfs: false });
      const none = App.buildAnalysisNetwork({ proposals: ["no-such-key"] });
      return { a: a.trips.filter((t) => t.source === "drawn").length, skipped: a.proposalsSkipped,
        b: b.trips.filter((t) => t.source === "drawn").length,
        onlyG: only.trips.filter((t) => t.source === "gtfs").length, onlyD: only.trips.length,
        noneD: none.trips.filter((t) => t.source === "drawn").length };
    });
    check("a hidden Service is skipped and named", h.a === 0 && h.skipped.length === 1 && h.skipped[0].reason === "hidden", JSON.stringify(h.skipped));
    check("Include hidden brings it back", h.b === p.dTrips);
    check("gtfs:false → proposals only", h.onlyG === 0 && h.onlyD === p.dTrips);
    check("proposals list filters by Service key", h.noneD === 0);

    const sp = await page.evaluate(() => {
      // A drawn line with a schedule but no stop Points gets stops every 0.25 mi.
      const f = turf.lineString([[-104.99, 39.74], [-104.99, 39.7255]], { name: "Spaced", lineIdx: 9001,
        attributes: { direction: "Both", runTime: 10,
          service: { weekday: [{ from: "07:00", to: "08:00", frequency: 30 }], saturday: [], sunday: [] } } });
      App.lines.push(f);
      const n = App.buildAnalysisNetwork({ gtfs: false });
      App.lines.pop();
      const trips = n.trips.filter((t) => t.routeKey.indexOf("Spaced") >= 0 || t.routeKey.indexOf("9001") >= 0);
      const lenMi = turf.length(f, { units: "miles" });
      return { trips: trips.length, stops: trips.length ? trips[0].stops.length : 0, lenMi,
        dirs: Array.from(new Set(trips.map((t) => t.directionId))).sort() };
    });
    check("a Service without stops gets evenly spaced stops, both ways", sp.trips === 4 &&
      sp.stops === Math.round(sp.lenMi / 0.25) + 1 && sp.dirs.join() === "0,1", JSON.stringify(sp));

    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("test ran", false, e && e.stack || String(e));
  } finally {
    if (browser) await browser.close();
    stopServer();
  }
  const passed = results.filter((x) => x.pass).length;
  console.log((passed === results.length ? "PASS" : "FAIL") + " — " + passed + "/" + results.length + " checks passed");
  process.exit(passed === results.length ? 0 : 1);
})();
