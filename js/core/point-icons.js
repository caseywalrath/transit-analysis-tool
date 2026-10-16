// js/core/point-icons.js
// Point icon styles (Dot, Pin, Square, Diamond, Star, transit and place glyphs)
// for drawn Points. Two halves, same convention as layer-palettes.js:
//
//  - window.PointIcons — PURE registry + helpers (no DOM, no map, nothing run
//    at load that touches either) so the golden harness can load this file in a
//    bare node:vm sandbox. The registry is the single place to add or retire
//    an icon: one ICONS entry (+ a GLYPHS path for a new symbol).
//  - App.* wiring — image drawing, the picker, and the type-default /
//    per-point setters. They touch App/map/DOM only inside function bodies.
//
// Cascade (Appearance popover row + Layers > Style Defaults row):
//   properties._pointIcon  >  App.featureSettings.pointIcon  >  "dot"
// The resolved id is stamped onto each map feature as `resolvedIcon` (like
// `resolvedColor`), never read raw by the layer filters — otherwise a type
// default would have to write every point.
//
// Rendering: "dot" stays the original circle layer (points-layer); every other
// icon is a symbol layer (points-icon-layer). Use App.pointLayerIds() for
// hit-testing, never the layer ids literally. The icon bitmaps are drawn here
// with canvas, one per icon x color ("pi:<icon>:<rrggbb>"), registered with
// map.addImage on demand. Drawing is synchronous (Path2D), so there is no
// async decode between "icon needed" and "icon available".
//
// Glyph artwork: Maki (https://github.com/mapbox/maki, v8.0.1), CC0 1.0 — the
// 15x15 icon paths are embedded below unmodified. Detail:
// docs/reference/drawing-and-features.md.

(function () {
  "use strict";

  var DEFAULT_ID = "dot";
  var BUILTIN_HEX = "2b6cb0";   // matches resolveFeatureColor's point fallback
  var PIXEL_RATIO = 3;          // bitmaps are drawn at 3x and displayed at 1x

  // Order here is the picker's order.
  var GROUPS = [
    { id: "markers", label: "Markers" },
    { id: "transit", label: "Transit" },
    { id: "places",  label: "Places" }
  ];

  // Display-pixel geometry at Size 1x. w/h include the white outline ring;
  // `anchor` is where the coordinate sits (pins point at it with their tip);
  // `glyph` is the box a symbol is centred in (scaled from Maki's 15px grid).
  var SHAPES = {
    dot:     { w: 16, h: 16, anchor: "center" },
    badge:   { w: 26, h: 26, anchor: "center", glyph: { cx: 13, cy: 13, size: 14 } },
    square:  { w: 26, h: 26, anchor: "center" },
    diamond: { w: 28, h: 28, anchor: "center" },
    star:    { w: 28, h: 28, anchor: "center" },
    pin:     { w: 26, h: 32, anchor: "bottom", glyph: { cx: 13, cy: 12, size: 12 } }
  };

  var GLYPHS = {
    "bus": "M2 3C2 1.9 2.9 1 4 1H11C12.1 1 13 1.9 13 3V11C13 12 12 12 12 12V13C12 13.55 11.55 14 11 14C10.45 14 10 13.55 10 13V12H5V13C5 13.55 4.55 14 4 14C3.45 14 3 13.55 3 13V12C2 12 2 11 2 11V3ZM3.5 4C3.22 4 3 4.22 3 4.5V7.5C3 7.78 3.22 8 3.5 8H11.5C11.78 8 12 7.78 12 7.5V4.5C12 4.22 11.78 4 11.5 4H3.5ZM4 9C3.45 9 3 9.45 3 10C3 10.55 3.45 11 4 11C4.55 11 5 10.55 5 10C5 9.45 4.55 9 4 9ZM11 9C10.45 9 10 9.45 10 10C10 10.55 10.45 11 11 11C11.55 11 12 10.55 12 10C12 9.45 11.55 9 11 9ZM4 2.5C4 2.78 4.22 3 4.5 3H10.5C10.78 3 11 2.78 11 2.5C11 2.22 10.78 2 10.5 2H4.5C4.22 2 4 2.22 4 2.5Z",
    "shelter": "M13 2L1 6V8L2 7.66667V13H12V11H4V7L13 4V2Z",
    "rail": "M 3 1 C 2.4477 1 2 1.4477 2 2 L 2 10 C 2 10.5523 2.4477 11 3 11 L 12 11 C 12.5523 11 13 10.5523 13 10 L 13 2 C 13 1.4477 12.5523 1 12 1 L 3 1 z M 5.75 1.5 L 5.7597656 1.5 L 9.2597656 1.5 C 9.3978656 1.5 9.5097656 1.6119 9.5097656 1.75 C 9.5097656 1.8881 9.3978656 2 9.2597656 2 L 5.75 2 C 5.6119 2 5.5 1.8881 5.5 1.75 C 5.5 1.6119 5.6119 1.5 5.75 1.5 z M 3.5 3 L 7 3 L 7 7 L 3.5 7 C 3.2239 7 3 6.7761 3 6.5 L 3 3.5 C 3 3.2239 3.2239 3 3.5 3 z M 8 3 L 11.5 3 C 11.7761 3 12 3.2239 12 3.5 L 12 6.5 C 12 6.7761 11.7761 7 11.5 7 L 8 7 L 8 3 z M 5 8 C 5.5523 8 6 8.4477 6 9 C 6 9.5523 5.5523 10 5 10 C 4.4477 10 4 9.5523 4 9 C 4 8.4477 4.4477 8 5 8 z M 10 8 C 10.5523 8 11 8.4477 11 9 C 11 9.5523 10.5523 10 10 10 C 9.4477 10 9 9.5523 9 9 C 9 8.4477 9.4477 8 10 8 z M 10.445312 11.994141 C 10.380597 11.999652 10.314981 12.018581 10.253906 12.050781 C 10.030606 12.168381 9.9302313 12.433922 10.019531 12.669922 L 10.189453 13 L 4.8105469 13 L 4.9394531 12.730469 C 5.0371531 12.472169 4.9067375 12.183637 4.6484375 12.085938 C 4.4124375 11.996738 4.1468969 12.097113 4.0292969 12.320312 L 3.0292969 14.320312 C 3.0080969 14.377912 2.9986 14.4387 3 14.5 C 3 14.7761 3.2239 15 3.5 15 C 3.6802 14.999 3.8450875 14.899434 3.9296875 14.740234 L 3.9296875 14.689453 L 4 14.689453 L 4.3105469 14 L 10.689453 14 L 11 14.689453 L 11 14.740234 C 11.0846 14.899434 11.249488 14.999 11.429688 15 C 11.705787 15 11.929688 14.7761 11.929688 14.5 C 11.949587 14.4212 11.949587 14.338566 11.929688 14.259766 L 10.929688 12.259766 C 10.833163 12.076541 10.639459 11.977608 10.445312 11.994141 z",
    "rail-metro": "M5.5,0c0,0-0.75,0-1,1L3,6.5V10c0,1,1,1,1,1h7c0,0,1,0,1-1V6.5L10.5,1c-0.2727-1-1-1-1-1H5.5z M6.5,1.5h2 c0,0,0.5357,0,0.75,1L10,6c0.2146,1.0017-1,1-1,1H6c0,0-1.2146,0.0017-1-1l0.75-3.5C5.9643,1.5,6.5,1.5,6.5,1.5z M5,8 c0.5523,0,1,0.4477,1,1s-0.4477,1-1,1S4,9.5523,4,9S4.4477,8,5,8z M6.75,8h1.5C8.3885,8,8.5,8.1115,8.5,8.25S8.3885,8.5,8.25,8.5 h-1.5C6.6115,8.5,6.5,8.3885,6.5,8.25S6.6115,8,6.75,8z M10,8c0.5523,0,1,0.4477,1,1s-0.4477,1-1,1S9,9.5523,9,9S9.4477,8,10,8z M4.125,12L3,15h1.5l0.375-1h5.25l0.375,1H12l-1.125-3h-1.5l0.375,1h-4.5l0.375-1H4.125z",
    "rail-light": "M5.5,0C5,0,5,0.5,5,0.5v1C5,1.777,5.223,2,5.5,2S6,1.777,6,1.5V1h1v2H6c0,0-2,0-2,2v3c0,3,3,3,3,3h1 c0,0,3,0,3-3V5c0-2-2-2-2-2H8V1h1v0.5C9,1.777,9.223,2,9.5,2S10,1.777,10,1.5v-1C10,0,9.5,0,9.5,0H5.5z M7.5,4l2.0449,0.7734L10,6.5 C10.1316,7,9.5,7,9.5,7h-4c0,0-0.6316,0-0.5-0.5l0.4551-1.7266L7.5,4z M7.5,8C7.7761,8,8,8.2239,8,8.5S7.7761,9,7.5,9 S7,8.7761,7,8.5S7.2239,8,7.5,8z M4.125,12L3,15h1.5l0.375-1h5.25l0.375,1H12l-1.125-3h-1.5l0.375,1h-4.5l0.375-1H4.125z",
    "ferry": "M5.33,11c0.6745,0.009,1.3262,0.245,1.85,0.67l0.26,0.23h0.05l0.31-0.28c0.9817-0.8115,2.379-0.8846,3.44-0.18L13.5,7L12,6 V2.45c-0.0466-0.8-0.6989-1.4305-1.5-1.45H10c0.0343-0.518-0.3579-0.9657-0.8759-1C9.0828-0.0027,9.0413-0.0027,9,0H6 C5.482-0.0343,5.0343,0.3579,5,0.8759C4.9973,0.9172,4.9973,0.9587,5,1H4.5C3.6989,1.0195,3.0466,1.65,3,2.45V6L1.5,7l2.25,4.53 C4.2143,11.2041,4.7631,11.02,5.33,11z M4,2.45c0.0105-0.2594,0.2293-0.4611,0.4886-0.4506C4.4924,1.9996,4.4962,1.9998,4.5,2h6 c0.259-0.0171,0.4829,0.1789,0.5,0.4379c0.0014,0.0207,0.0014,0.0414,0,0.0621v3l-3.5-2L4,5.45C4,5.45,4,2.45,4,2.45z M14,13v1 c-0.2626,0.0194-0.5069,0.1416-0.68,0.34c-0.2717,0.2883-0.6178,0.4959-1,0.6c-0.6147,0.1815-1.2795,0.0425-1.77-0.37l-0.39-0.35 c-0.3043-0.3026-0.7957-0.3026-1.1,0c-0.14,0.12-0.27,0.25-0.42,0.37c-0.7328,0.5856-1.7814,0.556-2.48-0.07l-0.39-0.35 c-0.2864-0.2502-0.7136-0.2502-1,0c-0.19,0.15-0.36,0.32-0.55,0.47c-0.7043,0.5215-1.6732,0.4968-2.35-0.06l-0.31-0.27 C1.4153,14.1443,1.2172,14.0346,1,14v-1c0.2585-0.032,0.5205,0.0169,0.75,0.14c0.2782,0.1722,0.5424,0.3661,0.79,0.58 c0.2051,0.2235,0.5147,0.319,0.81,0.25c0.1125-0.0333,0.2177-0.0876,0.31-0.16c0.16-0.12,0.29-0.26,0.45-0.39 c0.7106-0.5888,1.7394-0.5888,2.45,0c0.16,0.13,0.31,0.28,0.47,0.41c0.2864,0.2502,0.7136,0.2502,1,0c0.16-0.13,0.31-0.28,0.47-0.41 c0.7123-0.5943,1.7477-0.5943,2.46,0c0.15,0.13,0.29,0.27,0.44,0.39c0.2864,0.2502,0.7136,0.2502,1,0l0.47-0.41 C13.1895,13.1408,13.5886,12.9995,14,13z",
    "parking": "M4 2V13H6V9H8.5C10.433 9 12 7.433 12 5.5C12 3.567 10.433 2 8.5 2H4ZM6 7V4H8.5C9.32843 4 10 4.67157 10 5.5C10 6.32843 9.32843 7 8.5 7H6Z",
    "bicycle-share": "M10,1C9.4477,1,9,1.4477,9,2c0,0.5523,0.4477,1,1,1s1-0.4477,1-1C11,1.4477,10.5523,1,10,1z M8.1445,2.9941 c-0.13,0.0005-0.2547,0.0517-0.3477,0.1426l-2.6406,2.5c-0.2256,0.2128-0.2051,0.5775,0.043,0.7637L7,7.75v2.75 c-0.01,0.6762,1.0096,0.6762,1,0v-3c0.0003-0.1574-0.0735-0.3057-0.1992-0.4004L7.0332,6.5234l1.818-1.7212l0.7484,0.9985 C9.6943,5.9265,9.8426,6.0003,10,6h1.5c0.6761,0.01,0.6761-1.0096,0-1h-1.25L9.5,4L8.9004,3.1992 C8.8103,3.0756,8.6685,3,8.5156,2.9941H8.1445z M3,7c-1.6569,0-3,1.3432-3,3s1.3431,3,3,3s3-1.3432,3-3S4.6569,7,3,7z M12,7 c-1.6569,0-3,1.3432-3,3s1.3431,3,3,3s3-1.3432,3-3S13.6569,7,12,7z M3,8c1.1046,0,2,0.8954,2,2s-0.8954,2-2,2s-2-0.8954-2-2 S1.8954,8,3,8z M12,8c1.1046,0,2,0.8954,2,2s-0.8954,2-2,2s-2-0.8954-2-2S10.8954,8,12,8z",
    "airport": "M15,6.8182L15,8.5l-6.5-1 l-0.3182,4.7727L11,14v1l-3.5-0.6818L4,15v-1l2.8182-1.7273L6.5,7.5L0,8.5V6.8182L6.5,4.5v-3c0,0,0-1.5,1-1.5s1,1.5,1,1.5v2.8182 L15,6.8182z",
    "building": "M3,2v11h5v-3h3v3h1V2H3z M7,12H4v-2h3V12z M7,9H4V7h3V9z M7,6H4V4h3V6z M11,9H8V7h3V9z M11,6H8V4h3V6z",
    "commercial": "m14 6h-13c.0881-1.3829.427-2.7383 1-4h11c.5731 1.2617.9119 2.6171 1 4zm-11 1h9v6h-1v-5h-3v5h-5zm1 3h3v-2h-3z",
    "residential-community": "m11.8 12.5v-2.5c.7-.1 1.2-.7 1.2-1.5s-.7-1.5-1.5-1.5-1.5.7-1.5 1.5c0 .7.5 1.4 1.2 1.5v2.5h-4.2v-11.5h-5v11.5h-1v.5h13v-.5zm-5.8-2.5h-3v-1h3zm0-2h-3v-1h3zm0-2h-3v-1h3zm0-2h-3v-1h3z",
    "home": "M2,13.7478c0,0.13807,0.11193,0.25,0.25,0.25h3.749v-3h3v3h3.749c0.13807,0,0.25-0.11193,0.25-0.25V7.9987H2 C2,7.9987,2,13.7478,2,13.7478z M13.93,6.5778l-0.9319-0.8189V2c0-0.55228-0.44771-1-1-1s-1,0.44772-1,1v2L7.6808,1.09 C7.5863,0.9897,7.42846,0.98478,7.3279,1.079L7.3169,1.09L1.0678,6.553C0.9734,6.65376,0.97856,6.81197,1.07932,6.90637 C1.12478,6.94896,1.18451,6.97304,1.2468,6.9739L3,6.9989h10.7468c0.13807,0.00046,0.25037-0.1111,0.25083-0.24917 C13.99784,6.68592,13.97365,6.62445,13.93,6.5779V6.5778z",
    "industry": "M14,1v12H1V8.72c0.0016-0.1419,0.0634-0.2764,0.17-0.37l3-3.22c0.2074-0.1823,0.5234-0.1618,0.7056,0.0456 C4.9568,5.268,5.0011,5.387,5,5.51v3l3.16-3.37c0.2025-0.1878,0.5188-0.1759,0.7066,0.0266C8.9532,5.2599,9.0009,5.3827,9,5.51V11h3 V1H14z",
    "warehouse": "M13.5,5c-0.0762,0.0003-0.1514-0.0168-0.22-0.05L7.5,2L1.72,4.93C1.4632,5.0515,1.1565,4.9418,1.035,4.685 S1.0232,4.1215,1.28,4L7.5,0.92L13.72,4c0.2761,0.0608,0.4508,0.3339,0.39,0.61C14.0492,4.8861,13.7761,5.0608,13.5,5z M5,10H2v3h3 V10z M9,10H6v3h3V10z M13,10h-3v3h3V10z M11,6H8v3h3V6z M7,6H4v3h3V6z",
    "shop": "m13.33 5h-1.83l-.39-2.33c-.1601-.7182-.7017-1.2905-1.41-1.49-.3493-.1124-.7131-.173-1.08-.18h-2.24c-.3669.007-.7307.0676-1.08.18-.7083.1995-1.2499.7718-1.41 1.49l-.39 2.33h-1.83c-.2761-.0017-.5013.2208-.503.497-.0003.0519.0074.1035.023.153l1.88 6.3c.1964.6246.7753 1.0496 1.43 1.05h6c.651-.0047 1.2247-.4289 1.42-1.05l1.88-6.3c.0829-.2634-.0635-.5441-.3269-.627-.0463-.0146-.0945-.0223-.1431-.023zm-8.81 0 .36-2.17c.0807-.3625.3736-.6395.74-.7.2463-.0776.5019-.1213.76-.13h2.24c.2614.0078.5205.0515.77.13.3664.0605.6593.3375.74.7l.35 2.17h-6z",
    "grocery": "M 13.199219 1.5 C 13.199219 1.5 11.808806 1.4588 11.253906 2 C 10.720406 2.5202 10.5 2.9177 10.5 4 L 1.1992188 4 L 2.59375 8.8144531 C 2.59725 8.8217531 2.6036219 8.8287375 2.6074219 8.8359375 C 2.8418219 9.4932375 3.4545469 9.9666406 4.1855469 9.9941406 C 4.1885469 9.9954406 4.1992187 10 4.1992188 10 L 10.699219 10 L 10.699219 10.199219 C 10.699219 10.199219 10.7 10.500391 10.5 10.900391 C 10.3 11.300391 10.200391 11.5 9.4003906 11.5 L 2.9003906 11.5 C 1.9003906 11.5 1.9003906 13 2.9003906 13 L 4.0996094 13 L 4.1992188 13 L 9.0996094 13 L 9.1992188 13 L 9.3007812 13 C 10.500781 13 11.399219 12.299609 11.699219 11.599609 C 11.999219 10.899609 12 10.300781 12 10.300781 L 12 10 L 12 4 C 12 3.4764 12.228619 3 12.699219 3 L 13.25 3 C 13.6642 3 14 2.6642 14 2.25 C 14 1.8358 13.6642 1.5 13.25 1.5 L 13.199219 1.5 z M 9.1992188 13 C 8.5992188 13 8.1992188 13.4 8.1992188 14 C 8.1992188 14.6 8.5992187 15 9.1992188 15 C 9.7992187 15 10.199219 14.6 10.199219 14 C 10.199219 13.4 9.7992188 13 9.1992188 13 z M 4.1992188 13 C 3.5992188 13 3.1992188 13.4 3.1992188 14 C 3.1992188 14.6 3.5992187 15 4.1992188 15 C 4.7992188 15 5.1992188 14.6 5.1992188 14 C 5.1992188 13.4 4.7992187 13 4.1992188 13 z",
    "town-hall": "M13,4H9l0-3L7.5,0L6,1v3H2L1,5v1h13V5L13,4z M7.5,1.5c0.4,0,0.7,0.3,0.7,0.8S7.9,3,7.5,3S6.7,2.7,6.7,2.2 C6.7,1.8,7.1,1.5,7.5,1.5z M13,7H2v4l-1,1.5V14h13v-1.5L13,11V7z M5,12.5H4V8h1V12.5z M8,12.5H7V8h1V12.5z M11,12.5h-1V8h1V12.5z",
    "school": "M5.542 3.647 3.106 3l.443-1.63a.505.505 0 0 1 .618-.352l1.46.392a.5.5 0 0 1 .355.613l-.44 1.624Zm-4.52 7.356a.496.496 0 0 1-.005-.276l1.819-6.726 2.435.647-1.819 6.726a.499.499 0 0 1-.143.237l-1.457 1.347a.152.152 0 0 1-.247-.066l-.583-1.889ZM10 5c-2.25 0-3-.75-3-3 2.25 0 3 .75 3 3Zm-1.4 7.984c-1.37.21-3.126-1.706-3.52-3.8L5.969 5.9c.399-.35.903-.533 1.419-.533a2.71 2.71 0 0 1 1.564.489.964.964 0 0 0 1.089-.01 2.438 2.438 0 0 1 1.46-.479c.77 0 1.643.489 2.05 1.201 1.536 2.696-1.194 6.709-3.144 6.417a.867.867 0 0 1-.255-.093 1.427 1.427 0 0 0-1.302 0 .866.866 0 0 1-.25.092Z",
    "college": "M7.5,1L0,4.5l2,0.9v1.7C1.4,7.3,1,7.9,1,8.5s0.4,1.2,1,1.4V10l-0.9,2.1 C0.8,13,1,14,2.5,14s1.7-1,1.4-1.9L3,10c0.6-0.3,1-0.8,1-1.5S3.6,7.3,3,7.1V5.9L7.5,8L15,4.5L7.5,1z M11.9,7.5l-4.5,2L5,8.4v0.1 c0,0.7-0.3,1.3-0.8,1.8l0.6,1.4v0.1C4.9,12.2,5,12.6,4.9,13c0.7,0.3,1.5,0.5,2.5,0.5c3.3,0,4.5-2,4.5-3L11.9,7.5L11.9,7.5z",
    "hospital": "M7,1C6.4,1,6,1.4,6,2v4H2C1.4,6,1,6.4,1,7v1 c0,0.6,0.4,1,1,1h4v4c0,0.6,0.4,1,1,1h1c0.6,0,1-0.4,1-1V9h4c0.6,0,1-0.4,1-1V7c0-0.6-0.4-1-1-1H9V2c0-0.6-0.4-1-1-1H7z",
    "library": "M1.0819,9.9388C0.9871,9.867,1.0007,9.7479,1.0007,9.7479L1.5259,3.5c0,0,0.0082-0.0688,0.0388-0.104 C1.584,3.374,1.6084,3.342,1.6544,3.3232C2.1826,3.1072,5.0537,1.5519,6.5,3c0.2397,0.2777,0.4999,0.6876,0.4999,1v5.2879 c0,0,0.0062,0.1122-0.0953,0.1801c-0.0239,0.016-0.124,0.0616-0.242,0.0026c-2.2253-1.1134-4.711,0.1546-5.3381,0.4871 C1.1987,10.0244,1.1006,9.9531,1.0819,9.9388z M13.6754,9.9577c-0.6271-0.3325-3.1128-1.6005-5.3381-0.4871 c-0.118,0.059-0.2181,0.0134-0.242-0.0026C7.9939,9.4001,8.0001,9.2879,8.0001,9.2879V4c0-0.3124,0.2602-0.7223,0.4999-1 c1.4463-1.4481,4.2991,0.1071,4.8273,0.3232c0.046,0.0188,0.0704,0.0508,0.0897,0.0728C13.4476,3.4312,13.4558,3.5,13.4558,3.5 l0.5435,6.2479c0,0,0.0136,0.1191-0.0812,0.1909C13.8994,9.9531,13.8013,10.0244,13.6754,9.9577z M8.8647,12.6863 c0.0352-0.0085,0.0964-0.0443,0.1179-0.0775c0.0236-0.0364,0.0378-0.0617,0.0423-0.1088c0.0495-0.9379,1.6245-1.8119,4.6477-0.0298 c0.0775,0.0441,0.1666,0.0396,0.2425-0.0155C14.0014,12.392,14,12.2859,14,12.2859v-0.5542c0,0,0.0003-0.0764-0.0272-0.1184 c-0.0205-0.0312-0.0476-0.0643-0.0926-0.0858c-2.0254-1.3145-4.5858-1.8972-5.8854-0.1592 c-0.0181,0.0423-0.0353,0.0613-0.0728,0.0905C7.8654,11.5028,7.7964,11.5,7.7964,11.5H7.2109c0,0-0.069,0.0028-0.1256-0.0412 c-0.0375-0.0292-0.0547-0.0482-0.0728-0.0905c-1.2996-1.738-3.86-1.1828-5.8854,0.1317c-0.045,0.0215-0.0721,0.0546-0.0926,0.0858 c-0.0275,0.042-0.0272,0.1184-0.0272,0.1184v0.5542c0,0-0.0014,0.1061,0.0849,0.1688c0.0759,0.0551,0.165,0.0596,0.2425,0.0155 c3.0232-1.7821,4.5982-0.8806,4.6477,0.0573c0.0045,0.0471,0.0187,0.0724,0.0423,0.1088c0.0215,0.0332,0.0827,0.069,0.1179,0.0775 C6.8645,12.8656,7.9112,12.9363,8.8647,12.6863z",
    "park": "M14,5.75c0.0113-0.6863-0.3798-1.3159-1-1.61C12.9475,3.4906,12.4014,2.9926,11.75,3 c-0.0988,0.0079-0.1962,0.0281-0.29,0.06c-0.0607-0.66-0.6449-1.1458-1.3048-1.0851C9.8965,1.9987,9.6526,2.1058,9.46,2.28l0,0 c0-0.6904-0.5596-1.25-1.25-1.25S6.96,1.5896,6.96,2.28C6.96,2.28,7,2.3,7,2.33C6.4886,1.8913,5.7184,1.9503,5.2797,2.4618 C5.1316,2.6345,5.0347,2.8451,5,3.07C4.8417,3.0195,4.6761,2.9959,4.51,3C3.6816,2.9931,3.0044,3.659,2.9975,4.4874 C2.9958,4.6872,3.0341,4.8852,3.11,5.07C2.3175,5.2915,1.8546,6.1136,2.0761,6.9061C2.2163,7.4078,2.6083,7.7998,3.11,7.94 c0.2533,0.7829,1.0934,1.2123,1.8763,0.959C5.5216,8.7258,5.9137,8.2659,6,7.71C6.183,7.8691,6.4093,7.9701,6.65,8v5L5,14h5l-1.6-1 v-2c0.7381-0.8915,1.6915-1.5799,2.77-2c0.8012,0.1879,1.603-0.3092,1.7909-1.1103C12.9893,7.7686,13.0025,7.6444,13,7.52 c0.0029-0.0533,0.0029-0.1067,0-0.16C13.6202,7.0659,14.0113,6.4363,14,5.75z M8.4,10.26V6.82C8.6703,7.3007,9.1785,7.5987,9.73,7.6 h0.28c0.0156,0.4391,0.2242,0.849,0.57,1.12C9.7643,9.094,9.0251,9.6162,8.4,10.26z",
    "lodging": "M0.5,2.5C0.2,2.5,0,2.7,0,3v7.5v2C0,12.8,0.2,13,0.5,13S1,12.8,1,12.5V11h13v1.5 c0,0.3,0.2,0.5,0.5,0.5s0.5-0.2,0.5-0.5v-2c0-0.3-0.2-0.5-0.5-0.5H1V3C1,2.7,0.8,2.5,0.5,2.5z M3.5,3C2.7,3,2,3.7,2,4.5l0,0 C2,5.3,2.7,6,3.5,6l0,0C4.3,6,5,5.3,5,4.5l0,0C5,3.7,4.3,3,3.5,3L3.5,3z M7,4C5.5,4,5.5,5.5,5.5,5.5V7h-3C2.2,7,2,7.2,2,7.5v1 C2,8.8,2.2,9,2.5,9H6h9V6.5C15,4,12.5,4,12.5,4H7z",
    "restaurant": "M3.5,0l-1,5.5c-0.1464,0.805,1.7815,1.181,1.75,2L4,14c-0.0384,0.9993,1,1,1,1s1.0384-0.0007,1-1L5.75,7.5 c-0.0314-0.8176,1.7334-1.1808,1.75-2L6.5,0H6l0.25,4L5.5,4.5L5.25,0h-0.5L4.5,4.5L3.75,4L4,0H3.5z M12,0 c-0.7364,0-1.9642,0.6549-2.4551,1.6367C9.1358,2.3731,9,4.0182,9,5v2.5c0,0.8182,1.0909,1,1.5,1L10,14c-0.0905,0.9959,1,1,1,1 s1,0,1-1V0z",
    "stadium": "M7,1v2v1.5v0.5098C4.1695,5.1037,2.0021,5.9665,2,7v4.5c0,1.1046,2.4624,2,5.5,2s5.5-0.8954,5.5-2V7 c-0.0021-1.0335-2.1695-1.8963-5-1.9902V4.0625L11,2.75L7,1z M3,8.1465c0.5148,0.2671,1.2014,0.4843,2,0.6328v2.9668 C3.7948,11.477,3,11.0199,3,10.5V8.1465z M12,8.1484V10.5c0,0.5199-0.7948,0.977-2,1.2461V8.7812 C10.7986,8.6328,11.4852,8.4155,12,8.1484z M6,8.9219C6.4877,8.973,6.9925,8.9992,7.5,9C8.0073,8.9999,8.5121,8.9743,9,8.9238 v2.9844C8.5287,11.964,8.0288,12,7.5,12S6.4713,11.964,6,11.9082V8.9219z"
  };

  var ICONS = [
    { id: "dot",     label: "Dot",     group: "markers", shape: "dot" },
    { id: "pin",     label: "Pin",     group: "markers", shape: "pin" },
    { id: "square",  label: "Square",  group: "markers", shape: "square" },
    { id: "diamond", label: "Diamond", group: "markers", shape: "diamond" },
    { id: "star",    label: "Star",    group: "markers", shape: "star" },

    { id: "bus",           label: "Bus",              group: "transit", shape: "badge", glyph: "bus" },
    { id: "shelter",       label: "Bus shelter",      group: "transit", shape: "badge", glyph: "shelter" },
    { id: "rail",          label: "Rail",             group: "transit", shape: "badge", glyph: "rail" },
    { id: "rail-metro",    label: "Metro / subway",   group: "transit", shape: "badge", glyph: "rail-metro" },
    { id: "rail-light",    label: "Light rail / tram", group: "transit", shape: "badge", glyph: "rail-light" },
    { id: "ferry",         label: "Ferry",            group: "transit", shape: "badge", glyph: "ferry" },
    { id: "parking",       label: "Park & ride",      group: "transit", shape: "badge", glyph: "parking" },
    { id: "bicycle-share", label: "Bike share",       group: "transit", shape: "badge", glyph: "bicycle-share" },
    { id: "airport",       label: "Airport",          group: "transit", shape: "badge", glyph: "airport" },

    { id: "building",    label: "Building",     group: "places", shape: "badge", glyph: "building" },
    { id: "commercial",  label: "Office",       group: "places", shape: "badge", glyph: "commercial" },
    { id: "residential-community", label: "Apartments", group: "places", shape: "badge", glyph: "residential-community" },
    { id: "home",        label: "House",        group: "places", shape: "badge", glyph: "home" },
    { id: "industry",    label: "Industrial",   group: "places", shape: "badge", glyph: "industry" },
    { id: "warehouse",   label: "Warehouse",    group: "places", shape: "badge", glyph: "warehouse" },
    { id: "shop",        label: "Retail",       group: "places", shape: "badge", glyph: "shop" },
    { id: "grocery",     label: "Grocery",      group: "places", shape: "badge", glyph: "grocery" },
    { id: "town-hall",   label: "Government",   group: "places", shape: "badge", glyph: "town-hall" },
    { id: "school",      label: "School",       group: "places", shape: "badge", glyph: "school" },
    { id: "college",     label: "College",      group: "places", shape: "badge", glyph: "college" },
    { id: "hospital",    label: "Hospital",     group: "places", shape: "badge", glyph: "hospital" },
    { id: "library",     label: "Library",      group: "places", shape: "badge", glyph: "library" },
    { id: "park",        label: "Park",         group: "places", shape: "badge", glyph: "park" },
    { id: "lodging",     label: "Hotel",        group: "places", shape: "badge", glyph: "lodging" },
    { id: "restaurant",  label: "Restaurant",   group: "places", shape: "badge", glyph: "restaurant" },
    { id: "stadium",     label: "Stadium",      group: "places", shape: "badge", glyph: "stadium" }
  ];

  var BY_ID = {};
  ICONS.forEach(function (ic) { BY_ID[ic.id] = ic; });

  function has(id) {
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(BY_ID, id);
  }
  function get(id) { return has(id) ? BY_ID[id] : BY_ID[DEFAULT_ID]; }
  // Unknown / absent ids collapse to the dot, so a bad value can never hide a point.
  function normalize(id) { return has(id) ? id : DEFAULT_ID; }
  function list(groupId) {
    return ICONS.filter(function (ic) { return !groupId || ic.group === groupId; });
  }

  // "#RGB" / "#RRGGBB" (any case) -> "rrggbb"; anything else -> the built-in blue.
  function hex6(color) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(color == null ? "" : color).trim());
    if (m) return m[1].toLowerCase();
    var s = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(color == null ? "" : color).trim());
    if (s) return (s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    return BUILTIN_HEX;
  }

  // Symbol colour on a filled shape: white, unless the fill is light enough
  // that white would wash out (yellows, pale oranges).
  function glyphColorFor(color) {
    var h = hex6(color);
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.68 ? "#1a202c" : "#ffffff";
  }

  // Registered image name for an icon in a colour; null for the dot (drawn by
  // the circle layer, no image).
  function imageId(id, color) {
    var n = normalize(id);
    if (n === DEFAULT_ID) return null;
    return "pi:" + n + ":" + hex6(color);
  }
  function parseImageId(name) {
    var m = /^pi:([^:]+):([0-9a-f]{6})$/.exec(String(name));
    return (m && has(m[1]) && m[1] !== DEFAULT_ID) ? { id: m[1], hex: m[2] } : null;
  }

  // Per-point override, else the type default, else the dot.
  function resolve(props, defaultId) {
    if (props && has(props._pointIcon)) return props._pointIcon;
    return normalize(defaultId);
  }

  // MapLibre filters/expressions. Total over absent values: a feature with no
  // resolvedIcon is a dot, so it can never fall out of both layers.
  function dotFilter()  { return ["==", ["coalesce", ["get", "resolvedIcon"], DEFAULT_ID], DEFAULT_ID]; }
  function iconFilter() { return ["!=", ["coalesce", ["get", "resolvedIcon"], DEFAULT_ID], DEFAULT_ID]; }
  function anchorExpr() {
    var bottom = ICONS.filter(function (ic) { return SHAPES[ic.shape].anchor === "bottom"; })
      .map(function (ic) { return ic.id; });
    return ["match", ["get", "resolvedIcon"], bottom, "bottom", "center"];
  }

  window.PointIcons = {
    DEFAULT_ID: DEFAULT_ID, PIXEL_RATIO: PIXEL_RATIO,
    GROUPS: GROUPS, ICONS: ICONS, SHAPES: SHAPES, GLYPHS: GLYPHS,
    has: has, get: get, normalize: normalize, list: list,
    hex6: hex6, glyphColorFor: glyphColorFor,
    imageId: imageId, parseImageId: parseImageId, resolve: resolve,
    dotFilter: dotFilter, iconFilter: iconFilter, anchorExpr: anchorExpr
  };

  // ===========================================================================
  // App wiring (nothing below runs at load)
  // ===========================================================================
  var App = window.App = window.App || {};
  var PI = window.PointIcons;

  App.POINT_LAYER_IDS = ["points-icon-layer", "points-layer"];
  // Every MapLibre layer a drawn Point can be hit on (icon layer first: it is on top).
  App.pointLayerIds = function () { return App.POINT_LAYER_IDS.slice(); };
  App.isPointLayerId = function (id) { return App.POINT_LAYER_IDS.indexOf(id) >= 0; };

  // ---- Drawing ----
  function shapePath(shape) {
    var p = new Path2D(), i;
    if (shape === "badge") {
      p.arc(13, 13, 11, 0, Math.PI * 2);
    } else if (shape === "square") {
      var x = 2.5, y = 2.5, w = 21, h = 21, r = 4;
      p.moveTo(x + r, y);
      p.arcTo(x + w, y, x + w, y + h, r);
      p.arcTo(x + w, y + h, x, y + h, r);
      p.arcTo(x, y + h, x, y, r);
      p.arcTo(x, y, x + w, y, r);
      p.closePath();
    } else if (shape === "diamond") {
      p.moveTo(14, 2.5); p.lineTo(25.5, 14); p.lineTo(14, 25.5); p.lineTo(2.5, 14); p.closePath();
    } else if (shape === "star") {
      for (i = 0; i < 10; i++) {
        var ang = -Math.PI / 2 + i * Math.PI / 5, rad = (i % 2 === 0) ? 12 : 5;
        var px = 14 + rad * Math.cos(ang), py = 15 + rad * Math.sin(ang);
        if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
      }
      p.closePath();
    } else if (shape === "pin") {
      // Teardrop: straight tangents from the tip to a circular head.
      var cx = 13, cy = 12, hr = 10, tipY = 30.5;
      var th = Math.acos(hr / (tipY - cy));
      p.moveTo(cx, tipY);
      p.lineTo(cx + hr * Math.sin(th), cy + hr * Math.cos(th));
      p.arc(cx, cy, hr, Math.PI / 2 - th, Math.PI / 2 + th, true);
      p.closePath();
    }
    return p;
  }

  // Draws icon `id` filled with `color` onto ctx at `ratio` device px per
  // display px. The white ring is a wide stroke under the fill, so it sits
  // outside the shape like the dot's white outline.
  function drawIcon(ctx, id, color, ratio) {
    var def = PI.get(id), S = SHAPES[def.shape], fill = "#" + PI.hex6(color);
    ctx.save();
    ctx.scale(ratio, ratio);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (def.shape === "dot") {
      ctx.beginPath();
      ctx.arc(S.w / 2, S.h / 2, 6, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      ctx.fillStyle = fill; ctx.fill();
    } else {
      var path = shapePath(def.shape);
      ctx.lineWidth = 3; ctx.strokeStyle = "#ffffff"; ctx.stroke(path);
      ctx.fillStyle = fill; ctx.fill(path);
      var g = S.glyph;
      if (def.glyph && g && GLYPHS[def.glyph]) {
        ctx.translate(g.cx - g.size / 2, g.cy - g.size / 2);
        ctx.scale(g.size / 15, g.size / 15);
        ctx.fillStyle = PI.glyphColorFor(color);
        ctx.fill(new Path2D(GLYPHS[def.glyph]));
      } else if (def.shape === "pin") {
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = PI.glyphColorFor(color);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function makeCanvas(id, color, ratio) {
    var S = SHAPES[PI.get(id).shape];
    var c = document.createElement("canvas");
    c.width = Math.ceil(S.w * ratio);
    c.height = Math.ceil(S.h * ratio);
    drawIcon(c.getContext("2d"), id, color, ratio);
    return c;
  }

  // Registers the bitmap for an image name if the map does not have it yet.
  function ensureImage(name) {
    var map = App.map, parsed = PI.parseImageId(name);
    if (!map || !parsed || map.hasImage(name)) return false;
    var c = makeCanvas(parsed.id, "#" + parsed.hex, PIXEL_RATIO);
    map.addImage(name, c.getContext("2d").getImageData(0, 0, c.width, c.height), { pixelRatio: PIXEL_RATIO });
    return true;
  }
  App.ensurePointIconImage = ensureImage;

  // Safety net: any symbol that references an image we have not drawn yet
  // (first paint after a session restore, undo, a future setStyle) gets it
  // here, synchronously, instead of rendering blank.
  var _missingHandlerOn = false;
  App.installPointIconMissingHandler = function () {
    if (_missingHandlerOn || !App.map) return;
    _missingHandlerOn = true;
    App.map.on("styleimagemissing", function (e) { ensureImage(e.id); });
  };

  // Stamps the map-facing icon props on a point's GeoJSON props. Shared by
  // pointsGeoJSON(), the drag preview (editing.js) and the highlight source
  // (selection.js) so none of them can drop the icon.
  App.stampPointIcon = function (props, feature, color) {
    var id = PI.resolve(feature && feature.properties, (App.featureSettings || {}).pointIcon);
    props.resolvedIcon = id;
    var name = PI.imageId(id, color);
    props.iconImage = name || "";
    if (name) ensureImage(name);
    return props;
  };

  App.resolvePointIcon = function (feature) {
    return PI.resolve(feature && feature.properties, (App.featureSettings || {}).pointIcon);
  };

  // Data URL of an icon, for places that cannot take a canvas (SVG <image>,
  // the presentation legend's HTML string). Cached per icon x color.
  var _urlCache = {};
  App.pointIconDataURL = function (id, color) {
    var key = PI.normalize(id) + ":" + PI.hex6(color);
    if (!_urlCache[key]) _urlCache[key] = makeCanvas(id, color, 2).toDataURL("image/png");
    return _urlCache[key];
  };

  // A <canvas> preview of an icon sized to fit `maxH` display px tall (never
  // enlarged past its natural size).
  App.buildPointIconPreview = function (id, color, maxH) {
    var S = SHAPES[PI.get(id).shape];
    var k = Math.min(1, (maxH || S.h) / S.h);
    var ratio = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
    var c = makeCanvas(id, color, ratio * k);
    c.style.width = Math.round(S.w * k) + "px";
    c.style.height = Math.round(S.h * k) + "px";
    c.className = "pi-preview";
    c.setAttribute("aria-hidden", "true");
    return c;
  };

  // Features-list / Layers-tab row button: a point with a non-Dot icon shows
  // that icon (in its color) instead of the generic dot glyph.
  App.applyPointTypeIcon = function (btn, feature) {
    var id = App.resolvePointIcon(feature);
    if (id === PI.DEFAULT_ID) return;
    btn.innerHTML = "";
    btn.appendChild(App.buildPointIconPreview(id, App.resolveFeatureColor("point", feature), 18));
  };

  // ---- Setters ----
  function afterChange() {
    if (typeof App.renderPointLayers === "function") App.renderPointLayers();
    if (typeof App.refreshSelectionHighlight === "function") App.refreshSelectionHighlight();
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    if (typeof App.refreshLayersPanel === "function") App.refreshLayersPanel();
  }

  // Per-point override. iconId null/""/unknown clears it (follow the type
  // default). One undo step. Returns false for a missing point.
  App.setFeaturePointIcon = function (index, iconId) {
    var f = App.points && App.points[index];
    if (!f) return false;
    var next = PI.has(iconId) ? iconId : null;
    var cur = PI.has(f.properties._pointIcon) ? f.properties._pointIcon : null;
    if (next === cur) return true;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    if (next) f.properties._pointIcon = next; else delete f.properties._pointIcon;
    afterChange();
    return true;
  };

  // Type default from Layers > Style Defaults. "Last action wins", like
  // App.setTypeColor: every point drops its own icon so it follows the new
  // default. One undo step.
  App.setTypePointIcon = function (iconId) {
    if (!App.featureSettings) return;
    var next = PI.normalize(iconId);
    var hasOverrides = (App.points || []).some(function (p) { return p.properties._pointIcon !== undefined; });
    if (next === PI.normalize(App.featureSettings.pointIcon) && !hasOverrides) return;
    if (App.undo && !App.undo.isRestoring()) App.undo.push();
    App.featureSettings.pointIcon = next;
    (App.points || []).forEach(function (p) { delete p.properties._pointIcon; });
    afterChange();
  };

  // ---- Picker ----
  var _picker = null, _pickerAnchor = null, _pickerClosedAt = null, _pickerListeners = false;

  function closePicker() {
    if (_picker && _picker.parentNode) _picker.parentNode.removeChild(_picker);
    _picker = null; _pickerAnchor = null;
  }
  App.closePointIconPicker = closePicker;
  App.isPointIconPickerOpen = function () { return !!_picker; };

  function installPickerListeners() {
    if (_pickerListeners) return;
    _pickerListeners = true;
    document.addEventListener("mousedown", function (e) {
      if (!_picker || _picker.contains(e.target)) return;
      // Remember what was open so the opener's own click toggles it closed
      // instead of reopening it (the opener is often rebuilt by a panel refresh).
      _pickerClosedAt = { anchor: _pickerAnchor, at: Date.now() };
      closePicker();
    }, true);
    document.addEventListener("keydown", function (e) {
      if (_picker && e.key === "Escape") { closePicker(); e.stopPropagation(); }
    }, true);
  }

  // opts: { value: current icon id, color: hex for the previews, onPick(id) }
  App.openPointIconPicker = function (anchorEl, opts) {
    opts = opts || {};
    if (_picker && _pickerAnchor === anchorEl) { closePicker(); return; }
    var co = _pickerClosedAt;
    _pickerClosedAt = null;
    if (co && co.anchor === anchorEl && Date.now() - co.at < 500) return;
    closePicker();
    installPickerListeners();

    var pop = document.createElement("div");
    pop.id = "fp-icon-picker";
    pop.className = "pi-picker";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Point icon");
    var current = PI.normalize(opts.value);
    PI.GROUPS.forEach(function (g) {
      var title = document.createElement("div");
      title.className = "pi-group-title";
      title.textContent = g.label;
      pop.appendChild(title);
      var grid = document.createElement("div");
      grid.className = "pi-grid";
      grid.setAttribute("role", "radiogroup");
      grid.setAttribute("aria-label", g.label);
      PI.list(g.id).forEach(function (ic) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "pi-tile" + (ic.id === current ? " is-active" : "");
        b.title = ic.label;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", ic.id === current ? "true" : "false");
        b.setAttribute("aria-label", ic.label);
        b.setAttribute("data-icon", ic.id);
        b.appendChild(App.buildPointIconPreview(ic.id, opts.color, 30));
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          closePicker();
          if (typeof opts.onPick === "function") opts.onPick(ic.id);
        });
        grid.appendChild(b);
      });
      pop.appendChild(grid);
    });
    document.body.appendChild(pop);
    _picker = pop; _pickerAnchor = anchorEl;

    var rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : { left: 80, bottom: 80, top: 80 };
    var pw = pop.offsetWidth || 236, ph = pop.offsetHeight || 300;
    var left = rect.left, top = rect.bottom + 6;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(4, rect.top - ph - 6);
    pop.style.left = Math.max(4, Math.round(left)) + "px";
    pop.style.top = Math.max(4, Math.round(top)) + "px";
  };
})();
