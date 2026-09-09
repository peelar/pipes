#!/bin/sh
# Installs the Pipes single binary from GitHub Releases and links it into PATH.
set -eu

REPO="${PIPES_REPO:-peelar/pipes}"
INSTALL_ROOT="${PIPES_DATA_DIR:-$HOME/.local/share/pipes}"
BIN_DIR="$HOME/.local/bin"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) ASSET="pipes-darwin-arm64" ;;
  Darwin-x86_64) ASSET="pipes-darwin-x64-baseline" ;;
  Linux-x86_64) ASSET="pipes-linux-x64-baseline" ;;
  Linux-aarch64) ASSET="pipes-linux-arm64" ;;
  *)
    echo "Pipes has no build for $OS-$ARCH (macOS and Linux only; Windows users can use WSL)." >&2
    exit 1
    ;;
esac

if ! command -v codex >/dev/null 2>&1; then
  echo "Pipes needs the Codex CLI on PATH. Install Codex first, then rerun this script." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT/dist" "$BIN_DIR"
URL="https://github.com/$REPO/releases/latest/download/$ASSET"
echo "Downloading $URL..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$INSTALL_ROOT/dist/pipes"
else
  wget -qO "$INSTALL_ROOT/dist/pipes" "$URL"
fi
chmod +x "$INSTALL_ROOT/dist/pipes"
if [ "$OS" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$INSTALL_ROOT/dist/pipes" 2>/dev/null || true
fi
ln -sf "$INSTALL_ROOT/dist/pipes" "$BIN_DIR/pipes"
echo "Installed pipes to $BIN_DIR/pipes. Run: pipes"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "Note: $BIN_DIR is not on PATH. Add it, e.g.: export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
    ;;
esac
