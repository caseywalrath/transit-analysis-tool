// Golden cases for the pure half of js/core/point-icons.js (window.PointIcons):
// the icon registry, image-id naming, the override > default > "dot" cascade
// and the MapLibre filter/anchor expressions. Canvas drawing, the picker and
// the App.* setters touch the DOM/map and are covered by
// test/browser/point-icons.test.mjs.

export default {
  scripts: ["js/core/point-icons.js"],
  cases: [
    // ---- registry ----
    { id: "list/markers", call: "PointIcons.list", args: ["markers"] },
    { id: "list/transit-ids", call: "PointIcons.list", args: ["transit"] },
    { id: "list/all-count", call: "PointIcons.list", args: [] },
    { id: "get/unknown-falls-back-to-dot", call: "PointIcons.get", args: ["nope"] },
    { id: "has/known", call: "PointIcons.has", args: ["bus"] },
    { id: "has/unknown", call: "PointIcons.has", args: ["nope"] },
    { id: "has/non-string", call: "PointIcons.has", args: [42] },
    { id: "has/prototype-key-is-not-an-icon", call: "PointIcons.has", args: ["toString"] },
    { id: "normalize/known", call: "PointIcons.normalize", args: ["pin"] },
    { id: "normalize/unknown", call: "PointIcons.normalize", args: ["nope"] },
    { id: "normalize/undefined", call: "PointIcons.normalize", args: [undefined] },

    // ---- colors ----
    { id: "hex6/six-digit-mixed-case", call: "PointIcons.hex6", args: ["#2B6CB0"] },
    { id: "hex6/three-digit", call: "PointIcons.hex6", args: ["#f80"] },
    { id: "hex6/no-hash", call: "PointIcons.hex6", args: ["e53e3e"] },
    { id: "hex6/css-name-falls-back", call: "PointIcons.hex6", args: ["red"] },
    { id: "hex6/empty-falls-back", call: "PointIcons.hex6", args: [""] },
    { id: "glyphColorFor/dark-fill-white-glyph", call: "PointIcons.glyphColorFor", args: ["#2b6cb0"] },
    { id: "glyphColorFor/light-fill-dark-glyph", call: "PointIcons.glyphColorFor", args: ["#ffd700"] },
    { id: "glyphColorFor/unparseable-uses-default-blue", call: "PointIcons.glyphColorFor", args: ["hsl(1,2%,3%)"] },

    // ---- image ids ----
    { id: "imageId/bus-blue", call: "PointIcons.imageId", args: ["bus", "#2B6CB0"] },
    { id: "imageId/dot-has-no-image", call: "PointIcons.imageId", args: ["dot", "#2b6cb0"] },
    { id: "imageId/unknown-is-dot-so-null", call: "PointIcons.imageId", args: ["nope", "#2b6cb0"] },
    { id: "imageId/hyphenated-id", call: "PointIcons.imageId", args: ["rail-metro", "#38a169"] },
    { id: "parseImageId/round-trip", call: "PointIcons.parseImageId", args: ["pi:rail-metro:38a169"] },
    { id: "parseImageId/foreign-image", call: "PointIcons.parseImageId", args: ["marker-15"] },
    { id: "parseImageId/dot-is-not-an-image", call: "PointIcons.parseImageId", args: ["pi:dot:38a169"] },
    { id: "parseImageId/bad-color", call: "PointIcons.parseImageId", args: ["pi:bus:red"] },

    // ---- cascade: _pointIcon > type default > dot ----
    { id: "resolve/override-wins", call: "PointIcons.resolve", args: [{ _pointIcon: "pin" }, "bus"] },
    { id: "resolve/falls-to-type-default", call: "PointIcons.resolve", args: [{}, "bus"] },
    { id: "resolve/explicit-dot-override-beats-default", call: "PointIcons.resolve", args: [{ _pointIcon: "dot" }, "bus"] },
    { id: "resolve/unknown-override-ignored", call: "PointIcons.resolve", args: [{ _pointIcon: "nope" }, "bus"] },
    { id: "resolve/unknown-default-is-dot", call: "PointIcons.resolve", args: [{}, "nope"] },
    { id: "resolve/no-props-no-default", call: "PointIcons.resolve", args: [null, undefined] },

    // ---- map expressions ----
    { id: "dotFilter", call: "PointIcons.dotFilter", args: [] },
    { id: "iconFilter", call: "PointIcons.iconFilter", args: [] },
    { id: "anchorExpr/only-pin-anchors-at-the-tip", call: "PointIcons.anchorExpr", args: [] }
  ]
};
