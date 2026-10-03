# Phase 4 — Form controls, buttons, checklists (the headline change)

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/core-app.md. This file is historical.

**Goal:** modern, comfortable controls everywhere, changed at the shared-class level so
all modules inherit at once. This is the phase the developer originally asked for; the
prior phases exist so this one is written once, in tokens.

**Before starting — dead-sidebar note (see README's known-risk register):**
phase 0 confirmed `#sidebar-wrap` is `display:none` in `index.html` and nothing
calls `App.sidebar.render()` — the left sidebar this phase's §1/§4 touch
(`sidebar-v2.css`, `.var-checklist`) is currently unreachable by any user.
Styling it is still correct (tokens should cover it either way), but skip it
in checkpoint screenshots and confirm with the developer whether to leave it
dead, style it on spec, or revive it now instead of waiting for phase 7.

## 1. Text/number/select controls

Restyle **in place** (do not rename): `.rf-select`, `.rf-number-input`, `.rf-text-input`
(style.css ~2995–3030), plus the sidebar controls block in `sidebar-v2.css`
(`#sidebar select, input…`), the attribute-popup inputs (`.fp-attr-input`,
`input.fp-attr-input[type=number]` ~1519–1620), mini-popup inputs, the LODES/OSM popup
controls, and modal inputs inside `.rf-weights-modal`/`.rc-*` settings modals.

Unified spec (apply to all of the above):

```css
font-size: var(--text-base);        /* 14px */
min-height: 34px;
padding: 6px 10px;                  /* selects: padding-right ~30px for chevron */
border: 1px solid var(--border-strong);
border-radius: var(--radius-sm);
background: var(--surface-raised);
color: var(--text-primary);
transition: border-color var(--ease-fast), box-shadow var(--ease-fast);
```

States:
- hover: `border-color: var(--text-disabled)` → subtle darkening;
- focus: `outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring);`
- disabled: `opacity: .5; background: var(--surface-alt);`

Selects get a custom chevron (`appearance: none` + inline SVG `background-image`
data-URI, `currentColor` not allowed in CSS URIs — use two variants via
`--select-chevron` token re-valued in the dark block, or a gray that reads in both
themes).

Exception — compact inline inputs (`.rf-number-input-sm`, slider value boxes, the
buffer-radius inputs in the feature panel): keep them compact but align the look
(same border/radius/focus treatment, `min-height: 28px`, `--text-sm`).

**Known misuse to fix while here:** several popups put `class="rf-select"` on
`<input type="number">` (e.g. `transit-coverage-popup.html` buffer distance). Change
those to `rf-number-input` in the HTML — same look after this phase, but semantically
right.

## 2. Labels & field rhythm

- Field labels (`.tiny` labels above controls in popups, `#sidebar label`):
  `font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-secondary); margin-bottom: 4px;`
- Define `.form-field { margin-top: var(--space-3); }` and `.form-field > label { display:block; … }`
  — phase 5 will roll popups onto it; define it here so both phases share the spec.

## 3. Buttons

- `.rf-action-primary` (and `.tpi-action-primary`): filled `var(--accent)`, text
  `var(--text-invert)`, `min-height: 36px`, `font-weight: var(--weight-semibold)`,
  `border-radius: var(--radius-sm)`, hover `var(--accent-hover)`, same focus ring as
  inputs.
- `.rf-btn-sm` and the various small/secondary buttons (`.analysis-module-btn`,
  `#sidebar button`, export buttons): outline style — `border: 1px solid
  var(--border-strong); background: var(--surface-raised);` hover
  `var(--surface-hover)`; `min-height: 30px`.
- Tertiary/link actions (Select all / Clear links): `color: var(--accent)`, no
  underline until hover; ensure ≥24px hit area via padding.
- Destructive (Reset, delete confirms): keep the existing red identity, on
  `--danger` tokens.

## 4. Checklists & rows

`.rf-feature-checklist` and `.var-checklist` (sidebar): row `padding: 5px 6px;
border-radius: 4px;` hover `var(--surface-hover)`; whole row clickable (label wraps
input — verify the JS builds them that way; if a module builds rows without labels,
fix its row template string — UI string change only, allowed). Checkbox size 15–16px
(accent-color already applied in phase 1).

## 5. Width ripple (required, not optional)

Bigger controls in a 240px column will feel cramped:
- `.rf-settings-col` (style.css:2976): `width: 240px` → `280px`. Also the
  `.tb-body .rf-settings-col` override (~5183) — retune to match.
- Bump `popupWidth` in each module's `App.registerModule` call (**UI config only — these
  are JS files, so run the golden harness before committing**):
  - 720 → 760 (`buffer-summary`)
  - 960 → 1000 (`transit-propensity`, `fta-small-starts`, `ridership-forecasting`,
    `corridor-scoring`, `gtfs`, `title-vi`, `attribute-summary`; also `walkshed`,
    `transit-travelshed`, `transit-coverage`, `route-costing` — verify each file's
    current value first, some are already non-960)
  - 1100 → 1140 (`trip-builder`)
  - 520 stays (`display-settings`)
- Check `max-width: 90vw` interaction at a 1280px window: popups must still fit; the
  responsive stack rule near `.tpi-popup-layout`'s `@media` should still trigger.
- `.as-grid-*` templates and `.rc-table`: re-verify after the width change.

## 6. Popup shell polish

`.module-popup-dialog`: `border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);`
Header: title stays `--text-xl`; close button becomes a 30×30 hover-washed square
(`border-radius: var(--radius-sm)`) instead of a bare ×. (The collapse button arrives in
phase 6 — leave room, don't build it here.)

## Verification

- Capture script both themes, all popups + tabs + sidebar + attribute popup. This phase
  SHOULD look very different — compare against *intent*, not baseline: controls
  comfortable, columns not cramped, nothing clipped/overflowing/wrapped-badly.
- `node test/run-golden.mjs` → must pass (popupWidth edits touch module JS).
- Manually tab through one popup: focus ring visible on every control.

## Checkpoint (developer approval required — the big one)

Send light+dark of: Transit Coverage, Ridership Forecasting (Calibrate + Scenarios
tabs), Route Costing + its settings modal, sidebar, attribute popup. Wait for approval;
expect at least one round of tweak requests (spacing/height taste) before proceeding.

Commit: `UI refresh phase 4: control/button/checklist refresh + column and popup widths`
(with `Verified: node test/run-golden.mjs → N/N`)
