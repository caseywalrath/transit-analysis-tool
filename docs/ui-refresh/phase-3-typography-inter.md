# Phase 3 — Typography: Inter + full-notch scale bump

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/core-app.md. This file is historical.

**Goal:** Inter app-wide, base text 13→14px, and zero hardcoded pixel font sizes.
Approved decision: "full notch — more modern" (option b).

## 1. Inter

In `index.html`, replace the Open Sans `<link>` with Inter (weights 400;500;600;700):

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

In `css/style.css`:
- `--font-sans: "Inter", system-ui, sans-serif;`
- The two map-label rules that use `'Open Sans', var(--font-sans)` (`style.css:557` and
  `:639` area — grep `Open Sans`): change to just `var(--font-sans)`.
- Add once on `body`: `-webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;`

Note: Inter is loaded from Google Fonts CDN, consistent with the project's existing
CDN-library convention. Offline use falls back to system-ui gracefully.

## 2. Scale bump (token values only)

| Token | Old | New | Notes |
|---|---|---|---|
| `--text-2xs` | 10px | 10px | badges/markers — unchanged |
| `--text-xs`  | 11px | 11px | structural labels — unchanged (uppercase labels grow poorly) |
| `--text-sm`  | 12px | 13px | dense tables, secondary text |
| `--text-base`| 13px | 14px | body, form controls |
| `--text-md`  | 14px | 15px | |
| `--text-lg`  | 15px | 16px | |
| `--text-xl`  | 16px | 17px | popup titles |
| `--text-2xl` | 22px | 22px | unchanged |
| `--text-3xl` | 28px | 28px | unchanged |

Because phases 1–2 preserved token usage, this is a 6-line change that reflows the whole
app. That is the point of foundation-first.

## 3. Kill the ~35 hardcoded `font-size: Npx` declarations

`grep -nE 'font-size:\s*[0-9]+px' css/style.css css/sidebar-v2.css` and convert each to
the nearest token **at its old size's position in the *new* scale** — i.e. a hardcoded
`12px` in a dense table becomes `var(--text-sm)` (now 13px) only if that block should
grow with the app; if it's a deliberately tiny annotation (e.g. the 9px axis-ish label
at `style.css:4106`), use `--text-2xs`/`--text-xs` to keep it small. Judgement per line;
list any that stay literal (should be ~0) in the commit message.

## 4. Density audit (expected fallout)

Reflow suspects to check by screenshot and fix in this phase:
- **Route Costing / Trip Builder tables** (`.rc-table`, `.tb-*`): many were hardcoded
  11–12px. Keep them on `--text-sm`/`--text-xs` so they stay one step denser than body.
- **Attribute Summary grids** (`.as-grid-*` column templates): fixed-px grid columns may
  now truncate headers — widen the tight columns as needed (CSS only).
- **Sidebar variable checklist** and feature-panel rows: row heights grow slightly;
  confirm no wrapping weirdness.
- **Toolbar**: unaffected (icon buttons), but check the search input's 13px→14px.
- Popup vertical space: popups are `max-height: 80vh` with scrolling bodies — taller
  content is fine, but confirm the 2-column popups' settings columns don't scroll
  awkwardly (full fix comes with phase 4's width bump).

## Verification

Capture script both themes, all popups + tabs. Everything should read slightly larger
and in Inter; no truncation, no overflow, no wrapped buttons.

## Checkpoint (developer approval required)

Send shell + Transit Coverage + Route Costing (densest) + Ridership Forecasting
Calibrate tab, light+dark. Confirm the size/density feel before phase 4 builds controls
on top of it.

Commit: `UI refresh phase 3: Inter app-wide, type scale bump, tokenize stragglers`
