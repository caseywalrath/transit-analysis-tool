#!/usr/bin/env node
// test/browser/coord-pin.test.mjs
//
// Behavior test for coord-pin.js: a plain click on empty map pins its lat/lon
// (6 decimals, "lat, lon") on the scale bar's row; clicking a drawn feature or
// using a draw tool does not; Esc / × clears it; right-click offers
// "Copy coordinates" on empty map and in the feature menu.
//
// USAGE: NODE_PATH=/opt/node-tools/node_modules node test/browser/coord-pin.test.mjs

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/coord-pin.test.mjs");
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (!pass && detail !== undefined ? "  — " + JSON.stringify(detail) : ""));
}

(async () => {
  const { port, stop: stopServer } = await startStaticServer();
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await routeVendoredAssets(context, port);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.waitForFunction("window.App && App.map && App.map.loaded() && App.cache", { timeout: 30000 });
    await page.evaluate(() => App.cache.reset && App.cache.reset());
    await page.evaluate(() => App.map.jumpTo({ center: [-104.79, 38.806], zoom: 14 }));
    await page.evaluate(() => {
      var st = App.cache.collectState("full");
      st.points = [{ type: "Feature", properties: { name: "P", color: "#ff0000", attributes: {} },
        geometry: { type: "Point", coordinates: [-104.79, 38.806] } }];
      App.cache.applyState(st);
      App.refreshFeaturePanel();
    });
    await page.waitForTimeout(500);

    const canvas = await page.locator("#map canvas").boundingBox();
    const toScreen = (lng, lat) => page.evaluate(([a, b]) => { var p = App.map.project([a, b]); return [p.x, p.y]; }, [lng, lat]);
    const boxState = () => page.evaluate(() => {
      var b = document.querySelector("#map .coord-pin");
      var s = document.querySelector("#map .maplibregl-ctrl-scale");
      if (!b) return null;
      var br = b.getBoundingClientRect(), sr = s.getBoundingClientRect();
      return { hidden: b.hidden, text: b.querySelector(".coord-pin-text").textContent,
        sameRow: Math.abs((br.top + br.bottom) / 2 - (sr.top + sr.bottom) / 2) < 6, rightOfScale: br.left >= sr.right,
        markers: document.querySelectorAll(".coord-pin-marker").length };
    });

    const empty = await toScreen(-104.78, 38.80);
    await page.mouse.click(canvas.x + empty[0], canvas.y + empty[1]);
    await page.waitForTimeout(200);
    let st = await boxState();
    // Mouse clicks land on whole pixels, so compare against the click spot loosely.
    const expected = st && st.text;
    const [eLat, eLng] = (expected || "0, 0").split(", ").map(Number);
    check("empty-map click pins lat, lon at 6 decimals",
      st && !st.hidden && /^-?\d+\.\d{6}, -?\d+\.\d{6}$/.test(st.text) && Math.abs(eLat - 38.80) < 1e-4 && Math.abs(eLng + 104.78) < 1e-4, st);
    check("box sits on the scale bar's row, to its right", st && st.sameRow && st.rightOfScale, st);
    check("a marker shows the pinned spot", st && st.markers === 1, st);

    await page.locator("#map .coord-pin .coord-pin-copy").click();
    await page.waitForTimeout(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check("copy button copies the text", clip === expected, { clip, expected });

    const pt = await toScreen(-104.79, 38.806);
    await page.mouse.click(canvas.x + pt[0], canvas.y + pt[1]);
    await page.waitForTimeout(200);
    st = await boxState();
    check("clicking a drawn feature leaves the pin unchanged", st.text === expected, st);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    st = await boxState();
    check("Escape clears the pin and marker", st.hidden && st.markers === 0, st);

    await page.evaluate(() => { App.drawMode = "point"; });
    await page.mouse.click(canvas.x + empty[0] + 30, canvas.y + empty[1]);
    await page.evaluate(() => { App.drawMode = null; });
    await page.waitForTimeout(200);
    st = await boxState();
    check("no pin while a draw tool is active", st.hidden, st);

    const menuText = () => page.evaluate(() => { var m = document.getElementById("fp-context-menu"); return m ? m.textContent : ""; });
    await page.mouse.click(canvas.x + empty[0], canvas.y + empty[1], { button: "right" });
    await page.waitForTimeout(200);
    let menu = await menuText();
    check("empty-map right-click offers Copy coordinates", menu.trim() === "Copy coordinates", menu);
    await page.locator("#fp-context-menu").getByText("Copy coordinates").click();
    await page.waitForTimeout(200);
    const clip2 = await page.evaluate(() => navigator.clipboard.readText());
    st = await boxState();
    check("menu item copies and pins the clicked spot", clip2 === expected && !st.hidden && st.text === expected, { clip2, st });

    await page.mouse.click(canvas.x + pt[0], canvas.y + pt[1], { button: "right" });
    await page.waitForTimeout(200);
    menu = await menuText();
    check("feature right-click menu also has Copy coordinates", /Duplicate/.test(menu) && /Copy coordinates/.test(menu), menu);

    check("no page errors", pageErrors.length === 0, pageErrors);
  } catch (err) {
    console.error(err);
    check("test ran without throwing", false, String(err));
  } finally {
    if (browser) await browser.close();
    stopServer();
  }
  const passed = results.filter((r) => r.pass).length;
  console.log((passed === results.length ? "PASS" : "FAIL") + " — " + passed + "/" + results.length + " checks passed");
  process.exit(passed === results.length ? 0 : 1);
})();
