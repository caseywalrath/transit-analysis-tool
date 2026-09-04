#!/usr/bin/env node
// test/ui-screens/capture.mjs
//
// Screenshots the app shell and every module popup in light + dark mode, so
// later UI-refresh phases can diff their work against a mechanical baseline.
// No product code is touched by this script — it only drives a browser
// against the app's real static files over a local HTTP server.
//
// USAGE
//   node test/ui-screens/capture.mjs
//
// Requires the "playwright" npm package to be resolvable. This repo has no
// npm install of its own (see CLAUDE.md — "No build tools"), so install it
// once in a scratch directory OUTSIDE the repo and point NODE_PATH at it:
//
//   mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null
//   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
//   NODE_PATH=/tmp/pw-install/node_modules node test/ui-screens/capture.mjs
//
// In the Claude Code cloud environment, Chromium is preinstalled at
// /opt/pw-browsers/chromium — no browser download needed
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 above just stops npm from trying).
//
// WHY REQUESTS ARE INTERCEPTED
// The app loads MapLibre GL / Turf / pako / PapaParse / JSZip / shapefile
// from unpkg.com via <script>/<link> tags (see index.html). Sandboxed
// environments often cannot reach those CDN hosts at all (org egress
// policy, not just flaky tiles), which would prevent App.map from ever
// being created. So this script vendors pinned copies of those exact files
// under test/ui-screens/vendor/ (fetched once via `npm pack`, see that
// directory's note in test/ui-screens/README.md) and serves them via
// Playwright route interception — index.html itself is never modified.
// Every other remote host (basemap tiles, Census/TIGERweb, OSRM, Google
// Fonts) is aborted immediately so the run stays fast and deterministic;
// we're checking UI chrome, not live data or map imagery.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const OUT_DIR = join(HERE, "out");
const VENDOR_DIR = join(HERE, "vendor");
const FIXTURE_PATH = join(HERE, "fixture-session.json");
const VIEWPORT = { width: 1600, height: 950 };
const NARROW_VIEWPORT = { width: 1280, height: 800 };
const MAP_READY_TIMEOUT_MS = 30000;
const POPUP_SETTLE_MS = 600;
const TAB_SETTLE_MS = 300;

// ---- Playwright loader (see USAGE above for why this isn't a plain import) ----

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch (e) {
  console.error("Could not load the 'playwright' package (" + e.message + ").");
  console.error("Install it once outside the repo and point NODE_PATH at it:");
  console.error("  mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null");
  console.error("  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright");
  console.error("  NODE_PATH=/tmp/pw-install/node_modules node test/ui-screens/capture.mjs");
  process.exit(1);
}
const { chromium } = playwright;

const CHROMIUM_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  "/opt/pw-browsers/chromium"
].filter(Boolean);

function resolveExecutablePath() {
  for (const p of CHROMIUM_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's own managed browser
}

// ---- Vendored CDN assets (see header comment) ----

const VENDOR_MAP = new Map([
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js", { file: "maplibre-gl.js", type: "application/javascript" }],
  ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css", { file: "maplibre-gl.css", type: "text/css" }],
  ["https://unpkg.com/@turf/turf@6.5.0/turf.min.js", { file: "turf.min.js", type: "application/javascript" }],
  ["https://unpkg.com/pako@2.1.0/dist/pako.min.js", { file: "pako.min.js", type: "application/javascript" }],
  ["https://unpkg.com/papaparse@5.4.1/papaparse.min.js", { file: "papaparse.min.js", type: "application/javascript" }],
  ["https://unpkg.com/jszip@3.10.1/dist/jszip.min.js", { file: "jszip.min.js", type: "application/javascript" }],
  ["https://unpkg.com/shapefile@0.6.6/dist/shapefile.js", { file: "shapefile.js", type: "application/javascript" }]
]);

// ---- Module popups to capture (id must match App.registerModule({id: ...})) ----

const MODULE_IDS = [
  "buffer-summary",
  "transit-propensity",
  "fta-small-starts",
  "ridership-forecasting",
  "corridor-scoring",
  "walkshed",
  "transit-travelshed",
  "transit-coverage",
  "route-costing",
  "trip-builder",
  "title-vi",
  "gtfs",
  "zeb-feasibility",
  "attribute-summary",
  "display-settings"
];

// Phase 7b: active single-step tools start as map-friendly vertical task
// panels, then widen only after a completed run or when FTA opens its upload
// workspace. Values are deliberately asserted against the actual dialog,
// rather than inferred from registration metadata.
// Mirrors each module's own panelWidths declaration. Two invariants hold for
// every entry (asserted below, and in CLAUDE.md's "Adaptive single-step panel
// widths"): setup === results, and both <= 620 (the @container stacking
// breakpoint). Together those keep each panel a narrow, vertically stacked task
// panel that never resizes on run. `workspace` is exempt — FTA's Data Inputs is
// a deliberately wide file-upload surface, not a results view. Route
// Electrification Feasibility is the one deliberate unequal-width exception
// (see CLAUDE.md) — its own invariant is asserted separately below instead:
// whenever Inputs are collapsed (the only state its wider `results` width is
// ever shown in), `.rf-section-row` must still be column-stacked.
const UNEQUAL_WIDTH_EXEMPT = new Set(["zeb-feasibility"]);
const ADAPTIVE_PANEL_WIDTHS = {
  "buffer-summary": { setup: 600, results: 600 },
  "transit-propensity": { setup: 520, results: 520 },
  "corridor-scoring": { setup: 600, results: 600 },
  "fta-small-starts": { setup: 520, results: 520, workspace: 1000 },
  "walkshed": { setup: 460, results: 460 },
  "transit-coverage": { setup: 600, results: 600 },
  "transit-travelshed": { setup: 600, results: 600 },
  "zeb-feasibility": { setup: 600, results: 760 }
};

// Guard the invariants at load time, so a future width edit that would un-stack
// a panel (results > 620) or make it jump on run (setup !== results) fails here
// rather than silently shipping — that exact regression is what put the results
// table beside the inputs instead of below them. UNEQUAL_WIDTH_EXEMPT ids skip
// only the equal-width check; their `setup` width still must not exceed the
// breakpoint (it's the width shown before Inputs ever collapse).
const STACK_BREAKPOINT_PX = 620;
for (const [id, w] of Object.entries(ADAPTIVE_PANEL_WIDTHS)) {
  if (w.setup !== w.results && !UNEQUAL_WIDTH_EXEMPT.has(id)) {
    throw new Error(
      "ADAPTIVE_PANEL_WIDTHS." + id + ": setup (" + w.setup + ") must equal results (" +
      w.results + ") — unequal widths make the panel resize on run."
    );
  }
  if (w.setup > STACK_BREAKPOINT_PX) {
    throw new Error(
      "ADAPTIVE_PANEL_WIDTHS." + id + ": " + w.setup + "px exceeds the " +
      STACK_BREAKPOINT_PX + "px stacking breakpoint — the panel would un-stack."
    );
  }
}
const COLLAPSIBLE_INPUT_MODULE_IDS = new Set(Object.keys(ADAPTIVE_PANEL_WIDTHS));
const DISPLAY_BUFFER_CONTROL_IDS = {
  "buffer-summary": ["#basUseDisplayBuffers", "#basBufferMiles"],
  "transit-propensity": ["#tpiUseDisplayBuffers", "#tpiBufferMiles"],
  "ridership-forecasting": ["#rfUseDisplayBuffers", "#rfBufferMiles"],
  "corridor-scoring": ["#csUseDisplayBuffers", "#csBufferMiles"],
  "transit-coverage": ["#tcUseDisplayBuffers", "#tcBufferMiles"]
};

// ---- Small utilities ----

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHttpReady(port, timeoutMs) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Report ----
// status: "ok" | "fail" | "skip" — only "fail" makes the run exit non-zero.
// "skip" is for documented, expected-every-run gaps (see the sidebar note
// below) so the harness stays usable as a pass/fail gate for later phases.

const results = []; // { name, status, note, width, height }
let anyFailure = false;

function record(name, status, note, dims) {
  results.push({ name, status, note: note || "", width: dims && dims.width, height: dims && dims.height });
  if (status === "fail") anyFailure = true;
  const label = status === "ok" ? "OK  " : status === "skip" ? "SKIP" : "FAIL";
  const dimStr = dims ? dims.width + "x" + dims.height : "";
  console.log("[" + label + "] " + name + (dimStr ? "  " + dimStr : "") + (note ? "  (" + note + ")" : ""));
}

async function shootLocator(page, selector, outPath, name) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 10000 });
  const box = await loc.boundingBox();
  await loc.screenshot({ path: outPath });
  record(name, "ok", null, box ? { width: Math.round(box.width), height: Math.round(box.height) } : null);
}

async function shootPage(page, outPath, name) {
  await page.screenshot({ path: outPath });
  record(name, "ok", null, page.viewportSize() || VIEWPORT);
}

async function assertAdaptivePanelLayout(page, theme, id) {
  const widths = ADAPTIVE_PANEL_WIDTHS[id];
  if (!widths) return;

  const name = theme + "_" + id + "_adaptive-layout";
  try {
    const inspect = () => page.locator(".module-popup-dialog").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const row = el.querySelector(".rf-section-row");
      const inputs = el.querySelector(".module-inputs-header");
      return {
        width: Math.round(rect.width),
        inViewport: rect.left >= 0 && rect.right <= window.innerWidth,
        flow: row ? getComputedStyle(row).flexDirection : null,
        inputsExpanded: inputs ? inputs.getAttribute("aria-expanded") : null
      };
    });
    const assertState = async (mode, expectedWidth) => {
      const state = await inspect();
      if (state.width !== expectedWidth) {
        throw new Error(mode + " width " + state.width + "px; expected " + expectedWidth + "px");
      }
      if (!state.inViewport) throw new Error(mode + " panel exceeds the viewport");
      const expectedFlow = expectedWidth <= 620 ? "column" : "row";
      if (state.flow !== expectedFlow) {
        throw new Error(mode + " flow " + state.flow + "; expected " + expectedFlow);
      }
      return state;
    };

    const setup = await assertState("setup", widths.setup);
    if (setup.inputsExpanded !== "true") {
      throw new Error("setup inputs should be expanded; aria-expanded=" + setup.inputsExpanded);
    }

    await page.evaluate(() => window.App.popup.setLayoutMode("results"));
    await assertState("results", widths.results || widths.setup);

    if (id === "fta-small-starts") {
      await page.locator('.module-popup-dialog button[data-tab="data-inputs"]:visible').click();
      await assertState("workspace", widths.workspace);
      await page.locator('.module-popup-dialog button[data-tab="ratings"]:visible').click();
      await assertState("ratings", widths.setup);
    }

    // A user who reopens Inputs after viewing results must return to the
    // narrow vertical form. Otherwise a wide result panel regresses to the
    // former Settings | Results split while editing inputs.
    const inputsHeader = page.locator(".module-inputs-header:visible");
    await page.evaluate(() => window.App.popup.setLayoutMode("results"));
    await page.evaluate(() => {
      const dialog = document.querySelector(".module-popup-dialog");
      dialog.style.transform = "translate(-96px, 24px)";
    });
    await inputsHeader.click();
    const transformAfterCollapse = await page.locator(".module-popup-dialog").evaluate((el) => el.style.transform);
    if (transformAfterCollapse !== "translate(-96px, 24px)") {
      throw new Error("collapsing Inputs changed the panel docking transform");
    }
    await inputsHeader.click();
    const transformAfterExpand = await page.locator(".module-popup-dialog").evaluate((el) => el.style.transform);
    if (transformAfterExpand !== "translate(-96px, 24px)") {
      throw new Error("opening Inputs changed the panel docking transform");
    }
    const reopened = await assertState("reopened inputs", widths.setup);
    if (reopened.inputsExpanded !== "true") {
      throw new Error("reopened Inputs should be expanded; aria-expanded=" + reopened.inputsExpanded);
    }

    await page.evaluate(() => window.App.popup.setLayoutMode("setup"));
    await assertState("restored setup", widths.setup);
    record(name, "ok");
  } catch (e) {
    record(name, "fail", e.message);
  }
}

async function assertDisplayBufferControl(page, theme, id) {
  const pair = DISPLAY_BUFFER_CONTROL_IDS[id];
  if (!pair) return;
  const [toggleSelector, inputSelector] = pair;
  const name = theme + "_" + id + "_display-buffers";
  try {
    const toggle = page.locator(toggleSelector + ":visible");
    const input = page.locator(inputSelector + ":visible");
    const initial = await toggle.isChecked();
    if (await input.isDisabled() !== initial) {
      throw new Error("buffer field disabled state does not match Use Display Buffers");
    }
    await toggle.click();
    if (await input.isDisabled() === initial) {
      throw new Error("Use Display Buffers did not toggle the field disabled state");
    }
    await toggle.click();
    if (await input.isDisabled() !== initial) {
      throw new Error("Use Display Buffers did not restore the field disabled state");
    }
    record(name, "ok");
  } catch (e) {
    record(name, "fail", e.message);
  }
}

// ---- Main capture routine for one theme ----

async function captureTheme(browser, theme, port) {
  const isDark = theme === "dark";
  const fixture = readFileSync(FIXTURE_PATH, "utf8");

  const context = await browser.newContext({ viewport: VIEWPORT });

  // Seed localStorage (dark-mode flag + demo session) before any page script runs.
  await context.addInitScript(
    ({ isDark, fixtureJson }) => {
      localStorage.setItem("mat-dark-mode", isDark ? "1" : "0");
      localStorage.setItem("mat-session", fixtureJson);
    },
    { isDark, fixtureJson: fixture }
  );

  // Vendor CDN assets locally; abort everything else remote (tiles, Census,
  // OSRM, Google Fonts) so the run is fast, deterministic, and offline-safe.
  await context.route("**/*", (route) => {
    const url = route.request().url();
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

  const page = await context.newPage();
  page.on("pageerror", (e) => console.warn("  [page error] " + e.message));

  await page.goto("http://localhost:" + port + "/index.html", { waitUntil: "load" });

  try {
    await page.waitForFunction(
      "window.App && window.App.map && window.App.map.loaded()",
      { timeout: MAP_READY_TIMEOUT_MS }
    );
  } catch (e) {
    console.warn("  [warn] map did not report loaded() within " + MAP_READY_TIMEOUT_MS + "ms — continuing anyway (chrome is what we're checking).");
  }

  // Phase 7 fixed the no-flash script so pre-seeded dark mode applies before
  // first paint. Keep the real-button fallback for older snapshots or any
  // future page variant that does not pre-apply the class.
  if (isDark) {
    try {
      const alreadyDark = await page.locator("body").evaluate((el) => el.classList.contains("dark-mode"));
      if (!alreadyDark) await page.click("#darkmode-btn", { timeout: 5000 });
      await page.waitForFunction(
        "document.body.classList.contains('dark-mode')",
        { timeout: 5000 }
      );
    } catch (e) {
      console.warn("  [warn] could not engage dark mode via #darkmode-btn: " + e.message);
    }
  }

  // ---- Shell (full viewport) ----
  try {
    await page.screenshot({ path: join(OUT_DIR, theme + "_shell.png") });
    record(theme + "_shell", "ok", null, VIEWPORT);
  } catch (e) {
    record(theme + "_shell", "fail", e.message);
  }

  // ---- Phase 7 grouped Analysis menu ----
  try {
    await page.locator("#analysis-btn").click();
    const analysisMenuCheck = await page.locator("#analysis-dropdown").evaluate((dropdown) => {
      const headings = Array.from(dropdown.querySelectorAll(":scope > .analysis-module-list > .add-data-heading"));
      const groups = headings.map((heading) => {
        const buttons = [];
        let node = heading.nextElementSibling;
        while (node && !node.classList.contains("add-data-heading")) {
          if (node.matches(".analysis-module-btn")) buttons.push(node.textContent.replace(/\s*\(coming soon\)/, "").trim());
          node = node.nextElementSibling;
        }
        return { label: heading.textContent.trim(), buttons };
      });
      return groups;
    });
    if (analysisMenuCheck.length !== 2 || analysisMenuCheck[0].label !== "General" ||
        analysisMenuCheck[1].label !== "Transit Planning") {
      throw new Error("Analysis menu groups are not General and Transit Planning");
    }
    if (analysisMenuCheck[0].buttons.join("|") !== "Feature Area Analysis|Walkshed Analysis") {
      throw new Error("General Analysis menu order is incorrect");
    }
    const transitSorted = analysisMenuCheck[1].buttons.slice().sort((a, b) => a.localeCompare(b));
    if (transitSorted.join("|") !== analysisMenuCheck[1].buttons.join("|")) {
      throw new Error("Transit Planning menu is not alphabetized");
    }
    await shootLocator(
      page,
      "#analysis-dropdown",
      join(OUT_DIR, theme + "_phase7-analysis-menu.png"),
      theme + "_phase7-analysis-menu"
    );
    await page.locator("#analysis-btn").click();
  } catch (e) {
    record(theme + "_phase7-analysis-menu", "fail", e.message);
  }

  // ---- Sidebar ----
  // NOTE: #sidebar-wrap ships with inline style="display:none" in index.html
  // and nothing in the current codebase (grep confirms no App.sidebar.render()
  // call anywhere) ever shows it — the left "Data Inputs" sidebar is dead in
  // this build (Data Inputs / Analysis both moved elsewhere: buffer-summary
  // popup and the toolbar Analysis dropdown, respectively). That's a
  // pre-existing product fact, not something phase 0 changes, so this capture
  // is expected to be skipped every run until/unless that changes.
  try {
    await shootLocator(page, "#sidebar-wrap", join(OUT_DIR, theme + "_sidebar.png"), theme + "_sidebar");
  } catch (e) {
    record(theme + "_sidebar", "skip", "#sidebar-wrap is hidden by default in the current UI (dead code, not a phase-0 regression)");
  }

  // ---- Feature panel ----
  try {
    await shootLocator(page, "#feature-panel", join(OUT_DIR, theme + "_feature-panel.png"), theme + "_feature-panel");
  } catch (e) {
    record(theme + "_feature-panel", "fail", e.message);
  }

  // ---- Phase 7 accessibility smoke checks ----
  try {
    const missingIconLabels = await page.evaluate(() => Array.from(document.querySelectorAll("button"))
      .filter((b) => b.offsetParent !== null && b.querySelector("svg") && !b.textContent.trim() && !b.getAttribute("aria-label"))
      .map((b) => b.id || b.className || "unnamed button"));
    if (missingIconLabels.length) throw new Error("icon buttons missing aria-label: " + missingIconLabels.join(", "));

    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    await sleep(TAB_SETTLE_MS);
    const rowTargetIssues = await page.evaluate(() => Array.from(document.querySelectorAll(
      ".fp-gear-btn,.fp-del-btn,.fp-visibility-btn,.fp-dup-btn,.fp-type-icon,.fp-section-toggle,.fp-group-toggle,.lp-row-btn,.lp-swatch,.lp-caret"
    )).filter((el) => el.offsetParent !== null).flatMap((el) => {
      const r = el.getBoundingClientRect();
      const issues = [];
      if (r.width < 24 || r.height < 24) issues.push((el.className || el.id) + "=" + Math.round(r.width) + "x" + Math.round(r.height));
      if (!el.getAttribute("aria-label")) issues.push((el.className || el.id) + " missing aria-label");
      return issues;
    }));
    if (rowTargetIssues.length) throw new Error(rowTargetIssues.join(", "));
    await page.locator('.fp-tab-btn[data-fptab="features"]').click();

    await page.locator("#save-state-btn").focus();
    await page.keyboard.press("Tab");
    const focusVisible = await page.evaluate(() => document.activeElement && document.activeElement.matches(":focus-visible"));
    if (!focusVisible) throw new Error("toolbar keyboard focus is not visibly styled");
    record(theme + "_phase7-a11y-smoke", "ok");
  } catch (e) {
    record(theme + "_phase7-a11y-smoke", "fail", e.message);
  }

  // ---- Per-feature attribute popup ----
  try {
    await page.evaluate(() => {
      window.App.openAttrPopup("route", 0, window.App.routes[0]);
    });
    await shootLocator(page, "#fp-attr-popup", join(OUT_DIR, theme + "_attr-popup.png"), theme + "_attr-popup");
    await page.locator(".fp-attr-popup-collapse").click();
    await sleep(TAB_SETTLE_MS);
    await shootLocator(page, "#fp-attr-popup", join(OUT_DIR, theme + "_attr-popup-collapsed.png"), theme + "_attr-popup-collapsed");
    await page.locator(".fp-attr-popup-collapse").click();
    await page.evaluate(() => window.App.closeAttrPopup());
  } catch (e) {
    record(theme + "_attr-popup", "fail", e.message);
  }

  // ---- Module popups ----
  for (const id of MODULE_IDS) {
    const name = theme + "_" + id;
    try {
      await page.evaluate((moduleId) => window.App.openModulePopup(moduleId), id);
      await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
      await sleep(POPUP_SETTLE_MS);
      await assertDisplayBufferControl(page, theme, id);
      await assertAdaptivePanelLayout(page, theme, id);
      await shootLocator(page, ".module-popup-dialog", join(OUT_DIR, name + ".png"), name);

      // Every adaptive single-step panel must retain a keyboard-operable
      // Inputs section. Collapsing it cannot hide the Results column.
      if (COLLAPSIBLE_INPUT_MODULE_IDS.has(id)) {
        const inputsHeader = page.locator(".module-inputs-header:visible");
        await inputsHeader.click();
        await sleep(TAB_SETTLE_MS);
        const collapsedState = await page.locator(".module-popup-dialog").evaluate((el) => {
          const header = Array.from(el.querySelectorAll(".module-inputs-header"))
            .find((candidate) => candidate.offsetParent !== null);
          const activeSlot = header && header.closest(".module-body-slot");
          const body = header && header.parentElement.querySelector(":scope > .module-inputs-body");
          const results = activeSlot && activeSlot.querySelector(".rf-results-col");
          return {
            expanded: header && header.getAttribute("aria-expanded"),
            inputsHidden: body && getComputedStyle(body).display === "none",
            resultsVisible: results && getComputedStyle(results).display !== "none"
          };
        });
        if (collapsedState.expanded !== "false" || !collapsedState.inputsHidden || !collapsedState.resultsVisible) {
          throw new Error("collapsed Inputs state is not accessible or hid Results");
        }
        await shootLocator(
          page,
          ".module-popup-dialog",
          join(OUT_DIR, name + "_inputs-collapsed.png"),
          name + "_inputs-collapsed"
        );
        await inputsHeader.press("Enter");
        await sleep(TAB_SETTLE_MS);
        const expandedState = await inputsHeader.getAttribute("aria-expanded");
        if (expandedState !== "true") throw new Error("Inputs header did not expand by keyboard");
      }

      // Phase 6 behavior checkpoint: keep one representative full-page view
      // per theme so the live map, dock-right position, and collapsed title
      // bar are visible. Dialog-only captures above remain comparable to the
      // pre-refresh baseline set.
      if (id === "transit-coverage") {
        await shootPage(
          page,
          join(OUT_DIR, theme + "_phase6-live-map.png"),
          theme + "_phase6-live-map"
        );
        await page.locator(".module-popup-collapse").click();
        await sleep(TAB_SETTLE_MS);
        await shootPage(
          page,
          join(OUT_DIR, theme + "_phase6-collapsed.png"),
          theme + "_phase6-collapsed"
        );
        await page.locator(".module-popup-collapse").click();
        await sleep(TAB_SETTLE_MS);
      }

      // Tabbed popups: capture each [data-tab] button's panel too.
      // NOTE: every module's popup body slot stays in the DOM once loaded
      // (popup.js only toggles display:none on inactive slots), so this
      // selector must be scoped to :visible — otherwise it also matches
      // stale tab buttons from a previously-opened module's hidden slot.
      const tabButtons = page.locator(".module-popup-dialog button[data-tab]:visible");
      const tabCount = await tabButtons.count();
      for (let i = 0; i < tabCount; i++) {
        const btn = tabButtons.nth(i);
        const tabId = await btn.getAttribute("data-tab");
        try {
          await btn.click();
          await sleep(TAB_SETTLE_MS);
          await shootLocator(
            page,
            ".module-popup-dialog",
            join(OUT_DIR, name + "_tab-" + tabId + ".png"),
            name + "_tab-" + tabId
          );
        } catch (tabErr) {
          record(name + "_tab-" + tabId, "fail", tabErr.message);
        }
      }

      await page.evaluate(() => window.App.popup.close());
      await page.locator("#module-popup").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    } catch (e) {
      record(name, "fail", e.message);
      // Defensive: try to close whatever might be open before moving on.
      await page.evaluate(() => {
        try { window.App.popup.close(); } catch (_) { /* ignore */ }
      }).catch(() => {});
    }
  }

  // ---- Phase 7 responsive shell + representative collapsed Inputs ----
  try {
    await page.setViewportSize(NARROW_VIEWPORT);
    await sleep(TAB_SETTLE_MS);
    await shootPage(page, join(OUT_DIR, theme + "_phase7-narrow-shell.png"), theme + "_phase7-narrow-shell");
    await page.evaluate(() => window.App.openModulePopup("buffer-summary"));
    await page.locator("#module-popup").waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".module-inputs-header:visible").click();
    await sleep(TAB_SETTLE_MS);
    await shootPage(
      page,
      join(OUT_DIR, theme + "_phase7-narrow-inputs-collapsed.png"),
      theme + "_phase7-narrow-inputs-collapsed"
    );
    await page.evaluate(() => window.App.popup.close());
  } catch (e) {
    record(theme + "_phase7-narrow", "fail", e.message, NARROW_VIEWPORT);
  }

  await context.close();
}

// ---- Entry point ----

async function main() {
  if (!existsSync(FIXTURE_PATH)) {
    console.error("Missing fixture: " + FIXTURE_PATH);
    process.exit(1);
  }
  for (const [url, v] of VENDOR_MAP) {
    if (!existsSync(join(VENDOR_DIR, v.file))) {
      console.error("Missing vendored asset for " + url + " — expected " + join(VENDOR_DIR, v.file));
      process.exit(1);
    }
  }

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const port = await findFreePort();
  console.log("Starting static server on port " + port + " (cwd=" + REPO_ROOT + ")...");
  const pythonExecutable = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const server = spawn(pythonExecutable, ["-m", "http.server", String(port)], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "ignore"]
  });

  let browser;
  try {
    await waitForHttpReady(port, 10000);

    const executablePath = resolveExecutablePath();
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox"]
    });

    for (const theme of ["light", "dark"]) {
      console.log("\n=== " + theme + " ===");
      await captureTheme(browser, theme, port);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }

  console.log("\n=== Summary ===");
  const nameWidth = Math.max(...results.map((r) => r.name.length), 10);
  for (const r of results) {
    const dims = r.width ? r.width + "x" + r.height : "-";
    const label = r.status === "ok" ? "OK  " : r.status === "skip" ? "SKIP" : "FAIL";
    console.log(label + "  " + r.name.padEnd(nameWidth) + "  " + dims + (r.note ? "  " + r.note : ""));
  }
  const okCount = results.filter((r) => r.status === "ok").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  console.log(
    "\n" + okCount + "/" + results.length + " captures succeeded" +
    (skipCount ? " (" + skipCount + " expected skip" + (skipCount === 1 ? "" : "s") + ")" : "") +
    ". Output: " + OUT_DIR
  );

  if (anyFailure) {
    console.error("\nOne or more captures failed — see FAIL rows above.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
