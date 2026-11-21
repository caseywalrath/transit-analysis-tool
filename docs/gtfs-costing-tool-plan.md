# Transit Costing Tool: GTFS interoperability — deferred plan

> **Status:** Deferred (2026-11-20). **Do not start** until the Analysis app plan (`docs/gtfs-expansion-plan.md`) is complete and the user confirms the start at Gate G-C0a (1.1). No work under this plan has begun.
>
> **Where the work happens:** only in `caseywalrath/transit-costing-tool` (the **Costing tool**). This file waits in the `caseywalrath/transit-analysis-tool` repository (the **Analysis app**) until the work starts. Nothing in it authorizes a change to either repository before then.
>
> **Companion plan:** `docs/gtfs-expansion-plan.md` (Analysis app). It holds the GTFS·X findings (its Part 1) and the fixed decisions D1–D13, which this plan inherits (Part 3).

**Read this whole document before starting.** Also read Parts 1–2 and the whole progress log of the companion plan, which by then will be in `docs/archive/`.

---

## Summary

The Costing tool gains GTFS in both directions:

- **Export (C1, C2):** its schedules (trips, stop times, blocks) become GTFS, so the Analysis app can analyse them: coverage, Title VI, travel times, and comparison with the current network.
- **Import (C5):** an agency's GTFS routes become a baseline to schedule, block and cost.
- **New views (C3):** scenario comparison, a blocks timeline and a Marey chart.
- **Interlining (C4):** auto-blocking across routes, with deadhead times estimated from stored locations.
- **Round trip (J1):** sketch in the Analysis app → schedule, block and cost here → analyse back in the Analysis app.

**Why this plan is separate.** On 2026-11-20 the user decided that Costing tool work happens completely separately, and only after the Analysis app work is finished. By then the Analysis app:

- reads GTFS for any date (companion phase A2);
- analyses it (A4–A7);
- exports drawn sketches as GTFS (A8).

Those are this plan's inputs.

---

## Part 1 — Starting this plan

### 1.1 Start conditions

All of these must hold before any work begins:

1. **The Analysis app plan is complete:**
   - every phase A0–A8 is closed, or descoped with the user's agreement;
   - its progress log has a closing entry;
   - the plan has moved to `docs/archive/gtfs-expansion-plan.md`.
2. **The user has answered Gates G-C0a and G-C0b.**

**Gate G-C0a — Start the Costing tool work**
Question: The Analysis app work is finished. Should the Costing tool's GTFS work start now?
- Option A (recommended): yes, in this order: C1 and C2 (export), then C5 (import), then J1 (round trip). C3 (new views) and C4 (interlining) can come before or after.
- Option B: not yet, or start with a different phase (name it).
Example: once C2 is done, a timetable built in the Costing tool for Federal Blvd can be loaded into the Analysis app and compared with today's network.
What changes: work begins in the Costing tool repository, one phase at a time, each with its own sub-plan approved by you.
If you say "your call": Option A.

**Gate G-C0b — Sonnet in the Costing tool**
Question: In the Costing tool, may Sonnet take well-specified implementation packages, as it does in the Analysis app?
- Option A (recommended): yes. Haiku keeps the mechanical packages; Opus keeps design and review.
- Option B: no. Haiku and Opus only, as that repository's rules say today.
Example: wiring an approved export dialog to existing services is a typical Sonnet package.
What changes: Option A is faster and cheaper for mid-size packages, with Opus still reviewing everything. The first sub-plan records the answer in that repository's `AGENTS.md`.
If you say "your call": Option A.

### 1.2 First steps for the Opus agent

1. Confirm the start conditions, and ask Gates G-C0a and G-C0b.
2. Read:
   - this plan;
   - the companion plan's Parts 1–2 and its whole progress log, especially the **A2 and A8 hand-off notes**: the GTFS files and columns the Analysis app actually reads and writes;
   - in the Costing tool: `AGENTS.md`, `codex.md`, `architecture_overview.md`, `docs/data-schema.md`, `docs/domain-glossary.md`, `docs/backlog.md`, and the decision records named in Part 2.
3. Re-check Part 2's findings against the Costing tool's code at that time; it will have changed since 2026-11-20. Record the differences in the progress log.
4. **Move this plan into the Costing tool repository**, following that repository's rules:
   - copy it to `docs/implementation/gtfs-interoperability.md` and add a `docs/backlog.md` entry pointing to it;
   - in the Analysis app repository, move this file to `docs/archive/` and leave a one-paragraph pointer in its place.

   From then on, the copy in the Costing tool repository governs.
5. Write the first phase's sub-plan (4.3), present it to the user, and start no package before approval.

---

## Part 2 — Findings about the Costing tool

As of `transit-costing-tool@aea64aa` (2026-11-20). Re-verify at the start (1.2 step 3).

- **Gaps for GTFS (companion F14):**
  - stops belong to one Route, with IDs unique only within it; shared stops were deliberately deferred (Decision 0079);
  - service days have annual counts but no calendar dates;
  - GTFS import and export are deferred to its Phase 6 (`architecture_overview.md`);
  - there is no cross-scenario comparison table;
  - multi-route interlining is in `docs/backlog.md`.
- **Building blocks already present:**
  - stop and timepoint locations (Decision 0085);
  - derived stop times, with distance weighting (Decisions 0079, 0086);
  - "Export trips with stops CSV" (`src/application/stopTimesCsv.ts`), close to GTFS `stop_times.txt`;
  - a ZIP writer (`src/application/csvDownload.ts`);
  - planned frequencies (Decision 0058), which match the Analysis app's headway bands except that they are per route rather than per pattern (companion F16);
  - automatic blocking (Decisions 0055, 0056, 0083);
  - restore points (Decision 0081).
- **Day types (companion F15):** Weekday / Saturday / Sunday / Holiday with annual counts. The Analysis app uses Weekday / Saturday / Sunday; GTFS uses dates.
- **Methods to keep (companion F1, F2):**
  - The Costing tool already does what GTFS·X gets wrong: cost is rate × revenue hours including layover, and peak vehicles come from blocks.
  - Imports and exports must not weaken this.
- **Constraints:**
  - the interface works one route at a time;
  - capacity targets in `architecture_overview.md` ("Initial Capacity Target");
  - a single writing tab (Decision 0037);
  - backup-schema versioning rules (`docs/data-schema.md`).

---

## Part 3 — Fixed decisions

**Inherited unchanged from the companion plan:**

| Decision | Summary |
|---|---|
| D1 | Clean room: no GTFS·X code, data or assets, verbatim or translated. |
| D2 | Each app keeps its stack; they share files, not code. |
| D3 | GTFS is the interchange format. A second "sidecar" format needs Gate G-J1. |
| D4 | Time is integer seconds after service-day midnight; values past 24:00 are valid. |
| D5 | Great-circle distances; `shape_dist_traveled` is never trusted as input. |
| D6 | Hour vocabulary: running, revenue (including layover), platform. Every cost names its basis. |
| D12 | No new libraries. Unzipping uses browser built-ins (for example `DecompressionStream`) and a small hand-written ZIP reader. |
| D13 | No silent number changes. |

**Added for this plan:**

- **C-D1 — Governance.** Every phase follows the Costing tool's `AGENTS.md` and `codex.md`:
  - decision records in `docs/decisions/`;
  - an implementation plan in `docs/implementation/` with a "Verification per package" table;
  - structural and UI packages kept separate, with a user verification gate between them;
  - no automatic start of the next package.
- **C-D2 — The contract with the Analysis app** is what it actually reads and writes, as recorded in the companion plan's A2 and A8 hand-off notes, not what this plan assumed in November 2026.
- **C-D3 — One phase at a time.** At each verification gate, report the result and recommend the next package and model to the user.

---

## Part 4 — How the work is run

### 4.1 Roles and models

| Class | Model | Name in the Costing tool's `AGENTS.md` | Owns |
|---|---|---|---|
| Planner / integrator | Opus | Primary agent; UI-design class ("Sol") | Sub-plans, decision records, reviews, final verification, novel or complex interface design |
| Implementer | Sonnet (per Gate G-C0b) | Not in that file today | Well-specified packages that reuse existing components and patterns |
| Structural | Haiku at `high` or `xhigh` effort | Structural ("Luna") | Domain types, pure calculations, repositories and migrations, serializers, unit tests |

Haiku and Sonnet write most of the code. Opus does interface design and the delicate parts directly:

- the stop-identity rule;
- calendar synthesis;
- GTFS parsing edge cases;
- backup-schema changes.

### 4.2 Every phase needs a sub-plan

This plan gives each phase its goal, what it must deliver, draft gates and open questions. An Opus agent turns that into a sub-plan before any work.

### 4.3 Instructions for the Opus agent writing a sub-plan

```
You are the Opus planner for phase <ID> of the GTFS interoperability plan
(docs/implementation/gtfs-interoperability.md in transit-costing-tool, moved
there from transit-analysis-tool/docs/gtfs-costing-tool-plan.md).

1. Read that plan in full, then this repository's AGENTS.md, codex.md,
   architecture_overview.md, docs/data-schema.md, docs/domain-glossary.md,
   and the decision records the phase touches. Read the code AS IT IS NOW.
2. Write down what has changed since the plan was written that affects this
   phase: code, deviations by earlier phases, gate answers, the Analysis
   app's hand-off notes.
3. Decide the phase's shape. You may split it, merge it, shrink it, or
   conclude that no change is needed. Dropping or postponing any item under
   "Must deliver" is a user gate. Otherwise record your reasoning in the
   progress log.
4. Keep every Part 3 decision. Changing one is a user gate.
5. Write the decision record(s) in docs/decisions/ and the implementation
   plan in docs/implementation/, in this repository's formats, including the
   "Verification per package" table and the structural/UI separation.
6. Put user gates (format below) before the packages that depend on them.
   Present the plan to the user before launching any agent.
7. Prefer Haiku wherever a precise package makes it possible; use Sonnet for
   the rest; do novel interface design yourself.
8. When the phase closes: write the closeout, record gate answers in Part 7,
   and append a progress-log entry with hand-off notes.
```

### 4.4 How to write a user decision gate

The user is a transit planner, not a programmer. Every gate uses this template:

```
**Gate <ID> — <short title>**
Question: <one sentence the user can answer without reading code>
- Option A (recommended): <what the user will see and do>
- Option B: <...>
Example: <a concrete case with numbers>
What changes: <consequences, including what happens to existing projects,
scenarios and backups>
If you say "your call": <the default that will be used>
```

**Rules:**

- No code terms. If one is unavoidable, explain it in parentheses.
- One decision per gate.
- Say what happens to existing projects, scenarios and numbers (D13).
- Record the answer and date in Part 7, and repeat it in the progress log.

### 4.5 Verification and documentation

- Use the Costing tool's `AGENTS.md` "Verification" rules and each plan's "Verification per package" table.
- **Never cut:** typechecking; persistence, migration and backup tests when those change; a backup round trip when the backup schema changes.
- Update `architecture_overview.md`, `docs/data-schema.md` and `docs/domain-glossary.md` when structure, data or terms change.
- GTFS exports are also checked by loading them into the Analysis app, and by the MobilityData GTFS validator (the user runs it; the sub-plan says how).

---

### 4.6 Phase overview

| Phase | What the user gets | Lead classes | Needs | Gates | Status |
|---|---|---|---|---|---|
| C1 | One GTFS stop per physical stop at export | O, H | Start conditions | G-C1 | Deferred |
| C2 | Export schedules as GTFS | H, S, O | C1 | G-C2a–c | Deferred |
| C3 | Scenario comparison, blocks timeline, Marey chart | O (design), H | Start conditions | G-C3 | Deferred |
| C4 | Interlining with estimated deadheads | O, H | Start conditions | G-C4a–c | Deferred |
| C5 | Import agency GTFS routes as a baseline | O, H, S | C1 | G-C5a–d | Deferred |
| J1 | Round trip: sketch → schedule and cost → analysis | O | C2, C5 (A8 done) | G-J1 | Deferred |

```
(Analysis app plan complete) ─► C1 ─► C2 ──┐
                                C1 ─► C5 ──┴─► J1
                                C3, C4 (independent)
```

---

## Part 5 — Phases

Every Costing phase needs an Opus sub-plan written to that repository's rules (C-D1, 4.3): one or more decision records, an implementation plan with a verification table, structural and UI packages kept separate, and a user verification gate between them. The sub-plan reads that repository's `architecture_overview.md`, `docs/data-schema.md` and `docs/domain-glossary.md` first.

### C1 — One GTFS stop per physical stop

**Problem (F14):** stops belong to a Route, and their IDs are unique only within it. GTFS needs one record per physical stop, however many routes serve it.

**Must deliver:** a rule, applied at export, that produces one GTFS stop per physical stop, plus a list of conflicts for the planner before export.

**Draft gate:**

**Gate G-C1 — Stops shared by several routes**
Question: In GTFS, a stop served by three routes is one stop. The Costing tool stores stops inside each route. How should we reconcile them?
- Option A (recommended first step): at export, merge stops that share a stop ID and lie within about 30 m of each other. Nothing changes in how you work.
- Option B: a shared stop list for the whole scenario, edited in one place for every route.
Example: stop "24223" on routes 120 and 121 becomes one stop in the export under A. If the two routes give it different locations, it is listed for you to fix before export.
What changes: A is quick and reversible. B is a bigger data change, needed later for "all departures at this stop" across routes.
If you say "your call": Option A now; revisit B when stop-centred views are wanted.

**Questions for the sub-plan:**
- how timepoint stop IDs per pattern (Decision 0080) merge;
- stops with no ID;
- a timepoint and a stop that share an ID.
- **From the Analysis app's export (A8):** stops come from linked Points (`point-<n>`) or are generated every 0.25 mi as `<service key>#<pattern>#<k>` (the id contains `#`). Generated stops are never shared between Services, even at the same spot, so a merge by stop ID will not join them. Decide whether C5's import also merges nearby stops with different IDs.

### C2 — GTFS export

**Must deliver:**

- **An export dialog:** agency name, URL and time zone; a date range; holidays; which Trip profile; optionally which Blocking scenario (gives vehicle blocks); and a shape choice.
- **A ZIP** containing `agency`, `stops`, `routes`, `trips`, `stop_times`, `calendar`, `calendar_dates` and `feed_info`, plus optional `shapes`. Use the existing ZIP writer in `src/application/csvDownload.ts`.
- **Pre-export checks:**
  - stops or timepoints without coordinates (GTFS requires them);
  - missing stop IDs;
  - trips with missing times.
- **Stable IDs:** re-exporting unchanged data gives the same IDs.

**Mapping rules (fixed in the decision record):**

| Costing tool | GTFS |
|---|---|
| Service day | `service_id`, with day-of-week flags from its type |
| Holiday service day | `calendar_dates` additions on the holiday dates, plus removals for the day type it replaces |
| Outbound / Inbound | `direction_id` (record which is 0) |
| Timepoints | `timepoint=1` |
| Derived stop times (Decision 0086) | Times with `timepoint=0` |
| Blocks | `block_id` |
| Route type | Bus (`3`) by default, with a field to change it |

**Verification:** load the export into the Analysis app. The user also runs it through a standard GTFS validator; the sub-plan says how.

**Draft gates:**

**Gate G-C2a — Dates for the export**
Question: GTFS needs real calendar dates. Where should an export's date range and holidays come from?
- Option A (recommended): entered in the export dialog each time, remembered for the next export of that scenario.
- Option B: stored permanently on the scenario.
Example: Jan 4 – Jun 30, 2027, with MLK Day, Presidents Day and Memorial Day running the Holiday service.
What changes: A needs no change to scenario data. B makes dates part of the scenario backup.
If you say "your call": Option A.

**Gate G-C2b — Route shapes**
Question: GTFS route lines are optional. What should the export include?
- Option A (recommended): straight lines through each pattern's stops and timepoints, labelled as such in the feed's notes.
- Option B: no shapes.
- Option C (later, through J1): the alignment drawn in the Analysis app.
Example: a trip planner draws straight segments between stops instead of following streets.
What changes: A shows routes on a map; C gives true alignments once the handoff exists.
If you say "your call": Option A.

**Gate G-C2c — Stops without coordinates**
Question: Some stops may have no location yet. What should export do?
- Option A (recommended): refuse, and list the stops to fix (GTFS requires a location for every stop).
- Option B: export only the timepoints that have locations.
Example: 12 of 40 stops on a new pattern have no latitude and longitude.
What changes: A guarantees a valid feed.
If you say "your call": Option A.

### C3 — Scenario comparison, blocks timeline, Marey chart

**Must deliver:**

- **A scenario comparison** (Costing screen): change in trips, revenue hours, peak vehicles and cost between scenarios or trip profiles, with per-route lines.
- **A blocks timeline** (Blocking screen): one row per vehicle, trip bars by route, layover gaps, deadheads, beside the existing tables.
- **A Marey chart** (Trips screen): time across, distance along the pattern up, one line per trip, from pattern miles and trip times.

These are UI-design-class packages (Opus) on top of pure data preparation (Haiku).

**Draft gate:**

**Gate G-C3 — Which view first**
Question: Which of the three views do you want first?
- Option A (recommended): scenario comparison, then the blocks timeline, then the Marey chart.
- Option B: a different order.
Example: comparison answers "what does alternative B cost vs A" in one table. The timeline makes blocking easier to check. The Marey chart shows bunching and run-time problems at a glance.
What changes: only the order of delivery. All three are view-only and change no stored data.
If you say "your call": Option A.

### C4 — Interlining with estimated deadheads

**Must deliver:**
- auto-blocking that can chain trips across routes;
- deadhead times estimated from stop and timepoint locations (straight-line distance × a detour factor ÷ speed) where no deadhead connection was typed;
- a cost-attribution rule for vehicles serving several routes.

This resolves the backlog entry "Multi-route interlining". **GTFS·X reference page:** `service-planning`.

**Draft gates:**

**Gate G-C4a — When to interline**
Question: Should automatic blocking chain trips across routes?
- Option A (recommended): only when you switch it on for that run.
- Option B: always consider it.
Example: with interlining on, a vehicle finishing route 120 at a terminal shared with route 121 can take the next 121 trip instead of a new vehicle pulling out.
What changes: A keeps today's results unless you ask. Interlining usually lowers peak vehicles and deadhead, but mixes routes on one vehicle.
If you say "your call": Option A.

**Gate G-C4b — Estimated deadheads**
Question: When no deadhead connection is typed, how should the time to drive between two points be estimated?
- Option A (recommended): straight-line distance × 1.3 ÷ 20 mph, both numbers editable, labelled "estimated".
- Option B: only typed connections.
Example: 2 miles apart gives 2 × 1.3 ÷ 20 mph ≈ 8 minutes.
What changes: A lets automatic blocking connect trips at different terminals without typing every connection. Estimated deadheads are marked so you can replace them with real times.
If you say "your call": Option A.

**Gate G-C4c — Cost of a vehicle serving two routes**
Question: How should a vehicle's pull-out, pull-in and deadhead hours be split when it serves two routes?
- Option A (recommended): in proportion to each route's revenue hours on that vehicle.
- Option B: to the route of the first trip.
- Option C: keep today's separate "Unattributed" row.
Example: a vehicle runs 6 revenue hours on route 120 and 2 on route 121, plus 1 hour of pull-out, pull-in and deadhead. Under A, 0.75 h goes to route 120 and 0.25 h to route 121.
What changes: per-route costs add up to the scenario total under A and B. Under C, part of the cost belongs to no route.
If you say "your call": Option A.

### C5 — Import agency GTFS routes as a baseline

**Must deliver:**

- **Import selection:** pick a feed and one or more routes. The interface works one route at a time; the sub-plan sets limits.
- **What the import creates:** the Route, timepoint Nodes, patterns (one per unique stop sequence), stops with locations, run-time profiles built from observed times, and trips with their exact times.
- **Frequency-based trips (required):** read `frequencies.txt` and expand every window into its trips. With `exact_times=1`, trips depart at `start_time + k × headway_secs` below `end_time`, each a copy of the template trip's stop times shifted in time. The Analysis app's export lists only one template trip per regular band in `trips.txt`, so an importer that skips this file loads one trip per band instead of the timetable.
- **Optional parts:** blocks from `block_id`; service days and annual counts from the calendar; planned frequencies from `frequencies.txt` windows (see "Windows to planned frequencies" below).
- **Windows to planned frequencies:** the Analysis app writes one window per pattern, per direction, per band. A planned frequency (Decision 0058) is one set of non-overlapping periods per Route and Service day, shared by both directions. The sub-plan gives the merge rule and what happens when windows overlap, or when directions or patterns disagree (Gate G-C5e).
- **No new libraries (D12):** the sub-plan specifies unzipping with browser built-ins, for example a small ZIP reader plus `DecompressionStream`.

**Draft gates:**

**Gate G-C5a — Which stops become timepoints**
Question: The Costing tool schedules by timepoints. Which of a route's stops should become timepoints?
- Option A (recommended): the stops the feed marks as timepoints; if the feed marks none, you pick, starting from a suggestion (terminals and major transfer stops).
- Option B: every stop.
Example: route 120 has 64 stops per direction; its feed might mark 8 of them as timepoints. A sketch exported from the Analysis app marks only the first and last stop of each trip, so under A it imports with its two terminals as timepoints; its other stop times are spread evenly by distance along the drawn line, with no dwell.
What changes: B creates very large run-time tables (64 columns instead of 8). Under A, the other stops still import as Route stops with derived times (Decision 0079).
If you say "your call": Option A.

**Gate G-C5b — Building run-time bands from the real schedule**
Question: How should run-time bands be built from the feed's actual trip times?
- Option A (recommended): hourly bands using the median observed time per segment.
- Option B: one band per part of the day.
- Option C: import exact trip times only, with no bands.
Example: under A, the segment from Federal & 120th to Federal & 104th gets 07:00–08:00 = 6:30 and 08:00–09:00 = 7:10, taken from the median of that hour's trips.
What changes: bands are what you edit to re-time trips later. Under C, re-timing an imported route means building bands by hand first.
If you say "your call": Option A.

**Gate G-C5c — Days and annual counts**
Question: How should the feed's dates map to Weekday / Saturday / Sunday / Holiday and annual counts?
- Option A (recommended): derived from the feed's calendar, shown for you to confirm or edit.
- Option B: you enter them.
Example: the feed shows a weekday service running Monday–Friday, plus Sunday service on 6 holiday dates. The import proposes Weekday 249, Saturday 52, Sunday 58 and Holiday 6, for you to confirm.
What changes: the counts drive annual hours and cost. A gives a starting point taken from the feed.
If you say "your call": Option A.

**Gate G-C5d — Trips as built or rebuilt**
Question: Should imported trips keep their exact times, or be rebuilt from the new bands?
- Option A (recommended): keep exact times. The bands are a starting point for future edits.
- Option B: rebuild from bands.
Example: a 07:12 trip that really takes 41 minutes keeps 41 minutes under A. Under B it might become 39, the band median.
What changes: A reproduces today's service faithfully, and its costs match the agency's schedule. The trips show as "run times changed" until you choose to regenerate them.
If you say "your call": Option A.

**Gate G-C5e — Frequency windows that do not fit one plan per route**
Question: The Analysis app exports a window per pattern and direction. When a route's windows overlap, or differ between directions or patterns, what should the planned frequency be?
- Option A (recommended): import the windows of the direction with the most trips as the route's plan, and list every window that was left out or conflicted for you to review.
- Option B: import no plan when any windows conflict; trips still import.
Example: northbound runs 06:00–09:00 every 12 min and southbound 06:00–09:00 every 15 min. Under A the plan takes the busier direction (12 min) and lists the 15-minute window.
What changes: A always gives a starting plan; B never guesses.
If you say "your call": Option A.

**What the Analysis app's export carries (A8 hand-off, `docs/reference/modules/gtfs.md` in the Analysis app):**
- Service ids `WK`, `SA`, `SU`, Monday–Friday, Saturday and Sunday, over one date range; no `calendar_dates.txt`, so no holidays.
- No `block_id`; vehicles come from the Costing tool's own blocking.
- Directions: 0 for NB, EB, Outbound, CW, Loop and Both lines, 1 for the opposite. A "Both" line becomes two directions, and the return uses the reversed shape (shape id ending `-r`). Map this onto Inbound and Outbound (Decision 0011).
- Routes: blank short name; long name is the Service name; route ids from Service keys (for example `service-B1`). `route_type` comes from the line's mode.
- Shapes follow the drawn lines. There is no `shape_dist_traveled` (fits D5).
- Trip ids `<route>-<WK|SA|SU>-<pattern>-<direction>-<first departure seconds>`; stable when the sketch is unchanged.

---

## Part 6 — Joint phase J1: round trip between the apps

*Sub-plan required. Runs after C2 and C5. The Analysis app's A8 export is already done (start conditions).*

**Must deliver:** a documented round trip, on the mini fixture and on one real route:

1. Sketch a route in the Analysis app (drawn line, stops, headway bands).
2. Export it as GTFS (A8).
3. Import it into the Costing tool (C5): build run times, trips and blocks, and estimate cost.
4. Export from the Costing tool as GTFS (C2).
5. Load that export into the Analysis app as the Build feed, with the current agency feed as No-Build.
6. Compare (A7) and analyse (A5, A6).

The sub-plan produces a reconciliation table of trips, running hours, revenue hours and peak vehicles at each step, and a list of anything lost in transit.

- **Peak vehicles change method along the way.** The sketch export has no vehicle blocks, so at step 2 peak vehicles are the Analysis app's estimate from trip times. Real blocks first appear after blocking in the Costing tool (step 3). The table names the method at each step, so a difference is not mistaken for a loss.
- **Run times** of an imported sketch have terminal-only timepoints (Gate G-C5a), so expect two-column run-time tables.
- **Start check:** before J1, run an Analysis app export through the MobilityData GTFS validator and confirm it has no errors (the user's step; instructions in the Analysis app's `docs/reference/modules/gtfs.md`).

**Draft gate:**

**Gate G-J1 — GTFS alone, or GTFS plus a planning file**
Question: Is GTFS enough for the handoff, or do we need a second file for planning-only information?
- Option A (recommended): GTFS only. Headway bands travel as frequency windows (companion plan, Gate G8b); distances travel in the route shapes.
- Option B: GTFS plus a small planning file (for example the Costing tool's run-time bands).
Example: the Analysis app has no use for run-time bands, and the Costing tool rebuilds them from trip times (G-C5b).
What changes: A keeps one standard format. B adds a format both apps must maintain.
If you say "your call": Option A; revisit only if the round trip shows something important is lost.

---

## Part 7 — Gate register

Each gate is answered in its section. Record answers here and in the progress log.

| Gate | Phase | Question (short) | Recommendation | Answer | Date |
|---|---|---|---|---|---|
| G-C0a | Start | Start the Costing tool work now | Yes: C1, C2, C5, J1 | | |
| G-C0b | Start | Sonnet allowed in the Costing tool | Yes | | |
| G-C1 | C1 | Shared stops | Merge at export | | |
| G-C2a | C2 | Export dates | Dialog, remembered | | |
| G-C2b | C2 | Route shapes | Straight lines | | |
| G-C2c | C2 | Stops without coordinates | Refuse and list | | |
| G-C3 | C3 | Which view first | Comparison, timeline, Marey | | |
| G-C4a | C4 | When to interline | Opt-in per run | | |
| G-C4b | C4 | Estimated deadheads | 1.3 × distance ÷ 20 mph | | |
| G-C4c | C4 | Cost split for shared vehicles | By revenue hours | | |
| G-C5a | C5 | Which stops become timepoints | Feed's timepoints, else suggested | | |
| G-C5e | C5 | Frequency windows that do not fit one plan | Busiest direction, conflicts listed | | |
| G-C5b | C5 | Run-time bands from real times | Hourly medians | | |
| G-C5c | C5 | Days and annual counts | From calendar, confirmed | | |
| G-C5d | C5 | Trips exact or rebuilt | Exact | | |
| G-J1 | J1 | GTFS alone for handoff | GTFS only | | |

---

## Part 8 — Risks and watch-outs

1. **The Costing tool will have moved on.** This plan was written against `aea64aa`. The first sub-plan re-verifies every finding (1.2 step 3).
2. **Backups and migrations.** Stop identity (C1) and import (C5) may change stored data. Every such change follows the backup-schema and migration rules, with round-trip tests that are never cut.
3. **Scale.** An agency feed has far more routes and trips than the interface's one-route-at-a-time design expects. C5 sets import limits and checks the capacity targets.
4. **ID stability.** Re-exporting unchanged data must give the same GTFS IDs. Otherwise the Analysis app's comparisons and any downstream consumer break.
5. **Licensing (D1).** Reviews check that no GTFS·X code, data or text enters the repository.
6. **No new libraries (D12).** GTFS reading needs unzipping. Use browser built-ins and hand-written code; anything else needs a user gate.

---

## Appendix — References

**Companion plan:** `docs/gtfs-expansion-plan.md` (archived by the time this plan starts), Parts 1–2 and its progress log.

**GTFS·X documentation (methods only, D1):** <https://www.gtfsx.com/docs/>, then `service-planning` (blocks Gantt, variant comparison), `cost-estimation`, `import-and-export`, `shapes-from-stops`, `timetables-and-trips`.

**Costing tool:**
- `architecture_overview.md`, `docs/data-schema.md`, `docs/domain-glossary.md`, `docs/backlog.md` ("Multi-route interlining")
- Decisions 0002, 0037, 0055, 0056, 0058, 0079, 0080, 0081, 0083, 0085, 0086

**Outside standards:**
- GTFS Schedule reference: <https://gtfs.org/documentation/schedule/reference/>
- MobilityData GTFS validator rules: <https://gtfs-validator.mobilitydata.org/rules.html>

---

## Progress log

### 2026-11-20 — Plan split out (Opus)

- Created from Parts 6–7 of `docs/gtfs-expansion-plan.md` at the user's request: Costing tool work is done completely separately, and only after the Analysis app work is finished.
- Added: start conditions and Gate G-C0a; the former G0c, now G-C0b; Parts 2–4 adapted for the Costing tool's rules.
- No change was made to the Costing tool repository. A backlog pointer added earlier the same day was reverted (Costing tool commit `80d8917`); that branch matches its `main`.

**Hand-off:** nothing to do until the Analysis app plan is complete. Then follow 1.2.

### 2026-11-21 — Updated after the Analysis app plan closed (Opus)

- Read the A8 export as built and added what C1, C5 and J1 need: C5 must expand `frequencies.txt` (the export writes one template trip per regular band); a rule for merging per-direction windows into planned frequencies (new Gate G-C5e); the export's ids, directions, service days, missing blocks and holidays; terminal-only timepoints for sketches; peak-vehicle method in J1's table; validator run as a J1 start check.
- No change to the Costing tool repository.
