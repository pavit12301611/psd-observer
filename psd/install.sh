#!/usr/bin/env bash
# install.sh — the one command that sets PSD up on this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/pavit12301611/psd-observer/main/psd/install.sh | bash
#
# It fetches the PSD tree (no git needed), then hands over to scripts/psd.sh:
#   • node runtime check (Node 20.19+)
#   • ~/.local/lib/psd + ~/.local/bin/psd
#   • the notch extension, installed over the existing one (backed up first)
#   • a systemd user service so PSD is always up
#   • a live proof: status, an intent answer, the SSE stream, the OpenAI surface
#
# Flags after `bash -s --`:
#   --with-deps     install Fedora packages with sudo (grim, wmctrl, libnotify…)
#   --no-service    install and test, but do not enable the systemd unit
#   --no-notch      skip the extension entirely
#   --ref <name>    install a branch or tag instead of main
set -euo pipefail

REPO="pavit12301611/psd-observer"
REF="${PSD_REF:-main}"
WITH_DEPS=0
DO_SERVICE=1
DO_NOTCH=1

while [ $# -gt 0 ]; do
  case "$1" in
    --with-deps) WITH_DEPS=1 ;;
    --no-service) DO_SERVICE=0 ;;
    --no-notch) DO_NOTCH=0 ;;
    --ref) REF="${2:?--ref needs a branch or tag}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_bad=$'\033[31m'; c_b=$'\033[1m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_ok" "$c_reset" "$*"; }
warn() { printf '%s!%s %s\n' "$c_warn" "$c_reset" "$*"; }
bad()  { printf '%s✗%s %s\n' "$c_bad" "$c_reset" "$*"; }
head_() { printf '\n%s%s%s\n' "$c_b" "$*" "$c_reset"; }

head_ "PSD — install"
say "${c_dim}personal agent for the notch · phone app · WhatsApp${c_reset}"

# ---------------------------------------------------------------- preconditions
if ! command -v node >/dev/null 2>&1; then
  bad "Node is not installed."
  say "   Fedora:  ${c_b}sudo dnf install -y nodejs${c_reset}   then re-run this command"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  bad "Node $NODE_MAJOR is too old — PSD needs 20.19+."
  say "   Fedora: ${c_b}sudo dnf install -y nodejs20${c_reset} (or use nvm)"
  exit 1
fi
ok "node $(node -v)"

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { bad "$tool is required"; exit 1; }
done

# ------------------------------------------------------------------- fetch tree
WORK="${TMPDIR:-/tmp}/psd-install-$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

head_ "Download $REPO@$REF"
URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF"
if ! curl -fsSL --retry 3 --retry-delay 1 -o "$WORK/psd.tar.gz" "$URL"; then
  # Tags and commit-ish refs are not under refs/heads.
  curl -fsSL --retry 3 -o "$WORK/psd.tar.gz" "https://codeload.github.com/$REPO/tar.gz/$REF" || {
    bad "could not download $REPO@$REF"
    exit 1
  }
fi
tar -xzf "$WORK/psd.tar.gz" -C "$WORK"
SRC="$(find "$WORK" -maxdepth 1 -type d -name 'psd-observer-*' | head -1)"
[ -d "$SRC/psd" ] || { bad "archive did not contain psd/ — is the branch pushed?"; exit 1; }
ok "downloaded $(du -sh "$SRC/psd" | cut -f1) of source"

# ------------------------------------------------------------------- install
ARGS=()
[ "$WITH_DEPS" = 1 ] && ARGS+=(--with-deps)
[ "$DO_NOTCH" = 0 ] && ARGS+=(--no-notch)
[ "$DO_SERVICE" = 0 ] && ARGS+=(--no-service)
bash "$SRC/psd/scripts/psd.sh" install ${ARGS[@]+"${ARGS[@]}"}

# ------------------------------------------------------------------- prove it
head_ "Proving it works"
PATH="$HOME/.local/bin:$PATH"
# Loading the config is what generates the token on a fresh install, so do that
# first — then read the token it wrote.
BASE="http://127.0.0.1:$(node -e "import('$HOME/.local/lib/psd/src/config.js').then(m=>console.log(m.loadConfig().port))" 2>/dev/null || echo 7788)"
TOKEN="$(cat "${XDG_DATA_HOME:-$HOME/.local/share}/psd/token.txt" 2>/dev/null || true)"

TEMP_PID=""
stop_temp() { [ -n "$TEMP_PID" ] && kill "$TEMP_PID" 2>/dev/null || true; }
trap 'stop_temp; rm -rf "$WORK"' EXIT

wait_up() {
  for _ in $(seq 1 25); do
    curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && return 0
    sleep 0.4
  done
  return 1
}

if ! wait_up; then
  if [ "$DO_SERVICE" = 0 ] || ! command -v systemctl >/dev/null 2>&1; then
    # Prove the install anyway: run the installed copy, then put it away again.
    say "${c_dim}   starting the installed copy for the check…${c_reset}"
    ( cd "$HOME/.local/lib/psd" && exec node src/index.js ) >"$WORK/daemon.log" 2>&1 &
    TEMP_PID=$!
    wait_up || {
      bad "the installed copy did not start:"
      sed -n '1,15p' "$WORK/daemon.log" | sed 's/^/   /'
      exit 1
    }
  else
    bad "PSD is not answering on $BASE"
    say "   check:  ${c_b}journalctl --user -u psd-agent -n 40 --no-pager${c_reset}"
    exit 1
  fi
fi
ok "daemon up on $BASE"

# It has to be *this* install, with *this* token — not an older PSD already
# listening on the port, which would make every check below lie.
if [ -n "$TOKEN" ]; then
  OTHER="$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "origin: $BASE" -H 'x-psd-token: not-this-install' "$BASE/psd/status" || true)"
  MINE="$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "origin: $BASE" -H "x-psd-token: $TOKEN" "$BASE/psd/status" || true)"
  if [ "$MINE" = "200" ] && [ "$OTHER" = "401" ]; then
    ok "answering with this install's token"
  else
    warn "another PSD is already on $BASE (its token differs)"
    say "   stop it:  ${c_b}systemctl --user stop psd-agent${c_reset}   or pick a port in ~/.config/psd/env"
  fi
  # A browser on some other site must not be able to drive it.
  EVIL="$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H 'origin: https://evil.example' -H "x-psd-token: $TOKEN" "$BASE/psd/status" || true)"
  [ "$EVIL" = "403" ] && ok "a foreign web page is refused (403)" || warn "foreign origin got $EVIL — expected 403"
fi

START=$(date +%s%N)
ANSWER="$(curl -sf -m 20 -H 'content-type: application/json' \
  -d '{"text":"system status"}' "$BASE/psd/chat" || true)"
MS=$(( ($(date +%s%N) - START) / 1000000 ))
if printf '%s' "$ANSWER" | grep -q '"text"'; then
  ok "answered in ${MS} ms"
  printf '%s' "$ANSWER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);j.text.split("\n").slice(0,4).forEach(l=>console.log("   "+l));console.log("   path: "+(j.path||"?")+"  tools: "+((j.toolsUsed||[]).join(", ")||"none"));})' 2>/dev/null || true
else
  bad "the agent did not answer — journalctl --user -u psd-agent -n 40"
fi

FRAMES="$(curl -sN -m 10 -H 'content-type: application/json' -d '{"text":"disk space","source":"notch"}' "$BASE/psd/chat/stream" | grep -c '^event:' || true)"
[ "${FRAMES:-0}" -ge 2 ] && ok "SSE stream live ($FRAMES frames) — the notch gets this" || warn "stream returned $FRAMES frames"

curl -sf -m 5 "$BASE/v1/models" | grep -q '"psd"' && ok "OpenAI-compatible surface at $BASE/v1" || warn "/v1/models did not list psd"

if [ "$DO_SERVICE" = 1 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user is-active --quiet psd-agent.service && ok "psd-agent.service is active (starts on login)" || warn "service not active"
fi
stop_temp

# ------------------------------------------------------------------- the next steps
head_ "You are done — here is what you can do now"
say "  ${c_b}Notch${c_reset}       open the pill (Super+Shift+N), pick the PSD tab, ask anything"
say "  ${c_b}Terminal${c_reset}    psd \"what is eating my disk\"   ·   psd status   ·   psd doctor"
say "  ${c_b}Phone${c_reset}       psd-proxy    then http://<this-pc-ip>:$((${BASE##*:} + 1)) on the phone, Add to Home Screen"
say "  ${c_b}WhatsApp${c_reset}    bash ~/.local/lib/psd/scripts/psd.sh whatsapp   (four lines for its .env)"
say "  ${c_b}Any OpenAI app${c_reset} base $BASE/v1 · model psd · key $TOKEN"
say ""
say "  ${c_dim}Full check any time:  psd doctor${c_reset}"
say ""
