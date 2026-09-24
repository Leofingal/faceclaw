#!/bin/bash
# Ring-link harness (2026-09-24): the REAL FaceclawBleCommunicator on a plain
# JVM, against a fake BLE manager and a fake ring. See RingLinkHarness.java.
#
#   notes/ring-link-harness/run.sh [source-root] [out-dir]
#
# source-root defaults to this checkout. Point it at any other checkout (e.g. a
# `git archive` of the base) to run the same harness against that code - which
# is how it shows it catches the bug rather than merely passing on the fix.
# Needs ANDROID_HOME (android.jar supplies every Android type the ring path
# does not touch; the handful it does touch are replaced by android-stubs/).
set -u
H=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "${1:-$H/../..}" && pwd)
OUT=${2:-${TMPDIR:-/tmp}/ring-link-harness}
: "${ANDROID_HOME:?ANDROID_HOME must point at the Android SDK}"
AJ=$(ls "$ANDROID_HOME"/platforms/android-*/android.jar | sort -V | tail -1)
J="$SRC/App_Resources/Android/src/main/java/com/faceclaw/app"
rm -rf "$OUT"
mkdir -p "$OUT/app" "$OUT/stubs" "$OUT/harness" "$OUT/transcript"
echo "harness source root: $SRC"
echo "android.jar:         $AJ"

# 1. The real app code, compiled against android.jar, with the fake manager
#    standing in for the real one (same package, same signatures).
javac -nowarn -encoding UTF-8 -d "$OUT/app" -cp "$AJ" \
    -sourcepath "$H/fake-ble:$H/tns-stub:$SRC/App_Resources/Android/src/main/java" \
    "$H/fake-ble/com/faceclaw/app/FaceclawBleManager.java" \
    "$J"/g2protocol/*.java "$J"/util/*.java "$J/FaceclawBleCommunicator.java" \
    > "$OUT/javac-app.log" 2>&1 || { cat "$OUT/javac-app.log"; echo "HARNESS_EXIT: compile-app"; exit 2; }

# 2. Runtime stand-ins for the few Android classes the ring path touches.
javac -nowarn -encoding UTF-8 -d "$OUT/stubs" -cp "$AJ" $(find "$H/android-stubs" -name '*.java') \
    > "$OUT/javac-stubs.log" 2>&1 || { cat "$OUT/javac-stubs.log"; echo "HARNESS_EXIT: compile-stubs"; exit 2; }

# 3. The harness itself, against the stand-ins.
javac -nowarn -encoding UTF-8 -d "$OUT/harness" -cp "$OUT/stubs:$OUT/app:$AJ" "$H/RingLinkHarness.java" \
    > "$OUT/javac-harness.log" 2>&1 || { cat "$OUT/javac-harness.log"; echo "HARNESS_EXIT: compile-harness"; exit 2; }

# Stand-ins first, so they shadow android.jar's "Stub!" bodies.
java ${HARNESS_JAVA_OPTS:-} -cp "$OUT/harness:$OUT/stubs:$OUT/app:$AJ" com.faceclaw.app.RingLinkHarness "$OUT/transcript"
rc=$?
echo "HARNESS_EXIT: $rc"
exit $rc
