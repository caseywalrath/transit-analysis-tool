# Offline Crosswalk Guide: TAZ Projections → Census Tract Population Additions

**Purpose:** Convert a regional planning agency's TAZ-level population projections (this guide uses the PPACG MPO's as the worked example) into census tract population additions that the analysis tool can use. This is a one-time process per metro area. The result is a small CSV file you upload into the tool.

**License required:** ArcGIS Pro Basic (all tools used are available at Basic)

**Time estimate:** 45–60 minutes the first time; ~15 minutes for subsequent project areas once you have the base data layers set up.

---

## What You're Building

The tool works with census tract geographies. The MPO data uses TAZ geographies. These don't line up. The crosswalk calculates, for each census tract: "how many **additional people** are projected to live in this tract in 2030, 2040, and 2050, compared with 2020?"

The tool adds these counts to the tract's current ACS population (`pop_new = pop_census + pop_addition`). It does not use growth rates or multipliers. Working with additions has a useful property: people are counted, not averaged. Each TAZ's projected change is split among the tracts it overlaps in proportion to area, and the pieces add back up to the TAZ's full change. Regional totals are preserved, and near-empty greenfield TAZs that project a huge percentage jump from a tiny baseline (e.g., 3 people → 5,992) contribute their actual numeric change (5,989 people) and nothing more, rather than distorting a ratio.

The output looks like this:

```
GEOID,pop_2030,pop_2040,pop_2050
08041960100,420,980,1650
08041960200,60,110,230
...
```

`pop_2050 = 1650` means the model projects 1,650 more residents in that tract in 2050 than in 2020. The tool adds that number to your current ACS census population when running a future-year analysis. Negative values are allowed for tracts projected to lose population (the tool will not let a tract's population drop below zero).

**Accepted column headers:** `GEOID` (also `geoid`, `Geoid`, `GeoID`, `tract`, `TRACT`) and any of `pop_2030`, `pop_2040`, `pop_2050` (also `Pop_2030`/`POP_2030`/`population_2030`, and likewise for 2040 and 2050). At least one year column is required; a missing year column is treated as 0. A CSV that only has columns like `gf_2030` is rejected.

---

## Part 1: Gather Your Data Layers

### Step 1A — Export the TAZ Layer from ArcGIS Online

The MPO TAZ service requires login, so you'll export it manually rather than querying it directly.

1. Sign in to ArcGIS Online at [arcgis.com](https://www.arcgis.com)
2. In the Search bar, search for: `PPACG TAZ Forecasted Changes`
3. Open the item page for **PPACG TAZ Forecasted Changes 2020 to 2050**
4. Click **Open in Map Viewer** (or click the three-dot menu and choose **Export → Export to GeoJSON** or **Export to Shapefile**)
   - GeoJSON is fine; shapefile also works
   - If prompted for an extent, choose the full layer
5. Download the exported file to your computer
6. Note the folder location — you'll add it to ArcGIS Pro in Step 2

> **Alternative:** If you have the layer already loaded in a web map, you can right-click the layer in Map Viewer and choose **Save As Layer File** or export directly from there.

---

### Step 1B — Download Census Tract Boundaries

You need census tract polygons for the same state. The fastest source is the Census TIGER/Line shapefiles.

1. Go to: [https://www.census.gov/cgi-bin/geo/shapefiles/index.php](https://www.census.gov/cgi-bin/geo/shapefiles/index.php)
2. Select **Year: 2022** (or the year closest to your ACS data vintage — use the same year your tool is configured to query)
3. Under **Layer type**, select **Census Tracts**
4. Select **State: Colorado**
5. Click **Submit**, then download the `.zip` file
6. Unzip it to a known folder (e.g., `C:\GIS_Data\Census\`)

The file will be named something like `tl_2022_08_tract.shp` (08 = Colorado FIPS code).

---

## Part 2: Set Up Your ArcGIS Pro Project

### Step 2A — Create a New Project

1. Open ArcGIS Pro
2. Click **New** → **Map** → give it a name like `TAZ_Crosswalk` → click **OK**
3. A new map opens with a basemap

### Step 2B — Add Both Layers

**Add the census tracts:**
1. In the **Catalog** pane (right side), click **Add Data** (folder icon) or use the **Map** tab → **Add Data** button
2. Browse to where you saved the census tracts shapefile
3. Select `tl_2022_08_tract.shp` and click **OK**

**Add the TAZ layer:**
1. Click **Add Data** again
2. Browse to the GeoJSON or shapefile you exported from ArcGIS Online
3. Select it and click **OK**

Both layers should now appear in your **Contents** pane on the left and be visible on the map. Zoom to Colorado to confirm both layers look right — you should see the TAZ areas overlapping with census tracts across the metro area.

### Step 2C — Check the Field Names

Before proceeding, verify the actual field names in the TAZ attribute table (field names in the database may differ from the display aliases):

1. Right-click the TAZ layer in the **Contents** pane → **Attribute Table**
2. Look for fields containing population data. They might be named:
   - `POP_2020`, `POP_2030`, `POP_2040`, `POP_2050` — or
   - `Pop2020`, `Pop2030`, etc. — or
   - `Population_2020`, etc.
3. Write down the exact field names for Population 2020, 2030, 2040, and 2050. You'll need these in later steps.
4. Also note the TAZ ID field name (likely `TAZ` or `TAZ_ID`)

> **If the fields have commas in their values** (like "1,010"), the data was exported with number formatting. You may need to clean this — see the comma note in the Troubleshooting section at the end.

### Step 2D — Calculate TAZ Total Area

You need each TAZ's total area so you can compute each piece's share of its TAZ later (share = intersection area ÷ TAZ area). This must be calculated **before** running the Intersect, because after Intersect the geometries are split into pieces.

1. Open the TAZ layer's attribute table
2. Click **Add** (the plus icon) to add a new field
   - **Name:** `taz_area_sqm`
   - **Data Type:** `Double`
   - Click **OK**
3. Right-click the `taz_area_sqm` column header → **Calculate Geometry**
   - **Property:** `Area`
   - **Area Unit:** `Square Meters`
   - Click **OK**

Each TAZ now has its total area recorded. This value will carry through to the Intersect output so you can compute each piece's share of its TAZ.

---

## Part 3: Run the Spatial Overlay (Intersect)

The Intersect tool cuts both polygon layers against each other, creating a new layer where every polygon represents the overlap between one TAZ and one census tract. This is how we calculate how much of each tract comes from each TAZ.

### Step 3A — Open the Intersect Tool

1. Click the **Analysis** tab in the ribbon
2. Click **Tools** to open the Geoprocessing pane
3. In the search box, type `Intersect`
4. Click **Intersect (Analysis Tools)**

### Step 3B — Configure the Tool

- **Input Features:** Add both layers:
  - Click the dropdown and add your **Census Tracts** layer
  - Click the dropdown again and add your **TAZ** layer
- **Output Feature Class:** Give it a name like `TAZ_Tract_Intersect` and save it in your project geodatabase (the default location is fine)
- **Join Attributes:** Leave as `ALL`
- **Output Type:** Leave as `INPUT` (polygons)

Click **Run**. This may take 1–3 minutes depending on the number of TAZs and tracts.

### Step 3C — Verify the Output

1. The result layer (`TAZ_Tract_Intersect`) appears in the Contents pane
2. Open its attribute table (right-click → Attribute Table)
3. You should see columns from both the census tracts AND the TAZ layer combined into one table. Each row is one intersection polygon.
4. Confirm columns exist for: census tract GEOID, TAZ population fields, and the TAZ ID field

> **Expected row count:** There will be many more rows than either source layer had individually — that's correct. One TAZ spanning 3 tracts generates 3 rows.

---

## Part 4: Calculate Areas, Shares, and Population Additions

Now you'll add calculated fields to the intersection layer. All of this is done in the attribute table using **Add Field** and **Field Calculator**.

The key idea: for each TAZ, work out how many people it is projected to **add** (projected population minus 2020 population), then hand each intersection piece its area share of that change. Summing the pieces per tract gives the tract's population addition.

> **Why change, not projected total:** The tool adds your file to the current ACS population. If you uploaded projected totals, the baseline would be counted twice. Using each TAZ's change from its own 2020 figure also means any difference between the MPO's 2020 base and the ACS base does not leak into the result.

### Step 4A — Calculate Intersection Area

1. In the attribute table toolbar, click **Add** (the plus icon) to add a new field
   - **Name:** `area_sqm`
   - **Data Type:** `Double`
   - Click **OK**
2. Right-click the `area_sqm` column header → **Calculate Geometry**
   - **Property:** `Area`
   - **Area Unit:** `Square Meters`
   - Click **OK**

Each row now has the area of that intersection piece in square meters.

### Step 4B — Calculate Area Share

For each intersection piece, calculate what fraction of its TAZ it covers:

1. Add a new field: **Name:** `area_share`, **Data Type:** `Double`
2. Right-click `area_share` → **Calculate Field**
3. In the expression box:
   ```python
   !area_sqm! / !taz_area_sqm! if !taz_area_sqm! and !taz_area_sqm! > 0 else 0
   ```
4. Click **OK**

**What this produces:** A number between 0 and 1. A TAZ that lies entirely inside one tract has a single piece with share 1.0; a TAZ split across three tracts has three pieces whose shares add up to 1.0.

> **Assumption:** This treats the TAZ's growth as spread evenly across its area. For small urban TAZs that is reasonable. For a large TAZ that straddles a built-up tract and an empty one, the change is split by land area, not by where development is expected. If you know better, adjust the shares or split the TAZ first.

### Step 4C — Calculate TAZ Population Additions

You need one addition column per projection year: projected population minus 2020 population.

**For 2030:**
1. Add a new field: **Name:** `add_2030`, **Data Type:** `Double`
2. Right-click `add_2030` → **Calculate Field**
3. In the expression box (substituting your actual field names from Step 2C):
   ```python
   (!POP_2030! or 0) - (!POP_2020! or 0)
   ```
4. Click **OK**

**Repeat for 2040:**
1. Add field `add_2040` (Double)
2. Calculate Field: `(!POP_2040! or 0) - (!POP_2020! or 0)`

**Repeat for 2050:**
1. Add field `add_2050` (Double)
2. Calculate Field: `(!POP_2050! or 0) - (!POP_2020! or 0)`

> **Note:** Do not name these fields `pop_2030` etc. at this stage. ArcGIS field names are not case-sensitive, so they would clash with the TAZ layer's own `POP_2030` field.

### Step 4D — Allocate Additions to Intersection Pieces

For each intersection polygon, multiply the TAZ's addition by the piece's area share. These are the values you'll sum up per tract.

**For 2030:**
1. Add field `alloc_2030` (Double)
2. Calculate Field: `!add_2030! * !area_share!`

**Repeat for 2040 and 2050:**
- `alloc_2040` = `!add_2040! * !area_share!`
- `alloc_2050` = `!add_2050! * !area_share!`

---

## Part 5: Summarize by Census Tract

Now you aggregate all the intersection pieces up to the tract level by summing the allocated additions.

### Step 5A — Run Summary Statistics

1. In the Geoprocessing pane, search for `Summary Statistics`
2. Click **Summary Statistics (Analysis Tools)**
3. Configure:
   - **Input Table:** `TAZ_Tract_Intersect`
   - **Output Table:** Name it `Tract_Additions` (this will be a table, not a shapefile)
   - **Statistics Fields:** Add each of the following:
     | Field | Statistic Type |
     |-------|---------------|
     | `alloc_2030` | SUM |
     | `alloc_2040` | SUM |
     | `alloc_2050` | SUM |
   - **Case Field:** Set this to your census tract **GEOID** field (it might be called `GEOID`, `GEOID_1`, or similar — look for the 11-character tract identifier)
4. Click **Run**

The result is a table with one row per census tract. `SUM_alloc_2030` is the projected number of added residents in that tract by 2030, and so on.

### Step 5B — Create the Final Addition Columns

Open the `Tract_Additions` table. It will have columns like `SUM_alloc_2030`.

Copy the sums into columns with the names the tool expects, rounded to whole people:

**For 2030:**
1. Add field `pop_2030` (Double) to this table
2. Calculate Field: `round(!SUM_alloc_2030!)`

**Repeat for 2040 and 2050:**
- `pop_2040` = `round(!SUM_alloc_2040!)`
- `pop_2050` = `round(!SUM_alloc_2050!)`

> **If you start from projected tract totals instead:** If your source already gives projected population per tract (or you crosswalked projected totals with this same area-share method), the addition is the projected total minus the tract's current population: `pop_2050 = projected_2050 − ACS baseline`. Use the same ACS year the tool is configured to query. For TAZ data, the method above is simpler and avoids baseline mismatch.

### Step 5C — Rename the GEOID Column

The GEOID column in the Summary Statistics output may have been renamed (e.g., to `GEOID_1` or `CASE_GEOID`). The tool expects a column called `GEOID`.

1. In the table, right-click the GEOID column header → **Fields** (opens the Fields view)
2. Find the GEOID field and change its **Field Name** to `GEOID`
3. Save and close the Fields view

---

## Part 6: Export to CSV

### Step 6A — Remove Unnecessary Columns (Optional but Recommended)

The summary table has intermediate columns (`SUM_alloc_2030`, etc.) that you don't need in the final CSV. You can hide them:

1. In the table, right-click any column header → **Fields**
2. Uncheck the visibility boxes for all columns except: `GEOID`, `pop_2030`, `pop_2040`, `pop_2050`
3. Save

### Step 6B — Export as CSV

1. Right-click the `Tract_Additions` table in the **Contents** pane
2. Choose **Data → Export Table**
3. Configure:
   - **Output Table:** Browse to a folder and name the file `ppacg_population_additions.csv`
   - Make sure the format is `.csv` (Text File)
4. Click **OK**

### Step 6C — Verify the Output

Open the CSV in Excel or a text editor. It should look like:

```
GEOID,pop_2030,pop_2040,pop_2050
08001000100,0,0,0
08001000201,85,240,410
08041000100,1320,3650,6200
...
```

**Things to check:**
- The GEOID column contains 11-character strings (not numbers — Excel sometimes strips leading zeros). The tool pads short GEOIDs with leading zeros and trims longer ones to 11 characters, so a stripped zero is tolerated, but check the file anyway.
- Addition values are reasonable. Most tracts should add a few hundred to a few thousand people by 2050; negative values are valid for shrinking tracts. As a sanity check, add up each column: the total should be close to the region's projected 2050 population minus its 2020 population (it will match exactly if every TAZ overlaps your tracts).
- The file has no header other than the column names (no title row)
- Rows where all three years are 0 (like the first example row) are valid but have no effect; the tool drops them on load, so the tract count it reports may be lower than the number of rows in your file.

> **If Excel stripped leading zeros from GEOIDs:** Open the CSV in a text editor (Notepad, VS Code) and check whether GEOIDs like `08001000100` appear correctly. If they show as `8001000100` (10 digits instead of 11), the tool will repair this on load, but it is cleaner to fix the file. In Excel: select the GEOID column → Format Cells → Text → re-enter a value to trigger re-read, or simply use the text editor to confirm the raw file is correct (ArcGIS usually preserves them as strings).

---

## Part 7: Upload to the Tool

1. In the web analysis tool, open the **Ridership Forecasting** panel and go to its **Projections** tab ("Population Growth Projections"). Complete the **Calibrate** and **Scenarios** tabs first — the tab asks for this before it will run.
2. Click **Upload CSV**
3. Select your `ppacg_population_additions.csv` file
4. The tab will show: "Loaded: ppacg_population_additions.csv — [N] tracts"
5. Click **Run Projections**. The tool adds each tract's addition to its ACS population and re-scores your scenarios for all three horizon years (2030, 2040, 2050) at once, using the parameters from the Scenarios tab. There is no year dropdown.

To remove the projection file, click **Clear**.

> The projection file is applied through the Ridership Forecasting Projections tab, which re-scores the Transit Propensity Index inputs for each horizon year. The Transit Propensity Index module on its own has no year selector, so it does not use the file.

---

## Troubleshooting

**"The Intersect tool ran but my output has very few rows"**
Both layers must use the same coordinate system (projection). Check: right-click each layer → Properties → Source tab → Spatial Reference. If they differ, reproject one to match the other using **Project (Data Management)** before running Intersect.

**"My additions are all 0"**
This usually means the GEOID column from the census tracts didn't match the Case field in Summary Statistics, or the `add_*` fields were calculated from the wrong columns. Open the intersection layer attribute table and confirm you can see the tract GEOID values and non-zero `add_2030` values. Also confirm the Summary Statistics case field points to the right column.

**"The tool says it could not find any population projection columns"**
The CSV must contain at least one of `pop_2030`, `pop_2040`, `pop_2050`. A file with `gf_*` columns (growth factors from an older version of this guide) will not load.

**"All `area_share` values are 0"**
Check that you calculated `taz_area_sqm` on the TAZ layer **before** running Intersect (Step 2D). If you added it after, the Intersect output won't have the field. Also check that `POP_2020` and the projection fields have numeric values (not text with commas — see the comma note below).

**"Some tracts show very large additions"**
This is expected for greenfield tracts where the MPO projects new development (e.g., a few thousand people added to an almost empty tract). Check it against the source: sum the TAZ additions that overlap the tract and confirm it matches. If a large TAZ straddles a developed tract and an empty one, area-based allocation may place too many people in the wrong tract (see the assumption in Step 4B).

**"I have tracts with no TAZ coverage"**
This can happen near the metro boundary. Those tracts will simply be missing from the Summary Statistics output (or have 0 additions). The tool treats any GEOID not found in the CSV as an addition of 0, so those tracts keep their current ACS population.

**"The TAZ field names have commas in numeric values (e.g., '1,010')"**
If the exported TAZ layer stored population values as text strings with comma formatting, you need to clean them before calculating additions. In the Calculate Field step, use:
```python
float(str(!POP_2030!).replace(',', '')) - float(str(!POP_2020!).replace(',', ''))
```
Or clean the fields first using a single Calculate Field pass: `float(str(!POP_2020!).replace(',', ''))` into a new numeric field.

---

## Reusing This File on Future Projects

The population additions CSV covers the entire metro area. For future projects in the same region:

- **Same MPO projection vintage:** Reuse the existing CSV as-is
- **Updated MPO projections:** Re-run from Part 3 onward with the new TAZ data
- **Different metro area with different MPO:** Start from Part 1 with that MPO's TAZ layer and the relevant state's census tracts

The crosswalk methodology is the same regardless of MPO — any TAZ dataset with baseline and projected population values can be processed this way, and the tool accepts any CSV with a GEOID column and `pop_2030`/`pop_2040`/`pop_2050` columns.
