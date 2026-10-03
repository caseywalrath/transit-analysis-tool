# Fta small starts

Reference for changing FTA Small Starts. Read the code when this and the code disagree.

## fta-small-starts.js (module `"fta-small-starts"`, no public API)

Breakpoint classification for the five FTA Small Starts ratings (Cost Effectiveness/CRE, Existing Ridership/ESS, Transit-Supportive Land Use/LBAR, Mobility Improvement, Congestion Relief), CSV export. Popup body `projects/fta-small-starts-popup.html`, 2 tabs: **Ratings** (geography, ACS year, Compute Breakpoints, 5 rating cards) and **Data Inputs** (CRE/ESS/LBAR uploads with column-mapping selects, county FIPS, LBAR map-layer toggle). `projects/fta-small-starts.html` (and `fta-cre/ess/lbar.html`) are legacy sidebar fragments.

- `panelWidths: { setup: 520, results: 520, workspace: 1000 }` — Data Inputs is the one deliberate wide workspace mode.
- DOM writes guarded by `isPopupVisible()`; element ids use the `fta` prefix to avoid collisions.
- Rating pills: `.pill.high` / `.mh` / `.med` / `.ml` / `.low` in `css/style.css`.
- `_bpRunning`/`_bpQueued` are a concurrency guard around the async `_doUpdateBreakpointRatings()`.
- Persistence: `App.cache.registerModule("fta", ...)` persists computed ratings only, never the raw uploaded files (`CRE_MAP`, `ESS_POINTS`, `LBAR_SITES`).
