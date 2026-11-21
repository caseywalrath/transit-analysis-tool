#!/usr/bin/env node
// test/browser/title-vi-service-equity.test.mjs
//
// Title VI "Service Equity" tab and the low-income setting (js/projects/title-vi.js), against the real app
// in headless Chromium, the mini GTFS fixture (test/fixtures/gtfs/mini, analysis date 2026-01-12, a Monday)
// and stubbed TIGERweb / ACS responses.
//
// HAND CALCULATION. Departures on 2026-01-12 (every stop time but a trip's last): S1 21 (B1 W_0, W_2, OWL
// + F1: 9 frequency trips 06:00-08:40, 8 trips 16:00-17:45, 1 block trip), S2 5 (B1 W_0, W_1, W_2, W_3,
// OWL; W_BAD drops out for its blank first time), S3 2 (W_1, W_3), P1 1 and R2 1 (R1). 30 trips, 25 of
// them distinct GTFS trips. S1, S2, S3 are bus (0.25 mi) and P1, R2 rail (0.5 mi). S1-S2 and S2-S3 are
// 0.53 mi apart, so each circle holds only its own blocks. The median peak gap is 15 min at S1, S2 and S3,
// so all three are "frequent" for the half-mile switch (P1 and R2 have one trip, no gap).
//
// Blocks (POP100) and their block group (first 12 digits of the GEOID):
//   BG A 080010001001: a1 200 at S1, a2 100 at S2, a3 100 far from every stop
//   BG B 080010001002: b1 100 at S3, b2 100 at P1, b3 100 at R2, a4 100 0.40 mi north of S1
// ACS (both block groups have 1,000 residents; the poverty universes B17001_001E / C17002_001E are served too,
// for the tract-level fallback, which these block-group answers never trigger):
//   A: not-Hispanic-white 900 (minority 10 %), below poverty 300, C17002 rows 2-7 sum 200
//   B: not-Hispanic-white 300 (minority 70 %), below poverty 100, C17002 rows 2-7 sum 600
//
// Bus buffers only (a4 is outside 0.25 mi of S1): trips A = 21 + 5 = 26, B = 2 + 1 + 1 = 4.
//   minority   regional share 40 %: B is the minority area. 4.0 vs 26.0 per 1,000, ratio 0.1538 -> 0.15 -> disparity
//   poverty100 regional share 20 %: A is the low-income area. 26.0 vs 4.0, ratio 6.50 -> no disparity
//   poverty200 regional share 40 %: B is the low-income area. 4.0 vs 26.0, ratio 0.15 -> disparity
// Half mile at frequent stops (S1, S2, S3 widen to 0.5 mi; S1 now reaches a4): S1's 21 trips split 200:100
// between a1 (A) and a4 (B) = 14 / 7. A = 14 + 5 = 19, B = 7 + 2 + 1 + 1 = 11.
//   minority   B protected: 11.0 vs 19.0, ratio 0.5789 -> 0.58 -> disparity
//   poverty100 A protected: 19.0 vs 11.0, ratio 1.7273 -> 1.73 -> no disparity
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/title-vi-service-equity.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer, REPO_ROOT } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/title-vi-service-equity.test.mjs");

const SHOTS = "/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/a6/shots";
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (pass || !detail ? "" : "  — " + detail));
}

const MINI_DIR = join(REPO_ROOT, "test", "fixtures", "gtfs", "mini");
const mini = {};
["agency", "calendar", "calendar_dates", "frequencies", "routes", "shapes", "stop_times", "stops", "trips"]
  .forEach((n) => { mini[n + ".txt"] = readFileSync(join(MINI_DIR, n + ".txt"), "utf8"); });

const BG_A = "080010001001", BG_B = "080010001002";
const rect = (w, s, e, n) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
// Only the intersection with the study region matters; membership of a block comes from its GEOID.
const BG_FEATURES = [
  { type: "Feature", properties: { GEOID: BG_A }, geometry: rect(-105.1, 39.6, -104.8, 39.95) },
  { type: "Feature", properties: { GEOID: BG_B }, geometry: rect(-104.85, 39.6, -104.5, 39.95) }
];
const block = (geoid, lat, lon, pop) => ({ type: "Feature", properties: { GEOID: geoid, INTPTLAT: String(lat),
  INTPTLON: String(lon), POP100: pop, HU100: 0 }, geometry: null });
const BLOCKS = [
  block(BG_A + "001", 39.74, -104.99, 200),            // a1 at S1
  block(BG_A + "002", 39.74, -104.98, 100),            // a2 at S2
  block(BG_A + "003", 39.70, -105.05, 100),            // a3 far from every stop
  block(BG_B + "001", 39.74, -104.97, 100),            // b1 at S3
  block(BG_B + "002", 39.7501, -105.0001, 100),        // b2 at P1
  block(BG_B + "003", 39.85, -104.67, 100),            // b3 at R2
  block(BG_B + "004", 39.7458, -104.99, 100)           // a4, 0.40 mi north of S1
];
const ACS = {
  B03002_001E: { A: 1000, B: 1000 }, B03002_003E: { A: 900, B: 300 }, B01003_001E: { A: 1000, B: 1000 },
  B17001_002E: { A: 300, B: 100 }, B17001_001E: { A: 1000, B: 1000 }, C17002_001E: { A: 1000, B: 1000 },
  C17002_002E: { A: 50, B: 100 }, C17002_003E: { A: 50, B: 100 }, C17002_004E: { A: 25, B: 100 },
  C17002_005E: { A: 25, B: 100 }, C17002_006E: { A: 25, B: 100 }, C17002_007E: { A: 25, B: 100 }
};

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    const acsRequests = [];
    await routeVendoredAssets(context, port, (route, url) => {
      if (url.includes("tigerweb.geo.census.gov")) {
        const features = url.includes("/MapServer/2/query") ? BLOCKS : BG_FEATURES;
        route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ type: "FeatureCollection", features }) });
        return true;
      }
      if (url.includes("api.census.gov")) {
        const get = decodeURIComponent((url.match(/[?&]get=([^&]*)/) || [])[1] || "");
        const vars = get.split(",").filter((v) => v !== "NAME");
        acsRequests.push(vars.join(","));
        const hdr = ["NAME", ...vars, "state", "county", "tract", "block group"];
        const row = (bg, g) => ["bg", ...vars.map((v) => (ACS[v] ? ACS[v][g] : 0)), "08", "001", "000100", bg];
        route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify([hdr, row("1", "A"), row("2", "B")]) });
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
    const text = (sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || "", sel);
    const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== "none"; }, sel);
    const setVal = (sel, v) => page.evaluate(([s, val]) => {
      const el = document.querySelector(s); el.value = val; el.dispatchEvent(new Event("change", { bubbles: true }));
    }, [sel, v]);
    const setChecked = (sel, on) => page.evaluate(([s, val]) => {
      const el = document.querySelector(s); el.checked = val; el.dispatchEvent(new Event("change", { bubbles: true }));
    }, [sel, on]);
    const openTab = (id) => click('.tvi-tab[data-tab="' + id + '"]');
    const openPopup = async () => {
      await page.evaluate(() => App.openModulePopup("title-vi"));
      await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
      await page.waitForSelector("#tviSeRun", { state: "attached" });
    };
    // One run: click and wait until the button is enabled again (it is disabled synchronously by the click).
    async function run() {
      await click("#tviSeRun");
      await waitFor(() => !document.getElementById("tviSeRun").disabled);
      return text("#tviSeStatus");
    }
    const card = (p) => page.evaluate((pre) => ({
      verdict: document.getElementById("tviSe" + pre + "Verdict").textContent,
      cls: document.getElementById("tviSe" + pre + "Verdict").className,
      prot: document.getElementById("tviSe" + pre + "Protected").textContent,
      other: document.getElementById("tviSe" + pre + "Other").textContent,
      ratio: document.getElementById("tviSe" + pre + "Ratio").textContent,
      geos: document.getElementById("tviSe" + pre + "Geos").textContent
    }), p);
    const notes = () => page.evaluate(() => Array.from(document.querySelectorAll("#tviSeNotes li")).map((l) => l.textContent));
    const staleShown = () => visible("#tviSeStaleWarning");

    // ---- 1. before the popup has ever opened ----
    const early = await page.evaluate(() => {
      const st = App.cache.collectState("light").moduleState["title-vi"];
      return st && { version: st.version, low: st.policy.lowIncomeDefinition, se: st.policy.serviceEquity,
        hidden: st.seIncludeHidden, result: st.serviceEquity };
    });
    check("1. collectState before the popup opened still works and is version 4 with the defaults",
      !!early && early.version === 4 && early.low === "poverty100" && early.hidden === false && early.result === null &&
      early.se.busBufferMiles === 0.25 && early.se.railBufferMiles === 0.5 && early.se.frequentHalfMile === false &&
      early.se.frequentHeadwayMin === 15 && early.se.fourFifths === 0.8, JSON.stringify(early));

    // ---- 2. tab bar, low-income setting, no feed ----
    await openPopup();
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".tvi-tab")).map((t) =>
      t.getAttribute("data-tab") + "=" + t.textContent.trim()));
    check("2. the Service Equity tab sits after Equity Analysis", tabs.join("|") ===
      "policies=Major Service Changes|analysis=Equity Analysis|service=Service Equity|scenarios=Scenarios", tabs.join("|"));
    const liOpts = await page.evaluate(() => {
      const s = document.getElementById("tviLowIncomeDef");
      return { value: s.value, options: Array.from(s.options).map((o) => o.value + "=" + o.textContent) };
    });
    check("3. the low-income select offers poverty100 (default) and poverty200 with the table names",
      liOpts.value === "poverty100" && liOpts.options.join("|") ===
      "poverty100=Below the poverty level (B17001)|poverty200=Below 200% of the poverty level (C17002)", JSON.stringify(liOpts));

    await openTab("service");
    check("4. no feed: the date line says drawn Services only",
      (await text("#tviSeDate")) === "No GTFS feed: drawn Services only.", await text("#tviSeDate"));
    check("5. the headway field is disabled while the frequent-stop box is unchecked",
      await page.evaluate(() => document.getElementById("tviSeHeadway").disabled &&
        document.getElementById("tviSeBusMi").value === "0.25" && document.getElementById("tviSeRailMi").value === "0.5" &&
        document.getElementById("tviSeFourFifths").value === "0.8"));
    const noSvc = await run();
    check("6. nothing to test: the engine's error is the status message and no results show",
      /^No service to test\./.test(noSvc) && !(await visible("#tviSeResultsWrap")), noSvc);

    // ---- 7. load the feed ----
    const loaded = await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      const ok = await App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
      App.gtfsAnalysisDate.set("20260112");
      return ok;
    }, mini);
    check("7. mini feed loads", loaded === true);
    await openTab("analysis");
    await openTab("service");
    const dateLine = await text("#tviSeDate");
    check("8. the date line shows the analysis date, its day type and where to change it",
      dateLine === "Analysis date: 2026-01-12 (weekday). Change it in GTFS Feed Attributes.", dateLine);

    // ---- 9. first run: bus buffers, poverty100 ----
    const st1 = await run();
    check("9. the run succeeds", st1 === "Service equity test complete.", st1);
    const minC = await card("Min"), lowC = await card("Low");
    check("10. minority card: 4.0 vs 26.0 per 1,000, ratio 0.15, Potential disparity (red pill)",
      minC.prot === "4.0" && minC.other === "26.0" && minC.ratio === "0.15" && minC.verdict === "Potential disparity" &&
      /\blow\b/.test(minC.cls), JSON.stringify(minC));
    check("11. low-income card: 26.0 vs 4.0, ratio 6.50, No disparity",
      lowC.prot === "26.0" && lowC.other === "4.0" && lowC.ratio === "6.50" && lowC.verdict === "No disparity", JSON.stringify(lowC));
    check("12. each card says '2 geographies, regional share X%' (40.0 and 20.0)",
      minC.geos === "2 geographies, regional share 40.0%" && lowC.geos === "2 geographies, regional share 20.0%",
      minC.geos + " / " + lowC.geos);
    const summary = await text("#tviSeSummary");
    check("13. the summary line: 5 stops, 25 GTFS trips + 0 proposal trips, 2 geographies, the date",
      summary === "5 stops · 25 GTFS trips + 0 proposal trips · 2 geographies · 2026-01-12", summary);
    const n1 = await notes();
    check("14. notes: low-income definition and block-population counting; no half-mile or unallocated line",
      n1.includes("Low-income: Below the poverty level.") && n1.includes("Residents counted by 2020 census-block population.") &&
      !n1.some((t) => /mile used|no residents/.test(t)), JSON.stringify(n1));
    check("15. the run asked the census for B17001 and not C17002",
      acsRequests.some((r) => r === "B17001_002E") && !acsRequests.some((r) => /C17002/.test(r)), JSON.stringify(acsRequests));
    check("16. the stale banner is hidden after a run", !(await staleShown()));

    // ---- 17. low-income definition: stale, rerun from the banner ----
    await setVal("#tviLowIncomeDef", "poverty200");
    check("17. switching to poverty200 marks the Service Equity result stale", await staleShown());
    check("18. the saved policy follows the select",
      await page.evaluate(() => App.cache.collectState("light").moduleState["title-vi"].policy.lowIncomeDefinition) === "poverty200");
    await page.evaluate(() => document.querySelector("#tviSeStaleWarning .rf-status-rerun").click());
    await waitFor(() => !document.getElementById("tviSeRun").disabled && /complete/.test(document.getElementById("tviSeStatus").textContent));
    check("19. the banner's Re-run reruns the test and requests C17002_002E..007E",
      acsRequests.some((r) => r === "C17002_002E,C17002_003E,C17002_004E,C17002_005E,C17002_006E,C17002_007E"), JSON.stringify(acsRequests));
    const low2 = await card("Low");
    check("20. poverty200: B is the low-income area, 4.0 vs 26.0, ratio 0.15, Potential disparity",
      low2.prot === "4.0" && low2.other === "26.0" && low2.ratio === "0.15" && low2.verdict === "Potential disparity" &&
      low2.geos === "2 geographies, regional share 40.0%", JSON.stringify(low2));
    check("21. the notes name the 200 % definition and the banner is gone",
      (await notes()).includes("Low-income: Below 200% of the poverty level.") && !(await staleShown()));

    // ---- 22. CSV ----
    const dl = page.waitForEvent("download", { timeout: 10000 });
    await click("#tviSeExportCSV");
    const csv = readFileSync(await (await dl).path(), "utf8").split("\n");
    const comments = csv.filter((l) => l.startsWith("# "));
    const dataRows = csv.filter((l) => l && !l.startsWith("#"));
    check("22. CSV: '# ' lines with date, settings, both findings and the low-income definition",
      comments.length === 5 && /analysis date 2026-01-12 \(weekday\)/.test(comments[0]) &&
      /bus walk 0\.25 mi, rail walk 0\.5 mi, no 1\/2 mile rule, four-fifths threshold 0\.8/.test(comments[1]) &&
      comments[2] === "# Minority: Potential disparity, ratio 0.15 (4.0 vs 26.0 trips per 1,000 residents)" &&
      comments[3] === "# Low-income: Potential disparity, ratio 0.15 (4.0 vs 26.0 trips per 1,000 residents)" &&
      comments[4] === "# Low-income: Below 200% of the poverty level.", JSON.stringify(comments));
    check("23. CSV: a header and one row per geography",
      dataRows.length === 3 && dataRows[0] ===
      "geoid,residents,trips,trips_per_1000,minority_share_pct,low_income_share_pct,minority_area,low_income_area" &&
      dataRows[1] === BG_A + ",1000,26.00,26.00,10.0,20.0,no,no" &&
      dataRows[2] === BG_B + ",1000,4.00,4.00,70.0,60.0,yes,yes", JSON.stringify(dataRows));
    // ---- 25. frequent-stop switch ----
    await setVal("#tviLowIncomeDef", "poverty100");
    await setChecked("#tviSeFrequent", true);
    check("25. ticking the box enables the headway field", await page.evaluate(() => !document.getElementById("tviSeHeadway").disabled));
    check("26. changing a setting marks the result stale", await staleShown());
    const st3 = await run();
    const n3 = await notes();
    const min3 = await card("Min"), low3 = await card("Low");
    check("27. half-mile rule on: the note names the 3 frequent stops", st3 === "Service equity test complete." &&
      n3.includes("½ mile used at 3 frequent stops."), st3 + " " + JSON.stringify(n3));
    check("28. half-mile rule: minority 11.0 vs 19.0, ratio 0.58, Potential disparity",
      min3.prot === "11.0" && min3.other === "19.0" && min3.ratio === "0.58" && min3.verdict === "Potential disparity", JSON.stringify(min3));
    check("29. half-mile rule: low-income 19.0 vs 11.0, ratio 1.73, No disparity",
      low3.prot === "19.0" && low3.other === "11.0" && low3.ratio === "1.73" && low3.verdict === "No disparity", JSON.stringify(low3));
    await setChecked("#tviSeFrequent", false);
    check("30. unticking it goes stale again and the headway field is disabled",
      (await staleShown()) && await page.evaluate(() => document.getElementById("tviSeHeadway").disabled));
    await setChecked("#tviSeFrequent", true);
    check("31. putting the setting back returns to not stale", !(await staleShown()));

    // ---- 32. screenshots of the finished tab ----
    await page.locator("#module-popup").screenshot({ path: SHOTS + "/tvi-service-equity-light.png" });
    await page.evaluate(() => document.body.classList.add("dark-mode"));
    await page.locator("#module-popup").screenshot({ path: SHOTS + "/tvi-service-equity-dark.png" });
    await page.evaluate(() => document.body.classList.remove("dark-mode"));

    // ---- 33. other stale triggers ----
    await setVal("#tviSeFourFifths", "0.6");
    check("32. the four-fifths threshold marks it stale", await staleShown());
    await setVal("#tviSeFourFifths", "0.8");
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260113"));
    check("33. a new analysis date marks it stale", await staleShown());
    check("34. the date line follows the new date", /2026-01-13 \(weekday\)/.test(await text("#tviSeDate")), await text("#tviSeDate"));
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));
    check("35. the original date clears it", !(await staleShown()));
    await setChecked("#tviSeIncludeHidden", true);
    check("36. Include hidden marks it stale", await staleShown());
    await setChecked("#tviSeIncludeHidden", false);
    await page.evaluate(async () => {
      App.polygons.push({ type: "Feature", properties: { name: "Probe", polyIdx: 9001, attributes: {} },
        geometry: { type: "Polygon", coordinates: [[[-104.9, 39.7], [-104.8, 39.7], [-104.8, 39.8], [-104.9, 39.7]]] } });
      await App.notifyProject();
    });
    check("37. a changed drawn feature marks it stale when the module updates", await staleShown());
    await page.evaluate(async () => { App.polygons.pop(); await App.notifyProject(); });
    check("38. removing it clears the banner", !(await staleShown()));

    // ---- 38a. hidden flag of a drawn Line, feed identity, four-fifths range, Clear mid-run ----
    await page.evaluate(async () => {
      App.lines.push({ type: "Feature", properties: { name: "Probe line", lineIdx: 9002, attributes: {} },
        geometry: { type: "LineString", coordinates: [[-104.9, 39.7], [-104.8, 39.7]] } });
      await App.notifyProject();
    });
    await run();
    check("38a. a drawn Line added and re-run: not stale", !(await staleShown()));
    await page.evaluate(async () => { App.lines[App.lines.length - 1].properties.hidden = true; await App.notifyProject(); });
    check("38b. hiding that Line marks it stale (hidden flags are in the signature)", await staleShown());
    await page.evaluate(async () => { App.lines[App.lines.length - 1].properties.hidden = false; await App.notifyProject(); });
    check("38c. showing it again clears the banner", !(await staleShown()));
    await setChecked("#tviSeIncludeHidden", true);
    await run();
    await page.evaluate(async () => { App.lines[App.lines.length - 1].properties.hidden = true; await App.notifyProject(); });
    check("38d. with Include hidden on, hiding the Line does not stale it", !(await staleShown()));
    await page.evaluate(async () => { App.lines.pop(); await App.notifyProject(); });
    await setChecked("#tviSeIncludeHidden", false);
    await run();
    check("38e. back to the baseline fixture: rerun is current", !(await staleShown()));

    await page.evaluate(async (files) => {
      const zip = new JSZip();
      Object.keys(files).forEach((k) => zip.file(k, files[k]));
      const blob = await zip.generateAsync({ type: "blob" });
      await App.loadGTFSFile(new File([blob], "mini.zip", { type: "application/zip" }));
      App.gtfsAnalysisDate.set("20260112");
      await App.notifyProject();
    }, mini);
    check("38f. loading the same feed again (new feed object) marks it stale", await staleShown());
    await run();
    check("38g. a rerun against the new feed is current", !(await staleShown()));

    const ff = [];
    for (const v of ["1.5", "0", "-1", "abc", "1"]) {
      await setVal("#tviSeFourFifths", v);
      ff.push(await page.evaluate(() => App.cache.collectState("light").moduleState["title-vi"].policy.serviceEquity.fourFifths));
    }
    check("38h. four-fifths outside (0, 1] falls back to 0.8; 1 is kept", ff.join() === "0.8,0.8,0.8,0.8,1", ff.join());
    await setVal("#tviSeFourFifths", "0.8");
    await run();

    await page.evaluate(() => { document.getElementById("tviSeRun").click(); App.clearModule("title-vi"); });
    check("38i. Clear mid-run re-enables Run, empties the status and drops the result",
      await page.evaluate(() => !document.getElementById("tviSeRun").disabled &&
        document.getElementById("tviSeStatus").textContent === "") && !(await visible("#tviSeResultsWrap")));
    await page.waitForTimeout(2500);
    check("38j. the abandoned run does not bring its result or status back",
      !(await visible("#tviSeResultsWrap")) && (await text("#tviSeStatus")) === "" &&
      await page.evaluate(() => App.cache.collectState("light").moduleState["title-vi"].serviceEquity) === null);
    check("38k. a new run after the Clear works", (await run()) === "Service equity test complete." && (await visible("#tviSeResultsWrap")));

    // ---- 39. persistence ----
    const saved = await page.evaluate(() => {
      const st = App.cache.collectState("full");
      const m = st.moduleState["title-vi"];
      const se = m.serviceEquity;
      return { state: st, version: m.version, low: m.policy.lowIncomeDefinition, cfg: m.policy.serviceEquity,
        hidden: m.seIncludeHidden, hasGeos: "geos" in se, hasRegion: "region" in se, rows: se.result.geos.length,
        ratio: se.result.minority.ratio, text: JSON.stringify(m).length };
    });
    check("39. saved state: version 4, settings, and the result without geos/region but with the per-geography rows",
      saved.version === 4 && saved.low === "poverty100" && saved.cfg.frequentHalfMile === true && saved.hidden === false &&
      !saved.hasGeos && !saved.hasRegion && saved.rows === 2 && Math.abs(saved.ratio - 11 / 19) < 1e-9, JSON.stringify({
        v: saved.version, low: saved.low, cfg: saved.cfg, g: saved.hasGeos, r: saved.hasRegion, rows: saved.rows, ratio: saved.ratio }));

    // ---- 40. Clear drops it ----
    await page.evaluate(() => App.clearModule("title-vi"));
    check("40. Clear hides the results, disables Export CSV, clears the banner and keeps the settings",
      !(await visible("#tviSeResultsWrap")) && (await visible("#tviSeEmpty")) && !(await staleShown()) &&
      await page.evaluate(() => document.getElementById("tviSeExportCSV").disabled &&
        document.getElementById("tviSeFrequent").checked));
    check("41. a cleared module saves no Service Equity result",
      await page.evaluate(() => App.cache.collectState("light").moduleState["title-vi"].serviceEquity) === null);

    // ---- 42. restore ----
    await page.evaluate((st) => App.cache.applyState(st), saved.state);
    await page.evaluate(() => App.popup.close());
    await openPopup();
    await openTab("service");
    const rMin = await card("Min");
    check("42. restoring brings the result back, rendered, with the same numbers and not stale",
      (await visible("#tviSeResultsWrap")) && rMin.prot === "11.0" && rMin.other === "19.0" && rMin.ratio === "0.58" &&
      !(await staleShown()) && await page.evaluate(() => !document.getElementById("tviSeExportCSV").disabled),
      JSON.stringify(rMin));
    const dl2 = page.waitForEvent("download", { timeout: 10000 });
    await click("#tviSeExportCSV");
    const csv2 = readFileSync(await (await dl2).path(), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
    check("43. the CSV export works from the restored result (one row per geography)", csv2.length === 3, JSON.stringify(csv2));

    // A restored result whose date no longer matches reads as stale.
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260113"));
    check("44. a restored result is stale once the date differs", await staleShown());
    await page.evaluate(() => App.gtfsAnalysisDate.set("20260112"));

    // ---- 45. older versions load with the defaults ----
    // The popup body keeps its last values while closed; reopening writes the restored policy into it,
    // which is what a real restore-then-open does, so collect only after that.
    await page.evaluate(() => App.popup.close());
    await page.evaluate((st) => {
      const copy = JSON.parse(JSON.stringify(st));
      const m = copy.moduleState["title-vi"];
      m.version = 3;
      delete m.policy.lowIncomeDefinition; delete m.policy.serviceEquity;
      delete m.seIncludeHidden; delete m.serviceEquity;
      App.cache.applyState(copy);
    }, saved.state);
    await openPopup();
    await openTab("analysis");
    const old = await page.evaluate(() => {
      const back = App.cache.collectState("light").moduleState["title-vi"];
      return { low: back.policy.lowIncomeDefinition, se: back.policy.serviceEquity, hidden: back.seIncludeHidden,
        result: back.serviceEquity };
    });
    check("45. a version 3 payload loads with poverty100, the default settings and no result",
      old.low === "poverty100" && old.hidden === false && old.result === null && old.se.busBufferMiles === 0.25 &&
      old.se.railBufferMiles === 0.5 && old.se.frequentHalfMile === false && old.se.frequentHeadwayMin === 15 &&
      old.se.fourFifths === 0.8, JSON.stringify(old));
    check("46. the opened popup shows the defaults (select and Service Equity inputs)",
      await page.evaluate(() => document.getElementById("tviLowIncomeDef").value === "poverty100" &&
        document.getElementById("tviSeFrequent").checked === false && document.getElementById("tviSeHeadway").disabled));

    // ---- 47. the Equity Analysis baseline gets the definition too ----
    const before = acsRequests.length;
    await page.evaluate(() => {
      const st = App.cache.collectState("full");
      st.labels = []; st.points = []; st.lines = []; st.routes = [];
      st.polygons = [{ type: "Feature", properties: { name: "Area", polyIdx: 1, attributes: {} },
        geometry: { type: "Polygon", coordinates: [[[-105.1, 39.65], [-104.5, 39.65], [-104.5, 39.95], [-105.1, 39.95], [-105.1, 39.65]]] } }];
      App.cache.applyState(st);
      App.refreshFeaturePanel();
    });
    await setVal("#tviLowIncomeDef", "poverty200");
    await page.evaluate(() => { document.getElementById("tviApportionMethod").value = "area"; });
    await page.evaluate(() => App.openModulePopup("title-vi"));
    await openTab("analysis");
    await waitFor(() => document.querySelectorAll("#tviBaselineFeatureList input").length > 0);
    await click("#tviComputeBaseline");
    await waitFor(() => /Baseline computed|Error/.test(document.getElementById("tviAnalysisStatus").textContent));
    const baseTxt = await text("#tviBaselineApportion");
    check("47. the baseline asks for C17002 and prints the definition after the counting line",
      acsRequests.slice(before).some((r) => /C17002_002E/.test(r)) && /Low-income: Below 200% of the poverty level\.$/.test(baseTxt), baseTxt);

    check("48. no page errors", errors.length === 0, errors.join(" | "));
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
