#!/usr/bin/env bash
# Test stand-in for the agy binary: runs the stream-json mock with same argv.
exec node "$(dirname "$0")/mock_agy.mjs" "$@"
