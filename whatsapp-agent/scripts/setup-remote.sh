#!/usr/bin/env bash
# setup-remote.sh — use the phone app from ANYWHERE (free), not just your Wi-Fi.
#
#   ./scripts/setup-remote.sh
#
# What it does:
#   1. installs Tailscale (free for personal use, no port-forwarding, no public URL)
#   2. logs this PC into your tailnet (one approval link)
#   3. makes sure HOST=0.0.0.0 + TCP 8787 are allowed
#   4. prints the exact URL to open on your phone, from any network
#
# WhatsApp commands already work from anywhere (the PC dials out to WhatsApp),
# so this is only for the installable phone app / dashboard.
#
# Idempotent and safe to re-run. sudo is used for dnf, systemctl and firewalld.
set -euo pipefail
cd "$(dirname "$0")/.."
AGENT_DIR="$PWD"

say() { printf '\n== %s ==\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }

set_env() {
  local key="$1" value="$2"
  [ -f .env ] || cp .env.example .env
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

command -v dnf >/dev/null || { echo "This script targets Fedora (dnf). See ../FEDORA.md." >&2; exit 1; }

# ── 1. Tailscale ─────────────────────────────────────────────────────────────
if command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale already installed: $(tailscale version | head -1)"
else
  say "Installing Tailscale"
  if ! sudo dnf install -y tailscale; then
    echo "Package not in the enabled repos — adding Tailscale's official repo…"
    if sudo dnf config-manager addrepo --from-repofile=https://pkgs.tailscale.com/stable/fedora/tailscale.repo 2>/dev/null; then
      :
    else
      sudo dnf config-manager --add-repo https://pkgs.tailscale.com/stable/fedora/tailscale.repo
    fi
    sudo dnf install -y tailscale
  fi
fi

say "Enabling the Tailscale daemon"
sudo systemctl enable --now tailscaled

if ! sudo tailscale status >/dev/null 2>&1; then
  say "Logging this PC in"
  cat <<'EOF'
A long link will appear below. Open it in a browser (phone is fine), sign in
with Google/GitHub/Microsoft, and approve this machine. Free plan is enough.
EOF
  sudo tailscale up --hostname "observer-$(hostname -s)"
else
  echo "Already logged in to Tailscale."
fi

IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -z "$IP" ]; then
  warn "Couldn't read the Tailscale IP. Run 'tailscale status' and re-run this script."
  exit 1
fi

# ── 2. Agent reachable on that interface ─────────────────────────────────────
say "Allowing the phone app on port 8787"
set_env HOST 0.0.0.0
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
  sudo firewall-cmd --add-port=8787/tcp --permanent >/dev/null 2>&1 || true
  sudo firewall-cmd --reload >/dev/null 2>&1 || warn "Could not reload firewalld — run: sudo firewall-cmd --add-port=8787/tcp --permanent && sudo firewall-cmd --reload"
fi

# Pick up HOST=0.0.0.0 if the service is installed.
if systemctl --user is-enabled observer-whatsapp-agent >/dev/null 2>&1; then
  say "Restarting the agent service"
  systemctl --user restart observer-whatsapp-agent || true
  sleep 1
  systemctl --user --no-pager --lines=0 status observer-whatsapp-agent || true
else
  echo "Service not installed — start the agent with ./start.sh (or re-run install-fedora.sh --service)."
fi

# ── 3. Tell the owner exactly what to do ─────────────────────────────────────
PIN="$(cat data/dashboard-pin.txt 2>/dev/null || echo '<printed at startup>')"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8787}"

cat <<EOF

────────────────────────────────────────────────────────────────────────
 Phone app from ANYWHERE (free, private — no port forwarding)
────────────────────────────────────────────────────────────────────────
 1. Phone pe Tailscale app install karo (Play Store / App Store) and
    SAME account se login karo jisse ye PC logged in hai.
 2. Phone browser me kholo:

        http://${IP}:${PORT}/

    PIN: ${PIN}

 3. Chrome menu → "Add to Home screen". Ab ghar ke bahar bhi chalega.

 Kya kaam karega:
   • WhatsApp commands — pehle se hi kahin se bhi kaam karte hain.
   • Ye phone app — Tailscale ke through, duniya me kahin se bhi.
   • Laptop ghar pe on + internet pe hona chahiye.

 Security: Tailscale ek private network hai; URL sirf aapke devices ko
 dikhta hai, aur app PIN maangta hai. Port 8787 ko router pe forward
 mat karo — uski zaroorat nahi hai.
EOF

# Laptop sleep = agent offline. Say it once, clearly.
cat <<'EOF'

 ⚠  Laptop band / suspend ho gaya to agent bhi so jayega. Lid band karne
    par bhi chalte rehna ho to (optional, battery kharch badhega):

      sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

    Wapas normal karne ke liye: sudo systemctl unmask sleep.target \
suspend.target hibernate.target hybrid-sleep.target
EOF
