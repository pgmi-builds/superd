#!/usr/bin/env bash
# start-pi-app.sh — the pi adapter as a STANDALONE app (no ctx0 selector, no
# hub): one dsh process whose composition IS the adapter bundle (pi-provider +
# pi route + the pinned browse directory picker). LAN via a socat relay bound
# to the LAN IP only (never 0.0.0.0).
#
# HOME RULING (2026-09-17): pi keeps its NATIVE data home ~/.pi — there is NO
# home seeding step here (the codex line's setup-codex-home analog does not
# exist for pi). The adapter's DSH-side state (dsh-sessions.json mapping)
# lands under $DSH_HOME/agents/pi automatically.
set -euo pipefail
PORT="${AW_APP_PORT:-4987}"
UNIT="aw-pi-app-${PORT}-test"
RELAY_UNIT="aw-pi-app-${PORT}-relay"
LAN_HOST="${SUPERD_LAN_HOST:-192.168.31.130}"
MAIN_REPO="$HOME/workspaces/superd"
WT="$MAIN_REPO"
LOG="$MAIN_REPO/.scratch/aw-pi-app-${PORT}.log"
HOME_DIR="${AW_APP_HOME:-$WT/.tests}"
LABEL="pi"
NODE_BIN="/usr/bin/node"
LAUNCHER="$MAIN_REPO/upstream/deepseek-harness/apps/cli/lib/bin.js"

if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  exit 1
fi

# ---- standalone profile: the adapter bundle IS the app composition ----
PROF="$HOME_DIR/profiles/$LABEL"
mkdir -p "$PROF"
cat > "$PROF/package.json" <<JSON
{
  "name": "aw-pi-app-profile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@pgmi-builds/agent-adapter-pi"
      ]
    }
  }
}
JSON
cat > "$PROF/cordis.patch.yml" <<YML
# Standalone pi app: a REAL user-facing listener (loopback; LAN only via the
# socat relay). The provider rows (pi-provider + native-row disables +
# permission table + the pinned browse directory picker) are the adapter
# bundle's own patch — this file carries only the profile-specific posture.
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
YML
cat > "$PROF/pnpm-workspace.yaml" <<'YML'
nodeLinker: hoisted
autoInstallPeers: false
YML
# @pgmi-builds resolution: symlinks into the worktree
PGMB="$HOME_DIR/profiles/node_modules/@pgmi-builds"
mkdir -p "$PGMB"
ln -sfn "$WT/super-dsh/agent-pi" "$PGMB/agent-adapter-pi"
# the adapter's own node_modules link for the hub (world plugin import)
mkdir -p "$WT/super-dsh/agent-pi/node_modules/@pgmi-builds"
ln -sfn ../../../agent-hub "$WT/super-dsh/agent-pi/node_modules/@pgmi-builds/agent-hub"

systemctl --user reset-failed "$UNIT" 2>/dev/null || true
touch "$LOG"
WATERMARK=$(wc -l < "$LOG")

systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$WT/super-dsh/agent-pi" \
  --property=Environment="DSH_HOME=$HOME_DIR" \
  --property=Environment="SUPERD_DSH_ANCHOR=$MAIN_REPO/upstream/deepseek-harness/package.json" \
  --property=Environment="PI_TRACE=${PI_TRACE:-0}" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$LAUNCHER" --profile "$LABEL" --no-open --trusted-host "$LAN_HOST"

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q "127.0.0.1:${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { journalctl --user -u "$UNIT" --no-pager | tail -40; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }

TOKEN=$(tail -n +$((WATERMARK + 1)) "$LOG" | grep -oE "token=[A-Za-z0-9_-]+" | tail -1 | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "no token in log" >&2; tail -40 "$LOG"; exit 1; }

# ---- LAN relay (socat, LAN IP only; never 0.0.0.0) ----
systemctl --user reset-failed "$RELAY_UNIT" 2>/dev/null || true
systemctl --user stop "$RELAY_UNIT" 2>/dev/null || true
systemd-run --user --unit="$RELAY_UNIT" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  /usr/bin/socat "TCP-LISTEN:${PORT},fork,reuseaddr,bind=${LAN_HOST}" "TCP:127.0.0.1:${PORT}"

sleep 1
curl -s -c /tmp/aw-pi-app.jar -L -o /dev/null -w "LAN follow → %{http_code}\n" "http://${LAN_HOST}:${PORT}/?token=${TOKEN}" || true

echo "loopback : http://127.0.0.1:${PORT}/?token=${TOKEN}"
echo "LAN      : http://${LAN_HOST}:${PORT}/?token=${TOKEN}"
echo "jar      : /tmp/aw-pi-app.jar   (verify: AW_BASE=http://${LAN_HOST}:${PORT} node super-dsh/agent-pi/test/verify-pi-app.mjs)"
echo "unit     : $UNIT   (stop: systemctl --user stop $UNIT $RELAY_UNIT)"
