# Trip Builder — inline attribute setup

Implementation plan. Written to be followed step by step; each step names the
exact file, function, and line region to change.

---

## Problem

Trip Builder assembles Services from drawn Routes/Lines via
`App.buildTransitServices()` (`js/core/service-assembly.js`). A Service whose
features lack Direction, Time Bands, or Run time / Avg speed picks up
`level: "error"` warnings, `App.hasBlockingWarnings(svc)` returns true, and the
module renders its row red and **refuses the click**
(`js/projects/trip-builder.js:303`). The user sees a dead list and no
instruction on how to make it live.

The editor they need already exists inside this module: `openEditPopup()`
(`trip-builder.js:697`) mounts Direction, Run time, Avg speed, and the shared
`App.buildServiceScheduleEditor()` time-bands widget into the shared
`#fp-mini-popup`. It is simply unreachable, because its trigger button
(`#tbEditBtn`) is built by `renderServiceHeader()`, which only runs for a
selected Service.

**So this is mostly an unlocking job, not a build job.** Do not write a new
editor. Do not add a new popup shell. Do not add persistence.

---

## Scope

Five steps. Steps 1–4 unlock the existing editor for blocked Services. Step 5
adds the one field the existing editor is missing (Service id) plus the
selection-rekeying logic it requires.

Files touched:

- `js/projects/trip-builder.js` (the bulk)
- `projects/trip-builder-popup.html` (one new block, one reworded paragraph)
- `css/style.css` (re-tone the blocked row; style the new setup panel)
- `CLAUDE.md` (update the Trip Builder module description at the end)

No changes to `js/core/service-assembly.js`, `js/core/feature-attributes.js`,
or any other module. Route Costing shares `buildTransitServices()` and must
keep behaving exactly as it does today.

---

## Step 1 — Make blocked Services selectable

**File:** `js/projects/trip-builder.js`, `buildServiceList()`, around line 300.

Delete the bail-out in the row click handler:

```js
row.addEventListener("click", function () {
  if (row.classList.contains("tb-svc-blocked")) return;   // <-- DELETE THIS LINE
  var key = row.getAttribute("data-key");
  selectService(key);
});
```

Keep the `tb-svc-blocked` class on the row (line 282) — it is still the styling
hook, it just no longer means "inert". In the same loop, replace the bare
warning icon with an explicit chip so the row reads as an invitation rather
than an error. Where `warnIcon` is built (around line 270), when
`App.hasBlockingWarnings(svc)` is true also append to the `.tb-svc-meta` span:

```html
<span class="tb-svc-setup-chip">Needs setup</span>
```

Keep the existing `⚠` title tooltip carrying the joined warning messages.

**File:** `css/style.css`, lines 5653–5655. Re-tone from red/dead to amber/live:

```css
.tb-svc-row.tb-svc-blocked { cursor: pointer; }                 /* was not-allowed */
.tb-svc-row.tb-svc-blocked .tb-svc-name { color: var(--text-primary); }  /* was #c0392b */
.tb-svc-row.tb-svc-blocked:hover { background: var(--accent-soft); }     /* was transparent */
.tb-svc-setup-chip {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  background: #fef3c7;
  color: #92400e;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}
body.dark-mode .tb-svc-setup-chip { background: #3f2f10; color: #fbbf24; }
```

Use the existing token names in `:root` if `--text-primary` / `--text-xs` are
spelled differently in this file — check before writing. The amber chip colors
are a status encoding, so literal hex is acceptable here (same exemption the
rating pills use).

---

## Step 2 — Add a "needs setup" branch to the right column

**File:** `projects/trip-builder-popup.html`. Add a new block between
`#tbHeader` and `#tbActions`:

```html
<!-- Blocking-warning panel, shown when the selected Service is not ready -->
<div id="tbSetup" class="rf-info-box tb-setup" style="display:none;"></div>
```

**File:** `js/projects/trip-builder.js`, `renderRightSide()` (line 330).

Add `var setup = document.getElementById("tbSetup");` to the element lookups and
to the null guard. In the `if (!svc)` branch, hide it alongside the others.

After `renderServiceHeader(svc);`, insert a blocked branch:

```js
if (App.hasBlockingWarnings(svc)) {
  setup.style.display   = "";
  results.style.display = "none";
  exptRow.style.display = "none";
  results.innerHTML     = "";
  setExportEnabled(false);
  renderSetupPanel(svc);
  var gen = document.getElementById("tbGenerateBtn");
  if (gen) {
    gen.disabled = true;
    gen.title = "Fill in the missing attributes above to generate trips.";
  }
  return;
}
// not blocked:
setup.style.display = "none";
var gen2 = document.getElementById("tbGenerateBtn");
if (gen2) { gen2.disabled = false; gen2.title = ""; }
```

Leave `#tbActions` visible in both cases — a disabled-but-visible Generate
button explains the goal; a hidden one is just another dead end.

Add the new renderer next to `renderServiceHeader`:

```js
// Render the blocking warnings as an actionable checklist plus a button that
// opens the SAME editor the header's Edit button opens.
function renderSetupPanel(svc) {
  var el = document.getElementById("tbSetup");
  if (!el) return;
  var items = svc.warnings
    .filter(function (w) { return w.level === "error"; })
    .map(function (w) { return '<li>' + escapeHTML(w.msg) + '</li>'; })
    .join("");
  el.innerHTML =
    '<p><b>This Service needs a few attributes before trips can be generated.</b></p>' +
    '<ul class="tb-setup-list">' + items + '</ul>' +
    '<button id="tbSetupBtn" type="button" class="rf-action-primary">' +
      'Set up this Service' +
    '</button>' +
    '<p class="tiny u-muted">Changes here edit the Route/Line attributes directly ' +
    '&mdash; the same fields as the per-feature Attributes popup.</p>';
  var btn = document.getElementById("tbSetupBtn");
  if (btn) btn.addEventListener("click", function () { openEditPopup(svc, btn); });
}
```

The warning strings from `service-assembly.js` are already user-facing prose
("No service bands with a headway defined…", "…is missing both Run time and
Avg speed — set one."). Render them verbatim; do not rewrite them here, or the
two surfaces drift.

Add minimal CSS for `.tb-setup-list` (list-style disc, small left padding,
`var(--text-sm)`) next to the other `.tb-*` rules around line 5641.

---

## Step 3 — Make the edit popup refresh the whole right column live

**File:** `js/projects/trip-builder.js`, `openEditPopup()` → `onAttrChange()`
(line 711).

Today it re-renders only the header, so the warning list, the Generate button's
disabled state, and the left-hand chip all go stale while the user types. It
also silently does nothing when the Service key changes (needed by Step 5).

Replace the body of `onAttrChange` with a call to a new shared helper, and add
that helper near `selectService()`:

```js
// Rebuild services from current feature state, re-resolve the selection by
// pattern identity (the key may have changed if serviceId was edited), and
// re-render both columns. Called after any edit made inside the mini-popup.
// `anchor` is { featureType, featureIndex } of the pattern that anchors the
// selection — normally the first pattern of the Service being edited.
function refreshAfterEdit(anchor) {
  if (App.cache) App.cache.save();

  var oldKey = _selectedKey;
  var services = App.buildTransitServices();
  _services = services;

  if (anchor) {
    var found = null;
    services.forEach(function (s) {
      s.patterns.forEach(function (p) {
        if (p.featureType === anchor.featureType &&
            p.featureIndex === anchor.featureIndex) found = s;
      });
    });
    if (found) _selectedKey = found.key;
  }

  // Drop trips belonging to a key that no longer exists (the Service was
  // re-keyed or split) — its composition changed, so the trips are invalid.
  if (oldKey && oldKey !== _selectedKey &&
      !services.some(function (s) { return s.key === oldKey; })) {
    delete _tripsByService[oldKey];
  }

  if (_selectedKey && _tripsByService[_selectedKey]) {
    _stale = true;
    showStale();
  }
  if (!isPopupVisible()) return;
  buildServiceList();
  renderRightSide();
}
```

In `openEditPopup`, capture the anchor before building the content and pass it
through:

```js
var anchorPattern = svc.patterns[0]
  ? { featureType: svc.patterns[0].featureType, featureIndex: svc.patterns[0].featureIndex }
  : null;
...
function onAttrChange() { refreshAfterEdit(anchorPattern); }
content.addEventListener("input",  onAttrChange);
content.addEventListener("change", onAttrChange);
```

Notes for the implementer:

- Re-rendering `#tbHeader` and `#tbServiceList` under an open mini-popup is
  safe: `#fp-mini-popup` is a separate top-level element, and focus lives
  inside it, so typing is not interrupted.
- The old code's `showStale()` only fired when trips already existed; the
  helper above preserves that.
- Do **not** call `App.notifyProject()` from `refreshAfterEdit` — it stays in
  the mini-popup's `onClose` handler as today. Calling it per keystroke would
  fan out to every registered module.

---

## Step 4 — Reword the dead-end copy

Three strings currently send the user out of the module. Point them at the
in-module path instead.

1. `js/projects/trip-builder.js:251` (empty service list):
   `"No routes or lines drawn. Draw a Route or Line on the map, then select it
   here to set its schedule attributes."`

2. `emptyHint()` (line 65). Keep the two-field `{ need, action }` shape:
   - no features: `need: "Draw a route or line to begin."`,
     `action: "Then select it here — you can set Direction, Time Bands, and Run
     time without leaving this panel."`
   - features exist: `need: "Select a Service from the left to view or set up
     its trip schedule."`, `action: "Services marked \"Needs setup\" are
     missing attributes — select one to fill them in."`

3. `projects/trip-builder-popup.html`, the `#tbEmptyState` second paragraph:
   drop "Edit those in the per-feature Attributes popup" and replace with
   "Select a Service and use **Set up this Service** (or **✎ Edit**) to set
   them here."

Also update the left-column note at the top of the popup to mention that a
Service id is what pairs two features.

---

## Step 5 — The Service id gap

### Why it is needed

Two of the five blocking errors are *pairing* problems that the existing edit
popup cannot fix, because it has no Service id field:

- `"N patterns assigned to this Service — v1 supports max 2."`
- `"Directions not valid opposites (NB + NB)."` — sometimes a direction fix,
  but sometimes the user paired the wrong two features.

And in the other direction, a user who has drawn an outbound and an inbound
route has no way from this module to say "these are one Service".

### The complication

`svc.key` is derived from `serviceId` in `buildTransitServices()`
(`service-assembly.js:133`): `"service-<serviceId>"` for bucketed features,
`"solo-<type>-<idx>"` for unbucketed ones. `_selectedKey` and every key in
`_tripsByService` use it. Editing `serviceId` therefore re-keys the Service out
from under the current selection.

### Options considered

- **A. Re-resolve the selection by pattern identity after the change.**
  ~15 lines, entirely inside Trip Builder, no other module affected.
- **B. Change the key scheme to something identity-stable** (e.g. hash of
  member feature indices). Rejected: `service-assembly.js` is shared with Route
  Costing, which persists `selectedKeys` in its own session schema (v2) and
  migrates legacy `"group-…"` keys. Changing the scheme means a Route Costing
  schema bump for no benefit to that module.
- **C. Leave serviceId out; add a separate pairing UI.** Rejected: more
  bespoke surface, and the field belongs next to Direction anyway.

**Take option A.** `refreshAfterEdit()` from Step 3 already implements it —
that is why it takes an anchor pattern. Step 5 only has to add the field and
make sure it writes at the right moment.

### Implementation

**File:** `js/projects/trip-builder.js`, `buildEditPatternBlock()` (line 588).
Insert a Service row immediately **above** the Direction row, following the
same `fp-attr-row` / `fp-attr-label` / `fp-attr-input` pattern as its
neighbours:

```js
// Service id — the pairing key. Reuses the shared autocomplete datalist
// created by the per-feature attributes popup (js/core/feature-attributes.js).
var svcRow = document.createElement("div");
svcRow.className = "fp-attr-row";
var svcLabel = document.createElement("label");
svcLabel.className = "fp-attr-label";
svcLabel.textContent = "Service";
var svcInp = document.createElement("input");
svcInp.type = "text";
svcInp.className = "fp-attr-input";
svcInp.placeholder = "e.g. Blue Line";
svcInp.title = "Two Routes/Lines sharing a Service id are paired into one Service.";
svcInp.value = attrs.serviceId != null ? attrs.serviceId : "";
svcInp.setAttribute("list", "fp-service-datalist");
// CHANGE only (blur / Enter), never input — see the note below.
svcInp.addEventListener("change", function () {
  var v = svcInp.value.trim();
  if (v === "") delete attrs.serviceId; else attrs.serviceId = v;
});
svcRow.appendChild(svcLabel);
svcRow.appendChild(svcInp);
block.appendChild(svcRow);
```

Then append a one-line hint under the field:

```js
var svcHint = document.createElement("div");
svcHint.className = "tiny u-muted tb-edit-hint";
svcHint.textContent = "Give two features the same Service id to pair them " +
                      "(e.g. an NB and an SB pattern). Leave blank for a standalone Service.";
block.appendChild(svcHint);
```

**Critical detail — `change`, not `input`.** Every other field in this block
writes on `input`. The Service id must not, or a user typing "Blue Line" would
re-key the Service on every keystroke ("B", "Bl", "Blu"…), churning the
selection and the left-hand list. Binding to `change` means the write happens
once, on blur or Enter. The container-level `onAttrChange` listener registered
in Step 3 listens for both `input` and `change`, so the refresh still fires
right after the value lands — no extra wiring needed inside this handler.

**Datalist availability.** `fp-service-datalist` is created lazily by
`js/core/feature-attributes.js:498` and `attribute-summary.js:944`, so it may
not exist yet when Trip Builder's popup opens first in a session. Setting the
`list` attribute to a missing id is harmless (no autocomplete, no error), so do
not build a fallback — but if you want parity, copy the four-line
"create the datalist if absent" block from `attribute-summary.js:944-950`
verbatim rather than writing a new one.

### The two flows this enables

*Pairing.* Select Route A → **Set up this Service** → set Service id
"Blue Line", Direction NB → close. Select Route B (still solo) → set Service id
"Blue Line", Direction SB. The two now assemble into one paired Service, and
`refreshAfterEdit` moves the selection onto it.

*Splitting.* A Service with 3+ patterns shows three blocks, each with its own
Service id field. Clear or change one to move it out. The selection follows the
first pattern.

### Known cosmetic limitation — accept it, do not fix it

`App.openMiniPopup` sets its title once, and `buildEditPatternBlock` builds one
block per pattern at open time. If a re-key splits the Service while the popup
is open, the title (`"Edit — Blue Line"`) and the set of blocks shown go stale
until the user reopens it. The fields still bind to the correct underlying
`feature.properties.attributes` objects, so nothing is lost or mis-written.
Rebuilding the popup content mid-edit would destroy the input the user is
typing in. Leave it; note it in the code comment above `openEditPopup`.

---

## Guardrails

- **Do not touch `js/core/service-assembly.js`.** Route Costing depends on it
  and must be unaffected. If a warning message reads badly, that is a separate
  change with two consumers.
- **Do not add session-cache fields.** All edits write through to
  `feature.properties.attributes`, which the session cache already serializes.
  The `trip-builder` module schema stays at **v1** — `saveTbState` /
  `restoreTbState` are unchanged.
- **Do not weaken `runGenerate()`'s guard** (line 864). The blocked branch in
  `renderRightSide` disables the button, but the guard stays as the backstop.
- **Do not change `popupWidth: 1140`** or the panel-width behaviour. Trip
  Builder is explicitly outside the narrow-panel pattern (see CLAUDE.md,
  "Adaptive single-step panel widths").
- **`serviceId` is still not copyable** in Attribute Summary's Copy Attributes
  modal, deliberately. Nothing in this plan changes that.

---

## Verification

1. `node test/run-golden.mjs` — expect `PASS — N/N`. No formula, constant, or
   pure helper changes here, so the numbers must not move. If they do, you
   changed something you should not have; fix the code, do not re-record.
2. `node test/ui-screens/capture.mjs` — the popup markup changed
   (`#tbSetup`), so regenerate and **look at** `test/ui-screens/out/` against
   `baseline/`, not just the pass count. Update the committed baseline only if
   the visual diff is exactly the intended new panel.
3. Manual pass in the browser (`open index.html`):
   - Draw one Route with no attributes → its row shows "Needs setup" and is
     clickable → the setup panel lists the missing items → Generate is disabled.
   - **Set up this Service** → set Direction `Both`, Avg speed `14`, add a
     Weekday band 06:00–09:00 @ 15 → the warning list empties and Generate
     enables **without closing the popup**.
   - Generate → trips appear.
   - Draw a second Route, give both the Service id "Blue Line" (one at a time),
     set NB and SB → they merge into one paired Service, the selection follows,
     and the stale trips for the old key are gone.
   - Reload the page → session restores, no console errors, no orphaned entry
     in `_tripsByService`.

## Commit

One commit on branch `claude/trip-builder-attributes-5e7yk4`. Include in the
message which files changed and a `Verified: node test/run-golden.mjs → N/N`
line, per the repo convention.

Finally, update the **`trip-builder.js`** entry in `CLAUDE.md` (the
"Internal functions" and "Not in v1" lists near the end of the Trip Builder
section): add `renderSetupPanel` and `refreshAfterEdit`, note that blocked
Services are now selectable and editable in place, and note that the Edit
popup now carries the Service id pairing field.
