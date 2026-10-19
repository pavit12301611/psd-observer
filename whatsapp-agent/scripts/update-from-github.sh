#!/usr/bin/env bash
# update-from-github.sh — update the agent WITHOUT git.
#
#   ./scripts/update-from-github.sh            # update in place, keep everything
#   bash update-from-github.sh --dir ~/psd-observer/whatsapp-agent
#   bash update-from-github.sh --fresh ~/observer-agent    # first-time install
#   ./scripts/update-from-github.sh --check    # only show the remote version
#
# How it works: downloads the branch as a .tar.gz from codeload.github.com
# (plain curl — no git, no .git folder needed), backs up the current code, then
# copies only the code over the install.
#
# NEVER touched: .env, auth_info/ (the WhatsApp login), data/ (notes, reminders,
# todos, downloads, PIN, token), node_modules/. So you do not have to re-link
# WhatsApp or lose your settings.
set -euo pipefail

REPO="${REPO:-pavit12301611/psd-observer}"
BRANCH="${BRANCH:-arena/20378d42-psd-observer}"
ARCHIVE="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

say() { printf '\n== %s ==\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }

MODE="update"
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --fresh) MODE="fresh"; TARGET="${2:-}"; [ -n "$TARGET" ] || { echo "--fresh needs a target folder, e.g. --fresh ~/observer-agent" >&2; exit 2; }; shift 2 ;;
    --dir) TARGET="${2:-}"; [ -n "$TARGET" ] || { echo "--dir needs a path" >&2; exit 2; }; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null || { echo "curl is required (Fedora: sudo dnf install curl)" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }

remote_version() {
  local json
  # raw.githubusercontent.com first (plainest), then the GitHub API (base64).
  json="$(curl -fsSL --max-time 20 "${RAW}/whatsapp-agent/package.json" 2>/dev/null || true)"
  if [ -z "$json" ]; then
    json="$(curl -fsSL --max-time 20 \
      -H 'Accept: application/vnd.github.raw' \
      "https://api.github.com/repos/${REPO}/contents/whatsapp-agent/package.json?ref=${BRANCH}" 2>/dev/null || true)"
  fi
  printf '%s' "$json" | grep -m1 '"version"' | sed -E 's/.*"version" *: *"([^"]+)".*/\1/'
}

if [ "$MODE" = "check" ]; then
  echo "Remote branch : ${BRANCH}"
  echo "Remote version: $(remote_version || echo 'could not read')"
  if [ -f whatsapp-agent/package.json ]; then
    echo "Local version : $(grep -m1 '"version"' whatsapp-agent/package.json | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
  fi
  exit 0
fi

# ── Where does the code go? ──────────────────────────────────────────────────
if [ "$MODE" = "fresh" ]; then
  DEST="$TARGET"
  mkdir -p "$DEST"
  if [ -n "$(ls -A "$DEST" 2>/dev/null)" ] && [ ! -d "$DEST/src" ]; then
    echo "$DEST is not empty and doesn't look like an agent install — refusing to overwrite." >&2
    exit 1
  fi
else
  if [ -n "$TARGET" ]; then
    DEST="$TARGET"
  elif [ -d "./src" ] && [ -f "./package.json" ]; then
    DEST="$PWD"                                   # run from inside whatsapp-agent
  elif [ -d "./whatsapp-agent/src" ]; then
    DEST="$PWD/whatsapp-agent"                    # run from the repo root
  elif [ -d "$(dirname "$0")/../src" ]; then
    DEST="$(cd "$(dirname "$0")/.." && pwd)"      # run as scripts/update-from-github.sh
  else
    echo "Couldn't find an agent install here. Use: --dir /path/to/whatsapp-agent" >&2
    exit 1
  fi
  [ -f "$DEST/package.json" ] || { echo "$DEST doesn't look like the agent (no package.json)." >&2; exit 1; }
fi
DEST="$(cd "$DEST" && pwd)"
echo "Repo   : ${REPO}"
echo "Branch : ${BRANCH}"
echo "Target : ${DEST}"

# ── Download ─────────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Downloading (curl, no git)"
if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 -o "$TMP/src.tar.gz" "$ARCHIVE"; then
  cat >&2 <<EOF
Download failed. Common causes:
  • no internet / firewall on this network — try again or use a phone hotspot
  • the branch name changed — check: $RAW/whatsapp-agent/package.json
  • GitHub blocked by DNS — try: curl -I https://codeload.github.com
Manual alternative: open this link in a browser and extract the zip yourself:
  https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip
EOF
  exit 1
fi
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'psd-observer-*' | head -1)"
[ -n "$SRC" ] || { echo "The archive didn't contain the expected folder." >&2; exit 1; }
AGENT_SRC="$SRC/whatsapp-agent"
[ -d "$AGENT_SRC/src" ] || { echo "Archive is missing whatsapp-agent/src." >&2; exit 1; }
NEW_VERSION="$(grep -m1 '"version"' "$AGENT_SRC/package.json" | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
echo "Downloaded version: ${NEW_VERSION}"

# ── First-time install = just copy everything ────────────────────────────────
if [ "$MODE" = "fresh" ] || [ ! -f "$DEST/src/index.js" ]; then
  say "Fresh install into $DEST"
  cp -a "$AGENT_SRC/." "$DEST/"
  if [ ! -f "$DEST/.env" ] && [ -f "$DEST/.env.example" ]; then
    cp "$DEST/.env.example" "$DEST/.env"
    echo "Created .env from .env.example (owner +91 95289 23866, agent +91 88595 55795)."
  fi
  ( cd "$DEST" && npm install )
  cat <<EOF

Done. Next:
  cd "$DEST"
  ./scripts/install-fedora.sh --service --ollama --power --phone   # or ./start.sh
EOF
  exit 0
fi

# ── Update in place ─────────────────────────────────────────────────────────
OLD_VERSION="$(grep -m1 '"version"' "$DEST/package.json" | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
BACKUP="$HOME/observer-agent-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
say "Backing up current code → $BACKUP"
( cd "$DEST" && tar -czf "$BACKUP" \
    src webapp test scripts systemd package.json package-lock.json \
    README.md QUICKSTART.md .env.example start.sh docker-compose.yml Containerfile 2>/dev/null \
    || warn "backup was partial (some files didn't exist yet)" ) || warn "backup failed — continuing anyway"

say "Copying code (your .env / auth_info / data are left alone)"
for item in src webapp test scripts systemd; do
  [ -d "$AGENT_SRC/$item" ] || continue
  rm -rf "$DEST/$item.new"
  cp -a "$AGENT_SRC/$item" "$DEST/$item.new"
  rm -rf "$DEST/$item"
  mv "$DEST/$item.new" "$DEST/$item"
done
for file in package.json package-lock.json README.md QUICKSTART.md .env.example start.sh docker-compose.yml Containerfile; do
  [ -f "$AGENT_SRC/$file" ] && cp -a "$AGENT_SRC/$file" "$DEST/$file"
done
chmod +x "$DEST"/scripts/*.sh "$DEST/start.sh" 2>/dev/null || true

# New settings are documented in .env.example; tell the user what's new.
if [ -f "$DEST/.env.example" ] && [ -f "$DEST/.env" ]; then
  missing="$(comm -23 <(grep -oE '^[A-Z_]+=' "$DEST/.env.example" | sort -u) <(grep -oE '^[A-Z_]+=' "$DEST/.env" | sort -u) | tr '\n' ' ')"
  [ -n "$missing" ] && echo "New optional settings in .env.example (not required): $missing"
fi

say "npm install"
( cd "$DEST" && npm install )

say "Restarting the agent"
if systemctl --user is-enabled observer-whatsapp-agent >/dev/null 2>&1; then
  systemctl --user restart observer-whatsapp-agent || warn "restart failed — check: journalctl --user -u observer-whatsapp-agent -n 50"
  sleep 1
  systemctl --user is-active observer-whatsapp-agent >/dev/null 2>&1 \
    && echo "Service is running with the new code." \
    || warn "Service is not running — check: journalctl --user -u observer-whatsapp-agent -n 50"
else
  echo "No systemd service found — restart it yourself (./start.sh, or however you run it)."
fi

cat <<EOF

────────────────────────────────────────────────────────────────────────
 Updated: ${OLD_VERSION} → ${NEW_VERSION}
 Kept as-is: .env · auth_info/ (WhatsApp login) · data/ (PIN, notes, todos)
 Backup    : ${BACKUP}
────────────────────────────────────────────────────────────────────────
 WhatsApp pe /doctor bhejo — sab kuch check ho jayega.
 Screenshot/typing theek karne ke liye (ek hi baar):
   cd "$DEST" && ./scripts/fix-desktop.sh
EOF
