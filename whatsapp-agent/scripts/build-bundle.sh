#!/usr/bin/env bash
# Build a self-contained, verified archive without private/runtime state.
# A failed build/verification leaves the previous good archive untouched.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$AGENT_DIR/.cache"
STAGE="$(mktemp -d "$AGENT_DIR/.cache/bundle-XXXXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/whatsapp-agent"
for item in src webapp test scripts systemd benchmarks audits; do
  [ -d "$AGENT_DIR/$item" ] && cp -a "$AGENT_DIR/$item" "$STAGE/whatsapp-agent/$item"
done
rm -f "$STAGE/whatsapp-agent/release-bundle.tar.gz"

for file in package.json package-lock.json release-notes.json .env.example start.sh \
            README.md QUICKSTART.md LOCAL-MODELS.md AI-KEYS.md BUILD-LOG.md NEURAL.md DEEP-TESTING.md \
            VOICE.md WHATSAPP-CALL.md \
            docker-compose.yml Containerfile; do
  [ -f "$AGENT_DIR/$file" ] && cp -a "$AGENT_DIR/$file" "$STAGE/whatsapp-agent/$file"
done

find "$STAGE/whatsapp-agent" -depth -type d \( -name '__pycache__' -o -name 'node_modules' -o -name '.cache' -o -name 'coverage' \) -exec rm -rf -- {} +
tar -czf "$STAGE/release-bundle.tar.gz" -C "$STAGE" whatsapp-agent
python3 "$AGENT_DIR/scripts/verify-bundle.py" "$STAGE/release-bundle.tar.gz"
mv -f -- "$STAGE/release-bundle.tar.gz" "$AGENT_DIR/release-bundle.tar.gz"
ls -lh "$AGENT_DIR/release-bundle.tar.gz"
