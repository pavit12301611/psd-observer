#!/usr/bin/env bash
# build-bundle.sh — builds a tiny (~380 KB) self-contained release archive
# `whatsapp-agent/release-bundle.tar.gz` so curl updates take ~3 seconds
# instead of downloading the entire 18+ MB monorepo tarball.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/whatsapp-agent"
for item in src webapp test scripts systemd; do
  [ -d "$AGENT_DIR/$item" ] && cp -a "$AGENT_DIR/$item" "$STAGE/whatsapp-agent/$item"
done
rm -f "$STAGE/whatsapp-agent/release-bundle.tar.gz"

for file in package.json package-lock.json release-notes.json .env.example start.sh \
            README.md QUICKSTART.md LOCAL-MODELS.md AI-KEYS.md BUILD-LOG.md \
            docker-compose.yml Containerfile; do
  [ -f "$AGENT_DIR/$file" ] && cp -a "$AGENT_DIR/$file" "$STAGE/whatsapp-agent/$file"
done

tar -czf "$AGENT_DIR/release-bundle.tar.gz" -C "$STAGE" whatsapp-agent
ls -lh "$AGENT_DIR/release-bundle.tar.gz"
