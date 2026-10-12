"""Route-by-route No-Build vs Build comparison from corridor_hours.py summaries.

usage: compare.py <output_dir>
Reads <output_dir>/nobuild_summary.csv and build_summary.csv and writes
<output_dir>/route_comparison.csv: one row per day type x route, plus a TOTAL row
per day type. Day types: Weekday = service_id WK (MT/FR are Mon-Thu/Fri variants
and would be added here if a corridor route used them), Saturday = SA,
Sunday = SU, School-day add-on = DPSWK.
"""
import csv, os, sys, collections

out = sys.argv[1]
DAYS = [("Weekday", {"WK", "MT"}), ("Saturday", {"SA"}), ("Sunday", {"SU"}), ("School-day add-on", {"DPSWK"})]


def load(name):
    with open(os.path.join(out, name + "_summary.csv"), newline="") as f:
        return list(csv.DictReader(f))


data = {"nobuild": load("nobuild"), "build": load("build")}
rows = []
for day, sids in DAYS:
    per = {sc: collections.defaultdict(lambda: [0, 0.0, 0.0]) for sc in data}
    hw = {sc: {} for sc in data}  # route -> shortest peak headway (min) across the day type's service_ids
    for sc, recs in data.items():
        for r in recs:
            if r["service_id"] in sids:
                p = per[sc][r["route_id"]]
                p[0] += int(r["trip_runs"]); p[1] += float(r["corridor_hrs"]); p[2] += float(r["corridor_mi"])
                if r.get("peak_headway_min"):
                    v = float(r["peak_headway_min"])
                    hw[sc][r["route_id"]] = min(v, hw[sc].get(r["route_id"], v))
    routes = sorted(set(per["nobuild"]) | set(per["build"]),
                    key=lambda k: -max(per["nobuild"].get(k, [0, 0])[1], per["build"].get(k, [0, 0])[1]))
    tot = [0, 0.0, 0.0, 0, 0.0, 0.0]
    for rid in routes:
        a = per["nobuild"].get(rid, [0, 0.0, 0.0]); b = per["build"].get(rid, [0, 0.0, 0.0])
        for i in range(3):
            tot[i] += a[i]; tot[i + 3] += b[i]
        rows.append([day, rid, a[0], round(a[1], 2), round(a[2], 1), hw["nobuild"].get(rid, ""),
                     b[0], round(b[1], 2), round(b[2], 1), hw["build"].get(rid, ""),
                     round(b[1] - a[1], 2), round(b[2] - a[2], 1)])
    if routes:
        rows.append([day, "TOTAL", tot[0], round(tot[1], 2), round(tot[2], 1), "", tot[3], round(tot[4], 2),
                     round(tot[5], 1), "", round(tot[4] - tot[1], 2), round(tot[5] - tot[2], 1)])

with open(os.path.join(out, "route_comparison.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["day_type", "route_id", "nobuild_trips", "nobuild_hrs", "nobuild_mi", "nobuild_peak_headway_min",
                "build_trips", "build_hrs", "build_mi", "build_peak_headway_min", "change_hrs", "change_mi"])
    w.writerows(rows)
for r in rows:
    if r[1] == "TOTAL":
        print("%-18s No-Build %7.1f hrs  Build %7.1f hrs  change %+.1f" % (r[0], r[3], r[7], r[10]))
