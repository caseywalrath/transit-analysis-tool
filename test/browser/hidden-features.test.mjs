#!/usr/bin/env node
// test/browser/hidden-features.test.mjs
//
// Behavior test for hidden features in analysis checklists
// (docs/hidden-features-analysis-plan.md). Phase 2: Feature Area Analysis.
// Census/TIGERweb are unreachable in the sandbox (the harness aborts remote
// hosts), so runs are asserted on status/progress text, not on results.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/hidden-features.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/hidden-features.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const ROW = (n) => `#basFeatureChecklist .rf-feature-check-row:nth-child(${n})`;

async function rowState(page, n) {
  return page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const cb = row.querySelector("input[type=checkbox]");
    return { disabled: cb.disabled, checked: cb.checked, muted: row.classList.contains("ac-hidden"),
      tag: !!row.querySelector(".ac-hidden-tag"), title: row.title || "" };
  }, ROW(n));
}

// Generic row helpers for the other modules' checklists (selector = the list container).
async function rowOf(page, listSel, n) {
  return page.evaluate(([sel, n]) => {
    const row = document.querySelectorAll(sel + " .rf-feature-check-row")[n - 1];
    const cb = row.querySelector("input[type=checkbox]");
    return { disabled: cb.disabled, checked: cb.checked, muted: row.classList.contains("ac-hidden"),
      tag: !!row.querySelector(".ac-hidden-tag"), title: row.title || "" };
  }, [listSel, n]);
}
const clickEl = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || "", sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hide = (page, type, index, on) => page.evaluate(([t, i, o]) => App.bulkFeatures.setHidden([{ type: t, index: i }], o), [type, index, on]);

// Fixture: 2 routes, 2 lines, 2 points, 2 polygons inside the stubbed block group.
async function loadFixture(page) {
  await page.evaluate(() => {
    var st = App.cache.collectState("full");
    st.labels = []; st.points = []; st.polygons = []; st.lines = []; st.routes = [];
    function ln(name, id, lat) {
      return { type: "Feature", properties: { name: name, lineIdx: id, waypoints: 2, attributes: {} },
        geometry: { type: "LineString", coordinates: [[-104.9, lat], [-104.8, lat]] } };
    }
    function rt(name, id, lat) {
      return { type: "Feature", properties: { name: name, routeIdx: id, waypoints: [[-104.9, lat], [-104.8, lat]], attributes: {} },
        geometry: { type: "LineString", coordinates: [[-104.9, lat], [-104.85, lat], [-104.8, lat]] } };
    }
    function pt(name, id, lat) {
      return { type: "Feature", properties: { name: name, pointIdx: id, attributes: {} },
        geometry: { type: "Point", coordinates: [-104.85, lat] } };
    }
    function pg(name, id, lat) {
      var d = 0.02;
      return { type: "Feature", properties: { name: name, polyIdx: id, attributes: {} },
        geometry: { type: "Polygon", coordinates: [[[-104.9, lat], [-104.8, lat], [-104.8, lat + d], [-104.9, lat + d], [-104.9, lat]]] } };
    }
    st.routes = [rt("Route A", 1, 39.70), rt("Route B", 2, 39.72)];
    st.lines = [ln("Line A", 1, 39.74), ln("Line B", 2, 39.76)];
    st.points = [pt("Point A", 1, 39.70), pt("Point B", 2, 39.72)];
    st.polygons = [pg("Poly A", 1, 39.60), pg("Poly B", 2, 39.64)];
    App.cache.applyState(st);
    App.refreshFeaturePanel();
  });
}


// Standard hidden-feature assertions for a checklist-based module. cfg:
//   tag, module (registry id + cache key), list (checklist selector), selAll, selNone,
//   run (button selector), status (pill selector), toggle (id), note (selector),
//   done (status text of a finished run), first/second = {type,index} of rows 1 and 2.
async function standardSection(page, cfg, url) {
  const T = cfg.tag + ": ";
  const L = cfg.list, ST = cfg.status;
  const stale = () => page.evaluate((s) => !!document.querySelector(s + ".rf-status-stale"), ST);
  await loadFixture(page);
  await page.evaluate((m) => App.openModulePopup(m), cfg.module);
  await page.waitForSelector(L + " .rf-feature-check-row");
  check(T + "Include hidden toggle present and off", await page.evaluate((id) => { const t = document.getElementById(id); return !!t && !t.checked; }, cfg.toggle));
  check(T + "visible row enabled", !(await rowOf(page, L, 1)).disabled);
  await hide(page, cfg.first.type, cfg.first.index, true);
  let r = await rowOf(page, L, 1);
  check(T + "hiding grays row live, keeps checked", r.disabled && r.muted && r.tag && r.checked && r.title.includes("Include hidden"), JSON.stringify(r));
  await hide(page, cfg.first.type, cfg.first.index, false);
  await clickEl(page, L + " .rf-feature-check-row:nth-child(1) input");
  await hide(page, cfg.first.type, cfg.first.index, true);
  check(T + "hidden + unchecked stays unchecked", !(await rowOf(page, L, 1)).checked);
  await hide(page, cfg.first.type, cfg.first.index, false);
  r = await rowOf(page, L, 1);
  check(T + "showing restores enabled + unchecked state", !r.disabled && !r.muted && !r.checked, JSON.stringify(r));
  await clickEl(page, L + " .rf-feature-check-row:nth-child(1) input");
  // a disabled-but-checked row is never written into the saved unchecked list
  await hide(page, cfg.first.type, cfg.first.index, true);
  await clickEl(page, L + " .rf-feature-check-row:nth-child(2) input"); // uncheck row 2 -> selection saved
  check(T + "disabled-checked row not recorded as unchecked", await waitFor(page, ([m, t, idx]) => {
    const raw = localStorage.getItem("mat-session"); if (!raw) return false;
    const u = JSON.parse(raw).moduleState[m].uncheckedFeatures || [];
    return u.length === 1 && u[0].id === App[t === "route" ? "routes" : t === "line" ? "lines" : t === "point" ? "points" : "polygons"][idx].properties[App.FEATURE_ID_PROP[t]];
  }, 10000, [cfg.cacheKey || cfg.module, cfg.second.type, cfg.second.index]));
  await clickEl(page, L + " .rf-feature-check-row:nth-child(2) input"); // re-check
  await clickEl(page, cfg.selNone);
  await clickEl(page, cfg.selAll);
  const sa = [await rowOf(page, L, 1), await rowOf(page, L, 2)];
  check(T + "Select all ticks enabled only; Clear clears all", !sa[0].checked && sa[1].checked);
  await clickEl(page, L + " .rf-feature-check-row:nth-child(1) label");
  check(T + "clicking a disabled row's label does nothing", !(await rowOf(page, L, 1)).checked);
  // hidden-only selection (only row 1 ticked), toggle off
  await clickEl(page, cfg.selNone);
  await hide(page, cfg.first.type, cfg.first.index, false);
  await clickEl(page, L + " .rf-feature-check-row:nth-child(1) input");
  await hide(page, cfg.first.type, cfg.first.index, true);
  await clickEl(page, cfg.run);
  check(T + "hidden-only selection (toggle off) shows the hidden message",
    await waitFor(page, (s) => document.querySelector(s).textContent.includes("Selected features are hidden"), 20000, ST), await text(page, ST));
  await clickEl(page, "#" + cfg.toggle);
  r = await rowOf(page, L, 1);
  check(T + "toggle on enables the hidden row (still tagged)", !r.disabled && r.tag && !r.muted);
  if (cfg.extra) await cfg.extra(page);
  await clickEl(page, cfg.run);
  check(T + "toggle on: run completes", await waitFor(page, ([s, d]) => document.querySelector(s).textContent.includes(d), 40000, [ST, cfg.done]), await text(page, ST));
  check(T + "results disclose hidden features", (await text(page, cfg.note)).includes("Includes 1 feature hidden on the map."), await text(page, cfg.note));
  check(T + "fresh results not stale", !(await stale()));
  await hide(page, cfg.second.type, cfg.second.index, true); await sleep(300);
  check(T + "hiding an unselected feature does NOT mark stale", !(await stale()));
  await hide(page, cfg.second.type, cfg.second.index, false); await sleep(300);
  check(T + "showing an unselected feature does NOT mark stale", !(await stale()));
  await hide(page, cfg.first.type, cfg.first.index, false);
  check(T + "changing hidden state of a selected feature marks stale", await waitFor(page, (s) => !!document.querySelector(s + ".rf-status-stale"), 5000, ST));
  await clickEl(page, cfg.run);
  check(T + "re-run clears stale", await waitFor(page, ([s, d]) => document.querySelector(s).textContent.includes(d) && !document.querySelector(s + ".rf-status-stale"), 40000, [ST, cfg.done]));
  if (cfg.editStale) {
    await page.evaluate(() => { App.routes[1].properties.name = "Renamed"; App.notifyProject(); });
    check(T + "a genuine feature edit still marks stale", await waitFor(page, (s) => !!document.querySelector(s + ".rf-status-stale"), 5000, ST));
    await clickEl(page, cfg.run);
    await waitFor(page, ([s, d]) => document.querySelector(s).textContent.includes(d) && !document.querySelector(s + ".rf-status-stale"), 40000, [ST, cfg.done]);
  }
  await clickEl(page, "#" + cfg.toggle); // off
  check(T + "changing the toggle after a run marks stale", await waitFor(page, (s) => !!document.querySelector(s + ".rf-status-stale"), 5000, ST));
  await clickEl(page, "#" + cfg.toggle); // on
  await page.evaluate(() => App.cache.save());
  await waitFor(page, ([m, path]) => { const raw = localStorage.getItem("mat-session"); if (!raw) return false;
    let o = JSON.parse(raw).moduleState[m]; for (const k of path.split(".")) o = o && o[k];
    return o === true; }, 10000, [cfg.cacheKey || cfg.module, cfg.flagPath || "includeHidden"]);
  await reloadPage(page, url);
  await page.evaluate((m) => App.openModulePopup(m), cfg.module);
  await page.waitForSelector("#" + cfg.toggle);
  check(T + "toggle survives a reload", await page.evaluate((id) => document.getElementById(id).checked, cfg.toggle));
  await clickEl(page, "#" + cfg.toggle);
  await page.evaluate(() => App.cache.save());
}

async function reloadPage(page, url) {
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
  await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });
}

// Status text lives in #basStatus; the progress line in #basResultsProgress.
async function statusText(page) {
  return page.evaluate(() => (document.getElementById("basStatus") || {}).textContent || "");
}
async function isStale(page) {
  return page.evaluate(() => !!document.querySelector("#basStatus.rf-status-stale"));
}
async function waitFor(page, fn, timeout = 20000, arg = null) {
  try { await page.waitForFunction(fn, arg, { timeout }); return true; } catch (e) { return false; }
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    // Stub TIGERweb (one big block group) and the ACS API so a run completes.
    await routeVendoredAssets(context, port, (route, url) => {
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
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });

    // Two points; one variable ticked so a run can start.
    await page.evaluate(() => {
      App.addPoint(-104.9, 39.7);
      App.addPoint(-104.8, 39.75);
    });
    await page.evaluate(() => App.openModulePopup("buffer-summary"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.waitForSelector("#basFeatureChecklist .rf-feature-check-row");
    await page.evaluate(() => {
      const v = document.querySelector('#varSelect input[type="checkbox"]');
      v.checked = true; v.dispatchEvent(new Event("change", { bubbles: true }));
    });

    check("Include hidden toggle present and off by default",
      await page.evaluate(() => { const t = document.getElementById("basIncludeHidden"); return !!t && !t.checked; }));

    let r1 = await rowState(page, 1);
    check("visible row enabled, not muted", !r1.disabled && !r1.muted && !r1.tag);

    // ---- Hide point 1 while the popup is open ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));
    r1 = await rowState(page, 1);
    check("hiding a feature grays its row without reopening",
      r1.disabled && r1.muted && r1.tag && r1.title.includes("Include hidden"), JSON.stringify(r1));
    check("hidden row keeps its checked state (default: checked)", r1.checked === true);

    // ---- Uncheck state preserved across hide/show ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false));
    await page.evaluate(() => document.querySelector("#basFeatureChecklist input[type=checkbox]").click());
    check("unchecked visible row is unchecked", !(await rowState(page, 1)).checked);
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));
    check("hidden + previously unchecked stays unchecked", !(await rowState(page, 1)).checked);
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false));
    let r1b = await rowState(page, 1);
    check("showing it again restores enabled + previous (unchecked) state",
      !r1b.disabled && !r1b.muted && !r1b.tag && !r1b.checked, JSON.stringify(r1b));
    await page.evaluate(() => document.querySelector("#basFeatureChecklist input[type=checkbox]").click()); // re-check

    // ---- Select all / Clear ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));
    await page.evaluate(() => document.getElementById("basFeatureSelectNone").click());
    await page.evaluate(() => document.getElementById("basFeatureSelectAll").click());
    const sa = [await rowState(page, 1), await rowState(page, 2)];
    check("Select all ticks enabled boxes only (hidden stays cleared)", !sa[0].checked && sa[1].checked, JSON.stringify(sa));
    await page.evaluate(() => document.getElementById("basFeatureSelectNone").click());
    check("Clear clears every box", !(await rowState(page, 1)).checked && !(await rowState(page, 2)).checked);

    // ---- Hidden-only selection, toggle off: new message ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false));
    await page.evaluate(() => document.getElementById("basFeatureSelectAll").click());
    await page.evaluate(() => document.querySelectorAll("#basFeatureChecklist input[type=checkbox]")[1].click()); // uncheck #2
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], true));   // only #1 left checked, now hidden
    await page.evaluate(() => document.getElementById("basRun").click());
    check("toggle off, hidden-only selection shows the hidden message",
      await waitFor(page, () => (document.getElementById("basStatus") || {}).textContent.includes("Selected features are hidden")),
      await statusText(page));

    // ---- Toggle on: run gets past the buffer step ----
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());
    check("toggle on enables the hidden row (still tagged)",
      await (async () => { const s = await rowState(page, 1); return !s.disabled && s.tag && !s.muted; })());
    await page.evaluate(() => document.getElementById("basRun").click());
    check("toggle on: run passes the buffer step (no hidden/no-buffers error)",
      await waitFor(page, () => {
        const t = (document.getElementById("basStatus") || {}).textContent || "";
        const p = (document.getElementById("basResultsProgress") || {}).textContent || "";
        return !t.includes("Selected features are hidden") && !t.includes("No buffers") && (p.length > 0 || t.length > 0);
      }), await statusText(page));
    check("toggle on: run completes (Done)",
      await waitFor(page, () => (document.getElementById("basStatus") || {}).textContent.includes("Done"), 30000),
      await statusText(page));
    check("results notes disclose hidden features",
      await page.evaluate(() => document.getElementById("basResultsNotes").textContent.includes("Includes 1 feature hidden on the map.")));
    check("fresh results are not stale", !(await isStale(page)));

    // ---- Staleness ----
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 1 }], true)); // not selected in the run
    await new Promise((r) => setTimeout(r, 300));
    check("hiding an unselected feature does NOT mark results stale", !(await isStale(page)));
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 1 }], false));
    await new Promise((r) => setTimeout(r, 300));
    check("showing an unselected feature does NOT mark results stale", !(await isStale(page)));
    await page.evaluate(() => App.bulkFeatures.setHidden([{ type: "point", index: 0 }], false)); // in the run's selection
    check("changing hidden state of a selected feature marks results stale",
      await waitFor(page, () => !!document.querySelector("#basStatus.rf-status-stale"), 5000));
    await page.evaluate(() => document.getElementById("basRun").click());
    check("re-run clears stale",
      await waitFor(page, () => (document.getElementById("basStatus") || {}).textContent.includes("Done") &&
        !document.querySelector("#basStatus.rf-status-stale"), 30000));
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());   // toggle off after a run
    check("changing the toggle after a run marks results stale",
      await waitFor(page, () => !!document.querySelector("#basStatus.rf-status-stale"), 5000));
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());   // back on for persistence

    // ---- Persistence of the toggle ----
    await page.evaluate(() => App.cache.save());
    await waitFor(page, () => { // save is debounced; wait for the payload to land
      const raw = localStorage.getItem("mat-session");
      return !!raw && JSON.parse(raw).moduleState["buffer-summary"].includeHidden === true;
    }, 10000);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.waitForFunction("typeof App.openModulePopup === 'function'", { timeout: 10000 });
    await page.evaluate(() => App.openModulePopup("buffer-summary"));
    await page.waitForSelector("#basIncludeHidden");
    check("toggle survives a reload",
      await page.evaluate(() => document.getElementById("basIncludeHidden").checked));
    // untick for the next section
    await page.evaluate(() => document.getElementById("basIncludeHidden").click());
    check("toggle can be turned off again and persists in the cache payload",
      await waitFor(page, () => { const raw = localStorage.getItem("mat-session");
        return !!raw && JSON.parse(raw).moduleState["buffer-summary"].includeHidden === false; }, 10000));


    // =====================================================================
    // Corridor Scoring (Phase 3)
    // =====================================================================
    {
      const L = "#csFeatureList", ST = "#csStatus";
      await loadFixture(page);
      await page.evaluate(() => App.openModulePopup("corridor-scoring"));
      await page.waitForSelector(L + " .rf-feature-check-row");
      check("CS: Include hidden toggle present and off", await page.evaluate(() => { const t = document.getElementById("csIncludeHidden"); return !!t && !t.checked; }));
      check("CS: visible row enabled", !(await rowOf(page, L, 1)).disabled);
      await hide(page, "route", 0, true);
      let r = await rowOf(page, L, 1);
      check("CS: hiding grays row live, keeps checked", r.disabled && r.muted && r.tag && r.checked && r.title.includes("Include hidden"), JSON.stringify(r));
      await hide(page, "route", 0, false);
      await clickEl(page, L + " .rf-feature-check-row:nth-child(1) input"); // uncheck
      await hide(page, "route", 0, true);
      check("CS: hidden + unchecked stays unchecked", !(await rowOf(page, L, 1)).checked);
      await hide(page, "route", 0, false);
      r = await rowOf(page, L, 1);
      check("CS: showing restores enabled + unchecked state", !r.disabled && !r.muted && !r.checked, JSON.stringify(r));
      await clickEl(page, L + " .rf-feature-check-row:nth-child(1) input"); // re-check
      // saved selection never records a disabled-checked row as unchecked
      await hide(page, "route", 0, true);
      await clickEl(page, L + " .rf-feature-check-row:nth-child(2) input"); // uncheck B -> triggers capture
      check("CS: disabled-checked row not recorded as unchecked", await waitFor(page, () => { const raw = localStorage.getItem("mat-session"); if (!raw) return false;
          const u = JSON.parse(raw).moduleState["corridor-scoring"].uncheckedFeatures || [];
          return u.length === 1 && u[0].type === "route" && u[0].id !== App.routes[0].properties.routeIdx; }, 10000));
      await clickEl(page, L + " .rf-feature-check-row:nth-child(2) input"); // re-check B
      // Select all / Clear
      await clickEl(page, "#csSelectNone");
      await clickEl(page, "#csSelectAll");
      let sa = [await rowOf(page, L, 1), await rowOf(page, L, 2)];
      check("CS: Select all ticks enabled only; Clear clears all", !sa[0].checked && sa[1].checked);
      await clickEl(page, L + " .rf-feature-check-row:nth-child(1) label");
      check("CS: clicking a disabled row's label does nothing", !(await rowOf(page, L, 1)).checked);
      // hidden-only selection, toggle off
      await clickEl(page, "#csSelectNone");
      await hide(page, "route", 0, false);
      await clickEl(page, L + " .rf-feature-check-row:nth-child(1) input"); // check A only
      await hide(page, "route", 0, true);
      await clickEl(page, "#csScoreBtn");
      check("CS: hidden-only selection (toggle off) shows the hidden message",
        await waitFor(page, () => document.getElementById("csStatus").textContent.includes("Selected features are hidden")), await text(page, ST));
      // toggle on
      await clickEl(page, "#csIncludeHidden");
      r = await rowOf(page, L, 1);
      check("CS: toggle on enables the hidden row (still tagged)", !r.disabled && r.tag && !r.muted);
      await clickEl(page, "#csScoreBtn");
      check("CS: toggle on: run completes", await waitFor(page, () => document.getElementById("csStatus").textContent.includes("Scored"), 30000), await text(page, ST));
      check("CS: results disclose hidden features", (await text(page, "#csHiddenNote")).includes("Includes 1 feature hidden on the map."));
      check("CS: fresh results not stale", !(await page.evaluate(() => !!document.querySelector("#csStatus.rf-status-stale"))));
      const stale = (p) => p.evaluate(() => !!document.querySelector("#csStatus.rf-status-stale"));
      await hide(page, "route", 1, true); await sleep(300);
      check("CS: hiding an unselected feature does NOT mark stale", !(await stale(page)));
      await hide(page, "route", 1, false); await sleep(300);
      check("CS: showing an unselected feature does NOT mark stale", !(await stale(page)));
      await hide(page, "route", 0, false);
      check("CS: changing hidden state of a selected feature marks stale", await waitFor(page, () => !!document.querySelector("#csStatus.rf-status-stale"), 5000));
      await clickEl(page, "#csScoreBtn");
      check("CS: re-run clears stale", await waitFor(page, () => document.getElementById("csStatus").textContent.includes("Scored") && !document.querySelector("#csStatus.rf-status-stale"), 30000));
      await clickEl(page, "#csIncludeHidden"); // off
      check("CS: changing the toggle after a run marks stale", await waitFor(page, () => !!document.querySelector("#csStatus.rf-status-stale"), 5000));
      await clickEl(page, "#csIncludeHidden"); // on
      await page.evaluate(() => App.cache.save());
      await waitFor(page, () => { const raw = localStorage.getItem("mat-session");
        return !!raw && JSON.parse(raw).moduleState["corridor-scoring"].includeHidden === true; }, 10000);
      await reloadPage(page, url);
      await page.evaluate(() => App.openModulePopup("corridor-scoring"));
      await page.waitForSelector("#csIncludeHidden");
      check("CS: toggle survives a reload", await page.evaluate(() => document.getElementById("csIncludeHidden").checked));
      await clickEl(page, "#csIncludeHidden");
      await page.evaluate(() => App.cache.save());
    }

    await standardSection(page, {
      tag: "TPI", module: "transit-propensity", cacheKey: "tpi", list: "#tpiFeatureChecklist", selAll: "#tpiSelectAll", selNone: "#tpiSelectNone",
      run: "#tpiRun", status: "#tpiStatus", toggle: "tpiIncludeHidden", note: "#tpiHiddenNote", done: "TPI computed",
      first: { type: "route", index: 0 }, second: { type: "route", index: 1 }, editStale: true }, url);

    await standardSection(page, {
      tag: "TC", module: "transit-coverage", flagPath: "settings.includeHidden", list: "#tcFeatureList",
      selAll: "#tcFeatSelectAll", selNone: "#tcFeatSelectNone", run: "#tcRunBtn", status: "#tcStatus",
      toggle: "tcIncludeHidden", note: "#tcHiddenNote", done: "Analyzed coverage",
      first: { type: "route", index: 0 }, second: { type: "route", index: 1 },
      extra: async (pg) => {
        const A = "#tcAreaList";
        check("TC: area list present with both rows enabled (toggle on)", !(await rowOf(pg, A, 1)).disabled && !(await rowOf(pg, A, 2)).disabled);
        await clickEl(pg, "#tcIncludeHidden"); // off
        await hide(pg, "polygon", 0, true);
        let ar = await rowOf(pg, A, 1);
        check("TC: one toggle governs the service-area list too (hidden polygon grayed, checked)", ar.disabled && ar.muted && ar.tag && ar.checked, JSON.stringify(ar));
        await clickEl(pg, "#tcAreaSelectNone");
        await clickEl(pg, "#tcAreaSelectAll");
        const a2 = [await rowOf(pg, A, 1), await rowOf(pg, A, 2)];
        check("TC: area Select all ticks enabled only; Clear clears all", !a2[0].checked && a2[1].checked);
        // hidden-only service area, toggle off, features visible and ticked
        await hide(pg, "route", 0, false);
        await clickEl(pg, "#tcAreaSelectNone");
        await hide(pg, "polygon", 0, false);
        await clickEl(pg, A + " .rf-feature-check-row:nth-child(1) input");
        await hide(pg, "polygon", 0, true);
        await clickEl(pg, "#tcRunBtn");
        check("TC: hidden-only service area (toggle off) shows the hidden message",
          await waitFor(pg, () => document.getElementById("tcStatus").textContent.includes("Selected features are hidden"), 20000), await text(pg, "#tcStatus"));
        // restore: toggle on, polygon visible again, route 0 hidden again
        await clickEl(pg, "#tcIncludeHidden");
        await hide(pg, "polygon", 0, false);
        await clickEl(pg, "#tcAreaSelectAll");
        await hide(pg, "route", 0, true);
      } }, url);

    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
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
