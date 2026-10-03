# Phase 5 — Inline-style purge in popup HTML

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/core-app.md. This file is historical.

**Goal:** replace the ~370 static `style="…"` attributes across `projects/*-popup.html`
with shared primitives, so spacing is governed by the token scale and future changes are
global. Near-zero visual change.

## Scope boundaries (read carefully)

- **In scope:** static layout styles in the 15 `projects/*-popup.html` fragments —
  `margin-top`, `display:flex`-rows, `gap`, ad-hoc colors/font-sizes that phase 2/3
  equivalents exist for.
- **Out of scope:** `style="display:none"` used as JS show/hide state (the modules
  toggle `el.style.display` — converting those to classes would require JS changes in
  every module; not worth it). Leave every `display:none` alone.
- **Out of scope:** inline styles inside JS template strings (`js/projects/*.js`). Too
  many, too risky for the payoff. Exception: if a JS-emitted style duplicates something
  fixed in this phase and takes <5 minutes, do it; otherwise leave.

## Primitives (add to style.css in phase-4's shared section)

```css
.form-field   { margin-top: var(--space-3); }        /* defined in phase 4 */
.form-section { margin-top: var(--space-4); }        /* section-title spacing */
.btn-row      { display: flex; gap: var(--space-2); margin-top: var(--space-3); }
.u-mt-1 { margin-top: var(--space-1); }  .u-mt-2 { margin-top: var(--space-2); }
.u-mt-3 { margin-top: var(--space-3); }  .u-mt-4 { margin-top: var(--space-4); }
.u-muted { color: var(--text-secondary); }
.u-flex-row { display: flex; align-items: center; gap: var(--space-2); }
```

Keep the utility set SMALL (roughly the above). If a popup needs something a primitive
doesn't cover, prefer a module-prefixed class in that module's CSS block over inventing
more utilities.

Conversion guide: `style="margin-top:10px"` → `u-mt-3` (round to scale — 10px becomes
12px; the rhythm consolidation is the point); `style="margin-top:16px"` on
`.rf-section-title` → `form-section`; label+control pairs → wrap in `.form-field`;
`style="display:flex;gap:8px;margin-top:14px"` export rows → `btn-row`.

## Order (one commit per group)

1. Pilot: `transit-coverage-popup.html` (21 inline styles, representative). Screenshot,
   confirm rhythm, then use it as the pattern.
2. Small popups: `buffer-summary`, `gtfs`, `trip-builder`, `attribute-summary`,
   `walkshed`, `display-settings`.
3. Medium: `corridor-scoring`, `transit-propensity`, `route-costing`,
   `fta-small-starts`, `transit-travelshed`.
4. Large: `title-vi` (48), `ridership-forecasting` (108 — do tab by tab).

`mitigation-needs-popup.html` (dormant module): skip.

## Verification

Capture script after each group, both themes, including all tabs of the tabbed popups.
Spacing shifts of ±2–4px from scale-rounding are expected; layout breaks are not.
Grep target at the end: static inline styles (excluding `display:none`) in
`projects/*-popup.html` ≈ 0.

Commits: `UI refresh phase 5 (group N/4): inline-style purge — <files>`
