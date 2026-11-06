#!/usr/bin/env node
// test/browser/gpkg-store.test.mjs
//
// Behavior test for the GeoPackage file IndexedDB store (js/core/gpkg-store.js).
// Drives the real app in headless Chromium and asserts:
//
//   - the store keeps MAX_ENTRIES files, newest first, dropping the oldest
//   - update() rewrites layers and colors and keeps savedAt; an empty layers
//     list removes the file; a missing file resolves false
//   - remove() drops one file
//   - the MAX_BYTES cap evicts the oldest file, and a file over the cap is refused
//   - the bytes come back intact and size is recorded
//   - clear() empties the store
//
// Shared plumbing lives in test/browser/harness.mjs. USAGE: see
// test/browser/README.md (NODE_PATH points at a Playwright install).

import { loadPlaywright, launchBrowser, routeVendoredAssets, startStaticServer } from "./harness.mjs";

const { chromium } = loadPlaywright("test/browser/gpkg-store.test.mjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
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
    const url = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.App && App.gpkgStore", { timeout: 30000 });

    // ---- 1. Three newest kept, newest first ----
    const names1 = await page.evaluate(async () => {
      await App.gpkgStore.clear();
      for (const n of ["a", "b", "c", "d"]) {
        await App.gpkgStore.save(n, new Uint8Array(4).buffer, ["t1"], { t1: "#111111" });
      }
      return (await App.gpkgStore.list()).map((r) => r.name);
    });
    check("save a-d keeps the newest three, newest first",
      JSON.stringify(names1) === '["d","c","b"]', JSON.stringify(names1));

    // ---- 2. update() rewrites layers and colors, keeps savedAt ----
    const s2 = await page.evaluate(async () => {
      const before = (await App.gpkgStore.list()).find((r) => r.name === "c");
      const ok = await App.gpkgStore.update("c", ["t1", "t2"], { t1: "#222222" });
      const after = (await App.gpkgStore.list()).find((r) => r.name === "c");
      return {
        ok: ok,
        layers: after ? after.layers : null,
        color: after ? after.colors.t1 : null,
        savedAtSame: !!before && !!after && before.savedAt === after.savedAt
      };
    });
    check("update rewrites layers and colors and keeps savedAt",
      s2.ok === true && JSON.stringify(s2.layers) === '["t1","t2"]' && s2.color === "#222222" && s2.savedAtSame,
      JSON.stringify(s2));

    // ---- 3. Empty layers list removes the file ----
    const s3 = await page.evaluate(async () => {
      const ok = await App.gpkgStore.update("c", [], {});
      return { ok: ok, names: (await App.gpkgStore.list()).map((r) => r.name) };
    });
    check("update with empty layers removes the file",
      s3.ok === true && JSON.stringify(s3.names) === '["d","b"]', JSON.stringify(s3));

    // ---- 4. Missing file ----
    const s4 = await page.evaluate(() => App.gpkgStore.update("missing", ["x"], {}));
    check("update on a missing file resolves false", s4 === false, String(s4));

    // ---- 5. remove() ----
    const s5 = await page.evaluate(async () => {
      await App.gpkgStore.remove("b");
      return (await App.gpkgStore.list()).map((r) => r.name);
    });
    check("remove drops one file", JSON.stringify(s5) === '["d"]', JSON.stringify(s5));

    // ---- 6. MAX_BYTES cap evicts the oldest ----
    const s6 = await page.evaluate(async () => {
      await App.gpkgStore.clear();
      const MB60 = 60 * 1024 * 1024;
      await App.gpkgStore.save("big1", new ArrayBuffer(MB60), ["t1"], {});
      await App.gpkgStore.save("big2", new ArrayBuffer(MB60), ["t1"], {});
      return (await App.gpkgStore.list()).map((r) => r.name);
    });
    check("size cap drops the oldest file when the sum would exceed 100 MB",
      JSON.stringify(s6) === '["big2"]', JSON.stringify(s6));

    // ---- 7. A file over the whole cap is refused and evicts nothing ----
    const s7 = await page.evaluate(async () => {
      const ok = await App.gpkgStore.save("huge", new ArrayBuffer(101 * 1024 * 1024), ["t1"], {});
      return { ok: ok, names: (await App.gpkgStore.list()).map((r) => r.name) };
    });
    check("a file over MAX_BYTES is refused and nothing is evicted",
      s7.ok === false && JSON.stringify(s7.names) === '["big2"]', JSON.stringify(s7));

    // ---- 8. Bytes and size round-trip ----
    const s8 = await page.evaluate(async () => {
      await App.gpkgStore.clear();
      await App.gpkgStore.save("rt", new Uint8Array([1, 2, 3]), ["t1"], {});
      const rec = (await App.gpkgStore.list())[0];
      return { bytes: rec ? Array.from(new Uint8Array(rec.bytes)) : null, size: rec ? rec.size : null };
    });
    check("bytes and size round-trip",
      JSON.stringify(s8.bytes) === "[1,2,3]" && s8.size === 3, JSON.stringify(s8));

    // ---- 9. clear() empties the store ----
    const s9 = await page.evaluate(async () => {
      await App.gpkgStore.clear();
      return (await App.gpkgStore.list()).length;
    });
    check("clear empties the store and no uncaught page errors occurred",
      s9 === 0 && pageErrors.length === 0, "entries=" + s9 + (pageErrors.length ? " errors=" + pageErrors.join(" | ").slice(0, 300) : ""));
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
