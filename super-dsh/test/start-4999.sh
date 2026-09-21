#!/usr/bin/env bash
# start-4998.sh — AW-A acceptance instance (adapted from multi-agent-ctx template).
# One process: CTX0 web face on 127.0.0.1:4998 + ctx-omp world (plugin-spawned,
# loopback-ephemeral listener). SUPERD_KEEP: left running; stop via systemctl.
set -euo pipefail
PORT=4999
UNIT="aw-4999-test"
REPO="$HOME/workspaces/superd"
LOG="$REPO/.scratch/aw-4999.log"
NODE_BIN="/usr/bin/node"

if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  exit 1
fi
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
WATERMARK=$(wc -l < "$LOG" 2>/dev/null || echo 0)

# Native-home ruling (2026-09-17): the OMP world inherits the native ~/.omp
# app data as-is — no HOME redirection, no config seeding. The former
# AW_OMP_MCP_EXCLUDE prune was dropped by user decision, so the world loads
# the native agent/mcp.json unchanged (heavy stdio servers included by choice).
systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$REPO/super-dsh/test" \
  --property=Environment="DSH_HOME=$REPO/.tests/aw" \
  --property=Environment="SUPERD_DSH_ANCHOR=$REPO/upstream/deepseek-harness/package.json" \
  --property=Environment="AW_BARE_BASE=$REPO/.tests/aw/profiles/node_modules/" \
  --property=Environment="SUPERD_KEEP=1" \
  --property=Environment="AGY_CLI_HOME=/tmp/agy-home-key2" \
  --property=Environment="AGY_PROXY=http://187.127.111.29:7474" \
  --property=Environment="AW_TRUSTED_HOSTS=192.168.31.130,192.168.31.130:4999,192.168.31.130:4998" \
  --property=Environment="DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$REPO/super-dsh/test/smoke.mjs"

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { journalctl --user -u "$UNIT" --no-pager | tail -30; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }
echo "--- listening on ${PORT}; token URL (this boot):"
# Every ctx (ctx0 + each world's virtual webServer) prints a token line; only
# ctx0's authenticates against the single auth domain. Verify each candidate
# and hand out the one that actually serves the index.
JAR=$(mktemp)
for t in $(tail -n +$((WATERMARK + 1)) "$LOG" | grep -o 'token=[^ ]*' | cut -d= -f2 | tac); do
  # ctx0 answers 303-first and sets the auth cookie (repo convention: curl -c jar -L).
  if [ "$(curl -s -c "$JAR" -L -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/?token=${t}")" = "200" ]; then
    echo "http://127.0.0.1:${PORT}/?token=${t}"
    echo "WAN: https://test.pc.randomhash.app/?token=${t}"
    break
  fi
done
echo "SUPERD_KEEP=1 — left running for acceptance; stop: systemctl --user stop $UNIT"
