#!/usr/bin/env bash
# local-models.sh — run the agent on Hugging Face models, fully local.
#
# No API key, no cloud, no quota. Downloads a GGUF from Hugging Face with the
# `hf` CLI (or plain curl), serves it with llama.cpp's OpenAI-compatible
# llama-server, and points the agent at it.
#
#   ./scripts/local-models.sh list                 # models + RAM needed
#   ./scripts/local-models.sh recommend            # what fits THIS machine
#   ./scripts/local-models.sh commands <model>     # print the exact HF commands
#   ./scripts/local-models.sh download <model>     # hf download → ~/models/<model>
#   ./scripts/local-models.sh serve <model>        # llama-server on :8080
#   ./scripts/local-models.sh wire <model>         # write .env for the agent
#   ./scripts/local-models.sh setup <model>        # download + wire + systemd
#   ./scripts/local-models.sh ollama <model>       # same GGUF through Ollama
#   ./scripts/local-models.sh status               # is everything running?
#
# `<model>` is a short key from the list (best, balanced, tiny…) or any
# Hugging Face repo you name yourself:
#   ./scripts/local-models.sh download Qwen/Qwen3.5-9B-GGUF --quant Q4_K_M
#
# Everything stays on this PC. After the first download you can pull the
# network cable out and the agent still works.

set -euo pipefail

MODELS_DIR="${MODELS_DIR:-$HOME/models}"
ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env}"
PORT="${PORT:-8080}"
CTX="${CTX:-8192}"
HOST="${HOST:-127.0.0.1}"
SERVICE_NAME="observer-model"

say()  { printf '\n== %s ==\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

# ── catalogue ────────────────────────────────────────────────────────────────
# key | repo | quant tag | ~GB | min RAM GB | roles | note
# Re-checked against Hugging Face in Oct 2026. Quants are the ones the model
# authors publish; llama.cpp picks the file by the tag.
CATALOG=$(cat <<'EOF'
tiny|unsloth/Qwen3.5-0.8B-GGUF|Q4_K_M|0.6|2|tiny,light|fastest; good for "kholo/band karo" style jobs
light|unsloth/Qwen3.5-4B-GGUF|Q4_K_M|2.6|6|tiny,light|vision-capable; everyday laptop
balanced|ggml-org/gemma-4-12B-it-GGUF|Q4_K_M|7.4|12|light,standard,vision|256K ctx, reads screenshots, great all-rounder
classic|unsloth/Qwen3-14B-GGUF|UD-Q4_K_XL|9.0|16|standard|reliable tool calling, plain text
reason|unsloth/gpt-oss-20b-GGUF|UD-Q4_K_XL|15.8|24|standard,heavy|strong reasoning + tools, MoE (fast on CPU)
efficient|ggml-org/gemma-4-26B-A4B-it-GGUF|Q4_K_M|16.0|24|standard,heavy,vision|only 4B active per token — big quality, laptop speed
best|unsloth/Qwen3.8-27B-GGUF|UD-Q4_K_XL|17.9|24|standard,heavy|#1 local model 2026; agentic tool use, vision
EOF
)

lookup() {
  local key="$1"
  printf '%s\n' "$CATALOG" | awk -F'|' -v k="$key" '$1==k {print; found=1} END{exit(found?0:1)}'
}

is_known() { lookup "$1" >/dev/null 2>&1; }

field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

# ── hardware ─────────────────────────────────────────────────────────────────

detect() {
  local ram_kb ram_gb vram_gb=0 gpu="CPU only"
  ram_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  ram_gb=$(( ram_kb / 1024 / 1024 ))
  if command -v nvidia-smi >/dev/null 2>&1; then
    vram_gb=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    vram_gb=$(( ${vram_gb:-0} / 1024 ))
    [ "$vram_gb" -gt 0 ] && gpu="NVIDIA (${vram_gb} GB VRAM)"
  elif command -v rocm-smi >/dev/null 2>&1; then
    vram_gb=$(rocm-smi --showmeminfo vram --csv 2>/dev/null | awk -F, 'NR==2 {printf "%d", $2/1024/1024/1024}')
    [ "${vram_gb:-0}" -gt 0 ] && gpu="AMD (${vram_gb} GB VRAM)"
  fi
  printf '%s %s %s\n' "$ram_gb" "$vram_gb" "$gpu"
}

budget() {
  # Usable memory for a model: VRAM if we have a real GPU, else ~70% of RAM.
  local ram_gb="$1" vram_gb="$2"
  if [ "${vram_gb:-0}" -ge 8 ]; then echo "$vram_gb"; else echo $(( ram_gb * 7 / 10 )); fi
}

# ── tooling ──────────────────────────────────────────────────────────────────

hf_cli() {
  if command -v hf >/dev/null 2>&1; then echo "hf"; return; fi
  if command -v huggingface-cli >/dev/null 2>&1; then echo "huggingface-cli"; return; fi
  echo ""
}

install_tools() {
  say "Installing download + run tooling"
  if ! command -v python3 >/dev/null 2>&1; then
    die "python3 is required (Fedora: sudo dnf install python3)"
  fi
  if [ -z "$(hf_cli)" ]; then
    info "installing huggingface_hub (gives you the 'hf' command)"
    python3 -m pip install --user --quiet --upgrade "huggingface_hub[cli]" hf_transfer 2>/dev/null \
      || python3 -m pip install --user --quiet --upgrade huggingface_hub 2>/dev/null \
      || warn "pip install failed — downloads will fall back to plain curl"
  fi
  if ! command -v llama-server >/dev/null 2>&1 && ! command -v llama >/dev/null 2>&1; then
    info "installing llama.cpp (llama-server / llama)"
    if command -v dnf >/dev/null 2>&1 && dnf -q list llama-cpp >/dev/null 2>&1; then
      sudo dnf install -y llama-cpp || warn "dnf install llama-cpp failed"
    fi
    if ! command -v llama-server >/dev/null 2>&1 && ! command -v llama >/dev/null 2>&1; then
      if command -v curl >/dev/null 2>&1; then
        info "using the official installer: curl -LsSf https://llama.app/install.sh | sh"
        curl -LsSf https://llama.app/install.sh | sh || warn "llama.app installer failed"
        export PATH="$HOME/.local/bin:$PATH"
      fi
    fi
  fi
  command -v llama-server >/dev/null 2>&1 || command -v llama >/dev/null 2>&1 \
    || warn "llama-server still missing — install manually: https://github.com/ggml-org/llama.cpp/releases"
}

# ── per-model helpers ────────────────────────────────────────────────────────

repo_of()   { if is_known "$1"; then field "$(lookup "$1")" 2; else echo "$1"; fi; }
quant_of()  {
  if [ -n "${QUANT:-}" ]; then echo "$QUANT"; return; fi
  if is_known "$1"; then field "$(lookup "$1")" 3; else echo "Q4_K_M"; fi
}
size_of()   { if is_known "$1"; then field "$(lookup "$1")" 4; else echo "?"; fi; }
ram_of()    { if is_known "$1"; then field "$(lookup "$1")" 5; else echo "?"; fi; }
roles_of()  { if is_known "$1"; then field "$(lookup "$1")" 6; else echo "any"; fi; }
title_of()  { if is_known "$1"; then field "$(lookup "$1")" 7; else echo "custom Hugging Face repo"; fi; }
model_name() { printf '%s:%s' "$(repo_of "$1")" "$(quant_of "$1")"; }
model_dir() { printf '%s/%s' "$MODELS_DIR" "$(printf '%s' "$1" | tr '/' '_' | tr ':' '_')"; }

find_gguf() {
  local dir="$1"
  find "$dir" -maxdepth 2 -type f -name '*.gguf' 2>/dev/null \
    | grep -vi 'mmproj' | sort -k1 | head -1
}

find_mmproj() {
  local dir="$1"
  find "$dir" -maxdepth 2 -type f -name '*mmproj*.gguf' 2>/dev/null | head -1
}

# ── commands ─────────────────────────────────────────────────────────────────

cmd_list() {
  say "Local brains — Hugging Face GGUF, run by llama.cpp"
  printf '%-11s %-52s %-10s %-8s %s\n' "KEY" "HUGGING FACE REPO" "QUANT" "SIZE" "NEEDS"
  while IFS='|' read -r key repo quant gb ram roles note; do
    [ -z "$key" ] && continue
    printf '%-11s %-52s %-10s %-8s %s GB RAM\n' "$key" "$repo" "$quant" "~${gb}G" "$ram"
    printf '%-11s %s\n' "" "↳ $note  ·  roles: $roles"
  done <<< "$CATALOG"
  echo
  info "Download one:   ./scripts/local-models.sh download best"
  info "Run it:         ./scripts/local-models.sh serve best"
  info "Wire the agent: ./scripts/local-models.sh wire best"
  info "One shot:       ./scripts/local-models.sh setup best"
  info "Custom repo:    ./scripts/local-models.sh download Qwen/Qwen3.5-9B-GGUF --quant Q4_K_M"
}

cmd_detect() {
  read -r ram_gb vram_gb gpu <<< "$(detect)"
  say "This machine"
  info "RAM:  ${ram_gb} GB"
  info "GPU:  ${gpu}"
  info "Model budget (what a model may use): $(budget "$ram_gb" "$vram_gb") GB"
  info "Models folder: $MODELS_DIR"
}

cmd_recommend() {
  read -r ram_gb vram_gb gpu <<< "$(detect)"
  local room; room=$(budget "$ram_gb" "$vram_gb")
  say "This machine: ${ram_gb} GB RAM · ${gpu} · ~${room} GB usable for a model"

  local main="" small="" vision=""
  if   [ "$room" -ge 20 ]; then main="best";     small="tiny"; vision="balanced"
  elif [ "$room" -ge 15 ]; then main="reason";   small="tiny"; vision="balanced"
  elif [ "$room" -ge 10 ]; then main="balanced"; small="tiny"; vision="balanced"
  elif [ "$room" -ge 6 ];  then main="light";    small="tiny"; vision="light"
  else                          main="tiny";     small="tiny"; vision=""
  fi

  # An efficient MoE beats a dense model at the same RAM on CPU-only boxes.
  if [ "${vram_gb:-0}" -lt 8 ] && [ "$room" -ge 18 ] && [ "$room" -lt 22 ]; then
    main="efficient"
  fi

  echo
  info "Main model : $main  ($(repo_of "$main") : $(quant_of "$main"), ~$(size_of "$main") GB)"
  info "Tiny model : $small ($(repo_of "$small") : $(quant_of "$small"), ~$(size_of "$small") GB)"
  [ -n "$vision" ] && info "Vision     : $vision ($(repo_of "$vision") : $(quant_of "$vision"))"
  echo
  info "Install everything for this machine:"
  echo "   ./scripts/local-models.sh setup $main --small $small${vision:+ --vision $vision}"
}

cmd_commands() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: local-models.sh commands <model>   (see: local-models.sh list)"
  local repo quant dir name
  repo=$(repo_of "$key"); quant=$(quant_of "$key"); dir=$(model_dir "$key"); name=$(model_name "$key")
  say "Hugging Face download + run — copy-paste"
  echo "# 1. tooling (once)"
  echo "python3 -m pip install --user --upgrade 'huggingface_hub[cli]' hf_transfer"
  echo "curl -LsSf https://llama.app/install.sh | sh        # llama-server (llama.cpp)"
  echo
  echo "# 2. download the GGUF (${quant}, ~$(size_of "$key") GB)"
  echo "hf download ${repo} --include '*${quant}*' --local-dir ${dir}"
  echo "#    note: $(title_of "$key")"
  echo
  echo "# 3. serve it locally (OpenAI-compatible, port ${PORT})"
  echo "llama-server -hf ${name} --host ${HOST} --port ${PORT} --jinja -c ${CTX} -ngl 99"
  echo "#    no GPU? use -ngl 0 and ctx 4096 — slower but fine for chat + commands"
  echo
  echo "# 4. point the agent at it"
  echo "AI_PROVIDER=local"
  echo "LOCAL_API_URL=http://${HOST}:${PORT}/v1"
  echo "LOCAL_MODEL=${name}"
  echo
  echo "# 5. test it"
  echo "curl -s http://${HOST}:${PORT}/v1/models | head"
  echo "curl -s http://${HOST}:${PORT}/v1/chat/completions -H 'content-type: application/json' \\"
  echo "  -d '{\"model\":\"${name}\",\"messages\":[{\"role\":\"user\",\"content\":\"Namaste, tum kaun ho?\"}]}'"
  echo
  echo "# 6. WhatsApp pe:  /brains   (model live dikhega)"
  echo
  echo "# Or skip all of it: ./scripts/local-models.sh setup ${key}"
}

cmd_download() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: local-models.sh download <model> [--quant Q4_K_M]"
  local repo quant dir
  repo=$(repo_of "$key"); quant=$(quant_of "$key"); dir=$(model_dir "$key")
  mkdir -p "$dir"
  say "Downloading $(model_name "$key")"
  info "repo: $repo"
  info "quant: $quant  (~$(size_of "$key") GB)  → $dir"
  local cli; cli=$(hf_cli)
  if [ -n "$cli" ]; then
    export HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-1}"
    if "$cli" download "$repo" --include "*${quant}*" --local-dir "$dir"; then
      :
    else
      warn "'${cli} download' failed — falling back to the Hub's plain resolve URL"
      cli=""
    fi
  fi
  if [ -z "$cli" ]; then
    # Last resort: fetch the file list from the Hub API and curl each match.
    command -v curl >/dev/null 2>&1 || die "curl is required for the fallback download"
    local files
    files=$(curl -fsSL "https://huggingface.co/api/models/${repo}" \
      | tr ',' '\n' | grep -o '"rfilename":"[^"]*"' | cut -d'"' -f4 | grep -i "${quant}" || true)
    [ -n "$files" ] || die "could not list files for ${repo} (private repo? wrong name? try: hf download ${repo})"
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      info "curl → $f"
      curl -fL --retry 3 --retry-delay 2 -o "$dir/$(basename "$f")" \
        "https://huggingface.co/${repo}/resolve/main/${f}" || warn "failed: $f"
    done <<< "$files"
  fi
  local gguf; gguf=$(find_gguf "$dir")
  [ -n "$gguf" ] || die "download finished but no .gguf found in $dir"
  info "✅ $(basename "$gguf") ($(du -h "$gguf" | cut -f1))"
}

cmd_serve() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: local-models.sh serve <model> [--port 8080] [--ctx 8192]"
  local dir gguf mmproj name
  dir=$(model_dir "$key"); gguf=$(find_gguf "$dir"); name=$(model_name "$key")

  read -r ram_gb vram_gb _gpu <<< "$(detect)"
  local gpu_layers=0
  [ "${vram_gb:-0}" -ge 8 ] && gpu_layers=99

  local launcher=""
  command -v llama-server >/dev/null 2>&1 && launcher="llama-server"
  if [ -z "$launcher" ] && command -v llama >/dev/null 2>&1; then launcher="llama serve"; fi
  [ -n "$launcher" ] || die "llama-server not installed — run: ./scripts/local-models.sh install"

  local args=(--host "$HOST" --port "$PORT" --jinja -c "$CTX" -ngl "$gpu_layers" --alias "$name")
  if [ -n "$gguf" ]; then
    args+=(-m "$gguf")
    mmproj=$(find_mmproj "$dir")
    [ -n "$mmproj" ] && args+=(--mmproj "$mmproj")
  else
    # Not downloaded yet: let llama.cpp pull it straight from Hugging Face.
    info "no local file yet — llama.cpp will download $(model_name "$key") on first run"
    args+=(-hf "$name")
  fi

  say "Starting $( [ -n "$gguf" ] && echo "$(basename "$gguf")" || echo "$name" )"
  info "endpoint: http://${HOST}:${PORT}/v1   (ctx ${CTX}, gpu layers ${gpu_layers})"
  info "stop with Ctrl+C · background: nohup $launcher … > ~/model.log 2>&1 &"
  [ "$gpu_layers" = "0" ] && info "no GPU detected → CPU inference (expect a few tokens/sec on 27B, much faster on 'tiny')"
  exec $launcher "${args[@]}"
}

set_env() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENV_FILE"; then
    awk -v k="$k" -v v="$v" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' \
      "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}

# One model per port: llama-server serves exactly one GGUF per process, and
# the workload router needs several (tiny / main / heavy / vision) to be
# genuinely "multi-model, local".
port_for() {
  case "$1" in
    main)   echo "$PORT" ;;
    small)  echo $(( PORT + 1 )) ;;
    heavy)  echo $(( PORT + 2 )) ;;
    vision) echo $(( PORT + 3 )) ;;
  esac
}

url_for() { echo "http://${HOST}:$(port_for "$1")/v1"; }

write_unit() {
  local slot="$1" key="$2" port="$3"
  command -v systemctl >/dev/null 2>&1 || return 0
  local dir gguf launcher unit svc
  dir=$(model_dir "$key"); gguf=$(find_gguf "$dir")
  launcher=""
  command -v llama-server >/dev/null 2>&1 && launcher="$(command -v llama-server)"
  [ -z "$launcher" ] && command -v llama >/dev/null 2>&1 && launcher="$(command -v llama)"
  [ -n "$launcher" ] && [ -n "$gguf" ] || { warn "skipping the ${slot} service (llama-server or GGUF missing)"; return 0; }

  svc="$SERVICE_NAME"
  [ "$slot" != "main" ] && svc="${SERVICE_NAME}-${slot}"
  unit="$HOME/.config/systemd/user/${svc}.service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$unit" <<EOF
[Unit]
Description=Observer local model (${slot}: ${key})
After=network.target

[Service]
Type=simple
ExecStart=${launcher} -m "${gguf}" --host ${HOST} --port ${port} --jinja -c ${CTX} -ngl 99 --alias $(model_name "$key")
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload || true
  systemctl --user enable --now "$svc" >/dev/null 2>&1 \
    && info "service ${svc} → port ${port}" \
    || warn "could not start ${svc} (start manually: ./scripts/local-models.sh serve ${key} --port ${port})"
}

cmd_wire() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: local-models.sh wire <model> [--small <key>] [--heavy <key>] [--vision <key>] [--port 8080]"
  local name; name=$(model_name "$key")

  [ -f "$ENV_FILE" ] || { cp "$(dirname "$ENV_FILE")/.env.example" "$ENV_FILE" 2>/dev/null || touch "$ENV_FILE"; }
  say "Wiring the agent → local llama.cpp ($name)"

  set_env AI_PROVIDER local
  set_env ROUTER_PREFER local
  set_env LOCAL_API_URL "$(url_for main)"
  set_env LOCAL_MODEL "$name"

  local small="" heavy="" vision=""
  local i=0
  while [ $i -lt ${#REST[@]} ]; do
    case "${REST[$i]}" in
      --small)  small="${REST[$((i+1))]:-}" ;;
      --heavy)  heavy="${REST[$((i+1))]:-}" ;;
      --vision) vision="${REST[$((i+1))]:-}" ;;
    esac
    i=$(( i + 2 ))
  done

  # Same model in two slots → same endpoint, no duplicate server.
  if [ -n "$small" ] && [ "$small" = "$key" ]; then small=""; fi
  if [ -n "$heavy" ] && [ "$heavy" = "$key" ]; then heavy=""; fi

  set_env LOCAL_MODEL_SMALL  ""; set_env LOCAL_API_URL_SMALL  ""
  set_env LOCAL_MODEL_HEAVY  ""; set_env LOCAL_API_URL_HEAVY  ""
  set_env LOCAL_MODEL_VISION ""; set_env LOCAL_API_URL_VISION ""
  [ -n "$small" ]  && set_env LOCAL_MODEL_SMALL  "$(model_name "$small")"  && set_env LOCAL_API_URL_SMALL  "$(url_for small)"
  [ -n "$heavy" ]  && set_env LOCAL_MODEL_HEAVY  "$(model_name "$heavy")"  && set_env LOCAL_API_URL_HEAVY  "$(url_for heavy)"
  if [ -n "$vision" ]; then
    set_env LOCAL_MODEL_VISION "$(model_name "$vision")"
    if [ "$vision" = "$key" ]; then set_env LOCAL_API_URL_VISION "$(url_for main)"
    elif [ "$vision" = "$small" ]; then set_env LOCAL_API_URL_VISION "$(url_for small)"
    else set_env LOCAL_API_URL_VISION "$(url_for vision)"; fi
  fi

  info "✅ wrote AI_PROVIDER=local + LOCAL_* into $ENV_FILE"
  info "main: $(url_for main)   small: ${small:+$(url_for small)}   heavy: ${heavy:+$(url_for heavy)}   vision: ${vision:+$(url_for vision)}"
  info "restart the agent:  systemctl --user restart observer-whatsapp-agent   (or ./start.sh)"
  info "then WhatsApp pe:   /brains"
}

cmd_setup() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: local-models.sh setup <model> [--small <key>] [--vision <key>]"
  install_tools

  local small="" heavy="" vision=""
  local i=0
  while [ $i -lt ${#REST[@]} ]; do
    case "${REST[$i]}" in
      --small)  small="${REST[$((i+1))]:-}" ;;
      --heavy)  heavy="${REST[$((i+1))]:-}" ;;
      --vision) vision="${REST[$((i+1))]:-}" ;;
    esac
    i=$(( i + 2 ))
  done

  cmd_download "$key"
  write_unit main "$key" "$PORT"
  if [ -n "$small" ] && [ "$small" != "$key" ]; then
    cmd_download "$small"; write_unit small "$small" "$(port_for small)"
  fi
  if [ -n "$heavy" ] && [ "$heavy" != "$key" ]; then
    cmd_download "$heavy"; write_unit heavy "$heavy" "$(port_for heavy)"
  fi
  if [ -n "$vision" ] && [ "$vision" != "$key" ] && [ "$vision" != "$small" ]; then
    cmd_download "$vision"; write_unit vision "$vision" "$(port_for vision)"
  fi

  cmd_wire "$key"
  sleep 2
  say "Test it"
  curl -fsS "$(url_for main)/models" >/dev/null 2>&1 \
    && info "✅ local model is answering on $(url_for main)" \
    || info "start it with: ./scripts/local-models.sh serve ${key}   (or check: journalctl --user -u ${SERVICE_NAME} -f)"
}

cmd_ollama() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: local-models.sh ollama <model>"
  command -v ollama >/dev/null 2>&1 || die "Ollama not installed — sudo dnf install ollama && sudo systemctl enable --now ollama"
  local name; name=$(model_name "$key")
  say "Pulling $(name) through Ollama (same GGUF, managed by Ollama)"
  ollama pull "hf.co/${name}" || die "pull failed — check the repo/quant name: hf.co/${name}"
  info "✅ now: ollama run hf.co/${name}"
  info "wire it: AI_PROVIDER=ollama  OLLAMA_MODEL=hf.co/${name}   in .env"
}

cmd_status() {
  say "Local model status"
  local cli; cli=$(hf_cli)
  info "hf CLI:        ${cli:-❌ not installed (pip install 'huggingface_hub[cli]')}"
  info "llama-server:  $(command -v llama-server || command -v llama || echo '❌ not installed')"
  info "models folder: $MODELS_DIR ($( [ -d "$MODELS_DIR" ] && du -sh "$MODELS_DIR" 2>/dev/null | cut -f1 || echo 'empty'))"
  read -r ram_gb vram_gb gpu <<< "$(detect)"
  info "hardware:      ${ram_gb} GB RAM · ${gpu}"
  if curl -fsS "http://${HOST}:${PORT}/v1/models" >/dev/null 2>&1; then
    info "server:        ✅ http://${HOST}:${PORT}/v1"
    curl -fsS "http://${HOST}:${PORT}/v1/models" | tr ',' '\n' | grep '"id"' | head -3 | sed 's/^/               /'
  else
    info "server:        ❌ nothing on http://${HOST}:${PORT}/v1"
  fi
  if [ -f "$ENV_FILE" ]; then
    grep -E '^(AI_PROVIDER|LOCAL_|ROUTER_PREFER)' "$ENV_FILE" | sed 's/^/               /' || true
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

QUANT="${QUANT:-}"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --quant) QUANT_NEXT=1 ;;
  esac
done

# tiny option parser (keeps --quant/--port/--ctx usable anywhere)
CMD=""; KEY=""; REST=()
while [ $# -gt 0 ]; do
  case "$1" in
    --quant) QUANT="${2:-Q4_K_M}"; shift 2 ;;
    --port)  PORT="${2:-8080}"; shift 2 ;;
    --ctx)   CTX="${2:-8192}"; shift 2 ;;
    --host)  HOST="${2:-127.0.0.1}"; shift 2 ;;
    --small|--heavy|--vision) REST+=("$1" "${2:-}"); shift 2 ;;
    *) if [ -z "$CMD" ]; then CMD="$1"; elif [ -z "$KEY" ]; then KEY="$1"; else REST+=("$1"); fi; shift ;;
  esac
done

case "${CMD:-list}" in
  list|ls)                 cmd_list ;;
  detect|hw)               cmd_detect ;;
  recommend|rec)           cmd_recommend ;;
  commands|cmd|print)      cmd_commands "$KEY" ;;
  download|dl)             cmd_download "$KEY" ;;
  serve|run|start)         cmd_serve "$KEY" ;;
  wire|env)                cmd_wire "$KEY" ;;
  setup|install-model|all) cmd_setup "$KEY" ;;
  install|tools)           install_tools ;;
  ollama)                  cmd_ollama "$KEY" ;;
  status)                  cmd_status ;;
  -h|--help|help)          sed -n '2,30p' "$0" ;;
  *) die "unknown command: $CMD  (try: ./scripts/local-models.sh help)" ;;
esac
