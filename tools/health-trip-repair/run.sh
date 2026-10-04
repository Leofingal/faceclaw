#!/bin/bash
# One-off health repair after the Japan trip (2026-10-04). Run in the faceclaw distrobox.
#
#   tools/health-trip-repair/run.sh <snapshot health dir> <out dir> [older ring-pages.jsonl ...]
#
# Extra journals are merged in by page number, for pages the phone's journal has
# trimmed since they were snapshotted (it compacts committed lines past 128 KB).
# <snapshot health dir> holds a copy of the phone's files/health (read only here).
# <out dir> receives health/ (the repaired copy, every file), report.json,
# decoded.jsonl and repaired.md5. Exit 0 only if every acceptance assertion holds.
set -euo pipefail
SNAP=$(cd "${1:?snapshot health dir}" && pwd)
OUT=${2:?out dir}
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=$(cd "$HERE/../.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
rm -rf "$OUT/health" "$OUT/classes"
cd "$TREE"
echo "tree $(git rev-parse --short HEAD) dirty=$(git status --short | wc -l)"
npx tsc -p tests/tsconfig.json
javac -d "$OUT/classes" App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/RingProtocol.java "$HERE/DecodePages.java"
java -cp "$OUT/classes" com.faceclaw.app.DecodePages "$SNAP/ring-pages.jsonl" "${@:3}" > "$OUT/decoded.jsonl"
set +e
node "$HERE/repair.cjs" "$SNAP" "$OUT/decoded.jsonl" "$OUT/health" "$OUT/report.json" > "$OUT/repair.log"
status=$?
set -e
(cd "$OUT/health" && md5sum * > "$OUT/repaired.md5")
tail -n 30 "$OUT/repair.log"
exit $status
