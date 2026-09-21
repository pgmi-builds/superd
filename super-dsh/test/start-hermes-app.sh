#!/usr/bin/env bash
# start-hermes-app.sh — the hermes adapter as a STANDALONE app (no ctx0
# selector, no hub, no spawned world): one dsh process whose composition IS
# the adapter bundle (hermes-provider + the single `hermes` llm route + the
# pinned browse directory picker). Loopback listener only — this line runs no
# LAN relay and no --trusted-host (add one only if user acceptance needs it).
#
# HOME RULING (2026-09-17): the TUI gateway owns the live transcript; the
# DSH-side state (session log copy = the WebUI read surface, dsh-sessions.json
# mapping) lands under $DSH_HOME/agents/hermes automatically — there is NO
# home seeding step here (unlike the codex line's setup-codex-home.mjs).
#
# Bootstrap: scripts/setup-hermes-profile.mjs (idempotent) generates
# $DSH_HOME/profiles/hermes-standalone/ and verifies the @pgmi-builds links.
#
# Teardown: systemctl --user stop hermes-4985-test   (never kill)
set -euo pipefail

PORT="${AW_APP_PORT:-4985}"
UNIT="hermes-${PORT}-test"
WT="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root (test/ → super-dsh → repo)
LOG="$WT/.scratch/hermes-${PORT}.log"
HOME_DIR="${AW_APP_HOME:-$WT/.tests}"
LABEL="hermes-standalone"
NODE_BIN="/opt/node-v22.23.2/bin/node"
# dev base: prefer the self-contained repo build; SUPERD_DSH overrides; machine-global is the fallback
DSH="${SUPERD_DSH:-$WT/upstream/deepseek-harness/apps/cli/lib/bin.js}"
[ -f "$DSH" ] || DSH="/home/u1/.local/bin/dsh"

if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  exit 1
fi

# idempotent standalone-profile bootstrap (bundle set + webserver port 4985 + links)
DSH_HOME="$HOME_DIR" "$NODE_BIN" "$WT/super-dsh/agent-hermes/scripts/setup-hermes-profile.mjs"

systemctl --user reset-failed "$UNIT" 2>/dev/null || true
touch "$LOG"
# remember the log's current line count so token extraction below cannot race
# against a previous boot's token line
WATERMARK=$(wc -l < "$LOG")

systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$WT" \
  --property=Environment="DSH_HOME=$HOME_DIR" \
  --property=Environment="PATH=/home/u1/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$DSH" --profile "$LABEL" --no-open

ok=""
for _ in $(seq 1 45); do
  sleep 2
  if ss -tln | grep -q "127.0.0.1:${PORT} "; then ok=1; break; fi
  state=$(systemctl --user is-active "$UNIT" 2>/dev/null || true)
  if [ "$state" = "failed" ]; then { echo "unit $UNIT failed:" >&2; tail -30 "$LOG" >&2; exit 1; }; fi
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT} to listen" >&2; tail -30 "$LOG" >&2; exit 1; }

# token: only lines appended by THIS boot (past the watermark), retried briefly —
# the token line lands in the log shortly after the port opens
TOKEN=""
for _ in $(seq 1 15); do
  TOKEN=$(tail -n +$((WATERMARK + 1)) "$LOG" | grep -o "http://127\.0\.0\.1:${PORT}/?token=[^\" ]*" | tail -1 | grep -o 'token=.*' | cut -d= -f2 || true)
  [ -n "$TOKEN" ] && break
  sleep 2
done
[ -n "$TOKEN" ] || { echo "no token found in $LOG (lines after $WATERMARK)" >&2; tail -20 "$LOG" >&2; exit 1; }

echo "unit:   $UNIT (active)"
echo "home:   $HOME_DIR"
echo "local:  http://127.0.0.1:${PORT}/?token=${TOKEN}"
echo "stop:   systemctl --user stop $UNIT"
