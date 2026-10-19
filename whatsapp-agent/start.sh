#!/usr/bin/env bash
# Observer WhatsApp Agent launcher — Fedora Linux (also fine on any Linux).
# For autostart/background use the systemd user service instead:
#   ./scripts/install-systemd.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  cat >&2 <<'EOF'
Node.js and/or npm not found. On Fedora they are separate packages:

    sudo dnf install nodejs npm

(already on Fedora 40+ that gives Node 20/22 LTS). Or do everything at once:

    ./scripts/install-fedora.sh
EOF
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $(node --version) is too old (need 20+). See ../FEDORA.md — options: dnf system-upgrade, NodeSource RPM, or nvm." >&2
  exit 1
fi

[ -f .env ] || { echo "Creating .env from .env.example (owner +91 95289 23866, agent +91 88595 55795 already set)"; cp .env.example .env; }
[ -d node_modules ] || npm install

echo "Starting agent on $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}" || echo Linux)…"
echo "Scan the QR with the AGENT phone (8859555795): WhatsApp → Linked devices → Link a device."
echo "Then message it from YOUR number (9528923866): /help"
echo "Tip: for autostart + background, use ./scripts/install-systemd.sh (systemd --user)."
exec node src/index.js
