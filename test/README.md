# Golden-value tests

A tiny, zero-dependency safety net for the app's **calculation engines**. It pins
the numeric output of the pure math functions so a future edit that silently
changes a formula fails loudly instead of shipping.

There is **no build step and no npm install**. It uses only Node's built-ins
(`node:vm`, `node:fs`) and loads the app's real `.js` files exactly as written.
It runs in the Claude Code cloud environment (Node is already present) with one
command.

## Run it

```bash
bash test/run-tests.sh              # check everything (wrapper; same as below)
node test/run-golden.mjs            # check every case file (this is the "CI" run)
node test/run-golden.mjs ridership  # only case files matching "ridership"
node test/run-golden.mjs --update   # re-record golden values from current code
```

The final line is a one-glance tally, e.g. `PASS — 73/73 cases passed across 5 module(s)`.
Currently covered: Ridership Forecasting, TPI scoring, Route Costing, Trip Builder,
Corridor Scoring. (Title VI is deliberately deferred until its engine stabilizes —
see the note in `features.md`.)

`--update` is the only command that writes anything. Use it **only** when you have
deliberately changed a formula, then review the golden diff before committing —
the diff *is* the record of what numbers moved.

## What it can test

The functions exposed on the browser globals (`window.App`, `window.TPI`,
`window.RidershipModel`) that are **pure** — output depends only on the arguments,
with no map, DOM, Census/LODES API, or turf geometry involved. That covers the
fragile, literature-derived math (elasticities, scenario metrics, calibration,
classification) — exactly the code where a silent numeric drift is most dangerous
and hardest to notice by eye.

It intentionally does **not** test map interaction, API fetches, or geometry
(turf) — those aren't deterministic pure math and belong in a different kind of
test.

## Add a module

1. Create `test/cases/<name>.mjs` that default-exports:

   ```js
   export default {
     scripts: ["js/projects/<module>.js"], // app files to load, in dep order
     cases: [
       { id: "short-label", call: "Namespace.fnName", args: [/* ... */] },
     ],
   };
   ```

2. Seed its golden file once: `node test/run-golden.mjs --update <name>`.
3. Commit `test/cases/<name>.mjs` **and** `test/golden/<name>.json` together.

`scripts` are loaded in order into one sandbox, so if a module needs a helper
module loaded first (e.g. a scoring engine that reads `window.TPI` at call time),
list that file first. The sandbox seeds a no-op `App.registerModule`, so
*registered* modules (Route Costing, Trip Builder) load without a real app.

### Two kinds of function

- **Already on a global namespace** (`window.TPI`, `window.RidershipModel`, most
  of `window.App`): call it directly, e.g. `"RidershipModel.classifyCDI"`. No app
  change needed.
- **Private to a module's closure** (e.g. Route Costing's `computeRoundTrip`,
  Trip Builder's `mergeIntervals`): the module needs a tiny **test-only export
  hook**, guarded so it does nothing in the browser:

  ```js
  if (typeof window !== "undefined" && window.__MAT_TEST__) {
    App._rcTest = { computeRoundTrip: computeRoundTrip, /* ... */ };
  }
  ```

  Then reference it as `"App._rcTest.computeRoundTrip"`. See the hooks near
  `computeLayoverHrs` in `route-costing.js` and `mergeIntervals` in
  `trip-builder.js` for the pattern.

Maps and Sets (TPI returns Maps of geoid→score) are stored in the golden as
`{ "__map__": { ... } }` / `{ "__set__": [ ... ] }`, and `Infinity`/`NaN` as
`{ "__num__": "Infinity" }`. You don't need to do anything — the harness handles
these automatically on both sides of the comparison.

## Layout

```
test/
  run-golden.mjs        the runner (sandbox loader + tolerant comparator + CLI)
  run-tests.sh          convenience wrapper around run-golden.mjs
  cases/                one file per module: the inputs you choose to pin
  golden/               the recorded known-good outputs (committed; regenerated with --update)
  README.md
  ui-screens/            pixel regression harness (Playwright) — see its own README
  browser/                behavior tests (Playwright) — see test/browser/README.md
```

## Other test tiers

This directory only covers pure calculation math. Two more harnesses cover
what this one deliberately does not, both needing Playwright (see their own
READMEs for one-time setup):

- **`test/ui-screens/`** — screenshots the app shell and every module popup
  in light + dark mode and diffs against a committed baseline. Run after any
  app-shell, shared-CSS, popup, or module-markup change.
- **`test/browser/`** — drives the real app in headless Chromium and asserts
  runtime behavior a pixel diff can't see: persistence across a reload,
  startup sequencing, map-layer lifecycle. Run after a change to session
  persistence, IndexedDB/localStorage state, or anything else that only
  misbehaves with a real event loop.
