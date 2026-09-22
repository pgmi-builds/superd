#!/usr/bin/env bash
# start-4999.sh — the super-dsh line in PUBLISH-READY form (2026-09-22
# transformation): the 4999 instance runs THE DELIVERED ARTIFACT.
#
#   build (pack.mjs)  →  npm pack  →  pnpm install of the tarball into a
#   fresh profile  →  boot via the repo build's dsh CLI.
#
# No hand-written compositions, no @pgmi-builds symlink farms, no library boot
# script: the profile shape IS the consumer shape (`dsh plugin add super-dsh`
# produces exactly this manifest). Worlds self-provision from the package.
#
# Red line (repo AGENTS §〇): this script refuses to run against any home that
# is not this repo's .tests tree — the launch step owns the dev/test boundary,
# business code never does.
set -euo pipefail
PORT=4999
UNIT="aw-4999-test"
REPO="$HOME/workspaces/superd"
LINE="$REPO/super-dsh"
DSH_HOME_DIR="$REPO/.tests/aw"
PROFILE="aw-pub"
LOG="$REPO/.scratch/aw-4999.log"
NODE_BIN="/usr/bin/node"
PNPM="corepack pnpm@10.33.2"   # consumer-parity installer (store v10)
PNPM_STORE="$REPO/.npm-cache/pnpm-store-v10"
ANCHOR="$REPO/upstream/deepseek-harness/apps/cli/package.json"  # repo-line contract: the checkout build IS the installation

# ---- red line: home must be this repo's test tree ----
case "$DSH_HOME_DIR" in
  "$REPO/.tests"*) ;;
  *) echo "refusing: DSH home $DSH_HOME_DIR is outside $REPO/.tests (repo red line)" >&2; exit 1 ;;
esac

if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  exit 1
fi
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
WATERMARK=$(wc -l < "$LOG" 2>/dev/null || echo 0)

# ---- 1. build + pack the delivery artifact ----
"$NODE_BIN" "$LINE/scripts/pack.mjs"
TARBALL="$REPO/.scratch/aw-pack/super-dsh-$("$NODE_BIN" -p "require('$LINE/package.json').version").tgz"

# ---- 2. fresh profile consuming the tarball (consumer manifest shape) ----
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "aw-pub-profile",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "super-dsh"] } },
  "dependencies": { "super-dsh": "file:$TARBALL" }
}
EOF
cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
# ctx0 web face on the line port (loopback; LAN/WAN via socat/Caddy per repo
# port discipline). Everything else — hub, world rows, claude join, picker —
# composes from the installed super-dsh bundle's own patch.
- id: webserver
  config:
    host: 127.0.0.1
    port: 4999
EOF
echo "--- pnpm install (first run downloads the runtime SDKs into the store; later runs reuse it)"
(cd "$PROFILE_DIR" && $PNPM add "file:$TARBALL" --config.store-dir="$PNPM_STORE" --prefer-offline)

# ---- 3. boot via the repo build's dsh CLI (no custom boot code) ----
systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$REPO" \
  --property=Environment="DSH_HOME=$DSH_HOME_DIR" \
  --property=Environment="SUPERD_DSH_ANCHOR=$ANCHOR" \
  --property=Environment="SUPERD_KEEP=1" \
  --property=Environment="AW_TRUSTED_HOSTS=192.168.31.130,192.168.31.130:4999" \
  --property=Environment="DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}" \
  --property='UnsetEnvironment=DISPLAY WAYLAND_DISPLAY' \
  --property=Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$REPO/upstream/deepseek-harness/apps/cli/lib/bin.js" \
    --profile "$PROFILE" --no-open

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { tail -30 "$LOG"; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }
echo "--- listening on ${PORT}; token URL (this boot):"
JAR=$(mktemp)
# ctx0's token can land a few seconds after the bind (worlds interleave their
# virtual webServer lines around it) — poll until one actually authenticates.
found=""
for _ in $(seq 1 15); do
  for t in $(tail -n +$((WATERMARK + 1)) "$LOG" | grep -o 'token=[^ ]*' | cut -d= -f2 | tac); do
    rm -f "$JAR"
    if curl -s -o /dev/null -c "$JAR" "http://127.0.0.1:${PORT}/?token=$t" && \
       [ "$(curl -s -o /dev/null -b "$JAR" -w '%{http_code}' "http://127.0.0.1:${PORT}/")" = "200" ]; then
      found="$t"; break
    fi
  done
  [ -n "$found" ] && break
  sleep 2
done
if [ -n "$found" ]; then
  echo "  local: http://127.0.0.1:${PORT}/?token=$found"
  echo "  wan:   https://test.pc.randomhash.app/?token=$found"
else
  echo "  WARN: no token authenticated against the index — inspect $LOG" >&2
fi
rm -f "$JAR"
echo "--- SUPERD_KEEP=1: unit $UNIT left running (stop: systemctl --user stop $UNIT)"
