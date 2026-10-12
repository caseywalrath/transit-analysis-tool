"""Reproduce the numbers in service-hours-reconciliation-memo.md.

usage: reconcile_memo.py <nobuild_feed_dir> <Federal_Blvd_Service_Plan.xlsx>
Needs openpyxl (pip install openpyxl) for the spreadsheet half.

1. Existing 2023 annual hours for routes 29/30/31 from the No-Build GTFS:
   - trip time (first departure -> last arrival per trip, whole route)
   - block span (first departure -> last arrival per block_id, i.e. with layover)
   annualized with the Plan memo's 255 weekdays / 52 Saturdays / 58 Sundays.
2. BRT trip-only hours from the Plan spreadsheet's WK/SA/SU Times sheets
   (first to last timepoint per trip, both directions).
"""
import csv, sys, datetime, collections

feed, xlsx = sys.argv[1], sys.argv[2]
DAYS = {"WK": 255, "SA": 52, "SU": 58}


def h(s):
    a, b, c = s.strip().split(":")
    return int(a) * 3600 + int(b) * 60 + int(c)


def rd(p):
    return csv.DictReader(open(p, encoding="utf-8-sig"))


routes = {"29", "30", "31"}
trips = {t["trip_id"]: t for t in rd(feed + "/trips.txt") if t["route_id"] in routes}
span = {}
for r in rd(feed + "/stop_times.txt"):
    if r["trip_id"] in trips:
        s = span.setdefault(r["trip_id"], [10 ** 9, 0])
        s[0] = min(s[0], h(r["departure_time"])); s[1] = max(s[1], h(r["arrival_time"]))
trip_hrs = collections.defaultdict(float)
blk = collections.defaultdict(lambda: [10 ** 9, 0]); blk_routes = collections.defaultdict(set)
for tid, (a, b) in span.items():
    if a == 0 and b == 0:
        continue  # placeholder trip
    t = trips[tid]
    trip_hrs[(t["route_id"], t["service_id"])] += (b - a) / 3600
    k = (t["service_id"], t["block_id"].strip())
    blk[k][0] = min(blk[k][0], a); blk[k][1] = max(blk[k][1], b); blk_routes[k].add(t["route_id"])

print("Existing (No-Build GTFS), trip hours per day:")
for k in sorted(trip_hrs):
    print("  route %-3s %-6s %6.1f" % (k[0], k[1], trip_hrs[k]))
for grp in (["29", "30", "31"], ["29"], ["30", "31"]):
    ann = sum(v * DAYS.get(s, 0) for (r, s), v in trip_hrs.items() if r in grp)
    print("  annual trip hours, routes %s: %.0f" % ("+".join(grp), ann))
ann_blk = sum((e - a) / 3600 * DAYS.get(s, 0) for (s, b), (a, e) in blk.items() if blk_routes[(s, b)] <= {"30", "31"})
print("  annual block-span hours (with layover), routes 30+31: %.0f" % ann_blk)

import openpyxl
wb = openpyxl.load_workbook(xlsx, data_only=True)


def sec(v):
    if isinstance(v, datetime.datetime):  # after midnight is stored as a date: 1900-01-01 00:24 = 24:24
        return (v - datetime.datetime(1899, 12, 31)).total_seconds()
    if isinstance(v, datetime.time):
        return v.hour * 3600 + v.minute * 60 + v.second
    if isinstance(v, datetime.timedelta):
        return v.total_seconds()
    return None


print("BRT plan (spreadsheet), trip hours without layover:")
ann = 0
for sheet, days in (("WK Times", 255), ("SA Times", 52), ("SU Times", 58)):
    rows = list(wb[sheet].iter_rows(values_only=True))
    hdr = next(i for i, r in enumerate(rows) if r[0] == "Block")
    n, tot = 0, 0.0
    for c0 in (2, 19):  # southbound, northbound timepoint blocks
        for r in rows[hdr + 1:]:
            t = [sec(x) for x in r[c0:c0 + 11]]
            idx = [i for i, x in enumerate(t) if x is not None]
            if len(idx) < 2:
                continue
            tot += ((t[idx[-1]] - t[idx[0]]) % 86400) / 3600; n += 1
    ann += tot * days
    print("  %-9s %3d trips  %6.1f hrs/day" % (sheet, n, tot))
print("  annual BRT trip hours: %.0f" % ann)
