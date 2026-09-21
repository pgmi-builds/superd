#!/usr/bin/env bash
# start-world-4998.sh — the OMP world as ITS OWN PROCESS with ITS OWN DSH_HOME.
# Rationale (2026-09-15): the upstream adapter (dsh-shape-session-log) makes the
# dsh session log of record and serves list/workspace/models through NATIVE dsh
# components — so two contexts sharing one DSH_HOME are indistinguishable. A real
# world therefore needs its own home (ADR 0008: foreign = its own process).
# Recipe mirrors upstream apps/omp-web/test/start-4999.sh (launcher passes
# DSH_HOME + profile name; the plugin runs the OMP runtime on its NATIVE ~/.omp
# (2026-09-17 native-home ruling; OMP_HOME env remains a test-only isolation knob).
set -euo pipefail
PORT=4998
UNIT="aw-world-omp-${PORT}"
RELAY="aw-world-lan-${PORT}-relay"
REPO="$HOME/workspaces/superd"
WORLD_HOME="$REPO/.tests/aw-worlds/omp"
LOG="$REPO/.scratch/aw-world-omp-${PORT}.log"
DSH_BIN="$REPO/upstream/deepseek-harness/apps/cli/lib/bin.js"
NODE_BIN="/usr/bin/node"
LAN_IP="192.168.31.130"
ADAPTER="$REPO/super-dsh/agent-omp"

mkdir -p "$WORLD_HOME/profiles/aw-world-omp" "$REPO/.scratch"
cat > "$WORLD_HOME/profiles/aw-world-omp/package.json" <<EOF
{
  "name": "aw-world-omp-profile",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@pgmi-builds/agent-adapter-omp"] } },
  "dependencies": { "@pgmi-builds/agent-adapter-omp": "file:$ADAPTER" }
}
EOF
cat > "$WORLD_HOME/profiles/aw-world-omp/cordis.patch.yml" <<EOF
# the world's own listener (own home => own sessions/workspace/settings)
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
EOF
cat > "$WORLD_HOME/profiles/aw-world-omp/pnpm-workspace.yaml" <<'EOF'
nodeLinker: hoisted
autoInstallPeers: false
EOF

systemctl --user stop "$UNIT" "$RELAY" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" "$RELAY" 2>/dev/null || true
for _ in $(seq 1 15); do ss -tln | grep -q ":${PORT} " || break; sleep 1; done
if ss -tln | grep -q ":${PORT} "; then echo "refusing: ${PORT} busy" >&2; ss -tlnp | grep ":${PORT} " >&2; exit 1; fi
WM=$(wc -l < "$LOG" 2>/dev/null || echo 0)

systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$REPO" \
  --property=Environment="DSH_HOME=$WORLD_HOME" \
  --property=Environment="OMP_NATIVE_HOME=$HOME/.omp" \
  --property=Environment="SUPERD_KEEP=1" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$DSH_BIN" --profile aw-world-omp --no-open --trusted-host "$LAN_IP"

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { journalctl --user -u "$UNIT" --no-pager | tail -25; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }

systemd-run --user --unit="$RELAY" /usr/bin/socat "TCP-LISTEN:${PORT},fork,reuseaddr,bind=${LAN_IP}" "TCP:127.0.0.1:${PORT}" >/dev/null
echo "--- world listening on ${PORT} (own home: $WORLD_HOME)"
tail -n +$((WM + 1)) "$LOG" | grep 'token=' | tail -1 || true
echo "stop: systemctl --user stop $UNIT $RELAY"
