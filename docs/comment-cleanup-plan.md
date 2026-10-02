# Comment and Documentation Cleanup Plan

**Status:** Not started
**Goal:** Cut the tokens agents spend on documentation and comments, and remove claims that are no longer true. Nothing the app does may change.

## Background

Measured on 2026-10-02:

| Source | Size | When an agent pays for it |
|---|---|---|
| `CLAUDE.md` | ~309 KB (~75k tokens) | Every session start and every compaction |
| `docs/*.md` (30 files) | ~656 KB | Only when a task points to a file |
| Comments in `js/` | ~5,700 of 50,000 lines (11%) | Only when that file is read |

`CLAUDE.md` is the dominant cost, so it comes first. The comments in `js/` are a normal share of the code. Their main risk is being wrong, not their size. The plan files in `docs/` are where outdated "Phase N will…" statements build up.

## Rules for every phase

1. **Comments and docs only.** No change to executable code, CSS rules, HTML markup, test logic or golden values. The guard script (Phase 0) must pass on every commit.
2. **Keep the *why*, cut the *what*.**
   - **Keep:**
     - Invariants ("never call X directly", "must load before Y").
     - The reasons behind non-obvious code: past bugs, browser quirks, deliberate approximations.
     - Units and coordinate order where they aren't obvious.
     - Public API contracts that other files rely on.
   - **Cut:**
     - Comments that restate the next line.
     - Plan-phase history ("Phase 3 added…", "previously…").
     - Narration of what changed.
     - Duplicate explanations of the same thing in several places.
3. **Code wins conflicts.** When a comment and the code disagree, fix the comment. If the code itself looks wrong, do **not** change it. Record it in that phase's findings log (below) for the user to decide.
4. **One idea, one home.**
   - A detailed explanation lives in exactly one place: the code comment, a module reference doc, or a plan.
   - Other places get at most a one-line pointer (`See docs/reference/walkshed.md`).
5. **Do not trim test comments that explain a check's purpose.** Test files are in scope only for redundancy and stale claims.
6. **Small commits.** One batch per commit. Each message lists the guard result, e.g. `Verified: comment-guard 12/12 unchanged; node test/run-golden.mjs → N/N`.

### Findings log

Each phase appends to `docs/comment-cleanup-findings.md`. Each entry gives:
- the file and line;
- what the comment said;
- what the code does;
- a severity, either **Bug?** (the code may be wrong) or **Info**.

The user reviews the **Bug?** entries. They are never fixed as part of this plan.

## Model assignment

| Work | Model | Why |
|---|---|---|
| Guard script (Phase 0) | Opus | Correctness of the safety net matters most |
| `CLAUDE.md` restructure (Phase 1) | Opus | Deciding what every future session needs is a judgment call |
| Plan triage (Phase 2) | Sonnet; Opus reviews the archive list | Mechanical checks against the code |
| Comment batches (Phase 3) | Sonnet, one agent per batch | Repetitive, well-bounded work |
| Batches marked ★ in Phase 3 | Opus | Dense invariants where an over-cut comment invites a regression |
| Cross-check of each batch | Opus orchestrator | Spot-checks the diff and resolves conflict findings |
| Final reconciliation (Phase 4) | Opus | Needs a whole-repo view |

---

## Phase 0: Safety net (Opus)

Build `test/comment-guard.mjs`. It proves that only comments and whitespace changed between two git revisions.

- **JS and MJS:** tokenize both versions with `acorn` (already available via `NODE_PATH=/opt/node-tools/node_modules`) with comments dropped, then compare the token streams. Any difference in tokens is a failure.
- **CSS:** strip `/* … */`, collapse whitespace and compare.
- **HTML:** strip `<!-- … -->`, collapse whitespace between tags and compare.
- **Markdown:** not checked. It is pure documentation.

Usage:
```
NODE_PATH=/opt/node-tools/node_modules node test/comment-guard.mjs [base-rev]
```
The base revision defaults to `HEAD`, so the script checks uncommitted work. It prints one line per changed file and ends with `PASS — n/n files code-identical` or a failure listing the files.

**Self-test before relying on it:**
- A comment-only edit passes.
- Changing one character of code fails.
- Changing a string literal that contains `//` fails.
- Changing a regex literal fails.
- Changing a template literal fails.

**Done when:** the script is committed, its self-test cases are recorded in `test/README.md`, and it is run on the current `HEAD` against itself with a PASS.

---

## Phase 1: Slim `CLAUDE.md` (Opus)

**Target:** a core of 20–30 KB.

**Keep in `CLAUDE.md`:**
- Developer context and communication guidelines (unchanged).
- Common Issues to Prevent, tightened. These are rules, so they stay.
- The testing sections, merged into one short section that covers all three harnesses plus the comment guard.
- Conventions.
- Script load order, as the list only, with the parenthetical dependency notes shortened to the essential ones.
- A **file map** with one line per file giving its role, and a pointer to its reference doc where one exists.
- The Analysis Module System registration contract.
- Layout, briefly.

**Move to `docs/reference/<area>.md`:**
- The long per-file paragraphs in the File Structure section.
- The whole "App Namespace (Public API)" section, split by area: core-features, map-layers, road-network, analysis modules (one file per large module), cache, popup.
- The long module descriptions under "Analysis Module System".

**Process:**
1. Move the text as it is first, with no rewriting, in one commit, so the diff shows it was moved and nothing was lost.
2. Then make a second commit that trims the new reference docs:
   - remove phase history and duplicate passages;
   - check each claim against the code (for example, do the function names exist? do the defaults match?);
   - log any mismatch in the findings log.
3. Fix the `CLAUDE.md` claims already known to be stale.

**Acceptance checks:**
- Every exported `App.*` name, `window.*` engine and module id from the code is still mentioned in `CLAUDE.md` or a reference doc. A small script lists the exports and greps for each one.
- Every rule from Common Issues to Prevent still exists word for word or in a shorter form. The commit message lists each rule and where it now lives.
- `CLAUDE.md` is under 30 KB.

---

## Phase 2: Plan-file triage (Sonnet, Opus reviews)

For each file in `docs/` (and the root-level `.md` files other than `CLAUDE.md` and `README`):

1. Classify its status by checking whether the described features exist in the code:
   - **Shipped:** everything in it exists.
   - **Partial:** some of it exists.
   - **Not started**, or **Abandoned**.
2. Add a status header in this form:
   ```
   > **Status:** Shipped (verified 2026-10). The current behavior is described in docs/reference/<x>.md; this file is historical.
   ```
3. For **Partial** plans, list which phases or steps remain, with a check against the code for each one.
4. Move **Shipped** and **Abandoned** plans to `docs/archive/`, then update every link to them in the repo (`grep -r` for the filename).
5. Do not rewrite the body of an archived plan. Its value is as a historical record.

**User-facing documents** (`Ridership_Forecast_Readme.md`, `TPI_Ridership_Forecast_Methodology.md`, `Title_VI_Module_Overview.md`, `features.md`, and so on) are not archived. They are checked against the code for factual drift only, and any drift goes in the findings log for the user. Their wording is for transit professionals, so it isn't trimmed.

**Opus review:** confirms the archive list before the move commit.

---

## Phase 3: Code-comment passes (Sonnet per batch)

Each batch is one Sonnet agent and one commit. For each file, the agent:

1. Reads the whole file and the matching `docs/reference/` section.
2. Applies the Rules above.
3. Converts multi-paragraph header comments into a few lines describing the file's role and its invariants, with a pointer to its reference doc.
4. Checks each remaining claim against the code (names, defaults, units, which function calls which) and fixes the comment, or logs a **Bug?**.
5. Runs the guard, plus whichever test harness covers the file, to confirm nothing changed.
6. Reports the number of comment lines before and after, and its findings.

**Batches** (★ means Opus):

| # | Files |
|---|---|
| 3.1 | `utils.js`, `config.js`, `undo.js`, `selection.js`, `sidebar.js`, `search.js`, `projections.js` |
| 3.2 | `points.js`, `lines.js`, `routes.js`, `polygons.js`, `labels.js`, `textboxes.js`, `measure.js` |
| 3.3 | `editing.js`, `box-select.js` |
| 3.4 | `features.js`, `feature-appearance.js` |
| 3.5 | `feature-attributes.js`, `attribute-summary.js` (kept together because of the rule that both must be updated) |
| 3.6 ★ | `merge.js`, `split.js`, `service-assembly.js` |
| 3.7 | `layers-panel.js`, `layer-palettes.js`, `choropleth.js` |
| 3.8 ★ | `cache.js` (migrations and the schema-version history are delicate) |
| 3.9 ★ | `road-network.js`, `network-store.js`, `network-connectors.js`, `connector-graph.js`, `walk-cost.js`, `walk-audit.js` |
| 3.10 | `map.js`, `osm.js`, `osm-pois.js`, `census.js`, `lodes.js`, `popup.js`, `present-overlays.js`, `module-buffers.js`, `analysis-checklist.js` |
| 3.11 | `app.js` |
| 3.12 | `buffer-summary.js`, `transit-coverage.js`, `fta-small-starts.js` |
| 3.13 | `tpi-scoring.js`, `transit-propensity.js`, `corridor-scoring.js` |
| 3.14 | `ridership-scoring.js` |
| 3.15 | `ridership-forecasting.js` (the largest file; may be split in half by line range across two agents, in sequence) |
| 3.16 ★ | `travelshed.js`, `transit-travelshed.js`, `walkshed.js` |
| 3.17 | `route-costing.js`, `trip-builder.js`, `gtfs.js` |
| 3.18 | `title-vi-engine.js`, `title-vi.js` |
| 3.19 | `css/style.css`, `css/sidebar-v2.css`, `index.html`, `projects/*.html` |
| 3.20 | `test/**` (redundancy and stale claims only) |
| — | `mitigation-needs*.js` are skipped because the module is dormant. |

The batches are independent, so up to 3–4 can run at the same time. They must commit one after another to avoid conflicts. After each batch, the orchestrator reads a sample of the diff, and in full for ★ batches, before the next commit lands.

**Tests per batch:**
- The guard always runs.
- `node test/run-golden.mjs` runs for any batch that touches a golden-tested engine (3.1, 3.6, 3.7, 3.9, 3.13, 3.14, 3.16, 3.17, 3.18).
- The browser tests cannot be affected when the guard passes, so they run only once, at the end of the phase.

---

## Phase 4: Reconciliation (Opus)

1. Re-run the export-coverage check from Phase 1 against the trimmed code.
2. Look for remaining links to `docs/` paths that no longer exist.
3. Go through the findings log with the user: open each **Bug?** as its own follow-up task, or close it.
4. Run the full test suite: golden, browser, and the `ui-screens` capture. Record the before and after numbers in this file:
   - `CLAUDE.md` size;
   - total comment lines in `js/`;
   - size of `docs/` excluding `docs/archive/`.
5. Add one rule to the `CLAUDE.md` conventions so the problem doesn't return: "Comments explain why, not what. No plan-phase history in code comments. Update `docs/reference/` instead of `CLAUDE.md` for module detail."

---

## Order and checkpoints

- Phase 0 must be done before anything else.
- Phase 1 comes next because it gives the largest saving and every later agent benefits.
- Phases 2 and 3 can overlap.
- Phase 4 comes last.

The user checks in after Phase 1 to see the new `CLAUDE.md`, after Phase 2 to approve the archive list, and at Phase 4.
