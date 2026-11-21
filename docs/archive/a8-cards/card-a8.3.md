# Card A8.3 — "Drawn Services as GTFS" export dialog [Sonnet]

## 1. Goal
Let the user pick drawn Services, enter agency details and dates, and download a GTFS ZIP made by `GtfsExport.build`.

## 2. Read first
- `CLAUDE.md`, `AGENTS.md`, `docs/A8-plan.md`, `docs/a8-cards/card-a8.1.md` (the engine contract and its error texts).
- `js/core/gtfs-export.js` (whole file).
- `js/core/analysis-network-source.js`: search `App.gtfsExportInput` (gives the engine input) and `collectProposals`.
- `js/core/service-assembly.js`: search `App.buildTransitServices` and `App.hasBlockingWarnings`.
- `js/app.js`: search `// Export dropdown item click` and `document.getElementById("export-btn")`.
- `index.html`: search `id="export-gtfs-stops"` and `id="gp-dialog"`.
- `css/style.css`: search `.gp-dialog {` (the dialog look you reuse) and `.gp-dialog .btn-row`.
- `js/core/gpkg-layers.js`: search `_el("gp-dialog")` (how that dialog opens, closes and handles Escape).
- `test/browser/gtfs-copy-service.test.mjs` (how a test loads the mini feed and copies route B1 into a Service:
  `App.gtfsCopy({ routeId: "B1", mode: "service" })`) and `test/browser/harness.mjs`.

## 3. Files you may change
- `js/core/gtfs-export-ui.js` (new)
- `index.html` (menu button, dialog markup, one script tag)
- `js/app.js` (one branch in the export click handler)
- `css/style.css` (new `.gex-` rules only, placed immediately after the `.gp-dialog .btn-row` rule block)
- `test/browser/gtfs-export.test.mjs` (new)

## 4. Contract
ES5 in `js/`. IIFE with `var App = window.App`; module state private.

**Public:**
- `App.openGtfsExportDialog()` — fills and shows the dialog.
- `App.gtfsExportBlob(serviceKeys, opts)` → `Promise<{ blob, result, skipped }>`. `opts = { agency, startDate,
  endDate, frequencies }` (dates `YYYYMMDD`). Calls `App.gtfsExportInput(serviceKeys, { includeHidden: true, agency,
  startDate, endDate, frequencies, feedVersion: <today YYYYMMDD> })`, then `GtfsExport.build(input)` (let its errors
  reject the promise), zips `result.files` with `new JSZip()` (`zip.file(name, text)`, then
  `generateAsync({ type: "blob", compression: "DEFLATE" })`).

**Markup** (`index.html`, immediately after the closing `</div>` of `#gp-dialog`):
```
<div id="gex-dialog" class="gp-dialog gex-dialog" role="dialog" aria-modal="true" aria-labelledby="gex-title" hidden>
  <h2 id="gex-title" class="gp-title">Export drawn Services as GTFS</h2>
  <div id="gex-services" class="gex-services"></div>
  <div class="gex-grid">
    <label class="form-field">Agency name <input id="gex-agency-name" type="text"></label>
    <label class="form-field">Agency website <input id="gex-agency-url" type="url" placeholder="https://"></label>
    <label class="form-field">Time zone <input id="gex-agency-tz" type="text"></label>
    <label class="form-field">Language <input id="gex-agency-lang" type="text" value="en"></label>
    <label class="form-field">Service starts <input id="gex-start" type="date"></label>
    <label class="form-field">Service ends <input id="gex-end" type="date"></label>
  </div>
  <label class="gex-check"><input id="gex-frequencies" type="checkbox" checked> Include headway windows (frequencies.txt)</label>
  <div id="gex-status" class="gex-status" aria-live="polite"></div>
  <div class="btn-row">
    <button id="gex-cancel" class="rf-btn-sm">Close</button>
    <button id="gex-export" class="rf-action-primary">Export ZIP</button>
  </div>
</div>
```
Menu: immediately after the `id="export-gtfs-stops"` button: `<button data-format="gtfs-export">Drawn Services as GTFS (ZIP)</button>`.
Script tag: immediately after `<script src="js/core/analysis-network-source.js"></script>`.
`js/app.js`: in the export click handler, immediately after the `if (fmt === "gtfs-stops") {…}` block:
`if (fmt === "gtfs-export") { if (typeof App.openGtfsExportDialog === "function") App.openGtfsExportDialog(); return; }`

**Opening fills:**
- `#gex-services`: one row per `App.buildTransitServices()` entry, `<label class="gex-svc"><input type="checkbox"
  value="<key>" checked> <name></label>`. A Service where `App.hasBlockingWarnings(svc)` is true gets a disabled,
  unchecked box and the text ` — needs setup` after its name. No Services → the div reads
  `Draw a Line or Route and assign it a Service with headway bands first.` and `#gex-export` is disabled.
- Agency fields: from `localStorage["mat.gtfsExport.agency"]` (JSON `{name, url, timezone, lang}`), read in
  try/catch; else name `""`, url `""`, timezone `Intl.DateTimeFormat().resolvedOptions().timeZone` or
  `"America/Denver"`, lang `"en"`.
- Dates: start = today, end = today + 1 year − 1 day (local dates). Status cleared.

**Export click:** disable the button, status `Building…`; collect checked keys and fields; save the agency fields to
localStorage (try/catch). Dates: `"2027-01-05"` → `"20270105"`; a blank date passes `""` (the engine reports it).
Call `App.gtfsExportBlob`. On success: download via a temporary `<a download="drawn-services-gtfs-<startDate>.zip">`
with `URL.createObjectURL` (revoke after click); status: `Exported <routes> routes, <trips> trips in the file
(<tripsRepresented> departures), <stops> stops.` followed by each warning and each skipped Service
(`<name>: <reason>`) on its own line (`<div>` per line, text set with `textContent`). On error: status is the error
message, styled with `.gex-status.is-error`. Re-enable the button in both cases.
**Close:** `#gex-cancel` or Escape hides the dialog. Escape listener on `document` in the capture phase, only while
the dialog is open; call `e.stopPropagation()` so other Escape handlers do not also fire.

**CSS (`.gex-`):** `.gex-services` max-height 180px, overflow auto, border 1px solid var(--border), padding
var(--space-2), margin-bottom var(--space-3); `.gex-svc` display block; `.gex-grid` display grid,
grid-template-columns 1fr 1fr, gap var(--space-2) var(--space-3); `.gex-check` display block, margin
var(--space-3) 0; `.gex-status` min-height 1.2em, font-size var(--text-sm); `.gex-status.is-error` color var(--danger). No raw hex.

## 5. Edge cases
1. No Services → message, Export disabled.
2. Every checked Service skipped or without trips → the engine's error text shows; nothing downloads.
3. Bad URL / time zone / dates → the engine's exact error text shows.
4. Opening twice → the list is rebuilt, not appended.
5. localStorage throws → defaults, no console error.

## 6. Steps
1. Markup, menu button, script tag, app.js branch, CSS.
2. `js/core/gtfs-export-ui.js`.
3. `test/browser/gtfs-export.test.mjs` with the checks below. Load the mini feed and copy B1 into a Service the way
   `gtfs-copy-service.test.mjs` does. Read the downloaded ZIP with Playwright's `page.waitForEvent("download")`, then
   load it back in the page with `App.gtfsReadOtherFeed(new File([bytes], "x.zip"))`. Set `GEX_SHOTS_DIR` to save
   light and dark screenshots of the open dialog with a result showing (wait 500 ms after switching theme).

## 7. Done when
`NODE_PATH=/opt/node-tools/node_modules node test/browser/gtfs-export.test.mjs` ends `PASS — 9/9 checks passed`:
1. The Export menu has "Drawn Services as GTFS (ZIP)"; clicking it shows `#gex-dialog`.
2. Before any Service: the no-Services message shows and `#gex-export` is disabled.
3. After copying B1: one checked row per Service from `App.buildTransitServices()`.
4. With agency URL `example.org`: status is exactly `Agency URL must start with http:// or https://.` and there is no
   download.
5. With valid fields (name `Test Transit`, url `https://example.org`, tz `America/Denver`, dates covering
   2026-01-12): a download named `drawn-services-gtfs-<start>.zip` arrives and the status starts `Exported 1 routes`.
6. The ZIP has agency, stops, routes, trips, stop_times, calendar, shapes, feed_info (and frequencies when B1's bands
   are eligible).
7. Loaded back, the feed's trips on 20260112 (`GtfsSchedule.tripsOnDate(feed, "20260112").trips.length`) equal the
   drawn trips on that date (`App.buildAnalysisNetwork({ gtfs: false, date: "20260112" }).counts.proposalTrips`).
8. With "Include headway windows" off: no frequencies.txt, and the check 7 count is the same.
9. Escape closes the dialog.
Also: `node test/run-golden.mjs` still ends `PASS`; `NODE_PATH=/opt/node-tools/node_modules node
test/browser/gtfs-copy-service.test.mjs` still passes.

## 8. Stop and report if
- `App.gtfsExportInput` or `GtfsExport.build` behave differently from the cards.
- Check 7 disagrees (report both numbers; do not adjust the check).
- You need to change a file not in section 3.
