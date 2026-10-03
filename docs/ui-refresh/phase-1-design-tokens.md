# Phase 1 — Design tokens (additive only)

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/core-app.md. This file is historical.

**Goal:** define the complete semantic token system in `css/style.css` `:root`, plus a
single dark-mode token override block. **This phase adds tokens; it migrates almost
nothing** (phase 2 does the migration). The only visible change allowed is the
`accent-color` line (modern checkboxes/radios/sliders).

## 1. Color tokens

Add to `:root` in `css/style.css`, keeping the existing tokens (`--border`, `--muted`,
`--bg`, `--panel`, `--warnbg`, `--warnbd`, `--cardbg`) where they are — they get folded
in below via comments, not deleted (existing rules reference them).

```css
/* ---- Color tokens: surfaces ---- */
--surface:        #ffffff;   /* page + map chrome background (= old --bg) */
--surface-alt:    #f6f8fa;   /* toolbar, panels, table headers (= old --panel) */
--surface-raised: #ffffff;   /* popups, cards, inputs (= old --cardbg) */
--surface-hover:  rgba(0, 0, 0, 0.05);   /* hover wash on buttons/rows */
--surface-active: rgba(0, 0, 0, 0.09);

/* ---- Color tokens: text ---- */
--text-primary:   #2d3748;   /* absorbs #333, #2d3748, #374151, #1a1a1a */
--text-secondary: #555;      /* = old --muted */
--text-faint:     #888;      /* absorbs #888, #718096, #9ca3af */
--text-disabled:  #a0aec0;
--text-invert:    #ffffff;   /* text on accent-filled buttons */

/* ---- Color tokens: borders ---- */
/* --border stays (#e5e7eb); absorbs #ddd, #ccc, #e2e8f0-as-light-border */
--border-strong:  #a0aec0;   /* input borders, toolbar button outlines */

/* ---- Color tokens: accent ---- */
--accent:         #2b6cb0;
--accent-hover:   #2c5282;
--accent-soft:    rgba(43, 108, 176, 0.12);  /* selected-row wash, soft chips */
--focus-ring:     rgba(43, 108, 176, 0.35);

/* ---- Color tokens: semantic status ---- */
--danger:         #e53e3e;
--danger-hover:   #c53030;
--danger-soft:    rgba(229, 62, 62, 0.08);
--ok-bg: #ecfdf5;  --ok-bd: #a7f3d0;  --ok-text: #065f46;
--warn-bg: #fff7ed; --warn-bd: #fdba74; --warn-text: #92400e;  /* = old --warnbg/--warnbd */
--err-bg: #fef2f2;  --err-bd: #fca5a5;  --err-text: #991b1b;
--info-bg: #eff6ff; --info-bd: #bfdbfe; --info-text: #1e40af;
```

## 2. Dark-mode token block

Immediately after `:root`, add ONE block that re-values tokens for dark mode. Values are
taken from the hexes the existing 310 hand-written dark rules already use, so phase 2's
migration reproduces today's dark look:

```css
body.dark-mode {
  --surface:        #1e1e2e;
  --surface-alt:    #252535;
  --surface-raised: #2a2a3d;
  --surface-hover:  rgba(255, 255, 255, 0.07);
  --surface-active: rgba(255, 255, 255, 0.12);
  --text-primary:   #e2e8f0;
  --text-secondary: #a8b2c1;
  --text-faint:     #9ca3af;
  --text-disabled:  #718096;
  --border:         #3b3b52;   /* current dark borders mix #4a5568 and #2d2d3d; pick per phase-2 eyeball */
  --border-strong:  #4a5568;
  --accent:         #63b3ed;
  --accent-hover:   #90cdf4;
  --accent-soft:    rgba(99, 179, 237, 0.15);
  --focus-ring:     rgba(99, 179, 237, 0.4);
  --danger:         #fc8181;
  --danger-hover:   #f56565;
  --danger-soft:    rgba(252, 129, 129, 0.12);
  --ok-bg: #0c2b22;  --ok-bd: #1f5c46;  --ok-text: #6ee7b7;
  --warn-bg: #2f2413; --warn-bd: #92610f; --warn-text: #fbbf24;
  --err-bg: #331b1b;  --err-bd: #7f2f2f; --err-text: #fca5a5;
  --info-bg: #16243a; --info-bd: #2c4a75; --info-text: #93c5fd;
  /* legacy tokens follow the theme too: */
  --bg: #1e1e2e; --panel: #252535; --cardbg: #2a2a3d; --muted: #a8b2c1;
  --warnbg: #2f2413; --warnbd: #92610f;
}
```

Important: check whether `body.dark-mode` already re-values `--bg`/`--panel`/etc.
somewhere in style.css (search `dark-mode {` near the top of the dark section). If it
does, merge into that block rather than creating a duplicate.

## 3. Spacing / radius / shadow / motion tokens

```css
/* ---- Spacing scale (use for all margins/paddings/gaps) ---- */
--space-1: 4px;  --space-2: 8px;  --space-3: 12px;  --space-4: 16px;
--space-5: 20px; --space-6: 24px; --space-8: 32px;

/* ---- Radii ---- */
--radius-sm: 6px;   /* inputs, small buttons */
--radius-md: 8px;   /* cards, dropdowns, toolbar buttons */
--radius-lg: 12px;  /* popups/dialogs */

/* ---- Shadows ---- */
--shadow-sm: 0 1px 3px rgba(0,0,0,0.10);
--shadow-md: 0 4px 12px rgba(0,0,0,0.12);
--shadow-lg: 0 12px 40px rgba(0,0,0,0.22);

/* ---- Motion ---- */
--ease-fast: 0.12s ease;
```

Dark mode: shadows get slightly stronger (`rgba(0,0,0,0.5)` style) — add to the dark block.

## 4. The one visible change: native control accenting

```css
:root { accent-color: var(--accent); }
```

(Place with the tokens; this modernizes every checkbox, radio, range slider, and
progress bar in one line, both themes.)

## Verification

- Run capture script; diff vs baseline. **Only** checkbox/radio/slider tinting may
  differ.
- Toggle dark mode manually (screenshots cover it) — identical except native controls.

## Checkpoint (developer approval required)

Send the developer: light+dark shell screenshots plus a small hand-made palette sheet
(optional: a throwaway HTML page rendering each token as a swatch — do not commit it).
Confirm the accent, dark surface values, and status colors before phase 2 bakes them in
everywhere.

Commit: `UI refresh phase 1: semantic design tokens + dark token block + accent-color`
