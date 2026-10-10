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
//
// Shared plumbing (Playwright loading, Chromium resolution, vendored-CDN
// route interception, the static server, small polling utilities) lives in
// test/browser/harness.mjs — see docs/archive/browser-test-harness-plan.md for why.

import { readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  VENDOR_DIR,
  VENDOR_MAP,
  loadPlaywright,
  launchBrowser,
  routeVendoredAssets,
  startStaticServer,
  sleep
} from "../browser/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");
const FIXTURE_PATH = join(HERE, "fixture-session.json");
const VIEWPORT = { width: 1600, height: 950 };
const NARROW_VIEWPORT = { width: 1280, height: 800 };
const MAP_READY_TIMEOUT_MS = 30000;
const POPUP_SETTLE_MS = 600;
const TAB_SETTLE_MS = 300;

const { chromium } = loadPlaywright("test/ui-screens/capture.mjs");

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
  "attribute-summary"
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
// a deliberately wide file-upload surface, not a results view.
const ADAPTIVE_PANEL_WIDTHS = {
  "buffer-summary": { setup: 600, results: 600 },
  "transit-propensity": { setup: 520, results: 520 },
  "corridor-scoring": { setup: 600, results: 600 },
  "fta-small-starts": { setup: 520, results: 520, workspace: 1000 },
  "walkshed": { setup: 460, results: 460 },
  "transit-coverage": { setup: 600, results: 600 },
  "transit-travelshed": { setup: 600, results: 600 }
};

// Guard the invariants at load time, so a future width edit that would un-stack
// a panel (results > 620) or make it jump on run (setup !== results) fails here
// rather than silently shipping — that exact regression is what put the results
// table beside the inputs instead of below them.
const STACK_BREAKPOINT_PX = 620;
for (const [id, w] of Object.entries(ADAPTIVE_PANEL_WIDTHS)) {
  if (w.setup !== w.results) {
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
  await routeVendoredAssets(context, port);

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
      ".fp-gear-btn,.fp-del-btn,.fp-visibility-btn,.fp-dup-btn,.fp-type-icon,.fp-section-toggle,.fp-group-toggle,.lp-row-eye,.lp-group-eye,.lp-layer-eye,.lp-row-op,.lp-row-menu,.lp-swatch,.lp-caret"
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

  // ---- GTFS route browser (Layers tab, expanded) ----
  try {
    await page.evaluate(async () => {
      const pts = (id, x0, n) => Array.from({ length: n }, (_, i) => id + "," + (38.8 + i * 0.001) + "," + (-104.8 + x0 + i * 0.01) + "," + (i + 1)).join("\n");
      const t = (r, s, h, n) => Array.from({ length: n }, (_, i) => [r, "svc", r + "_" + s + "_" + i, h, s].join(",")).join("\n");
      const zip = new window.JSZip();
      zip.file("shapes.txt", "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" + [pts("177198", 0, 6), pts("177198_A", 0, 4), pts("177202", 0.001, 5), pts("B1", 0.05, 4)].join("\n") + "\n");
      zip.file("trips.txt", "route_id,service_id,trip_id,trip_headsign,shape_id\n" + [t("red", "177198", "Downtown", 3), t("red", "177198_A", "Downtown", 1), t("red", "177202", "Loop", 4), t("blue", "B1", "North", 2)].join("\n") + "\n");
      zip.file("routes.txt", "route_id,route_short_name,route_long_name,route_type,route_color\nred,Red,Red Circulator,3,FF0000\nblue,,Blue Line,3,0000FF\n");
      await window.App.loadGTFSFile(await zip.generateAsync({ type: "blob" }));
    });
    await page.waitForFunction("window.App.gtfsRouteIndex()", { timeout: 15000 });
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    await page.locator("#fp-tab-layers .lp-row", { hasText: "GTFS routes" }).first().locator(".lp-gtfs-browse-btn").click();
    await page.locator("#fp-tab-layers .lp-gtfs-route", { hasText: "Red" }).locator(".lp-caret").click();
    await page.locator("#fp-tab-layers .lp-gtfs-route", { hasText: "Blue" }).locator(".lp-gtfs-eye").click();
    await sleep(TAB_SETTLE_MS);
    await shootLocator(page, "#feature-panel", join(OUT_DIR, theme + "_gtfs-route-browser.png"), theme + "_gtfs-route-browser");
    await page.evaluate(() => window.App.clearGTFS());
    await page.locator('.fp-tab-btn[data-fptab="features"]').click();
  } catch (e) {
    record(theme + "_gtfs-route-browser", "fail", e.message);
  }

  // ---- GTFS stop selection (docs/archive/gtfs-stop-selection-plan.md Phase 5) ----
  // Small synthetic feed (6 stops, one shape), 3 selected + 1 id not in the
  // feed so the badge shows the "not in feed" suffix. Captures the box-select
  // bar on the GTFS stops target, the Export menu with the stop button, and
  // the Layers-tab GTFS stops row with its badge and open ⋯ menu.
  let savedView = null;
  try {
    savedView = await page.evaluate(() => ({ c: window.App.map.getCenter().toArray(), z: window.App.map.getZoom(), b: window.App.map.getBearing(), p: window.App.map.getPitch() }));
    await page.evaluate(async () => {
      const stops = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id, i) =>
        [id, "C" + id, "Stop " + id, 38.81 - (i % 2) * 0.004, -104.806 + Math.floor(i / 2) * 0.004, 0, ""].join(",")).join("\n");
      const zip = new window.JSZip();
      zip.file("stops.txt", "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n" + stops + "\n");
      zip.file("shapes.txt", "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS1,38.80,-104.81,1\nS1,38.80,-104.79,2\n");
      zip.file("trips.txt", "route_id,service_id,trip_id,trip_headsign,shape_id\nr1,svc,t1,Down,S1\n");
      zip.file("routes.txt", "route_id,route_short_name,route_long_name,route_type\nr1,One,One Line,3\n");
      await window.App.loadGTFSFile(new File([await zip.generateAsync({ type: "blob" })], "build.zip", { type: "application/zip" }));
    });
    await page.waitForFunction("window.App.gtfsStops.isAvailable().ok && window.App.map.getLayer('gtfs-stops-selected')", { timeout: 15000 });
    await page.evaluate(() => {
      window.App.map.jumpTo({ center: [-104.8, 38.808], zoom: 15 });
      window.App.gtfsStops.set(["s1", "s2", "s4", "zz-not-in-feed"]);
      window.App.setSelection([]);
    });

    // 1. Box-select bar, GTFS stops target.
    await page.click('.tool-btn[data-mode="box-select"]');
    await page.selectOption(".box-select-bar-target", "gtfs-stops");
    await sleep(TAB_SETTLE_MS);
    await page.mouse.move(5, 5); // keep hover state out of the shot
    await shootLocator(page, ".box-select-bar", join(OUT_DIR, theme + "_box-select-bar-stops.png"), theme + "_box-select-bar-stops");
    await page.click('.tool-btn[data-mode="box-select"]');

    // 2. Export menu with the stop button visible.
    await page.click("#export-btn");
    await page.locator("#export-gtfs-stops").waitFor({ state: "visible", timeout: 5000 });
    await sleep(TAB_SETTLE_MS);
    await shootLocator(page, "#export-dropdown", join(OUT_DIR, theme + "_export-menu-gtfs-stops.png"), theme + "_export-menu-gtfs-stops");
    await page.click("#export-btn");

    // 3. Layers tab: GTFS stops row (badge) and its open ⋯ menu.
    await page.locator('.fp-tab-btn[data-fptab="layers"]').click();
    const stopsRow = page.locator("#fp-tab-layers .lp-row", { hasText: "GTFS stops" }).first();
    await stopsRow.waitFor({ state: "visible", timeout: 5000 });
    // Row alone (menu closed, not hovered: the badge hides on hover) so the badge is readable.
    await page.mouse.move(5, 5);
    await sleep(TAB_SETTLE_MS);
    await shootLocator(page, '#fp-tab-layers .lp-row:has-text("GTFS stops")', join(OUT_DIR, theme + "_layers-gtfs-stops-badge.png"), theme + "_layers-gtfs-stops-badge");
    await stopsRow.hover();
    await stopsRow.locator(".lp-row-menu").click();
    await page.locator("#fp-context-menu").waitFor({ state: "visible", timeout: 5000 });
    await sleep(TAB_SETTLE_MS);
    const clip = await page.evaluate(() => {
      const a = document.querySelector("#feature-panel").getBoundingClientRect();
      const m = document.querySelector("#fp-context-menu").getBoundingClientRect();
      const x = Math.max(0, Math.min(a.left, m.left)), y = Math.max(0, Math.min(a.top, m.top));
      const r = Math.min(window.innerWidth, Math.max(a.right, m.right)), b = Math.min(window.innerHeight, Math.max(a.bottom, m.bottom));
      return { x, y, width: r - x, height: b - y };
    });
    await page.screenshot({ path: join(OUT_DIR, theme + "_layers-gtfs-stops-menu.png"), clip });
    record(theme + "_layers-gtfs-stops-menu", "ok", null, { width: Math.round(clip.width), height: Math.round(clip.height) });
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await page.locator('.fp-tab-btn[data-fptab="features"]').click();
    await page.evaluate(() => window.App.clearGTFS());
  } catch (e) {
    record(theme + "_gtfs-stop-selection", "fail", e.message);
  }
  // Put the map back exactly where it was so later full-page shots are unaffected.
  if (savedView) {
    await page.evaluate((v) => window.App.map.jumpTo({ center: v.c, zoom: v.z, bearing: v.b, pitch: v.p }), savedView);
    await sleep(TAB_SETTLE_MS);
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

  // ---- Shared Appearance popover (docs/archive/feature-appearance-plan.md Phase 1) ----
  try {
    await page.evaluate(() => {
      const icon = document.querySelector("#fp-tab-features .fp-item .fp-type-icon") || document.body;
      window.App.openAppearancePopup(icon, "route", 0, {});
    });
    await page.locator("#fp-appearance-popover").waitFor({ state: "visible", timeout: 5000 });
    await sleep(TAB_SETTLE_MS);
    await shootLocator(page, "#fp-appearance-popover", join(OUT_DIR, theme + "_appearance-popover.png"), theme + "_appearance-popover");
    await page.evaluate(() => window.App.closeAppearancePopup());
  } catch (e) {
    record(theme + "_appearance-popover", "fail", e.message);
  }

  // ---- Line style control + dashed/dotted lines (Phase 3) ----
  try {
    await page.evaluate(() => {
      const A = window.App;
      if (A.lines[0]) A.lines[0].properties._lineStyle = "dashed";
      if (A.routes[0]) A.routes[0].properties._lineStyle = "dotted";
      A.renderLineLayers(); A.renderRouteLayers();
      const icon = document.querySelector("#fp-tab-features .fp-item .fp-type-icon") || document.body;
      A.openAppearancePopup(icon, A.routes[0] ? "route" : "line", 0, {});
    });
    await page.locator("#fp-appearance-popover").waitFor({ state: "visible", timeout: 5000 });
    await sleep(TAB_SETTLE_MS);
    await shootLocator(page, "#fp-appearance-popover", join(OUT_DIR, theme + "_appearance-line-style.png"), theme + "_appearance-line-style");
    await page.evaluate(() => window.App.closeAppearancePopup());
    await shootPage(page, join(OUT_DIR, theme + "_line-styles-map.png"), theme + "_line-styles-map");
    await page.evaluate(() => {
      const A = window.App;
      if (A.lines[0]) delete A.lines[0].properties._lineStyle;
      if (A.routes[0]) delete A.routes[0].properties._lineStyle;
      A.renderLineLayers(); A.renderRouteLayers();
    });
  } catch (e) {
    record(theme + "_appearance-line-style", "fail", e.message);
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

  console.log("Starting static server...");
  const { port, stop: stopServer } = await startStaticServer();
  console.log("Static server ready on port " + port);

  let browser;
  try {
    browser = await launchBrowser(chromium);

    for (const theme of ["light", "dark"]) {
      console.log("\n=== " + theme + " ===");
      await captureTheme(browser, theme, port);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer();
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
