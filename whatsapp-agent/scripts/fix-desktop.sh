#!/usr/bin/env bash
# fix-desktop.sh — make screenshots, keyboard, mouse and everything else work on
# a Fedora desktop (GNOME/KDE, Wayland or X11).
#
#   ./scripts/fix-desktop.sh
#
# Safe to re-run. Installs the right capture/input tools, enables the ydotool
# daemon Wayland needs, and tells you exactly what is still missing.
set -euo pipefail
cd "$(dirname "$0")/.."
AGENT_DIR="$PWD"

say() { printf '\n== %s ==\n' "$*"; }
command -v dnf >/dev/null || { echo "This script targets Fedora (dnf)." >&2; exit 1; }

DESKTOP="${XDG_CURRENT_DESKTOP:-$(loginctl show-session "$(loginctl | awk -v u="$USER" '$3==u {print $1; exit}')" -p Desktop -P 2>/dev/null || true)}"
DESKTOP="${DESKTOP:-GNOME}"
case "$DESKTOP" in
  *KDE*|*Plasma*) PORTAL="xdg-desktop-portal-kde" ;;
  *) PORTAL="xdg-desktop-portal-gnome" ;;
esac
SESSION="${XDG_SESSION_TYPE:-$(loginctl show-session "$(loginctl | awk -v u="$USER" '$3==u {print $1; exit}')" -p Type -P 2>/dev/null || true)}"
echo "Desktop: $DESKTOP · session: ${SESSION:-unknown}"

# ── 1. The tools ─────────────────────────────────────────────────────────────
say "Installing screenshot / input / capture tools"
# Split into groups so one bad package name can't sink the whole install.
sudo dnf install -y grim gnome-screenshot scrot maim ImageMagick || \
  echo "⚠ Some screenshot tools failed — the portal below is the important one."
sudo dnf install -y xdg-desktop-portal "$PORTAL" || \
  echo "⚠ Portal packages failed. Try: sudo dnf install xdg-desktop-portal xdg-desktop-portal-gnome"
sudo dnf install -y ydotool wtype xdotool wl-clipboard || \
  echo "⚠ Input tools failed. Try: sudo dnf install ydotool xdotool"
sudo dnf install -y tesseract tesseract-langpack-hin ffmpeg poppler-utils zip unzip \
  wmctrl playerctl brightnessctl libnotify NetworkManager bluez wl-clipboard || \
  echo "⚠ Some extras failed — every action names its own package when used."

# ── 2. ydotool daemon (this is what actually presses keys on Wayland) ────────
say "Enabling the ydotool daemon"
if systemctl enable --now ydotool 2>/dev/null; then
  echo "ydotool daemon enabled (unit: ydotool)."
elif systemctl enable --now ydotoold 2>/dev/null; then
  echo "ydotool daemon enabled (unit: ydotoold)."
else
  echo "⚠ Couldn't enable the ydotool daemon automatically."
  echo "  Check the unit name: systemctl list-unit-files | grep -i ydotool"
  echo "  Then: sudo systemctl enable --now <that-unit>"
fi
# Some packages keep the socket root-only; make it reachable for the user.
for sock in /tmp/.ydotool_socket /run/ydotoold/socket; do
  [ -S "$sock" ] || continue
  if [ ! -w "$sock" ]; then
    echo "Making $sock accessible to $USER…"
    sudo chown "$USER" "$sock" 2>/dev/null || sudo chmod 666 "$sock" 2>/dev/null || true
  fi
done

if [ ! -e /dev/uinput ]; then
  echo "⚠ /dev/uinput is missing — ydotool cannot work without it."
  echo "  sudo modprobe uinput && echo uinput | sudo tee /etc/modules-load.d/uinput.conf"
fi

# ── 3. Let the user grab screenshots without a prompt (pipewire/wireplumber) ─
say "Checking the desktop portal service"
for unit in xdg-desktop-portal xdg-desktop-portal-gnome xdg-desktop-portal-kde; do
  if systemctl --user list-unit-files 2>/dev/null | grep -q "^${unit}\."; then
    systemctl --user restart "$unit" 2>/dev/null || true
  fi
done

# ── 4. Restart the agent so it picks up the new tools + sockets ──────────────
if systemctl --user is-enabled observer-whatsapp-agent >/dev/null 2>&1; then
  say "Restarting the WhatsApp agent"
  systemctl --user restart observer-whatsapp-agent || true
fi

cat <<'EOF'

────────────────────────────────────────────────────────────────────────
 Ab WhatsApp pe /doctor bhejo — har cheez ka status + exact fix milega.
────────────────────────────────────────────────────────────────────────
 GNOME Wayland pe pehli baar screenshot lete waqt PC screen pe ek
 "Allow screenshot?" prompt aa sakta hai — us pe *Allow* (ya "Always
 allow") dabao. Warna wo baar baar poochega.

 Ab test karo:
   /screenshot          → asli screen aani chahiye (kaali nahi)
   /pc type hello       → PC ke focused box me type hoga
   /pc key super        → Activities/app launcher khulega
   /pc click 600 400    → wahan click hoga
   /pc scroll down 5

 Kuch phir bhi na chale to: journalctl --user -u observer-whatsapp-agent -n 100
EOF

# ── 5. Machine-readable summary of what is still missing ─────────────────────
say "Installed check"
missing=""
for bin in grim gnome-screenshot gdbus ydotool xdotool tesseract ffmpeg pdftotext nmcli; do
  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ -n "$missing" ]; then
  echo "Still missing:$missing"
else
  echo "All required binaries are present. ✅"
fi
[ -e /dev/uinput ] && echo "/dev/uinput: present ✅" || echo "/dev/uinput: MISSING ⚠"
echo "Agent dir: $AGENT_DIR"
