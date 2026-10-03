# Phase 2 — Color migration onto tokens

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/core-app.md. This file is historical.

**Goal:** replace hardcoded chrome colors in `css/style.css` (~660 hex occurrences) and
`css/sidebar-v2.css` with phase-1 tokens, then delete dark-mode override rules that the
tokens make redundant. Done in slices, each verified in both themes before the next.

**This phase should produce near-zero visual change.** The consolidations below
(#333/#374151 → `--text-primary`, #ddd/#ccc → `--border`) shift some grays by a barely
perceptible step — that is intended and acceptable; anything more noticeable is a bug.

## Mapping table (light-mode occurrences → token)

| Old value(s) | Token |
|---|---|
| `#333`, `#2d3748`, `#374151`, `#1a1a1a`, `#1f2937` | `var(--text-primary)` |
| `#555` (and `var(--muted)` may stay as-is) | `var(--text-secondary)` |
| `#888`, `#718096`, `#9ca3af` (as text) | `var(--text-faint)` |
| `#a0aec0` (as placeholder/disabled text) | `var(--text-disabled)` |
| `#a0aec0`, `#cbd5e0` (as borders) | `var(--border-strong)` |
| `#ddd`, `#ccc`, `#e5e7eb`, `#e2e8f0` (as light-mode borders) | `var(--border)` |
| `#fff`/`#ffffff` (as input/card/popup bg) | `var(--surface-raised)` |
| `#fff` (as page/panel-adjacent bg) | `var(--surface)` — judgement call; raised vs surface are the same value in light mode, pick by role |
| `#f6f8fa`, `#f7fafc` | `var(--surface-alt)` |
| `#f0f2f5`, `#edf2f7`, `#eef1f5`, `#f0f0f0`, `rgba(0,0,0,0.05)` (hover washes) | `var(--surface-hover)` |
| `#2b6cb0` | `var(--accent)` |
| `#2c5282` | `var(--accent-hover)` |
| `rgba(43,108,176,0.1–0.2)` | `var(--accent-soft)` or `var(--focus-ring)` by role |
| `#63b3ed` in light-mode rules (rare) | leave or map to `var(--accent)` by eye |
| `#e53e3e` | `var(--danger)`; `#c53030` → `var(--danger-hover)` |
| `#fc8181`, `#f56565` (light-mode borders on reset btn) | `var(--danger)` is too strong — use literal or `var(--danger-soft)` border treatment; judgement call, keep look identical |
| status greens/ambers/reds/blues (`#ecfdf5`/`#a7f3d0`/`#065f46`, `#fff7ed`/`#fdba74`/`#92400e`, `#fef2f2`/`#fca5a5`/`#991b1b`, `#eff6ff`/`#bfdbfe`/`#1e40af`) | the `--ok-*` / `--warn-*` / `--err-*` / `--info-*` trios |

**Never migrate (data colors, both files):** `.pill.*` rating colors; choropleth/legend
swatches; drawing-tool icon fills in `index.html` SVGs; feature default colors in JS;
the fuchsia road-download outline; GTFS layer grays; anything inside a `background:
linear-gradient` used as a data ramp.

**Dark-only hexes** (`#1e1e2e`, `#252535`, `#2a2a3d`, `#2d2d3d`, `#4a5568`, `#e2e8f0`
in dark rules): these disappear as their rules are deleted (below), not migrated.

## Slices (one commit each, capture script between)

Slice by style.css section comments (grep the header, work to the next header):

1. **Toolbar + search + all toolbar dropdowns** (`/* ---- Top toolbar ---- */` through
   `/* ---- Main content ---- */`, plus `/* ---- Add Data dropdown ---- */`,
   `/* ---- Save State dropdown ---- */`, `/* ---- Analysis dropdown ---- */`,
   `/* ---- LODES State Selector Popup ---- */`, `/* ---- OSM POI category picker ---- */`).
2. **Feature panel + attribute popup + mini popup + context menus** (sections from
   `/* ---- Right-side feature panel ---- */` through the group/schedule/route-picker
   blocks).
3. **Map overlays**: present mode, legend, north arrow, title, measure tool, text boxes,
   labels, basemap switcher, floating widgets, OSM popups.
4. **Module popup shell + BAS + TPI** (`.module-popup*`, BAS blocks, `.tpi-*`).
5. **RF shared component blocks** (`.rf-*` — the biggest slice; the status pills should
   land exactly on the `--ok/--warn/--err/--info` trios).
6. **Remaining modules** (`.cs-*`, `.tc-*`, `.ws-*`, `.ts-*`, `.fta-*`, `.tvi-*`,
   `.rc-*`, `.tb-*`, `.as-*`, `.gtfs-*`).
7. **`css/sidebar-v2.css`** (small; includes its own dark block at the bottom).

## Deleting dark-mode rules

After migrating a slice, find its `body.dark-mode …` rules (they are scattered — grep
each migrated selector). A dark rule may be **deleted only if every declaration in it is
now redundant** because the light rule reads from a token that the dark block re-values.
If a dark rule contains one genuinely different declaration (e.g. a dark-specific
box-shadow), keep the rule but strip the redundant declarations.

Expected end state: dark-mode rule count drops from ~310 to well under 100 (some
legitimately bespoke dark rules remain — map marker outlines, scrollbar styling, etc.).

## Verification (per slice)

- Capture script, both themes; compare against baseline. Only imperceptible gray
  consolidation allowed.
- Extra manual pass for slice 5/6: open a popup that shows each status pill state
  (stale/done/error/running) — easiest by temporarily calling
  `App.renderModuleState({statusEl: "tcStatus", status:{kind:"error",message:"x"}})`
  from the console; do not commit test code.

## Checkpoint

Push all slices, send developer light+dark before/after of: shell, Transit Coverage
popup, Ridership Forecasting Calibrate tab, feature panel. "Review and continue" —
approval not blocking unless something looks off.

Commits: `UI refresh phase 2 (slice N/7): <sections>`
