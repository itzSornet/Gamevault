#!/usr/bin/env bash
# GameVault installer — Arch Linux / pacman
#
#   curl -fsSL https://itzsornet.github.io/Gamevault/install.sh | sudo bash
#
# Adds the [gamevault] repository (once), then installs the package.
# Read it first if you prefer: it only touches pacman config + installs.
set -euo pipefail

REPO_CONF=/etc/pacman.d/gamevault.conf
PACMAN_CONF=/etc/pacman.conf
SERVER=https://itzsornet.github.io/Gamevault/x86_64

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root (curl -fsSL https://itzsornet.github.io/Gamevault/install.sh | sudo bash)" >&2
  exit 1
fi

if ! command -v pacman >/dev/null 2>&1; then
  echo "error: pacman not found. This installer is for Arch-based systems." >&2
  echo "       Download the AppImage instead:" >&2
  echo "       https://github.com/itzSornet/Gamevault/releases/latest" >&2
  exit 1
fi

echo "==> configuring [gamevault] repository"
mkdir -p /etc/pacman.d
cat > "$REPO_CONF" <<EOF
[gamevault]
Server = $SERVER
SigLevel = Optional TrustAll
EOF

if ! grep -q 'gamevault\.conf' "$PACMAN_CONF"; then
  printf '\n# GameVault package repository\nInclude = %s\n' "$REPO_CONF" >> "$PACMAN_CONF"
fi

echo "==> syncing package databases and upgrading"
pacman -Syu --noconfirm

echo "==> installing gamevault"
pacman -S --noconfirm --needed gamevault

echo
echo "Done. Launch it with:  gamevault"
echo "Future updates:        sudo pacman -Syu"
