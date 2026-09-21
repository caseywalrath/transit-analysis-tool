# Browser behavior tests — shared harness plan

Status: Phase 0 done (a working test is committed). Phases 1-4 open.

## Why this exists

The repo has two test harnesses and a gap between them:

| Harness | Covers | Cannot catch |
|---|---|---|
| `test/run-golden.mjs` | Pure calculation math, pinned numerically. Deliberately no map, DOM, API or turf. | Anything that only misbehaves in a real browser. |
| `test/ui-screens/capture.mjs` | Rendered pixels of the shell and every module popup. | Wrong *behavior* that still looks right (or renders nothing at all). |

Neither could see the bug that motivated this work. While building the
road-network IndexedDB cache (`js/core/network-store.js`), an IndexedDB
transaction went inactive because the code `await`ed between creating the
transaction and issuing its request. IndexedDB deactivates a transaction as soon
as control returns to the event loop, so this throws `TransactionInactiveError`
only when the main thread is busy enough to push the continuation past a task
boundary — which is exactly page startup, the one moment that store exists to be
read at. The store caught it and returned `null`, so the symptom was "there is no
cached network" rather than an error. It worked every time the page was idle and
failed every time it mattered.

That class of bug — **silent, timing-dependent, browser-only** — is what this
harness is for.

## Phase 0 (done)

`test/browser/network-cache.test.mjs` is committed and passes 18/18. It drives
the real app in headless Chromium against a stubbed Overpass endpoint and
asserts the cache's invariants (see the file header for the list; the two that
matter most are *restore must bump the network epoch* and *an explicit clear
must not resurrect on refresh*).

It was committed with its plumbing duplicated from `capture.mjs` rather than
held back pending a refactor, so the proven checks exist in the repo today.
Phases 1-3 pay that debt off.

## Decisions already made — do not relitigate

- **Playwright via `NODE_PATH`, never an npm install in the repo.** This repo has
  no build step and no `package.json` by design (CLAUDE.md → "No build tools").
  `capture.mjs` already established the `/tmp/pw-install` + `NODE_PATH`
  convention; browser tests follow it. Do not add a `package.json`, a lockfile,
  or a `node_modules/`.
- **No test framework.** No jest/vitest/mocha. Plain Node, a `check(name, pass,
  detail)` helper, a `PASS — n/n` summary line and an exit code — matching
  `run-golden.mjs`'s contract so any future CI treats them identically.
- **One vendored-CDN source of truth.** `test/ui-screens/vendor/` stays the only
  copy of the pinned libraries. Browser tests read from it; they do not get their
  own vendor directory.
- **Behavior tests are not a pixel harness.** If a change needs a screenshot
  diff, it belongs in `capture.mjs`. If it needs "did the app actually do the
  right thing", it belongs here.
- **Golden tests stay pure.** Nothing in this plan changes `run-golden.mjs` or
  adds browser dependencies to it.

## Phase 1 — extract `test/browser/harness.mjs`

Create `test/browser/harness.mjs` holding the plumbing that
`test/ui-screens/capture.mjs` and `test/browser/network-cache.test.mjs`
currently each carry their own copy of. Move, do not rewrite — the point is one
copy, not a better one.

Extract from `capture.mjs` (current line numbers):

| Piece | `capture.mjs` lines | Notes |
|---|---|---|
| `REPO_ROOT` / `VENDOR_DIR` resolution | 45-48 | `OUT_DIR` is capture-specific and **stays** in `capture.mjs`. |
| Playwright loader + install instructions | 58-70 | The error message names the calling script; take the script path as an argument or derive it. |
| `CHROMIUM_CANDIDATES` / `resolveExecutablePath()` | 72-82 | Verbatim. |
| `VENDOR_MAP` | 86-94 | The single source of truth after this phase. |
| `findFreePort()` | 164-173 | Verbatim. |
| `waitForHttpReady()` | 175-191 | Verbatim. |
| `sleep()` | 193-195 | Verbatim. |
| Static-server spawn | inside `main()`, ~643-651 | Wrap as `startStaticServer()` → `{ port, stop() }`. |
| `chromium.launch(...)` call | ~657-662 | Wrap as `launchBrowser()`. |

Also extract the route-interception handler. `capture.mjs` (348-362) vendors CDN
assets, allows localhost and aborts everything else; the network-cache test needs
the same plus an Overpass stub. Export:

```js
// extraHandler: optional (route, url) => truthy if it handled the request
export async function routeVendoredAssets(context, port, extraHandler) { ... }
```

`capture.mjs` passes no `extraHandler`; the network-cache test passes one that
fulfills `overpass-api.de` and counts hits.

**Verification (this is the important part of Phase 1).** `capture.mjs` is the UI
regression baseline tool; a refactor must not change a single pixel.

1. Run `capture.mjs` on `main` (before your changes) and keep `test/ui-screens/out/`.
2. Apply the refactor.
3. Run `capture.mjs` again and confirm the new `out/` matches both the previous
   run and the committed `test/ui-screens/baseline/`.
4. Run `test/browser/network-cache.test.mjs` — still 18/18.

If any screenshot moves, the refactor changed behavior and is wrong. Do not
re-record the baseline to make it pass.

## Phase 2 — refactor `network-cache.test.mjs` onto the harness

Delete the duplicated block (imports through `waitForHttpReady`, plus the inline
server spawn and `chromium.launch`) and import from `harness.mjs`. Keep in the
test file only what is genuinely about this feature:

- `overpassPayload()` — the 4x4 street-grid fixture
- `waitStatus()` / `idbCount()` — see Phase 3 before moving these
- every `check(...)` and the flow between them
- the `KNOWN DUPLICATION` paragraph in the header comment, now removed

Re-run: 18/18, and `capture.mjs` still matches baseline.

## Phase 3 — harden the timing

Three fixed sleeps remain, and fixed sleeps are how this suite will start
flaking in CI. Replace each with a wait on observable state.

| Location | Current | Replace with |
|---|---|---|
| After the first download | `waitForTimeout(1500)` for the deferred IDB write | Poll `idbCount(page) === 1` with a deadline. |
| After `clearRoadNetwork()` | `waitForTimeout(800)` | Poll `idbCount(page) === 0` with a deadline. |
| After the post-clear reload | `waitForTimeout(1200)` before asserting nothing restored | This one is a genuine negative assertion — there is no event for "restore decided not to run". Keep a bounded wait, but gate it on `App.restoreCachedNetwork` having settled: expose nothing new in product code for this; instead wait for the status log to be non-empty OR the deadline, then assert. Document why it stays time-based. |

While here, note in the file that `waitStatus()` reads `window.__statusLog`
rather than the live `#status` element **because `App.setStatus` clears itself
after 5 seconds** — polling the DOM loses messages and cost a debugging cycle
during development. That comment is load-bearing; keep it wherever the helper
ends up.

Do not add product-code hooks just to make tests easier to write. If an assertion
genuinely cannot be made from the public `App.*` surface, say so rather than
widening the API.

## Phase 4 — runner and docs

1. **Runner.** Add `test/browser/run-browser.sh`, mirroring `test/run-tests.sh`'s
   shape (resolve its own directory, `exec node`). It should run every
   `*.test.mjs` in `test/browser/`, print each file's summary, and exit non-zero
   if any file did. Do **not** fold browser tests into `test/run-tests.sh` —
   golden tests are zero-install and must stay runnable with nothing but Node.
2. **`test/browser/README.md`.** Cover: the `NODE_PATH` install line; that
   Chromium is preinstalled at `/opt/pw-browsers/chromium` in the cloud
   environment; what belongs here versus in `ui-screens` versus in the golden
   harness; and the IndexedDB transaction-activity rule below.
3. **`test/README.md`.** One short section pointing at the new directory.
4. **`CLAUDE.md`.** Two edits:
   - Under "Testing — golden-value checks", add a sibling paragraph on browser
     behavior tests, with the same "when do I need to run this?" framing the
     golden section uses. Golden = calculation changes; browser = changes to
     persistence, startup sequencing, or map-layer lifecycle.
   - In the File Structure block, add `test/browser/` beside the existing
     `test/` entries.

## Gotchas worth carrying forward

- **The IndexedDB transaction-activity rule.** A transaction is active only
  during the task that created it and during its own requests' `onsuccess`
  handlers. Never `await` a non-IDB promise (or a second round trip) between
  creating a transaction and issuing its request. `js/core/network-store.js`'s
  `_withStore()` encodes the correct shape and explains why; `js/core/cache.js`'s
  Recent Projects store uses the older `_idbTx`/`await` shape, which survives only
  because it is called from user gestures on an idle page. Do not copy the older
  one. (The dead `_dedupeByHandle()` helper that had this bug was removed in
  commit `470c2c2`.)
- **The epoch assertion is a real invariant, not a formality.** If someone
  "optimizes" `restoreCachedNetwork()` to skip `rebuildNetwork()`, the epoch stops
  advancing and restored walkshed/travelshed geometry silently starts being
  treated as current. That check is the guard.
- **Status messages are transient.** 5-second auto-clear; always read the
  recorded log.
- **`fetchRoadNetwork()` can raise a `window.confirm`** for large areas. Tests
  must keep a `page.on("dialog")` accept handler or they hang.
- **These tests write to real browser storage** (`localStorage` and the
  `mat-network-cache` IndexedDB database) inside the Playwright context. The
  context is discarded per run, so no cleanup is needed — but never point one at
  a persistent user profile.
