# GTFS expansion and cross-app handoff — implementation plan

> **Status:** Approved at Gate G0 (2026-11-21). A0–A4 complete; next phase A5.
>
> **Scope: the Analysis app only** (`caseywalrath/transit-analysis-tool`). Work on the Transit Costing Tool (`caseywalrath/transit-costing-tool`, the **Costing tool**) is in a separate plan, `docs/gtfs-costing-tool-plan.md`. It starts only after this plan is complete. **Nothing under this plan changes the Costing tool repository** (D14).
>
> **Based on:** a review of GTFS·X (the documentation at <https://www.gtfsx.com/docs/> and the repository <https://github.com/GTFS-X/gtfsx>, read 2026-11-20) against the Analysis app at `7ce6056` and the Costing tool at `aea64aa`. Part 1 summarizes the findings, so the original conversation is not needed.

**Read this whole document before starting any phase.** The phase sections assume Parts 1–3. Each phase must leave the app fully working, and each package is committed separately with `Verified:` lines (`CLAUDE.md` § Testing).

**Who reads what**

- **The user:** read the Summary, Part 4 (phase overview) and the decision gates. Every gate is listed in Part 8 with a link to its phase.
- **Opus planners:** read everything and follow Part 3.
- **Sonnet and Haiku agents:** you receive task cards. Each card names the sections of this plan to read.

---

## Summary

The Analysis app gains the ability to work from real transit schedules (GTFS):

- it learns to read a GTFS schedule for a chosen day, quickly enough for a large agency feed;
- it then uses the schedule for stop and route detail panels, a service and cost summary, stop analysis, coverage, Title VI service equity, and schedule-based travel times;
- it can mix drawn proposals into the real network for those analyses;
- it can export drawn Services as standard GTFS.

**The Costing tool is not part of this plan.** Its GTFS work (export, import, new views, interlining) and the round trip between the apps are in `docs/gtfs-costing-tool-plan.md`. That plan starts only once this one is finished, and only then does any work happen in the Costing tool repository.

We borrow **ideas** from GTFS·X, never its **code** (licensing, Part 1.2). Where GTFS·X's method is weak, we build a better version: cost units, peak vehicles, spacing bands, coverage estimates and single-departure travel times.

**What you get, in order:**

1. **A1:** More accurate population counts in every module (using where people actually live). Clearer Route Costing hours and rates. Coverage measured from stops.
2. **A2:** Large GTFS feeds load without freezing the page, plus a single "day to analyze" choice.
3. **A3:** Copy a real GTFS route as an editable Service with its headways, run time and stops, so every existing module works on real routes.
4. **A4:** A feed overview. Click a stop or route to see its trips, headways and nearby population.
5. **A5:** A GTFS service and cost summary, and Stop Analysis (spacing, consolidation candidates, service per stop, wheelchair data).
6. **A6:** Coverage, Title VI service equity and travel times on real schedules, with drawn proposals mixed in.
7. **A7:** Build vs No-Build comparison and feed health checks.
8. **A8:** Export drawn Services as GTFS.

Afterwards, in the separate plan: the Costing tool phases (C1–C5) and the round trip between the apps (J1).

---

## Part 1 — Findings

### 1.1 What GTFS·X is

GTFS·X is a browser-based GTFS **editor** (React/TypeScript, Mapbox, Cloudflare backend). Its analyses read the schedule (`stop_times.txt`) directly:

- operating cost and service summary;
- demographic coverage;
- Title VI service equity;
- stop analysis;
- RAPTOR access isochrones;
- light vehicle blocking;
- feed variants.

Most of its remaining surface is out of scope for us (1.6): feed authoring, hosting and publishing, rider embeds, accounts and billing.

### 1.2 Licensing

GTFS·X is licensed **AGPL-3.0**.

- **Free to use:** ideas, methods, thresholds, formulas, workflows and screen layouts. Standard algorithms are not theirs either: RAPTOR, overlap counting, greedy blocking, great-circle distance.
- **Not free to use:** copying their code, or translating it closely. That would make our apps derivative works that must be published under AGPL, including offering source to every online user. Neither of our repositories has a license file today.
- **Their hosted data** (demand-dot tiles, nationwide census-block file, county file) is served from their own servers and is not ours to use.

Decision D1 makes this a binding rule. This is a practical reading, not legal advice.

### 1.3 How the three tools differ

| | GTFS·X | Analysis app | Costing tool |
|---|---|---|---|
| Source of truth | The GTFS schedule | Drawn routes with headway time bands; GTFS is a reference layer only | Timepoint patterns, run-time bands, trips, blocks |
| Map | Yes (Mapbox) | Yes (MapLibre, own street network) | No |
| GTFS | Read, edit, write | Read-only viewer, route browser, "copy shape as line", stop list | None (deferred to its Phase 6) |
| Analyses | Cost, coverage, Title VI ratio, stop analysis, isochrones | Coverage, Title VI major-change, travelsheds, walksheds, TPI, ridership, FTA, costing | Run times, trips, blocking, costing |
| Stack | React/TS + backend | Plain JavaScript, no build | React/TS, static site |

**The key gap:** none of our analysis modules reads a schedule. A **GTFS schedule engine** (Phase A2) is the foundation for most of this plan.

### 1.4 Method findings

Phases refer to these by number. Each states where the evidence is, so a planner can re-check it.

- **F1 — GTFS·X cost units.**
  - Cost = (revenue hours × deadhead factor 1.1) × a rate labelled "cost per **revenue** hour". In the user's screenshot, route 0: 793.1 h × 1.1 = 872.4 h × $100 = $87,241.
  - An NTD cost per vehicle revenue hour already includes deadhead, so deadhead is counted about 10% twice.
  - Their "revenue hours" also leave out layover between trips, which NTD revenue hours include. The two errors partly cancel.
  - Docs page: `cost-estimation`.
- **F2 — GTFS·X peak vehicles.**
  - Peak vehicles = the most trips running at one moment, grouped by `service_id`. A code comment of theirs admits this under-counts when several service IDs run on one date, which is common in large feeds.
  - It also ignores layover, so it is a minimum.
- **F3 — GTFS·X stop-spacing bands.**
  - Bands: too close < 600 ft, target 750–1,320 ft, too far > 2,640 ft. Nothing between 600–750 ft or 1,320–2,640 ft is labelled.
  - In the user's screenshot, 813 + 4,446 + 894 = 6,153 of 9,932 segments were classified, so about 38% fell in no band.
  - Docs page: `stop-analysis`.
- **F4 — GTFS·X stop-consolidation savings.**
  - Savings = seconds per removed stop (default 18, meant to include braking and acceleration) × trips per day.
  - It assumes every trip stops there, and the extra walk for riders is not counted.
  - Terminals and stations are excluded; the lower-service stop of a pair is flagged.
- **F5 — Census apportionment.**
  - **GTFS·X:** its default method treats block groups as circles around tract centres; its own stop panel says adjacent stops look alike. Its exact method uses a hosted nationwide block file.
  - **Ours:** we use real TIGERweb polygons with area shares, which is better than their default.
  - **New finding:** the TIGERweb layer `Tracts_Blocks/MapServer/2`, which we already query in `js/core/lodes.js` (`fetchBlocksInternalPointsInUnion`), also returns `POP100` and `HU100`: each block's 2020 population and housing units. Verified by a live query on 2026-11-20. Exact block weighting therefore needs no hosting.
  - **Two separate apportionment implementations exist:**
    - `js/core/census.js`: `computeGeoOverlapFractions` and `aggregateWithinUnion`, used by Feature Area Analysis, Transit Coverage and Title VI;
    - `js/projects/tpi-scoring.js`: its own area-fraction code, used by TPI, Ridership Forecasting and Corridor Scoring.
- **F6 — Transit Coverage buffers the drawn line, not its stops** (`js/projects/transit-coverage.js` through `App.buildAnalysisBufferSet`). This overstates access for limited-stop and express service.
- **F7 — Route Costing hour labels and rate.**
  - Its displayed "rev hrs" are running hours (trips × one-way run time), and cost = rate × platform hours (running + layover + deadhead). That is consistent, but an NTD per-revenue-hour rate typed into it overstates cost.
  - There is no per-Service rate override. Interlines are disabled.
- **F8 — "Copy as line → Service" leaves the copies incomplete.** It sets service ID and direction only (`js/projects/gtfs.js` `copyShapeToLine`, `App.gtfsCopy`): no time bands, run time or stops. Copies therefore show "Needs setup" in every module.
- **F9 — Trip Builder's output is not used elsewhere.**
  - Its generator (`generateTripsForPattern`, `generateAllTrips` in `js/projects/trip-builder.js`) produces start/end times that no other module reads.
  - The Costing tool builds real schedules.
- **F10 — GTFS loading.**
  - `loadGTFSFile` parses every file, including `stop_times.txt`, into row objects on the main thread.
  - There is no service-date logic anywhere.
  - Full session export embeds the parsed tables (`serializeGTFSData`).
  - IndexedDB already keeps the original ZIP (`js/core/gtfs-store.js`, last two feeds).
- **F11 — Travel time.**
  - **Ours:** Transit Travelshed uses drawn routes, a headway wait model, at most one transfer, and street-network walking at both ends.
  - **GTFS·X:** RAPTOR over real stop times with one departure time; their docs list departure-window averaging as unbuilt. The access walk is straight-line and the egress walk uses Mapbox.
  - Docs page: `access-isochrones`.
- **F12 — Street-distance coverage at system scale.**
  - GTFS·X caps network walksheds at 200 stops per run.
  - Our walk floods are single-origin (`js/core/road-network.js` `computeWalkshed`, `computeWalkCostMap`).
  - Transit Travelshed already traces contours from arbitrary per-node times (`App.contourSamples`, `WalkShape.contour`), so a **multi-origin** flood (every stop starts at distance 0) plugs into existing tools.
- **F13 — Title VI.**
  - **Ours:** a major-service-change test (disparate impact / disproportionate burden):
    - before/after alterations, policy thresholds, route divergence, and areas losing or gaining service;
    - low-income = below poverty (`B17001`);
    - revenue-hours % and span % typed by hand (`manual` fields in `js/projects/title-vi-engine.js`).
  - **GTFS·X:** a service-equity ratio:
    - trips per capita in minority vs non-minority block groups, split at the regional average, with four-fifths banding;
    - low-income = below 200% of poverty (`C17002`);
    - a ½ mi buffer for stops with peak headway ≤ 15 min.
  - The two tests answer different FTA questions. Docs page: `title-vi-analysis`.
- **F14 — Costing tool gaps.**
  - Stops belong to one Route (IDs unique only within it; shared stops were deliberately deferred).
  - Service days have annual counts but no calendar dates.
  - There is no cross-scenario comparison table, and multi-route interlining is in its backlog.
  - **Already present:** stop and timepoint locations (Decision 0085), derived stop times (Decisions 0079 and 0086), and an "Export trips with stops CSV" that is close to GTFS `stop_times.txt`.
- **F15 — Day types differ across the tools.**
  - **Analysis app:** Weekday / Saturday / Sunday, with "Sunday mirrors Saturday". Route Costing has days per year for each type.
  - **Costing tool:** Weekday / Saturday / Sunday / Holiday, with annual counts.
  - **GTFS:** calendar dates.
- **F16 — Analysis bands ≈ Costing planned frequencies.**
  - Analysis app: `{from, to, frequency}` per day type, per drawn feature (pattern).
  - Costing tool: `{startTime, endTime, headwaySeconds}` per Route and Service day.
  - The one difference: per pattern vs per route.
- **F17 — GTFS·X interface patterns worth adopting:**
  - click a stop to see Details / Trips / Coverage tabs;
  - collapsible report sections with a one-line result in the header (for example "773 pairs · ~174.9 veh-hr/day");
  - thresholds editable inline;
  - CSV export per section;
  - a short "how this is computed" note;
  - instant recompute for schedule-only figures;
  - hiding routes re-scopes every analysis.
- **F18 — GTFS·X patterns to avoid:**
  - F1–F4;
  - two different coverage numbers for one stop;
  - one card per route for 130 routes;
  - Mapbox dependencies and sign-in walls.
- **F19 — Optional TPI documentation material.** GTFS·X's `rider-propensity` page:
  - separates "who rides" (zero-car, below 200% of poverty) from "who depends on transit" (adds 65+ and disability);
  - never adds overlapping groups together;
  - explains, with evidence, why it dropped renters and ages 18–24.

### 1.5 What happens to each overlapping feature

| Area | Feature | Disposition | Phase |
|---|---|---|---|
| Census | Apportionment (all modules) | **Expand:** add block-population weighting; unify the two implementations | A1 |
| Analysis | Route Costing | **Keep the math; expand:** rate basis, per-Service rate, clearer hour labels | A1 |
| Analysis | Transit Coverage | **Expand:** measure from stops; later accept GTFS stops | A1, A6 |
| Analysis | GTFS loading and storage | **Rebuild** as the schedule engine | A2 |
| Analysis | Route browser hide/show | **Expand:** hidden routes are excluded from GTFS analyses | A2, A4 |
| Analysis | Copy as line → Service | **Expand:** fill bands, run time and stops from the schedule | A3 |
| Analysis | GTFS popup (raw files) | **Rebuild** the front as a feed overview; keep raw files as a tab | A4 |
| Analysis | Stop / route details | **New:** click-for-details panel (entity-first) | A4 |
| Analysis | GTFS stop selection list | **Expand:** becomes an input to stop reports | A4, A5 |
| Analysis | Service summary and cost from GTFS | **New** | A5 |
| Analysis | Stop Analysis | **New**, with F3 and F4 fixed | A5 |
| Analysis | Title VI | **Keep** the engine; **add** the service-equity test and feed-derived inputs | A6, A7 |
| Analysis | Transit Travelshed | **Keep** for drawn routes; **add** RAPTOR on schedules with a departure window | A6 |
| Analysis | Walk network | **Keep**; **add** a multi-origin flood | A6 |
| Analysis | Build/No-Build feeds | **Expand** into a comparison table | A7 |
| Analysis | Feed health | **New** (light) | A7 |
| Analysis | Trip Builder | **Keep the generator** (as the synthetic-trip engine); **decide** the panel's future | A6, A8 |
| Analysis | Walkshed, TPI, Ridership, Corridor Scoring, FTA | **Keep**; they benefit from A1 | A1 |
| Analysis | Export drawn Services as GTFS (this app's side of the handoff) | **New** | A8 |
| Costing | Stop identity, GTFS export and import, new views, interlining, round trip | **Separate plan** (`docs/gtfs-costing-tool-plan.md`), after this plan | — |

### 1.6 Out of scope

- **GTFS authoring:** fares, Flex zones, stations and pathways, transfers, translations, agency editing.
- **Publishing:** hosted feeds, draft links, rider mini-sites, embeds, GTFS-Realtime alerts, catalog submission.
- **Platform:** accounts, organizations, billing, forum, AI assistant.
- **Other:** anything that needs Mapbox (snap-to-road, road travel-time estimates), and the demand-dot tile pipeline.

A phase sub-plan may not add any of these without a user gate.

---

## Part 2 — Fixed decisions

Agents follow these. Changing one requires a user gate (Part 3.5).

- **D1 — Clean room.**
  - (a) No GTFS·X source code, data files or assets enter either repository, verbatim or translated.
  - (b) Sonnet and Haiku agents never open GTFS·X source files.
  - (c) Opus planners may read GTFS·X's public documentation pages (Appendix A) and describe a method in their own words, citing the page.
  - (d) Neither app makes requests to GTFS·X servers.
  - (e) No Mapbox services.
- **D2 — Each app keeps its stack.**
  - The Analysis app stays plain JavaScript with no build step (`CLAUDE.md`).
  - The Costing tool stays React/TypeScript (`architecture_overview.md`).
  - The apps share **files**, not code.
- **D3 — GTFS is the interchange format.** Anything this app exports for another tool, including the later Costing tool plan, is standard GTFS. No second ("sidecar") format is added under this plan.
- **D4 — Time** is integer seconds after service-day midnight. Values past 24:00 are valid (same as GTFS and Costing Decision 0002).
- **D5 — Distances** for analysis are great-circle. `shape_dist_traveled` is never trusted as input, because GTFS leaves its unit undefined. Along-shape distance may be computed from geometry.
- **D6 — Hour vocabulary**, used in this app's interface, CSVs and docs (the Costing tool plan adopts the same terms):
  - **Running hours:** first departure to last arrival of revenue trips.
  - **Revenue hours:** running hours + layover between revenue trips (the NTD vehicle-revenue-hour convention).
  - **Platform hours:** pull-out to pull-in, or revenue hours + a deadhead estimate.
  - Every cost names its basis, for example "× rate per revenue hour".
- **D7 — Peak vehicles from GTFS:**
  - computed for one calendar date, across every service active that date;
  - if trips carry `block_id`: the most blocks in service at once (a block spans its first departure to its last arrival);
  - otherwise: the most trips overlapping at once, with each trip extended by the layover assumption;
  - the result always names its method.
- **D8 — Unions, not sums.** System totals count each person or area once. Per-route figures are not additive and say so.
- **D9 — Hidden GTFS routes** are excluded from GTFS analyses by default. Modules that already offer "include hidden" offer it here too, the same rule as for hidden drawn features.
- **D10 — The schedule engine** is `js/core/gtfs-schedule.js`, exposed as `window.GtfsSchedule`.
  - Pure: no DOM, map, `App` or turf access at load time.
  - Golden-tested through `test/run-golden.mjs`, and listed with the other engines in `CLAUDE.md`.
  - All other GTFS analysis math also lives in pure engine functions; panels only display results.
- **D11 — Works when `index.html` is opened from disk.** Any background thread (Web Worker) is optional and feature-detected, with a main-thread fallback that yields to the page.
- **D12 — No new libraries or CDN scripts** (`AGENTS.md` rule 7). Charts (histograms, Marey) are hand-built SVG/HTML. Any exception needs a user gate.
- **D13 — No silent number changes.**
  - A change that moves an existing module's results for the same inputs sits behind a gate.
  - Saved sessions keep the method they were run with.
  - Results and CSVs name the method.
- **D14 — No Costing tool changes.**
  - No package, agent or session working under this plan edits, commits to, or pushes to the `caseywalrath/transit-costing-tool` repository. That includes docs, backlog entries and pointers.
  - Agents may read that repository only where a phase section says so. A8 does, to keep its GTFS export usable later.
  - Costing tool work lives in `docs/gtfs-costing-tool-plan.md`, which starts only after this plan is complete.

---

## Part 3 — How the work is run

### 3.1 Roles and models

| Class | Model | Name in `AGENTS.md` | Owns |
|---|---|---|---|
| Planner / integrator | Opus | Planner / integrator | Sub-plans, task cards, every review gate, final verification, the Opus-only areas, visual and interaction design |
| Implementer | Sonnet | Implementer (default) | Well-specified features touching a few files and following existing patterns |
| Structural | Haiku at `high` or `xhigh` effort | Structural | Pure functions with golden tests, fixtures, markup to an exact spec, menu wiring, docs |

**Default division of work:**

- Haiku and Sonnet write most of the code.
- Opus writes sub-plans and cards, runs every review, and does these directly:
  - the `AGENTS.md` "Opus only" areas: map layer order and the Layers panel, map click ownership and the attributes dock, startup and session save/restore, IndexedDB, shared-helper refactors, geometry correctness, async races, and visual design;
  - in this plan specifically: the schedule engine's data layout and loader integration, the RAPTOR engine, the multi-origin walk flood, and the Title VI methods.
- When planning, apply "Prefer the structural class where it can succeed" (`AGENTS.md`): split work so Haiku can take it, and settle every decision in the card. Record which choices worked in the progress log.

### 3.2 Two detail levels

- **Ready phases (A0–A3).**
  - This plan settles their decisions, contracts and edge cases. The Opus orchestrator turns each package outline into a full task card after checking it against the current code (`AGENTS.md` "check the card against the code").
  - Small differences (renamed functions, moved code): adjust the card and note it in the progress log.
  - Anything that contradicts Part 2 or a gate answer: stop and ask the user.
- **Sub-plan phases (A4–A8).** An Opus agent writes a detailed sub-plan first (3.3). This plan gives each one its goal, what it must deliver, methods to honour, questions to resolve, and draft gates.

### 3.3 Instructions for the Opus agent writing a sub-plan

Paste this block, with `<ID>` filled in, into the planning prompt:

```
You are the Opus planner for phase <ID> of docs/gtfs-expansion-plan.md
(transit-analysis-tool).

1. Read that plan's Summary, Parts 1–3, the phase <ID> section, the Gate
   register (Part 8) and the whole Progress log, including hand-off notes.
   Then read the code and docs phase <ID> touches AS THEY ARE NOW, not as
   the plan describes them. Do not change the transit-costing-tool
   repository (decision D14).
2. Write down what has changed since the plan was written that affects this
   phase: code, deviations by earlier phases, gate answers.
3. Decide the phase's shape. You may split it, merge it with a neighbour,
   shrink it, or conclude that no change is needed. Dropping or postponing
   any item under "Must deliver" is a user gate. Otherwise record your
   reasoning in the Progress log.
4. Keep every Part 2 decision. Changing one is a user gate.
5. Write the sub-plan to docs/gtfs-expansion/<ID>-plan.md (create the
   folder if needed), in the style of docs/archive/gpkg-import-plan.md.
   Contents: status line; code facts verified (commit hash, search strings);
   fixed decisions for the phase; user gates in the Part 3.5 format with
   your recommendation; packages tagged [O]/[S]/[H] with task cards in
   AGENTS.md format; verification per package; docs to update; acceptance;
   a progress log.
6. Put each user gate before the packages that depend on it. Present the
   sub-plan to the user before launching any agent: a plain summary of what
   will change for them, the gates, and the package list with models.
7. Prefer Haiku wherever a precise card makes it possible; use Sonnet for the
   rest; do the Opus-only areas yourself.
8. When the phase closes: move the sub-plan to docs/archive/, record
   gate answers in Part 8, append a Progress log entry with hand-off notes
   (exact names, ids and signatures later phases need), and update the
   phase's status in Part 4.
```

### 3.4 Running a phase

- Follow `AGENTS.md` "Running a phase": cards → agents → Opus review gate (`code-review` at `high`, re-run every "Done when" command, inspect screenshots) → commit and push → progress log. A **package** in this plan is what `AGENTS.md` calls a phase: one commit, one review gate.
- Paste the `AGENTS.md` rules block at the top of every agent prompt.
- Every review gate confirms that the package touched only this repository (D14).

### 3.5 How to write a user decision gate

The user is a transit planner, not a programmer. Every gate uses this template:

```
**Gate <ID> — <short title>**
Question: <one sentence the user can answer without reading code>
- Option A (recommended): <what the user will see and do>
- Option B: <...>
Example: <a concrete case with numbers>
What changes: <consequences, including what happens to existing saved work
and results>
If you say "your call": <the default that will be used>
```

**Rules:**

- No code terms. If one is unavoidable, explain it in parentheses.
- One decision per gate.
- Say what happens to existing sessions and numbers (D13).
- Record the answer and date in Part 8, and repeat it in the progress log.

### 3.6 Testing and documentation

Use `CLAUDE.md` § Testing:

- Golden tests for every engine function.
- Browser tests for loading, restore, session files, map layers and hide/show paths. `hidden-features.test.mjs` after touching `module-buffers.js` or `analysis-checklist.js`.
- Screenshots for interface changes, inspected as images.
- Never edit an existing test or golden file to make it pass. Re-record golden values only for a deliberate, gated math change.
- Docs to update in the same commit: each touched module's `docs/reference/` page (always `docs/reference/modules/gtfs.md` for GTFS work); `CLAUDE.md` (file map, script load order, engine list, any new invariant); `test/README.md` for new golden cases.

### 3.7 Git and branches

- Each session works on its own `claude/…` branch, created from the latest `main` (this repo's `CLAUDE.md` on branch state).
- Confirm that earlier phases are merged into `main` before starting the next one. This avoids building on an old interface.
- Pull requests only when the user asks.
- Never start a package on an uncommitted tree.

---

## Part 4 — Phase overview

| Phase | What the user gets | Detail | Lead classes | Needs | Gates | Status |
|---|---|---|---|---|---|---|
| A0 | Test feeds and a speed baseline (nothing visible) | Ready | O | — | G0a–b | Done (2026-11-21) |
| A1 | Better census counts everywhere; clearer Route Costing; coverage from stops | Ready | S, H; O review | A0 (G0 only) | G1a–c | Done (2026-11-21) |
| A2 | Large GTFS feeds load without freezing; one "day to analyze" | Ready | O, H, S | A0 | G2a–b | Done |
| A3 | Copy a GTFS route as an editable Service with headways, run time and stops | Ready | H, S, O | A2 | G3a–b | Done |
| A4 | Feed overview; click a stop or route for its details | Sub-plan | O, H, S | A2 | G4a–c | Done (sub-plan `docs/archive/A4-plan.md`) |
| A5 | GTFS service and cost summary; Stop Analysis | Sub-plan | S, H, O | A2, A4 | G5a–d | Not started |
| A6 | Coverage, Title VI equity and travel times on real schedules, with proposals mixed in | Sub-plan | O, H, S | A1, A2, A3 | G6a–d | Not started |
| A7 | Build vs No-Build comparison; feed health checks | Sub-plan | S, O | A5, A6 | G7a–b | Not started |
| A8 | Export drawn Services as GTFS; decide Trip Builder's future | Sub-plan | S, H, O | A6 | G8a–b | Not started |

```
A0 ─► A1
A0 ─► A2 ─► A3 ──────────────┐
      A2 ─► A4 ─► A5 ─────┐  │
      A1 + A2 + A3 ─► A6 ─┴──┴─► A7
                      A6 ─► A8 ─► (this plan complete) ─► docs/gtfs-costing-tool-plan.md
```

Run one phase at a time. **Suggested start:** A0 → A1 → A2.

**When this plan is complete:** every phase is closed (or descoped with the user's agreement), the progress log has a closing entry, and this file moves to `docs/archive/`. Only then may the separate Costing tool plan begin.

---

## Part 5 — Analysis app phases

### A0 — Setup and baselines

**Goal:** agree the plan, create the test feeds, and measure today's GTFS loading. Nothing changes for the user.

**Gate G0a — Plan and copying rule**
Question: Do you approve this phase order and the rule that we never copy GTFS·X code?
- Option A (recommended): approve. We read how GTFS·X does something and write our own version.
- Option B: change the order or scope first. Tell us which phases to move or drop.
Example: we may read GTFS·X's description of how it counts peak vehicles, then build our own (better) count. We never paste their files into our apps.
What changes: building is somewhat slower than copying would be, but your apps stay free of the AGPL obligation to publish their source code under that license.
If you say "your call": Option A.

**Gate G0b — Real feeds for testing**
Question: Which real GTFS feeds should we test with?
- Option A (recommended): one large feed (RTD, matching your screenshots) and one small agency feed you know well.
- Option B: only the small feed.
Example: the large feed shows whether the app stays responsive with about 130 routes and about 7,500 stops. The small feed lets you check numbers by hand.
What changes: you provide the ZIP files or their public download links. Large feeds are not stored in the repository; tests that need them say where to put them.
If you say "your call": Option A, using RTD's public feed and the smallest feed you name later.

**Packages**

- **A0.1 [O] — Mini fixture feed.** Opus writes `test/fixtures/gtfs/mini/*.txt` and `test/fixtures/gtfs/mini/EXPECTED.md` (hand-computed answers). The feed must include all of the following:
  1. Three routes: a bus route with two directions; a rail route; a route whose service is defined only by `frequencies.txt` (one window `exact_times=0`, one `exact_times=1`, one window crossing midnight).
  2. One stop served by two routes, and a parent station with a child platform (`location_type` 1 and 0).
  3. Weekday, Saturday and Sunday services in `calendar.txt`. A weekday holiday removed through `calendar_dates.txt` and replaced by the Sunday service. A one-off added date. One service defined only in `calendar_dates.txt`.
  4. A trip running past midnight (`25:10:00`). A trip with blank intermediate times (`timepoint=0`). A trip whose first time is blank (invalid). `stop_sequence` values with gaps and rows out of order.
  5. `block_id` on some trips, including one block that switches routes.
  6. `wheelchair_boarding` values 0, 1, 2 and blank.
  7. `shapes.txt` for two of the three routes.
  8. File quirks: a byte-order mark in one file, CRLF line endings in one file, a quoted field containing a comma, and an extra unknown column.

  `EXPECTED.md` lists, for at least three named dates:
  - active services, trips per route, running hours per route;
  - first and last departures;
  - departures at the shared stop;
  - peak vehicles by both D7 methods;
  - the busiest weekday.

  These become golden expectations in A2.
- **A0.2 [O] — Baseline measurement** on the G0b feeds, with the current code:
  - time from file pick to routes on the map;
  - longest single page freeze;
  - browser memory after loading;
  - full-session export size.

  Record the numbers in the progress log and set A2's targets. Starting proposal for a feed the size of RTD on a typical laptop:
  - loaded and indexed in ≤ 15 s;
  - no single freeze longer than 250 ms;
  - schedule store ≤ 100 MB.

**Done when:** the fixture and `EXPECTED.md` are committed, the baseline and targets are in the progress log, and G0a–b are answered in Part 8.

### A1 — Quick wins on existing modules

None of this needs the schedule engine.

**Must deliver:**
- block-population weighting available to every census-based module;
- Route Costing with a rate-basis choice, per-Service rates and correct hour labels;
- Transit Coverage able to measure from stops.

**Gate G1a — How to count people when a buffer covers part of a neighbourhood**
Question: When a buffer covers part of a block group, how should we estimate how many of its residents are inside?
- Option A: by land area (today).
- Option B (recommended): by where people lived in the 2020 Census, using census-block counts.
Example: the buffer covers 30% of a block group's land. Under A, 30% of its residents count, even if that part is a park. Under B, if the covered part holds 2 of its 10 blocks with 400 of its 1,200 residents, 33% count; if it is all park, 0% count.
What changes: B is more accurate, especially near single stops. Population figures in every module move somewhat for new runs. Each run adds a short Census download, cached for the session. Saved sessions keep the method they were run with, and results and CSVs name the method. If the Census service is unreachable, the run uses A and says so.
If you say "your call": B for new runs; A stays available as a choice.

**Gate G1b — Measure Transit Coverage from stops or from the whole line**
Question: When a drawn route has stops, should coverage be measured around the stops or along the whole line?
- Option A (recommended): around the stops when the route has stops; along the line when it has none. Show which was used for each route.
- Option B: always along the line (today).
Example: a 10-mile limited-stop route with 10 stops and a ½-mile buffer. The line buffer covers about 10.8 sq mi; circles around the 10 stops cover about 7.9 sq mi. Covered population drops by roughly a quarter, and by more for rail with distant stations.
What changes: routes with drawn stops show lower, more realistic coverage. Routes without stops are unchanged. Saved sessions keep the line method until you re-run with the new setting.
If you say "your call": Option A.

**Gate G1c — Which hourly rate Route Costing expects**
Question: What kind of hourly rate do you usually type into Route Costing?
- Option A (recommended): keep "cost per platform hour" as the default, and add a choice of "cost per revenue hour (NTD)".
- Option B: switch the default to "cost per revenue hour (NTD)".
Example: 100 running hours, 10% layover and 10% deadhead give 120 platform hours and 110 revenue hours. At $150/hr, the platform basis gives $18,000 and the revenue basis $16,500. Typing an NTD per-revenue-hour rate under the platform basis overstates cost by about 9%.
What changes: under A, existing results stay the same. Either way, the column now labelled "Rev hrs" is renamed "Running hrs", because it never included layover, and a true "Revenue hrs (incl. layover)" column is added. Any spreadsheet that reads the CSV column by its old name needs updating.
If you say "your call": Option A.

**Packages**

- **A1.1 [O] — Card pass.**
  - Inventory every apportionment path. At least: `census.js` (`computeGeoOverlapFractions`, `aggregateWithinUnion`); `tpi-scoring.js`'s own area-fraction code (used by TPI, Ridership Forecasting and Corridor Scoring); and the callers in `buffer-summary.js`, `transit-coverage.js` and `title-vi-engine.js`.
  - Decide where each module shows the method choice (existing apportion toggles, the Title VI policy settings, Coverage settings). This is interface design, so Opus settles it and the cards state it exactly.
- **A1.2 [H] — Pure fraction function with golden cases.**
  - `blockWeightedFractions(geoids, blocksByGeoid, insideBlockIds, areaFractions)` returns a `Map` of GEOID → fraction.
  - Fraction = Σ `POP100` of the geography's blocks whose internal point is inside the area ÷ Σ `POP100` of all its blocks.
  - If the geography's total `POP100` is 0, use `HU100` the same way. If that is also 0, use the area fraction passed in.
  - Block membership comes from the GEOID prefix, never from point-in-polygon against the geography.
  - Tract-level fallback variables use tract-prefix sums.
  - It goes in a pure location, so it can be golden-tested alone. The card pass names the file.
- **A1.3 [S] — Block fetch.**
  - Extend the TIGERweb block query to request `POP100` and `HU100`.
  - Fetch blocks for every geography that touches the area, not only those inside it, because the denominator is the whole geography. Use a bounding box of those geographies or a GEOID-prefix query; the card pass chooses.
  - Cache per block group for the session; page through results with the existing `App.fetchAllTigerwebFeatures`.
  - On failure: return a status that makes the caller use the area method with a visible note. Never a silent fallback.
- **A1.4 [S, Opus review] — Wire the method in.**
  - A method option `"area" | "blockPop" | "whole"` in the shared helper(s). The existing boolean `apportionByArea` maps to `"area"` / `"whole"`.
  - Both implementations route through one fraction function.
  - Default per G1a. Module state stores the method; sessions saved before this change load as `"area"`.
  - Results and CSVs name the method.
- **A1.5 [S, H golden] — Route Costing.**
  - `settings.rateBasis`: `"platform"` (default) or `"revenue"`.
  - Revenue hours = running + layover hours for each day type.
  - Cost = rate × the chosen hours.
  - Per-Service rate overrides live in Route Costing's own saved state, keyed by Service key, **not** in feature attributes. Feature attributes would trigger the `CLAUDE.md` rule that every attribute change also updates the dock and Attribute Summary.
  - Labels and CSV per G1c. Bump the module's saved-state version, with defaults for older saves.
  - Golden tests: existing cases produce identical output under the default; new cases cover the revenue basis and an override.
  - The disabled Interlines button gets a tooltip pointing to the Transit Costing Tool; the card fixes the exact text.
- **A1.6 [S, Opus review] — Transit Coverage from stops.**
  - A feature's stops are the Points whose `attributes.associatedRoutes` reference it by stable id. Use the same resolution Transit Travelshed uses; the card names the function.
  - Coverage area = the union of circles at the buffer distance around those stops, when the feature has at least one stop; otherwise the line buffer.
  - The results table shows "from N stops" or "from line" per feature. The setting is saved; sessions saved earlier load as "line".

**Edge cases for the cards:**
1. Blocks with zero population and housing (water, parks) contribute nothing.
2. A geography whose blocks all have zero population or housing falls back to the area fraction.
3. An area crossing a state or county line.
4. Tens of thousands of blocks in a county-wide study: show progress, and warn above a threshold the card sets.
5. TIGERweb paging or timeout part-way through: treat as a failure (area method with a note), never a partial count.
6. Hidden stop Points: respect the module's "include hidden" setting.
7. A stop associated with several routes.
8. Walkshed-flagged Points: Coverage uses its own circles, and says so in the docs.
9. A route whose stops all fall outside the service area.
10. A Service whose rate override is blank, zero or negative: ignore it and use the default rate.

**Tests:**
- golden cases for every pure function;
- `hidden-features.test.mjs`;
- the existing golden suite passes unchanged except for gated, deliberate changes;
- screenshots of every changed panel.

**Docs:**
- the reference pages of every touched module;
- `CLAUDE.md` for any new public `App.*` name.

### A2 — GTFS schedule engine

**Must deliver:**
- the app loads a feed the size of RTD within the A0 targets without freezing;
- it answers "what runs on date X" for any date;
- one shared "day to analyze" setting;
- session files handle the feed per G2a;
- everything that works today keeps working: route browser, stop selection, restore after refresh, Build/No-Build swap.

**Gate G2a — Should saved session files carry the GTFS feed?**
Question: When you export a full session file, should it include the GTFS feed?
- Option A (recommended): yes, as the original ZIP file inside the session file.
- Option B: no. The session remembers the feed's name and asks you to add the ZIP when you open it on another computer, like GeoPackage layers today.
- Option C: keep today's format, which stores the unzipped tables.
Example: a 6 MB feed adds about 8 MB to a session file under A. Today's format stores the unzipped tables, which are usually many times larger.
What changes: all three options still open session files saved today. A keeps today's convenience with smaller files. B gives the smallest files but needs the ZIP at hand.
If you say "your call": Option A.

**Gate G2b — How you choose the day to analyze**
Question: Schedules vary by calendar date. How should you pick the day the GTFS analyses look at?
- Option A (recommended): pick Weekday, Saturday or Sunday. The app chooses a typical date (the busiest date of that type in the feed, skipping holidays) and shows it, for example "Weekday — Fri Nov 20, 2026". You can change it to any exact date.
- Option B: always pick an exact date yourself.
Example: in a feed with school trippers, an October Wednesday includes them and a July Wednesday does not. Option A picks a full-service weekday automatically.
What changes: one date drives every GTFS analysis at a time. It is saved with the session and shown on every GTFS result and CSV.
If you say "your call": Option A.

**Design fixed by this plan** (the card pass may adjust names, not intent):

- **Storage.**
  - `stop_times.txt` is read in one streaming pass (PapaParse row or chunk callbacks) into parallel integer arrays: trip index, stop index, sequence, arrival seconds, departure seconds, timepoint flag. Rows are sorted by trip, then sequence, with a per-trip offset table.
  - Blank times are stored as "missing" (−1) and filled only when a function asks for interpolation. String ids are stored once in lookup tables.
  - Other files stay as row objects, since they are small. Shapes keep today's GeoJSON conversion.
  - The raw-table viewer reads its first 500 `stop_times` rows from the store.
- **Engine responsibilities (`window.GtfsSchedule`):**
  - time parsing;
  - a calendar index from `calendar.txt` and `calendar_dates.txt`, including dates-only services;
  - active services for a date, and the feed's date range;
  - day type of a date, flagging dates where a weekday's usual services are removed as holiday or exception;
  - the representative date for a day type (busiest, ties → earliest on or after today while the feed is active);
  - trips on a date, with frequency templates expanded and `exact_times` respected;
  - trip spans; departures at a stop;
  - patterns (unique ordered stop lists per route and direction, with trip counts) and the dominant pattern (most trips on the date, then most stops, then longest);
  - median headway at a stop within time windows;
  - peak vehicles per D7;
  - a route-day summary (trips, running seconds, first departure, last arrival).
- **Day to analyze.** One shared app-level setting: get and set, plus a change notification for open panels. Saved additively in `moduleState["gtfs-browse"]`. Defaults per G2b.
- **Background thread:** optional per D11. Opus decides after measuring the main-thread version against the targets.

**Packages:**

- **A2.1 [O]** Card pass: confirm the data layout, search strings and fixture expectations.
- **A2.2 [H]** Calendar and date functions, with golden cases from `EXPECTED.md`.
- **A2.3 [H]** Time parsing, frequency expansion, trip spans, departures and headways, with golden cases.
- **A2.4 [H, or S if the card cannot settle every case]** Patterns and dominant pattern, route-day summary and peak vehicles (D7), with golden cases.
- **A2.5 [S]** Streaming `stop_times` reader into the store. Golden cases run on the fixture text, including the byte-order mark, CRLF, quotes, extra columns and blank times.
- **A2.6 [O]** Loader integration:
  - `loadGTFSFile` and the `gtfs-store.js` restore, keeping its transaction rule;
  - session export and import per G2a, with old session files still restoring;
  - the shared day-to-analyze setting;
  - the raw-table viewer.
- **A2.7 [H]** A large synthetic feed generator for tests, with exact size parameters set by the card.
- **A2.7 [S]** A browser test: load the large feed, switch the date, refresh and restore, run a session round trip, and check page responsiveness.
- **A2.8 [O]** Review, a performance check on the real feeds against the A0 targets, and docs.

**Edge cases for the cards:**
1. Times past 24:00; frequency windows crossing midnight.
2. Blank intermediate times. A blank first or last time: exclude the trip from timing and count it.
3. Unsorted rows, gaps in `stop_sequence`, duplicate (trip, sequence) pairs.
4. Trips referencing unknown stops, routes or services: skip and count.
5. Calendar end before start. Dates-only services. A missing `calendar.txt`. An "added" date outside a calendar's range.
6. Overlapping frequency windows. `exact_times` 0 and 1.
7. Blocks spanning routes or services.
8. Empty files. Feeds with no shapes. Several agencies.
9. A feed loaded while another is still loading (existing `_loadSeq` rule). A feed removed mid-load.

**Tests:**
- golden;
- `gtfs-cache.test.mjs`, `gtfs-browser-smoke.mjs` and `gtfs-stop-select-smoke.mjs` pass unchanged;
- the new browser test.

**Docs:**
- `docs/reference/modules/gtfs.md`: rewrite the loading and persistence sections;
- `CLAUDE.md`: file map, script load order (place the engine next to the other pure engines; the card pass names the anchor) and the engine list;
- `test/README.md`.

### A3 — Copy GTFS routes as editable Services with schedules

**Must deliver:**
- The route browser and the map right-click menu offer "Copy as Service with schedule".
- Copies carry Weekday, Saturday and Sunday headway bands, a run time, a direction and (per G3b) stops.
- A short reconciliation note per copied route.
- Route Costing, Transit Coverage and Transit Travelshed then run on the copy with no manual setup.

**Gate G3a — How detailed copied headway bands should be**
Question: When a real route is copied into an editable Service, how detailed should its headway bands be?
- Option A (recommended): standard parts of the day (early, AM peak, midday, PM peak, evening, night), for example "AM peak 06:00–09:00 every 12 min".
- Option B: a new band wherever the headway changes.
Example: a midday schedule alternating 14- and 16-minute gaps becomes "every 15" under A, and several short bands under B.
What changes: under both options, trips per day match the real schedule exactly. A is simpler to read and edit. B can produce 10–20 bands per day for irregular schedules. Run time is one average per direction either way, because the Service holds a single run time.
If you say "your call": Option A. The day-part times are one editable setting, reused by A4 if G4c agrees.

**Gate G3b — Copy stops too?**
Question: Should copying a route also copy its stops as points on the map?
- Option A (recommended): yes, when copying up to 5 routes at a time; ask first for larger copies.
- Option B: never copy stops.
Example: one bus route has 60–120 stops. Copying 20 routes could add over 1,500 points to the Features list.
What changes: copied stops let coverage (G1b) and travel times use real stop locations. Without them, those modules measure from the line.
If you say "your call": Option A.

**Calculation (fixed):**

1. **Dates.** Use the representative date of each day type (A2).
2. **Trips per shape.** Take the trips on that date that use the copied shape. Trips without a shape cannot be copied, because the copy needs geometry; they are listed in the note.
3. **Bands (G3a = A).**
   - Assign each trip to the day part containing its first departure.
   - For a day part with *n* trips over *m* minutes, the headway *h* is:
     - the first value from 2, 3, 4, 5, 6, 7.5, 8, 10, 12, 15, 20, 30, 40, 45, 60, 90, 120 for which `ceil(m ÷ h) = n`;
     - if none qualifies, the largest one-decimal value with `ceil(m ÷ h) = n`.
   - The first band of the day starts at the first departure, rounded down to 5 minutes. The last band ends at the last departure, rounded up to 5 minutes.
   - Day parts with no trips get no band.
   - Sunday mirrors Saturday when their bands are identical.
4. **Run time.** The trip-count-weighted mean trip duration on the representative weekday, falling back to Saturday and then Sunday. Minutes, one decimal. Average speed is left blank, since run time takes precedence.
5. **Direction.** Today's rule (`direction_id` 0 → Outbound, 1 → Inbound when all trips agree).
6. **Stops (G3b).**
   - Points at the stop coordinates, carrying the stop name, associated with the copied line(s).
   - A stop served by several copied shapes becomes one Point associated with all of them.
   - Opus decides in the card pass how a later copy recognises a stop already copied, without adding a new attribute field. A new field would trigger the `CLAUDE.md` rule that attribute changes also update the dock and Attribute Summary.
7. **Reconciliation note.** Per route and day type: trips (copy vs GTFS) and running hours (Route Costing's math on the copy vs GTFS). Trips must match exactly. Running hours within 3% pass silently; otherwise the note says why (usually run times that vary through the day).
8. **Undo.** The whole copy is one undo step (`App.undo.batch`).

**Packages:**

- **A3.1 [O]** Card pass, including menu placement (the Layers panel is Opus-only) and the stop-recognition approach.
- **A3.2 [H]** A pure band converter and run-time function in the engine, with golden cases.
- **A3.3 [S]** Apply the copies (bands, run time, stops) and the reconciliation note.
- **A3.4 [O]** Menu wiring in `js/core/layers-panel.js` and the right-click menu.
- **A3.5 [O]** Review:
  - run Route Costing, Coverage and Travelshed on a copied route of each fixture type;
  - extend `test/gtfs-browser-smoke.mjs` with new checks, without changing existing ones;
  - screenshots.

**Docs:** `docs/reference/modules/gtfs.md`, `docs/reference/modules/route-costing.md` (copied Services) and `docs/reference/modules/trip-builder.md`.

### A4 — Feed overview and click-for-details

*Sub-plan required (3.3).*

**Must deliver:**

- **Feed overview.** The GTFS popup opens on an overview instead of the file list:
  - agency, service date range and days until the feed expires;
  - day types with trips per day;
  - route, stop and trip counts;
  - the day-to-analyze control;
  - a place for A7's health flags.

  The raw files stay available as a tab.
- **Stop details.** Clicking a GTFS stop shows tabs:
  - **Details:** all stop fields.
  - **Trips:** departures on the analysis date, sortable by time or route; departure or arrival; trips per day; span; peak and off-peak headway; a "show hidden routes" switch.
  - **Coverage:** distance to adjacent stops on each route, and ¼ / ½ mi population, households and workers by the A1 method, with equity shares compared to the county. This tab may move to A6 if the census work needs more; the sub-plan decides.
- **Route details.** Clicking a GTFS route shows Details / Stops / Schedule (trips by pattern and day, span, headway by day part). A Cost tab is added once A5 exists.
- Schedule-only figures update instantly (G4b).

**Draft gates** (the sub-plan finalises them):

**Gate G4a — Where details appear**
Question: When you click a GTFS stop or route, where should its details open?
- Option A (recommended): in the left details panel, the same one that opens when you click a drawn feature.
- Option B: in a popup on the map.
- Option C: in a floating panel like the analysis modules.
Example: clicking stop 24223 opens its Details / Trips / Coverage tabs on the left, while the map and any open analysis stay visible.
What changes: A keeps one habit ("click something, read its details on the left"). B has little room for tabs and covers the map. C competes with an open analysis for space.
If you say "your call": Option A.

**Gate G4b — Instant results**
Question: Should figures that come only from the schedule (trip counts, headways, spacing, cost) update instantly when you change the date, rates or hidden routes, with no Run button?
- Option A (recommended): yes. Analyses that call the Census or the street network keep their Run button.
- Option B: keep a Run button everywhere.
Example: switching the analysis day from Weekday to Saturday immediately refreshes the stop's departures and the route's span.
What changes: under A, a project rule changes for these panels only (`CLAUDE.md` "Standardized module state"), and they never show a "results are out of date" banner because they never are.
If you say "your call": Option A.

**Gate G4c — Peak and off-peak definition**
Question: Which hours count as peak and off-peak when we report headways?
- Option A (recommended): the same editable parts of the day used by copied Services (A3).
- Option B: fixed windows: peak 6–9 AM and 3–6 PM, off-peak 10 AM–2 PM.
Example: an agency whose PM peak runs 4–7 PM can set it once under A, and every report follows.
What changes: one setting controls copied bands and all headway reports under A.
If you say "your call": Option A.

**Questions the sub-plan must answer:**
- How the new details coexist with today's GTFS hover and click popup, the right-click copy menu, box select and the stop-selection badge.
- How the attributes dock's invariants (`CLAUDE.md`: follows selection, gesture-only opening, Escape handling, closing before deletes) apply to a read-only GTFS view.
- How to keep the Trips tab fast for stops with 2,000+ departures per day.
- Dark mode, narrow widths, keyboard use, and the screenshot set.

**Opus-only:** map click ownership, the attributes dock, map layers.

### A5 — GTFS service and cost summary; Stop Analysis

*Sub-plan required.*

**Must deliver:**

- **Service and cost**, per route and for the system:
  - trips; running, revenue and platform hours (D6); span; service days; peak vehicles (D7);
  - cost by the chosen rate basis, with per-route rate overrides;
  - weekly and annual totals (G5a);
  - CSV export;
  - a sortable, searchable table with rows that expand by day type, not one card per route (F18);
  - a short "how this is computed" note.
- **Stop Analysis:**
  - **Spacing distribution:** five labelled bands with editable thresholds (defaults 600 / 750 / 1,320 / 2,640 ft); median, mean, 10th and 90th percentile; per-route medians on the dominant pattern.
  - **Consolidation candidates:** per G5d.
  - **Service per stop:** trips per day, span, peak and off-peak headway, plus a colour ramp on the map.
  - **Wheelchair data completeness:** by route.
  - Map highlighting of findings; CSV per section; collapsible sections with a one-line result in each header (F17).
- **Scope:** hidden routes (D9), the analysis date, and the stop selection list as an optional filter.
- **Cross-check:** on a Service copied in A3, Route Costing and the GTFS summary agree within the documented tolerance, with an explanation of the difference.

**Draft gates:**

**Gate G5a — Turning one day into a year**
Question: How should we turn one day's service into yearly totals?
- Option A (recommended): annual day counts per day type, for example 254 weekdays, 52 Saturdays and 59 Sundays/holidays. This is the same kind of setting Route Costing and the Costing tool use.
- Option B: count the dates in the feed's calendar and scale to a year.
Example: a feed covering January–June has about 129 weekdays; Option B scales that to about 260, minus any holidays the feed codes.
What changes: A matches your other tools and budgets. B reflects holidays coded in the feed, but varies with how long the feed's calendar runs. B is shown under A as a cross-check.
If you say "your call": Option A.

**Gate G5b — Where these reports live**
Question: Where should the GTFS service, cost and stop reports appear?
- Option A (recommended): one new analysis, "GTFS Service Analysis", with tabs: Service & Cost, Stops, and later Compare and Feed health.
- Option B: separate entries in the Analysis menu.
Example: under A, one menu entry opens one panel; tabs switch reports and keep your settings.
What changes: A follows the tabbed layout already used by Ridership Forecasting, FTA and Title VI.
If you say "your call": Option A.

**Gate G5c — Layover when the feed has no vehicle blocks**
Question: Most feeds don't say which trips each bus runs. What layover should revenue and platform hours assume then?
- Option A (recommended): use the feed's vehicle blocks when present; otherwise the same layover setting as Route Costing (for example 10%). Label which was used.
- Option B: always use the Route Costing setting.
Example: a route with 100 running hours shows 110 revenue hours at 10% layover.
What changes: A uses real layover where the feed provides it.
If you say "your call": Option A.

**Gate G5d — Time saved by removing a stop**
Question: How should we estimate time saved by removing a stop?
- Option A (recommended): editable seconds per removed stop (default 20) × trips per day, labelled "upper bound: assumes every trip stops there", plus the extra walking distance for riders of the removed stop.
- Option B: GTFS·X's version, the same calculation without the label or walking distance.
Example: removing a stop served by 100 trips per day saves up to about 33 vehicle-minutes per day, while its riders walk up to 550 ft further.
What changes: A shows both sides of the trade-off.
If you say "your call": Option A.

**Questions for the sub-plan:**
- table design for 130+ routes;
- how per-route rate overrides are saved;
- map highlight layers (Opus-only);
- CSV formats;
- performance with 7,500 stops.

**GTFS·X reference pages:** `cost-estimation`, `service-summary`, `stop-analysis` (Appendix A; methods only, D1).

### A6 — Coverage, Title VI equity and travel times on real schedules

*Sub-plan required. Expect the sub-plan to split this into A6a, A6b and A6c.*

**Must deliver:**

- **A6a — Analysis network and coverage.**
  - Move Trip Builder's trip generator into a pure engine function (Trip Builder keeps calling it), extended to produce stop times at drawn stops by distance along the line. These "synthetic trips" merge with GTFS trips into one network for the analysis date.
  - Transit Coverage and Feature Area Analysis accept GTFS stops and routes: stop buffers by mode (¼ mi bus, ½ mi rail, editable) and peak headway from the schedule.
  - Street-distance coverage for whole systems by a multi-origin flood (F12), with a spatial index for snapping stops to the network.
- **A6b — Title VI.**
  - Add the service-equity test: trips per capita, minority vs non-minority, four-fifths banding, and the same for low income.
  - Apportion trips to people with the A1 block weighting.
  - Policy settings for the low-income definition (G6a) and the frequent-stop buffer rule (G6d).
  - Fill revenue-hours % and span % for alterations automatically when before and after feeds exist.
- **A6c — Travel times.**
  - A pure RAPTOR engine over the analysis network (golden-tested), with walk access, egress and transfers on the existing street network.
  - Results summarised over a departure window (G6b), drawn with the existing contour tools.
  - Drawn proposals included per G6c.

**Draft gates:**

**Gate G6a — Who counts as low-income in Title VI**
Question: Which low-income definition should the Title VI analyses use?
- Option A (recommended): make it a policy setting, defaulting to "below poverty" (today).
- Option B: switch the default to "below 200% of poverty" (GTFS·X and many agencies).
Example: B classifies roughly twice as many people as low-income, which can change disproportionate-burden findings.
What changes: A leaves existing analyses unchanged. Choose B in settings if your adopted Title VI program uses it.
If you say "your call": Option A.

**Gate G6b — One departure time or a time window for travel times**
Question: Should transit travel times be measured for one departure time or summarised across a time window?
- Option A (recommended): a window, for example 7:00–8:00, showing the typical (median) reach, with best- and worst-case reach available.
- Option B: one departure time.
Example: leaving at 7:58 vs 8:02 can mean just catching or just missing a 30-minute bus. Under B, the map changes a lot between the two.
What changes: A takes longer to compute (many runs), but results don't jump with the departure minute.
If you say "your call": Option A, with the window editable.

**Gate G6c — Proposals mixed into the real network**
Question: Should drawn proposed routes be added to the real GTFS network in the same coverage, equity and travel-time runs?
- Option A (recommended): yes. Proposals run on evenly spaced trips built from their headway bands.
- Option B: analyse GTFS and drawn routes separately.
Example: under A, "a new crosstown route plus today's network" shows the jobs reachable in 45 minutes from a neighbourhood.
What changes: under A, proposals inherit an even-headway assumption, which results note.
If you say "your call": Option A.

**Gate G6d — Wider buffer for frequent stops in the equity test**
Question: Should stops with very frequent peak service draw riders from farther away in the service-equity test?
- Option A (recommended): use your Title VI policy's buffer for every stop, with an optional switch that uses ½ mile for stops with peak service every 15 minutes or better.
- Option B: always apply the ½-mile rule for frequent stops.
Example: a 10-minute corridor's stops would serve block groups up to ½ mile away instead of ¼ mile.
What changes: the switch can raise service figures for areas near frequent corridors.
If you say "your call": Option A, with the switch off.

**Questions for the sub-plan:**
- RAPTOR round limit and transfer walking (reuse the travelshed walk caps).
- Departure sampling interval and percentiles.
- Performance targets.
- Where the service-equity test sits in the Title VI panel.
- The multi-origin flood interface in `js/core/road-network.js` (Opus-only shared core).
- Whether the changed-routes workflow for Title VI belongs here or in A7.

**GTFS·X reference pages:** `access-isochrones`, `title-vi-analysis`, `demographic-coverage`.

### A7 — Build vs No-Build comparison and feed health

*Sub-plan required.*

**Must deliver:**

- **Comparison table** between two feeds:
  - change in trips, running / revenue / platform hours, peak vehicles and cost;
  - residents, jobs and census blocks within reach;
  - per-route changes (added, removed, changed);
  - CSV export.
- **Title VI changed-routes workflow,** if not done in A6: list the routes changed between the feeds, pre-check them against the major-change policy, and let the user confirm before the equity analysis.
- **Feed health:** read-only flags, each with a count and examples:
  - expiry;
  - missing shapes;
  - stops without wheelchair data;
  - impossible speeds between stops;
  - stops far from their shape;
  - non-increasing times;
  - missing `agency_id` (relevant to FTA's NTD reporting).

**Draft gates:**

**Gate G7a — What can be compared**
Question: What should the comparison table compare?
- Option A (recommended): two GTFS feeds, for example the current feed and a proposed feed from the agency or another scheduling tool. Drawn proposals are covered by mixing them into a run (G6c).
- Option B: also compare the feed with your edited copies of its routes.
Example: No-Build = today's RTD feed; Build = next service change's draft feed with routes 120 and 121 restructured.
What changes: A is simpler and holds only one feed's details in memory at a time.
If you say "your call": Option A.

**Gate G7b — Which health checks**
Question: Which feed health checks should the app run?
- Option A (recommended): the seven checks listed above.
- Option B: the list with changes. Name any to drop or add.
Example: "12 stops sit more than 150 m from their route's shape" or "feed expires in 9 days".
What changes: checks are read-only flags. They never change the feed or block an analysis.
If you say "your call": Option A.

**Questions for the sub-plan:**
- How to match routes between feeds (`route_id`, then short name).
- How to keep the second feed's summary without both full schedules in memory.
- Where speed and distance thresholds come from. Cite the MobilityData GTFS validator documentation directly rather than GTFS·X (D1).

### A8 — Export drawn Services as GTFS

*Sub-plan required.*

**Must deliver:**

- A valid GTFS ZIP from selected drawn Services:
  - agency details entered in an export dialog;
  - stops from associated Points (or generated at a stated spacing when none exist);
  - routes;
  - trips and stop times from the A6 synthetic-trip engine;
  - shapes from the drawn lines;
  - a calendar from a chosen date range;
  - optionally `frequencies.txt` (G8b).
- **Verification:** the export loads back into the Analysis app and passes the MobilityData GTFS validator with no errors (the user runs the validator; the sub-plan says how).
- **Readiness for the later Costing tool plan:** the export is standard GTFS with nothing specific to this app, because the Costing tool's importer (phase C5 of `docs/gtfs-costing-tool-plan.md`) will read it later. The A8 planner may **read** the Costing tool repository (`docs/data-schema.md`, Decisions 0058, 0079, 0085 and 0086) to check that the export carries what that importer will need. It must not change that repository (D14).
- **Hand-off note:** the closing progress-log entry records the exact file and column set the export writes, and how bands become `frequencies.txt`. This is the contract the Costing tool plan starts from.

**Draft gates:**

**Gate G8a — Trip Builder's future**
Question: Once the GTFS export exists, what should happen to the Trip Builder panel?
- Option A (recommended): retire the panel. Its trip generator lives on inside the export and the travel-time analyses.
- Option B: keep it as is.
- Option C: fold a short schedule preview into the Service editor.
Example: today Trip Builder lists start and end times per direction that no other module uses.
What changes: A removes a menu entry. Saved Trip Builder results in old sessions would no longer be shown.
If you say "your call": Option A, once the export has passed its verification.

**Gate G8b — Headway bands in the export**
Question: Should exported Services also include their headway bands as GTFS frequency windows?
- Option A (recommended): yes, alongside the individual trips, so a scheduling tool (including the Costing tool, later) can turn them back into planned headways.
- Option B: trips only.
Example: "Weekday 06:00–09:00 every 12 min" travels with the file.
What changes: A keeps your planning intent intact through the handoff.
If you say "your call": Option A.

---

## Part 6 — Costing tool work (separate plan)

Moved to `docs/gtfs-costing-tool-plan.md` at the user's request (2026-11-20). That plan starts only after every phase of this plan is closed, and its work happens only in the Costing tool repository. Nothing under this plan changes that repository (D14).

## Part 7 — Round trip between the apps (separate plan)

The round trip (sketch here → schedule and cost in the Costing tool → analysis here) is phase J1 of `docs/gtfs-costing-tool-plan.md`. This plan's part of it is A8: a standard GTFS export of drawn Services.

---

## Part 8 — Gate register

Each gate is answered in its phase section. Record answers here and in the progress log.

| Gate | Phase | Question (short) | Recommendation | Answer | Date |
|---|---|---|---|---|---|
| G0a | A0 | Approve plan; never copy GTFS·X code | Approve | Approved (Option A) | 2026-11-21 |
| G0b | A0 | Real feeds for testing | RTD + one small feed | "Your call": RTD + BART (small) | 2026-11-21 |
| G1a | A1 | Count people by area or by 2020 blocks | Blocks for new runs | Blocks for new runs (Option B) | 2026-11-21 |
| G1b | A1 | Coverage from stops or line | Stops when present | Stops when present (Option A) | 2026-11-21 |
| G1c | A1 | Route Costing rate basis | Keep platform default, add revenue | Revenue-hour default (Option B) | 2026-11-21 |
| G2a | A2 | GTFS inside session files | Original ZIP | Original ZIP (Option A) | 2026-11-21 |
| G2b | A2 | Choosing the day to analyze | Day type → typical date, changeable | Exact date always (Option B) | 2026-11-21 |
| G3a | A3 | Detail of copied headway bands | Standard day parts | Standard day parts (Option A) | 2026-11-21 |
| G3b | A3 | Copy stops too | Yes, up to 5 routes | Yes, up to 5 routes (Option A) | 2026-11-21 |
| G4a | A4 | Where details appear | Left details panel | Left details panel (Option A) | 2026-11-21 |
| G4b | A4 | Instant results for schedule-only figures | Yes | Yes (Option A) | 2026-11-21 |
| G4c | A4 | Peak / off-peak definition | Shared editable day parts | Shared editable day parts (Option A) | 2026-11-21 |
| G5a | A5 | One day → a year | Annual day counts | | |
| G5b | A5 | Where reports live | One tabbed analysis | | |
| G5c | A5 | Layover without vehicle blocks | Blocks if present, else setting | | |
| G5d | A5 | Time saved by removing a stop | Labelled upper bound + walk distance | | |
| G6a | A6 | Low-income definition | Setting, default below poverty | | |
| G6b | A6 | Departure time or window | Window | | |
| G6c | A6 | Mix proposals into real network | Yes | | |
| G6d | A6 | Wider buffer for frequent stops | Optional, off | | |
| G7a | A7 | What can be compared | Two feeds | | |
| G7b | A7 | Which health checks | Listed set | | |
| G8a | A8 | Trip Builder's future | Retire once the export works | | |
| G8b | A8 | Headway bands in exports | Yes | | |

---

## Part 9 — Risks and watch-outs

1. **Large feeds.** Memory and page freezes are the main technical risk. A0 measures, A2 sets the targets, and every later phase re-checks them on the RTD-size feed.
2. **Opening from disk (D11).** Background threads often fail when `index.html` is opened directly. Every such feature needs a working fallback, tested both ways.
3. **Census service limits.** Block queries are heavier than today's block-group queries. Cache per session, show progress, and fall back visibly (A1), never silently.
4. **Surprising number changes (D13).** Every default change is gated, saved sessions keep their method, and outputs name it.
5. **Licensing (D1).** Reviews check that no GTFS·X code, data or text has entered either repository. Methods are cited by documentation page only.
6. **Scope creep into GTFS editing (1.6).** The Analysis app reads GTFS; it does not become an editor.
7. **Touching the Costing tool by accident (D14).** Agents see both repositories in some sessions. Cards name only this repository's files, and every review gate checks that the Costing tool repository has no changes from the package.
8. **Project rules in `CLAUDE.md`.**
   - Attribute changes must update the dock and Attribute Summary together.
   - Drawn points and lines render in several map layers, so never use their layer ids literally.
   - The Opus-only areas.
   - Cards must name the rule when they come near one.
9. **Network-dependent tests.** Use the stubs in `test/stubs/` and fixtures, not live services, in automated tests.

---

## Appendix A — Reference pages

**GTFS·X documentation (methods only, D1):** <https://www.gtfsx.com/docs/>, then the page name:

| Page | Topic |
|---|---|
| `cost-estimation` | Operating cost |
| `service-summary` | Service summary |
| `service-planning` | Headway generation, blocks Gantt, variants |
| `scenario-analysis` | Route visibility |
| `stop-analysis` | Stop analysis |
| `demographic-coverage` | Coverage |
| `title-vi-analysis` | Title VI ratio |
| `access-isochrones` | RAPTOR isochrones |
| `rider-propensity` | Propensity vs need |
| `shapes-from-stops` | Generating shapes |
| `validation` | Validation |
| `import-and-export` | Import and export |
| `timetables-and-trips` | Timetables and frequencies |

**Analysis app references:**
- `docs/reference/modules/gtfs.md`
- `route-costing.md`, `trip-builder.md`, `transit-coverage.md`, `transit-travelshed.md`, `title-vi.md`, `walkshed.md`
- `docs/reference/road-network.md`, `docs/reference/core-app.md`

**Costing tool references (read-only, A8 only; D14):**
- `docs/data-schema.md`
- Decisions 0058, 0079, 0085, 0086
- The separate plan: `docs/gtfs-costing-tool-plan.md` (in this repository)

**Outside standards:**
- GTFS Schedule reference: <https://gtfs.org/documentation/schedule/reference/>
- MobilityData GTFS validator rules: <https://gtfs-validator.mobilitydata.org/rules.html>
- FTA Circular 4702.1B

---

## Progress log

### 2026-11-20 — Plan written (Opus)

- Wrote this plan from the GTFS·X review.
- Added a pointer entry, "GTFS interoperability", to the Costing tool's `docs/backlog.md`.
- No code changed in either repository.

**Hand-off:** next step is Gate G0 (a–c) with the user, then phase A0.

### 2026-11-20 — Costing tool work split out (Opus)

- At the user's request, the Costing tool phases (C1–C5), the round trip (J1), their gates and gate G0c moved to a separate plan, `docs/gtfs-costing-tool-plan.md`. That plan starts only after this one is complete.
- D14 now forbids any change to the Costing tool repository under this plan.
- The backlog pointer added earlier today was reverted on the Costing tool branch `claude/friendly-brahmagupta-51rk4t` (commit `80d8917`). That branch now matches its `main` and needs no merge.
- A8 gained a read-only compatibility check and a hand-off note that defines the export the later plan starts from.

**Hand-off:** next step is Gate G0 (a–b) with the user, then phase A0.

### 2026-11-21 — A0 Setup and baselines (Opus orchestrating)

- **Gates:** G0a approved (Option A). G0b "your call": RTD (`rtd-denver.com/files/gtfs/google_transit.zip`, 10.8 MB ZIP) as the large feed; BART (`bart.gov/dev/schedules/google_transit.zip`, 1.0 MB) as the small one, since the Summit Stage and Santa Fe links tried were dead. Neither feed is committed.
- **A0.1 [Opus]:** `test/fixtures/gtfs/mini/` (9 files) and `EXPECTED.md`. Answers worked by hand for 2026-01-12, -19, -24 and -30. `EXPECTED.md` fixes nine counting conventions A2 must adopt or deliberately change; it includes the mixed-block rule (unblocked trips count as their own block) and a 10-minute sweep layover.
- **Independent check [Haiku, high]:** recomputed every answer from the raw files with its own parser, without seeing `EXPECTED.md`. All values agree, for all four dates and the whole-feed items. Haiku's notes for A2:
  - "last departure" means the latest trip start;
  - interpolated times round to whole seconds;
  - an invalid trip is reported only on dates its service runs.
- **A0.2 [Sonnet, deviation: plan said Opus]:** `test/perf/gtfs-baseline.mjs` + `test/perf/README.md`. Opus reviewed the script and re-ran it twice on RTD; the results repeat within 10%.

**Baseline, current code (headless Chromium in the cloud container):**

| Feed | Rows (stop_times) | Parse | To map | Longest freeze | Heap growth | GTFS part of session |
|---|---|---|---|---|---|---|
| BART | 76,409 | 0.4 s | 0.7 s | 0.10 s | 23 MB | 22 M chars |
| RTD | 814,413 | 3.0 s | 4.0–4.4 s | **1.41–1.47 s** | **210 MB** | **240 M chars** |

**Targets for A2 (an RTD-sized feed on a typical laptop):**

- Load time: the current 4 s is already inside the 15 s target, so A2 must not get slower; ≤ 15 s stays the ceiling for laptops slower than this container.
- Freezes: the current 1.4 s blocks the page, so the ≤ 250 ms target is the main work.
- Memory: ≤ 100 MB, against 210 MB now.
- Sessions: the 240 M-character GTFS part already exceeds the app's 50 MB "Continue?" prompt in `exportFullState`. This confirms that G2a (store the original ZIP in sessions) is needed.

**Hand-off:**

- Mini feed path: `test/fixtures/gtfs/mini/`.
- Baseline command: `NODE_PATH=/opt/node-tools/node_modules node test/perf/gtfs-baseline.mjs <zip> [--runs N]`. Its final line is `RESULT {json}`, with fields `parseMs`, `toMapMs`, `longestFreezeMs`, `heapDeltaMB` and `gtfsSessionChars`.

### 2026-11-21 — A1 Quick wins (Opus orchestrating)

**Gates:**
- G1a: census blocks for new runs.
- G1b: coverage from stops when present.
- G1c: **revenue-hour default** (Option B, not the recommendation). The engine's default is still platform, so golden values and old sessions keep platform. New work starts on revenue.

**Packages, in commit order:**

| Package | Model | Commit | What it delivered |
|---|---|---|---|
| A1.2 | Haiku, high | `dab9868` | `window.Apportion` engine, 20 golden cases |
| A1.3 | Sonnet | `f2a6df1` | Census block fetch and shared method helper, browser test `apportion-fetch` (7 checks) |
| A1.6 | Sonnet | `f92113c` | Coverage measured from stops |
| A1.4c | Sonnet | `cff9dc8` | Coverage apportionment |
| A1.4a | Sonnet, plus an Opus fix | `8c1cc6a` | Feature Area Analysis and Title VI |
| A1.4b | Sonnet | `68d1852` | TPI, Ridership Forecasting and Corridor Scoring |
| A1.5 | Sonnet | this commit's parent | Route Costing |

**Deviations:**
- A1.1, the card pass, was done by Opus inline; no separate document.
- A1.4 was split three ways so the parts could run in parallel on separate files.
- Opus fix in Title VI: an analysis is refused when its baseline was counted by a different method (older baselines count as land area).
- TPI-family modules still default "Apportion to buffer" to **off**. The new block-population method applies only when that box is on, because turning apportionment on by default would change scores beyond G1a.
- There are no golden cases for `App.associatedStopPoints` or `App.buildStopCircleUnion`, because they depend on `App` and turf; a browser test covers them indirectly. Transit Travelshed still has its own copy of the stop lookup; moving it to the shared helper is left for later (an Opus-only refactor).
- The existing Route Costing golden entries gained new keys. No values changed.
- Browser tests run by several agents at once were flaky (shared ports and timeouts). Run one file at a time after A1, every browser test file passes.

**Hand-off:**
- `App.computeApportionFractions(union, geos, method, {onProgress})` returns `{fractions: Map, method, methodUsed, basis, note, blockCount}`. Pass the fractions to `App.aggregateWithinUnion(..., {fractions})`.
- Related names: `App.APPORTION_DEFAULT = "blockPop"`, `App.apportionMethodFromLegacy(bool)` and `Apportion.methodLabel(m)`.
- `App.associatedStopPoints(type, feature, {includeHidden})` and `App.buildStopCircleUnion(points, miles)`.
- Route Costing: `settings.rateBasis` and `_rateOverrides` (saved as `rateOverrides`, state v4). Per-day `revenueHrs`, plus `dailyRevenueHrs` and `annualRevenueHrs`. Test hooks: `App._rcTest.sanitizeRate` and `effectiveRate`.

### 2026-11-21 — A2 GTFS schedule engine (Opus orchestrating)

**Gates:**
- G2a: the original ZIP goes in session files.
- G2b: always an exact date (not the recommendation). The control starts on the feed's busiest weekday, shown as an exact date, and the user can pick any date in the feed's range. There is no day-type picker.

**Tasks:**
- A2.1 card pass [Opus]. Deviation: A2.2–A2.5 went to one Sonnet card instead of three Haiku cards plus one Sonnet card. They share one new file, and the CSV reader, store and queries depend on each other.
- A2.2–A2.5 engine [Sonnet]: `js/core/gtfs-schedule.js`, with 115 golden cases (`test/cases/gtfs-schedule.mjs`). Every value in `EXPECTED.md` reproduced, and the 10-minute sweep layover is kept as the default. Opus fixes after review:
  - `busiestDate` returns null when no day of that type has service.
  - Frequency runs from a template with a `block_id` each count as their own vehicle.
  - A bad duplicate calendar row no longer deletes the valid row before it.
  - Two golden cases were added for these.
- A2.7a synthetic feed [Haiku]: `test/perf/make-synthetic-feed.mjs` (deterministic; about 835 k stop_times rows at scale 1). Headway was widened to 20–60 min to hit the row target.
- A2.6 loader integration [Opus]:
  - The parse uses `CsvStream` in slices that yield to the page.
  - stop_times is kept only in the columnar store.
  - shapes are grouped while parsing, keeping a 500-row preview.
  - Session export writes `gtfsZip` and falls back to `gtfsData` for a feed that came from an old session file.
  - Old session files still open.
  - Day to analyze control and API; table viewer reads from the store.
- A2.7b browser test [Sonnet]: `test/browser/gtfs-schedule.test.mjs`, 16 checks: mini feed, date API and panel, refresh, ZIP round trip, old format, `importFullState`, clear, and the synthetic feed's responsiveness.
- A2.8 review [Opus]: `code-review` at high found 8 issues, all fixed directly:
  - session date lost when a feed was already loaded;
  - old-format feed dropped on re-save;
  - frequency block peaks;
  - dates outside the feed's range accepted;
  - damaged base64 showing the wrong error;
  - a stale session date applied to a fresh upload;
  - `notifyProject` firing before the ZIP feed loaded;
  - calendar duplicate rows.

  The review also found 1 problem in A1 code, fixed here: the block-method label and medians note in Feature Area Analysis said "population-weighted" but the weights are each geography's share of its residents inside.
- Background thread (D11): not built. The main thread meets the targets.

**Performance** (this container, `test/perf/gtfs-baseline.mjs`):

| Feed | Load to map | Longest freeze | Heap growth | GTFS part of session |
|---|---|---|---|---|
| RTD, before | 4.0–4.4 s | 1.41–1.47 s | 210 MB | 240 M chars |
| RTD, after | 3.0–3.3 s | 0.22 s | 69 MB | 14.4 M chars |
| Synthetic (scale 1), after | 2.2 s | 0.19–0.24 s | 47 MB | 6.5 M chars |
| BART, after | 0.6 s | 0 | 12 MB | 1.4 M chars |

All A0 targets are met: load ≤ 15 s, freeze ≤ 250 ms, memory ≤ 100 MB. The freeze margin is thin, about 30 ms. The remaining long tasks are `StopTimesBuilder.finish`/`buildFeed` and the MapLibre source build. Later phases must re-check against it.

**Hand-off:**
- `window.GtfsSchedule`: see `docs/reference/modules/gtfs.md` § "Schedule engine and day to analyze" for the full list. The key calls are `tripsOnDate(feed, date, {routeIds})`, `routeDaySummary(feed, date)`, `peakVehicles(feed, date, {layoverSec})`, `patterns`/`dominantPattern(feed, date, routeId, dir)`, `departuresAtStop`, `medianHeadway` and `tripStopTimes(feed, tripId, {interpolate})`.
- Runtime: `App.gtfsSchedule()` returns the feed or null. The date API is `App.gtfsAnalysisDate.get()`, `.set("YYYYMMDD")`, which rejects dates outside the feed's range, and `.onChange(fn)`, which returns an unsubscribe function and fires with null on clear.
- `_gtfsData` entries for `stop_times.txt` and `shapes.txt` are `columnar` with `rows: null`. Code reading `.rows` must handle that.
- Session format: `state.gtfsZip = {name, base64}`, or the legacy `state.gtfsData`. `App.serializeGTFSZip()` returns a Promise; `App.restoreGTFSFromZip(payload)` re-loads the ZIP like an upload.
- Hidden routes are not yet applied to schedule queries (D9). A4–A6 must filter with `tripsOnDate(..., {routeIds})` using `App.gtfsHiddenState()`.

### A3 — 2026-11-21

Gates: G3a standard day parts; G3b copy stops (up to 5 routes; the UI copies one route at a time, so no confirmation prompt is needed yet).

- A3.1 card pass [Opus]:
  - Stop recognition: an existing Point whose `stopId` equals the GTFS stop_id and lies within 2 m is reused (no new attribute field).
  - Menus: the new label appears only when the feed has a timetable for the route, so feeds without one (and the existing smoke test) keep the old menus.
  - The note shows in a closable notice over the map.
- A3.2 band converter [Haiku]: `DEFAULT_DAY_PARTS`, `bandTripCount`, `headwayBands`, `meanTripMinutes`, `bandsEqual` in `js/core/gtfs-schedule.js`; 23 golden cases, incl. a random test of 1,006 bands with 0 trip-count mismatches.
- A3.3 apply copies [Sonnet]: `serviceCopyPlan`, `reconciliationNote`; `App.gtfsHasSchedule`, the schedule path of `App.gtfsCopy`, stop Points; 12 golden cases; `test/browser/gtfs-copy-service.test.mjs` (16 checks).
- A3.4 menus [Opus]: Layers-tab route menu and map right-click; `App.gtfsShowCopyNote`.
- A3.5 review [Opus]:
  - Route Costing skipped the copy in its default speed mode ("missing Avg speed"). Fixed: copies get Avg speed = shape length ÷ run time (deviation from "average speed left blank"; it gives the same one-way time). On the mini feed Route B1 now costs with 6 weekday trips and 2.0 running hours, matching the timetable.
  - Transit Coverage and Transit Travelshed list the copied lines with no setup.
  - Note day names capitalised (golden note cases re-recorded; no numbers moved).
  - `test/gtfs-stop-select-smoke.mjs` fails 5 drag-select checks in this container both with and without A3 changes (pre-existing, not caused by A3).

**Hand-off:**
- Day parts are `GtfsSchedule.DEFAULT_DAY_PARTS`; `headwayBands` and `serviceCopyPlan` take a `dayParts` argument, so A4 (G4c) can make them an editable setting.
- Copies use one date per day type (analysis date if it is an ordinary day of that type, else the busiest such date).

### A4 — 2026-11-21

Gates: G4a left details panel; G4b instant results; G4c the shared, editable parts of the day.

- Sub-plan [Opus]: `docs/archive/A4-plan.md`. Shape decision: the stop **Coverage** tab's Census figures (¼ / ½ mi population, households, workers, equity shares) move to A6, which builds the block method on real schedules; A4 ships the schedule-only part as a **Spacing** tab. The phase text allowed the sub-plan to decide this.
- A4.1 engine [Haiku, xhigh]: `stopDepartures`, `stopSummary`, `stopSpacing`, `routeSchedule`, `feedOverview`; 21 golden cases (`a4-*`), all hand-checked against the mini fixture, no existing value changed. Card was precise enough for Haiku to succeed first time.
- A4.2 dock view and click ownership [Opus]: `App.openDockView` / `refreshDockView` / `getDockViewKey` in `feature-attributes.js`; `editing.js` asks `App.gtfsPickAt` when no drawn feature is under a click; the MapLibre click popup is removed (hover tooltip and right-click menu stay); `App.gtfsDayParts`; instant redraws.
- A4.3 tabs, Overview and test [Sonnet]: Trips / Spacing / Stops / Schedule tabs, Overview + Files tabs in the GTFS panel with the day-parts editor, `test/browser/gtfs-details.test.mjs` (19 checks). `test/browser/gtfs-schedule.test.mjs` gained one click on the new Files tab (deliberate UI change, by Opus).
- A4.4 review [Opus]: `code-review` at high, 10 findings, all fixed directly: routes without shapes dropped from stop figures when any route was hidden; day-part inputs lost focus mid-edit; a route view's swatch repainted by type-colour changes; GTFS clicks in presentation mode (now skipped); unassigned shapes showed no shape id or highlight; session restore didn't redraw for restored day parts; Copy as Point at 0,0 for stops without coordinates; a dead `routes.txt` fallback; per-redraw feed-wide accessibility scan; panel tabs now follow the `[data-tab]` + `switchTab` convention.
- Performance (RTD, busiest stop 17717, 713 departures): open 8 ms, Trips 27 ms, Show all 36 ms, Spacing 35 ms, route Schedule 12 ms, date change redraw 22 ms.

**Hand-off:**
- Engine: `GtfsSchedule.stopDepartures(feed, date, stopId, {routeIds})`, `stopSummary(feed, date, stopId, {routeIds, dayParts})`, `stopSpacing(feed, date, stopId, {routeIds})`, `routeSchedule(feed, date, routeId, {dayParts})`, `feedOverview(feed, {today, dates})`. Peak = parts `am`+`pm`, off-peak = `midday`.
- Day parts: `App.gtfsDayParts.get()/set(starts)/reset()/isDefault()`; session key `gtfs-browse.dayParts`.
- Details: `App.gtfsOpenDetails({kind:"stop", stopId} | {kind:"route", routeId, shapeId})`; private tab lists `_stopTabs` / `_routeTabs` in `gtfs.js` take `{id, label, render(el, id, state, refresh)}` — A5 adds the route Cost tab by pushing onto `_routeTabs`; A6 adds the stop Coverage tab to `_stopTabs`.
- Hidden routes: private `scheduleRouteIds(includeHidden)` gives the `routeIds` filter (null = all).
- `#gtfsHealth` in the Overview is reserved for A7's feed-health flags.

