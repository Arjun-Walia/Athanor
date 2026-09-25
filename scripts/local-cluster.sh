#!/usr/bin/env bash
# Run a five-node Athanor cluster as local processes (no Docker needed).
#
#   scripts/local-cluster.sh            build, start five nodes, tail their logs
#   NODES=6 scripts/local-cluster.sh    start six (the sixth joins and rebalances)
#   CLEAN=1 scripts/local-cluster.sh    wipe ./data/local first
#
# Node i listens on HTTP 808i, gRPC 909i, gossip 794(5+i). Ctrl-C stops all.
set -euo pipefail

cd "$(dirname "$0")/.."
NODES="${NODES:-5}"
DATA="${DATA:-./data/local}"
BIN="${BIN:-./bin/vault-node}"

if [[ "${CLEAN:-0}" == "1" ]]; then
  rm -rf "$DATA"
fi
mkdir -p "$DATA" bin

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  if [[ -f ui/dist/index.html ]]; then
    echo "embedding ui/dist into the node binary"
    rm -rf internal/webui/dist && mkdir -p internal/webui/dist
    cp -R ui/dist/. internal/webui/dist/
    touch internal/webui/dist/.gitkeep
  fi
  go build -o "$BIN" ./cmd/vault-node
fi

pids=()
cleanup() {
  echo
  echo "stopping ${#pids[@]} nodes"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for i in $(seq 1 "$NODES"); do
  id="node$i"
  "$BIN" \
    --id "$id" \
    --http ":808$i" \
    --grpc "127.0.0.1:909$i" \
    --gossip "127.0.0.1:$((7945 + i))" \
    --advertise 127.0.0.1 \
    --public-url "http://localhost:808$i" \
    --seeds "127.0.0.1:7946" \
    --data "$DATA/$id" \
    --scrub-interval "${SCRUB:-30s}" \
    --reap-after "${REAP:-2m}" \
    >"$DATA/$id.log" 2>&1 &
  pids+=($!)
  echo "$id  http://localhost:808$i   (log: $DATA/$id.log)"
done

echo
echo "dashboard: http://localhost:8081/app  (or: cd ui && npm run dev → http://localhost:5173/app)"
tail -n 0 -F "$DATA"/node*.log
