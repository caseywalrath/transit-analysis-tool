#!/usr/bin/env node
// test/browser/transit-coverage-gtfs.test.mjs
//
// Transit Coverage on GTFS routes (js/projects/transit-coverage.js), against the real app in headless
// Chromium and the mini fixture (test/fixtures/gtfs/mini, analysis date 2026-01-12). TIGERweb and the
// ACS API are stubbed the way faa-gtfs-stops.test.mjs does, residents are counted by land area (no block
// download), and the covered area is read from the map overlay's GeoJSON source, so the checks measure
// geometry rather than census numbers.
//
// Stops with a departure on 2026-01-12 (a terminus such as F2 has none, so it is not a coverage stop) and
// their buffers (bus 1/4 mi, rail 1/2 mi): B1 S1 S2 S3, F1 S1 (bus), R1 P1 R2 (rail). They are all more
// than 0.75 mi apart, so the circles do not overlap and areas add up.
//
//   - the GTFS section is absent without a feed; with one it lists B1/R1/F1 with the right mode tags
//   - unchecking R1 drops its stops; the rail buffer is bigger than the bus one
//   - the headway threshold keeps only stops whose COMBINED peak headway is within it
//   - along streets: no network -> straight line and a note; a synthetic network -> a different shape,
//     stops beyond it measured in a straight line and counted
//   - hiding F1 marks results stale and Re-run drops it; CSV lines; session v3 and a v2 payload
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/transit-coverage-gtfs.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/transit-coverage-gtfs.test.mjs");

const SHOTS = "/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/a6/shots";
mkdirSync(SHOTS, { recursive: true });

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

// Street grid around S1/S2/S3/P1/F2 (-105.02..-104.96, 39.70..39.78); R2 (39.85, -104.67) is far outside.
const LAT0 = 39.70, LNG0 = -105.02, NI = 41, NJ = 31, D = 0.002;
function overpassPayload() {
  const el = []; let id = 9000;
  const P = (i, j) => ({ lat: LAT0 + i * D, lon: LNG0 + j * D });
  for (let i = 0; i < NI; i++) for (let j = 0; j < NJ; j++) {
    if (j + 1 < NJ) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i, j + 1)] });
    if (i + 1 < NI) el.push({ type: "way", id: id++, tags: { highway: "residential" }, geometry: [P(i, j), P(i + 1, j)] });
  }
  return JSON.stringify({ elements: el });
}

const SQ_MI = 2589988.110336;
const ALL = ["B1", "R1", "F1"];
const STOPS = { S1: [-104.99, 39.74], S2: [-104.98, 39.74], S3: [-104.97, 39.74], P1: [-105.0001, 39.7501],
  R2: [-104.67, 39.85], F2: [-104.99, 39.73] };

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("overpass-api.de")) {
        route.fulfill({ status: 200, contentType: "application/json", body: overpassPayload() });
        return true;
      }
      if (url.includes("tigerweb.geo.census.gov")) {
        const ring = [[-106, 38.5], [-103, 38.5], [-103, 41], [-106, 41], [-106, 38.5]];
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          type: "FeatureCollection", features: [{ type: "Feature", properties: { GEOID: "080010001001" },
            geometry: { type: "Polygon", coordinates: [ring] } }] }) });
        return true;
      }
      if (url.includes("api.census.gov")) {
        const get = decodeURIComponent((url.match(/[?&]get=([^&]*)/) || [])[1] || "");
        const vars = get.split(",").filter((v) => v !== "NAME");
        const hdr = ["NAME", ...vars, "state", "county", "tract", "block group"];
        const row = ["bg", ...vars.map(() => "100"), "08", "001", "000100", "1"];
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([hdr, row]) });
        return true;
      }
      return false;
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && App.gtfsStore", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());

    const waitFor = (fn, arg, ms) => page.waitForFunction(fn, arg, { timeout: ms || 30000 }).then(() => true, () => false);
    const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
    const setVal = (sel, v) => page.evaluate(([s, val]) => {
      const el = document.querySelector(s); el.value = val; el.dispatchEvent(new Event("change", { bubbles: true }));
    }, [sel, v]);
    const statusText = () => page.evaluate(() => document.getElementById("tcStatus").textContent);

    // One run: click Analyze and wait for it to finish (the status leaves "Analyzing…" at once).
    async function run() {
      await click("#tcRunBtn");
      const ok = await waitFor(() => /Analyzed coverage|Error/.test(document.getElementById("tcStatus").textContent));
      const st = await statusText();
      if (!/Analyzed coverage/.test(st)) console.log("    run status: " + st.trim());
      return ok && /Analyzed coverage/.test(st);
    }
    // Area (sq mi) of the coverage / threshold fill on the map, and which named stops it contains.
    const geo = (kind) => page.evaluate(([k, stops]) => {
      const src = App.map.getSource("transit-coverage-fill");
      const f = src && src._data && src._data.features.find((x) => x.properties.kind === k);
      if (!f) return null;
      const inside = {};
      Object.keys(stops).forEach((id) => { inside[id] = turf.booleanPointInPolygon(turf.point(stops[id]), f); });
      return { area: turf.area(f) / 2589988.110336, inside };
    }, [kind, STOPS]);
    const setChecked = (ids) => page.evaluate((want) => {
      document.querySelectorAll("#tcGtfsList input[type=checkbox]").forEach((cb) => {
        const on = want.indexOf(cb.getAttribute("data-route-id")) >= 0;
        if (cb.checked !== on) cb.click();
      });
    }, ids);
    const near = (a, b, tol) => Math.abs(a - b) / b <= tol;

    // ---- 1. no feed ----
    await page.evaluate(() => App.openModulePopup("transit-coverage"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.waitForSelector("#tcFeatureList");
    check("1. no feed loaded: the GTFS routes section and the stop-buffer fields are hidden",
      await page.evaluate(() => getComputedStyle(document.getElementById("tcGtfsSection")).display === "none" &&
        getComputedStyle(document.getElementById("tcGtfsBuffers")).display === "none"));

    // Service-area polygon around the whole mini feed (and the street grid).
    await page.evaluate(() => {
      const st = App.cache.collectState("full");
      st.labels = []; st.points = []; st.lines = []; st.routes = []; st.polygons = [{
        type: "Feature", properties: { name: "Service area", polyIdx: 1, attributes: {} },
        geometry: { type: "Polygon", coordinates: [[[-105.1, 39.65], [-104.5, 39.65], [-104.5, 39.95], [-105.1, 39.95], [-105.1, 39.65]]] } }];
      App.cache.applyState(st);
      App.refreshFeaturePanel();
    });

    // ---- 2. feed loaded ----
    await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      await App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
      App.gtfsAnalysisDate.set("20260112");
    }, mini);
    await waitFor(() => document.querySelectorAll("#tcGtfsList input[type=checkbox]").length === 3);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll("#tcGtfsList .rf-feature-check-row")).map((r) => ({
      id: r.querySelector("input").getAttribute("data-route-id"), checked: r.querySelector("input").checked,
      name: r.querySelector("label").textContent, mode: r.querySelector(".rf-feature-type-badge").textContent,
      chip: !!r.querySelector(".tc-route-chip") })));
    check("2. feed loaded: GTFS section visible with B1 (bus), F1 (bus), R1 (rail), all checked, each with a colour chip",
      rows.length === 3 && rows.every((r) => r.checked && r.chip) &&
      rows.find((r) => r.id === "B1").mode === "bus" && rows.find((r) => r.id === "F1").mode === "bus" &&
      rows.find((r) => r.id === "R1").mode === "rail" && rows.map((r) => r.name).join() === "B1,F1,R1", JSON.stringify(rows));
    const dateText = await page.evaluate(() => document.getElementById("tcGtfsDate").textContent);
    check("3. the analysis date is shown read-only with a pointer to the GTFS panel",
      dateText.includes("2026-01-12") && /GTFS panel/.test(dateText), dateText);
    check("4. the bus and rail stop-buffer fields appear, defaulting to 0.25 and 0.5 mi, and Distance measured is Straight line",
      await page.evaluate(() => getComputedStyle(document.getElementById("tcGtfsBuffers")).display !== "none" &&
        document.getElementById("tcBusBufferMi").value === "0.25" && document.getElementById("tcRailBufferMi").value === "0.5" &&
        document.getElementById("tcDistanceMode").value === "straight"));

    // ---- 5. all routes, straight line ----
    await page.evaluate(() => { document.getElementById("tcApportionMethod").value = "area"; });
    const ran = await run();
    const g1 = await geo("coverage");
    const expectAll = Math.PI * (3 * 0.25 * 0.25 + 2 * 0.5 * 0.5);
    check("5. all three routes, straight line: the run completes", ran);
    check("6. covered area = three 1/4 mi bus circles + two 1/2 mi rail circles (within 3 %)",
      !!g1 && near(g1.area, expectAll, 0.03), g1 ? g1.area.toFixed(3) + " vs " + expectAll.toFixed(3) : "no coverage");
    check("7. every stop with a departure is covered; the terminus F2 is not",
      !!g1 && ["S1", "S2", "S3", "P1", "R2"].every((s) => g1.inside[s]) && !g1.inside.F2, JSON.stringify(g1 && g1.inside));
    const resultsText = await page.evaluate(() => document.getElementById("tcResults").textContent);
    check("8. the results list one row per GTFS route and a 'GTFS stops: 5' line",
      /GTFS stops: 5/.test(resultsText) && /B1 \[bus\] \(from 3 stops\)/.test(resultsText) &&
      /R1 \[rail\] \(from 2 stops\)/.test(resultsText) && /F1 \[bus\] \(from 1 stop\)/.test(resultsText), resultsText.slice(0, 500));
    check("9. the footnote and the row label name the distance method and the bus / rail buffers",
      /straight line/.test(resultsText) && /bus 0\.25 mi \/ rail 0\.5 mi/.test(resultsText) && /2026-01-12/.test(resultsText), resultsText.slice(-300));

    await page.screenshot({ path: SHOTS + "/tc-gtfs-results-light.png" });
    await page.evaluate(() => document.body.classList.add("dark-mode"));
    await page.screenshot({ path: SHOTS + "/tc-gtfs-results-dark.png" });
    await page.evaluate(() => document.body.classList.remove("dark-mode"));

    // CSV
    const dl = page.waitForEvent("download", { timeout: 10000 });
    await click("#tcExportCSV");
    const csv = readFileSync(await (await dl).path(), "utf8");
    check("10. CSV: gtfs-stops rows, '# Analysis date:' and '# Distance measured:' lines",
      /,gtfs-stops,/.test(csv) && csv.split("\n").includes("# Analysis date: 2026-01-12") &&
      csv.split("\n").includes("# Distance measured: straight line"), csv.slice(0, 700));

    // ---- unchecking R1 ----
    await setChecked(["B1", "F1"]);
    check("11. unchecking a GTFS route marks the results stale",
      await waitFor(() => !!document.querySelector("#tcStatus.rf-status-stale"), null, 5000));
    await run();
    const g2 = await geo("coverage");
    check("12. R1 unchecked: its stops P1 and R2 drop out of the covered area",
      !!g2 && !g2.inside.P1 && !g2.inside.R2 && g2.inside.S1 && g2.inside.S3 &&
      near(g2.area, Math.PI * 3 * 0.25 * 0.25, 0.03), g2 ? g2.area.toFixed(3) + " " + JSON.stringify(g2.inside) : "none");
    await page.screenshot({ path: SHOTS + "/tc-gtfs-inputs-light.png" });

    // ---- rail vs bus buffer ----
    await setChecked(["R1"]);
    await run();
    const railBig = await geo("coverage");
    await setVal("#tcRailBufferMi", "0.25");
    check("13. changing a stop buffer marks the results stale", await waitFor(() => !!document.querySelector("#tcStatus.rf-status-stale"), null, 5000));
    await run();
    const railSmall = await geo("coverage");
    check("14. rail 0.5 mi covers four times the area of rail 0.25 mi (two rail stops)",
      !!railBig && !!railSmall && near(railBig.area / railSmall.area, 4, 0.05) && near(railBig.area, Math.PI * 2 * 0.25, 0.03),
      railBig && railSmall ? railBig.area.toFixed(3) + " / " + railSmall.area.toFixed(3) : "none");
    await setVal("#tcRailBufferMi", "0.5");

    // ---- threshold ----
    await setChecked(ALL);
    await setVal("#tcHeadwayThreshold", "15");
    await run();
    const exp = await page.evaluate(() => {
      const rows = GtfsSchedule.stopServiceTable(App.gtfsSchedule(), "20260112", { routeIds: ["B1", "R1", "F1"], dayParts: App.gtfsDayParts.get() });
      const q = {}, all = {};
      rows.forEach((r) => { all[r.stopId] = r.peakHeadwaySec; q[r.stopId] = r.peakHeadwaySec != null && r.peakHeadwaySec <= 900; });
      return { all, q };
    });
    const thr = await geo("threshold");
    const yes = Object.keys(exp.q).filter((k) => exp.q[k]), no = Object.keys(exp.q).filter((k) => !exp.q[k]);
    check("15. fixture sanity: at 15 min some stops qualify and some do not", yes.length > 0 && no.length > 0, JSON.stringify(exp.all));
    check("16. threshold area holds exactly the stops whose combined peak headway is <= 15 min",
      !!thr && yes.every((s) => thr.inside[s]) && no.every((s) => !thr.inside[s]), JSON.stringify(exp.q) + " " + JSON.stringify(thr && thr.inside));
    const rt2 = await page.evaluate(() => document.getElementById("tcResults").textContent);
    check("17. the results say 'GTFS stops: 5 (N qualify at ≤ 15 min peak headway)' with N matching",
      rt2.includes("GTFS stops: 5 (" + yes.length + " qualify at ≤ 15 min peak headway)"), rt2.slice(0, 400));
    await setVal("#tcHeadwayThreshold", "");

    // ---- along streets: no network ----
    await setVal("#tcDistanceMode", "streets");
    check("18. changing Distance measured marks the results stale", await waitFor(() => !!document.querySelector("#tcStatus.rf-status-stale"), null, 5000));
    await run();
    const noNet = await geo("coverage");
    const noteNoNet = await page.evaluate(() => { const n = document.getElementById("tcDistanceNote"); return n.style.display === "none" ? "" : n.textContent; });
    check("19. along streets without a road network: same area as straight line, with the explanation",
      !!noNet && near(noNet.area, expectAll, 0.03) &&
      noteNoNet === "No street network is loaded, so distance was measured in a straight line.", noteNoNet + " / " + (noNet && noNet.area));

    // ---- along streets: synthetic network ----
    await page.evaluate(() => App.fetchRoadNetwork());
    await waitFor(() => App.roadNetworkLoaded(), null, 30000);
    await page.evaluate(() => App.notifyProject());
    check("20. a road network loaded after the run marks street-distance results stale", await waitFor(() => !!document.querySelector("#tcStatus.rf-status-stale"), null, 10000));
    const t0 = Date.now();
    await run();
    const ms = Date.now() - t0;
    const st = await geo("coverage");
    const noteNet = await page.evaluate(() => { const n = document.getElementById("tcDistanceNote"); return n.style.display === "none" ? "" : n.textContent; });
    check("21. along streets with a network: the area differs from the circles (by more than 1 %)",
      !!st && Math.abs(st.area - expectAll) / expectAll > 0.01 && st.area > 0, st ? st.area.toFixed(3) + " vs " + expectAll.toFixed(3) : "none");
    check("22. the off-network stop (R2) is covered by a circle and counted in the note",
      !!st && st.inside.R2 && st.inside.S1 && st.inside.P1 && noteNet === "1 stop is off the street network and was measured in a straight line.", noteNet);
    console.log("    along-streets run: " + ms + " ms");
    await page.evaluate(() => document.body.classList.remove("dark-mode"));
    await page.screenshot({ path: SHOTS + "/tc-gtfs-streets-light.png" });

    // streets + threshold exercises the second flood
    await setVal("#tcHeadwayThreshold", "15");
    await run();
    const thrSt = await geo("threshold");
    check("23. along streets with a threshold: the threshold area is inside the coverage area and not larger",
      !!thrSt && !!(await geo("coverage")) && thrSt.area <= (await geo("coverage")).area + 1e-9 && thrSt.area > 0, thrSt && thrSt.area);
    await setVal("#tcHeadwayThreshold", "");
    await setVal("#tcDistanceMode", "straight");

    // ---- hiding F1 ----
    await run();
    const rtBefore = await page.evaluate(() => document.getElementById("tcResults").textContent);
    await page.evaluate(() => App.gtfsSetRouteHidden("F1", true));
    check("24. hiding F1 marks the results stale", await waitFor(() => !!document.querySelector("#tcStatus.rf-status-stale"), null, 5000));
    check("25. F1 leaves the GTFS routes list (Include hidden is off)",
      await page.evaluate(() => !document.querySelector('#tcGtfsList input[data-route-id="F1"]')));
    await click("#tcStatus .rf-status-rerun");
    await waitFor(() => /Analyzed coverage/.test(document.getElementById("tcStatus").textContent));
    const noF1 = await geo("coverage");
    const rtF1 = await page.evaluate(() => document.getElementById("tcResults").textContent);
    check("26. Re-run drops F1: its result row is gone and B1 and R1 stay",
      /F1 \[bus\]/.test(rtBefore) && !/F1 \[/.test(rtF1) && /B1 \[bus\]/.test(rtF1) && /R1 \[rail\]/.test(rtF1) && !!noF1 && noF1.inside.S1, rtF1.slice(0, 300));
    await page.evaluate(() => App.gtfsSetRouteHidden("F1", false));
    await waitFor(() => !!document.querySelector('#tcGtfsList input[data-route-id="F1"]'), null, 5000);
    check("27. un-hiding F1 puts it back, checked", await page.evaluate(() => {
      const cb = document.querySelector('#tcGtfsList input[data-route-id="F1"]'); return !!cb && cb.checked; }));

    // ---- session ----
    await setChecked(["B1", "F1"]);
    await setVal("#tcBusBufferMi", "0.3");
    await setVal("#tcRailBufferMi", "0.6");
    await setVal("#tcDistanceMode", "streets");
    const saved = await page.evaluate(() => { const m = App.cache.collectState("full").moduleState["transit-coverage"];
      return { version: m.version, unchecked: m.gtfsUnchecked, settings: m.settings }; });
    check("28. session saves schema v3 with gtfsUnchecked, busBufferMi, railBufferMi, distanceMode",
      saved.version === 3 && saved.unchecked.length === 1 && saved.unchecked[0] === "R1" &&
      saved.settings.busBufferMi === 0.3 && saved.settings.railBufferMi === 0.6 && saved.settings.distanceMode === "streets", JSON.stringify(saved));
    const back = await page.evaluate(() => {
      const st = App.cache.collectState("full");
      document.getElementById("tcBusBufferMi").value = "0.9";
      document.getElementById("tcDistanceMode").value = "straight";
      document.querySelector('#tcGtfsList input[data-route-id="R1"]').click();
      App.cache.applyState(st);
      return { bus: document.getElementById("tcBusBufferMi").value, rail: document.getElementById("tcRailBufferMi").value,
        dist: document.getElementById("tcDistanceMode").value,
        r1: document.querySelector('#tcGtfsList input[data-route-id="R1"]').checked,
        b1: document.querySelector('#tcGtfsList input[data-route-id="B1"]').checked };
    });
    check("29. applying that session restores the settings and leaves R1 unchecked, B1 checked",
      back.bus === "0.3" && back.rail === "0.6" && back.dist === "streets" && !back.r1 && back.b1, JSON.stringify(back));
    const v2 = await page.evaluate(() => {
      const st = App.cache.collectState("full");
      const m = st.moduleState["transit-coverage"];
      m.version = 2; delete m.gtfsUnchecked;
      delete m.settings.busBufferMi; delete m.settings.railBufferMi; delete m.settings.distanceMode;
      App.cache.applyState(st);
      return { bus: document.getElementById("tcBusBufferMi").value, rail: document.getElementById("tcRailBufferMi").value,
        dist: document.getElementById("tcDistanceMode").value,
        allChecked: Array.from(document.querySelectorAll("#tcGtfsList input[type=checkbox]")).every((c) => c.checked) };
    });
    check("30. a v2 session loads with 0.25 / 0.5 mi, straight line and every GTFS route checked",
      v2.bus === "0.25" && v2.rail === "0.5" && v2.dist === "straight" && v2.allChecked, JSON.stringify(v2));

    // Unloading the feed removes the section again.
    await page.evaluate(() => App.clearGTFS && App.clearGTFS());
    await waitFor(() => !App.gtfsSchedule(), null, 10000);
    await page.evaluate(() => { App.closeModulePopup && App.closeModulePopup(); App.openModulePopup("transit-coverage"); });
    await page.waitForSelector("#tcGtfsSection", { state: "attached" });
    check("31. after the feed is cleared the GTFS section is hidden again",
      await page.evaluate(() => getComputedStyle(document.getElementById("tcGtfsSection")).display === "none"));

    check("32. no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 400));
  } catch (e) {
    check("test ran to the end", false, e && e.stack || String(e));
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
