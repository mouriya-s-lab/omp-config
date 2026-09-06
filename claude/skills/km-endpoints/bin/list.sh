#!/bin/bash
# List all Komodo endpoints registered in the external inventory.
# Each line: <name>  <host>
# There is no "active" endpoint — every km call picks its target via
# `km -p <name>` per invocation (see render-config.sh).
set -euo pipefail

ENDPOINTS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/komodo/endpoints"

found=0
for f in "$ENDPOINTS_DIR"/*.toml; do
    [ -e "$f" ] || continue
    found=1
    name="$(basename "$f" .toml)"
    host="$(awk -F'"' '/^host/ {print $2; exit}' "$f")"
    printf '%-20s %s\n' "$name" "$host"
done

if [ "$found" -eq 0 ]; then
    echo "No endpoints defined in $ENDPOINTS_DIR" >&2
    exit 1
fi
