#!/usr/bin/env bash
# install-fresh.sh — FIRST-TIME install with no git at all.
#
#   curl -fL -o /tmp/observer-setup.sh \
#     "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/5f4643a1-psd-observer/whatsapp-agent/scripts/install-fresh.sh"
#   bash /tmp/observer-setup.sh --service --ollama --power --phone
#
# What it does, in order:
#   1. downloads the branch as a .tar.gz from codeload.github.com (plain curl)
#   2. extracts the whatsapp-agent folder to ~/observer-agent (or --dir <path>)
#   3. creates .env from .env.example (owner/agent numbers already filled in)
#   4. runs scripts/install-fedora.sh with the flags you pass
#
# Options:
#   --dir <path>       where to install (default: ~/observer-agent)
#   --no-install       download + extract only (then you run install-fedora.sh)
#   --force            install into a folder that already has code (overwrites it)
#   --service --ollama --power --phone --remote
#                      passed straight through to install-fedora.sh
#
# Requirements: Fedora (dnf), curl, tar, tar+curl internet. No git, no zip tool.
set -euo pipefail

REPO="${REPO:-pavit12301611/psd-observer}"
BRANCH="${BRANCH:-arena/5f4643a1-psd-observer}"
ARCHIVE="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"

DEST="$HOME/observer-agent"
DO_INSTALL=1
FORCE=0
PASSTHRU=()

say() { printf '\n== %s ==\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DEST="${2:-}"; [ -n "$DEST" ] || { echo "--dir needs a path" >&2; exit 2; }; shift 2 ;;
    --no-install) DO_INSTALL=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    --service|--ollama|--power|--phone|--remote|--pc-control) PASSTHRU+=("$1"); shift ;;
    *) echo "Unknown option: $1 (supported: --dir, --no-install, --force, --service, --ollama, --power, --phone, --remote)" >&2; exit 2 ;;
  esac
done

say "Checks"
for bin in curl tar; do
  command -v "$bin" >/dev/null || { echo "$bin is required. Fedora: sudo dnf install $bin" >&2; exit 1; }
done
command -v dnf >/dev/null || warn "dnf not found — this installer targets Fedora. It will still download the code, but you'll install Node yourself."
echo "Repo   : ${REPO}"
echo "Branch : ${BRANCH}"
echo "Install: ${DEST}"
echo "Flags  : ${PASSTHRU[*]:-none}"

# ── 1. Download ──────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Downloading the code (curl, no git)"
if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 -o "$TMP/src.tar.gz" "$ARCHIVE"; then
  cat >&2 <<EOF

Download failed. Things to try:
  • check internet:  curl -I https://codeload.github.com
  • mobile hotspot / different network (some ISPs block GitHub raw)
  • download in a browser instead and unzip to ${DEST}:
      https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip
EOF
  exit 1
fi
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'psd-observer-*' | head -1)"
[ -n "$SRC" ] || { echo "The archive didn't contain the expected folder." >&2; exit 1; }
[ -d "$SRC/whatsapp-agent/src" ] || { echo "Archive is missing whatsapp-agent/src — branch name wrong?" >&2; exit 1; }
VERSION="$(grep -m1 '"version"' "$SRC/whatsapp-agent/package.json" | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
echo "Version: ${VERSION}"

# ── 2. Extract ───────────────────────────────────────────────────────────────
if [ -d "$DEST/src" ] && [ "$FORCE" -ne 1 ]; then
  cat >&2 <<EOF

${DEST} already has an agent install.
  • to UPDATE it (keeps .env, WhatsApp login, data):
        bash "$0" --dir "${DEST}"           # or scripts/update-from-github.sh --dir "$DEST"
  • to overwrite the code anyway (keeps .env/auth_info/data too):
        bash "$0" --dir "${DEST}" --force
EOF
  exit 1
fi

say "Installing to $DEST"
mkdir -p "$DEST"
if [ "$FORCE" -eq 1 ]; then
  # Keep secrets/state, replace only code.
  for item in src webapp test scripts systemd; do
    cp -a "$SRC/whatsapp-agent/$item" "$DEST/${item}.new" 2>/dev/null || continue
    rm -rf "$DEST/$item"; mv "$DEST/${item}.new" "$DEST/$item"
  done
  for file in package.json package-lock.json README.md QUICKSTART.md .env.example start.sh docker-compose.yml Containerfile; do
    [ -f "$SRC/whatsapp-agent/$file" ] && cp -a "$SRC/whatsapp-agent/$file" "$DEST/$file"
  done
else
  cp -a "$SRC/whatsapp-agent/." "$DEST/"
fi

if [ ! -f "$DEST/.env" ]; then
  cp "$DEST/.env.example" "$DEST/.env"
  echo "Created .env (owner +91 95289 23866, agent +91 88595 55795 already set)."
fi
chmod +x "$DEST"/scripts/*.sh "$DEST/start.sh" 2>/dev/null || true

echo "Installed files:"
( cd "$DEST" && ls -d src webapp scripts systemd package.json 2>/dev/null | sed 's/^/  • /' )

# ── 3. Install ───────────────────────────────────────────────────────────────
if [ "$DO_INSTALL" -eq 0 ]; then
  cat <<EOF

Downloaded only (--no-install). Next:
  cd "$DEST"
  ./scripts/install-fedora.sh ${PASSTHRU[*]:---service --ollama --power --phone}
EOF
  exit 0
fi

say "Running the Fedora installer"
cd "$DEST"
./scripts/install-fedora.sh "${PASSTHRU[@]}"

cat <<EOF

────────────────────────────────────────────────────────────────────────
 ✅ Installed ${VERSION} in ${DEST}
────────────────────────────────────────────────────────────────────────
 1. Logs / QR / phone-app URL + PIN:
      journalctl --user -u observer-whatsapp-agent -f
 2. Agent phone (+91 88595 55795) se QR scan karo:
      WhatsApp → Linked devices → Link a device
 3. Apne phone (+91 95289 23866) se agent ko message karo:  /help
 4. Phone app: printed URL kholo → PIN → "Add to Home screen"
 5. Screenshot kaali / typing na chale?:
      cd "${DEST}" && ./scripts/fix-desktop.sh    then WhatsApp: /doctor
 6. Ghar se bahar app chahiye:
      cd "${DEST}" && ./scripts/setup-remote.sh

 Folder: ${DEST}
 Update baad me (git ke bina):
   curl -fL -o /tmp/agent-update.sh "https://raw.githubusercontent.com/${REPO}/${BRANCH}/whatsapp-agent/scripts/update-from-github.sh"
   bash /tmp/agent-update.sh --dir "${DEST}"
EOF
