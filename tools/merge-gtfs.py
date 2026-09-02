#!/usr/bin/env python3
"""Merge two or more GTFS feeds into one prefixed demo feed.

Python 3 stdlib only (zipfile, csv, io) -- no third-party dependencies.

Usage:
    python3 tools/merge-gtfs.py \
      --feed AVN=data/gtfs/avon-co-us.zip \
      --feed GET=data/gtfs/greeleyevans-co-us.zip \
      --out data/gtfs/colorado-demo-gtfs.zip

Each feed's id columns (route_id, trip_id, stop_id, shape_id, service_id,
block_id, fare_id, zone_id, parent_station, from_stop_id, to_stop_id,
origin_id, destination_id, contains_id) are prefixed with "CODE_" so the
merged feed has no id collisions between source feeds. agency_id is handled
separately: a blank agency_id becomes exactly CODE; a non-blank one is
prefixed like every other id column, and the resolved value is written into
every routes.txt row for that feed (GTFS allows a blank routes.txt
agency_id when the feed has exactly one agency, so the source value cannot
always be trusted to already match).
"""

import argparse
import csv
import datetime
import io
import sys
import zipfile

ID_COLUMNS = {
    "route_id", "trip_id", "stop_id", "shape_id", "service_id", "block_id",
    "fare_id", "zone_id", "parent_station", "from_stop_id", "to_stop_id",
    "origin_id", "destination_id", "contains_id",
}

SUMMARY_FILES = ("routes.txt", "trips.txt", "stops.txt", "shapes.txt")


def read_feed_tables(path):
    """Return {filename: {"header": [...], "rows": [dict, ...]}} for every
    .txt file in the zip. A top-level subfolder prefix is stripped the same
    way js/projects/gtfs.js loadGTFSFile() does (path.split("/").pop())."""
    tables = {}
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = info.filename.split("/")[-1]
            if not name.endswith(".txt"):
                continue
            with z.open(info) as f:
                text = f.read().decode("utf-8-sig", errors="replace")
            if not text.strip():
                tables[name] = {"header": [], "rows": []}
                continue
            reader = csv.DictReader(io.StringIO(text))
            header = reader.fieldnames or []
            rows = [{k: v for k, v in r.items() if k is not None} for r in reader]
            tables[name] = {"header": header, "rows": rows}
    return tables


def prefix_ids(tables, code):
    """Prefix every ID_COLUMNS value in every file except agency.txt (which
    process_agency handles) with "CODE_". Blank values are left blank."""
    for fname, table in tables.items():
        if fname == "agency.txt":
            continue
        for row in table["rows"]:
            for col in ID_COLUMNS:
                val = row.get(col)
                if val is not None and val.strip():
                    row[col] = code + "_" + val.strip()


def process_agency(tables, code):
    """Resolve agency_id for this feed's agency.txt rows and propagate the
    result into routes.txt. Returns the list of resolved agency_id values."""
    agency_table = tables.get("agency.txt")
    resolved_ids = []
    if agency_table and agency_table["rows"]:
        for row in agency_table["rows"]:
            old_id = (row.get("agency_id") or "").strip()
            new_id = code if not old_id else (code + "_" + old_id)
            row["agency_id"] = new_id
            resolved_ids.append(new_id)
    else:
        resolved_ids = [code]

    routes_table = tables.get("routes.txt")
    if routes_table:
        if len(resolved_ids) == 1:
            # Single-agency feed: GTFS allows a blank routes.txt agency_id
            # in this case, so every route unambiguously belongs to this
            # one agency -- write the resolved id into every row.
            for row in routes_table["rows"]:
                row["agency_id"] = resolved_ids[0]
        else:
            # Multi-agency feed: remap any route agency_id that matches one
            # of this feed's original agency_id values; leave blanks as-is
            # (ambiguous with more than one agency, not exercised by the
            # two single-agency demo feeds this tool currently targets).
            for row in routes_table["rows"]:
                val = (row.get("agency_id") or "").strip()
                if val:
                    row["agency_id"] = code + "_" + val
    return resolved_ids


def merge_feeds(feed_specs):
    """feed_specs: [(code, path), ...]. Returns (merged_tables, summary)."""
    merged = {}
    summary = []

    for code, path in feed_specs:
        tables = read_feed_tables(path)
        agency_ids = process_agency(tables, code)
        prefix_ids(tables, code)

        trips = tables.get("trips.txt", {"rows": []})["rows"]
        block_id_count = sum(1 for r in trips if (r.get("block_id") or "").strip())
        counts = {}
        for fname in SUMMARY_FILES:
            counts[fname] = len(tables.get(fname, {"rows": []})["rows"])
        summary.append({
            "code": code,
            "agency_ids": agency_ids,
            "counts": counts,
            "trip_count": len(trips),
            "block_id_populated": block_id_count,
        })

        for fname, table in tables.items():
            if fname == "feed_info.txt":
                continue  # dropped; a single merged feed_info.txt replaces per-feed ones
            dest = merged.setdefault(fname, {"header": [], "rows": []})
            for col in table["header"]:
                if col not in dest["header"]:
                    dest["header"].append(col)
            dest["rows"].extend(table["rows"])

    today = datetime.date.today().strftime("%Y%m%d")
    merged["feed_info.txt"] = {
        "header": ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_version"],
        "rows": [{
            "feed_publisher_name": "Colorado Statewide GTFS Database",
            "feed_publisher_url": "https://www.codot.gov",
            "feed_lang": "en",
            "feed_version": today,
        }],
    }

    return merged, summary


def write_feed(tables, out_path):
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for fname, table in sorted(tables.items()):
            if not table["header"]:
                continue
            buf = io.StringIO()
            writer = csv.DictWriter(buf, fieldnames=table["header"], extrasaction="ignore")
            writer.writeheader()
            for row in table["rows"]:
                writer.writerow({col: row.get(col, "") or "" for col in table["header"]})
            z.writestr(fname, buf.getvalue())


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--feed", action="append", required=True, metavar="CODE=path.zip",
                         help="A CODE=path.zip pair; repeatable, one per source feed.")
    parser.add_argument("--out", required=True, help="Output zip path.")
    args = parser.parse_args(argv)

    feed_specs = []
    for spec in args.feed:
        if "=" not in spec:
            parser.error("--feed must be CODE=path.zip, got: %s" % spec)
        code, path = spec.split("=", 1)
        feed_specs.append((code, path))

    merged, summary = merge_feeds(feed_specs)
    write_feed(merged, args.out)

    print("Merged %d feed(s) -> %s" % (len(feed_specs), args.out))
    for s in summary:
        print("  %s: agency_id=%s  routes=%d trips=%d stops=%d shapes=%d  block_id populated %d/%d trips"
              % (s["code"], ",".join(s["agency_ids"]), s["counts"]["routes.txt"], s["counts"]["trips.txt"],
                 s["counts"]["stops.txt"], s["counts"]["shapes.txt"],
                 s["block_id_populated"], s["trip_count"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
