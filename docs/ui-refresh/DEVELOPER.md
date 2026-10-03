# Agent / Model Recommendations by Phase

> **Status:** Reference (living). Checked 2026-10: the paths it cites (`test/run-golden.mjs`, `test/ui-screens/`, `/opt/pw-browsers/chromium`) exist. It is advice on which model to use per phase, not a plan. It covers only phases 0-7 although its intro says eight phases, and the branch `claude/modern-ui-refresh-plan-j66tes` is not checked here.

This document maps each of the eight UI refresh phases to recommended agent/model choices,
with rationale for the tier assignments.

## Quick Reference Table

| Phase | Title | Demand Profile | Primary Recommendation | Rationale |
|---|---|---|---|---|
| 0 | Screenshot harness | Debugging-heavy | Sonnet 5 | Headless browser + environment quirks require iterative troubleshooting |
| 1 | Design tokens | Transcription | Haiku 4.5 / Luna | Straightforward token definitions; low semantic complexity |
| 2 | Color migration | High-volume + judgement | Sonnet 5 | ~660 hex→token calls; dark-rule deletion requires discipline; high regression risk |
| 3 | Typography & scale | Moderate complexity | Haiku 4.5 / Luna acceptable | Mostly spec'd; density audit needs mild judgement only |
| 4 | Controls refresh | Taste + ripple mgmt | Opus 5 / Terra | THE headliner phase; iterative feedback rounds; worth the spend; defines inherited look |
| 5 | Inline-style purge | High-volume, low judgement | Haiku 4.5 / Luna | Best cost-saving target; mechanical work; per-group commits limit blast radius |
| 6 | De-modalize | Behavior comprehension | Sonnet 5 minimum / Opus | Requires reading module JS (Travelshed flow); reasoning about interaction consequences |
| 7 | Shell/a11y/docs | Mixed: structure + spec | Sonnet 5 | Toolbar restructure and dropdown grouping require care; documentation updates |

## Rationale by Tier

### Tier: Cheap + Competent (Haiku 4.5 / Luna-equivalent)
**Best for:** Phases 1, 3, 5 (transcription, high-volume mechanics, low-decision work)

- Phase 1 (Tokens): The spec IS the diff. Token names and values are given; transcription
  risk is minimal. A weaker model executes this cleanly.
- Phase 3 (Typography): Scale changes are deterministic. The only decisions are the
  density audit (mild) and which hardcoded sizes stay vs. tokenize (rare exceptions).
- Phase 5 (Inline purge): Four groups of files, one commit each. Patterns are simple
  (margin-top:10px → u-mt-3). Per-group commits mean early failure is caught. The risk
  that a weaker model produces a plausible-but-wrong inline-style interpretation is LOW
  because the output is visible per-group.

### Tier: Mid-Range (Sonnet 5)
**Best for:** Phases 0, 2, 6, 7 (coordination, semantic calls, behavior reasoning)

- Phase 0 (Screenshot): Playwright + headless-browser environment setup has real friction
  (server lifecycle, fixture JSON schema, map-load waits). Iterative debugging on failures
  needs a model that reasons about error messages and environment state.
- Phase 2 (Color migration): This LOOKS mechanical (grep-and-replace at scale) but every
  hex is a small semantic call (#333 → text-primary? or surfaces?). A weaker model produces
  plausible-looking mistakes (wrong token choice survives casual screenshot review). The
  dark-rule deletion rule requires discipline: "delete only if EVERY declaration is
  redundant." A budget model reads this as "delete if MOSTLY redundant" and ships a
  broken dark mode in a hard-to-catch form. Sonnet's higher accuracy is worth paying for.
- Phase 6 (De-modalize): Requires reading `js/projects/transit-travelshed.js` to understand
  the "pick origin on map" flow and reasoning about whether it still works when the map is
  live. This is not a checklist task; it's behavior comprehension. Sonnet vs. budget model
  makes the difference between "I checked it and it'll work" vs. "I checked it" (false).
- Phase 7 (Shell/a11y/docs): Most of this is spec'd, but toolbar hierarchy involves visual
  grouping decisions and the dropdown grouping requires correct id lists (no silent typos).

### Tier: Premium (Opus 5 / Terra-equivalent)
**Best for:** Phase 4 (and 6 if behavior audit is genuinely valued)

- Phase 4 (Controls refresh): This is the phase the developer originally requested; the
  prior six exist so this one is written once in tokens. Taste-driven acceptance: "does it
  look/feel right?" will see iteration rounds with developer feedback. A stronger model is
  less likely to produce a first-pass design that LOOKS modern but has awkward rhythm or
  spacing that wastes a feedback round. Also, phase 4 touches CSS, HTML, and JS config
  simultaneously, and the ripple (settings column widths, popup sizes, grid templates,
  scrolling boundaries) is broad. Opus-tier reasoning about cross-cutting impact is worth it.
- Phase 6 (if you want serious behavior audit): The plan flags flows to test (origin
  picker, draw-while-popup-open, etc.). A premium model audits them more thoroughly; a
  budget model checkbox-ticks without stress-testing. Your choice based on your tolerance
  for "worked in manual testing" vs. "I'm confident it works."

## Summary: Cost-Optimized Path

If you want the tightest budget adherence:
1. **Haiku/Luna** for phases 1, 3, 5 (3 phases, low semantic risk)
2. **Sonnet** for phases 0, 2, 6, 7 (4 phases, moderate to high semantic risk)
3. **Opus/Terra** for phase 4 (1 phase, taste-driven, feedback rounds expected)

Total: 3 budget, 4 mid-range, 1 premium—and the premium spend is on the phase that defines
the look everything else inherits.

## Notes on Luna and Terra (5.6)

Luna and Terra are outside my knowledge cutoff (Jan 2026). If they are positioned as
documented:
- **Luna ≈ Haiku-class but cheaper**: slot into phases 1, 3, 5.
- **Terra >> Sonnet in capability**: slot into phases 4, 6 (phase 0 may still need
  Sonnet if its debugging overhead is real; adjust if Terra's environment integration is
  superior).

## Environment Assumptions (All Phases)

Every phase assumes:
- Shell access to the repository (git commands, node test runs)
- Git push rights to `claude/modern-ui-refresh-plan-j66tes` branch
- Playwright + Chromium (phase 0 specifically; path: `/opt/pw-browsers/chromium`)
- Node.js for `node test/run-golden.mjs` (phases 4, 6, 7)
- One-phase-one-commit discipline enforced by the agent or developer review
- Phase dependencies respected (phase 2 needs phase 1's tokens; phase 3 assumes phase 2's migrations)
