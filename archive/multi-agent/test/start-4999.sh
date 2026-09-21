#!/usr/bin/env bash
# start-4999.sh — bring up the Multi-Agent test instance (registry + omp sdk
# provider) on 4999 (LAN-exposed), modeled on apps/ui-preact/test/start-4999.sh
# and the repo AGENTS.md 三 dsh-plugin launch contract.
#
# Usage:  bash apps/multi-agent/test/start-4999.sh [port]     (default 4999)
#   MA_TRUSTED_HOSTS="dom1 dom2"   extra --trusted-host entries for external
#                                   (reverse-proxied) origins; default
#                                   test.pc.randomhash.app (Teddy/Caddy → 4999).
#
# Notes:
# - Bootstraps the profile first: node scripts/profiles/ma.mjs
#   (idempotent; creates .superd-test/profiles/ma with both bundle links).
# - Test home is ALWAYS the repo .superd-test (never ~/.dsh, never ~/.superd).
# - Teardown: systemctl --user stop ma-4999-test   (never kill).

set -euo pipefail

PORT="${1:-4999}"
UNIT="ma-${PORT}-test"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$REPO/.scratch/ma-${PORT}.log"
DSH_BIN="/opt/node-v22.23.2/bin/node"
# dev base: prefer the self-contained repo build; SUPERD_DSH overrides; machine-global is the fallback
DSH="${SUPERD_DSH:-$REPO/upstream/deepseek-harness/apps/cli/lib/bin.js}"
[ -f "$DSH" ] || DSH="/home/u1/.local/bin/dsh"
DSH_HOME_DIR="$REPO/.superd-test"
TRUSTED=()
for h in ${MA_TRUSTED_HOSTS:-test.pc.randomhash.app}; do TRUSTED+=(--trusted-host "$h"); done

if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  exit 1
fi

# profile bootstrap is idempotent (bundle set + hoisted install)
node "$REPO/scripts/profiles/ma.mjs" >/dev/null

# relink the repo-root @deepseek-ai/* tree to the active installation (AGENTS.md 二/三)
node "$REPO/scripts/heal-modules.mjs" >/dev/null

# remember the log's current line count so token extraction below cannot race
# against a previous boot's token line (ui-preact scar)
MARK=$(wc -l < "$LOG" 2>/dev/null || echo 0)

systemctl --user reset-failed "$UNIT" 2>/dev/null || true

systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$REPO" \
  --property=Environment=DSH_HOME="$DSH_HOME_DIR" \
  --property=Environment=PATH="/home/u1/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$DSH_BIN" "$DSH" --profile ma --no-open "${TRUSTED[@]}"

ok=""
for _ in $(seq 1 45); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  state=$(systemctl --user is-active "$UNIT" 2>/dev/null || true)
  if [ "$state" = "failed" ]; then { echo "unit $UNIT failed:" >&2; tail -30 "$LOG" >&2; exit 1; }; fi
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT} to listen" >&2; tail -30 "$LOG" >&2; exit 1; }

# token: only lines appended by THIS boot (past the mark), retried briefly —
# the token line lands in the log shortly after the port opens
TOK=""
for _ in $(seq 1 15); do
  TOK=$(tail -n +$((MARK + 1)) "$LOG" | grep -o "http://127\.0\.0\.1:${PORT}/?token=[^\" ]*" | tail -1 | grep -o 'token=.*' | cut -d= -f2 || true)
  [ -n "$TOK" ] && break
  sleep 2
done
[ -n "$TOK" ] || { echo "no token found in $LOG (lines after $MARK)" >&2; tail -20 "$LOG" >&2; exit 1; }

LAN_IP=$(hostname -I | awk '{print $1}')
echo "unit:   $UNIT (active)"
echo "home:   $DSH_HOME_DIR"
echo "local:  http://127.0.0.1:${PORT}/?token=${TOK}"
echo "lan:    http://${LAN_IP}:${PORT}/?token=${TOK}"
for h in ${MA_TRUSTED_HOSTS:-test.pc.randomhash.app}; do
  echo "wan:    https://${h}/?token=${TOK}"
done
