# Layers-panel styling affordance — evaluation (Phase 3 Step 3.5)

Evaluation memo only, per `docs/feature-area-choropleth-plan.md` Phase 3 Step 3.5. No code in this step.

## Question

Now that Feature Area Analysis, TPI, Ridership Forecasting, and Corridor Scoring all render their
choropleths through `App.choropleth` (Steps 3.1–3.4), should the Layers panel (`js/core/layers-panel.js`)
gain a generic "style…" item on each `ANALYSIS` manifest entry — a shared affordance to read/write a
module's `{ ramp, method, classes }` spec from outside that module's own popup?

## What the four migrated modules actually expose

The shared *engine* is uniform (`App.choropleth.render(opts)` everywhere), but the *style spec each
module is willing to vary at runtime* is not:

| Module | User-facing style controls | Ramp | Classing |
|---|---|---|---|
| Feature Area Analysis | Full: `#basMapRamp` + `#basMapClasses` in its own popup (Step 3.1) | Any of the 4 curated `RAMPS` presets | quantile / equal / continuous, user's choice |
| TPI | None | Fixed `"blues"` | Fixed manual breaks `[1,2,3,4]` — the 1–5 rating scale is the point; the legend is static (`tpi-legend.html`) |
| Ridership Forecasting | None | Fixed `"blues"` | Fixed manual breaks `[1,2,3,4]`, same rationale as TPI |
| Corridor Scoring | None (line layer) | N/A — not a `RAMPS` key | Fixed custom 4-color red/orange/yellow/green quality scale, not a sequential ramp at all |

Only Feature Area Analysis has anything for a "style…" affordance to actually surface. TPI and RF's
1–5 scale is a rating, not a magnitude to re-bucket — letting a user pick "equal interval" or
"continuous" there would misrepresent what a score of 3 means relative to the legend. Corridor
Scoring's colors are a red/green judgment (poor → excellent), not a ramp preset; a generic "ramp
picker" control doesn't apply to it at all, and offering one would invite a color choice that breaks
the red-means-bad convention the whole module is built around.

## Why a generic affordance doesn't pay for itself yet

- It would need a per-module capability flag (which of ramp/classes, if any, this module allows
  restyling) before it could render anything — at which point it's mostly re-declaring information
  each module already encodes in its own popup (or deliberately omits, for TPI/RF/CS).
- Feature Area Analysis's style controls already sit next to the exact data they affect — same
  `#basMapRow` block as the map-variable and shade-by pickers. Splitting "which variable" (module
  popup) from "what color" (Layers panel) across two different UI surfaces for the one module that
  has both is a net UX regression for zero present benefit, since no second module needs the split.
- This is also the plan's own settled decision (`docs/feature-area-choropleth-plan.md`, "Settled
  design decisions"): styling controls live in the module popup "for now," with this evaluation as
  the checkpoint to revisit it.

## Recommendation: no-go, revisit later

Don't build a generic Layers-panel styling affordance now. Revisit if a **second** module grows a
genuine user-facing `{ramp, classes}` choice — at that point the shared shape is real, not
speculative, and the abstraction pays for itself.

**Rough scope, if that trigger arrives:** an optional `styleSpec: { get(), set(spec) }` pair on an
`ANALYSIS` manifest entry (`js/core/layers-panel.js`), read by a new "Style…" row in the existing ⋯
menu; the row is simply omitted for entries without `styleSpec` (Corridor Scoring, and TPI/RF unless
they later add a real ramp choice). `get()`/`set()` would delegate to each module's own `_mapRamp`/
`_mapClasses`-equivalent state and its own `renderX Choropleth()` re-render call — the Layers panel
would not own the spec, only expose a second entry point to it, mirroring how it already proxies
visibility/opacity into each module's map layers without owning that state either.
