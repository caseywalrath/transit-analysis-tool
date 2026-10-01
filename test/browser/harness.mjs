// test/browser/harness.mjs
//
// Shared Playwright plumbing for the browser test tier: loading the
// `playwright` package (installed outside the repo — see below), resolving
// preinstalled Chromium, vendored-CDN asset interception, a local static
// file server, and small polling utilities. Used by both
// test/ui-screens/capture.mjs (pixel regression) and every
// test/browser/*.test.mjs (behavior assertions) so this plumbing exists in
// exactly one place instead of two copies drifting apart. See
// docs/browser-test-harness-plan.md.
//
// This repo has no npm install of its own (CLAUDE.md — "No build tools"), so
// Playwright is installed once in a scratch directory OUTSIDE the repo and
// resolved at runtime via NODE_PATH:
//
//   mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null
//   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
//   NODE_PATH=/tmp/pw-install/node_modules node <calling-script>.mjs
//
// In the Claude Code cloud environment, Chromium is preinstalled at
// /opt/pw-browsers/chromium — no browser download needed
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 above just stops npm from trying).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const VENDOR_DIR = join(REPO_ROOT, "test", "ui-screens", "vendor");

// ---- Playwright loader ----
// `NODE_PATH` only affects Node's CommonJS require() resolution, not ESM
// import — that's why this is a createRequire() load rather than a
// top-level `import "playwright"`, which would not see NODE_PATH at all.
// `scriptPath` names the calling script in the install instructions so a
// failure points at a command that actually works from wherever it failed.

const req = createRequire(import.meta.url);

export function loadPlaywright(scriptPath) {
  try {
    return req("playwright");
  } catch (e) {
    console.error("Could not load the 'playwright' package (" + e.message + ").");
    console.error("Install it once outside the repo and point NODE_PATH at it:");
    console.error("  mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null");
    console.error("  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright");
    console.error("  NODE_PATH=/tmp/pw-install/node_modules node " + scriptPath);
    process.exit(1);
  }
}

// ---- Chromium resolution ----

const CHROMIUM_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  "/opt/pw-browsers/chromium"
].filter(Boolean);

export function resolveExecutablePath() {
  for (const p of CHROMIUM_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's own managed browser
}

export function launchBrowser(chromium) {
  return chromium.launch({
    executablePath: resolveExecutablePath(),
    headless: true,
    args: ["--no-sandbox"]
  });
}

// ---- Vendored CDN assets ----
// Pinned copies of the CDN scripts index.html loads (see
// test/ui-screens/README.md for how they were fetched/refreshed). Single
// source of truth for every browser test — nothing here or under
// test/browser/ keeps its own copy of this map.

export const VENDOR_MAP = new Map([
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js", { file: "maplibre-gl.js", type: "application/javascript" }],
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css", { file: "maplibre-gl.css", type: "text/css" }],
  ["https://unpkg.com/@turf/turf@6.5.0/turf.min.js", { file: "turf.min.js", type: "application/javascript" }],
  ["https://unpkg.com/pako@2.1.0/dist/pako.min.js", { file: "pako.min.js", type: "application/javascript" }],
  ["https://unpkg.com/papaparse@5.4.1/papaparse.min.js", { file: "papaparse.min.js", type: "application/javascript" }],
  ["https://unpkg.com/jszip@3.10.1/dist/jszip.min.js", { file: "jszip.min.js", type: "application/javascript" }],
  ["https://unpkg.com/shapefile@0.6.6/dist/shapefile.js", { file: "shapefile.js", type: "application/javascript" }]
]);

// Vendors CDN assets locally, allows the local static server through, and
// aborts every other remote request (tiles, Census, OSRM, fonts, ...) so a
// run stays fast, deterministic, and offline-safe. `extraHandler(route,
// url)` is optional and runs first; return a truthy value from it to signal
// "handled" (it already called route.fulfill/abort/continue) and skip the
// vendor/abort fallthrough below. capture.mjs passes no extraHandler; a
// behavior test uses it to stub an API such as Overpass.
export async function routeVendoredAssets(context, port, extraHandler) {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (extraHandler) {
      const handled = await extraHandler(route, url);
      if (handled) return;
    }
    const vendored = VENDOR_MAP.get(url);
    if (vendored) {
      return route.fulfill({
        status: 200,
        contentType: vendored.type,
        body: readFileSync(join(VENDOR_DIR, vendored.file))
      });
    }
    if (url.startsWith("http://localhost:" + port + "/") || url.startsWith("http://127.0.0.1:" + port + "/")) {
      return route.continue();
    }
    return route.abort();
  });
}

// ---- Static file server ----

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function waitForHttpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get({ host: "127.0.0.1", port, path: "/index.html", timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("static server never became ready on port " + port));
        setTimeout(attempt, 100);
      });
      req.on("timeout", () => req.destroy());
    }
    attempt();
  });
}

// Spawns `python3 -m http.server` rooted at the repo (the app fetches popup
// HTML fragments at runtime, so it must be served over HTTP, not opened as a
// file:// URL) and waits until it answers. Returns `{ port, stop() }`;
// `stop()` kills the server process — call it in a `finally` block.
export async function startStaticServer() {
  const port = await findFreePort();
  const pythonExecutable = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const server = spawn(pythonExecutable, ["-m", "http.server", String(port)], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForHttpReady(port, 10000);
  return { port, stop: () => server.kill() };
}

// ---- Misc ----

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
