# CARTO Basemap API Key — Implementation Plan

**Status:** Implemented on `claude/carto-api-key` — except the final step, pasting the real
key into `js/core/config.js` (see §9 step 4). Shipped with `CARTO_API_KEY = ""`, which runs
the keyless-fallback path.
**Branch:** `claude/carto-api-key`
**Trigger:** CARTO now requires an API key for `basemaps.cartocdn.com`. Unkeyed requests
are served with an "API KEY REQUIRED" watermark. Three of this app's seven basemaps —
including the default — are CARTO, so the default map experience is currently degraded.

---

## 1. The honest constraint: this key cannot be kept secret

This is the single most important thing to understand before implementing, because it
determines the whole design.

This app is a **pure static front-end** — no build step, no backend, no npm, no CI. It is
served by **GitHub Pages** from a **public repository**
(`https://caseywalrath.github.io/transit-analysis-tool/`). That means:

- There is no build step to inject a secret at deploy time.
- There is no server to proxy tile requests through.
- Every `.js` file in the repo is served verbatim to the browser.

So the key is readable by anyone, in at least three independent ways: reading the public
repo, viewing source on the live site, or opening the browser's Network tab and looking at
a tile request URL. **Even a private repo would not help** — the deployed site has to hand
the key to the browser for tiles to load at all.

There is no arrangement of files, obfuscation, encoding, or `.gitignore` that changes this.
Anything claiming to "hide" the key in a static site is theater, and worse than useless
because it produces false confidence.

**This is fine, and it is the model CARTO expects.** A basemap tile key is a *public
identifier plus a quota*, in the same family as a Mapbox public token or a Google Maps
browser key. The security control is not secrecy — it is **scoping the key to your domain**
and **monitoring the quota**. That is the plan below.

### What we are actually defending against

| Risk | Real? | Control |
|---|---|---|
| Someone reads the key | Certain, unavoidable | Accepted by design |
| Someone uses the key on *their* site, burning your 5M/month quota | Plausible | Domain scoping (§2) + fallback (§5) |
| Key leaks something else sensitive | No — it grants tile access only | n/a |
| Quota exhaustion breaks the app for users | Plausible | Keyless fallback basemaps (§5) |

---

## 2. Domain scoping — confirm this before relying on it

CARTO's key request form asks for **the domain you will use the basemaps on**. Register the
key for the GitHub Pages host:

```
caseywalrath.github.io
```

**⚠️ Unverified, and it matters:** I could not reach `carto.com` or `docs.carto.com` from
this environment (egress-blocked), so I could **not confirm whether CARTO actually enforces
that domain as a referrer restriction**, or merely records it for their own analytics. The
entire "exposure doesn't matter" argument rests on enforcement being real.

**Before implementing, confirm with CARTO one of the following:**

1. **The key is referrer-locked to the registered domain.** → Committing it to the public
   repo is genuinely safe; a scraper cannot use it elsewhere. Proceed with confidence.
2. **The key is not enforced, just recorded.** → Committing it means anyone can lift it and
   spend your quota. Still workable (that is what the §5 fallback and §7 rotation runbook
   are for), but go in with eyes open, and treat quota monitoring as mandatory rather than
   optional.

A quick way to test enforcement once you have the key: request a tile with the key and a
forged `Referer` header from an unrelated domain and see whether it is served or rejected.

```
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Referer: https://example.com/' \
  'https://a.basemaps.cartocdn.com/light_all/10/163/395.png?key=YOUR_KEY'
```

### Two practical consequences of domain locking

- **Local development.** The team opens `index.html` directly (`file://`) or via a local
  static server. If the key is locked to `caseywalrath.github.io`, CARTO tiles may fail
  locally. Ask CARTO whether `localhost` is permitted, or rely on the §5 fallback while
  working locally. **Confirm this at registration time** — it is the first thing that will
  bite in day-to-day use.
- **Custom domain later.** If the Pages site ever moves to a custom domain, the key must be
  re-registered. Note it in the runbook (§7).

---

## 3. Key mechanics (verified)

The key is a query parameter named `key`, appended to the tile URL. Subdomain sharding
(`a/b/c/d.basemaps.cartocdn.com`) still applies.

```
https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=YOUR_KEY
```

Sources: [CartoDB/basemap-styles README](https://github.com/CartoDB/basemap-styles),
[CARTO Basemaps FAQ](https://docs.carto.com/faqs/carto-basemaps),
[Request an API key](https://carto.com/basemaps/apikey/).

**Attribution is a license condition of the free tier.** The existing CARTO + OpenStreetMap
attribution strings in `js/core/map.js` must stay exactly as they are. Do not touch them.

---

## 4. Where the key lives: a new `js/core/config.js`

Create one file that is the single home for third-party credentials, loaded **first**, before
`utils.js`.

```js
// js/core/config.js
// Third-party API keys and deployment configuration.
//
// ⚠️ EVERYTHING IN THIS FILE IS PUBLIC. This is a static site with no build
// step and no backend — every value here is served verbatim to the browser
// and is readable via view-source or the Network tab. Never put a credential
// here that grants anything beyond public, rate-limited, read-only access.
// See docs/carto-api-key-plan.md.

(function () {
  var App = (window.App = window.App || {});

  // CARTO basemap tiles. Public by design (see above); scoped to the
  // deployment domain on CARTO's side and capped at 5M tiles/month.
  // Empty string = no key: the CARTO basemaps are withdrawn from the
  // switcher and a keyless basemap is used instead (see map.js).
  App.CARTO_API_KEY = "";  // ← paste key here

  // Census API key — removes the ~500 req/day anonymous rate limit.
  // The Census API works without this, just slower. Moved here from
  // utils.js so all credentials live in one documented place.
  App.CENSUS_API_KEY = "84dd46873ff2d6d2d41d42c6e9cebfa41214fd14";

  // Per-browser overrides, for forks and local development that need to
  // use their own keys without editing this file. Set in the console:
  //   localStorage.setItem("mat-carto-key", "…")
  // Cleared with removeItem. Wrapped because storage access throws
  // outright in some privacy modes.
  try {
    var k = localStorage.getItem("mat-carto-key");
    if (k) App.CARTO_API_KEY = k;
  } catch (e) { /* storage unavailable — keep the committed default */ }
})();
```

Wire it into `index.html` immediately **before** `js/core/utils.js` (currently line 366):

```html
<script src="js/core/config.js"></script>
<script src="js/core/utils.js"></script>
```

Then **delete** the `App.CENSUS_API_KEY` line at `js/core/utils.js:13` and its comment, so
there is exactly one definition. Everything reading `App.CENSUS_API_KEY` (three call sites in
`js/core/census.js`: lines 138, 234, 280) keeps working untouched, since the namespace and
timing are unchanged.

> **Note on the Census key:** per your decision this key is *moved, not rotated*. It has been
> committed to a public repo and should be considered already exposed. It is low-severity
> (public data, read-only, the API works without any key at all), so this is a defensible
> call — but if you ever want to close it out, request a fresh key at
> <https://api.census.gov/data/key_signup.html> and swap the one line above.

---

## 5. Applying the key, and degrading gracefully without one

All CARTO URLs live in exactly one place: the `BASEMAPS` array at `js/core/map.js:11-50`
(12 URLs across the 3 CARTO entries). Nothing else in the repo references `cartocdn`.

Two changes in `map.js`:

**(a) Append the key.** Add a small helper and apply it when building tile arrays:

```js
function withCartoKey(tiles) {
  if (!App.CARTO_API_KEY) return tiles;
  return tiles.map(function (u) {
    return u + (u.indexOf("?") === -1 ? "?" : "&") + "key=" +
           encodeURIComponent(App.CARTO_API_KEY);
  });
}
```

Apply it in the two places a raster source is constructed — the initial style
(`map.js:102-114`) and `switchBasemap()` (`map.js:166-171`). Note these are **separate code
paths**: the initial style is built directly from `BASEMAPS[0]` rather than going through
`switchBasemap`, so patching only one will leave the default basemap broken on load. Easiest
correct approach: map the key over `BASEMAPS` once at module init, so both paths read
already-keyed URLs and neither needs to remember to call the helper.

**(b) Withdraw CARTO when there is no key.** If `App.CARTO_API_KEY` is empty, filter the three
CARTO entries out of `BASEMAPS` at init and change the default `currentBasemapId` from
`"carto-light"` to **`"esri-light-gray"`** — the closest visual match among the keyless
options, and already in the registry.

This matters for three real cases: a fork with no key, a quota-exhausted key, and local
development if the key turns out to be domain-locked. In all three, the user gets clean
working tiles instead of a watermarked map, and the basemap switcher never offers an option
that renders broken. The remaining four basemaps (OSM, Satellite, Esri Dark Gray, Esri Light
Gray) require no key.

---

## 6. What NOT to do

Recording these explicitly, because they are the tempting wrong turns:

- **Do not `.gitignore` the config file.** It must be committed or the deployed site has no
  key. A gitignored config would break Pages while providing zero security benefit.
- **Do not obfuscate, base64, or "encrypt" the key.** Trivially reversible, and it invites
  someone later to treat the file as safe for a real secret.
- **Do not add a backend proxy.** It is the only thing that would genuinely hide the key, but
  it means a server, a deploy pipeline, and an ongoing cost — a large architectural change to
  protect a free, public, tile-only credential. Not worth it here.
- **Do not put a real secret in `config.js` later.** The header comment says this; respect it.
  Anything granting write access, billing, or private data must never live in this repo.
- **Do not remove the CARTO/OSM attribution.** It is a license condition of the free tier.

---

## 7. Operations runbook

**Monitoring.** The free tier is 5M tile requests per calendar month across raster and
vector. CARTO says they will contact you rather than cut you off. Watch for the watermark
reappearing on the live site — that is the practical signal that the key has stopped working,
whether from quota or revocation.

**Rotation / revocation.** If the key is abused or exhausted:
1. Request a replacement at <https://carto.com/basemaps/apikey/>.
2. Update the one line in `js/core/config.js`, commit, push. Pages redeploys automatically.
3. If a fork was the source of the abuse, re-register with a tightened domain.

Because the key exists in exactly one line of one file, rotation is a one-line change. That
is the main structural benefit of this plan — not secrecy, but a single point of change.

**Domain change.** Moving the Pages site to a custom domain requires re-registering the key
for the new host, or CARTO tiles will start failing if enforcement is real.

---

## 8. Code changes summary

| File | Change |
|---|---|
| `js/core/config.js` | **New.** `App.CARTO_API_KEY`, `App.CENSUS_API_KEY`, localStorage override, prominent "everything here is public" header. |
| `index.html` | Add `<script src="js/core/config.js">` immediately before `js/core/utils.js` (~line 366). |
| `js/core/utils.js` | Delete the `App.CENSUS_API_KEY` line (13) and its comment. |
| `js/core/map.js` | Key-map the `BASEMAPS` tile URLs at init; drop CARTO entries and default to `esri-light-gray` when no key is present; export `getThemeBasemapId`. |
| `js/app.js` | Dark-mode toggle: resolve via `getThemeBasemapId()` instead of hardcoded CARTO ids (see below). |
| `CLAUDE.md` | Document `config.js` in File Structure and Script Load Order; note the public-by-design constraint. |

Nothing outside `map.js` reads basemap URLs.

### Found during implementation: `app.js` hardcoded the CARTO ids

Not anticipated when this plan was written. `js/app.js` called
`App.switchBasemap("carto-dark")` / `("carto-light")` at two sites — the dark-mode toggle
and the restore-on-load path. `switchBasemap` returns early on an unknown id, so in the
keyless path both calls would have **silently no-opped**, leaving dark mode showing a light
basemap with no error.

Fixed by adding `App.getThemeBasemapId(isDark)` to `map.js` — it returns the CARTO pair when
keyed and the Esri Canvas pair when not — and calling that from `app.js`. This keeps
knowledge of which basemaps actually exist inside `map.js`, where the registry lives. Any
future caller that wants "the light/dark basemap" should use it rather than naming ids.

---

## 9. Build order

1. Create `config.js` with an **empty** `CARTO_API_KEY`; wire into `index.html`; remove the
   `utils.js` line. Confirm Census lookups still work (proves the namespace move is clean).
2. Add the keyless-fallback path in `map.js`. With an empty key, confirm CARTO options
   disappear from the switcher and the map opens on Esri Light Gray. **This is the state a
   fork sees, so it is worth getting right before the key exists.**
3. Add `withCartoKey`. Paste the real key locally (via the localStorage override, so it is
   not yet committed) and confirm CARTO tiles load watermark-free.
4. Commit the real key to `config.js`. Push and verify on the live Pages URL, not just
   locally — the domain restriction only takes effect there.
5. Update `CLAUDE.md`.

---

## 10. Acceptance checks

- [ ] With a valid key: all three CARTO basemaps load with **no watermark**, on the live
      Pages URL.
- [ ] With `CARTO_API_KEY = ""`: CARTO options are absent from the switcher, the map opens on
      Esri Light Gray, and no request is made to `cartocdn.com`.
- [ ] The default basemap on first load is keyed correctly — i.e. the initial-style path was
      patched, not just `switchBasemap`.
- [ ] Switching between all seven basemaps works; drawn features stay above the basemap.
- [ ] CARTO and OpenStreetMap attribution is still visible on every CARTO basemap.
- [ ] `localStorage.setItem("mat-carto-key", "other")` overrides the committed key; removing
      it reverts. No error thrown when storage is unavailable.
- [ ] Census-dependent modules still work — `App.CENSUS_API_KEY` resolves from its new home.
- [ ] Tile URLs carry `?key=…` exactly once, with no double `?`.

## 11. Testing

- **Golden tests: not required.** No formula, constant, or calculation-engine helper is
  touched.
- **UI screenshot harness: optional.** The basemap is stubbed/blocked in
  `test/ui-screens/capture.mjs` (external requests are intercepted), so it will not exercise
  tile loading. Worth one run only to confirm no chrome regression from the `index.html`
  script-tag addition. Note the committed baseline currently shows pre-existing
  environment drift — diff against a same-environment control run, not the baseline.
- **Manual verification is the real test here**, and it must happen on the deployed Pages URL,
  since domain-scoped keys behave differently from `localhost`/`file://`.
