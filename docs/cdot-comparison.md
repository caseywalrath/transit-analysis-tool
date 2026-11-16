# Walkshed comparison: OpenStreetMap vs CDOT road layers

Status: template, to be filled in by the project lead. Plan: `docs/cdot-roads-plan.md`.

## How to run one row

1. Add Data → CDOT Roads for Street Routing… Set the layers for the row; click "Use CDOT for street
   downloads" (or, for an OSM row, make sure the button reads "Use CDOT…", i.e. CDOT is off, and no FLM
   tile source is set).
2. Place the origin point (coordinates below), open Walkshed, set walk speed 2.8 mph and time bands
   5, 10, 15 minutes, click Calculate. Streets download by themselves.
3. Read the results table: **Walkshed area** (mi² / km²) and **Nodes** (street intersections and segment
   ends reached; the nearest available stand-in for "reached segments") per band. The status line names
   the street source ("Streets: CDOT 14+17." or nothing for OpenStreetMap).
4. Export GeoJSON if the two shapes should be compared on a map later.
5. Between a CDOT row and an OSM row, press × on Area Roads in the Add Data menu so the next Calculate
   downloads from the newly chosen source.

## Results (5 / 10 / 15 minutes at 2.8 mph)

| Origin | Source | Nodes reached | Walkshed area (mi²) | Notes |
|---|---|---|---|---|
| D01 Union Station -105.0004685, 39.7529095 | OSM | | | downtown, footway-heavy |
| D01 | CDOT 14+17 | | | |
| C01 Commerce City -104.9430570, 39.8263610 | OSM | | | |
| C01 | CDOT 14+17 | | | |
| G01 Greeley | OSM | | | |
| G01 | CDOT 14+17 | | | |
| B01 Broomfield | OSM | | | |
| B01 | CDOT 14+17 | | | |
| F01 Fraser | OSM | | | |
| F01 | CDOT 14+17 | | | |
| F01 | CDOT 14+17+7 | | | US 40 is in layer 7 only |
| D02 Sloan's Lake -105.0490000, 39.7480000 | OSM | | | should report no streets within snapping distance |
| D02 | CDOT 14+17 | | | should report no streets within snapping distance |

## Facts from the brief, section 2: where they were confirmed

| Fact | Command line (Nov 13 / 16) | Inside a browser |
|---|---|---|
| Field names and two-space class strings | yes (fixtures re-fetched Nov 16) | only through fixtures |
| `exceededTransferLimit` paging | yes | only through fixtures |
| CORS from `caseywalrath.github.io` | header seen by command line | **not yet**: first real check is the deployed site |
| Rate limits, terms of use, uptime | no | no; question to CDOT GIS staff (Phase 0) |

## Findings

(To be written after the table is filled in, including the Fraser / US 40 finding.)
