# Phase 7 — Shell hierarchy, accessibility, documentation

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/ui-layout.md. This file is historical.

**Goal:** finish the original refresh with consistent narrow layouts for single-step
analysis panels, toolbar and Analysis-menu grouping, and an accessibility pass — then
update the project docs and refresh the screenshot baselines to the new look.

## 0. Consider fixing the dark-mode no-flash bug here

Phase 0 found that `index.html`'s "no-flash" `<head>` script reads
`document.body.classList` before `<body>` exists, so it throws on every load
(a real `pageerror`, not a sandboxed-environment artifact) and never applies
the class — dark mode currently reverts to light on every reload for real
users, only surviving via the `#darkmode-btn` click handler for the rest of
the tab session. See the README's known-risk register for the full writeup.
This phase already relocates that button, so it's a natural place to also fix
it: move the one-line script from just before `</head>` to the first line
inside `<body>` (still runs before any other body content paints — same
no-flash effect — but `document.body` exists there). Not required, but flag
the decision to the developer rather than leaving it silently broken. **If
fixed, update `capture.mjs` too**: it unconditionally clicks `#darkmode-btn`
for the dark pass today because that's the only thing that currently works;
once the no-flash script correctly pre-applies the class, that same click
would toggle dark mode back *off* instead. Guard it — only click when
`!document.body.classList.contains("dark-mode")`.

## 1. Single-step panel layout normalization

Phase 4 approved Walkshed as the narrow-panel pilot and added the shared
`App.renderModuleInputs()` collapsible-input primitive. Walkshed, Transit Coverage, and
Transit Travelshed currently use it. Extend that pattern before refreshing the final
baselines so more single-step tools preserve horizontal space for the live map introduced
in Phase 6.

This is a **structural-fit rule**, not a blanket rule that every module with one Run
button must use the same markup. Apply it where inputs can collapse into a useful summary
and the results remain readable in a narrow floating panel.

### Confirmed conversions

- **Feature Area Analysis:** wrap the Settings column with
  `App.renderModuleInputs()`. Its collapsed summary should identify the selected variable
  count, geography level, ACS year, and area-apportionment state. Keep the Results table
  visible while inputs are collapsed.
- **Transit Propensity Index:** make the Settings column collapsible. Summarize geography
  level/year, analysis-buffer distance, selected-feature count, and selected corridor.
  Preserve the Adjust Weights modal and choropleth visibility control.
- **Corridor Scoring:** make the Settings column collapsible. Summarize geography
  level/year, analysis-buffer distance, and selected-corridor count. Preserve the Adjust
  Weights modal and route-coloring visibility control.
- **FTA Small Starts:** apply the collapsible Settings pattern to the **Ratings** tab,
  summarizing geography level and ACS year. Keep the Data Inputs tab's upload layout
  unchanged; it is a separate workspace and does not fit the narrow input/results schema.

Use each module's existing Settings and Results DOM. Do not duplicate the collapse
component or introduce module-specific caret behavior. Each module should call
`App.renderModuleInputs()` during its existing popup initialization and provide a summary
callback based on current UI state. Reopening a module starts expanded, matching the
Phase 4 pilot behavior; user collapse/expand actions must not alter analysis settings.

### Existing implementations — regression check only

- **Walkshed:** retain the approved narrow-panel pilot behavior.
- **Transit Coverage:** retain its current collapsible inputs and verify its summary stays
  current after setting changes and analysis runs.
- **Transit Travelshed:** retain its current collapsible inputs and verify origin picking,
  map interaction, and summary updates still work while the panel remains open.

### Conditional fit test — do not force the pattern

- **Route Costing:** its main view is Settings | Results, but the service checklist,
  dense results tables, Costing Settings modal, and Interlines workflow may require its
  current width. Prototype the narrow/collapsed state only if it can preserve readable
  tables and modal access without horizontal clipping. Otherwise document it as deferred.
- **Trip Builder:** its service selector is simple, but its generated schedules are among
  the widest results in the app. Prototype only if the results remain readable at the
  proposed narrow width. Otherwise document it as deferred.

Do **not** convert Ridership Forecasting, Title VI Service Equity, or GTFS Feed Viewer in
this phase. Their multi-step/tabbed or specialized workspaces do not fit this schema.

### Layout and responsive acceptance criteria

- Expanded inputs remain comfortable at the Phase 4 control sizes; collapsed inputs leave
  a materially narrower panel over the map.
- Results never disappear when only the input section is collapsed.
- The input summary updates after every setting that it reports.
- The shared input caret and the Phase 6 whole-panel caret remain visually and
  semantically distinct. Both work by mouse and keyboard and expose accurate expanded
  state.
- At 1280px and the harness's narrow viewport, no panel or dense result table clips beyond
  the viewport. Existing responsive stacking remains functional.
- Verify both light and dark themes in expanded and collapsed states. Add focused captures
  for the newly converted modules where the existing harness does not exercise both
  states.

This layout work may be committed separately as
`UI refresh phase 7a: normalize single-step analysis panel layouts` before the Phase 7
shell/accessibility commit. It remains part of Phase 7 and must be complete before the
final baseline replacement.

## 2. Toolbar hierarchy

Today `#file-actions` mixes view toggles (dark mode, present) with workflow actions
(save, add data, export, analysis). Restructure `index.html` (keep all ids; only move
elements and adjust CSS):

- **Left group — session/workflow:** save-state, add-data, export, analysis.
- **Center — draw tools** (unchanged) then draw actions (undo/redo/clear), with the
  destructive **Reset** kept at the group's far end with its existing extra margin.
- **Right group — view controls:** dark-mode and present buttons, placed immediately
  left of the search box (`#search-wrapper` is absolutely positioned right — put the
  view buttons in a small absolutely-positioned wrapper beside it, or convert the
  toolbar's right side to a flex group; implementer's choice, but don't break the
  search dropdown positioning).
- Add subtle group separators: `1px` `var(--border)` vertical rules with
  `var(--space-3)` gaps (replace the current bare `margin-right: 32px` /
  `margin-left: 32px`).

Check present-mode and collapsed states still look right (present mode hides the
toolbar entirely — unaffected, but verify).

## 3. Analysis dropdown grouping

In `js/app.js` `buildAnalysisButtonsHTML()`: render two labeled groups using the same
heading style as the Add Data dropdown (`.add-data-heading` pattern):

- **General:** Feature Area Analysis and Walkshed Analysis.
- **Transit Planning:** every other non-system analysis, arranged alphabetically by
  visible module name.

Implementation note: keep the two General ids explicit in `buildAnalysisButtonsHTML`;
put every other registered non-system module into Transit Planning and sort that group
by visible name so future modules never vanish. Skip `system: true` modules as today.
JS UI change → run golden harness.

## 4. Accessibility pass

- **Focus visibility:** add a global
  `:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }`
  and remove any `outline: none` that isn't paired with a box-shadow focus style
  (grep `outline`).
- **Labels:** every icon-only button gets `aria-label` (grep `<button` in `index.html`
  and the JS-built row buttons in `features.js` / `layers-panel.js`: gear, trash, eye,
  color swatch, duplicate, collapse chevrons). `title` alone is not enough.
- **Target size:** the small row icons (`.fp-gear-btn`, `.fp-del-btn`, layer-row
  icons, `.rf-info-btn`) get a ≥24×24px hit area via padding/min-sizes — visual glyph
  size can stay as-is.
- **Color-alone check:** classification pills already carry text (High/Medium/Low) —
  confirm; the red "blocked service" rows in Route Costing / Trip Builder already have
  ⚠ badges — confirm; fix any case found where color is the only signal.

## 5. Documentation + wrap-up

- **CLAUDE.md:** update the Conventions section — semantic color tokens + the dark-mode
  token block (declare "no raw hex for chrome colors; data colors exempt"), spacing
  scale, the shared control classes and layout primitives (`.form-field`,
  `.form-section`, `.btn-row`, `.u-*`), Inter, de-modalized popup behavior (live map,
  dock-right, collapse), and the screenshot harness (`test/ui-screens/`) as the visual
  verification tool.
- **CLAUDE.md — correct the stale sidebar description** (phase 0 finding): the
  "Panel-based sidebar" Conventions bullet and the Layout section's ASCII
  diagram both describe `#sidebar-wrap` / the Analysis panel as if live, but
  `App.sidebar.render()` is never called anywhere and the Analysis panel is
  actually the toolbar dropdown built by `buildAnalysisButtonsHTML()`. If §1's
  toolbar work or phase 4 didn't revive the sidebar, update both spots (plus
  the `sidebar.js` file-structure entry) to say so plainly instead of
  describing dead code as current behavior; if it *was* revived along the way,
  update to match whatever it now does.
- **features.md:** mark "Modern UI refresh" done (link to `docs/ui-refresh/`), and note
  that "Analysis dropdown navigation" and "Top menu layout and hierarchy" were partially
  delivered here (grouping + toolbar hierarchy); leave the vertical icon rail and
  command palette items open.
- **Refresh baselines:** rerun the capture script; replace `test/ui-screens/baseline/`
  with the new-look images (delete the pre-refresh set — git history keeps it).

## Verification

- Capture script both themes — final full pass.
- `node test/run-golden.mjs` → pass.
- Expanded/collapsed walkthrough for Feature Area Analysis, Transit Propensity Index,
  Corridor Scoring, and FTA Small Starts Ratings; regression walkthrough for Walkshed,
  Transit Coverage, and Transit Travelshed.
- Record the Route Costing and Trip Builder fit-test decision. If either is converted,
  include it in the expanded/collapsed walkthrough and verify its widest result state.
- Keyboard-only walkthrough: Tab through toolbar → sidebar → a popup; focus always
  visible; Escape closes popup.

## Final review

### Corrected implementation outcome

The original completion note conflated the four newly collapsible panels with a
narrow-layout conversion. That was documentation-only; those panels still opened at
1000px. The correction introduces the shared `panelWidths` registration field and
`App.popup.setLayoutMode("setup" | "results" | "workspace")`, with drag reset for
normal opens and explicit transitions, while Inputs expand/collapse preserves the
user's current drag position. The existing 90vw cap is retained. Each logical input section now has a stable
`data-input-group` wrapper and Run/Calculate buttons use `.module-input-actions`, so a
later Settings or Advanced consolidation can move a complete group without rewiring IDs
or listeners.

### Input hierarchy follow-up

Analysis panels now use this visible input order wherever the relevant controls exist:

1. Feature, route, corridor, or service-area selection.
2. Census geography and ACS-year selection.
3. Buffer and other study-area parameters, including apportionment.
4. Module-specific settings.
5. Additional settings behind an existing modal button or native details control.

Transit Travelshed is the deliberate exception: **Select origin** is its first control,
followed by route/line selection and then its transit-specific parameters. The
Walkshed and Transit Travelshed details controls are labeled **Additional settings**.
The ordering is presentation-only; all existing control IDs and listeners remain
unchanged.

| Module | Setup | Results/workspace | Decision |
|---|---:|---:|---|
| Walkshed | 460px | 460px | Retained vertical pilot. |
| Feature Area Analysis | 520px | 900px | Widen only for the five-column result table. |
| Transit Propensity Index | 520px | 520px | Geography list and summary stay vertical. |
| Corridor Scoring | 520px | 760px | Result width uses the available space for rankings and factors. |
| FTA Small Starts Ratings | 520px | 520px | Ratings remain vertical. |
| FTA Data Inputs | — | 1000px workspace | Preserves the upload workspace. |
| Transit Coverage | 540px | 760px | Widen for population/jobs and headways. |
| Transit Travelshed | 540px | 640px | Retains scrolling inputs and Advanced details. |

Route Costing and Trip Builder remain wide by design. Ridership Forecasting, Title VI,
GTFS, system modules, and the dormant Mitigation Needs prototype are excluded.

- Feature Area Analysis, Transit Propensity Index, Corridor Scoring, and FTA Small
  Starts Ratings use the shared collapsible-input layout. Walkshed, Transit Coverage,
  and Transit Travelshed retain it. All seven now also use the adaptive widths above.
- Route Costing and Trip Builder retained their wider layouts after dense result and
  interline/schedule fit testing. Their warning states combine visible icons or labels
  with color rather than relying on color alone.
- Toolbar controls are grouped by workflow, drawing, and view function. The Analysis
  menu puts Feature Area Analysis and Walkshed Analysis in General, and alphabetizes
  every other non-system module under Transit Planning.
- Visible icon-only controls have accessible names, collapsible/tab state exposes ARIA
  state, keyboard focus remains visible, and the audited high-frequency row controls
  meet the 24px minimum target size.
- Dark-mode persistence is fixed by moving the no-flash script to the start of the body.
- Verification completed with 129/129 golden tests and 96/98 visual/a11y checks; the two
  skips are the intentionally dormant legacy sidebar in light and dark themes.
- `test/ui-screens/baseline/` now contains the completed Phase 7 visual baseline set.

Send the developer the final light+dark shell and representative expanded/collapsed
single-step panel screenshots plus a summary
of everything shipped across phases 0–7, and the list of deliberately-deferred items
(vertical icon rail, command palette, JS-template inline styles, docked-panel popup
variant).

Commit: `UI refresh phase 7: toolbar/menu hierarchy, a11y pass, docs, new baselines`
(with `Verified: node test/run-golden.mjs → N/N`)
