#!/usr/bin/env bash
# start-codex-app.sh — the codex world as a STANDALONE app (no ctx0 selector,
# no hub, no spawned world): one dsh process whose composition IS the adapter
# bundle (codex-provider + codex routes + the pinned browse directory picker).
# LAN via a socat relay bound to the LAN IP only (never 0.0.0.0).
set -euo pipefail
PORT="${AW_APP_PORT:-4988}"
UNIT="aw-codex-app-${PORT}-test"
RELAY_UNIT="aw-codex-app-${PORT}-relay"
LAN_HOST="${SUPERD_LAN_HOST:-192.168.31.130}"
MAIN_REPO="$HOME/workspaces/superd"
WT="$MAIN_REPO"   # main checkout: the adapter lives at super-dsh/agent-codex
LOG="$MAIN_REPO/.scratch/aw-codex-app-${PORT}.log"
# Dedicated app home: the adapter pack under test owns ALL DSH-level state
# (workspace registry, settings, session logs) — the shared .tests/aw
# home carries other lines' leftovers (17 workspaces, stale settings).
# Test $DSH_HOME (repo convention): the agent APP home is
# $DSH_HOME/agents/<label> and its dsh profile packages live in
# $DSH_HOME/profiles/<label>. No per-app bespoke home.
HOME_DIR="${AW_APP_HOME:-$WT/.tests}"
LABEL="codex"
NODE_BIN="/usr/bin/node"
LAUNCHER="$MAIN_REPO/upstream/deepseek-harness/apps/cli/lib/bin.js"

if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  exit 1
fi

# nested codex home (reads ~/.codex READ-ONLY, one-way valve)
DSH_HOME="$HOME_DIR" "$NODE_BIN" "$WT/super-dsh/agent-codex/scripts/setup-codex-home.mjs"

# ---- standalone profile: the adapter bundle IS the app composition ----
PROF="$HOME_DIR/profiles/$LABEL"
mkdir -p "$PROF"
cat > "$PROF/package.json" <<JSON
{
  "name": "aw-codex-app-profile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@pgmi-builds/agent-adapter-codex"
      ]
    }
  }
}
JSON
cat > "$PROF/cordis.patch.yml" <<YML
# Standalone codex app: a REAL user-facing listener (loopback; LAN only via
# the socat relay). The provider rows (codex-provider + native-row disables +
# permission table + the pinned browse directory picker) are the adapter
# bundle's own patch — this file carries only the profile-specific posture.
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
YML
# profile-local pnpm posture (matches the line's other profiles)
cat > "$PROF/pnpm-workspace.yaml" <<'YML'
nodeLinker: hoisted
autoInstallPeers: false
YML
# @pgmi-builds resolution: symlinks into the worktree (same as the other
# profiles — the hub and adapter are worktree-local packages)
PGMB="$HOME_DIR/profiles/node_modules/@pgmi-builds"
mkdir -p "$PGMB"
# package name → worktree directory (they differ: the adapter package
# @pgmi-builds/agent-adapter-codex lives in super-dsh/agent-codex)
ln -sfn "$WT/super-dsh/agent-codex" "$PGMB/agent-adapter-codex"

systemctl --user reset-failed "$UNIT" 2>/dev/null || true
touch "$LOG"
WATERMARK=$(wc -l < "$LOG")

systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$WT/super-dsh/agent-codex" \
  --property=Environment="DSH_HOME=$HOME_DIR" \
  --property=Environment="SUPERD_DSH_ANCHOR=$MAIN_REPO/upstream/deepseek-harness/package.json" \
  --property=Environment="CODEX_TRACE=${CODEX_TRACE:-0}" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$LAUNCHER" --profile "$LABEL" --no-open --trusted-host "$LAN_HOST"

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q "127.0.0.1:${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { journalctl --user -u "$UNIT" --no-pager | tail -30; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }

TOKEN=$(tail -n +$((WATERMARK + 1)) "$LOG" | grep -oE "token=[A-Za-z0-9_-]+" | tail -1 | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "no token in log" >&2; tail -30 "$LOG"; exit 1; }

# ---- LAN relay (socat, LAN IP only; never 0.0.0.0) ----
systemctl --user reset-failed "$RELAY_UNIT" 2>/dev/null || true
systemctl --user stop "$RELAY_UNIT" 2>/dev/null || true
systemd-run --user --unit="$RELAY_UNIT" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  /usr/bin/socat "TCP-LISTEN:${PORT},fork,reuseaddr,bind=${LAN_HOST}" "TCP:127.0.0.1:${PORT}"

sleep 1
curl -s -c /tmp/aw-codex-app.jar -L -o /dev/null -w "LAN follow → %{http_code}\n" "http://${LAN_HOST}:${PORT}/?token=${TOKEN}" || true

echo "loopback : http://127.0.0.1:${PORT}/?token=${TOKEN}"
echo "LAN      : http://${LAN_HOST}:${PORT}/?token=${TOKEN}"
echo "unit     : $UNIT   (stop: systemctl --user stop $UNIT $RELAY_UNIT)"
