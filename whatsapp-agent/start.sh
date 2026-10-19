#!/usr/bin/env bash
# Observer WhatsApp Agent launcher (Linux/macOS/Pi). Free, native WhatsApp.
set -e
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "Node.js 20+ not found — install it free from https://nodejs.org"; exit 1; }
[ -f .env ] || { echo "Creating .env from .env.example (your numbers are already in it)"; cp .env.example .env; }
[ -d node_modules ] || npm install

echo "Starting agent — scan the QR with the AGENT phone (8859555795): WhatsApp → Linked devices → Link a device."
echo "Then message it from YOUR number (9528923866): /help"
exec npm start
