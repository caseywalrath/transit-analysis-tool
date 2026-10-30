#!/usr/bin/env node
// test/browser/attr-dock.test.mjs
//
// Behavior test for the attributes dock (js/core/feature-attributes.js) and the
// map click model in js/core/editing.js:
//   - first click on a feature selects it and opens the dock; a second click on
//     the selected Line adds a vertex and leaves the dock alone
//   - clicking another feature replaces the dock's contents
//   - empty map and buffer clicks clear the selection and close the dock;
//     pinned, they do nothing
//   - finishing a drawing opens the dock on the new feature; clicks while
//     drawing never close it
//   - a half-typed field is saved when a map click closes the dock
//   - Escape closes the dock only, not an analysis panel under it
//   - a Features-list row click opens it; the row has no gear icon
//   - multi-select shows a member list; undo after delete leaves no stale dock
//   - present mode hides it; the scale bar moves clear of it
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/attr-dock.test.mjs
// Exits 0 when every check passes, 1 otherwise.

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/attr-dock.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (!pass && detail !== undefined ? "  — " + JSON.stringify(detail) : ""));
}

const LAT = 38.806;
const LNG = -104.80;

async function loadFixture(page) {
  await page.evaluate(([LNG, LAT]) => {
    var st = App.cache.collectState("full");
    st.routes = []; st.polygons = []; st.labels = [];
    st.points = [
      { type: "Feature", properties: { name: "Stop A", pointIdx: 1, color: "", attributes: {} },
        geometry: { type: "Point", coordinates: [LNG + 0.012, LAT + 0.004] } },
      // Sits on Line B, for the overlap picker.
      { type: "Feature", properties: { name: "Stop B", pointIdx: 2, color: "", attributes: {} },
        geometry: { type: "Point", coordinates: [LNG - 0.004, LAT - 0.002] } }
    ];
    st.lines = [
      { type: "Feature", properties: { name: "Line A", lineIdx: 1, color: "", attributes: {} },
        geometry: { type: "LineString", coordinates: [[LNG - 0.012, LAT - 0.004], [LNG - 0.012, LAT + 0.004]] } },
      { type: "Feature", properties: { name: "Line B", lineIdx: 2, color: "", attributes: {} },
        geometry: { type: "LineString", coordinates: [[LNG - 0.004, LAT - 0.004], [LNG - 0.004, LAT + 0.004]] } }
    ];
    App.cache.applyState(st);
    App.rebuildBuffers(0.25);
    App.refreshFeaturePanel();
    // Off-center so the leftmost line stays clear of the open dock.
    App.map.jumpTo({ center: [LNG - 0.008, LAT], zoom: 14 });
  }, [LNG, LAT]);
}

const px = (page, lng, lat) => page.evaluate(([lng, lat]) => {
  var p = App.map.project([lng, lat]); var r = App.map.getCanvasContainer().getBoundingClientRect();
  return [r.left + p.x, r.top + p.y];
}, [lng, lat]);

const dock = (page) => page.evaluate(() => {
  var el = document.getElementById("attr-dock");
  var open = !!el && el.style.display !== "none";
  return { open, title: open ? el.querySelector(".ad-title").value : "",
    sel: App.getSelectedFeatures().map((s) => s.type + ":" + s.index).join(",") };
});

async function settle(page) { await page.waitForTimeout(250); }

async function clickAt(page, lng, lat) {
  const c = await px(page, lng, lat);
  await page.mouse.click(c[0], c[1]);
  await settle(page);
}

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
    await page.waitForFunction("window.App && window.App.map && window.App.map.loaded()", { timeout: 30000 });
    await page.evaluate(() => { try { localStorage.removeItem("attrDock.pinned"); localStorage.removeItem("attrDock.collapsed"); } catch (e) {} });
    await loadFixture(page);
    await settle(page);

    // ---- First click opens; second click adds a vertex ----
    await clickAt(page, LNG - 0.012, LAT - 0.001);
    let d = await dock(page);
    check("first click on a line opens the dock on it", d.open && d.title === "Line A" && d.sel === "line:0", d);
    const nBefore = await page.evaluate(() => App.lines[0].geometry.coordinates.length);
    await clickAt(page, LNG - 0.012, LAT + 0.002);
    const nAfter = await page.evaluate(() => App.lines[0].geometry.coordinates.length);
    d = await dock(page);
    check("second click on the selected line adds a vertex", nAfter === nBefore + 1, { nBefore, nAfter });
    check("…and the dock stays on that line", d.open && d.title === "Line A", d);

    // ---- Switching ----
    await clickAt(page, LNG - 0.004, LAT);
    d = await dock(page);
    check("clicking another line replaces the dock", d.open && d.title === "Line B" && d.sel === "line:1", d);
    await clickAt(page, LNG + 0.012, LAT + 0.004);
    d = await dock(page);
    check("clicking a point shows the point", d.open && d.title === "Stop A" && d.sel === "point:0", d);

    // ---- Scale bar moves clear of the dock ----
    const ctl = await page.evaluate(() => {
      var c = document.querySelector(".maplibregl-ctrl-bottom-left").getBoundingClientRect();
      var k = document.getElementById("attr-dock").getBoundingClientRect();
      return { ctlLeft: c.left, dockRight: k.right };
    });
    check("bottom-left map controls sit right of the dock", ctl.ctlLeft >= ctl.dockRight - 1, ctl);

    // ---- Buffer click counts as empty map ----
    const bufHit = await page.evaluate(([lng, lat]) => {
      var p = App.map.project([lng, lat]);
      return App.map.queryRenderedFeatures([p.x, p.y], { layers: ["buffers-fill"] }).length;
    }, [LNG + 0.012 + 0.0015, LAT + 0.004]);
    await clickAt(page, LNG + 0.012 + 0.0015, LAT + 0.004);
    d = await dock(page);
    check("a click inside a buffer closes the dock and clears the selection", bufHit > 0 && !d.open && d.sel === "", { bufHit, d });

    // ---- Empty map + pin ----
    await clickAt(page, LNG + 0.012, LAT + 0.004);
    await page.click("#attr-dock .ad-pin");
    await clickAt(page, LNG + 0.006, LAT - 0.009);
    d = await dock(page);
    check("pinned: an empty-map click keeps the dock and selection", d.open && d.sel === "point:0", d);
    await page.click("#attr-dock .ad-pin");
    await clickAt(page, LNG + 0.006, LAT - 0.009);
    d = await dock(page);
    check("unpinned: an empty-map click closes the dock and clears the selection", !d.open && d.sel === "", d);

    // ---- Typing is saved when a map click closes the dock ----
    await clickAt(page, LNG + 0.012, LAT + 0.004);
    const stopInput = page.locator("#attr-dock .fp-attr-row", { hasText: "Stop ID" }).locator("input");
    await stopInput.click();
    await page.keyboard.type("1042");
    await clickAt(page, LNG + 0.006, LAT - 0.009);
    const stopId = await page.evaluate(() => App.points[0].properties.attributes.stopId);
    check("a half-typed field is saved when an empty-map click closes the dock", stopId === "1042", stopId);

    // ---- Escape closes only the dock ----
    await clickAt(page, LNG - 0.004, LAT);
    await page.evaluate(() => App.openAttributeSummary());
    await page.waitForFunction(() => App.popup.isOpen(), { timeout: 10000 }).catch(() => {});
    await page.mouse.move(5, 890);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("Escape");
    await settle(page);
    const esc1 = { dock: (await dock(page)).open, panel: await page.evaluate(() => App.popup.isOpen()) };
    check("Escape closes the dock but not the analysis panel", !esc1.dock && esc1.panel, esc1);
    await page.keyboard.press("Escape");
    await settle(page);
    check("a second Escape closes the analysis panel", !(await page.evaluate(() => App.popup.isOpen())));

    // ---- Drawing ----
    // Picking a draw tool clears the selection (so the dock closes); clicks
    // while drawing must not open it on whatever lies under them.
    await page.keyboard.press("l");
    await clickAt(page, LNG + 0.012, LAT + 0.004);
    d = await dock(page);
    check("a draw click on an existing point does not open the dock", !d.open, d);
    await clickAt(page, LNG + 0.012, LAT - 0.006);
    await page.keyboard.press("Enter");
    await settle(page);
    d = await dock(page);
    const nLines = await page.evaluate(() => App.lines.length);
    check("finishing a line opens the dock on the new line", d.open && d.sel === "line:" + (nLines - 1) && d.title === App_lineName(nLines), { d, nLines });

    // ---- Features list ----
    await page.keyboard.press("Escape");
    await settle(page);
    await page.locator(".fp-item", { hasText: "Line B" }).first().click();
    await settle(page);
    d = await dock(page);
    check("a Features-list row click opens the dock", d.open && d.title === "Line B", d);
    check("Features rows have no gear icon", (await page.locator(".fp-gear-btn").count()) === 0);

    // ---- Multi-select ----
    await page.locator(".fp-item", { hasText: "Line A" }).first().click({ modifiers: ["Control"] });
    await settle(page);
    const multi = await page.evaluate(() => ({
      title: document.querySelector("#attr-dock .ad-title").value,
      members: Array.from(document.querySelectorAll("#attr-dock .ad-member-name")).map((x) => x.textContent).sort()
    }));
    check("a multi-selection shows a member list", multi.title === "2 features selected" && multi.members.join(",") === "Line A,Line B", multi);
    await page.locator("#attr-dock .ad-member", { hasText: "Line A" }).click();
    await settle(page);
    d = await dock(page);
    check("clicking a member narrows to it", d.open && d.title === "Line A" && d.sel === "line:0", d);

    // ---- Delete + undo ----
    await page.evaluate(() => { App.deleteFeature("line", 0); });
    await settle(page);
    d = await dock(page);
    check("deleting the shown feature closes the dock", !d.open, d);
    await page.evaluate(() => document.getElementById("undo-btn").click());
    await settle(page);
    d = await dock(page);
    check("undo does not reopen a stale dock", !d.open, d);

    // ---- Header toolbar, overlap picker, sections ----
    const tools = () => page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .ad-tool")).map((b) => b.textContent));
    const sections = () => page.evaluate(() => Array.from(document.querySelectorAll("#attr-dock .ad-section")).map((x) => x.getAttribute("data-section")));
    await clickAt(page, LNG - 0.004, LAT - 0.002);
    d = await dock(page);
    let t = await tools();
    check("a click on a point over a line shows the point with \"1 more here\"", d.title === "Stop B" && t.indexOf("1 more here \u25BE") >= 0, { d, t });
    await page.locator("#attr-dock .ad-tool-more").click();
    await page.locator("#fp-context-menu button", { hasText: "Line B" }).click();
    await settle(page);
    d = await dock(page);
    check("picking from \"more here\" switches to the line under the point", d.title === "Line B" && d.sel === "line:1", d);
    t = await tools();
    check("single-feature toolbar: Zoom to, Duplicate, Hide, Delete", ["Zoom to", "Duplicate", "Hide", "Delete"].every((x) => t.indexOf(x) >= 0), t);
    const secs = await sections();
    check("line sections: Transit service, Study area, Walk network, Service schedule, Measurements, Used in, Details",
      ["Transit service", "Walk network", "Study area", "Service schedule", "Measurements", "Used in", "Details"].every((x) => secs.indexOf(x) >= 0), secs);
    check("footer links to Attribute Summary", (await page.locator("#attr-dock .ad-footer .ad-link").textContent()) === "Open in Attribute Summary");
    const meas = await page.evaluate(() => document.querySelector('#attr-dock .ad-section[data-section="Measurements"]').textContent);
    check("Measurements shows length and vertices", /Length/.test(meas) && /Vertices\s*2/.test(meas), meas);

    await page.locator('#attr-dock .ad-section[data-section="Measurements"] .ad-section-head').click();
    await page.locator(".fp-item", { hasText: "Line A" }).first().click();
    await settle(page);
    const closedOnA = await page.evaluate(() => document.querySelector('#attr-dock .ad-section[data-section="Measurements"]').classList.contains("ad-section-closed"));
    check("a collapsed section stays collapsed on the next feature", closedOnA);
    await page.locator('#attr-dock .ad-section[data-section="Measurements"] .ad-section-head').click();

    await page.locator("#attr-dock .ad-tool", { hasText: /^Hide$/ }).click();
    await settle(page);
    const hid = { hidden: await page.evaluate(() => !!App.lines[0].properties.hidden), t: await tools() };
    check("Hide hides the feature and the button becomes Show", hid.hidden && hid.t.indexOf("Show") >= 0, hid);
    await page.locator("#attr-dock .ad-tool", { hasText: /^Show$/ }).click();
    await settle(page);
    check("Show brings it back", !(await page.evaluate(() => !!App.lines[0].properties.hidden)));

    await page.fill("#attr-dock .ad-title", "Renamed A");
    await page.keyboard.press("Enter");
    await settle(page);
    const ren = await page.evaluate(() => ({ name: App.lines[0].properties.name,
      row: Array.from(document.querySelectorAll(".fp-item .fp-name")).some((x) => (x.value || x.textContent) === "Renamed A") }));
    check("renaming in the header renames the feature and its Features row", ren.name === "Renamed A" && ren.row, ren);
    await page.keyboard.press("Escape");
    await settle(page);

    // ---- Collapse + present mode ----
    await clickAt(page, LNG + 0.012, LAT + 0.004);
    await page.click("#attr-dock .ad-collapse");
    const rail = await page.evaluate(() => document.getElementById("attr-dock").getBoundingClientRect().width);
    check("collapse shrinks the dock to a rail", rail > 0 && rail <= 40, rail);
    await page.click("#attr-dock .ad-collapse");
    await page.evaluate(() => App.setPresentMode(true));
    const hidden = await page.evaluate(() => getComputedStyle(document.getElementById("attr-dock")).display === "none");
    check("present mode hides the dock", hidden);
    await page.evaluate(() => App.setPresentMode(false));

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

function App_lineName(n) { return "Line " + n; }
