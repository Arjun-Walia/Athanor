#!/usr/bin/env bash
# Install the frameless Athanor desktop app into the user menu and open it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required (Node.js 20+)." >&2
  exit 1
fi

if [[ ! -f ui/dist/index.html ]]; then
  npm --prefix ui ci
  npm --prefix ui run build
fi

npm --prefix desktop install

ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$ICON_DIR" "$APP_DIR" "$BIN_DIR"

cp "$ROOT/ui/public/favicon.svg" "$ICON_DIR/athanor.svg"

LAUNCHER="$BIN_DIR/athanor"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
cd "$ROOT/desktop"
exec "$ROOT/desktop/node_modules/.bin/electron" --no-sandbox "$ROOT/desktop"
EOF
chmod +x "$LAUNCHER"

cat > "$APP_DIR/athanor.desktop" <<EOF
[Desktop Entry]
Name=Athanor
GenericName=Object store
Comment=Fault-tolerant distributed object store
Exec=$LAUNCHER
Icon=athanor
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=athanor
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" || true
fi

echo "Installed. Athanor is in your application menu."
exec "$LAUNCHER"
