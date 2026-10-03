# Ridership Forecasting Tool

A corridor-level ridership forecasting tool built into the Micro Analysis Tool. It estimates transit ridership potential for a proposed corridor by combining demographic demand analysis with service design parameters, producing defensible ridership ranges rather than single-point predictions.

This tool does not replace a full regional travel demand model. It is a decision-support tool designed to compare service types and inform corridor-level planning.

---

## What This Tool Does

The Ridership Forecasting module answers the question: **"If we run transit service along this corridor, how many riders might we expect?"**

It works in five steps:

1. **Calibration** (optional) -- Adjusts the demand estimate using observed ridership from real routes, so the forecast reflects actual local performance
2. **Demand Analysis** -- Measures how much latent transit demand exists along the corridor based on who lives and works there
3. **Elasticity** -- Estimates how ridership responds to changes in service frequency and quality (e.g., switching from local bus to BRT)
4. **Scenario Comparison** -- Compares multiple service configurations side-by-side, showing ridership, operating cost, and productivity for each
5. **Projections** -- Re-scores demand under projected future population and shows how scenario ridership changes by horizon year

Each step builds on the previous one. You can run Demand alone for a quick assessment, or work through all five tabs for a full corridor analysis.

---

## How to Access It

1. Open the Micro Analysis Tool in your browser
2. Draw a route (or place stations/lines) on the map to define your corridor
3. Open the **Analysis** menu in the toolbar
4. Click **Ridership Forecasting** to open the module popup

The popup has five tabs across the top, in this order: **Calibrate**, **Demand**, **Elasticity**, **Scenarios**, and **Projections**. The Calibrate tab is shown first.

---

## The Demand Score: Corridor Demand Index (CDI)

At the heart of the model is the **Corridor Demand Index (CDI)**, a single number from 1 to 5 that summarizes how transit-supportive the demographics are along your corridor.

### How CDI is calculated

The CDI builds on the Transit Propensity Index (TPI), which scores every census geography (block group or tract) in the corridor on nine factors:

| Factor | What it measures | Why it matters for transit |
|---|---|---|
| Population Density | People per square mile | More people = more potential riders |
| Employment Density | Jobs per square mile (from LODES data) | Commute destinations generate ridership |
| Zero-Vehicle Households | % of households with no car | Transit-dependent population |
| Low-Income (Poverty) | % of people below poverty level | Higher transit reliance |
| Seniors (65+) | % of population age 65 and over | Often transit-dependent |
| Disability | % of population with a disability | Often transit-dependent |
| Minority | % of minority population | Equity consideration; historically underserved |
| Young Adults 18–24 | % of population aged 18–24 (default weight 0; available to activate) | Younger adults with lower car access; optional factor |
| Limited English Proficiency | % who speak English less than very well | Often transit-dependent |

For each factor, every geography in the corridor is ranked against the other geographies in the same corridor using quintiles (fifths). A geography in the top 20% for population density gets a 5; one in the bottom 20% gets a 1. This means scores are always relative to your specific study area, not a national benchmark.

The nine factor scores are combined into a weighted average (the TPI composite score), and then the CDI is calculated as a population-weighted average of all the TPI scores across the corridor. This means areas with more people count more toward the overall CDI.

### How to interpret CDI

| CDI Score | Classification | What it means |
|---|---|---|
| 4.0 -- 5.0 | **High** | Strong latent demand. Demographics strongly support transit investment. |
| 3.0 -- 3.9 | **Medium** | Moderate demand. Transit can work here with good service design. |
| 2.0 -- 2.9 | **Low-Medium** | Below-average demand. Service may need strong frequency or speed advantages to attract riders. |
| Below 2.0 | **Low** | Weak demand signal. Consider whether other factors (major destinations, development plans) justify service. |

A CDI of 3.5 does not mean "3.5 riders." It is an index that feeds into the ridership estimate when combined with calibration and service parameters.

---

## Tab 1: Calibrate

This tab is optional but recommended. It lets you adjust the model's output using observed ridership data from real transit routes, so forecasts reflect actual local performance rather than relying solely on demographics.

### When to use calibration

- If you have route-level ridership data from the transit agency you are analyzing (e.g., daily boardings by route)
- If you have comparable data from a peer system (e.g., UTA route-level data for a Mountain West comparison)
- If you have system-level NTD data and want to establish a baseline productivity ratio

### Cross-system calibration

You can calibrate using data from one transit system (e.g., UTA in Salt Lake City) and then apply that calibration to a different system (e.g., a proposed corridor in Colorado Springs). To do this:

1. Draw routes for the calibration system AND the target system on the map
2. In the Calibrate tab, use the **feature checklist** to select only the calibration system's routes (uncheck the target system corridors)
3. Complete calibration as normal
4. Switch to the Demand tab, uncheck "Same system as calibration," and select the target system's routes
5. The calibration factor will be applied to CDI values computed independently within the target system's geography

**Best practice**: When calibrating with a different system than your study corridor, do NOT include the study corridor in the calibration feature selection. This ensures the calibration quintile normalization reflects the system with observed ridership data, not the study corridor's demographics.

### Data Requirements

If you see a warning icon (⚠) next to the **ACS Year** label in the Calibrate tab, LODES employment data is not loaded. See the note under the Demand tab for details. The analysis will proceed without employment density, but employment is especially important for calibration if your observed ridership data comes from routes with significant job centers.

### How to calibrate

1. **Select Calibration Features** -- Use the feature checklist in Step 1 to choose which drawn routes/lines define the calibration system. Only selected features will be included in the TPI analysis and quintile normalization.

2. **Analyze System** -- Click **Analyze System** to run the demand analysis for the selected features. This must be done before uploading ridership data. Each route gets a CDI score normalized within the calibration system.

3. **Upload CSV** -- Click the upload button and select a CSV file containing observed ridership data. Expected columns include route name, daily ridership (or boardings per hour), peak headway, and service type. The tool will attempt to auto-detect which columns map to which fields.

4. **Column Mapping** -- After upload, verify or correct the column assignments using the dropdown menus. The tool guesses based on common column names but you should confirm.

5. **Choose a Method**:
   - **Ratio-based (recommended)** -- Divides each route's observed ridership by its computed demand index and averages the results. Simple, robust, and works well with small datasets (as few as 3--5 routes). Produces a single calibration factor.
   - **Simple regression (needs 3+ routes)** -- Fits a line through the data (observed ridership vs. demand index). Better if you have more data (10+ routes) and want to account for scatter. Produces an intercept and slope.

4. **Review Results** -- The tool shows:
   - **Calibration Factor** -- The multiplier that will be applied to CDI in all future forecasts
   - **R-squared** -- How well the calibration fits the observed data (0 to 1; higher is better). Shown for both methods when at least two routes are matched.
   - **Sample Size** -- How many routes were used

5. **Warnings** -- If the sample size is very small (fewer than 5 routes), a warning appears. The calibration still works but should be interpreted with caution. (The ratio method itself needs only two valid routes; regression needs three.)

### Import / Export Calibration

- **Export Coefficients** -- Saves the calibration factor, method, fit statistics, factor weights, and per-route CDI data as a JSON file (`ridership-calibration-<date>.json`). This is a standalone artifact that can be reused across sessions without re-running the Census data fetch. Useful for sharing calibration settings between sessions or with colleagues.

- **Import Coefficients** -- Loads a previously exported calibration file, restoring the factor and (in v2 format) per-route CDI data and weights without needing to re-upload and re-process the observed data. Supports both v1 (coefficients only) and v2 (with metadata) formats.

---

## Tab 2: Demand

This tab runs the core demand analysis and produces the CDI score for the **target system** you are analyzing.

### Target System (top of left side)

- **Same system as calibration** -- Check this box if the routes you are analyzing for demand are the same routes you calibrated against. When checked, the tool reuses the calibration step's TPI data (no additional Census API calls needed). When unchecked, you can select different routes/lines for demand analysis.

- **Demand system features** -- When "Same system" is unchecked, a checklist appears showing all drawn routes and lines. Select which features define the demand/target system. These get their own independent quintile normalization, separate from the calibration system. This is important for **cross-system analysis** (e.g., calibrating with UTA data but analyzing Colorado Springs corridors).

- **Analysis corridor** -- Select which specific route or line you want to analyze in detail. "All corridors" uses the system-wide CDI. Selecting a specific corridor shows that corridor's CDI and scopes segment analysis to just that feature.

### Settings (continued)

- **Geography Level** -- Choose between Census Tracts (faster, less detailed) or Block Groups (slower, more granular). Block Groups are the default and recommended for corridor-level work. Four factors -- Zero-Vehicle Households, Low-Income (Poverty), Disability, and LEP -- are available only at the tract level. In a Block Group run, their values are fetched for the parent tract and applied identically to every block group in that tract, so they do not vary within a tract. (If another factor is missing for some block groups, the tool likewise fills those block groups from the parent tract unless Apportion by Area is on.)

- **ACS Year** -- Which year of American Community Survey data to use. Default is 2024 (the most recent available). A small warning icon (⚠) appears next to this label if LODES employment data has not been uploaded. See the note below.

- **Segment Length** -- If set above zero, the route is divided into equal-length segments (e.g., every half mile) and each segment gets its own CDI score. This shows where demand is strongest along the corridor. Set to 0 to skip segmentation (the default is 0.5 mile).

- **Apportion by Area** -- When checked, geographies that only partially overlap the corridor buffer are scaled proportionally. This is more accurate for edge cases but slightly slower.

- **Buffer distance (mi)** -- How far from the route the corridor extends when selecting geographies (default 0.5, range 0.05--5). Calibrate and Demand share one buffer setting, with an option to use the display buffers instead.

- **Normalize by Length** -- When checked, observed ridership is divided by route length before calibration and the baseline projection is scaled back up by corridor length.

- **Include hidden** -- Toggles to include features that are currently hidden on the map.

### LODES Data Warning

If you see a warning icon (⚠) next to the **ACS Year** label, it means the Employment Density factor (LODES data) has not been loaded. When LODES is absent:

- The Employment Density factor **is excluded** from the TPI scoring
- Its weight (typically 35% of the total) is automatically **redistributed equally among the other factors that have a non-zero weight** (eight with the default weights, since Young Adults 18–24 defaults to zero)
- The analysis **still runs successfully** — results remain valid, just with a heavier emphasis on population density and socioeconomic factors
- To include employment in the analysis, upload a LODES file using the **LODES Employment** button in the **Add Data** menu (requires downloading from the Census Bureau for your state)

Employment data is most important for analyzing commute corridors with significant job centers. Population-only analysis is still useful for residential ridership assessment.

### Analyze Demand (button)

Click this to run the analysis. The tool will:
1. Query census geographies that overlap the selected demand features' buffers
2. Fetch demographic data from the Census Bureau API
3. Score each geography on the nine TPI factors (quintile-normalized within this system)
4. Compute the corridor-wide CDI and segment-level CDI (if segmentation is on)
5. Render a color-coded map (choropleth) on the map view

### Results (right side)

- **CDI Score** -- The corridor-wide demand index (1--5 scale). Click the information icon next to the label for a brief explanation.

- **Classification Badge** -- Color-coded label: High (green), Medium (yellow), Low-Medium (orange), or Low (red).

- **Statistics** -- Number of geographies analyzed, how many were successfully scored, total route length in miles, and number of segments.

- **Segment Breakdown** -- If segmentation is enabled, shows each segment's CDI score and classification. Useful for identifying where along the corridor demand is strongest or weakest.

- **Factor Scores** -- The average score (1--5) for each of the nine TPI factors, plus the effective weight used. This shows which factors are driving the overall score.

### Exports

- **GeoJSON** -- Downloads a geographic file with every scored geography, including raw values, quintile scores, and CDI classification. Can be opened in GIS software or mapping tools.

- **CSV** -- Downloads the same data as a spreadsheet-compatible table.

### Next Steps

After the analysis completes, a message appears suggesting you either continue to the **Elasticity** tab (to estimate ridership under different service types) or go to the **Calibrate** tab (to ground the model in observed data first).

---

## Tab 3: Elasticity

This tab estimates how ridership changes when you improve service frequency or upgrade the service type. It converts the CDI demand score into a ridership multiplier using transit industry elasticity values.

### Service Parameters (left side)

- **Service Type** -- Select the type of service you are proposing:

  | Service Type | Description |
  |---|---|
  | **Local Bus** | Standard fixed-route bus service. This is the baseline -- all premiums are zero. |
  | **Enhanced Bus** | Improved bus service with features like better stops, limited branding, or queue jumps. Default premium 5% to 15%. |
  | **Limited-Stop Express** | Skips intermediate stops for faster travel on longer trips. Default premium 0% to 10%. |
  | **BRT-Style** | Bus Rapid Transit characteristics: dedicated lanes, level boarding, real-time info, branded stations. Highest default premium, 5% to 25%. |

- **Baseline Headway** -- The current or comparison service frequency in minutes (e.g., 30-minute headways for existing local bus).

- **Proposed Headway** -- The frequency you are proposing (e.g., 15-minute headways for a new enhanced bus).

- **Frequency Elasticity** -- A slider and input box (range 0.1 to 1.0, default 0.6). This value controls how strongly ridership responds to frequency changes. It is consistent with the ranges reported in TCRP Report 95 (roughly 0.3 to 0.6) and with newer empirical evidence: Berrebi et al. (2021) found frequency elasticities of 0.66 to 0.78 across four U.S. transit agencies, so the default sits at the upper end of the conventional range while remaining conservative relative to that study. A value of 0.6 means that doubling frequency increases ridership by about 52%.

- **Service Span Elasticity** -- A slider and input box (range 0.1 to 1.0, default 0.7). This value controls how strongly ridership responds to changes in service hours per day (span). It is applied in the Scenarios tab when you change the "Span" input for each scenario — ridership estimates adjust relative to the 14-hour local bus baseline. The typical range is 0.5 to 0.9. See [Service Span Elasticity](#service-span-elasticity) below for details.

### Service Type Premium (right side)

Each service type has a single ridership premium, expressed as a low and a high percentage relative to the Local Bus baseline. The **Conservative (%)** and **Optimistic (%)** sliders (range 0 to 150%) are set to the selected service type's defaults and can be adjusted; the Moderate value is the average of the two.

| Service Type | Conservative | Optimistic |
|---|---|---|
| Local Bus | 0% | 0% |
| Enhanced Bus | 5% | 15% |
| Limited-Stop Express | 0% | 10% |
| BRT-Style | 5% | 25% |

The premium is applied on top of the frequency effect (and, in Scenarios, the span effect) to produce three ridership estimates.

### Ridership Multiplier (right side)

Once you have run a demand analysis (Demand tab), this section shows three estimates:

- **Conservative** -- Uses the low premium. Represents a cautious forecast.
- **Moderate** -- Uses the average of the low and high premiums. The most likely outcome.
- **Optimistic** -- Uses the high premium. Represents a best-case scenario.

The estimates are shown as index values. They become actual ridership numbers when combined with calibration data and route-specific parameters in the Scenarios tab. The Elasticity tab also has a **Model Uncertainty** slider (0--60%, default 25%) that sets a symmetric confidence band around the calibrated baseline before the service multipliers are applied.

Two additional statistics are shown:
- **Frequency Effect** -- The multiplier from the headway change alone (e.g., 1.52x for going from 30 to 15 minutes at 0.6 elasticity)
- **Base CDI** -- The corridor demand score being used as the starting point

---

## Tab 4: Scenarios

This tab lets you define up to four different service configurations and compare them side-by-side on ridership, operating cost, and productivity metrics.

### Scenario Columns

Four scenario slots are available, **A**, **B**, **C**, and **D**, shown side by side as input columns.

### Scenario Inputs

For each scenario, you define:

| Input | Description | Default |
|---|---|---|
| **Scenario Name** | A label for this scenario (e.g., "Enhanced Bus - 15 min") | "Scenario A" |
| **Service Type** | Local Bus, Enhanced Bus, Limited-Stop Express, or BRT-Style | Local Bus |
| **Peak Headway** | Service frequency in minutes during peak hours | 30 min |
| **Service Span** | Hours of service per day (e.g., 6 AM to 8 PM = 14 hours) | 14 hrs |
| **Average Speed** | Average operating speed including stops, in mph | 15 mph |
| **Cost per Revenue Hour** | Operating cost including driver, fuel, maintenance, and overhead | $150 |
| **Service Days per Year** | How many days per year the service operates | 260 (weekday only) |

Service days presets: 260 (weekday only), 302 (weekday + Saturday), 312 (excluding holidays), 365 (daily).

### Build Scenarios (button)

Click this to compute all metrics for all four scenarios at once. The tool calculates:

| Metric | What it means |
|---|---|
| **Vehicles Needed** | Minimum number of buses to maintain the headway, based on route length and speed |
| **Revenue Hours / Day** | Total hours of in-service vehicle operation per day |
| **Annual Revenue Hours** | Revenue hours per day multiplied by service days per year |
| **Annual Operating Cost** | Annual revenue hours multiplied by cost per revenue hour |
| **Span Effect** | The ridership multiplier from the service span change relative to the 14-hour baseline (e.g., 1.19x for 18 hrs at elasticity 0.7). A value of 1.0 means no change from the baseline span. |
| **Daily Ridership (Low / Mid / High)** | Estimated daily boardings based on CDI, elasticity premiums, span effect, and calibration factor (if available). Three estimates reflecting conservative, moderate, and optimistic assumptions. |
| **Annual Ridership (Mid)** | Moderate daily estimate multiplied by service days per year |
| **Boardings per Revenue Hour** | Annual ridership divided by annual revenue hours. A key productivity metric -- typical for bus is 10-30 depending on context. |
| **Cost per Boarding** | Annual operating cost divided by annual ridership. Lower is better. Typical range is $3-$15 for productive bus routes. |

### Comparison Table

After building scenarios, a table appears showing all four scenarios as columns with all metrics as rows. The moderate (mid) ridership rows are highlighted to draw attention to the most likely outcome.

### Exports

- **Export CSV** -- Downloads the comparison table as a spreadsheet-compatible file. One row per scenario with all metrics.

- **Export JSON** -- Downloads the full scenario data in JSON format, including all input parameters and computed results. Useful for importing into other tools or archiving the analysis.

---

## Tab 5: Projections

This tab estimates how scenario ridership may change under future population conditions. Complete the Calibrate and Scenarios tabs first.

1. Click **Upload CSV** and select a population projection CSV (the tool references PPACG projections).
2. Click **Run Projections**. Projected population counts are added to the Census ACS baseline and the demand indices are re-scored for each horizon year (2030, 2040, 2050), using the Scenarios tab parameters. No additional Census API calls are needed.
3. Review the **Projection Timeline**: daily ridership (Moderate estimate, with the Low--High range in parentheses) and the CDI change for the current year and each horizon year.
4. Click **Export CSV** to download the timeline. **Clear** removes the loaded projection file.

---

## How the Math Works

This section explains the key calculations in plain terms for anyone who wants to understand the model logic.

### Frequency Effect

When you improve frequency (reduce headway), ridership increases -- but not proportionally. The relationship follows a power curve:

> **Frequency effect = (new frequency / old frequency) raised to the power of the elasticity value**

Frequency is calculated as 60 divided by the headway in minutes (e.g., 15-minute headway = 4 trips per hour).

**Example**: Going from 30-minute headways (2 trips/hour) to 15-minute headways (4 trips/hour) with an elasticity of 0.6:
> Effect = (4 / 2) ^ 0.6 = 2 ^ 0.6 = 1.52

This means a 52% ridership increase from the frequency improvement alone.

### Service Span Elasticity

Service span is the number of hours per day the route operates (e.g., 6 AM to 8 PM = 14 hours). When a scenario's span differs from the 14-hour local bus baseline, the tool applies a span multiplier using the same power-curve approach as frequency elasticity:

> **Span effect = (scenario span / 14 hours) raised to the power of the span elasticity**

**Example**: A scenario with an 18-hour span and the default elasticity of 0.7:
> Effect = (18 / 14) ^ 0.7 = 1.286 ^ 0.7 ≈ 1.19

This means approximately 19% more ridership from the extended service hours, relative to 14-hour service. Conversely, a 10-hour span would produce:
> Effect = (10 / 14) ^ 0.7 = 0.714 ^ 0.7 ≈ 0.77 (about 23% fewer riders)

**Why a power curve?** The formula naturally produces diminishing marginal returns. Adding 4 hours to a 10-hour service day (a 40% increase) has a much larger proportional impact than adding 4 hours to an 18-hour service day (a 22% increase). This reflects how early morning and late evening extensions often capture significant pent-up demand when span is short, but add less marginal ridership once the service day is already long.

**Defining "effective span"**: To keep span conceptually separate from frequency, count only hours when service is frequent enough to be practically usable — ideally when headways are 60 minutes or less. Avoid counting hours at 90–120 minute headways as equivalent to true all-day service, as this would overstate span's contribution relative to frequency.

**Recommended parameter range:**

| Value | Interpretation | Source |
|---|---|---|
| 0.5 | Conservative — consistent with lower-end service elasticity literature; appropriate when added off-peak hours are less productive | TCRP synthesis |
| 0.6–0.8 (typical) | Supported by studies showing service-hours/miles elasticities around 0.7–0.8 and strong ridership response to evening/weekend extensions | Currie & Loader (2009); TCRP literature |
| 0.83–0.9 | Aggressive — direct precedent: Hampton Roads Transit uses 0.83; Currie & Loader report >0.8 on weekend evening extensions | Currie & Loader (2009); HRT planning practice |

The default value of 0.7 represents a mid-range, widely defensible estimate appropriate for most sketch-level planning contexts. Adjust upward (toward 0.85) if your corridor has strong latent demand for early morning or evening trips; adjust downward (toward 0.5) if added span hours are unlikely to generate proportional ridership.

### Combined Ridership Multiplier

The total ridership multiplier combines the frequency effect, the span effect, and the service type premiums:

> **Multiplier = frequency effect × span effect × (1 + service type premium)**

The service type premium has a low and high value (with mid = average), producing three multiplier estimates (Conservative / Moderate / Optimistic). The span effect is applied uniformly across all three.

### Ridership Estimate

> **Estimated ridership = CDI score x calibration factor x multiplier**, with a baseline uncertainty band (default +/-25%) applied to the calibrated baseline before the multiplier. When Normalize by Length is on, the baseline is also multiplied by route length.

If no calibration has been done, the calibration factor defaults to 1 (no adjustment). The CDI score here is the corridor-wide population-weighted average from the Demand tab.

### Operating Metrics

> **Vehicles needed = ceiling of (2 x route length / average speed) / (headway / 60)**, with a minimum of 1 vehicle

This ensures enough buses are available to maintain the headway given the round-trip time.

> **Revenue hours per day = vehicles needed x service span**

> **Annual operating cost = revenue hours per day x service days x cost per revenue hour**

> **Boardings per revenue hour = annual ridership / annual revenue hours**

> **Cost per boarding = annual operating cost / annual ridership**

---

## Normalization Modes

The CDI (Corridor Demand Index) is always computed relative to a pool of corridors — the set of geographies used for quintile scoring. By default, each system uses its own independent pool. This section explains when and why to change that.

### Separate Pools (default)

Each system's CDI is computed within its own normalization pool:

- **Calibration system CDI**: normalized against the calibration system's corridors only
- **Demand system CDI**: normalized against the demand system's corridors only

A route that scores 4.2 CDI in Colorado Springs is in the top quintile *relative to Colorado Springs corridors*. A route that scores 4.2 CDI in a calibration system like Salt Lake City is in the top quintile *relative to Salt Lake City corridors*. These values are on different absolute scales — but the calibration relationship is still meaningful if applied consistently within each system.

**Use separate pools when:**
- Analyzing corridors within the same system you calibrated against
- Calibration and demand systems have similar absolute density levels
- You want to preserve within-system relative rankings (which corridor is best relative to its peers)

### Shared Pool

When the **Shared pool normalization (calibration + demand)** checkbox is checked in the Demand tab — available only when "Same system as calibration" is unchecked — a single TPI run covers both the calibration and demand systems together. All corridors from both systems are scored relative to the same combined pool of geographies, making CDI values directly comparable across systems.

After the combined analysis runs, the calibration is automatically refitted using the new shared-pool CDI values for calibration routes. The updated factor appears in the Calibrate tab results with a note confirming the refit.

**Use shared pool when:**
- Calibrating against one system (e.g., Salt Lake City) and applying the calibration to another (e.g., Colorado Springs) where absolute density levels differ substantially
- You want cross-system CDI comparisons to be meaningful in absolute terms
- You are combining high-density urban corridors with low-density suburban corridors in the same analysis

**Important:** When "Same system as calibration" is unchecked, shared pool is checked by default — this is the recommended setting for cross-system analysis. You can manually uncheck it if you prefer separate-pool behavior.

**Warning:** The normalization pool depends on which features are selected. Changing feature selections (or re-running calibration) after enabling shared pool mode will mark the demand analysis as stale, and you should re-run to get consistent results.

### Mode comparison

| Situation | Recommended Mode |
|---|---|
| Calibration and demand are from the same geographic area | Separate pools (default, or use "Same system") |
| Calibration and demand systems span very different density environments | Shared pool |
| Quick single-city corridor assessment | Separate pools |
| Peer-system comparison where absolute density levels matter | Shared pool |

---

## Typical Workflows

### Quick Corridor Assessment

1. Draw a route on the map
2. Open Ridership Forecasting
3. On the **Demand** tab, click **Analyze Demand**
4. Review the CDI score and segment breakdown
5. Export GeoJSON to visualize in GIS if needed

Time: 2-5 minutes

### Compare Service Types

1. Complete the quick assessment above
2. Go to the **Elasticity** tab
3. Select different service types (Enhanced Bus, BRT, etc.)
4. Compare the Conservative / Moderate / Optimistic ranges
5. Adjust the frequency elasticity slider to test sensitivity

Time: 5-10 minutes

### Full Scenario Analysis

1. Draw the corridor route on the map
2. Upload LODES employment data (optional, from the Add Data menu)
3. Run **Analyze Demand** on the Demand tab
4. Go to the **Calibrate** tab, upload observed ridership data, run calibration
5. Go to the **Scenarios** tab
6. Define Scenario A: current service (Local Bus, 30 min, $150/hr)
7. Define Scenario B: improved service (Enhanced Bus, 20 min, $150/hr)
8. Define Scenario C: premium service (BRT-Style, 10 min, $180/hr)
9. Click **Build Scenarios**
10. Review the comparison table
11. Export CSV for reports or presentations

Time: 15-30 minutes (depending on data availability)

### Calibrate with Peer System Data

1. Obtain route-level ridership data from a peer agency (e.g., UTA monthly ridership reports)
2. For each peer route, run the demand analysis in this tool to get its CDI
3. Combine into a CSV: route name, observed daily ridership, peak headway, service type
4. Upload to the **Calibrate** tab
5. The calibration factor now reflects real-world performance from a comparable system
6. Continue with Elasticity and Scenarios -- all forecasts now use the calibrated factor

---

## What This Tool Is and Is Not

**It is:**
- A corridor-level decision-support tool for comparing service types
- Grounded in census demographics and transit demand research
- Designed to produce ranges (conservative, moderate, optimistic) rather than precise predictions
- Transparent in its assumptions -- every parameter is visible and adjustable
- Locally calibratable using observed ridership data

**It is not:**
- A full four-step travel demand model
- A substitute for MPO or regional modeling
- Predicting exact future-year ridership
- Accounting for induced demand, land use changes, or network effects

The forecasts should be used alongside professional judgment, local knowledge, and other planning tools.

---

## Export File Formats

| Export | Tab | Format | Contents |
|---|---|---|---|
| Demand GeoJSON | Demand | `.geojson` (`corridor-cdi-<date>`) | Every scored geography with CDI score, classification, raw factor values, and quintile scores. Openable in GIS. |
| Demand CSV | Demand | `.csv` (`corridor-cdi-<date>`) | Same data in tabular format. Openable in Excel. An "Include Shared Pool data" option adds the shared-pool geographies when a shared-pool run is active. |
| Calibration Coefficients | Calibrate | `.json` (`ridership-calibration-<date>`) | Calibration factor, method, R-squared and sample size, plus (v2 format) factor weights, per-route CDI values and settings. Importable in future sessions (v1 and v2). |
| Scenario Comparison CSV | Scenarios | `.csv` (`ridership-scenarios-<date>`) | One row per scenario with all operating and ridership metrics. Openable in Excel. |
| Scenario Comparison JSON | Scenarios | `.json` (`ridership-scenarios-<date>`) | Full scenario parameters and results. Useful for archiving or feeding into other tools. |
| Projection Timeline CSV | Projections | `.csv` (`projection-timeline_<date>`) | Current and horizon-year (2030, 2040, 2050) ridership and CDI values. |

---

## Glossary

| Term | Definition |
|---|---|
| **ACS** | American Community Survey. Annual demographic survey by the US Census Bureau. The tool uses the 5-year estimates. |
| **Block Group** | A Census geography containing roughly 600-3,000 people. More granular than tracts. |
| **Boardings per Revenue Hour** | Number of passenger boardings divided by hours of in-service vehicle operation. A standard transit productivity metric. |
| **BRT** | Bus Rapid Transit. Premium bus service with dedicated lanes, branded stations, and frequent service. |
| **CDI** | Corridor Demand Index. The model's composite demand score (1-5 scale). |
| **Calibration Factor** | A multiplier derived from observed ridership data that scales the model's output to match real-world performance. |
| **Census Tract** | A Census geography containing roughly 1,200-8,000 people. Larger than block groups. |
| **Cost per Boarding** | Annual operating cost divided by annual ridership. Measures cost-effectiveness. |
| **Elasticity** | How sensitive ridership is to changes in a variable (like frequency). An elasticity of 0.6 means a 10% increase in frequency yields about a 6% increase in ridership. |
| **Headway** | Time between consecutive buses at a stop, in minutes. Lower headway = more frequent service. |
| **LODES** | LEHD Origin-Destination Employment Statistics. Block-level employment data from the Census Bureau. Used to compute the Employment Density factor in TPI scoring. If LODES is not loaded, a warning icon (⚠) appears next to the ACS Year selector in the Ridership Forecasting Calibrate and Demand tabs, and the Employment factor is excluded (its weight redistributed to other factors). |
| **NTD** | National Transit Database. Federal reporting system with system-level ridership and financial data for every US transit agency. |
| **OLS Regression** | Ordinary Least Squares. A statistical method that fits a best-fit line through data points. |
| **Quintile** | One-fifth of a ranked dataset. The top quintile (5) is the highest 20%; the bottom quintile (1) is the lowest 20%. |
| **Revenue Hour** | One hour of in-service vehicle operation (bus on the road, doors open to passengers). |
| **Service Span** | Hours per day that a route operates (e.g., 6 AM to 8 PM = 14-hour span). |
| **Service Span Elasticity** | A parameter controlling how strongly ridership responds to changes in service hours. Applied as a power curve: `(new span / baseline span) ^ elasticity`. Default is 0.7; typical range 0.5–0.9. |
| **TCRP** | Transit Cooperative Research Program. A federally funded research program that publishes guidance on transit planning topics, including elasticity values. |
| **TIGERweb** | The Census Bureau's geographic boundary service used to retrieve tract and block group shapes. |
| **TPI** | Transit Propensity Index. The 9-factor scoring model that feeds into the CDI. |
