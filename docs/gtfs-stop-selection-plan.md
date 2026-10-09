# GTFS stop selection and export — plan

Status: **proposed**. Nothing is implemented yet.

## What the user asked for

Build a stop list from a GTFS feed on the map, then export it. A script outside
the app uses the list to find every trip, route and block that serves those
stops, and adds up the service. The first use is the Federal Boulevard BRT cost
comparison: one list of corridor stops, applied to a Build feed and a No-Build
feed. The feature should be durable and reusable, not a one-off.

The agreed shape:

1. **Box select chooses what it selects:** drawn features (today) or GTFS stops.
2. **Export writes the selection:** a "Selected" choice next to All and Visible
   only for drawn features, plus a separate export for selected GTFS stops.
3. **Rules stay outside the app.** The app does no rule-based picking. A small
   import ("Select stops from list…") lets a list made by a script come back
   onto the map for review.
4. **The selection survives switching feeds**, so one list can be checked
   against both scenarios.

## Decisions (recommended defaults, change before Phase 1 if wanted)

| # | Question | Decision |
|---|---|---|
| D1 | What can box select target? | **Features** (today's behavior, unchanged) or **GTFS stops**. No "Both": every group action (Delete, Merge, Hide, right-click menu, export) would have to decide what to do with stops, which cannot be deleted or merged. Targets plug in through a small registry, so another layer (for example census block groups) can be added later without touching the drag code. |
| D2 | One selection or two? | **Two, independent.** Switching the target never clears either selection. The feature selection keeps its highlight while stops are being selected. |
| D3 | Where does the target choice live? | A small **on-map bar** at the top centre of the map, shown only while the box-select tool is on: `Select: [Features ▾] · 163 stops selected · Clear`. The stop selection has no panel of its own, so the bar is also where its count and Clear live. (Alternative: a caret menu on the toolbar button. It is more compact but has nowhere to show the count.) |
| D4 | Is the target remembered? | **No.** Every page load starts on Features, so a returning user is never surprised by the tool selecting something else. |
| D5 | Shift+drag with the tool off | Uses the **current target**. Same modifier keys as today: plain = replace, Shift = add, Ctrl/Cmd = remove. A click selects the topmost stop under the cursor; a plain click on empty map clears the stop selection. Alt (fully inside) has no effect on stops, since a stop is a point. |
| D6 | Hidden stops layer | The GTFS stops target is **unavailable** (greyed out in the bar, with the reason as a tooltip) when no feed is loaded or the stops layer is hidden. If the layer is hidden while the target is GTFS stops, drags select nothing and the bar says why. |
| D7 | What is a stop selection? | **A list of `stop_id` strings, kept separately from the loaded feed.** It survives loading a different feed and a page reload (it rides the normal autosave). IDs that are not in the current feed are kept but not drawn, and the app reports them as "not in this feed". |
| D8 | What clears it? | The bar's **Clear**, the Layers-panel menu's **Clear stop selection**, **Remove layer** / Clear GTFS feed, the toolbar **Clear**, and **Reset Session**. Loading another ZIP does **not** clear it: that is the feed-switch workflow. |
| D9 | "Selected" export scope | A third radio, **Selected**, next to All and Visible only. It means **selected drawn features** and works for JSON (Features only), JSON (All data), CSV, KML and Shapefile. Share Link ignores the scope, as it does today. Labels and text boxes are never part of the feature selection, so Selected leaves them out. |
| D10 | GTFS stops export | A separate Export-menu button, **Selected GTFS stops (CSV)**, shown only when a feed is loaded and stops are selected (the "Local Map Data" button already works this way). The same action is also in the Layers-panel menu. |
| D11 | Stop CSV columns | `stop_id, stop_code, stop_name, stop_lat, stop_lon, location_type, parent_station, in_feed, feed_file`. **Every selected ID is written**, including ones missing from the loaded feed (`in_feed` = 0, other stop fields blank), so a list exported from either scenario is complete. Rows follow `stops.txt` order, then missing IDs in selection order. The file name includes the feed's ZIP name, because RTD's two feeds carry the same `feed_version`. |
| D12 | Import | **Select stops from list…** (Layers-panel menu) reads a CSV with a `stop_id` column (any case) or a plain one-ID-per-line text file. It **replaces** the selection and reports how many IDs matched the loaded feed. |
| D13 | Single-stop edits without the tool | Right-clicking a GTFS stop adds **Add to stop selection** / **Remove from stop selection** next to the existing **Copy As Point**. |
| D14 | Undo | The stop selection is not part of undo, just as the feature selection isn't. |
| D15 | Highlight | Selected stops are drawn as filled dots in the feature-selection blue (`#2b6cb0`, `js/core/selection.js:134`) with a white outline, on a layer just above the stops layer and below drawn features. They follow the stops layer's visibility and opacity. Map data symbols are exempt from the design-token rule. |

## How it fits the existing code

- **Box select** (`js/core/box-select.js`) is already generic where it matters.
  Its hit tests work on screen pixels and don't care what the shapes are. Four
  places assume drawn features:
  - `buildCache` (lines 152–185) projects only `App.points/lines/routes/polygons`;
  - `combine` (lines 201–211) reads `App.getSelectedFeatures()`;
  - `apply` (lines 316–323) writes through `App.setSelection` and says "features";
  - the badge text in `drawFeedback` (lines 221–237).

  Mouse events are taken in the capture phase, and `inMap` (lines 139–142) only
  starts a drag inside the map's canvas container. The new bar must therefore sit
  in the map container, outside the canvas container, so clicks on it never start
  a drag.
- **Load order.** `box-select.js` loads early (core) and `gtfs.js` loads late (a
  module). So box select defines a registry at load time, and `gtfs.js` registers
  the stops target when it loads. This is the same pattern as
  `App.registerFeatureUsage` and `App.registerLayerRepainter`.
- **GTFS stops** (`js/projects/gtfs.js`):
  - Stops are drawn on `gtfs-stops-layer`, built from
    `buildStopsGeoJSON` (lines 999–1016, `location_type` 0 or blank only). The
    stops FeatureCollection is not kept after it is handed to MapLibre (unlike
    `_shapesFC`, line 17), so the module needs to keep a reference.
  - `loadGTFSFile` (lines 292–346) does not remember the ZIP's file name.
  - Loading a feed calls `addMapLayers` (lines 491–567). It resets the
    route-browser state but never calls `clearGTFS` (lines 385–402). That
    difference is what lets D8 keep the stop selection on a feed switch while
    clearing it on an explicit removal.
  - Session state already has a home, the `gtfs-browse` cache entry
    (lines 1392–1400). It currently returns `{}` when there is no route index; the
    stop selection must be collected whether or not a feed is loaded.
  - The stop right-click menu is built at lines 781–788.
- **Export:**
  - The scope radios are at `index.html:132-135`, and the chosen scope is
    passed through `js/app.js:1597-1601`.
  - Every feature format filters through one function, `getExportArrays`
    (`js/core/cache.js:1144-1157`), so adding "selected" there covers CSV, KML,
    SHP and JSON (Features only) at once. JSON (All data) has its own Visible
    branch (`js/core/cache.js:735-746`) that must learn the same scope, and
    `_scopeSuffix` (lines 1134–1136) needs a `-selected` suffix.
  - The conditional "Local Map Data" button (`index.html:143`) is the
    precedent for a button that appears only when there is something to export.
- **Layers panel** (`js/core/layers-panel.js`):
  - The GTFS stops manifest entry is at lines 62–63.
  - Row menus come from `layerMenuOptions` (lines 915–930), which today offers
    only Zoom, Open module and Remove. An optional per-entry `menuItems()` hook
    and an optional `badge()` hook (a short muted text after the row name) keep
    the GTFS-specific actions out of the generic panel code.
- **Delete key** (`js/app.js:819-844`): the selection delete is allowed while
  `App.drawMode === "box-select"` (line 833). With the GTFS stops target active,
  Delete must do nothing, so it can never delete drawn features the user wasn't
  looking at.
- **Tests:**
  - Box-select geometry is golden-tested (`test/cases/box-select.mjs`).
  - The GTFS pure helpers are golden-tested by loading `js/projects/gtfs.js` in
    the sandbox (`test/cases/gtfs-browse.mjs`).
  - Browser smoke tests already exist for box select (`test/box-select-smoke.mjs`)
    and the GTFS browser (`test/gtfs-browser-smoke.mjs`, which zips a synthetic
    feed in the page).

## Phases

Each phase ends with its tests passing, an Opus review of the diff, and one
commit on the session branch. "Owner" says who does the work when Opus
orchestrates.

### Phase 1 — pure helpers (Owner: **Sonnet**)

Small, exact, golden-testable. No DOM, map or turf.

1. In `js/core/box-select.js`, next to `App.boxSelectGeom`, add
   `combineKeys(currentKeys, hitKeys, op)` (op `"replace" | "add" | "remove"`).
   It works on string keys, keeps order, de-duplicates, and does not change its
   inputs. The features path keeps its own `combine` for now (see Phase 3).
2. In `js/projects/gtfs.js`, a new pure namespace `App.gtfsStopList`:
   - `parseStopIdList(text)` → `{ ids, headerFound, blanks, duplicates }`.
     - It accepts a CSV with a `stop_id` column (any case, BOM stripped, quoted
       fields allowed) or a headerless one-ID-per-line file.
     - IDs are trimmed and de-duplicated, keeping first-seen order.
     - Reuse `App.parseCSV` (`js/core/utils.js`) if it handles quoted fields;
       otherwise write a small RFC 4180 reader here.
   - `reconcile(ids, feedStopIds)` → `{ present, missing }`, both in `ids`
     order.
   - `stopListCSV(ids, stopsRows, feedFile)` → CSV text with the D11 columns
     and order, RFC 4180 quoting (stop names contain commas, `&` and quotes).
3. Golden cases: extend `test/cases/box-select.mjs` (`combineKeys`, all three
   ops and duplicates) and `test/cases/gtfs-browse.mjs` (header vs no header,
   BOM, quoted IDs, a `Stop_ID` header, blanks and duplicates, missing IDs, CSV
   quoting of a name with a comma and a quote). Seed with `--update`.

**Done when:** `node test/run-golden.mjs` passes. The new cases are reviewed by
reading their recorded outputs, not just counted.

### Phase 2 — stop selection state in gtfs.js (Owner: **Sonnet**, **Opus** reviews the lifecycle)

The selection's lifecycle touches load, restore, clear and autosave. The
"IDs kept separately from the feed" rule (D7) keeps it simple: the list is the
only state, and everything else (highlight, counts, export) is worked out from
it plus whatever feed is loaded.

1. State: `_selectedStops` (an ordered list of `stop_id` strings plus a lookup
   object), `_stopsFC` (keep the FeatureCollection from `addMapLayers`), and
   `_feedFileName` (set from `file.name` in `loadGTFSFile`).
2. Highlight layer `gtfs-stops-selected`:
   - Same source as the stops (`gtfs-stops`), added right after
     `gtfs-stops-layer` in `addMapLayers`, filtered to the selected IDs
     (`["in", ["get","stop_id"], ["literal", ids]]`).
   - Its visibility follows `setStopLayerVisibility` (lines 599–606), and
     `removeMapLayers` removes it.
   - The filter is rebuilt on every change. An empty list matches nothing, using
     the same "never matches" trick as the route highlight at line 527.
3. Public API, `App.gtfsStops`:
   - `ids()`, `count()` → `{ total, inFeed }`, `has(id)`;
   - `set(ids)`, `add(ids)`, `remove(ids)`, `clear()`;
   - `zoomTo()`, `exportCSV()`, `importFromFile(file)`;
   - `feedFileName()`, `isAvailable()` (feed loaded and stops layer visible).

   Every change goes through one private `changed()` function. It updates the
   highlight filter, saves the cache, refreshes the Layers panel, and tells box
   select to refresh its bar (`App.boxSelect.refreshBar`, added in Phase 3,
   called only if it exists).
4. Lifecycle (per D7/D8):
   - Loading another ZIP keeps the list and re-applies the highlight to the new
     feed.
   - `clearGTFS` empties the list.
   - The `gtfs-browse` cache entry collects `{ routes, shapes, stops,
     feedFile }`, always including `stops`, and `apply` restores `stops` and
     `feedFile` right away, since they don't depend on the feed being present.
   - Hidden routes and shapes keep their current pending-restore behavior.
5. Stops right-click (D13, lines 781–788): add **Add to stop selection** /
   **Remove from stop selection** for each stop under the cursor, next to the
   existing **Copy As Point**.
6. `exportCSV` builds the file with `App.gtfsStopList.stopListCSV` and downloads
   it as `gtfs-stops-selected-<zip name without .zip>-<YYYY-MM-DD>.csv`. It uses
   the same download helper and date stamp the feature exports use; if that
   helper is private to `cache.js`, expose it rather than copying it.
7. `importFromFile` reads the file, calls `parseStopIdList`, replaces the
   selection, and sets a status line, for example "Selected 163 stops · 4 not
   in this feed · 2 duplicates ignored".

**Opus review checklist:**
- a full-session file restore with a feed and a selection;
- a page reload with no feed, then the ZIP loaded again (the selection reappears);
- load feed A, select, then load feed B (the selection is kept and missing IDs
  are counted);
- Remove layer clears the selection; Reset Session clears it;
- no listeners or layers left behind after repeated load/clear cycles (see the
  `_layerListeners` note at lines 686–690).

### Phase 3 — box-select targets and the on-map bar (Owner: **Opus**)

This is the delicate part. It changes the capture-phase drag code that every
box-select user relies on, and it adds new on-map UI.

1. Registry in `box-select.js`: `App.boxSelect.registerTarget(spec)`, where
   `spec = { id, label, noun: ["stop","stops"], isAvailable() → { ok, reason },
   candidates() → [{ key, coord: [lng, lat] }], getKeys(), setKeys(keys) }`.
   - The built-in `"features"` target wraps today's code exactly: the existing
     `buildCache`/`hitTest`/`combine`/`App.setSelection` path. Its behavior must
     not change at all (`test/box-select-smoke.mjs` passes untouched).
   - Point-only targets project `candidates()` to pixels once per drag, using
     only those inside the current map bounds (a quick lng/lat check before
     `map.project`, so a 10,000-stop feed stays instant). They hit-test with
     `pointInRect`, and combine with `combineKeys` from Phase 1.
   - Only after the smoke test passes unchanged may the features path also move
     to `combineKeys`, as an optional clean-up.
2. `gtfs.js` registers `{ id: "gtfs-stops", label: "GTFS stops", … }` at load
   time, through `App.gtfsStops`.
3. The on-map bar `.box-select-bar`:
   - It goes in `App.map.getContainer()` (not the canvas container; see "How it
     fits" above), top centre, and is shown only while the tool is on.
   - Contents: a `<select>` of registered targets (unavailable ones disabled,
     with the reason as a tooltip), a live count for the current target, and a
     Clear button.
   - Keyboard-reachable, with design tokens only and working in dark mode. It is
     hidden in Present mode (`body.present-mode`).
   - `App.boxSelect.refreshBar()` re-reads the counts and availability. Phase 2's
     `changed()` calls it, and so does the Layers-panel eye toggle for the GTFS
     stops layer.
4. Behavior changes, all target-aware:
   - the badge text ("12 stops");
   - the status line ("Selected 163 GTFS stops");
   - click selection takes the topmost stop within the 3 px pad;
   - Shift+drag with the tool off uses the current target (D5);
   - the target resets to Features on page load (D4);
   - if the current target becomes unavailable while the tool is on, the bar
     says so and drags select nothing.
5. Delete key (`js/app.js:833`): return early when box select is active and the
   current target isn't `"features"`.
6. CSS in `css/style.css`, next to the existing `.box-select-*` rules.

**Done when:**
- `test/box-select-smoke.mjs` passes **unchanged**;
- the Phase 5 smoke checks for stop targeting pass;
- the bar looks right in light and dark mode at desktop and narrow widths;
- the map still pans normally after Escape.

### Phase 4 — export and Layers-panel wiring (Owner: **Sonnet**)

Follows existing patterns once Phases 2 and 3 exist. 4a does not depend on them
and can start right after Phase 1.

**4a. "Selected" scope for drawn features (D9).**
- Add the radio at `index.html:132-135`.
- In `js/core/cache.js`:
  - `getExportArrays("selected")` keeps the features in
    `App.getSelectedFeatures()`, matched by type and array index at export time.
    Labels and text boxes are left out.
  - The JSON (All data) branch at lines 735–746 treats "selected" like
    "visible".
  - `_scopeSuffix` returns `-selected`.
  - The empty-export status messages gain "Nothing to export — no features
    selected."

**4b. Export-menu button (D10).**
- Add `<button data-format="gtfs-stops" id="export-gtfs-stops" style="display:none">`
  after the Local Map Data button (`index.html:143`).
- In the Export button's open handler (`js/app.js:1577-1584`), set its visibility
  and label ("Selected GTFS stops (CSV) · 163") from `App.gtfsStops.count()` each
  time the menu opens.
- In the format handler (`js/app.js:1591-1595`), route `gtfs-stops` to
  `App.gtfsStops.exportCSV()` before the `App.cache` formats.

**4c. Layers panel.**
- Add `gtfs-stops-selected` to the GTFS stops entry's `layers` array
  (lines 62–63) with `op: "circle-opacity"`, so visibility and opacity apply to
  both.
- Add the generic optional manifest hooks to `buildLayerRow`:
  - `menuItems()`: entries appended after Zoom to layer;
  - `badge()`: muted text after the label.
- The GTFS stops entry supplies:
  - badge: "163 selected", or "163 selected · 4 not in feed";
  - menu items: **Select stops by box** (turns the tool on with the GTFS stops
    target), **Select stops from list…** (a hidden file input, `accept=".csv,.txt"`),
    **Zoom to selected stops**, **Export selected stops (CSV)**,
    **Clear stop selection**.

  The selection items are disabled when the selection is empty.

**Done when:**
- all five feature formats export only the selected features under "Selected";
- the stop export button appears and disappears correctly;
- the stop CSV opens cleanly in a spreadsheet, names with commas included;
- the Layers menu actions work.

### Phase 5 — tests, screenshots, documentation (Owner: **Sonnet**; **Haiku** runs suites; **Opus** final review)

1. New browser smoke test `test/gtfs-stop-select-smoke.mjs` (Sonnet). Same
   harness as `test/gtfs-browser-smoke.mjs`, with a synthetic feed of about eight
   stops in two rows plus a second feed missing two of those stops. Checks:
   - box select on the GTFS stops target: replace, Shift-add, Ctrl-remove, click
     on a stop, and a plain click on empty map clears;
   - the feature selection is untouched by stop drags, and vice versa;
   - Delete does nothing while on the stops target;
   - with the stops layer hidden, the target is disabled and drags select
     nothing;
   - right-click add/remove;
   - the export CSV content (capture the download and compare the text);
   - "Selected" scope export of features (CSV);
   - import from a list, then load the second feed: the selection is kept, 2
     are reported "not in this feed", and the export has `in_feed` = 0 rows;
   - a page reload restores the selection, which reappears once the feed is
     loaded again;
   - Remove layer clears the selection.
2. Screenshots (Sonnet adds the shots, Haiku runs them, Opus inspects): add to
   `test/ui-screens/capture.mjs`:
   - the box-select bar with the GTFS stops target (light/dark);
   - the Export menu with the stop button;
   - the GTFS stops row badge and its open menu.

   Re-baseline only the shots this work changed.
3. `CLAUDE.md` (Sonnet; Opus checks against the code):
   - `box-select.js`: targets, the bar, `combineKeys`;
   - `gtfs.js`: the `App.gtfsStops` and `App.gtfsStopList` APIs, the selection
     lifecycle, the right-click items;
   - `cache.js`: the Selected scope;
   - `layers-panel.js`: the `menuItems`/`badge` hooks;
   - `app.js`: the Export button and the Delete-key rule;
   - the covered-engine list and the smoke-test list.
4. Mark this plan **implemented** with short implementation notes, as
   `docs/box-select-plan.md` does.

**Haiku regression task** (after each phase from 2 on; long-running, tightly
bounded). Run exactly these commands, report pass/fail with the tail of each
log, and change nothing:
- `node test/run-golden.mjs`
- `test/box-select-smoke.mjs`, `test/gtfs-browser-smoke.mjs`,
  `test/feature-merge-smoke.mjs`, `test/feature-split-smoke.mjs`,
  `test/feature-color-smoke.mjs` (and `test/gtfs-stop-select-smoke.mjs` once it
  exists)
- `bash test/browser/run-browser.sh`
- `test/ui-screens/capture.mjs`, then list which images differ from
  `test/ui-screens/baseline/`.

For NODE_PATH and Playwright setup, see `test/README.md`.

### Phase 6 — real-data acceptance (Owner: **Opus**, then the user)

Using the two RTD feeds (kept out of the repo):
1. Load the Build ZIP and box-select the Federal corridor stops, including the
   BRT stops. Remove cross-street stops with Ctrl+click.
2. Export. Load the No-Build ZIP. The "not in this feed" count should equal the
   number of BRT stops in the selection (the Build feed is the No-Build feed plus
   144 BRT stops, with none removed).
3. Export again and confirm the two CSVs list the same IDs.
4. Time a box drag over the whole metro area to confirm it stays responsive with
   about 7,500 stops.

## Delegation summary

| Work | Owner | Why |
|---|---|---|
| `combineKeys`, stop-list parsing/CSV helpers, golden cases | Sonnet | Self-contained, exact spec |
| Stop selection state, highlight, API, right-click items | Sonnet | Follows existing gtfs.js patterns |
| Selection lifecycle review (load, restore, clear, autosave) | **Opus** | Ordering bugs here are silent and only show on reload |
| Box-select target registry, drag changes, on-map bar | **Opus** | Capture-phase events, regression risk for every box-select user, new UI |
| Selected export scope, Export button, Layers hooks and menu | Sonnet | Small, pattern-following |
| Smoke test, screenshot additions, CLAUDE.md | Sonnet | Mechanical with a clear checklist |
| Running test suites and the screenshot capture, reporting diffs | **Haiku** | Long-running, fixed commands, no decisions |
| Final review, screenshot inspection, real-data acceptance | **Opus** | Judgment |

Order: Phase 1 → Phase 2 → Phase 3 → 4b/4c → Phase 5 → Phase 6. Phase 4a can run
in parallel with Phases 2–3. The Phase 3 registry work for the features target
can start alongside Phase 2; only the stops target needs Phase 2's API.

## Orchestration notes for Opus

- Brief each Sonnet task with:
  - this plan's phase section and the decisions it depends on;
  - the exact files it may change;
  - the functions and line ranges above, re-checked against the current code
    first, since line numbers drift;
  - the acceptance checks;
  - a reminder of the CLAUDE.md conventions (design tokens, no build step,
    `App.*` namespace, golden-test rules).
- Re-read every diff before committing. In particular, check that the features
  path of box select is unchanged, that every stop-selection change goes through
  `changed()`, and that nothing reads a stop selection without allowing for IDs
  missing from the feed.
- Haiku only runs the fixed command list and reports. It never edits files,
  re-baselines screenshots, or decides that a failure is a flake.
- A golden or smoke failure in code a phase didn't touch is a regression to
  diagnose, not to re-record.

## Risks

- **Box-select regressions.** Mitigation: the features target wraps the current
  code unchanged, and the existing smoke test must pass without edits.
- **Clicks on the bar starting a drag.** Mitigation: the bar lives outside the
  canvas container, which the capture-phase handler ignores; the smoke test
  clicks the bar while the tool is on.
- **Stop IDs not stable between feeds.** Other agencies may renumber stops
  between scenarios. Mitigation: the "not in this feed" count, `in_feed` in the
  export, and the ZIP name in the file name make this visible instead of silent.
- **Large feeds.** Projection is limited to stops within the current map view.
  The feed is already held in memory by the viewer, so selection adds only a
  list of IDs.

## Not in scope

- Rule-based selection in the app (by name, distance or route). That stays in
  the outside script; Select stops from list… brings its result back for review.
- Selecting other reference layers (census areas, OSM, walk network) — the
  registry allows it later.
- "Both" (features and stops in one selection).
- Lasso or polygon-shaped selection.
- The corridor-service script itself (matching stops to trips, routes and
  blocks, and summing service). A prototype exists from the planning
  conversation; it would live outside this app.
- Two GTFS feeds loaded at once.
