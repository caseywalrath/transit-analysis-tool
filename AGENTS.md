# AGENTS.md — multi-agent work in this repository

Read this before planning or running any work split across agents (subagents,
parallel sessions, or a plan meant for another model to implement). `CLAUDE.md`
still governs everything else: conventions, testing tiers, git rules, and how to
talk to the user.

Use subagents only when the user asks for delegation or a plan calls for it.

## Roles

| Class | Current model | Former names | Use for |
|---|---|---|---|
| **Planner / integrator** | Opus | Sol | Plans, architecture, task cards, every review gate, final verification. Work that spans shared systems (see "Opus only"). |
| **Implementer** | Sonnet | Terra | The default implementer: well-specified features that touch a few files and follow existing patterns. Also ad-hoc tasks the user judges easy. |
| **Structural** | Haiku, at `high` or `xhigh` effort | Luna | Bounded, mechanical work with a pass/fail check: vendoring, fixtures, pure engines with golden tests, copying an existing file's structure, static markup/CSS, menu wiring, test files, docs. |

- **User's usual workflow:** plan with Opus, implement with Sonnet. Haiku is the cost-saving option for structural packages, never for open-ended ones.
- **Effort:** run Haiku at `high` or `xhigh` effort (the Agent tool's `effort` parameter). The smaller models perform markedly better there.
- **Older plans:** model names in archived plans and in `docs/ui-refresh/DEVELOPER.md` are history. Map any such assignment to the class above that fits the package.
- **Responsibility:** the primary agent stays responsible for architecture, integration review, cross-file consistency and final verification, whoever wrote the code.

### Prefer the structural class where it can succeed

When planning, check each implementer-sized task: could a structural agent do it if the card were precise enough? If so, assign it to Haiku and do the work that makes that possible:

- Split it into structural pieces: a pure function plus its tests, markup separate from behavior, a copy of an existing pattern separate from wiring it in. Keep any piece needing judgment for Sonnet or Opus.
- Settle every decision in the card: the contract, the edge cases, the exact placement and the expected test values. Do not leave choices to the agent.
- Check the card against the code before launch (next section).

Keep a task with Sonnet when the card would need a decision the planner cannot make in advance, or when writing a complete card would cost more than doing the work. Record each choice and its outcome in the plan's progress log, so later plans can tell which kinds of task Haiku handles well.

### Opus only

These areas are not for structural agents. Implementers get them only with a tight card and an Opus review:

- Map layer order, the Layers-panel manifest (`js/core/layers-panel.js`), and the style registries (`layer-palettes.js`).
- Map click/hover ownership, alongside `editing.js`, selection and the attributes dock.
- Startup order, `cache.js` session save/restore/`applyState`, undo snapshots, and IndexedDB stores (the `TransactionInactiveError` rule).
- Behavior-preserving refactors of existing importers or shared helpers.
- Projections, geometry validity, and anything else where a wrong answer still renders.
- Async flows with cancellation or races (dialogs, restore-while-user-acts).
- Visual, layout or interaction design. A structural agent may build UI only to an exact spec that reuses existing primitives (`CLAUDE.md` "Design tokens").

**Why:** in the GeoPackage import (`docs/archive/gpkg-import-plan.md`), nearly every review finding was an interaction between parts. Examples: toolbar CSS leaking into a dialog, a library caching a failed load, undo overwriting run-time styles. Agents scoped to one or two files cannot see these.

## Before launching: check the card against the code

The cheapest and highest-value step. For every "copy X", "next to Y" or "use Z" in a card, confirm with grep or a quick read that X, Y and Z exist and have the shape the card says. In past runs, three of ten cards named things that did not exist. One such mistake was carried out faithfully: "beside the LODES popup" put a dialog inside the toolbar and broke its buttons.

## Task card format (implementer and structural agents)

Always in this order. A smaller model builds exactly what the card says and no more, so a gap in the card becomes a gap in the code.

1. **Goal**: one sentence.
2. **Read first**: exact files, plus search strings for the relevant spot. Line numbers drift between phases; search strings do not.
3. **Files you may change**: a closed list. Anything else means stop and report.
4. **Contract**: exact signatures, return shapes, ids, error/status text, and byte or data layouts. State the following, because a small model will not infer them:
   - the failure behavior of each function: throw, return null, or count and continue;
   - whether one bad item may stop the whole batch (the default is to propagate);
   - who owns cleanup (for example "functions that take `db` never close it");
   - style limits (ES5 in `js/`, modern syntax allowed in tests).
5. **Edge cases**: a numbered list, drafted by the planner. List the odd inputs, empty and NULL cases, mixed types, failures and retries. Smaller models implement lists; they do not invent them.
6. **Placement**: name the container and the exact anchor ("immediately before `<script src="js/core/config.js">`"), not a neighbor.
7. **Steps**: numbered and small.
8. **Done when**: exact commands and the exact final line each must print. For tests, a numbered list of named checks with expected values.
9. **Stop and report if**: the situations where the agent must stop instead of improvising.

## Rules block (paste at the top of every agent prompt)

```
RULES
1. Read CLAUDE.md, AGENTS.md, the plan's relevant sections and every file under
   "Read first" before editing.
2. Do NOT commit, push, switch branches, or run git commands other than
   `git status` and `git diff`. The orchestrator commits after review.
3. Change only the files listed. If another file seems to need a change, stop and report.
4. Never edit an existing test, golden file or harness to make it pass, and never
   change an expected value to match actual output: report actual vs expected.
5. If a "Done when" command fails, fix YOUR code at most twice, then stop and
   report the full failing output.
6. Follow CLAUDE.md conventions. Comments explain why, not what, and never
   mention plan phases.
7. No new libraries, packages or frameworks.
8. Report: FILES / COMMANDS (last output line of each) / DEVIATIONS / QUESTIONS.
   Do not judge screenshots; list their paths.
```

## Running a phase

```
agent task(s) ─► review gate [Opus] ─► commit + push ─► progress-log entry
```

- **Review gate**:
  - Run the `code-review` skill at `high` on the phase diff.
  - Re-run every "Done when" command yourself; never trust the report alone.
  - Open and inspect every screenshot.
  - Passing tests prove only that the card was followed, not that the card was complete.
- **Send-backs**: start a **fresh** agent with the original card plus a numbered list of exact fixes. This worked every time it was used.
- **Reassignment**: if a second attempt still fails review, the planner does the task itself. Fix two- or three-line issues directly rather than sending them back, and log that you did.
- **Parallel agents**: only on disjoint files. If two agents must share a file, give each its exact lines and tell it to re-read and retry if an edit fails because the file changed.
- **Commits**: one commit per phase, with `Verified:` lines (`CLAUDE.md` § Testing). Never start a phase on an uncommitted tree. Keep uncommitted work uncommitted while an agent is still editing it, and say so.
- **Progress log**: append to the plan's "Progress log" section in the same commit. Record:
  - the tasks, and which model did each;
  - send-backs and why;
  - deviations from the plan;
  - **hand-off notes**: the exact function names, ids and signatures the next phase's cards depend on.

  This log is what lets a fresh or compacted session continue correctly.

## Plans

- **Where plans live:** in `docs/`, moved to `docs/archive/` when finished. Each plan has a status line, fixed technical decisions, and phases tagged with their class. It ends with a progress log.
- **Phase boundaries:** put them where the model changes, so each phase's handoff is a commit.
- **Example:** `docs/archive/gpkg-import-plan.md` shows the full pattern: a card-per-task layout, a review gate per phase, a progress log and an experiment summary.
