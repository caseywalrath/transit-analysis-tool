# UI screenshot harness

Screenshots the app shell and every module popup in light + dark mode, so each
phase of the [Modern UI Refresh](../../docs/ui-refresh/README.md) can verify
its work by eyeballing images against a baseline instead of re-deriving intent
from a diff. No build step, no npm install of the app itself — see
"One-time setup" below for the one external package this script needs.

## Run it

```bash
node test/ui-screens/capture.mjs
```

Writes `test/ui-screens/out/<theme>_<name>.png` (gitignored — regenerated
every run) and prints a summary table. Exits non-zero if any capture failed
(distinct from the one documented, expected "skip" — see below).

## One-time setup (playwright)

The repo has no `package.json` and stays that way (see `CLAUDE.md` —
"No build tools"). Install `playwright` once in a scratch directory
**outside** the repo and point `NODE_PATH` at it:

```bash
mkdir -p /tmp/pw-install && cd /tmp/pw-install && npm init -y >/dev/null
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
NODE_PATH=/tmp/pw-install/node_modules node /path/to/repo/test/ui-screens/capture.mjs
```

In the Claude Code cloud environment Chromium is already installed at
`/opt/pw-browsers/chromium`, so the browser download is skipped and the
script launches that binary directly. `NODE_PATH` only affects Node's
CommonJS `require()` resolution (not ESM `import`), which is why the script
loads `playwright` via `createRequire()` internally instead of a top-level
`import` — a plain `import "playwright"` would not see `NODE_PATH` at all.

## How it works

1. Starts `python3 -m http.server <free port>` from the repo root (the app
   fetches popup HTML fragments at runtime, so it must be served over HTTP,
   not opened as a `file://` URL). Killed in a `finally` block.
2. Drives headless Chromium via Playwright, one fresh browser **context**
   per theme (isolated `localStorage`).
3. Before navigation, seeds `localStorage`:
   - `mat-dark-mode` — `"1"` for the dark pass, `"0"` for light (read by the
     no-flash `<head>` script in `index.html`).
   - `mat-session` — the contents of `fixture-session.json`, a hand-built
     demo session (2 points, 1 line, 2 paired routes with service bands, 1
     polygon) so the feature panel, checklists, and Trip Builder / Route
     Costing service lists render real rows instead of empty state.
4. Waits for `window.App && App.map && App.map.loaded()` (30s timeout;
   proceeds anyway if it times out — see "Network stubbing" below).
5. Captures, per theme: the full shell, `#sidebar-wrap`, `#feature-panel`,
   the per-feature attribute popup, and each module popup in
   `MODULE_IDS` (must match the `id` each module passes to
   `App.registerModule({...})`). Tabbed popups (anything with
   `button[data-tab]` inside `.module-popup-dialog`) additionally get one
   screenshot per tab, named `<theme>_<id>_tab-<tabid>.png`.
6. Every capture is wrapped in try/catch — one module throwing on open
   does not abort the run (see the summary table's `FAIL` rows).

## Network stubbing

`index.html` loads MapLibre GL / Turf / pako / PapaParse / JSZip / shapefile
from `unpkg.com`. Some sandboxed environments block that host outright at
the network-policy level (not just slow/flaky — a hard `403`), which would
otherwise mean `App.map` is never created and nothing renders. To make the
harness work in exactly that kind of environment (and to keep every run
fast and deterministic even with real internet access), the script:

- Serves pinned local copies of those six files from `vendor/` (below) via
  Playwright route interception whenever the browser requests the exact
  unpkg URL `index.html` currently uses. **`index.html` itself is never
  modified** — the real app still loads from the real CDN in production.
- Aborts every other remote request immediately (basemap tiles,
  Census/TIGERweb, OSRM routing, Google Fonts). The map area renders blank/
  gray and text falls back to system fonts — expected and fine, since this
  harness checks UI chrome, not live data or tile imagery.

### `vendor/` — pinned CDN mirrors

Fetched once via `npm pack` (bypasses `unpkg.com`, uses the npm registry
instead) and copied out of the tarball — not committed as npm packages, just
plain static files:

| File | Package@version (must match `index.html`'s CDN pin) |
|---|---|
| `maplibre-gl.js`, `maplibre-gl.css` | `maplibre-gl@4.7.1` (`dist/`) |
| `turf.min.js` | `@turf/turf@6.5.0` |
| `pako.min.js` | `pako@2.1.0` (`dist/`) |
| `papaparse.min.js` | `papaparse@5.4.1` |
| `jszip.min.js` | `jszip@3.10.1` (`dist/`) |
| `shapefile.js` | `shapefile@0.6.6` (`dist/`) |

If a later phase (or any other change) bumps one of these CDN version pins
in `index.html`, re-fetch the matching file here so the two stay in sync:

```bash
npm pack maplibre-gl@<new-version>   # extract, copy dist/maplibre-gl.{js,css}
```

and update both the `VENDOR_MAP` entry in `test/browser/harness.mjs` (the
shared source of truth for every browser test, not just this one) and the
table above.

## Known, expected "skip": `#sidebar-wrap`

`#sidebar-wrap` ships with inline `style="display:none"` in `index.html`,
and nothing in the current codebase ever shows it — `App.sidebar.render()`
(the function that would populate and reveal it) is not called anywhere.
The "Data Inputs" panel it used to hold now lives inside the Buffer-Area
Summary popup, and the "Analysis" panel is now the toolbar's Analysis
dropdown, per `CLAUDE.md`. This is a pre-existing product fact, not
something phase 0 introduced or should paper over — the script logs it as
a `SKIP` (not a `FAIL`) so the run still exits 0, and `<theme>_sidebar.png`
is simply absent from `out/`. If the sidebar is ever wired back up, this
capture will start succeeding again with no script changes needed.

## Baseline vs. out

- `out/` — gitignored, regenerated every run.
- `baseline/` — committed once in phase 0, the **pre-refresh** reference
  set. Later phases run the script and eyeball their `out/` against
  `baseline/`; they do not recommit `baseline/` until the final phase
  refreshes it to the new look (see `docs/ui-refresh/README.md`).

## Adding a popup to the list

Add its `id` (must match the string passed to `App.registerModule`) to the
`MODULE_IDS` array near the top of `capture.mjs`. Tabs are discovered
automatically (any `button[data-tab]` inside the open dialog), so no
further change is needed for tabbed modules.
