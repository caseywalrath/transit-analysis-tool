"""Corridor service hours from a GTFS feed + an exported stop list (CSV from the app).

usage: corridor_hours.py <feed_dir> <stoplist.csv> <label> <out_dir> [min_run] [bridge]

- Corridor stops = every stop_id in the CSV (in_feed ignored; ids absent from the
  feed simply never match). The SAME list is applied to both feeds.
- editlist.txt ExcludeRoute lines are honored (Build drops 30/31 there).
- Per trip: runs of consecutive corridor stops in stop_sequence order. A run may
  bridge up to `bridge` consecutive non-list stops (default 0). Runs shorter than
  `min_run` corridor stops (default 2) are dropped (a crossing route touches 1).
  Corridor time = sum over runs of (last arrival - first departure).
  Corridor miles = straight-line stop to stop within each run.
- Writes <label>_trips.csv (one row per trip-run) and <label>_summary.csv.
- Also reports "gap" stops: non-list stops sandwiched between list stops within a
  trip, i.e. places where the list has a hole that splits a run.
"""
import csv, sys, os, math, collections

feed, listcsv, label, outdir = sys.argv[1:5]
MIN_RUN = int(sys.argv[5]) if len(sys.argv) > 5 else 2
BRIDGE = int(sys.argv[6]) if len(sys.argv) > 6 else 0


def read(p):
    with open(p, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def hms(s):
    h, m, x = s.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(x)


def fmt(sec):
    return "%02d:%02d" % (sec // 3600, (sec % 3600) // 60)


def miles(a, b):
    la1, lo1, la2, lo2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(h))


corr = {r["stop_id"].strip() for r in read(listcsv) if r["stop_id"].strip()}
stops = {r["stop_id"]: r for r in read(os.path.join(feed, "stops.txt"))}
excluded = set()
el = os.path.join(feed, "editlist.txt")
if os.path.exists(el):
    for r in read(el):
        if (r.get("command") or "").strip() == "ExcludeRoute":
            excluded.add(r["parameter1"].strip())
trips = [t for t in read(os.path.join(feed, "trips.txt")) if t["route_id"] not in excluded]
st = collections.defaultdict(list)
for r in read(os.path.join(feed, "stop_times.txt")):
    st[r["trip_id"]].append(r)

out_rows = []
gaps = collections.Counter()
for t in trips:
    rows = st.get(t["trip_id"])
    if not rows:
        continue
    rows.sort(key=lambda r: int(r["stop_sequence"]))
    if hms(rows[0]["departure_time"]) == 0 and hms(rows[-1]["arrival_time"]) == 0:
        continue  # placeholder trip
    flags = [r["stop_id"] in corr for r in rows]
    # gap diagnostic: 1-2 non-list stops between list stops
    i = 0
    while i < len(rows):
        if not flags[i]:
            j = i
            while j < len(rows) and not flags[j]:
                j += 1
            if i > 0 and j < len(rows) and (j - i) <= 2:
                for k in range(i, j):
                    gaps[(rows[k]["stop_id"], t["route_id"])] += 1
            i = j
        else:
            i += 1
    # runs with optional bridging
    runs, cur, pend = [], [], []
    for r, f in zip(rows, flags):
        if f:
            if cur and pend:
                cur.extend(pend)
            pend = []
            cur.append(r)
        elif cur:
            pend.append(r)
            if len(pend) > BRIDGE:
                runs.append(cur); cur, pend = [], []
    if cur:
        runs.append(cur)
    for run in runs:
        nlist = sum(1 for r in run if r["stop_id"] in corr)
        if nlist < MIN_RUN:
            continue
        a, b = hms(run[0]["departure_time"]), hms(run[-1]["arrival_time"])
        pts = [(float(stops[x["stop_id"]]["stop_lat"]), float(stops[x["stop_id"]]["stop_lon"])) for x in run]
        mi = sum(miles(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        out_rows.append({
            "route_id": t["route_id"], "service_id": t["service_id"], "trip_id": t["trip_id"],
            "direction_id": t.get("direction_id", ""), "block_id": (t.get("block_id") or "").strip(),
            "headsign": t.get("trip_headsign", ""),
            "entry_stop": run[0]["stop_id"], "entry_name": stops[run[0]["stop_id"]]["stop_name"], "entry_time": fmt(a),
            "exit_stop": run[-1]["stop_id"], "exit_name": stops[run[-1]["stop_id"]]["stop_name"], "exit_time": fmt(b),
            "corridor_stops": nlist, "corridor_min": round((b - a) / 60, 2), "corridor_mi": round(mi, 3),
        })

with open(os.path.join(outdir, label + "_trips.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
    w.writeheader(); w.writerows(out_rows)

agg = collections.defaultdict(lambda: [0, 0.0, 0.0, set()])
for r in out_rows:
    a = agg[(r["route_id"], r["service_id"])]
    a[0] += 1; a[1] += r["corridor_min"] / 60; a[2] += r["corridor_mi"]
    if r["block_id"]: a[3].add(r["block_id"])
with open(os.path.join(outdir, label + "_summary.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["route_id", "service_id", "trip_runs", "corridor_hrs", "corridor_mi", "blocks"])
    for (rid, sid), (n, h, mi, bl) in sorted(agg.items()):
        w.writerow([rid, sid, n, round(h, 2), round(mi, 2), len(bl)])

print("%s: list=%d stops, excluded routes=%s, trip-runs=%d" % (label, len(corr), sorted(excluded), len(out_rows)))
print("gap stops (non-list stop between list stops; stop, route: trips):")
for (sid, rid), n in gaps.most_common(15):
    print("   %-7s %-28s route %-6s %d" % (sid, stops[sid]["stop_name"][:28], rid, n))
