#!/usr/bin/env bash
# install-fedora.sh — one-shot Fedora setup for the Observer WhatsApp Agent.
#
#   ./scripts/install-fedora.sh            install deps + npm packages
#   ./scripts/install-fedora.sh --service  …plus install & start the systemd
#                                            user service (autostart, headless QR
#                                            via journal/dashboard)
#   ./scripts/install-fedora.sh --ollama   …plus install/enable local Ollama
#                                            and pull the default free model
#
# Idempotent: safe to re-run. Uses sudo only for dnf (and the Ollama installer,
# which manages its own sudo).
set -euo pipefail
cd "$(dirname "$0")/.."
AGENT_DIR="$PWD"

WANT_SERVICE=0
WANT_OLLAMA=0
for arg in "$@"; do
  case "$arg" in
    --service) WANT_SERVICE=1 ;;
    --ollama) WANT_OLLAMA=1 ;;
    *) echo "Unknown option: $arg (supported: --service, --ollama)" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s ==\n' "$*"; }

# ── 1. Confirm Fedora (warn, don't hard-fail, on RHEL-likes) ──────────────────
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  say "OS: ${PRETTY_NAME:-unknown}"
  case " ${ID:-} ${ID_LIKE:-} " in
    *" fedora "*) : ;;
    *) echo "Note: this script targets Fedora (dnf). On other distros, install Node 20+ your way and run ./start.sh instead." ;;
  esac
fi
command -v dnf >/dev/null || { echo "dnf not found — this script is for Fedora. See ../FEDORA.md for the manual steps." >&2; exit 1; }

# ── 2. System packages ────────────────────────────────────────────────────────
# Fedora splits npm from nodejs (unlike nodejs.org installers), so list both.
# The build tools cover the rare native-module fallback (normally prebuilt).
say "Installing Node.js, npm and build basics (sudo dnf)"
sudo dnf install -y nodejs npm git curl gcc-c++ make python3

# ── 3. Node >= 20 check (Fedora 39 ships 20, 40 ships 20/22, 41+ ships 22+) ──
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "Node $(node --version) · npm $(npm --version) · $(command -v node)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  cat >&2 <<EOF
Node $NODE_MAJOR is too old (need 20+). Options on Fedora:
  a) Upgrade Fedora itself: sudo dnf system-upgrade download --releasever=<latest>
  b) NodeSource RPM (current LTS repo):
       curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
       sudo dnf install -y nodejs      # this one bundles npm
  c) nvm (per-user, no sudo): https://github.com/nvm-sh/nvm then 'nvm install 22'
Then re-run this script.
EOF
  exit 1
fi

# ── 4. .env + npm install ─────────────────────────────────────────────────────
say "Agent setup in $AGENT_DIR"
[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example (owner +91 95289 23866, agent +91 88595 55795 already set)."; }
npm install

# ── 5. Optional: local Ollama (the free AI brain) ────────────────────────────
if [ "$WANT_OLLAMA" -eq 1 ]; then
  say "Ollama (optional, free local AI)"
  if command -v ollama >/dev/null; then
    echo "Ollama already installed: $(ollama --version 2>/dev/null || echo present)"
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  # The upstream installer creates a system service; make sure it's up.
  sudo systemctl enable --now ollama 2>/dev/null || echo "Start Ollama with: ollama serve"
  ollama pull llama3.2
  echo "Optional photo understanding: ollama pull llava, then set OLLAMA_VISION_MODEL=llava in .env"
fi

# ── 6. Optional: systemd user service (the Fedora way to keep it running) ────
if [ "$WANT_SERVICE" -eq 1 ]; then
  say "Installing systemd user service"
  bash scripts/install-systemd.sh
fi

say "Done"
cat <<EOF
Next steps:
  1. Start it:        ./start.sh        (or it is already running if you used --service)
  2. Link the agent phone +91 88595 55795:
     WhatsApp → Linked devices → Link a device → scan the QR
     (terminal, the auto-opened image viewer, or the dashboard URL it prints;
      under systemd: journalctl --user -u observer-whatsapp-agent -f)
  3. From YOUR phone +91 95289 23866, WhatsApp the agent number:  /help
  4. Free AI (optional): re-run with --ollama, then send  /model  to check.

Nothing to open in firewalld: the bridge listens on 127.0.0.1 only.
Full Fedora guide: ../FEDORA.md
EOF
