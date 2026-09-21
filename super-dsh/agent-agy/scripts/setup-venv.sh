#!/usr/bin/env bash
# Durable venv hosting the google-antigravity SDK for the bridge.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$HERE/.venv"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q google-antigravity
echo "$VENV/bin/python"
