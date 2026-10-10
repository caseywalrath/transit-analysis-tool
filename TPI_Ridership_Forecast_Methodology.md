# Transit Propensity and Ridership Forecasting: Technical Methodology

**Micro Analysis Tool — Methodology Appendix**

*Draft for review — [Month Year]*

---

## 1. Introduction and Purpose

This document describes the quantitative methods underlying the Transit Propensity Index (TPI) and Ridership Forecasting modules of the Micro Analysis Tool. It is intended to serve as a technical appendix to corridor planning studies, alternatives analyses, or other documents that reference outputs from the tool.

The tool produces corridor-level ridership estimates by combining census-derived demand indices with service elasticity models and optional empirical calibration. It is designed as a sketch-planning decision-support tool — not a replacement for regional travel demand models or FTA-standard forecasting procedures. All outputs are presented as ranges (conservative, moderate, optimistic) rather than single-point predictions, reflecting the inherent uncertainty in corridor-level estimation.

**Scope.** The methodology covers five principal components, plus population projections:

1. Factor selection and data sources
2. Quintile normalization and composite scoring
3. Corridor Demand Index (CDI) computation
4. Calibration methods
5. Elasticity and scenario models

Population projections (Section 7.4) re-score the same model for future horizon years.

---

## 2. Factor Selection and Data Sources

### 2.1 Factor Rationale

The Transit Propensity Index evaluates latent transit demand using nine demographic and socioeconomic factors drawn from the American Community Survey (ACS) 5-year estimates and the Longitudinal Employer-Household Dynamics (LEHD) Origin-Destination Employment Statistics (LODES). These factors were selected based on established transit planning literature identifying population characteristics associated with higher transit ridership and transit dependence.[^1]

| # | Factor | Indicator | Source | Default Weight |
|---|--------|-----------|--------|----------------|
| 1 | Population Density | Persons per square mile | ACS B01003 | 35 |
| 2 | Employment Density | Jobs per square mile | LODES WAC (C000) | 35 |
| 3 | Zero-Vehicle Households (tract-only) | % of households with no vehicle available | ACS B08201, B11001 | 5 |
| 4 | Low-Income % (Poverty) (tract-only) | % of persons below the poverty level | ACS B17001, B01003 | 5 |
| 5 | Senior 65+ % | % of population aged 65 and over | ACS B01001 (12 cohorts) | 5 |
| 6 | Disability % (tract-only) | % of civilian noninstitutionalized population with a disability | ACS B18101 (12 cohorts) | 5 |
| 7 | Minority % | % of population who are not non-Hispanic White | ACS B03002 | 5 |
| 8 | Young Adults 18–24 % | % of population aged 18–24 | ACS B01001 (8 cohorts) | 0 |
| 9 | LEP % (Limited English Proficiency) (tract-only) | % of population age 5+ who speak English less than "very well" | ACS C16001 (12 categories) | 5 |

The two density factors (population and employment) receive the largest default weights (35 each, totaling 70% of the composite) because density is the single strongest predictor of transit ridership across the literature.[^2] The remaining socioeconomic and equity factors together receive 30% of the weight, reflecting their secondary but meaningful contribution to transit propensity. Young Adults 18–24 % receives a default weight of zero but is available for user activation.

All weights are user-adjustable. When weights are modified, the tool recalculates quintile scores and composite indices in real time without additional Census API calls.

### 2.2 Data Sources and Geography

**American Community Survey.** The tool queries ACS 5-year estimates via the Census Bureau's data API at either the census tract or block group level. Block groups (typically 600–3,000 persons) are the default and recommended geography for corridor-level analysis; tracts (typically 1,200–8,000 persons) are available as a faster, less granular alternative. Geographic boundaries are retrieved from the Census Bureau's TIGERweb service.

**LODES Employment Data.** LODES Workplace Area Characteristics (WAC) data provides block-level job counts (variable C000, total employment). Block-level counts are aggregated to the analysis geography (tract or block group) by matching the first 11 (tract) or 12 (block group) digits of the 15-digit block GEOID. If LODES data is not loaded, the Employment Density factor is excluded and its weight is redistributed equally among all other active factors.[^3]

**Tract-Only Factors and Tract-Level Fallback.** Four factors are treated as tract-only: Zero-Vehicle Households (B08201, B11001), Low-Income (B17001), Disability (B18101) and Limited English Proficiency (C16001). When the analysis geography is set to block groups, the variables for these factors (whenever their weight is non-zero) are fetched at the tract level and assigned uniformly to all child block groups within each tract. These four factors therefore carry no within-tract variation in block-group runs. This static handling is applied whether or not area-weighted apportionment is enabled.

A second, dynamic fallback operates for the remaining ACS factors (Population Density, Senior, Minority, Young Adults 18–24): if a factor yields a non-finite value for one or more block groups (the variable is suppressed or unavailable at that geography in a given ACS vintage, whether for all block groups or only some), the tool re-fetches that factor's variables at the tract level and fills only the affected block groups from their parent tract. The dynamic fallback is bypassed when area-weighted apportionment is enabled.[^4]

### 2.3 Computation of Factor Values

Each factor is computed as a rate or density for each census geography:

- **Population Density:** Total population (B01003_001E) divided by geography area in square miles, where area is computed via `turf.area()` in square meters and converted using the constant 2,589,988.11 m² per mi².
- **Employment Density:** Aggregated LODES job count (C000) divided by geography area in square miles.
- **All percentage-based factors:** Numerator variable(s) summed and divided by the relevant denominator (total population, total households, or civilian noninstitutionalized population as appropriate), multiplied by 100.

For factors with multi-cohort numerators (Senior, Disability, Young Adults 18–24, LEP), the tool sums 8–12 individual ACS variables to construct the numerator. The specific variable codes are documented in the tool's source code and correspond to standard ACS detailed table structures.

---

## 3. Normalization and Composite Scoring

### 3.1 Quintile Normalization

Raw factor values are converted to ordinal scores on a 1–5 scale using quintile normalization *within the study area*. This is a critical design choice: scores are always relative to the corridors under analysis, not to an external benchmark.

**Standard procedure (N ≥ 5 geographies):**

1. For each factor, extract all valid (finite, non-null) values across the study area geographies.
2. Sort values in ascending order.
3. Assign each geography a quintile score:

$$Q_i = \min\!\bigl(5,\;\lfloor (i / N) \times 5 \rfloor + 1\bigr)$$

where *i* is the zero-indexed position in the sorted array and *N* is the count of valid values.[^5]

4. For all factors in this tool, higher raw values indicate higher transit propensity (`higherIsBetter = true`), so quintile scores are used as assigned (quintile 5 = highest values = highest propensity). Were a factor to be specified with `higherIsBetter = false`, scores would be inverted: Q' = 6 − Q.

**Small-sample procedure (N < 5 geographies):**

When fewer than five geographies have valid data, quintile assignment would be degenerate. The tool switches to equal-interval scoring:

$$Q_i = \min\!\bigl(5,\;\max\!\bigl(1,\;\lceil ((v_i - v_{\min}) / R) \times 5 \rceil\bigr)\bigr)$$

where *R* = *v*_max − *v*_min. If all values are equal (R = 0), all geographies receive a score of 3.

### 3.2 Composite Score (TPI)

The Transit Propensity Index composite score for each geography is a weighted average of its factor quintile scores:

$$\text{TPI}_g = \frac{\displaystyle\sum_{f \in F_g} w_f \cdot Q_{g,f}}{\displaystyle\sum_{f \in F_g} w_f}$$

where:
- *F_g* is the set of factors that have a valid quintile score for geography *g*
- *w_f* is the normalized weight for factor *f* (weights are normalized so that all active factor weights sum to 1)
- *Q_{g,f}* is the quintile score for geography *g* on factor *f*

This formulation gracefully handles missing data: if a geography lacks a score for a particular factor, that factor's weight is redistributed proportionally among the remaining factors for that geography. The resulting composite ranges from 1.0 to 5.0.

### 3.3 Area-Weighted Apportionment (Optional)

When the "Apportion by Area" option is enabled, geographies that only partially overlap the analysis buffer are scaled proportionally:

1. For each geography, compute the geometric intersection with the buffer union polygon.
2. Calculate the area fraction: *f* = area(intersection) / area(geography), clamped to [0, 1].
3. Multiply each raw factor value by its area fraction before quintile normalization.

This produces more accurate results at buffer edges, where a geography may extend well beyond the corridor, at a modest increase in computation time.

---

## 4. Corridor Demand Index (CDI)

### 4.1 System-Wide CDI

The Corridor Demand Index aggregates TPI composite scores across all geographies in the study area into a single summary metric. The CDI is computed as a **population-weighted average** of TPI composite scores:

$$\text{CDI} = \frac{\displaystyle\sum_{g} \text{TPI}_g \times P_g}{\displaystyle\sum_{g} P_g}$$

where *P_g* is the estimated population of geography *g*, derived as population density multiplied by area in square miles. If population density data is unavailable for a geography, a uniform weight of 1 is substituted.

Population weighting ensures that areas with more residents contribute proportionally more to the corridor-level demand signal. A densely populated urban block group with a TPI of 4.5 influences the CDI more than a sparsely populated suburban tract with the same score.

### 4.2 Per-Route CDI

When multiple routes or lines are drawn, the tool computes an individual CDI for each feature using the same population-weighted method, but restricted to geographies that intersect that feature's buffer polygon. The intersection uses a two-step spatial test: a fast bounding-box check (`booleanIntersects`) followed by a precise polygon intersection (`turf.intersect`) to determine the fractional overlap. Population weights are scaled by the overlap fraction.

Per-route CDI values are essential for calibration (Section 5), where each route's CDI is paired with its observed ridership.

Each per-route result also includes:
- **Factor breakdown:** Population-weighted average quintile score per factor for that route, enabling identification of which demand drivers are strongest along each corridor.
- **Composite range:** The minimum and maximum TPI composite scores among overlapping geographies, indicating within-corridor variation.

### 4.3 CDI Classification

CDI scores are classified into four tiers for interpretive convenience:

| CDI Range | Classification | Interpretation |
|-----------|---------------|----------------|
| ≥ 4.0 | High | Strong latent demand; demographics strongly support transit investment |
| 3.0–3.9 | Medium | Moderate demand; transit can succeed with good service design |
| 2.0–2.9 | Low-Medium | Below-average demand; strong frequency or speed advantages may be needed |
| < 2.0 | Low | Weak demand signal; other factors (destinations, development plans) should be considered |

### 4.4 Segment-Level CDI

When segment analysis is enabled, each route is divided into equal-length chunks (user-specified, e.g., 0.5 miles) using `turf.lineChunk()`. Each chunk receives a buffer (default 0.5 miles; configurable), and the population-weighted CDI is computed within that buffer against the same set of pre-fetched TPI geographies. This reveals spatial variation in demand along the corridor without additional Census API calls.

### 4.5 Normalization Pools

Because quintile normalization is relative to the study area, the choice of which geographies constitute the normalization pool affects CDI values. The tool provides two modes:

**Separate pools (default when "Same system as calibration" is checked).** The calibration system and the demand/target system each receive independent quintile normalization. A CDI of 4.2 in one system is relative to that system's internal distribution. When "Same system as calibration" is unchecked, the shared-pool option is switched on automatically (it may be unchecked manually to return to separate pools); when the box is checked, the shared-pool option is disabled.

**Shared pool.** Both the calibration and demand systems are combined into a single TPI run. All geographies from both systems are scored against the same quintile distribution, making CDI values directly comparable across systems. After the shared run, the calibration is automatically refitted using the updated CDI values (see Section 5.3). Shared-pool normalization is recommended for cross-system analysis (e.g., calibrating with data from one metropolitan area and applying the calibration to corridors in a different city).[^6]

---

## 5. Calibration Methods

Calibration adjusts the model's output using observed ridership data from real transit routes, translating the abstract CDI scale into plausible ridership magnitudes. Calibration is optional but recommended.

### 5.1 Data Requirements

The user provides a CSV file with route-level data including, at minimum:
- Route name (for matching to drawn features)
- Observed daily ridership (boardings)

Optional but recommended columns:
- Peak headway (minutes) — enables headway normalization (see Section 5.4)
- Service type — provides context for interpreting calibration results

Columns are assigned through a column-mapping step (Route Name, Daily Ridership, Peak Headway, Service Type). The tool performs case-insensitive exact string matching (after trimming whitespace) between CSV route names and drawn feature names; the first match wins. Routes that do not match are excluded from calibration. The interface requires at least two valid matched routes to run any calibration and shows a small-sample warning when fewer than five routes are used.

### 5.2 Ratio-Based Calibration

The ratio method computes a single calibration factor as the mean ratio of observed ridership to computed CDI across all matched routes:

$$k = \frac{1}{n} \sum_{i=1}^{n} \frac{R_i}{\text{CDI}_i}$$

where *R_i* is the observed daily ridership for route *i* and CDI_i is the per-route CDI. Routes with CDI ≤ 0 are excluded.

This method is simple, robust, and effective with small sample sizes (as few as 3–5 routes). It assumes a proportional relationship between CDI and ridership passing through the origin — i.e., zero demand implies zero ridership.

An R² statistic is computed when *n* ≥ 2 using predicted values *R̂_i* = *k* × CDI_i:

$$R^2 = 1 - \frac{\sum (R_i - \hat{R}_i)^2}{\sum (R_i - \bar{R})^2}$$

### 5.3 OLS Regression Calibration

The regression method fits a simple ordinary least squares (OLS) model:

$$\hat{R} = \alpha + \beta \cdot \text{CDI}$$

where β (slope) serves as the primary calibration factor and α (intercept) captures a baseline ridership level independent of the CDI score. This method requires *n* ≥ 3 matched routes and is generally more appropriate for larger datasets (10+ routes) where the additional parameter is justified.

Standard OLS formulas are applied:[^7]

$$\beta = \frac{n\sum x_i y_i - \sum x_i \sum y_i}{n\sum x_i^2 - (\sum x_i)^2}, \quad \alpha = \frac{\sum y_i - \beta \sum x_i}{n}$$

R² is computed as above. A warning is issued when *n* < 10 because small-sample OLS estimates have wide confidence intervals.

### 5.4 Headway Normalization

When headway data is available in the calibration CSV, observed ridership values are normalized before fitting to remove the effect of frequency differences across routes. This isolates the demand component of ridership from the service-supply component:

$$R_i^{\text{norm}} = \frac{R_i}{f(h_{\text{ref}},\; h_i,\; \varepsilon)}$$

where *f* is the frequency effect function (Section 6.1), *h*_ref is a reference headway of 30 minutes, *h_i* is the route's actual headway, and ε is the frequency elasticity parameter.

The frequency elasticity ε used here is taken from the Elasticity tab's frequency elasticity input. An optional "Normalize by Length" setting additionally divides each route's ridership by its length before fitting (and the baseline projection is then scaled by corridor length; see Section 7.2).

The calibration is then fit on (CDI_i, *R*_i^norm) pairs. This ensures the calibration factor reflects pure demand differences rather than being confounded by routes that have high ridership primarily because of high frequency.

### 5.5 Shared-Pool Refit

When shared-pool normalization is active (Section 4.5), the calibration is automatically refitted after the combined TPI run. The tool re-runs the calibration fit using the original matched (route, ridership) pairs but with updated CDI values derived from the shared normalization pool. The resulting calibration object is flagged as `sharedPoolMode: true`.

---

## 6. Elasticity and Service Models

### 6.1 Frequency Elasticity

The relationship between service frequency and ridership follows a power-curve model, a form consistent with the transit elasticity literature synthesized in TCRP Report 95, Chapter 9:[^8]

$$E_{\text{freq}} = \left(\frac{f_{\text{new}}}{f_{\text{base}}}\right)^{\varepsilon_f}$$

where:
- *f* = 60 / headway (trips per hour)
- ε_f is the frequency elasticity parameter (default 0.60; user-adjustable range 0.1–1.0)

**Example.** Reducing headway from 30 minutes (2 trips/hr) to 15 minutes (4 trips/hr) at ε_f = 0.6:

$$E_{\text{freq}} = (4/2)^{0.6} = 2^{0.6} \approx 1.52$$

This indicates a 52% ridership increase from the frequency improvement alone. The power-curve form ensures diminishing marginal returns: doubling frequency from 60 to 30 minutes has a larger proportional effect than doubling from 15 to 7.5 minutes. This diminishing-returns behavior is corroborated empirically by Berrebi et al. (2021), who found that routes with already-frequent service showed the smallest ridership response to further frequency increases.[^11]

The values used here are consistent with the ranges reported in TCRP Report 95 (roughly 0.3–0.6) and are supported by newer empirical evidence. Berrebi et al. (2021), examining four U.S. transit agencies, estimated frequency elasticities of 0.66–0.78 — above the conventional range.[^11] The default of 0.60 is chosen to sit at the upper end of the conventional TCRP range while remaining conservative relative to this more recent evidence; users may raise it toward 0.7–0.8 where local conditions or agency data support a stronger frequency response. These figures characterize broad literature ranges rather than a single authoritative point estimate, and analysts preparing formal deliverables should verify the specific value adopted against the primary sources cited and, where possible, local data.[^8]

### 6.2 Service Span Elasticity

Service span — the number of hours per day that a route operates — affects ridership through a similar power-curve relationship:

$$E_{\text{span}} = \left(\frac{S_{\text{new}}}{S_{\text{base}}}\right)^{\varepsilon_s}$$

where *S*_base = 14 hours (the local bus default span) and ε_s is the span elasticity parameter (default 0.70; user-adjustable range 0.1–1.0).

**Example.** An 18-hour span at ε_s = 0.7:

$$E_{\text{span}} = (18/14)^{0.7} \approx 1.19$$

The span effect is applied in the Scenarios tab only, where each scenario has an explicit span input. It is not applied in the Elasticity tab, which focuses on headway and service-type effects.

**Literature basis.** Recommended parameter values:[^9]

| Value | Interpretation | Source |
|-------|---------------|--------|
| 0.5 | Conservative; appropriate when added off-peak hours are less productive | TCRP synthesis |
| 0.6–0.8 | Mid-range; supported by service-hours/miles elasticities around 0.7–0.8 | Currie & Loader (2009); TCRP |
| 0.83–0.9 | Aggressive; direct precedent from Hampton Roads Transit (0.83) and Currie & Loader findings on weekend evening extensions | Currie & Loader (2009); HRT planning practice |

### 6.3 Service Type Premiums

Service quality improvements beyond frequency generate additional ridership. The tool models this through service type premiums — percentage multipliers applied to the frequency-adjusted ridership estimate. Each service type carries a single low/high premium range (not separate frequency, speed and mode components). Four service type presets are provided:

| Service Type | Premium Range (Low–High) | Description |
|-------------|-------------------------|-------------|
| Local Bus (baseline) | 0%–0% | Standard fixed-route service; all premiums zero |
| Enhanced Bus | 5%–15% | Improved stops, limited branding, queue jumps |
| Limited-Stop Express | 0%–10% | Fewer stops for faster travel on longer trips |
| BRT-Style | 5%–25% | Dedicated lanes, level boarding, branded stations |

Premium values are user-adjustable via Conservative (%) and Optimistic (%) slider controls (0–150% range) that apply to the selected service type. The low and high values produce the conservative and optimistic ridership estimates, respectively, while the moderate estimate uses the midpoint: *mid* = (*low* + *high*) / 2.

> **[Note to user]:** The default service premium values represent the author's professional judgment informed by industry literature on BRT and service-quality ridership effects. Users preparing formal planning documents may wish to cite specific sources supporting the premium values used in their analysis, such as TCRP Report 118 (*Bus Rapid Transit Practitioner's Guide*), FTA research on ridership effects of BRT investments, or local before/after studies of service upgrades.[^10]

### 6.4 Combined Ridership Multiplier

The total service-effect multiplier combines frequency, span, and service premium:

$$M_{\text{level}} = E_{\text{freq}} \times E_{\text{span}} \times (1 + p_{\text{level}})$$

where *level* ∈ {low, mid, high} and *p* is the service premium fraction for that level. The span effect is applied in the Scenarios tab only; in the Elasticity tab the multiplier is *E*_freq × (1 + *p*).

### 6.5 Baseline Uncertainty Model

Calibrated ridership estimates carry inherent uncertainty from model simplification, data limitations, and corridor-specific factors not captured by the nine TPI variables. The tool represents this through a symmetric uncertainty band applied to the calibrated baseline projection *before* service-effect multipliers:

$$B_{\text{low}} = \max(0,\; B_{\text{mid}} \times (1 - u))$$
$$B_{\text{high}} = B_{\text{mid}} \times (1 + u)$$

where *B*_mid is the calibrated baseline ridership and *u* is the uncertainty percentage (default 25%; user-adjustable 0–60%).

Service-effect multipliers are then applied element-wise to the baseline band:

$$R_{\text{low}} = B_{\text{low}} \times M_{\text{low}}, \quad R_{\text{mid}} = B_{\text{mid}} \times M_{\text{mid}}, \quad R_{\text{high}} = B_{\text{high}} \times M_{\text{high}}$$

This produces a final conservative/moderate/optimistic ridership range that reflects both demand-side uncertainty and service-design variation.

---

## 7. Scenario Comparison

### 7.1 Operating Metrics

For each scenario, the tool computes standard transit operating metrics:

**Vehicles required:**

$$V = \left\lceil \frac{2L}{v \cdot (h/60)} \right\rceil$$

where *L* is route length (miles), *v* is average speed (mph), and *h* is headway (minutes). The factor of 2 accounts for round-trip travel. The ceiling function ensures a whole number of vehicles, with a minimum of one.

**Revenue hours per day:**

$$H_{\text{day}} = V \times S$$

where *S* is the service span in hours.

**Annual operating cost:**

$$C = H_{\text{day}} \times D \times c$$

where *D* is service days per year and *c* is cost per revenue hour.

### 7.2 Ridership Computation in Scenarios

Each scenario's ridership estimate proceeds as follows:

1. **Baseline projection.** Compute calibrated baseline ridership for the selected corridor:
   - Ratio method: *B*_mid = CDI × *k*
   - Regression method: *B*_mid = max(0, α + β × CDI)
   - The corridor length *L* enters only when "Normalize by Length" is enabled, in which case each expression is multiplied by *L*. In implementation, *B*_mid = max(0, CDI × *k* × *L*, (α + CDI × *k*) × *L*), where *k* is the calibration factor (the slope for regression), α = 0 for the ratio method, and *L* = 1 when length normalization is off.

2. **Baseline uncertainty.** Apply the uncertainty band to obtain (*B*_low, *B*_mid, *B*_high).

3. **Service multipliers.** Compute frequency effect, span effect, and service premiums.

4. **Final ridership.** Multiply element-wise: *R*_level = *B*_level × *E*_freq × *E*_span × (1 + *p*_level).

### 7.3 Productivity Metrics

Two standard transit productivity measures are computed:

$$\text{Boardings per revenue hour} = \frac{R_{\text{annual}}}{H_{\text{annual}}}$$

$$\text{Cost per boarding} = \frac{C_{\text{annual}}}{R_{\text{annual}}}$$

The cost-per-boarding calculation uses inverted ridership levels (low ridership produces high cost per boarding, and vice versa) to maintain internal consistency of the conservative/optimistic framing.

---

### 7.4 Population Projections

The Projections tab estimates how scenario ridership may change under future population conditions. The user uploads a population projection CSV (the interface references PPACG projections); projected population counts are added to the Census ACS baseline, and TPI is re-scored from the cached raw values for each horizon year (2030, 2040, 2050) without additional Census API calls. The scenario parameters from the Scenarios tab and the existing calibration are used, so the Calibrate and Scenarios tabs must be completed first. Results are shown as a timeline of the Moderate daily ridership estimate (with the Low–High range) alongside the CDI change for each horizon year, and can be exported as CSV.

---

## 8. Limitations and Appropriate Use

This methodology is subject to several limitations that users should consider when interpreting results:

1. **Relative normalization.** Quintile scores are relative to the study area. A CDI of 4.0 in a low-density region does not represent the same absolute demand as a 4.0 in a dense urban area, unless shared-pool normalization is used.

2. **Static demand.** The model uses point-in-time census data and does not account for future land use changes, induced demand, or transit-oriented development effects.

3. **No network effects.** Each corridor is evaluated independently. The model does not capture the effect of transfers, network connectivity, or competing parallel services.

4. **Simplified elasticities.** The power-curve elasticity model, while well-supported in the literature, does not capture threshold effects, market saturation, or asymmetric responses to service increases versus decreases.

5. **Calibration transferability.** Cross-system calibration assumes that the relationship between demographics and ridership is similar between the calibration and target systems. Differences in transit culture, land use patterns, fare policy, or competing modes may reduce transferability.

6. **ACS margin of error.** Small-area ACS estimates (especially at the block group level) carry significant margins of error that are not propagated through the model. Users should exercise caution when interpreting results for individual block groups.

> **[Note to user]:** When incorporating these results into formal planning documents, consider supplementing with sensitivity analyses (varying weights, elasticity parameters, and calibration data) to demonstrate the robustness of findings. The tool's adjustable parameters facilitate such analyses.

---

## 9. References

[^1]: Transit Cooperative Research Program. *TCRP Report 167: Making Effective Fixed-Guideway Transit Investments — Indicators of Success.* Transportation Research Board, 2014. **[User note: Confirm this or substitute a more specific citation for transit propensity factor selection methodology used in your region.]**

[^2]: Pushkarev, B., and Zupan, J. *Public Transportation and Land Use Policy.* Indiana University Press, 1977. See also: Ewing, R., and Cervero, R. "Travel and the Built Environment: A Meta-Analysis." *Journal of the American Planning Association* 76, no. 3 (2010): 265–294. **[User note: These are foundational citations for density–transit ridership relationships. Consider adding local or regional references as appropriate.]**

[^3]: When LODES data is absent, the 35-point employment weight is divided equally among all other factors with non-zero weights. For the default weight configuration, this adds approximately 4.4 points to each of the eight remaining active factors. The analysis remains valid but places heavier emphasis on residential population characteristics.

[^4]: The dynamic tract-level fallback is a data-availability safeguard. It is bypassed under area-weighted apportionment (the static tract-only handling is not) because the apportionment procedure requires consistent geographic boundaries between the raw values and the intersection geometries.

[^5]: This is a standard rank-based quintile assignment. It is equivalent to assigning percentile ranks and grouping them into five equal bins. Ties at quintile boundaries are resolved by sort-order position (first occurrence receives the lower quintile).

[^6]: The choice between separate and shared normalization pools is analogous to the distinction between within-system and cross-system percentile ranking. Separate pools preserve internal rankings; shared pools enable absolute comparisons at the cost of potentially masking within-system variation when systems differ greatly in scale.

[^7]: See any standard statistics reference, e.g., Weisberg, S. *Applied Linear Regression.* 4th ed. Wiley, 2014.

[^8]: Transit Cooperative Research Program. *TCRP Report 95: Traveler Response to Transportation System Changes, Chapter 9 — Transit Scheduling and Frequency.* Transportation Research Board, 2004. The commonly cited elasticity range of 0.3–0.6 for service frequency is drawn from this synthesis. **[User note: Consider also citing Evans (2004), *Traffic Engineering and Control*, for international evidence on bus service elasticities.]**

[^9]: Currie, G., and Loader, C. "High Ridership Growth from Extended Transit Service Hours: An Exploration of the Causes." *Transportation Research Record: Journal of the Transportation Research Board* 2110 (2009): 120–127. Hampton Roads Transit planning practice (ε = 0.83) is cited as a practitioner precedent. See also TCRP synthesis literature on service-hours elasticities. **[User note: This is the primary citation supporting the span elasticity parameter. Consider adding Balcombe et al. (2004), *The Demand for Public Transport: A Practical Guide*, TRL Report 593, for additional UK-based evidence.]**

[^10]: Transit Cooperative Research Program. *TCRP Report 118: Bus Rapid Transit Practitioner's Guide.* Transportation Research Board, 2007. See also: Hensher, D.A., and Golob, T.F. "Bus Rapid Transit Systems: A Comparative Assessment." *Transportation* 35, no. 4 (2008): 501–518. **[User note: Users should cite studies relevant to their specific service type assumptions. FTA before/after studies of BRT corridors may provide locally applicable premium values.]**

[^11]: Berrebi, S.J., Joshi, S., and Watkins, K.E. "Sensitivity of Transit Ridership to Frequency: Evidence from Four U.S. Agencies." Findings summarized in Raida, Ohlms, and Chen (2023), *VTRC 23-R16* (see [^12]). Across TriMet (Portland), Miami-Dade Transit, Metro Transit (Minneapolis–St. Paul), and MARTA (Atlanta), a 1% increase in service frequency was associated with ridership increases of 0.66%–0.78%; routes already operating at high frequency showed the smallest marginal response. **[User note: Confirm the primary Berrebi et al. citation and year against the original publication before formal use; the elasticity values here are reported via the VTRC synthesis.]**

[^12]: Raida, A., Ohlms, P.B., and Chen, T.D. *Improving Ridership Projections of Proposed Bus and Rail Transit Projects to Evaluate Congestion Reduction Effects.* Final Report VTRC 23-R16. Virginia Transportation Research Council, 2023. Provides a synthesis of before-after studies on bus stop amenities and service-frequency effects on ridership, plus an original Virginia before-after analysis. Reported stop-level ridership increases from amenity improvements (shelters, benches, real-time information, lighting) ranged from 1.5% to 140%, but the report emphasizes that these effects are highly context-dependent, frequently confounded with concurrent frequency changes and land-use shifts, and largely stop-level (partly redistributive) rather than net corridor-level gains — the route-level effect observed for real-time information was approximately 2%. This tool therefore does not model bus stop amenities as a separate parameter; any amenity-related ridership effect is subsumed within the service-type premiums (Section 6.3), where premium magnitudes are kept deliberately conservative at the corridor level.

---

## Appendix A: ACS Variable Reference

The following table provides the complete ACS variable codes used for each TPI factor. All variables are from the ACS 5-year Detailed Tables. Factors marked "tract-only" are fetched at the tract level and assigned to child block groups in block-group runs (Section 2.2).

| Factor | Table | Variables (Numerator) | Denominator |
|--------|-------|-----------------------|-------------|
| Population Density | B01003 | B01003_001E | Geography area (sq mi) |
| Zero-Vehicle HH (tract-only) | B08201, B11001 | B08201_002E | B11001_001E |
| Low-Income % (Poverty) (tract-only) | B17001, B01003 | B17001_002E | B01003_001E |
| Senior 65+ | B01001 | B01001_020E through _025E, _044E through _049E (12 cohorts, male + female) | B01003_001E |
| Disability % (tract-only) | B18101 | B18101_004E, _007E, _010E, _013E, _016E, _019E, _023E, _026E, _029E, _032E, _035E, _038E (12 cohorts) | B18101_001E |
| Minority | B03002 | B03002_001E − B03002_003E | B03002_001E |
| Young Adults 18–24 % | B01001 | B01001_007E through _010E, _031E through _034E (8 cohorts, male + female) | B01003_001E |
| LEP % (tract-only) | C16001 | C16001_005E, _008E, _011E, _014E, _017E, _020E, _023E, _026E, _029E, _032E, _035E, _038E (12 language categories) | C16001_001E |
| Employment Density | LODES WAC | C000 (total jobs, block-level, aggregated to analysis geography) | Geography area (sq mi) |

---

## Appendix B: Notation Summary

| Symbol | Definition |
|--------|-----------|
| *Q_{g,f}* | Quintile score (1–5) for geography *g* on factor *f* |
| *w_f* | Normalized weight for factor *f* |
| TPI_g | Composite Transit Propensity Index for geography *g* |
| CDI | Corridor Demand Index (population-weighted mean of TPI across corridor) |
| *P_g* | Estimated population of geography *g* |
| *k* | Ratio calibration factor |
| α, β | OLS regression intercept and slope |
| ε_f | Frequency elasticity parameter (default 0.60) |
| ε_s | Service span elasticity parameter (default 0.70) |
| *E*_freq | Frequency effect multiplier |
| *E*_span | Span effect multiplier |
| *p* | Service type premium (fraction) |
| *u* | Baseline uncertainty percentage (default 0.25) |
| *B* | Baseline ridership estimate (before service effects) |
| *R* | Final ridership estimate |
| *V* | Vehicles required |
| *L* | Route length (miles) |
| *v* | Average operating speed (mph) |
| *h* | Headway (minutes) |
| *S* | Service span (hours/day) |

---

*This document was prepared as a technical reference for the Micro Analysis Tool's Transit Propensity Index and Ridership Forecasting modules. All formulas and parameters described herein correspond to the tool's current implementation. Users are encouraged to verify parameter selections against local conditions and applicable agency standards before incorporating results into formal planning deliverables.*
