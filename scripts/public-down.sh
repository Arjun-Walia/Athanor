#!/usr/bin/env bash
# Stop the processes started by scripts/public-up.sh.
# Leaving cloudflared stopped is what makes athanor.cfd return Cloudflare
# error 1033.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${DATA:-$ROOT/data/local}/run"

if [[ ! -d "$RUN" ]]; then
  echo "nothing to stop ($RUN does not exist)"
  exit 0
fi

for pidfile in "$RUN"/*.pid; do
  [[ -e "$pidfile" ]] || continue
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "stopped $name (pid $pid)"
  else
    echo "$name was not running"
  fi
  rm -f "$pidfile"
done
