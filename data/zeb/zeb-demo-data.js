// Route Electrification Feasibility demo — constants and assumptions.
// See docs/zeb-feasibility-demo-plan.md Step 3.1. This is the single place
// that defines vehicle classes, the energy/battery model, grade and climate
// factors, per-agency depot/vehicle defaults, optional per-route overrides,
// and the 5-tier feasibility classification consumed by js/core/zeb-model.js
// and js/projects/zeb-feasibility.js.
window.ZebDemoData = {
  vehicleClasses: {
    bus40:   { id: "bus40",   label: "40-ft BEB",   batteryKWh: 440, baseKWhPerMi: 2.10 },
    cutaway: { id: "cutaway", label: "Cutaway BEB", batteryKWh: 150, baseKWhPerMi: 1.15 }
  },
  charger: { kW: 150, efficiency: 0.90 },
  socBuffer: 0.20,
  blockChaining: { maxLayoverMin: 30, terminalToleranceMi: 0.3 },
  deadheadCircuity: 1.3,
  gradeClasses: {
    flat:     { label: "Flat",     factor: 1.00 },
    rolling:  { label: "Rolling",  factor: 1.12 },
    mountain: { label: "Mountain", factor: 1.30 }
  },
  seasons: {
    summer: { label: "Summer" },
    winter: { label: "Winter" }
  },
  climateZones: {
    plains:   { label: "Front Range plains", janMeanLowF: 13, factors: { summer: 1.05, winter: 1.30 } },
    mountain: { label: "Mountain valley",    janMeanLowF: 5,  factors: { summer: 1.00, winter: 1.45 } }
  },
  // Keys = the real agency_id values written into data/gtfs/colorado-demo-gtfs.zip
  // by tools/merge-gtfs.py (Step 0): both source feeds carry a non-blank
  // agency_id, so the merge script's "prefix, don't replace" rule produced
  // AVN_1554 / GET_4889 rather than the bare AVN/GET shown in the plan's
  // illustrative example.
  agencies: {
    AVN_1554: { label: "Avon Transit", climateZone: "mountain", gradeClass: "mountain",
                defaultVehicleClass: "cutaway",
                depot: { name: "Avon Regional Transit Facility", coords: [-106.505, 39.640] } },
    GET_4889: { label: "Greeley-Evans Transit", climateZone: "plains", gradeClass: "flat",
                defaultVehicleClass: "bus40",
                depot: { name: "GET Operations Center", coords: [-104.700, 40.430] } }
  },
  // Per-route overrides keyed by the prefixed route_id (e.g. "AVN_15142").
  // Any field may be omitted; the agency default applies. Empty by default —
  // every route in the merged feed currently uses its agency's defaults.
  routeOverrides: {
    // "GET_74434": { vehicleClass: "cutaway" },
    // "AVN_15142": { gradeClass: "rolling" }
  },
  tiers: [
    { tier: 1, label: "Ready today",              maxRatio: 0.75,     color: "#1a9850", reason: "Worst block uses at most 75% of the battery after the 20% safety buffer." },
    { tier: 2, label: "Feasible with margin",     maxRatio: 0.90,     color: "#91cf60", reason: "Worst block fits within the buffered battery with 10–25% margin." },
    { tier: 3, label: "Marginal",                 maxRatio: 1.00,     color: "#fee08b", reason: "Worst block only just meets the 20% buffer; small changes tip it over." },
    { tier: 4, label: "Needs midday charging",    maxRatio: 1.60,     color: "#fc8d59", reason: "Depot-only charging fails; a single opportunity charge would close the gap.",
      rechargeReason: "Block energy fits, but it cannot be recharged at 150 kW in the overnight window." },
    { tier: 5, label: "Not feasible depot-only",  maxRatio: Infinity, color: "#d73027", reason: "Required capacity exceeds 160% of the available battery." }
  ],
  di: {   // Disproportionately Impacted community proxy (Step 7)
    minorityShareMin: 0.40,
    povertyShareMin:  0.25,   // <100% FPL proxy for Enviroscreen's ≥40% <200% FPL criterion
    acsYear: "2023"
  }
};
