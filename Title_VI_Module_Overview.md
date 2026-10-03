# Title VI Module — Overview

## 1. Purpose

The Title VI module is a browser-only analysis module that replaces the manual GIS workflow for Title VI service equity analysis. It supports three tasks:

1. Determine whether a proposed service or fare action qualifies as a Major Service Change under rules the user defines.
2. Evaluate minority and low-income impacts for the area affected by the change, against a system baseline.
3. Compare alternative scenarios (for example, a proposal and a mitigation alternative) side by side.

Major Service Change thresholds and the Disparate Impact / Disproportionate Burden thresholds are user-editable, so the module can follow different agency policies. The protected-population definitions are fixed (see Section 6).

## 2. How it fits the app

- The module is a popup-based analysis module registered with `App.registerModule()` (`js/projects/title-vi.js`). It appears in the **General** group of the toolbar Analysis menu.
- The popup is 1000 px wide and has three tabs: **Major Service Changes**, **Equity Analysis** and **Scenarios** (`projects/title-vi-popup.html`).
- Pure calculation lives in `js/projects/title-vi-engine.js` (`window.TitleVI`, no DOM access). The module UI, map overlay, persistence and exports live in `title-vi.js`.
- Census geography and ACS values come from TIGERweb and the Census API through the `core` object. No backend and no build tools are involved.
- Module state is saved with the app session (autosave and session export/import) and also has its own Session JSON export/import on the Scenarios tab.

## 3. Where service metrics come from

Before/after service metrics are not imported from a file. They come from two sources:

- **Geometry (computed automatically).** The user draws or imports the existing and proposed alignments as Routes or Lines, then pairs them in a service adjustment. The module computes before and after route miles, the percent change in route miles, the percent of the existing route that has moved (the "altered" share, using a 0.1 mi divergence threshold sampled about every 0.05 mi), and the service loss and gain areas (buffer differences).
- **Manual entry on the adjustment card.** Revenue hours, span of service (hours) and fare each have a Before and an After field. The module calculates the percent change from these. A blank or zero "before" value means that percent change is not calculated and the rule cannot trigger for that adjustment.

Stop counts are not an input and not a rule.

## 4. Using the module

### Tab 1 — Major Service Changes

**Agency Policies (left).** Each rule has an enable checkbox and, where applicable, a threshold. A change that meets any enabled rule is flagged as a Major Service Change. Percent rules compare the absolute change, so increases and decreases both count.

| Rule | Default | Threshold |
|---|---|---|
| Route miles change | Enabled | 25% |
| Revenue hours change | Enabled | 25% |
| Span of service change | Disabled | 25% |
| Route elimination | Enabled | Yes/no |
| Eliminated / altered miles | Disabled | 25% |
| Fare change | Disabled | 10% |

Percent thresholds accept 1 to 100. The **Export MSC Results CSV** button writes the per-adjustment rule results.

**Service Adjustments (right).** Use **+ Service Adjustment** to add one card per route change. Each card has:

- A name and a change type: **Adjustment** (existing and proposed alignments), **Elimination** (existing alignment only; treated as 100% altered with the whole buffer counted as loss) or **New Route** (proposed alignment only; the whole buffer counts as gain, and route-miles change is not defined).
- Before and After feature selectors, which point at drawn Routes or Lines. References are stored by stable feature ID. If a referenced feature is deleted, the card shows a warning and the analysis will not run until the reference is fixed or the adjustment is removed.
- Manual Before/After fields for revenue hours, span (hours) and fare.

### Tab 2 — Equity Analysis

- **System Baseline.** Select the Routes, Lines and Polygons that represent the system and click **Calculate Baseline**. The module computes minority and low-income shares over the union of their buffers. This is the comparison benchmark. Only a system-population baseline is supported; a ridership-based baseline is not.
- **Geography.** Census Tracts or Block Groups (default), and ACS year (2024 default; 2023, 2022 and 2021 available). Mixed-geography runs are not supported.
- **Impacted Area Method.** Choose how the impacted area is built:
  - Area losing coverage (buffer difference) — default.
  - All affected area (loss plus gain).
  - Full existing route buffer.
  - Drawn polygon(s).
  If no change areas can be computed, the area falls back to buffers around the "before" routes.
- **Equity Thresholds.** Disparate Impact and Disproportionate Burden thresholds, in percentage points (default 15 each; accepted range 1 to 50).
- **Run Equity Analysis.** Evaluates the Major Service Change rules and calculates demographics for the impacted area. Results show a Major Service Change verdict with the rule-by-rule outcome, then separate cards for Minority (Disparate Impact) and Low-Income (Disproportionate Burden). Each card shows the impacted-area share, the baseline share, the difference and the threshold. The loss and gain areas are drawn on the map. If inputs change after a run, a stale-results banner with a Re-run button appears. A failed run leaves the inputs open.
- **Exports.** Findings CSV and Impacted Area GeoJSON.

### Tab 3 — Scenarios

- Scenario Manager: select, **Duplicate**, **Rename** and **Delete** scenarios. Each scenario holds its own adjustments and impact method, so a mitigation alternative is a duplicate with modified adjustments.
- Scenario Comparison: run the equity analysis on each scenario, then compare Major Service Change trigger status, population, minority and low-income shares, differences and finding labels side by side.
- **Export Comparison CSV**, **Export Session JSON**, and **Import Session JSON**.

## 5. Findings logic

- A finding is flagged when the impacted-area share exceeds the baseline share by at least the threshold (`difference >= threshold`, in percentage points). Only an impacted share above the baseline can flag; a lower share never does.
- Labels: "Potential Disparate Impact" / "No Disparate Impact" for minority, and "Potential Disproportionate Burden" / "No Disproportionate Burden" for low-income.
- If a threshold field is cleared or zero, the engine falls back to 15 ppt.

## 6. Demographic definitions

These are fixed in the engine and not user-configurable:

- **Minority share** = (B03002_001E − B03002_003E) / B03002_001E, that is, everyone other than non-Hispanic White alone.
- **Low-income share** = B17001_002E (persons below poverty) / B01003_001E (total population).
- Counts are area-apportioned into the impacted area (or baseline union). At block-group level, if no poverty values return, the module falls back to tract-level poverty values mapped onto the block groups.

## 7. Persistence and export

The module state (policy, scenarios, baseline selection and result, stale flag) is saved with the app session and survives closing and reopening the popup. There is one policy per session, not a library of policy profiles. Exports:

| File | Source |
|---|---|
| `title-vi-findings-YYYY-MM-DD.csv` | Findings CSV (Equity Analysis tab) |
| `title-vi-impacted-area-YYYY-MM-DD.geojson` | Impacted Area GeoJSON (Equity Analysis tab) |
| `title-vi-msc-results-YYYY-MM-DD.csv` | Export MSC Results CSV (Major Service Changes tab) |
| `title-vi-comparison-YYYY-MM-DD.csv` | Export Comparison CSV (Scenarios tab) |
| `title-vi-session-YYYY-MM-DD.json` | Export Session JSON (Scenarios tab) |

## 8. Defaults

Block groups, 0.5 mi buffer, ACS 2024, Disparate Impact 15 ppt, Disproportionate Burden 15 ppt, minority = 1 − non-Hispanic White share, low-income = persons below poverty / total population, baseline = system population.

## 9. Known limits

- Major Service Change rules are evaluated per adjustment. There is no cumulative multi-route rule, no "all service removed on a day" rule and no stop-count rule.
- Revenue hours, span and fare are manual entries. Fare-only changes have no spatial impact area and need a drawn polygon or a paired alignment for the equity step.
- Changed-segment detection is approximated by buffer differences between the paired existing and proposed alignments.
- Not in scope: GTFS-native stop change inference, fare elasticity or ridership forecasting, public notice workflow, narrative report generation, mixed-geography runs.

## 10. Not yet built / possible enhancement

**Route/service-metrics CSV import.** The original design called for importing a CSV of per-route before/after metrics (route miles, revenue hours, span, stops, fare) so that non-geometric Major Service Change checks could be driven from agency data instead of manual entry. This was never built. There is no CSV import in the popup, and the module does not read or validate such files. It is tracked as "Title VI route/service-metrics CSV import" in `features.md`.
