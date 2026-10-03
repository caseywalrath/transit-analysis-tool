# Phase 0 — Screenshot harness + baseline capture

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/core-app.md. This file is historical.

**Goal:** a repeatable script that screenshots the app shell and every module popup in
light and dark mode, so every later phase can verify its work mechanically.
**No product code changes in this phase.**

## Deliverables

1. `test/ui-screens/capture.mjs` — the capture script.
2. `test/ui-screens/baseline/` — committed baseline PNGs of the **current (pre-refresh)** UI.
3. `test/ui-screens/out/` — gitignored output dir for later runs (add to `.gitignore`).
4. A short `test/ui-screens/README.md` (usage + how to add a popup to the list).

## How the script works

The app is pure static files but uses `fetch()` for popup HTML fragments, so it must be
served over HTTP, not `file://`:

1. Start a static server on a free port: `python3 -m http.server <port>` from repo root
   (spawn as a child process from the script; kill it in a `finally`).
2. Drive Chromium with Playwright. In the cloud environment, Chromium is preinstalled —
   launch with `executablePath: "/opt/pw-browsers/chromium"` if the default resolution
   fails. If the `playwright` npm package is not importable, install it once *outside the
   repo* (`npm i playwright` in a scratch dir, set `NODE_PATH`) — do **not** add a
   `package.json` to the repo; the project stays npm-free.
3. Viewport 1600×950. For each theme (`light`, `dark`):
   - Set theme before load: `localStorage.setItem("mat-dark-mode", theme === "dark" ? "1" : "0")`
     via an init script, then `goto http://localhost:<port>/index.html`.
   - Wait for the map to be ready: poll for `window.App && App.map && App.map.loaded()`
     (timeout 30s; the basemap tiles are remote — if tiles fail in a sandboxed network,
     proceed anyway once `App.map` exists; chrome around the map is what we're checking).
   - **Seed demo features** so panels/popups aren't empty. Cheapest reliable way, via
     `page.evaluate`: call `App.addPoint(lon, lat)` twice and `App.handlePolygonClick` /
     line equivalents are fiddly — instead seed by loading a canned session:
     `localStorage.setItem("mat-session", <fixture JSON>)` *before* `goto`, using a
     fixture file `test/ui-screens/fixture-session.json`. Build the fixture once by hand:
     open the app locally, draw 2 points, 1 line, 2 routes (give them serviceIds/bands via
     the attribute popup), 1 polygon, then export session JSON and trim. If building the
     fixture interactively isn't possible in this environment, construct minimal JSON by
     reading `js/core/cache.js` for the schema (version 2; routes need `geometry` +
     `properties.waypoints`). The fixture makes checklists, the feature panel, and the
     Trip Builder/Route Costing service lists render with real rows.
   - Capture, in order:
     - `<theme>_shell.png` — full page (toolbar + sidebar + map + feature panel).
     - `<theme>_sidebar.png` — clip to `#sidebar-wrap`.
     - `<theme>_feature-panel.png` — clip to `#feature-panel`.
     - `<theme>_attr-popup.png` — run `App.openAttrPopup("route", 0, App.routes[0])` in
       page context first, then clip `#fp-attr-popup`; close after.
     - One per module popup: run `App.openModulePopup("<id>")`, wait ~600ms for the
       fragment fetch + init, screenshot clipped to `.module-popup-dialog`, then
       `App.popup.close()`. Module ids:
       `buffer-summary`, `transit-propensity`, `fta-small-starts`,
       `ridership-forecasting`, `corridor-scoring`, `walkshed`, `transit-travelshed`,
       `transit-coverage`, `route-costing`, `trip-builder`, `title-vi`, `gtfs`,
       `attribute-summary`, `display-settings`.
       File name: `<theme>_<id>.png`.
   - Tabbed popups (ridership-forecasting, fta-small-starts, title-vi): additionally
     click each `[data-tab]` button and capture `<theme>_<id>_tab-<tabid>.png`.
4. Print a summary table (name → px dimensions) and exit non-zero if any capture failed.

Keep the script defensive: a popup that throws during open should log and continue, not
abort the run (some modules warn without map data — that's fine, we're checking chrome).

## Baseline

Run the script on the current codebase; copy `out/` → `baseline/`; commit. PNGs at this
viewport are ~100–300KB each; ~35–40 images is an acceptable one-time cost for the
regression value. Do not recommit baselines in later phases (they are the *pre-refresh*
reference until the final phase refreshes them).

## Verification

- Script runs clean twice in a row (deterministic output names, no leftover server).
- Every module id above produced a non-blank image in both themes.

Commit: `UI refresh phase 0: screenshot harness + pre-refresh baselines`
