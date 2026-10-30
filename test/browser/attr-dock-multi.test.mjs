#!/usr/bin/env node
// test/browser/attr-dock-multi.test.mjs
//
// Multi-select editing in the attributes dock (rules: js/core/attr-bulk.js;
// UI: renderMulti in js/core/feature-attributes.js):
//   - two Lines share the transit fields; differing values show "Mixed"
//   - editing a shared field writes every selected feature as ONE undo step
//   - Line + Point share only Buffer; type chips narrow the selection
//   - walkshed points are skipped for Buffer, with a note
//   - a Mixed service schedule offers "Replace all…"; closing it unchanged
//     writes nothing
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/attr-dock-multi.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/attr-dock-multi.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (!pass && detail !== undefined ? "  — " + JSON.stringify(detail) : ""));
}

const LAT = 38.806, LNG = -104.80;

async function settle(page) { await page.waitForTimeout(250); }

const sections = (page) => page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .ad-section")).map((x) => x.getAttribute("data-section")));
const rowInput = (page, label) => page.locator("#attr-dock .fp-attr-row", { has: page.locator(".fp-attr-label", { hasText: new RegExp("^" + label + "$") }) }).locator("input, select, button").first();

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await routeVendoredAssets(context, port, () => false);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());

    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded() && window.AttrBulk", { timeout: 30000 });
    await page.evaluate(([LNG, LAT]) => {
      var st = App.cache.collectState("full");
      st.routes = []; st.polygons = []; st.labels = [];
      var band = (f) => ({ weekday: [{ from: "06:00", to: "20:00", frequency: f }] });
      st.lines = [
        { type: "Feature", properties: { name: "Line A", lineIdx: 1, color: "", attributes: { avgSpeed: 12, direction: "NB", service: band(15) } },
          geometry: { type: "LineString", coordinates: [[LNG - 0.01, LAT - 0.004], [LNG - 0.01, LAT + 0.004]] } },
        { type: "Feature", properties: { name: "Line B", lineIdx: 2, color: "", attributes: { avgSpeed: 20, direction: "NB", service: band(30) } },
          geometry: { type: "LineString", coordinates: [[LNG, LAT - 0.004], [LNG, LAT + 0.004]] } }
      ];
      st.points = [
        { type: "Feature", properties: { name: "Stop A", pointIdx: 1, color: "", attributes: {} },
          geometry: { type: "Point", coordinates: [LNG + 0.01, LAT] } },
        { type: "Feature", properties: { name: "Stop W", pointIdx: 2, color: "", attributes: { serviceAreaType: "walkshed" } },
          geometry: { type: "Point", coordinates: [LNG + 0.012, LAT] } }
      ];
      App.cache.applyState(st);
      App.refreshFeaturePanel();
    }, [LNG, LAT]);
    await settle(page);

    const pick = async (names) => {
      await page.locator(".fp-item", { hasText: names[0] }).first().click();
      for (const n of names.slice(1)) await page.locator(".fp-item", { hasText: n }).first().click({ modifiers: ["Control"] });
      await settle(page);
    };

    // ---- Two lines ----
    await pick(["Line A", "Line B"]);
    const secs = await sections(page);
    check("two lines share Transit service, Study area, Service schedule", ["Transit service", "Study area", "Service schedule", "Selection"].every((x) => secs.indexOf(x) >= 0), secs);
    const spd = await rowInput(page, "Avg speed").evaluate((e) => ({ v: e.value, ph: e.placeholder }));
    check("differing Avg speed shows Mixed", spd.v === "" && spd.ph === "Mixed", spd);
    const dir = await rowInput(page, "Direction").evaluate((e) => e.value);
    check("equal Direction shows the value", dir === "NB", dir);
    const svc = await page.locator("#attr-dock .ad-replace").first().textContent();
    check("differing service schedule offers Replace all", svc === "Mixed · Replace all…", svc);

    await rowInput(page, "Avg speed").fill("25");
    await rowInput(page, "Avg speed").press("Enter");
    await settle(page);
    let sp = await page.evaluate(() => App.lines.map((l) => l.properties.attributes.avgSpeed));
    check("editing Avg speed writes both lines", sp[0] === 25 && sp[1] === 25, sp);
    const after = await rowInput(page, "Avg speed").evaluate((e) => e.value);
    check("…and the row now shows the shared value", after === "25", after);
    await page.evaluate(() => document.getElementById("undo-btn").click());
    await settle(page);
    sp = await page.evaluate(() => App.lines.map((l) => l.properties.attributes.avgSpeed));
    check("one undo restores both", sp[0] === 12 && sp[1] === 20, sp);

    await page.locator("#attr-dock .ad-replace").first().click();
    await page.locator("#fp-mini-popup").waitFor({ state: "visible", timeout: 5000 });
    const seeded = await page.evaluate(() => Array.from(document.querySelectorAll("#fp-mini-popup input")).map((i) => i.value).filter(Boolean).join(","));
    check("Replace all opens seeded from the first feature", /15/.test(seeded) && !/30/.test(seeded), seeded);
    await page.keyboard.press("Escape");
    await settle(page);
    const freqs = await page.evaluate(() => App.lines.map((l) => l.properties.attributes.service.weekday[0].frequency));
    check("closing it unchanged writes nothing", freqs[0] === 15 && freqs[1] === 30, freqs);
    check("Escape closed the editor, not the dock", await page.evaluate(() => App.isAttrDockOpen()));

    // ---- Line + point ----
    await pick(["Line A", "Stop A"]);
    // Editable rows only (Measurements rows are read-only text).
    const s2 = await page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .fp-attr-row"))
      .filter((r) => r.querySelector("input, select, button")).map((r) => r.querySelector(".fp-attr-label").textContent));
    check("Line + Point share only Buffer", s2.join(",") === "Buffer", s2);
    const chips = await page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .ad-chip")).map((x) => x.textContent));
    check("type chips list each type", chips.join(",") === "1 Line,1 Point", chips);
    await rowInput(page, "Buffer").fill("0.75");
    await rowInput(page, "Buffer").press("Enter");
    await settle(page);
    const br = await page.evaluate(() => [App.lines[0].properties._bufferRadius, App.points[0].properties._bufferRadius]);
    check("Buffer writes both feature types", br[0] === 0.75 && br[1] === 0.75, br);
    await page.locator("#attr-dock .ad-chip", { hasText: "1 Line" }).click();
    await settle(page);
    const narrowed = await page.evaluate(() => ({ sel: App.getSelectedFeatures().map((s) => s.type + ":" + s.index).join(","), title: document.querySelector("#attr-dock .ad-title").value }));
    check("a chip narrows the selection to that type", narrowed.sel === "line:0" && narrowed.title === "Line A", narrowed);

    // ---- Walkshed skip ----
    await pick(["Stop A", "Stop W"]);
    const note = await page.locator("#attr-dock .ad-bulk-note").textContent().catch(() => "");
    check("Buffer notes the skipped walkshed point", note === "Skips 1 feature with a walkshed", note);
    await rowInput(page, "Buffer").fill("1");
    await rowInput(page, "Buffer").press("Enter");
    await settle(page);
    const wb = await page.evaluate(() => App.points.map((p) => p.properties._bufferRadius));
    check("…and leaves it out of the write", wb[0] === 1 && wb[1] === undefined, wb);
    const ids = await page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .fp-attr-label")).map((x) => x.textContent));
    check("Stop ID (identity field) is not offered", ids.indexOf("Stop ID") < 0, ids);

    check("no page errors", pageErrors.length === 0, pageErrors);
  } catch (e) {
    console.error(e);
    check("test ran to completion", false, e.message);
  } finally {
    if (browser) await browser.close();
    await stopServer();
  }
  const passed = results.filter((r) => r.pass).length;
  const ok = passed === results.length;
  console.log((ok ? "PASS" : "FAIL") + " — " + passed + "/" + results.length + " checks passed");
  process.exit(ok ? 0 : 1);
})();
