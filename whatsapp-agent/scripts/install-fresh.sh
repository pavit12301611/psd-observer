#!/usr/bin/env bash
# install-fresh.sh — first-time install (wrapper → observer.sh install)
#
# Kept for compatibility — everything now lives in ONE script: observer.sh
#   bash observer.sh install ...
# This wrapper finds observer.sh next to it, or downloads it if you ran this
# file from /tmp, and forwards all arguments.
set -euo pipefail

REPO="${REPO:-pavit12301611/psd-observer}"
BRANCH="${BRANCH:-arena/1cff19d3-psd-observer}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -x "$HERE/observer.sh" ]; then
  exec "$HERE/observer.sh" install "$@"
fi
if [ -f "$HERE/observer.sh" ]; then
  exec bash "$HERE/observer.sh" install "$@"
fi

URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}/whatsapp-agent/scripts/observer.sh"
API="https://api.github.com/repos/${REPO}/contents/whatsapp-agent/scripts/observer.sh?ref=${BRANCH}"
TMP="/tmp/observer.sh"
if ! curl -fsSL --max-time 60 -o "$TMP" "$URL" 2>/dev/null; then
  curl -fsSL --max-time 60 -H "Accept: application/vnd.github.raw" -o "$TMP" "$API" \
    || { echo "Could not download observer.sh — check your internet." >&2; exit 1; }
fi
exec bash "$TMP" install "$@"
