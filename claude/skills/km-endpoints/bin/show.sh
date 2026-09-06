#!/bin/bash
# Print fixed, shell-escaped Bash assignments. Capture with tracing disabled,
# check success, then evaluate the quoted output in a scoped Bash subshell.
# Output:
#   NAME=<name>
#   HOST=<url>
#   KEY=<api-key>
#   SECRET=<api-secret>
#
# Usage: show.sh <name>
#
# This script is the per-invocation analogue of `km -p <name>`: callers
# that need raw HTTP curl access (not the km CLI) read host/key/secret
# from here. There is no implicit "active" endpoint — callers must pass
# <name> explicitly, mirroring `km -p <name>`. This avoids the global
# mutable state that previously made concurrent sessions race.
set +x
set -euo pipefail

ENDPOINTS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/komodo/endpoints"

if [ "$#" -ne 1 ]; then
    echo "Usage: $(basename "$0") <name>" >&2
    echo "Available endpoints:" >&2
    ls -1 "$ENDPOINTS_DIR"/*.toml 2>/dev/null | xargs -n1 basename | sed 's/\.toml$//' | sed 's/^/  /' >&2 || true
    exit 2
fi

name="$1"
endpoint_file="$ENDPOINTS_DIR/${name}.toml"

if [ ! -f "$endpoint_file" ]; then
    echo "ERROR: endpoint '$name' not found at $endpoint_file" >&2
    echo "Available:" >&2
    ls -1 "$ENDPOINTS_DIR"/*.toml 2>/dev/null | xargs -n1 basename | sed 's/\.toml$//' | sed 's/^/  /' >&2 || true
    exit 1
fi

# Python 3.11+ supplies a real TOML parser and standard shell quoting.
# Parse and encode in one process: shell command substitution would strip
# trailing newlines from individual decoded values.
exec python3 - "$name" "$endpoint_file" <<'PY'
import shlex
import sys

try:
    import tomllib
except ImportError:
    sys.exit("ERROR: show.sh requires Python 3.11+ with stdlib tomllib")

try:
    with open(sys.argv[2], "rb") as endpoint:
        fields = tomllib.load(endpoint)
except (OSError, UnicodeError, tomllib.TOMLDecodeError):
    # Parser diagnostics can contain source text, including credentials.
    sys.exit("ERROR: endpoint file is unreadable or invalid TOML")

assignments = [f"NAME={shlex.quote(sys.argv[1])}"]
for field in ("host", "key", "secret"):
    value = fields.get(field)
    if not isinstance(value, str) or not value:
        sys.exit(f"ERROR: endpoint requires a nonempty string field: {field}")
    if "\0" in value:
        sys.exit(f"ERROR: endpoint field cannot contain NUL: {field}")
    assignments.append(f"{field.upper()}={shlex.quote(value)}")

# Emit nothing until every field is valid. Quoted newlines remain literal,
# including trailing newlines, and no parsed value is executed or logged.
sys.stdout.write("\n".join(assignments) + "\n")
PY
