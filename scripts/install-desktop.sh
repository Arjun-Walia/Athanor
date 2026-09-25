#!/usr/bin/env bash
# Build the Athanor desktop app from this checkout and install it for the
# current user, on whichever OS this is.
#
#   scripts/install-desktop.sh          build + install + open
#   NO_OPEN=1 scripts/install-desktop.sh
#
# Prebuilt installers for every platform are on GitHub Releases; this script
# is for people who want to run what they just changed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required (Node.js 20+)." >&2
  exit 1
fi

echo "building the dashboard"
if [[ ! -d ui/node_modules ]]; then npm --prefix ui ci --no-audit --no-fund; fi
npm --prefix ui run build

echo "installing desktop dependencies"
npm --prefix desktop install --no-audit --no-fund

os="$(uname -s)"
case "$os" in
  Darwin)
    echo "packaging for macOS"
    npm --prefix desktop run pack -- --mac --"$(uname -m | sed 's/x86_64/x64/')"
    app="$(find desktop/dist -maxdepth 3 -name 'Athanor.app' | head -n 1)"
    if [[ -z "$app" ]]; then echo "no Athanor.app produced" >&2; exit 1; fi
    dest="$HOME/Applications"
    mkdir -p "$dest"
    rm -rf "$dest/Athanor.app"
    cp -R "$app" "$dest/Athanor.app"
    echo "Installed to $dest/Athanor.app (unsigned: right-click → Open the first time)."
    [[ "${NO_OPEN:-0}" == "1" ]] || open "$dest/Athanor.app"
    ;;
  Linux)
    echo "packaging for Linux"
    npm --prefix desktop run pack -- --linux
    unpacked="$(find desktop/dist -maxdepth 2 -type d -name 'linux-unpacked' | head -n 1)"
    if [[ -z "$unpacked" ]]; then echo "no linux-unpacked produced" >&2; exit 1; fi
    ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
    APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    BIN_DIR="${HOME}/.local/bin"
    OPT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/athanor"
    mkdir -p "$ICON_DIR" "$APP_DIR" "$BIN_DIR" "$OPT_DIR"
    rm -rf "$OPT_DIR/app"
    cp -R "$unpacked" "$OPT_DIR/app"
    cp "$ROOT/desktop/build/icon.png" "$ICON_DIR/athanor.png"
    cat > "$BIN_DIR/athanor" <<EOF
#!/bin/sh
exec "$OPT_DIR/app/athanor" "\$@"
EOF
    chmod +x "$BIN_DIR/athanor"
    cat > "$APP_DIR/athanor.desktop" <<EOF
[Desktop Entry]
Name=Athanor
GenericName=Object store dashboard
Comment=Fault-tolerant distributed object store
Exec=$BIN_DIR/athanor
Icon=athanor
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=Athanor
EOF
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" || true
    echo "Installed. Athanor is in your application menu and on your PATH as 'athanor'."
    [[ "${NO_OPEN:-0}" == "1" ]] || ("$BIN_DIR/athanor" >/dev/null 2>&1 &)
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "packaging for Windows"
    npm --prefix desktop run dist:win
    exe="$(find desktop/dist -maxdepth 1 -name 'Athanor-win-*.exe' | head -n 1)"
    echo "Installer built: $exe. Run it to install Athanor."
    [[ "${NO_OPEN:-0}" == "1" ]] || start "" "$exe"
    ;;
  *)
    echo "Unsupported OS: $os. Run 'npm --prefix desktop run dist' and use the installer it produces." >&2
    exit 1
    ;;
esac
