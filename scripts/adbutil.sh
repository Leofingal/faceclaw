# Sourceable adb helper functions shared by the scripts/ utilities.
# Not a standalone script; use:  source "$(dirname "$0")/adbutil.sh"

# adb_preflight <package>
#
# Checks that adb exists, exactly one device is reachable, and <package> is
# installed, then prints the install mode on stdout:
#   debug    - debuggable build; run-as works
#   release  - installed but not debuggable; run-as is refused
# Any other condition prints a diagnosis to stderr and returns nonzero (which
# aborts callers running under `set -e`).
adb_preflight() {
    local package="$1"
    local state

    if ! command -v adb >/dev/null 2>&1; then
        echo "Error: adb not found on PATH" >&2
        return 1
    fi

    # get-state fails outright when there is no device or more than one, and
    # reports states like "offline" / "unauthorized" for unusable ones.
    if ! state="$(adb get-state 2>&1)"; then
        echo "Error: no usable adb device ($state)." >&2
        echo "       Connected devices:" >&2
        adb devices -l | sed '1d;/^$/d' >&2
        return 1
    fi
    if [ "$state" != "device" ]; then
        echo "Error: adb device is in state '$state' (offline/unauthorized?)" >&2
        return 1
    fi

    # grep rather than pm's exit code: exit-code propagation over `adb shell`
    # needs shell protocol v2, which very old adb binaries lack.
    if ! adb shell pm path "$package" 2>/dev/null | grep -q "^package:"; then
        echo "Error: $package is not installed on this device" >&2
        return 1
    fi

    if adb shell run-as "$package" true >/dev/null 2>&1; then
        echo debug
    else
        echo release
    fi
}
