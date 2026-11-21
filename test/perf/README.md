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
