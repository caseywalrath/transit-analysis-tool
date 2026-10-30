// Golden cases for window.AttrBulk (js/core/attr-bulk.js): the multi-select
// rules of the attributes dock. The schema below is a trimmed copy of
// ATTR_FIELDS' shape (keys, flags) — enough to pin the rules, not the UI.

const TRANSIT = [
  { key: "group", label: "Group", type: "text", hidden: true },
  { key: "direction", label: "Direction", type: "select", section: "Transit service" },
  { key: "serviceId", label: "Service", type: "text", section: "Transit service" },
  { key: "avgSpeed", label: "Avg speed", type: "number", defaultValue: 14, section: "Transit service" },
];
const BUFFER = { key: "bufferRadius", label: "Buffer", type: "buffer-radius", section: "Study area",
  skipIf: { attr: "serviceAreaType", equals: "walkshed" } };
const SERVICE = { key: "service", label: "Service schedule", type: "service", bulk: "replace", section: "Service schedule" };
const FIELDS = {
  route: TRANSIT.concat([BUFFER, SERVICE]),
  line: TRANSIT.concat([{ key: "networkRole", label: "Walk network", type: "select" }, BUFFER, SERVICE]),
  point: [
    { key: "group", label: "Group", type: "text", hidden: true },
    { key: "stopId", label: "Stop ID", type: "text", bulk: false },
    { key: "associatedRoutes", label: "Routes", type: "routes", bulk: "replace" },
    { key: "serviceAreaType", label: "Service area", type: "select" },
    BUFFER,
  ],
  polygon: [
    { key: "group", label: "Group", type: "text", hidden: true },
    { key: "notes", label: "Notes", type: "text" },
  ],
  label: [
    { key: "fontSize", label: "Size", type: "select" },
    { key: "bgColor", label: "Background", type: "color" },
  ],
};

const f = (attrs, extra) => ({ properties: Object.assign({ attributes: attrs || {} }, extra || {}) });

export default {
  scripts: ["js/core/attr-bulk.js"],
  cases: [
    // R1 field intersection by type mix
    { id: "route+line-share-transit-buffer-service", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "route", feature: f({ direction: "NB" }) }, { type: "line", feature: f({ direction: "NB" }) }]] },
    { id: "point+route-share-buffer-only", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "point", feature: f({}) }, { type: "route", feature: f({}) }]] },
    { id: "polygon+route-share-nothing-visible", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "polygon", feature: f({}) }, { type: "route", feature: f({}) }]] },
    { id: "points-hide-identity-stopId", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "point", feature: f({ stopId: "1" }) }, { type: "point", feature: f({ stopId: "2" }) }]] },
    { id: "labels-share-size-and-background", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "label", feature: f({ fontSize: "Large", bgColor: "#fff" }) }, { type: "label", feature: f({ fontSize: "Large", bgColor: "#000" }) }]] },
    // R2 same / mixed, default-aware, string-vs-number
    { id: "avgSpeed-unset-equals-default-14", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "route", feature: f({}) }, { type: "route", feature: f({ avgSpeed: 14 }) }]] },
    { id: "avgSpeed-mixed", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "route", feature: f({ avgSpeed: 12 }) }, { type: "route", feature: f({ avgSpeed: 20 }) }]] },
    { id: "avgSpeed-string-15-equals-number-15", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "route", feature: f({ avgSpeed: "15" }) }, { type: "route", feature: f({ avgSpeed: 15 }) }]] },
    { id: "service-schedule-deep-compare", call: "AttrBulk.analyze",
      args: [FIELDS, [
        { type: "route", feature: f({ service: { weekday: [{ from: "06:00", to: "20:00", frequency: 15 }] } }) },
        { type: "line", feature: f({ service: { weekday: [{ from: "06:00", to: "20:00", frequency: 30 }] } }) }]] },
    // buffer radius reads properties._bufferRadius
    { id: "buffer-same-override", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "route", feature: f({}, { _bufferRadius: 0.5 }) }, { type: "line", feature: f({}, { _bufferRadius: 0.5 }) }]] },
    // R5 eligibility: walkshed points are skipped for Buffer
    { id: "buffer-skips-walkshed-points", call: "AttrBulk.analyze",
      args: [FIELDS, [
        { type: "point", feature: f({ serviceAreaType: "walkshed" }, { _bufferRadius: 1 }) },
        { type: "point", feature: f({}, { _bufferRadius: 0.25 }) },
        { type: "point", feature: f({}, { _bufferRadius: 0.25 }) }]] },
    { id: "buffer-none-eligible", call: "AttrBulk.analyze",
      args: [FIELDS, [{ type: "point", feature: f({ serviceAreaType: "walkshed" }) }, { type: "point", feature: f({ serviceAreaType: "walkshed" }) }]] },
    { id: "empty-selection", call: "AttrBulk.analyze", args: [FIELDS, []] },
    // type chips
    { id: "type-counts", call: "AttrBulk.typeCounts",
      args: [[{ type: "route" }, { type: "line" }, { type: "route" }, { type: "route" }, { type: "point" }]] },
  ],
};
