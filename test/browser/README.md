# Browser behavior tests

Drives the real app in headless Chromium and asserts that it actually
*behaves* correctly — not that its calculation math is right (`test/`'s
golden harness) and not that its pixels look right (`test/ui-screens/`).
See `docs/browser-test-harness-plan.md` for the full design rationale and
the motivating bug.

## What belongs here vs. the other two harnesses

| Harness | Tests | Add a test here instead when... |
|---|---|---|
| `test/run-golden.mjs` | Pure calculation functions, pinned numerically. No map, DOM, API, or turf. | never — that harness stays pure by design. |
| `test/ui-screens/capture.mjs` | Rendered pixels of the shell and every module popup, light + dark. | the change is visual (layout, styling, a new popup). |
| `test/browser/*.test.mjs` (here) | Runtime behavior only a real browser can exhibit — persistence across a reload, load-order/startup sequencing, map-layer lifecycle, anything involving IndexedDB/localStorage timing. | the change could be wrong in a way that still *looks* right, or is invisible without a real event loop (see the IndexedDB gotcha below). |

## Run it

```bash
bash test/browser/run-browser.sh          # every *.test.mjs in this directory
node test/browser/network-cache.test.mjs  # a single file directly
```

Each file prints its own `PASS — n/n` / `FAIL — n/n` summary and exits 0/1
(same contract as `test/run-golden.mjs`). The runner runs every file even if
an earlier one fails, and exits non-zero if any file did.

## One-time setup (Playwright)

Same as `test/ui-screens/` — this repo has no `package.json` and stays that
way (`CLAUDE.md` → "No build tools"). Install `playwright` once in a scratch
directory **outside** the repo and point `NODE_PATH` at it:

```bash
mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
NODE_PATH=/tmp/pw-install/node_modules bash test/browser/run-browser.sh
```

In the Claude Code cloud environment, Chromium is preinstalled at
`/opt/pw-browsers/chromium`, so no browser download happens — the
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` above just stops `npm i` from trying to
fetch one.

## Shared plumbing

`harness.mjs` holds everything both this directory and
`test/ui-screens/capture.mjs` need: the Playwright loader, Chromium
resolution, the vendored-CDN route interceptor (`routeVendoredAssets`, with
an optional `extraHandler` a test can use to stub an API — see
`network-cache.test.mjs` stubbing Overpass), and the local static file
server (`startStaticServer`). One copy, imported by both — see
`docs/browser-test-harness-plan.md` for why that mattered enough to extract.

A new test file only needs its own feature-specific setup and assertions;
everything else comes from `harness.mjs`.

## The IndexedDB transaction-activity rule

The bug that motivated this whole harness tier: an IndexedDB transaction is
only **active** during the synchronous task that created it and during its
own requests' `onsuccess` callbacks. `await`ing anything — even a second IDB
round trip via a naive two-hop helper — between creating the transaction and
issuing its request lets it auto-deactivate as soon as control returns to
the event loop. The next request on it then throws `TransactionInactiveError`.

This only bites when the main thread is busy enough to push the continuation
past a task boundary — which is exactly page startup, the one moment
`js/core/network-store.js`'s store exists to be read at. It worked every
time the page was idle (manual devtools testing) and failed every time it
mattered (the real automatic startup path), which is why this needed a
browser test rather than a code review to catch.

`js/core/network-store.js`'s `_withStore(mode, fn)` encodes the correct
shape (every request issued synchronously or from another request's
`onsuccess`, never after an `await`) and explains why in its own comment.
`js/core/cache.js`'s Recent Projects store uses the older `_idbTx`/`await`
shape and gets away with it only because it's called from user gestures on
an already-idle page — do not copy that shape into a new store.

## Adding a test file

1. Create `test/browser/<feature>.test.mjs` importing from `./harness.mjs`.
2. Use the same `check(name, pass, detail)` / results-array / `PASS — n/n`
   pattern as `network-cache.test.mjs` and `test/run-golden.mjs` — no test
   framework, just plain Node and an exit code.
3. If the feature involves timing, prefer polling observable state
   (`page.waitForFunction`, or a small helper like `network-cache.test.mjs`'s
   `waitForIdbCount`) over a fixed `waitForTimeout`. A fixed sleep is how
   this tier starts flaking in CI. The one legitimate exception is a genuine
   negative assertion with no event to wait on ("this did NOT happen") —
   `network-cache.test.mjs`'s `waitForStatusActivity` documents that case.
4. `App.setStatus` clears the status line after 5 seconds — if your
   assertion depends on a status message, read a recorded log
   (`window.__statusLog`, populated by a `MutationObserver` installed via
   `context.addInitScript`) rather than polling the live DOM element, or you
   will intermittently miss the message.
5. If the flow can trigger a `window.confirm` (large-area downloads do —
   see `fetchRoadNetwork()`), register `page.on("dialog", (d) => d.accept())`
   before triggering it, or the page hangs waiting for a human.
6. These tests write to real browser storage (`localStorage`, IndexedDB)
   inside a Playwright context that is discarded at the end of the run — no
   cleanup needed, but never point one at a persistent user profile.
