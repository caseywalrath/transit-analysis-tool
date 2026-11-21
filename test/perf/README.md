# GTFS loading baseline (test/perf)

`gtfs-baseline.mjs` loads a real GTFS ZIP into the real app in headless
Chromium and prints how heavy the load is. It measures only; it never fails on
a slow number. Feeds are NOT committed: pass any path.

```bash
NODE_PATH=/opt/node-tools/node_modules node test/perf/gtfs-baseline.mjs <feed.zip> [--runs N]
```

A missing or unreadable path prints usage and exits 2. Exit 1 means a run
failed (load returned false, layers never appeared, crash or timeout). Each run
uses a fresh browser context, so no cache carries over.

## What the numbers mean

- `parseMs`: from calling `App.loadGTFSFile` until its promise resolves.
- `toMapMs`: from the same start until a GTFS map layer exists and the map is
  idle (null if that takes over 300 s).
- `longestFreezeMs`, `longTaskCount`, `totalLongTaskMs`: main-thread long tasks
  (over 50 ms) seen from the load start until 0.5 s after the map is ready.
  null if the browser lacks the longtask API.
- `heapBeforeMB` / `heapAfterMB` / `heapDeltaMB`: JS heap after a forced GC,
  before and after the load.
- `gtfsSessionChars`: length of `JSON.stringify({gtfsData: App.serializeGTFSData()})`,
  the GTFS part of a full-session export (null if it throws).
- `ok`: load returned true and the layers appeared.

The last output line is `RESULT ` followed by single-line JSON.

## Synthetic feed

`make-synthetic-feed.mjs` writes a deterministic, RTD-sized fake GTFS ZIP so
tests can load a large feed without a download. Feeds are NOT committed; write
the output to a scratch path.

```bash
node test/perf/make-synthetic-feed.mjs <out.zip> [--scale S]
```

`S` defaults to 1.0 (any number above 0). Bad arguments print usage and exit 2.
Success prints `WROTE <path> <bytes> bytes, <N> stop_times rows` and exits 0.
The same arguments always give a byte-identical ZIP.

At scale 1 it holds 9,040 stops (9,000 grid stops plus 40 parent stations with
two platforms each), 155 routes (150 `R001`..`R150` plus frequency routes
`F01`..`F05`), a WKDY/SAT/SUN calendar with holiday exceptions, about 835,000
stop_times rows, and one shape per route and direction. Frequency routes use one
template trip per direction. The stops file has a byte-order mark and the
calendar file uses CRLF line ends, like real feeds.
