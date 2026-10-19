#!/usr/bin/env bash
# install-fedora.sh — one-shot Fedora setup for the Observer WhatsApp Agent.
#
#   ./scripts/install-fedora.sh            install deps + npm packages
#   ./scripts/install-fedora.sh --service  …plus install & start the systemd
#                                            user service (autostart, headless QR
#                                            via journal/dashboard)
#   ./scripts/install-fedora.sh --ollama   …plus install/enable local Ollama
#                                            and pull the default free model
#   ./scripts/install-fedora.sh --power    …plus the full toolkit: OCR, screen
#                                            recording, webcam, windows, zip,
#                                            PDF reading, Wi-Fi/Bluetooth CLIs,
#                                            and ACCESS_LEVEL=full + input on
#   ./scripts/install-fedora.sh --phone    …allow your phone on the same Wi-Fi
#                                            to open the app (firewalld 8787)
#   ./scripts/install-fedora.sh --pc-control  (old name for --power)
#
# Idempotent: safe to re-run. Uses sudo only for dnf (and the Ollama installer,
# which manages its own sudo).
set -euo pipefail
cd "$(dirname "$0")/.."
AGENT_DIR="$PWD"

WANT_SERVICE=0
WANT_OLLAMA=0
WANT_PCCONTROL=0
WANT_PHONE=0
for arg in "$@"; do
  case "$arg" in
    --service) WANT_SERVICE=1 ;;
    --ollama) WANT_OLLAMA=1 ;;
    --power|--pc-control) WANT_PCCONTROL=1 ;;
    --phone) WANT_PHONE=1 ;;
    *) echo "Unknown option: $arg (supported: --service, --ollama, --power, --phone)" >&2; exit 2 ;;
  esac
done

# set_env KEY VALUE — update or append a key in .env (idempotent).
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

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

# ── 4b. Optional: the full power toolkit ─────────────────────────────────────
if [ "$WANT_PCCONTROL" -eq 1 ]; then
  say "Full toolkit: OCR, recording, webcam, windows, files, Wi-Fi, Bluetooth"
  sudo dnf install -y \
    grim gnome-screenshot scrot kde-spectacle playerctl brightnessctl ydotool xdotool \
    wl-clipboard libnotify tesseract tesseract-langpack-hin wmctrl \
    ffmpeg wf-recorder zip unzip poppler-utils bluez NetworkManager \
    || echo "⚠ Some packages failed to install — every action names the exact missing package when used."
  # Wayland keyboard/mouse needs the ydotool daemon (uinput). Unit name varies
  # by packaging; try both, never fatal.
  sudo systemctl enable --now ydotool 2>/dev/null || sudo systemctl enable --now ydotoold 2>/dev/null || \
    echo "⚠ Couldn't enable the ydotool daemon automatically — Wayland input needs it: check 'systemctl list-unit-files | grep ydotool'"
  set_env ALLOW_PC_CONTROL true
  set_env ACCESS_LEVEL full
  set_env OCR_LANGS "eng+hin"
  echo "Full access ENABLED in .env: apps, files, Wi-Fi, input, screenshots, OCR, recording."
  echo "Destructive actions (delete/kill/shutdown/close app) still ask for /yes first."
  echo "Optional extra PIN for input: set CONTROL_PIN=1234 in .env"
fi

# ── 4c. Optional: phone app over Wi-Fi (firewalld) ───────────────────────────
if [ "$WANT_PHONE" -eq 1 ]; then
  say "Phone app access on port 8787"
  set_env HOST 0.0.0.0
  if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
    sudo firewall-cmd --add-port=8787/tcp --permanent >/dev/null 2>&1 && sudo firewall-cmd --reload >/dev/null 2>&1 \
      && echo "firewalld: port 8787 open on your LAN." \
      || echo "⚠ Could not open 8787 in firewalld — run: sudo firewall-cmd --add-port=8787/tcp --permanent && sudo firewall-cmd --reload"
  else
    echo "firewalld is not running — nothing to open. (If you use ufw/nftables, allow TCP 8787 on your LAN.)"
  fi
  echo "Only devices on your Wi-Fi can reach the app, and it needs the PIN printed at startup."
fi

# ── 5. Optional: systemd user service (the Fedora way to keep it running) ────
# Deliberately BEFORE the optional Ollama step: the agent must end up running
# even if the AI extras have trouble. Ollama problems must never block WhatsApp.
if [ "$WANT_SERVICE" -eq 1 ]; then
  say "Installing systemd user service"
  bash scripts/install-systemd.sh
fi

# ── 6. Optional: local Ollama (the free AI brain) — best-effort, never fatal ─
# Failure here only means "no AI chat yet"; every built-in command still works.
setup_ollama() {
  ollama_up() { curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; }

  if command -v ollama >/dev/null; then
    echo "Ollama binary found at $(command -v ollama)"
  else
    echo "Installing Ollama (upstream installer)…"
    curl -fsSL https://ollama.com/install.sh | sh || { echo "⚠ Ollama install failed — skipping AI setup, the agent works without it."; return 0; }
  fi

  if ! ollama_up; then
    echo "Ollama server is not responding yet — trying to start its service…"
    if systemctl list-unit-files --no-legend 2>/dev/null | grep -q '^ollama\.service'; then
      sudo systemctl enable --now ollama || echo "⚠ Could not enable the ollama service (see: systemctl status ollama)"
    else
      echo "⚠ No ollama.service unit on this system."
      echo "  This happens when ollama was unpacked manually instead of installed."
      echo "  Fix either way:"
      echo "    a) Reinstall properly:  curl -fsSL https://ollama.com/install.sh | sh"
      echo "       then:                sudo systemctl enable --now ollama"
      echo "    b) Or just run it now:  ollama serve        (in a separate terminal)"
    fi
    for _ in $(seq 1 15); do ollama_up && break; sleep 1; done
  fi

  if ollama_up; then
    echo "Ollama server is up — pulling llama3.2 (~2 GB, one time)…"
    ollama pull llama3.2 || echo "⚠ Model pull failed — retry later with: ollama pull llama3.2"
    echo "Optional photo understanding: ollama pull llava, then set OLLAMA_VISION_MODEL=llava in .env"
  else
    cat <<'EOF'
⚠ Ollama server still not responding, so no model was pulled.
  The WhatsApp agent itself is unaffected — link it and use /help, then
  fix Ollama any time and send /model on WhatsApp to verify:
    1) sudo systemctl enable --now ollama   (or: ollama serve)
    2) curl http://127.0.0.1:11434          → should say "Ollama is running"
    3) ollama pull llama3.2
EOF
  fi
  return 0
}
if [ "$WANT_OLLAMA" -eq 1 ]; then
  say "Ollama (optional, free local AI)"
  setup_ollama || true
fi

say "Done"
cat <<EOF
Next steps (run ONE command at a time — don't paste the journalctl line
together with this installer, it gets swallowed while the installer runs):
  1. Start it:        ./start.sh        (or it is already running if you used --service)
  2. Link the agent phone +91 88595 55795:
     WhatsApp → Linked devices → Link a device → scan the QR
     (terminal, the auto-opened image viewer, or the dashboard URL it prints;
      under systemd: journalctl --user -u observer-whatsapp-agent -f)
  3. From YOUR phone +91 95289 23866, WhatsApp the agent number:  /help
  4. Free AI (optional): re-run with --ollama, then send  /model  to check.
  5. Phone app (no Observer needed): open http://<this-PC-IP>:8787/ on your
     phone, enter the PIN it prints at startup, and use "Add to Home screen".
     Enable LAN access + firewall with:  ./scripts/install-fedora.sh --phone

Optional but recommended extras:
  ./scripts/install-fedora.sh --power    full toolkit (OCR, recording, Wi-Fi…)
  ./scripts/install-fedora.sh --ollama   free offline AI (unlimited chat + tasks)

Full Fedora guide: ../FEDORA.md · phone app + power guide: README.md
EOF
