# Fta small starts

Reference detail moved verbatim from `CLAUDE.md`. Read the code when this and the code disagree.

## Files

- **`fta-small-starts.js`** — FTA Small Starts: breakpoint classification, CRE/ESS/LBAR, popup-based 2-tab UI (Ratings | Data Inputs), session persistence, CSV export

- **`fta-small-starts-popup.html`** — FTA popup body: 2-tab layout (Ratings | Data Inputs); Ratings tab has 2-column layout (settings + 5 rating cards); Data Inputs tab has CRE/ESS/LBAR file uploads with column mapping selects

- **`fta-small-starts.html`** — FTA sidebar HTML fragment (legacy, replaced by popup version)

## API

### API — fta-small-starts.js (analysis module, no public API)
Registers module `"fta-small-starts"` as a popup-based analysis. Opens in a 2-tab popup (960px wide). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()`. All DOM element IDs use `fta` prefix (e.g., `ftaGeoLevel`, `ftaYearSelect`, `ftaCreFile`) to avoid collisions with other modules.

**Tab 1 – Ratings**: 2-column layout. Left column: geography level dropdown, ACS Year selector, "Compute Breakpoints" button, loaded-data indicators (CRE/ESS/LBAR status). Right column: 5 rating cards (`bpItem` class) for Cost Effectiveness (CRE), Existing Ridership (ESS), Transit-Supportive Land Use (LBAR), Mobility Improvement, and Congestion Relief — each showing a color-coded pill (High/Medium-High/Medium/Medium-Low/Low) with numeric value and classification range. CSV export button below ratings.

**Tab 2 – Data Inputs**: 2-column layout. Left column: CRE file upload (3 column selects: route name, annualized cost, new annual riders) and ESS file upload (2 column selects: route name, avg weekday boardings). Right column: LBAR file upload (4 column selects: block GEOID, residential density, employment density, CBD dummy) with county FIPS input and map layer toggle.

**Pill color coding:** `.pill.high` (green), `.pill.mh` (blue), `.pill.med` (yellow), `.pill.ml` (orange), `.pill.low` (red) — defined in `css/style.css`.

**Internal functions:** `_doUpdateBreakpointRatings()` (async, computes all 5 ratings from uploaded data + ACS), `computeCRE()`, `computeESS()`, `computeLbarRatio()`, `switchTab()`, `updateDataIndicators()`, `exportRatingsCSV()`, `restoreRatingsDisplay()`, `saveFtaState()`, `restoreFtaState()`.

**Module-local state:** `CRE_MAP`, `ESS_POINTS`, `LBAR_SITES` (uploaded data), `_lastRatings` (computed rating results for session persistence), `_initialized`, `_activeTab`, `_bpRunning`, `_bpQueued` (concurrency guard). Session persistence via `App.cache.registerModule("fta", ...)` — persists computed ratings only, not raw uploaded file data.
