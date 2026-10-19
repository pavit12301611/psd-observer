#!/usr/bin/env bash
# relink-whatsapp.sh — one-command recovery when the WhatsApp link dies:
# the agent phone unlinked this device, WhatsApp logged the session out, or
# the QR was scanned with the wrong phone.
#
# What it does:
#   1. stops the agent (systemd user service if present),
#   2. backs the dead login up next to auth_info/ with a timestamp
#      (auth_info_loggedout_<date_time>/ — moved, NEVER deleted, and repeated
#      runs never overwrite an older backup),
#   3. starts the agent again and follows the logs so a FRESH QR appears —
#      scan it with the AGENT phone. "✅ Connected" shows up in the same logs.
#
# Your data/ (notes, reminders, todos, downloads) is never touched.
# (Normally you don't even need this: AUTO_RELINK=true makes the agent do
# steps 2–3 itself the moment a logout happens. This script is the manual
# override — e.g. AUTO_RELINK=false, or the QR was scanned with the wrong
# phone so the session is valid but useless.)
#
#   ./scripts/relink-whatsapp.sh              relink + follow logs (Ctrl+C leaves the logs; the service keeps running)
#   ./scripts/relink-whatsapp.sh --no-follow  relink only, print the log command
set -euo pipefail
cd "$(dirname "$0")/.."

FOLLOW=1
for arg in "$@"; do
  case "$arg" in
    --no-follow) FOLLOW=0 ;;
    *) echo "Unknown option: $arg (supported: --no-follow)" >&2; exit 2 ;;
  esac
done

UNIT="observer-whatsapp-agent"

# Where does the login live? AUTH_DIR from .env wins (same rule as
# src/config.js: relative paths resolve against this folder, ~ = home).
AUTH_VALUE="auth_info"
if [ -f .env ]; then
  v="$(grep -E '^AUTH_DIR=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  [ -n "$v" ] && AUTH_VALUE="$v"
fi
case "$AUTH_VALUE" in
  "~")       AUTH_DIR="$HOME" ;;
  "~/"*)     AUTH_DIR="$HOME/${AUTH_VALUE#\~/}" ;;
  /*)        AUTH_DIR="$AUTH_VALUE" ;;
  *)         AUTH_DIR="$PWD/$AUTH_VALUE" ;;
esac

echo "== WhatsApp relink =="
echo "Login folder: $AUTH_DIR"

HAVE_SERVICE=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$UNIT" >/dev/null 2>&1; then
  HAVE_SERVICE=1
fi

if [ "$HAVE_SERVICE" -eq 1 ]; then
  echo "Stopping service $UNIT ..."
  systemctl --user stop "$UNIT" || true
else
  echo "No systemd user service found (foreground mode)."
  if pgrep -f "node .*src/index\.js" >/dev/null 2>&1; then
    echo "⚠ An agent process is still running. Stop it first (Ctrl+C in its terminal), then run this script again." >&2
    exit 1
  fi
fi

if [ -d "$AUTH_DIR" ]; then
  STAMP="$(date +%F_%H-%M-%S)"
  BACKUP="${AUTH_DIR}_loggedout_${STAMP}"
  n=1
  while [ -e "$BACKUP" ]; do
    BACKUP="${AUTH_DIR}_loggedout_${STAMP}-$n"
    n=$((n + 1))
  done
  mv "$AUTH_DIR" "$BACKUP"
  echo "Dead login backed up to: $BACKUP"
  echo "(It can never log in again. Delete it later if you like — but never share it.)"
else
  echo "No old login found — starting completely fresh."
fi

echo
echo "Next: scan the fresh QR with the AGENT phone (the +91 88595 55795 one):"
echo "  WhatsApp → top-right ⋮ menu → Linked devices → Link a device → scan"
echo "Do NOT scan with your personal number's phone."
echo

if [ "$HAVE_SERVICE" -eq 1 ]; then
  systemctl --user start "$UNIT"
  if [ "$FOLLOW" -eq 1 ]; then
    echo "Following logs — the QR appears below. When you see"
    echo "'✅ Connected as +918859555795', press Ctrl+C (the service keeps running)."
    echo
    exec journalctl --user -u "$UNIT" -f -n 30
  fi
  echo "Service started. QR + logs:  journalctl --user -u $UNIT -f"
else
  echo "Starting the agent in this terminal — the QR appears right here."
  echo "Leave this terminal open while the agent should run; Ctrl+C stops it."
  echo
  exec ./start.sh
fi
