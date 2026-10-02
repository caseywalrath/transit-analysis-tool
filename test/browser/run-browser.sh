#!/usr/bin/env bash
# Runs every browser behavior test in test/browser/ (test/browser/*.test.mjs).
#
#   bash test/browser/run-browser.sh
#
# Requires Playwright resolvable via NODE_PATH and a browser (Chromium is
# preinstalled at /opt/pw-browsers/chromium in the Claude Code cloud
# environment) — see test/browser/README.md for the one-time setup.
#
# Deliberately NOT folded into test/run-tests.sh: the golden tests are
# zero-install and must stay runnable with nothing but Node, while these
# need Playwright plus a real browser.
#
# Runs every file even if an earlier one fails, prints each file's own
# PASS/FAIL summary, and exits non-zero if any file did.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

shopt -s nullglob
FILES=("$DIR"/*.test.mjs)
shopt -u nullglob

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No *.test.mjs files found in $DIR"
  exit 0
fi

overall=0
for f in "${FILES[@]}"; do
  echo "=== $(basename "$f") ==="
  node "$f"
  status=$?
  [ $status -ne 0 ] && overall=1
  echo
done

exit $overall
