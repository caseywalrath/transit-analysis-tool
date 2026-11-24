#!/usr/bin/env node
// test/browser/travelshed-schedule.test.mjs
//
// Transit Travelshed in "Schedule (GTFS + proposals)" mode, end to end through the panel.
// Grid: 30x30 residential streets (synthetic Overpass payload), ~220 m (N-S) x ~170 m (E-W) blocks.
// One drawn Route runs east along row 5 from column 3 to column 27 (~4.1 km, 8 min end to end), a trip
// every 10 min from 06:00 to 10:00, no stop Points (so stops every 0.25 mi). The origin sits 66 m off the
// route's west end, so a rider boards within a minute's walk and rides to the far end.
//   far point = column 26 on the route: ~3.9 km (47 min) on foot, so only riding reaches it in 30 min.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/travelshed-schedule.test.mjs
// Set TS_SHOTS_DIR to a folder to also save light and dark screenshots of the results there.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/travelshed-schedule.test.mjs");

const LAT0 = 39.712, LNG0 = -105.02, N = 30, D = 0.002;
const ROW = LAT0 + 5 * D;
function overpassPayload() {
  const el = []; let id = 9000;
  const P = (i, j) => ({ lat: LAT0 + i * D, lon: LNG0 + j * D });
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (j + 1 < N) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i, j + 1)] });
    if (i + 1 < N) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i + 1, j)] });
  }
  return JSON.stringify({ elements: el });
}

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
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("overpass-api.de")) {
        route.fulfill({ status: 200, contentType: "application/json", body: overpassPayload() });
        return true;
      }
      return false;
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    await page.evaluate(() => App.fetchRoadNetwork());
    await page.waitForFunction("App.roadNetworkLoaded()", { timeout: 30000 });

    const originLL = [LNG0 + 3 * D, ROW + 0.3 * D];
    const farLL = [LNG0 + 26 * D, ROW];
    const baseSettings = { v: 3, origin: originLL, budgets: [15, 30, null], serviceMode: "schedule",
      windowFrom: "07:00", windowTo: "08:00", stepMin: 2, statistic: "typical", includeHidden: false };

    // The drawn Route plus the saved module settings, applied the way a session restore does.
    const applyScene = (settings, endJ = 27, runTime = 8) => page.evaluate(({ LNG0, ROW, D, settings, endJ, runTime }) => {
      const st = App.cache.collectState("full");
      const a = [LNG0 + 3 * D, ROW], b = [LNG0 + endJ * D, ROW];
      st.routes = [{ type: "Feature",
        properties: { name: "Test route", routeIdx: 1, waypoints: [a, b],
          attributes: { direction: "Both", runTime,
            service: { weekday: [{ from: "06:00", to: "10:00", frequency: 10 }], saturday: [], sunday: [] } } },
        geometry: { type: "LineString", coordinates: [a, b] } }];
      st.points = [];
      st.moduleState = st.moduleState || {};
      st.moduleState["transit-travelshed"] = settings;
      App.cache.applyState(st);
    }, { LNG0, ROW, D, settings, endJ, runTime });

    // Restored settings reach the inputs only when the panel opens, so close it first.
    const reopen = async () => {
      await page.evaluate(() => { if (App.popup.isOpen()) App.popup.close(); App.openModulePopup("transit-travelshed"); });
      await page.locator("#tsRunBtn").waitFor({ state: "attached", timeout: 10000 });
    };
    await applyScene(baseSettings);
    await reopen();
    await page.locator("#tsRunBtn").waitFor({ state: "attached", timeout: 10000 });

    // ---- Mode switch shows and hides the right inputs ----
    const vis = (id) => page.evaluate((i) => { const el = document.getElementById(i); return !!(el && el.offsetParent !== null); }, id);
    const schedVis = { from: await vis("tsWindowFrom"), step: await vis("tsStepMin"), stat: await vis("tsStatistic"),
      hid: await vis("tsIncludeHidden"), date: await vis("tsDateLine"), access: await vis("tsAccessWalk") };
    const headVis = { day: await vis("tsDayType"), wait: await vis("tsMaxWait") || await vis("tsRouteList"), spacing: await vis("tsStopSpacing"), shed: await vis("tsShedMode") };
    check("schedule mode shows the window, step, statistic, hidden box, date line and walk caps",
      Object.values(schedVis).every(Boolean), JSON.stringify(schedVis));
    check("schedule mode hides day/time, route list, stop spacing and shed mode", Object.values(headVis).every((v) => !v), JSON.stringify(headVis));
    check("no feed: the date line says drawn Services only",
      (await page.locator("#tsDateLine").textContent()) === "No GTFS feed: drawn Services only.");

    const shapes = () => page.evaluate(() => {
      const src = App.map.getSource("ts-travelshed");
      return src && src._data ? src._data.features.map((f) => ({ band: f.properties.band, area: turf.area(f), geom: f })) : [];
    });
    const totalArea = (fs) => fs.reduce((t, f) => t + f.area, 0);
    // The ring-differenced bands, unioned back into the largest band's footprint.
    const insideAny = (pt) => page.evaluate((p) => {
      const fs = App.map.getSource("ts-travelshed")._data.features;
      return fs.some((f) => turf.booleanPointInPolygon(turf.point(p), f));
    }, pt);
    const runUi = async () => {
      await page.evaluate(() => {
        const t = document.getElementById("tsResultsTable"); if (t) t.innerHTML = "";
        window.__t0 = performance.now();
        document.getElementById("tsRunBtn").click();
      });
      await page.waitForFunction(() => {
        const st = document.getElementById("tsStatus");
        return st && !st.classList.contains("rf-status-running") && st.style.display !== "none" &&
          !st.classList.contains("rf-status-stale") && /Calculated|No stops|No service|Set a departure/.test(st.textContent);
      }, { timeout: 60000 });
      return page.evaluate(() => ({ ms: Math.round(performance.now() - window.__t0), status: document.getElementById("tsStatusText").textContent }));
    };
    const setField = async (id, value) => {
      await page.evaluate(({ id, value }) => {
        const el = document.getElementById(id);
        if (el.type === "checkbox") el.checked = !!value; else el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, { id, value });
    };

    // ---- (a) typical run: bands drawn, the largest contains the origin ----
    const typ = await runUi();
    const typFs = await shapes();
    const typArea = totalArea(typFs);
    check("(a) schedule mode draws two bands", typFs.length === 2 && typFs.every((f) => f.area > 0) && /Calculated/.test(typ.status), JSON.stringify({ n: typFs.length, status: typ.status }));
    check("(a) the largest band contains the origin", await insideAny(originLL));
    const summary = await page.locator("#tsRouteDetail").textContent();
    check("(a) summary line: 30 departures, window, step, statistic, stops",
      /30 departures 07:00–08:00 every 2 min · typical \(median\) · \d+ stops within reach · \d+ stops within walk of the origin/.test(summary), summary.slice(0, 200));
    check("(a) results note the no-feed day type, proposals note and the transfer rule",
      /drawn Services only \(weekday bands\)/.test(summary) && /evenly spaced trips/.test(summary) &&
      /Transfers: walk up to ¼ mi, straight line × 1\.3/.test(summary), summary.slice(-300));
    check("(a) no off-street note when every reached stop is on the streets", !/beyond the loaded streets/.test(summary));
    const legendNote = await page.evaluate(() => { const r = document.getElementById("tsLegendRow0"); return r.parentNode.lastElementChild.textContent.trim(); });
    check("legend footnote names scheduled trips and two transfers in schedule mode",
      legendNote === "Walk → ride scheduled trips → walk, ≤2 transfers.", legendNote);
    check("results footer has no duplicate routing line", !/Routing took/.test(summary) && /routing \d+ ms/.test(await page.locator("#tsResultsTable").textContent()));
    const headCells = await page.evaluate(() => Array.from(document.querySelectorAll("#tsResultsTable th")).map((th) => th.textContent));
    check("(a) results table is Budget and Area only", JSON.stringify(headCells) === JSON.stringify(["Budget", "Area"]), JSON.stringify(headCells));
    const ridingMs = await page.evaluate(() => (document.getElementById("tsResultsTable").textContent.match(/(\d+) ms total · routing (\d+) ms/) || []).slice(1).map(Number));

    // ---- (b) far point: reachable only by riding ----
    const farIn = await insideAny(farLL);
    check("(b) the far stop (47 min on foot) is inside the typical band", farIn);

    // ---- (c) statistics: best >= typical >= worst in area (best = shortest times) ----
    await setField("tsStatistic", "best");
    const bestRun = await runUi(); const bestArea = totalArea(await shapes());
    await setField("tsStatistic", "worst");
    const worstRun = await runUi(); const worstArea = totalArea(await shapes());
    check("(c) Best case area > Typical > Worst case area (shorter times reach farther)",
      bestArea > typArea && typArea > worstArea, [bestArea, typArea, worstArea].map((a) => Math.round(a / 4046.86) + " ac").join(" / "));
    check("(c) statistic shows in the summary", /worst case \(90th percentile\)/.test(await page.locator("#tsRouteDetail").textContent()) && /Calculated/.test(worstRun.status) && /Calculated/.test(bestRun.status));
    await setField("tsStatistic", "typical");

    // ---- (d) a window with no trips: walk area only, and the far stop is out ----
    await setField("tsWindowFrom", "03:00");
    await setField("tsWindowTo", "04:00");
    const emptyRun = await runUi();
    const emptyFs = await shapes();
    const emptyArea = totalArea(emptyFs);
    const emptySummary = await page.locator("#tsRouteDetail").textContent();
    const capKm = 0.5 * 1.609344;
    const circleKm2 = Math.PI * Math.pow(capKm + 0.1, 2);   // access cap + the 330 ft off-street reach
    check("(d) no trips in the window: no stop reached by a ride, only the access-capped walk area",
      /\b0 stops within reach · \d+ stops within walk of the origin/.test(emptySummary) && emptyFs.length > 0 && emptyArea > 0 && emptyArea / 1e6 <= circleKm2 * 1.05 && emptyArea < typArea * 0.5,
      (emptyArea / 1e6).toFixed(2) + " km2 vs bound " + circleKm2.toFixed(2) + ", typical " + (typArea / 1e6).toFixed(2) + " (" + emptyRun.status + ")");
    check("(b) the far stop is not inside the walk-only bands", !(await insideAny(farLL)));
    check("(d) the origin is still inside the walk-only band", await insideAny(originLL));
    await setField("tsWindowFrom", "07:00");
    await setField("tsWindowTo", "08:00");

    // ---- no stop within walking distance of the origin ----
    const farOrigin = [LNG0 + 3 * D, LAT0 + 25 * D];
    await applyScene(Object.assign({}, baseSettings, { origin: farOrigin }));
    await reopen();
    await page.locator("#tsRunBtn").waitFor({ state: "attached", timeout: 10000 });
    const noAccess = await runUi();
    const noAccessFs = await shapes();
    check("no stops near the origin: status says so and the walk-only band is still drawn",
      /^No stops within walking distance of the origin\./.test(noAccess.status) && noAccessFs.length > 0, noAccess.status);

    // ---- hidden Services ----
    await applyScene(baseSettings);
    await page.evaluate(() => { App.routes[0].properties.hidden = true; App.notifyProject(); });
    await reopen();
    const hid1 = await runUi();
    check("hidden Service is left out: no service to route", /No service/.test(hid1.status), hid1.status);
    await setField("tsIncludeHidden", true);
    const hid2 = await runUi();
    check("Include hidden brings it back", /Calculated/.test(hid2.status), hid2.status);
    await setField("tsIncludeHidden", false);
    await page.evaluate(() => { App.routes[0].properties.hidden = false; App.notifyProject(); });
    const again = await runUi();
    check("unhidden run is clean again", /Calculated/.test(again.status), again.status);

    // ---- Stops beyond the loaded streets: the route runs ~1.9 km past the grid's east edge ----
    await applyScene(baseSettings, 40, 12);
    await reopen();
    const offRun = await runUi();
    const offText = await page.locator("#tsRouteDetail").textContent();
    const offN = +((offText.match(/(\d+) reached stops are beyond the loaded streets, so no walk is drawn from them\./) || [])[1] || 0);
    check("stops past the street grid are counted and the note is shown", /Calculated/.test(offRun.status) && offN > 0, offRun.status + " / " + offN + " off-street stops");
    await applyScene(baseSettings);
    await reopen();
    await runUi();

    // ---- Screenshots of a results state ----
    const shots = process.env.TS_SHOTS_DIR || "";
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, "travelshed-schedule-light.png") });
      await page.evaluate(() => document.body.classList.add("dark-mode"));
      // Buttons ease their colors; let the transition finish before capturing.
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shots, "travelshed-schedule-dark.png") });
      await page.evaluate(() => document.body.classList.remove("dark-mode"));
    }

    // Dark mode must restyle the Export button through the shared tokens (not stay light after a toggle).
    const btnBg = await page.evaluate(async () => {
      const b = document.getElementById("tsExportBtn");
      document.body.classList.add("dark-mode");
      await new Promise((r) => setTimeout(r, 500));
      const c = getComputedStyle(b).backgroundColor.match(/\d+/g).map(Number);
      document.body.classList.remove("dark-mode");
      return c;
    });
    check("dark mode: the Export button background is dark", (btnBg[0] + btnBg[1] + btnBg[2]) / 3 < 110, btnBg.join(","));

    // ---- (e) stale on GTFS analysis date change and on a feed load ----
    const staleNow = () => page.evaluate(() => !!document.querySelector("#tsStatus.rf-status-stale"));
    check("fresh result is not stale", !(await staleNow()));
    const loaded = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      return App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
    }, mini);
    check("mini feed loads", loaded === true);
    await page.waitForFunction(() => !!App.gtfsAnalysisDate.get(), { timeout: 10000 });
    check("(e) loading a feed marks the result stale", await staleNow());
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    const feedRun = await runUi();
    check("with the feed loaded the run works and the date line shows the analysis date",
      /Calculated/.test(feedRun.status) && /GTFS analysis date: 2026-01-12 \(weekday\) \(change it in GTFS Feed Attributes\)\./.test(await page.locator("#tsDateLine").textContent()),
      feedRun.status);
    check("the feed run reports the GTFS date and trips", /Analysis date 2026-01-12 \(weekday\)/.test(await page.locator("#tsRouteDetail").textContent()));
    check("re-run clears the stale banner", !(await staleNow()));
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260113"));
    check("(e) changing the analysis date marks the result stale", await staleNow());
    const exportBtnDisabled = await page.evaluate(() => document.getElementById("tsExportBtn").disabled);
    check("(e) export is disabled while stale", exportBtnDisabled);
    await runUi();
    check("(e) a re-run after the date change is fresh", !(await staleNow()));
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    await runUi();
    check("(e) a changed input also marks it stale", await (async () => {
      await setField("tsStepMin", 4);
      const s = await staleNow();
      await setField("tsStepMin", 2);
      return s;
    })());

    // ---- GeoJSON export metadata ----
    await runUi();
    const meta = await page.evaluate(async () => {
      let captured = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return orig.call(URL, blob); };
      document.getElementById("tsExportBtn").click();
      URL.createObjectURL = orig;
      const fc = JSON.parse(await captured.text());
      return { m: fc.metadata, n: fc.features.length };
    });
    check("export carries serviceMode, window, statistic and departures",
      meta.m.serviceMode === "schedule" && meta.m.window === "07:00-08:00" && meta.m.statistic === "typical" && meta.m.departures === 30 &&
      meta.m.analysisDate === "20260112" && meta.n === 3, JSON.stringify(meta.m));

    // ---- (f) persistence v3 round trip ----
    await setField("tsWindowFrom", "06:30");
    await setField("tsWindowTo", "09:15");
    await setField("tsStepMin", 3);
    await setField("tsStatistic", "worst");
    await setField("tsIncludeHidden", true);
    const saved = await page.evaluate(() => JSON.parse(JSON.stringify(App.cache.collectState("full"))));
    const ms3 = saved.moduleState["transit-travelshed"];
    check("(f) saved settings are v3 with the schedule fields",
      ms3.v === 3 && ms3.serviceMode === "schedule" && ms3.windowFrom === "06:30" && ms3.windowTo === "09:15" &&
      ms3.stepMin === 3 && ms3.statistic === "worst" && ms3.includeHidden === true, JSON.stringify(ms3));
    // v2 payload: loads as headway mode, schedule fields ignored.
    const v2 = JSON.parse(JSON.stringify(saved));
    v2.moduleState["transit-travelshed"] = { v: 2, origin: originLL, budgets: [15, 30, null], serviceMode: "schedule", statistic: "best" };
    await page.evaluate((st) => App.cache.applyState(st), v2);
    const afterV2 = await page.evaluate(() => App.cache.collectState("full").moduleState["transit-travelshed"]);
    check("(f) a v2 session loads as headway mode and ignores any schedule fields",
      afterV2.serviceMode === "headway" && afterV2.v === 3 && afterV2.statistic === "worst", JSON.stringify(afterV2));
    await page.evaluate((st) => App.cache.applyState(st), saved);
    const afterV3 = await page.evaluate(() => App.cache.collectState("full").moduleState["transit-travelshed"]);
    check("(f) restoring the v3 payload brings the schedule settings back",
      afterV3.serviceMode === "schedule" && afterV3.windowFrom === "06:30" && afterV3.windowTo === "09:15" &&
      afterV3.stepMin === 3 && afterV3.statistic === "worst" && afterV3.includeHidden === true, JSON.stringify(afterV3));
    await reopen();
    const inputsBack = await page.evaluate(() => ({ mode: document.getElementById("tsServiceMode").value,
      from: document.getElementById("tsWindowFrom").value, to: document.getElementById("tsWindowTo").value,
      step: document.getElementById("tsStepMin").value, stat: document.getElementById("tsStatistic").value,
      hid: document.getElementById("tsIncludeHidden").checked }));
    check("(f) the panel inputs show the restored values",
      inputsBack.mode === "schedule" && inputsBack.from === "06:30" && inputsBack.to === "09:15" && inputsBack.step === "3" &&
      inputsBack.stat === "worst" && inputsBack.hid === true, JSON.stringify(inputsBack));

    // ---- (g) back to headway mode: the headway inputs return ----
    await setField("tsServiceMode", "headway");
    // The inputs are collapsed after a run, so read the wrappers' own display rather than layout visibility.
    const shown = (sel) => page.evaluate((q) => { const els = document.querySelectorAll(q); return els.length > 0 && Array.from(els).every((e) => e.style.display === ""); }, sel);
    const hidden = (sel) => page.evaluate((q) => { const els = document.querySelectorAll(q); return els.length > 0 && Array.from(els).every((e) => e.style.display === "none"); }, sel);
    const back = { headway: await shown(".ts-body .ts-headway-only"), schedule: await hidden(".ts-body .ts-schedule-only") };
    check("(g) headway mode shows its inputs and hides the schedule ones",
      back.headway && back.schedule, JSON.stringify(back));

    check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
    console.log("  timing: typical run " + typ.ms + " ms wall (table: total/routing " + ridingMs.join("/") + " ms); best " + bestRun.ms + " ms; worst " + worstRun.ms + " ms; empty window " + emptyRun.ms + " ms");
  } catch (e) {
    check("test ran", false, e && e.stack || String(e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer();
  }
  const passed = results.filter((x) => x.pass).length;
  console.log((passed === results.length ? "PASS" : "FAIL") + " — " + passed + "/" + results.length + " checks passed");
  process.exit(passed === results.length ? 0 : 1);
})();
