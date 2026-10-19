#!/usr/bin/env bash
# install-systemd.sh — install (or remove) the systemd user service on Fedora.
#
#   ./scripts/install-systemd.sh              install + enable + start
#   ./scripts/install-systemd.sh --uninstall  stop + disable + remove unit
#   ./scripts/install-systemd.sh --no-linger  install without enabling linger
#
# Linger = your user services start at boot and keep running after you log
# out. That's what makes the agent behave like an always-on service on a
# desktop/laptop. It needs one sudo-less loginctl call (may prompt via polkit
# on some setups).
set -euo pipefail
cd "$(dirname "$0")/.."
AGENT_DIR="$PWD"
UNIT="observer-whatsapp-agent.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload
  echo "Removed $UNIT (auth_info/ and data/ were left untouched)."
  exit 0
fi

command -v systemctl >/dev/null || { echo "systemctl not found — systemd is required (this is the Fedora path). Use ./start.sh instead." >&2; exit 1; }
command -v node >/dev/null || { echo "node not found — run scripts/install-fedora.sh first." >&2; exit 1; }
[ -d node_modules ] || { echo "node_modules missing — running npm install first…"; npm install; }
[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example."; }

NODE_BIN="$(command -v node)"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__AGENT_DIR__|$AGENT_DIR|g" \
  systemd/observer-whatsapp-agent.service > "$UNIT_PATH"
echo "Wrote $UNIT_PATH"
echo "  node: $NODE_BIN ($(node --version))"
echo "  dir:  $AGENT_DIR"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"

if [ "${1:-}" != "--no-linger" ]; then
  if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "Linger enabled: the agent now starts at boot, before/without login."
  else
    echo "Could not enable linger automatically. Run once:  loginctl enable-linger $USER"
    echo "(Without linger the agent runs only while you are logged in.)"
  fi
fi

cat <<EOF

Service running. Useful commands:
  systemctl --user status observer-whatsapp-agent
  journalctl --user -u observer-whatsapp-agent -f     # logs + linking QR
  systemctl --user restart observer-whatsapp-agent

First run: follow the journal, scan the QR with the AGENT phone
(+91 88595 55795) under WhatsApp → Linked devices, then message it
from YOUR number (+91 95289 23866):  /help
EOF
systemctl --user --no-pager --lines=0 status "$UNIT" || true
