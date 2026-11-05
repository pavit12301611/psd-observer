#!/usr/bin/env bash
# test-integration.sh — prove the three surfaces are one system, on this machine.
#
#   bash scripts/test-integration.sh            uses http://127.0.0.1:7788
#   PSD_PORT=7790 bash scripts/test-integration.sh
#   DEEP=1 bash scripts/test-integration.sh     also asks the model a question
#
# It never installs anything and never sends WhatsApp by default (SEND_WA=1
# enables that one write). Everything else is read-only or local.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PSD_PORT:-7788}"
BASE="${PSD_URL:-http://127.0.0.1:$PORT}"

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_bad=$'\033[31m'; c_b=$'\033[1m'
pass=0; fail=0; skip=0
ok()   { printf '%s✓%s %s\n' "$c_ok" "$c_reset" "$*"; pass=$((pass+1)); }
no()   { printf '%s✗%s %s\n' "$c_bad" "$c_reset" "$*"; fail=$((fail+1)); }
skip() { printf '%s–%s %s\n' "$c_warn" "$c_reset" "$*"; skip=$((skip+1)); }
head_() { printf '\n%s%s%s\n' "$c_b" "$*" "$c_reset"; }

TOKEN="${PSD_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="$(node -e "import('$ROOT/src/config.js').then(m=>console.log(m.loadConfig().token))" 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  no "could not read the PSD token (run 'psd doctor')"
  exit 1
fi

api() { curl -s -m "${3:-30}" -H "x-psd-token: $TOKEN" -H 'content-type: application/json' ${2:+-d "$2"} "$BASE$1"; }
# has <js-expression-on-`o`>  → exit 0 when the decoded JSON matches
has() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let o;try{o=JSON.parse(s)}catch{process.exit(1)};let ok=false;try{ok=!!eval(process.argv[1])}catch{ok=false};process.exit(ok?0:1)})" "$1"; }
# contains <plain text>  → exit 0 when the raw response contains it
contains() { grep -qF -- "$1"; }

head_ "1. daemon"
if curl -s -m 3 "$BASE/health" >/dev/null; then
  health="$(curl -s -m 3 "$BASE/health")"
  ok "PSD answers on $BASE — $(printf '%s' "$health" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('v'+o.version+' · uptime '+o.uptime+'s')})")"
else
  no "PSD is not listening on $BASE — start it: psd serve (or systemctl --user start psd-agent)"
  exit 1
fi

head_ "2. auth + browser safety"
code_ok="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "x-psd-token: $TOKEN" "$BASE/psd/status")"
# A browser origin always needs the real token — that is what protects the app.
code_no="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "origin: $BASE" -H 'x-psd-token: wrong-token-value' "$BASE/psd/status")"
code_evil="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H 'origin: https://evil.example' -H "x-psd-token: $TOKEN" "$BASE/psd/status")"
[ "$code_ok" = "200" ] && ok "token accepted" || no "token rejected (HTTP $code_ok) — check psd token"
[ "$code_no" = "401" ] && ok "wrong token refused" || no "a wrong token was not refused (HTTP $code_no)"
[ "$code_evil" = "403" ] && ok "foreign-origin page refused (no drive-by tool use)" || no "a foreign origin got through (HTTP $code_evil) — set PSD_CORS_ORIGIN correctly"
if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/psd/status")" = "200" ]; then
  ok "loopback CLI needs no token (fast path for the notch)"
fi

head_ "3. brain"
status="$(api /psd/status)"
printf '%s' "$status" | has "o.brain.healthy" && ok "a model is answering" || skip "no model — offline intents still work (ollama pull qwen3:8b)"
printf '%s' "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);
  for(const b of o.brain.brains) console.log('   '+(b.ok?'✓':'✗')+' '+b.id+(b.ok?' · '+(b.model||''):' · '+b.error))})"

head_ "4. fast paths (no model needed)"
start=$(date +%s%N)
reply="$(api /psd/chat '{"text":"system status"}')"
ms=$(( ($(date +%s%N) - start) / 1000000 ))
printf '%s' "$reply" | has "o.path==='intent'" && ok "intent → tool (${ms}ms)" || no "system status did not run the tool: $reply"
printf '%s' "$reply" | contains 'CPU:' && ok "real system data came back" || no "no CPU line in the answer"

printf '%s' "$(api /psd/chat '{"text":"who are you?"}')" | has "o.path==='quick'" && ok "quick reply (no model, no tool)" || no "quick path failed"

head_ "5. tools"
for tool in '{"tool":"system_status","args":{}}' '{"tool":"disk_space","args":{}}' '{"tool":"list_apps","args":{"query":"term"}}'; do
  name="$(printf '%s' "$tool" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).tool))")"
  out="$(api /psd/tool "$tool")"
  printf '%s' "$out" | has "o.ok===true" && ok "tool $name" || no "tool $name → $out"
done

head_ "6. streaming (what the notch uses)"
stream="$(curl -s -m 40 -N -H "x-psd-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"disk space","source":"notch"}' "$BASE/psd/chat/stream")"
printf '%s' "$stream" | grep -q '^event: start' && ok "SSE start frame" || no "no SSE start frame"
printf '%s' "$stream" | grep -q '^event: done' && ok "SSE done frame with the answer" || no "no SSE done frame"

head_ "7. notch (GNOME extension)"
notch_ok="$(printf '%s' "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).surfaces.notch.available))")"
if [ "$notch_ok" = "true" ]; then
  ok "notch D-Bus is live — pushing a card"
  pushed="$(api /psd/notch/message '{"kind":"card","title":"PSD","body":"integration test — three surfaces, one brain","tab":"chat"}')"
  printf '%s' "$pushed" | has "o.delivered===true" && ok "card delivered to the notch" || no "card not delivered: $pushed"
  state="$(gdbus call --session --dest io.github.pavit12301611.Notch \
    --object-path /io/github/pavit12301611/Notch \
    --method io.github.pavit12301611.Notch.Psd.PsdState 2>/dev/null || true)"
  [ -n "$state" ] && ok "PsdState reads back: $(printf '%s' "$state" | head -c 90)" || skip "PsdState unavailable (older extension installed?)"
else
  skip "notch extension is not on the session bus (enable it, then log out/in on Wayland)"
fi

head_ "8. whatsapp"
wa="$(printf '%s' "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);
  console.log(o.surfaces.whatsapp.linked ? 'linked' : (o.surfaces.whatsapp.lastError ? 'down' : 'unknown'))})")"
case "$wa" in
  linked) ok "WhatsApp agent is linked to the owner's phone" ;;
  down)   skip "WhatsApp agent is not running (start it, then: bash scripts/psd.sh whatsapp)" ;;
  *)      skip "WhatsApp link state unknown — check PSD_WHATSAPP_URL / PSD_WHATSAPP_TOKEN" ;;
esac
if [ "${SEND_WA:-0}" = "1" ]; then
  out="$(api /psd/whatsapp '{"text":"✅ PSD integration test — notch, phone and WhatsApp share one brain."}')"
  printf '%s' "$out" | has "o.ok===true" && ok "test message sent to the owner" || no "send failed: $out"
else
  skip "WhatsApp send not attempted (SEND_WA=1 to actually send)"
fi

head_ "9. OpenAI-compatible surface (WhatsApp agent, OpenJarvis, curl)"
printf '%s' "$(api /v1/models)" | has "o.data.length>=1" && ok "/v1/models lists psd" || no "/v1/models is empty"
completion="$(api /v1/chat/completions '{"model":"psd","messages":[{"role":"user","content":"hello"}]}')"
printf '%s' "$completion" | has "o.choices[0].message.content.length>0" && ok "/v1/chat/completions answers in OpenAI shape" || no "completion failed: $completion"

head_ "10. web app"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$BASE/")"
[ "$code" = "200" ] && ok "phone/desktop app served (HTTP 200)" || no "web app returned $code"
curl -s -m 8 "$BASE/app.js" | grep -q 'psd/chat/stream' && ok "app talks to the streaming endpoint" || no "app.js is missing the stream call"

head_ "11. memory + reminders"
api /psd/memory '{"key":"integration test","value":"'$(date -Iseconds)'"}' | has "o.ok===true" && ok "memory write" || no "memory write failed"
api /psd/memory | has "o.facts.length>=1" && ok "memory read" || no "memory read failed"
rem="$(api /psd/reminders '{"text":"integration test reminder","when":"2h"}')"
printf '%s' "$rem" | has "o.ok===true" && ok "reminder scheduled ($(printf '%s' "$rem" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(new Date(JSON.parse(s).at).toLocaleString('en-IN')))"))" || no "reminder failed: $rem"

if [ "${DEEP:-0}" = "1" ]; then
  head_ "12. model round-trip"
  q="$(api /psd/chat '{"text":"In one sentence: what is the difference between a process and a thread?"}' null 120)"
  printf '%s' "$q" | has "o.text.length>20" && ok "model answered: $(printf '%s' "$q" | head -c 120)…" || no "model did not answer: $q"
fi

head_ "summary"
printf '  %s✓ %d passed%s   %s! %d skipped%s   %s✗ %d failed%s\n' \
  "$c_ok" "$pass" "$c_reset" "$c_warn" "$skip" "$c_reset" "$c_bad" "$fail" "$c_reset"
[ "$fail" -eq 0 ] && printf '\n  %sPSD is wired end to end.%s\n\n' "$c_ok" "$c_reset" || printf '\n  %sFix the ✗ lines above (psd doctor gives the commands).%s\n\n' "$c_bad" "$c_reset"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
