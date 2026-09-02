// Route Electrification Feasibility demo — reference overlay geometry.
// See docs/zeb-feasibility-demo-plan.md Step 3.2. Plain rectangles standing
// in for climate zones and utility service territories — illustrative service
// areas for a proposal screenshot, not official boundaries. Coordinates
// rounded to 3 decimals. Consumed by js/projects/zeb-overlays.js.
window.ZebOverlayData = {
  climateZones: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { zone: "mountain", label: "Mountain valley" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-107.000, 39.300], [-106.000, 39.300],
            [-106.000, 39.900], [-107.000, 39.900],
            [-107.000, 39.300]
          ]]
        }
      },
      {
        type: "Feature",
        properties: { zone: "plains", label: "Front Range plains" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-105.100, 40.100], [-104.300, 40.100],
            [-104.300, 40.700], [-105.100, 40.700],
            [-105.100, 40.100]
          ]]
        }
      }
    ]
  },
  utilities: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { utility: "Holy Cross Energy", type: "co-op", color: "#805ad5" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-106.800, 39.500], [-106.200, 39.500],
            [-106.200, 39.800], [-106.800, 39.800],
            [-106.800, 39.500]
          ]]
        }
      },
      {
        type: "Feature",
        properties: { utility: "Xcel Energy", type: "IOU", color: "#dd6b20" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-104.800, 40.370], [-104.640, 40.370],
            [-104.640, 40.470], [-104.800, 40.470],
            [-104.800, 40.370]
          ]]
        }
      },
      {
        type: "Feature",
        properties: { utility: "Poudre Valley REA", type: "co-op", color: "#3182ce" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-104.950, 40.280], [-104.500, 40.280],
              [-104.500, 40.560], [-104.950, 40.560],
              [-104.950, 40.280]
            ],
            [
              [-104.800, 40.370], [-104.800, 40.470],
              [-104.640, 40.470], [-104.640, 40.370],
              [-104.800, 40.370]
            ]
          ]
        }
      }
    ]
  }
};
