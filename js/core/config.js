// js/core/config.js
// Third-party API keys and deployment configuration.
// No dependencies. Must load FIRST, before utils.js.
// Exports: App.CARTO_API_KEY, App.CENSUS_API_KEY
//
// ############################################################################
// #  EVERYTHING IN THIS FILE IS PUBLIC.                                      #
// #                                                                          #
// #  This is a static site with no build step and no backend, published from #
// #  a public repository via GitHub Pages. Every value here is served        #
// #  verbatim to the browser and is readable via view-source, the repo, or   #
// #  the Network tab. There is no way to hide a value placed here, and a     #
// #  private repo would not change that — the deployed page has to hand      #
// #  these to the browser to work at all.                                    #
// #                                                                          #
// #  ONLY put credentials here that grant public, rate-limited, read-only    #
// #  access and are safe to expose. Never a key that grants write access,    #
// #  billing, or private data.                                               #
// #                                                                          #
// #  See docs/carto-api-key-plan.md for the full reasoning.                  #
// ############################################################################

(function () {
  var App = (window.App = window.App || {});

  // --- CARTO basemap tiles ---
  // Required since CARTO began keying basemaps.cartocdn.com; unkeyed requests
  // are served with an "API KEY REQUIRED" watermark. Public by design (see
  // above): the protection is that the key is registered to this deployment's
  // domain with CARTO and capped at 5M tile requests/month, not that it is
  // secret. Free tier is non-commercial and requires that the CARTO and
  // OpenStreetMap attribution stay visible on the map.
  //
  // Get one at https://carto.com/basemaps/apikey/
  //
  // Empty string = no key. That is a supported state, not a broken one: the
  // three CARTO basemaps are withdrawn from the switcher and the map falls
  // back to a keyless basemap, so a fork, an exhausted quota, or local
  // development never renders a watermarked map. See js/core/map.js.
  App.CARTO_API_KEY = "cb1_2916_1_c306e086b30dd31ae0a6ade6";

  // --- Census API key ---
  // Removes the ~500 requests/day anonymous rate limit. The Census API works
  // without this, just slower, so an empty string is a safe fallback.
  // Get one at https://api.census.gov/data/key_signup.html
  App.CENSUS_API_KEY = "84dd46873ff2d6d2d41d42c6e9cebfa41214fd14";

  // --- Per-browser override ---
  // Lets a fork or a local checkout use its own CARTO key without editing
  // this file (and without committing it). Set it from the browser console:
  //   localStorage.setItem("mat-carto-key", "your-key-here");
  //   localStorage.removeItem("mat-carto-key");   // revert to the default
  // Wrapped because storage access throws outright in some privacy modes.
  try {
    var overrideKey = localStorage.getItem("mat-carto-key");
    if (overrideKey) App.CARTO_API_KEY = overrideKey;
  } catch (e) {
    /* storage unavailable — keep the committed default */
  }
})();
