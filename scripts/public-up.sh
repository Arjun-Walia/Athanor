#!/usr/bin/env bash
# Start the public cluster on this machine and keep it running after the
# shell exits. Cloudflare error 1033 means the tunnel has no live connector:
# cloudflared is not running, so athanor.cfd cannot reach the nodes.
#
#   scripts/public-up.sh
#   scripts/public-down.sh
#
# Requires the vault-node build tools, Caddy, and a tunnel token at
# ~/.cloudflared/athanor.token (override with TUNNEL_TOKEN_FILE).
# docs/DEPLOY.md walks through this on an Oracle Cloud VPS, including the
# systemd unit in deploy/systemd that runs this script at boot.
# PUBLIC_URL defaults to https://www.athanor.cfd. Every node advertises
# that origin so a browser on the internet never fails over to localhost.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Secrets and overrides live in deploy/athanor.env (gitignored; see
# deploy/athanor.env.example). ATHANOR_ADMIN_TOKEN and
# ATHANOR_CLUSTER_SECRET set there are inherited by every node.
if [[ -f "$ROOT/deploy/athanor.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/deploy/athanor.env"
  set +a
fi

DATA="${DATA:-$ROOT/data/local}"
RUN="$DATA/run"
BIN="${BIN:-$ROOT/bin/vault-node}"
PUBLIC_URL="${PUBLIC_URL:-https://www.athanor.cfd}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
CADDYFILE="${CADDYFILE:-$ROOT/deploy/Caddyfile.host}"
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-$HOME/.cloudflared/athanor.token}"
NODES="${NODES:-5}"

export PATH="${HOME}/.local/go/bin:${HOME}/.local/bin:${PATH}"

mkdir -p "$RUN" "$DATA" "$ROOT/bin"

if [[ ! -x "$BIN" || "${REBUILD:-1}" == "1" ]]; then
  if [[ -f ui/dist/index.html ]]; then
    rm -rf internal/webui/dist && mkdir -p internal/webui/dist
    cp -R ui/dist/. internal/webui/dist/
    touch internal/webui/dist/.gitkeep
  fi
  version="$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
  go build -ldflags "-X main.version=${version}" -o "$BIN" ./cmd/vault-node
fi

start_bg() {
  local name="$1"
  shift
  local pidfile="$RUN/${name}.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return
  fi
  nohup "$@" >>"$RUN/${name}.log" 2>&1 &
  echo $! >"$pidfile"
  disown || true
  echo "$name started (pid $(cat "$pidfile"))"
}

for i in $(seq 1 "$NODES"); do
  id="node$i"
  start_bg "$id" "$BIN" \
    --id "$id" \
    --http ":808${i}" \
    --grpc "127.0.0.1:909${i}" \
    --gossip "127.0.0.1:$((7945 + i))" \
    --advertise 127.0.0.1 \
    --public-url "$PUBLIC_URL" \
    --seeds "127.0.0.1:7946" \
    --data "$DATA/$id" \
    --scrub-interval "${SCRUB:-30s}" \
    --reap-after "${REAP:-2m}"
done

caddy="$(command -v caddy || true)"
if [[ -z "$caddy" ]]; then
  echo "caddy is not installed; the tunnel would have no gateway on :${GATEWAY_PORT}" >&2
  exit 1
fi
start_bg gateway "$caddy" run --config "$CADDYFILE" --adapter caddyfile

if [[ -f "$TOKEN_FILE" ]]; then
  cloudflared="$(command -v cloudflared || true)"
  if [[ -z "$cloudflared" ]]; then
    echo "cloudflared is not installed; athanor.cfd will keep returning error 1033" >&2
    exit 1
  fi
  start_bg tunnel "$cloudflared" tunnel --no-autoupdate run --token-file "$TOKEN_FILE"
else
  echo "no tunnel token at $TOKEN_FILE; local gateway only, public hostname will 1033" >&2
fi

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${GATEWAY_PORT}/v1/admin/ready" >/dev/null 2>&1; then
    echo "gateway ready at http://127.0.0.1:${GATEWAY_PORT}"
    echo "public origin ${PUBLIC_URL}"
    exit 0
  fi
  sleep 0.5
done

echo "nodes did not become ready; see $RUN/node1.log" >&2
exit 1
