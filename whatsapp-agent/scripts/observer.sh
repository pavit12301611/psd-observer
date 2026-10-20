#!/usr/bin/env bash
# observer.sh — ONE script for the whole Observer WhatsApp agent.
#
#   bash observer.sh install     first-time install (curl-only, no git needed)
#   bash observer.sh update      update the code, keep .env / WhatsApp login / data
#   bash observer.sh models …    local Hugging Face models (llama.cpp) — 100% offline
#   bash observer.sh keys …      add Groq / OpenRouter / Gemini free API keys
#   bash observer.sh test        self-test: keys, brains, routing, unit tests
#   bash observer.sh doctor      what is broken and the exact fix
#   bash observer.sh service …   systemd: install / restart / status / logs
#   bash observer.sh start       run in the foreground
#   bash observer.sh relink      fresh WhatsApp QR
#   bash observer.sh remote      Tailscale access to the phone app from anywhere
#   bash observer.sh fix         screenshots / keyboard / mouse on Fedora
#   bash observer.sh version     local vs remote version
#
# Examples
#   bash observer.sh install --service --power --phone
#   bash observer.sh install --fedora all --model best
#   bash observer.sh models recommend
#   bash observer.sh models setup best --small tiny --vision balanced
#   bash observer.sh update --dir ~/observer-agent
#   bash observer.sh doctor
#
# Nothing here needs git. The install/update path downloads a branch tarball
# with plain curl from codeload.github.com.
set -euo pipefail

REPO="${REPO:-pavit12301611/psd-observer}"
BRANCH="${BRANCH:-arena/5f4643a1-psd-observer}"
ARCHIVE="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
API="https://api.github.com/repos/${REPO}/contents"
DEFAULT_DIR="${DEFAULT_DIR:-$HOME/observer-agent}"
SERVICE="observer-whatsapp-agent"
MODEL_SERVICE="observer-model"
SELF_URL="${RAW}/whatsapp-agent/scripts/observer.sh"
# Where this file lives — if it sits inside an install (<dir>/scripts/), that
# install wins over anything else we might discover.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"

# ── pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; INFO=$'\033[36m'
else
  B=""; DIM=""; R=""; OK=""; WARN=""; ERR=""; INFO=""
fi
say()  { printf '\n%s== %s ==%s\n' "$B" "$*" "$R"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   %s✅ %s%s\n' "$OK" "$*" "$R"; }
warn() { printf '   %s⚠  %s%s\n' "$WARN" "$*" "$R" >&2; }
bad()  { printf '   %s❌ %s%s\n' "$ERR" "$*" "$R" >&2; }
die()  { printf '\n%s❌ %s%s\n' "$ERR" "$*" "$R" >&2; exit 1; }
hint() { printf '      %s%s%s\n' "$DIM" "$*" "$R"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── version / network helpers ────────────────────────────────────────────────

local_version() {
  local dir="${1:-.}"
  grep -m1 '"version"' "$dir/package.json" 2>/dev/null | sed -E 's/.*"version" *: *"([^"]+)".*/\1/'
}

remote_version() {
  local json
  json=$(curl -fsSL --max-time 20 "${RAW}/whatsapp-agent/package.json" 2>/dev/null || true)
  if [ -z "$json" ]; then
    json=$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github.raw' \
      "${API}/whatsapp-agent/package.json?ref=${BRANCH}" 2>/dev/null || true)
  fi
  printf '%s' "$json" | grep -m1 '"version"' | sed -E 's/.*"version" *: *"([^"]+)".*/\1/'
}

# Download a file from the repo: raw first, GitHub API as fallback.
fetch_repo_file() {
  local rel="$1" out="$2"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 90 -o "$out" "${RAW}/${rel}" 2>/dev/null \
    || curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 90 \
         -H 'Accept: application/vnd.github.raw' -o "$out" "${API}/${rel}?ref=${BRANCH}"
}

download_tarball() {
  local tmp="$1"
  say "Downloading the code (curl, no git)"
  info "branch: ${BRANCH}"
  if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 -o "$tmp/src.tar.gz" "$ARCHIVE"; then
    cat >&2 <<EOF

Could not download the code. Common causes:
  • no internet / firewall on this network — try a phone hotspot
  • the branch name changed — check: $SELF_URL
  • GitHub blocked by DNS — test: curl -I https://codeload.github.com
Manual alternative (opens in a browser):
  https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip
EOF
    return 1
  fi
  tar -xzf "$tmp/src.tar.gz" -C "$tmp"
}

find_extracted_agent() {
  local tmp="$1"
  find "$tmp" -maxdepth 2 -type d -name 'whatsapp-agent' | head -1
}

# ── where is the install? ────────────────────────────────────────────────────

find_install() {
  local target="${1:-}"
  if [ -n "$target" ]; then
    ( cd "$target" 2>/dev/null && pwd ) || return 1
    return 0
  fi
  if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/../package.json" ] \
     && [ -d "$SELF_DIR/../src" ] \
     && grep -q 'observer-whatsapp-agent' "$SELF_DIR/../package.json" 2>/dev/null; then
    ( cd "$SELF_DIR/.." && pwd ); return 0
  fi
  if [ -f "./package.json" ] && [ -d "./src" ] && grep -q 'observer-whatsapp-agent' ./package.json 2>/dev/null; then
    pwd; return 0
  fi
  if [ -d "./whatsapp-agent/src" ]; then
    ( cd ./whatsapp-agent && pwd ); return 0
  fi
  if [ -d "$DEFAULT_DIR/src" ]; then
    ( cd "$DEFAULT_DIR" && pwd ); return 0
  fi
  local guess
  guess=$(find "$HOME" -maxdepth 5 -type f -name package.json -path '*observer-agent*' 2>/dev/null | head -1)
  [ -n "$guess" ] && { dirname "$guess"; return 0; }
  guess=$(find "$HOME" -maxdepth 6 -type f -name index.js -path '*whatsapp-agent/src*' 2>/dev/null | head -1)
  [ -n "$guess" ] && { dirname "$(dirname "$guess")"; return 0; }
  return 1
}

service_active()  { systemctl --user is-active  "$SERVICE" >/dev/null 2>&1; }
service_enabled() { systemctl --user is-enabled "$SERVICE" >/dev/null 2>&1; }

restart_agent() {
  local dir="$1"
  if service_enabled; then
    systemctl --user restart "$SERVICE" && sleep 1
    if service_active; then ok "service ${SERVICE} restarted with the new code"
    else bad "service is not running — check: journalctl --user -u ${SERVICE} -n 50"; fi
  else
    info "no systemd service yet — start it yourself: cd \"$dir\" && ./start.sh"
    hint "or install the service: bash observer.sh service install"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  INSTALL
# ═══════════════════════════════════════════════════════════════════════════════

cmd_install() {
  local dest="$DEFAULT_DIR" force=0 fedora=0 passthru=() model=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)       dest="${2:-}"; [ -n "$dest" ] || die "--dir needs a path"; shift 2 ;;
      --force)     force=1; shift ;;
      --fedora)    fedora=1; shift ;;
      --model)     model="${2:-}"; shift 2 ;;
      --service|--ollama|--power|--phone|--remote|--pc-control) passthru+=("$1"); fedora=1; shift ;;
      -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
      *) die "install: unknown option $1 (try --help)" ;;
    esac
  done

  have curl || die "curl is required: sudo dnf install curl"
  have tar  || die "tar is required: sudo dnf install tar"
  have node || die "Node.js 20+ is required: sudo dnf install nodejs npm"
  local node_major; node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 20 ] || die "Node.js 20+ required (you have $(node -v)). Fedora: sudo dnf module install nodejs:22"

  if [ -d "$dest/src" ] && [ "$force" -ne 1 ]; then
    warn "$dest already has an install."
    info "update it instead:  bash observer.sh update --dir $dest"
    info "or force a reinstall: bash observer.sh install --dir $dest --force"
    exit 1
  fi

  local tmp; tmp=$(mktemp -d); trap "rm -rf '$tmp'" EXIT
  download_tarball "$tmp" || exit 1
  local src; src=$(find_extracted_agent "$tmp")
  [ -n "$src" ] && [ -d "$src/src" ] || die "the archive did not contain whatsapp-agent/ (branch changed?)"

  say "Installing into $dest"
  mkdir -p "$dest"
  # The tarball never contains .env / auth_info/ / data/ (gitignored), so a
  # straight copy cannot destroy an existing login or your notes.
  cp -a "$src/." "$dest/"
  chmod +x "$dest"/scripts/*.sh "$dest/start.sh" 2>/dev/null || true
  if [ ! -f "$dest/.env" ] && [ -f "$dest/.env.example" ]; then
    cp "$dest/.env.example" "$dest/.env"
    ok "created .env (owner +91 95289 23866 · agent +91 88595 55795 already filled in)"
  fi
  ok "code installed · version $(local_version "$dest")"

  say "Installing Node dependencies"
  ( cd "$dest" && npm install --no-audit --no-fund ) || die "npm install failed — check your internet, then: cd $dest && npm install"

  if [ "$fedora" -eq 1 ]; then
    say "Fedora setup (packages, service, desktop tools)"
    ( cd "$dest" && ./scripts/install-fedora.sh "${passthru[@]}" ) || warn "install-fedora.sh reported a problem (see above)"
  fi

  if [ "$model" = "auto" ]; then
    say "Picking a local model for this machine"
    model=$(models_recommend_key)
  fi
  if [ -n "$model" ]; then
    cmd_models setup "$model"
  fi

  say "Done"
  cat <<EOF
   Folder : $dest
   Start  : cd "$dest" && ./start.sh
   Service: bash "$dest/scripts/observer.sh" service install
   Update : bash "$dest/scripts/observer.sh" update
   Local AI (no cloud): bash "$dest/scripts/observer.sh" models recommend
   Check  : bash "$dest/scripts/observer.sh" doctor

EOF
  [ ${#passthru[@]} -eq 0 ] && hint "next time, save time: bash observer.sh install --service --power --phone"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  UPDATE
# ═══════════════════════════════════════════════════════════════════════════════

cmd_update() {
  local dir="" check=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)   dir="${2:-}"; [ -n "$dir" ] || die "--dir needs a path"; shift 2 ;;
      --check) check=1; shift ;;
      -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
      *) die "update: unknown option $1 (try --help)" ;;
    esac
  done

  have curl || die "curl is required: sudo dnf install curl"
  local dest
  dest=$(find_install "$dir") || die "couldn't find an agent install. Use: bash observer.sh update --dir /path/to/observer-agent"

  if [ "$check" -eq 1 ]; then
    say "Version check"
    info "branch : ${BRANCH}"
    info "remote : $(remote_version || echo 'could not read')"
    info "local  : $(local_version "$dest")"
    exit 0
  fi

  local old; old=$(local_version "$dest")
  local started_epoch; started_epoch=$(date +%s)
  local tmp; tmp=$(mktemp -d); trap "rm -rf '$tmp'" EXIT
  download_tarball "$tmp" || exit 1
  local src; src=$(find_extracted_agent "$tmp")
  [ -n "$src" ] || die "the archive did not contain whatsapp-agent/"
  local new; new=$(local_version "$src")
  info "installed: ${old:-?} → ${new:-?}"

  local backup="$HOME/observer-agent-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  say "Backing up the current code → $backup"
  ( cd "$dest" && tar -czf "$backup" \
      src webapp test scripts systemd package.json package-lock.json \
      README.md QUICKSTART.md LOCAL-MODELS.md AI-KEYS.md .env.example start.sh \
      docker-compose.yml Containerfile 2>/dev/null ) \
    || warn "backup was partial (some files don't exist yet) — continuing"

  say "Copying code (your .env / auth_info / data stay untouched)"
  local item file
  for item in src webapp test scripts systemd; do
    [ -d "$src/$item" ] || continue
    rm -rf "$dest/$item.new"
    cp -a "$src/$item" "$dest/$item.new"
    rm -rf "$dest/$item"
    mv "$dest/$item.new" "$dest/$item"
  done
  for file in package.json package-lock.json README.md QUICKSTART.md LOCAL-MODELS.md AI-KEYS.md \
              .env.example start.sh docker-compose.yml Containerfile; do
    [ -f "$src/$file" ] && cp -a "$src/$file" "$dest/$file"
  done
  chmod +x "$dest"/scripts/*.sh "$dest/start.sh" 2>/dev/null || true

  migrate_groq_env "$dest/.env"

  if [ -f "$dest/.env.example" ] && [ -f "$dest/.env" ]; then
    local missing
    missing=$(comm -23 <(grep -oE '^[A-Z_]+=' "$dest/.env.example" | sort -u) \
                        <(grep -oE '^[A-Z_]+=' "$dest/.env" | sort -u) | tr '\n' ' ')
    [ -n "$missing" ] && info "new optional settings in .env.example: $missing"
  fi

  say "Installing dependencies"
  ( cd "$dest" && npm install --no-audit --no-fund ) || warn "npm install failed — run it yourself: cd $dest && npm install"

  # Leave a receipt the new process can read at startup: data/ survives
  # updates, so the "updated!" WhatsApp message knows the real duration.
  local elapsed=$(( $(date +%s) - started_epoch ))
  mkdir -p "$dest/data"
  printf '{"from":"%s","to":"%s","at":"%s","seconds":%s,"via":"observer.sh"}\n' \
    "${old:-}" "${new:-}" "$(date -Is)" "$elapsed" > "$dest/data/last-update.json" 2>/dev/null \
    || warn "could not write data/last-update.json (update still fine)"

  restart_agent "$dest"

  cat <<EOF

────────────────────────────────────────────────────────────────────────
 Updated: ${old:-?} → ${new:-?}   (took $(( $(date +%s) - started_epoch ))s)
 Kept   : .env · auth_info/ (WhatsApp login, no new QR) · data/
 Backup : ${backup}
────────────────────────────────────────────────────────────────────────
 WhatsApp pe ek "updated" message aayega (kya naya + kitna time laga).
 Phir /doctor bhejo — sab check ho jayega.
EOF
}

# ═══════════════════════════════════════════════════════════════════════════════
#  MODELS — local Hugging Face GGUF via llama.cpp
# ═══════════════════════════════════════════════════════════════════════════════

MODELS_DIR="${MODELS_DIR:-$HOME/models}"
MODEL_PORT="${MODEL_PORT:-8080}"
MODEL_CTX="${MODEL_CTX:-8192}"
MODEL_HOST="${MODEL_HOST:-127.0.0.1}"
QUANT=""
PORT_SET=0

# key | repo | quant tag | ~GB | min RAM GB | roles | note
MODEL_CATALOG=$(cat <<'EOF'
tiny|unsloth/Qwen3.5-0.8B-GGUF|Q4_K_M|0.6|2|tiny,light|fastest; good for "kholo/band karo" style jobs
light|unsloth/Qwen3.5-4B-GGUF|Q4_K_M|2.6|6|tiny,light|vision-capable; everyday laptop
balanced|ggml-org/gemma-4-12B-it-GGUF|Q4_K_M|7.4|12|light,standard,vision|256K ctx, reads screenshots, great all-rounder
classic|unsloth/Qwen3-14B-GGUF|UD-Q4_K_XL|9.0|16|standard|reliable tool calling, plain text
reason|unsloth/gpt-oss-20b-GGUF|UD-Q4_K_XL|15.8|24|standard,heavy|strong reasoning + tools, MoE (fast on CPU)
efficient|ggml-org/gemma-4-26B-A4B-it-GGUF|Q4_K_M|16.0|24|standard,heavy,vision|only 4B active per token — big quality, laptop speed
best|unsloth/Qwen3.8-27B-GGUF|UD-Q4_K_XL|17.9|24|standard,heavy|#1 local model 2026; agentic tool use, vision
EOF
)

cat_row()      { printf '%s\n' "$MODEL_CATALOG" | awk -F'|' -v k="$1" '$1==k {print; found=1} END{exit(found?0:1)}'; }
is_known()     { cat_row "$1" >/dev/null 2>&1; }
cat_field()    { printf '%s' "$1" | cut -d'|' -f"$2"; }
repo_of()      { if is_known "$1"; then cat_field "$(cat_row "$1")" 2; else echo "$1"; fi; }
quant_of()     { if [ -n "$QUANT" ]; then echo "$QUANT"; elif is_known "$1"; then cat_field "$(cat_row "$1")" 3; else echo "Q4_K_M"; fi; }
size_of()      { is_known "$1" && cat_field "$(cat_row "$1")" 4 || echo "?"; }
ram_of()       { is_known "$1" && cat_field "$(cat_row "$1")" 5 || echo "?"; }
note_of()      { is_known "$1" && cat_field "$(cat_row "$1")" 7 || echo "custom Hugging Face repo"; }
model_name()   { printf '%s:%s' "$(repo_of "$1")" "$(quant_of "$1")"; }
model_dir()    { printf '%s/%s' "$MODELS_DIR" "$(printf '%s' "$1" | tr '/' '_' | tr ':' '_')"; }

hf_cli() { if have hf; then echo hf; elif have huggingface-cli; then echo huggingface-cli; else echo ""; fi; }

detect_hw() {
  local ram_kb ram_gb vram_gb=0 gpu="CPU only" tmp
  ram_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  ram_gb=$(( ram_kb / 1024 / 1024 ))
  if have nvidia-smi; then
    tmp=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    vram_gb=$(( ${tmp:-0} / 1024 ))
    [ "$vram_gb" -gt 0 ] && gpu="NVIDIA (${vram_gb} GB VRAM)"
  elif have rocm-smi; then
    tmp=$(rocm-smi --showmeminfo vram --csv 2>/dev/null | awk -F, 'NR==2 {printf "%d", $2/1024/1024/1024}')
    vram_gb=${tmp:-0}
    [ "$vram_gb" -gt 0 ] && gpu="AMD (${vram_gb} GB VRAM)"
  fi
  printf '%s %s %s\n' "$ram_gb" "$vram_gb" "$gpu"
}

model_budget() {
  local ram_gb="$1" vram_gb="$2"
  if [ "${vram_gb:-0}" -ge 8 ]; then echo "$vram_gb"; else echo $(( ram_gb * 7 / 10 )); fi
}

models_recommend_key() {
  local ram_gb vram_gb gpu room
  read -r ram_gb vram_gb gpu <<< "$(detect_hw)"
  room=$(model_budget "$ram_gb" "$vram_gb")
  if [ "$room" -ge 20 ]; then echo best
  elif [ "$room" -ge 15 ]; then echo reason
  elif [ "$room" -ge 10 ]; then echo balanced
  elif [ "$room" -ge 6 ]; then echo light
  else echo tiny; fi
}

find_gguf()   { find "$1" -maxdepth 2 -type f -name '*.gguf' 2>/dev/null | grep -vi mmproj | sort | head -1; }
find_mmproj() { find "$1" -maxdepth 2 -type f -name '*mmproj*.gguf' 2>/dev/null | head -1; }

install_model_tools() {
  say "Installing download + run tooling"
  have python3 || die "python3 is required: sudo dnf install python3"
  if [ -z "$(hf_cli)" ]; then
    info "installing huggingface_hub (the 'hf' command)"
    python3 -m pip install --user --quiet --upgrade "huggingface_hub[cli]" hf_transfer 2>/dev/null \
      || python3 -m pip install --user --quiet --upgrade huggingface_hub 2>/dev/null \
      || warn "pip install failed — downloads will fall back to plain curl"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if ! have llama-server && ! have llama; then
    info "installing llama.cpp (llama-server)"
    if have dnf && dnf -q list llama-cpp >/dev/null 2>&1; then
      sudo dnf install -y llama-cpp || warn "dnf install llama-cpp failed"
    fi
    if ! have llama-server && ! have llama; then
      info "official installer: https://llama.app/install.sh"
      curl -LsSf https://llama.app/install.sh | sh || warn "llama.app installer failed"
      export PATH="$HOME/.local/bin:$PATH"
    fi
  fi
  have llama-server || have llama || warn "llama-server missing — binaries: https://github.com/ggml-org/llama.cpp/releases"
}

models_list() {
  say "Local brains — Hugging Face GGUF, run by llama.cpp"
  printf '%-11s %-50s %-10s %-7s %s\n' "KEY" "HUGGING FACE REPO" "QUANT" "SIZE" "NEEDS"
  local key repo quant gb ram roles note
  while IFS='|' read -r key repo quant gb ram roles note; do
    [ -z "$key" ] && continue
    printf '%-11s %-50s %-10s %-7s %s GB RAM\n' "$key" "$repo" "$quant" "~${gb}G" "$ram"
    printf '%-11s %s\n' "" "↳ ${note}"
  done <<< "$MODEL_CATALOG"
  echo
  info "bash observer.sh models recommend"
  info "bash observer.sh models setup best"
  info "bash observer.sh models commands best     # sirf download commands"
  info "bash observer.sh models download Qwen/Qwen3.5-9B-GGUF --quant Q4_K_M"
}

models_recommend() {
  local ram_gb vram_gb gpu room main small vision
  read -r ram_gb vram_gb gpu <<< "$(detect_hw)"
  room=$(model_budget "$ram_gb" "$vram_gb")
  say "This machine: ${ram_gb} GB RAM · ${gpu} · ~${room} GB usable for a model"

  if   [ "$room" -ge 20 ]; then main="best";     small="tiny"; vision="balanced"
  elif [ "$room" -ge 15 ]; then main="reason";   small="tiny"; vision="balanced"
  elif [ "$room" -ge 10 ]; then main="balanced"; small="tiny"; vision="balanced"
  elif [ "$room" -ge 6 ];  then main="light";    small="tiny"; vision="light"
  else                          main="tiny";     small="tiny"; vision=""
  fi
  if [ "${vram_gb:-0}" -lt 8 ] && [ "$room" -ge 18 ] && [ "$room" -lt 22 ]; then main="efficient"; fi

  info "Main   : $main — $(repo_of "$main") : $(quant_of "$main")  (~$(size_of "$main") GB)"
  info "Tiny   : $small — $(repo_of "$small") : $(quant_of "$small")"
  [ -n "$vision" ] && info "Vision : $vision — $(repo_of "$vision") : $(quant_of "$vision")"
  echo
  info "Install it all:"
  printf '   bash observer.sh models setup %s --small %s%s\n' "$main" "$small" "${vision:+ --vision $vision}"
}

models_commands() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: observer.sh models commands <model>"
  local repo quant dir name
  repo=$(repo_of "$key"); quant=$(quant_of "$key"); dir=$(model_dir "$key"); name=$(model_name "$key")
  say "Hugging Face download + run (copy-paste)"
  echo "# 1. tooling (once)"
  echo "python3 -m pip install --user --upgrade 'huggingface_hub[cli]' hf_transfer"
  echo "curl -LsSf https://llama.app/install.sh | sh"
  echo
  echo "# 2. download the GGUF (${quant}, ~$(size_of "$key") GB) — $(note_of "$key")"
  echo "hf download ${repo} --include '*${quant}*' --local-dir ${dir}"
  echo
  echo "# 3. serve it (OpenAI-compatible, port ${MODEL_PORT})"
  echo "llama-server -hf ${name} --host ${MODEL_HOST} --port ${MODEL_PORT} --jinja -c ${MODEL_CTX} -ngl 99"
  echo "#    no GPU: use -ngl 0 -c 4096"
  echo
  echo "# 4. point the agent at it (.env)"
  echo "AI_PROVIDER=local"
  echo "LOCAL_API_URL=http://${MODEL_HOST}:${MODEL_PORT}/v1"
  echo "LOCAL_MODEL=${name}"
  echo
  echo "# 5. test"
  echo "curl -s http://${MODEL_HOST}:${MODEL_PORT}/v1/models"
  echo
  echo "# or do 1-4 automatically: bash observer.sh models setup ${key}"
}

models_download() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: observer.sh models download <model> [--quant Q4_K_M]"
  local repo quant dir cli
  repo=$(repo_of "$key"); quant=$(quant_of "$key"); dir=$(model_dir "$key")
  mkdir -p "$dir"
  say "Downloading $(model_name "$key")"
  info "repo:  $repo"
  info "quant: $quant  (~$(size_of "$key") GB)"
  info "into:  $dir"

  cli=$(hf_cli)
  if [ -n "$cli" ]; then
    export HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-1}"
    if ! "$cli" download "$repo" --include "*${quant}*" --local-dir "$dir"; then
      warn "'${cli} download' failed — falling back to the Hub resolve URLs"
      cli=""
    fi
  fi
  if [ -z "$cli" ]; then
    have curl || die "curl is required for the fallback download"
    local files
    files=$(curl -fsSL "https://huggingface.co/api/models/${repo}" 2>/dev/null \
      | tr ',' '\n' | grep -o '"rfilename":"[^"]*"' | cut -d'"' -f4 | grep -i "${quant}" || true)
    [ -n "$files" ] || die "could not list files for ${repo} — check the repo name (or: hf download ${repo})"
    local f
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      info "curl → $f"
      curl -fL --retry 3 --retry-delay 2 -o "$dir/$(basename "$f")" \
        "https://huggingface.co/${repo}/resolve/main/${f}" || warn "failed: $f"
    done <<< "$files"
  fi
  local gguf; gguf=$(find_gguf "$dir")
  [ -n "$gguf" ] || die "no .gguf found in $dir after the download"
  ok "$(basename "$gguf") · $(du -h "$gguf" | cut -f1)"
}

model_port_for() {
  case "$1" in
    main) echo "$MODEL_PORT" ;;
    small) echo $(( MODEL_PORT + 1 )) ;;
    heavy) echo $(( MODEL_PORT + 2 )) ;;
    vision) echo $(( MODEL_PORT + 3 )) ;;
  esac
}
model_url_for() { echo "http://${MODEL_HOST}:$(model_port_for "$1")/v1"; }

models_serve() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: observer.sh models serve <model> [--port 8080] [--ctx 8192]"
  local dir gguf mmproj name vram_gb ram_gb gpu launcher
  dir=$(model_dir "$key"); gguf=$(find_gguf "$dir"); name=$(model_name "$key")
  read -r ram_gb vram_gb gpu <<< "$(detect_hw)"
  local ngl=0; [ "${vram_gb:-0}" -ge 8 ] && ngl=99

  launcher=""
  have llama-server && launcher="llama-server"
  if [ -z "$launcher" ] && have llama; then launcher="llama serve"; fi
  [ -n "$launcher" ] || die "llama-server not installed — bash observer.sh models install"

  local args=(--host "$MODEL_HOST" --port "$MODEL_PORT" --jinja -c "$MODEL_CTX" -ngl "$ngl" --alias "$name")
  if [ -n "$gguf" ]; then
    args+=(-m "$gguf")
    mmproj=$(find_mmproj "$dir")
    [ -n "$mmproj" ] && args+=(--mmproj "$mmproj")
  else
    info "not downloaded yet — llama.cpp will fetch ${name} on first run"
    args+=(-hf "$name")
  fi
  say "Serving $( [ -n "$gguf" ] && basename "$gguf" || echo "$name" )"
  info "endpoint http://${MODEL_HOST}:${MODEL_PORT}/v1 · ctx ${MODEL_CTX} · gpu layers ${ngl}"
  [ "$ngl" = "0" ] && info "no GPU → CPU inference (fine for 0.8B–12B, slow for 27B)"
  exec $launcher "${args[@]}"
}

env_set() {
  local file="$1" k="$2" v="$3"
  [ -f "$file" ] || touch "$file"
  if grep -qE "^${k}=" "$file"; then
    awk -v k="$k" -v v="$v" 'BEGIN{d=0} $0 ~ "^"k"=" {print k"="v; d=1; next} {print} END{if(!d) print k"="v}' \
      "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$k" "$v" >> "$file"
  fi
}

models_wire() {
  local key="${1:-}" small="" heavy="" vision="" dir env
  [ -n "$key" ] || die "usage: observer.sh models wire <model> [--small k] [--heavy k] [--vision k]"
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --small)  small="${2:-}"; shift 2 ;;
      --heavy)  heavy="${2:-}"; shift 2 ;;
      --vision) vision="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done

  local name; name=$(model_name "$key")
  if dir=$(find_install ""); then env="$dir/.env"; else env="$(pwd)/.env"; fi
  [ -f "$env" ] || { [ -f "$(dirname "$env")/.env.example" ] && cp "$(dirname "$env")/.env.example" "$env" || touch "$env"; }

  say "Wiring the agent → local llama.cpp"
  env_set "$env" AI_PROVIDER local
  env_set "$env" ROUTER_PREFER local
  env_set "$env" LOCAL_API_URL "$(model_url_for main)"
  env_set "$env" LOCAL_MODEL "$name"
  env_set "$env" LOCAL_MODEL_SMALL "";  env_set "$env" LOCAL_API_URL_SMALL ""
  env_set "$env" LOCAL_MODEL_HEAVY "";  env_set "$env" LOCAL_API_URL_HEAVY ""
  env_set "$env" LOCAL_MODEL_VISION ""; env_set "$env" LOCAL_API_URL_VISION ""
  [ -n "$small" ] && [ "$small" != "$key" ] && {
    env_set "$env" LOCAL_MODEL_SMALL "$(model_name "$small")"
    env_set "$env" LOCAL_API_URL_SMALL "$(model_url_for small)"
  }
  [ -n "$heavy" ] && [ "$heavy" != "$key" ] && {
    env_set "$env" LOCAL_MODEL_HEAVY "$(model_name "$heavy")"
    env_set "$env" LOCAL_API_URL_HEAVY "$(model_url_for heavy)"
  }
  if [ -n "$vision" ]; then
    env_set "$env" LOCAL_MODEL_VISION "$(model_name "$vision")"
    if   [ "$vision" = "$key" ];   then env_set "$env" LOCAL_API_URL_VISION "$(model_url_for main)"
    elif [ "$vision" = "$small" ]; then env_set "$env" LOCAL_API_URL_VISION "$(model_url_for small)"
    else env_set "$env" LOCAL_API_URL_VISION "$(model_url_for vision)"; fi
  fi
  ok "wrote AI_PROVIDER=local + LOCAL_* into $env"
  info "main $(model_url_for main)${small:+ · small $(model_url_for small)}${heavy:+ · heavy $(model_url_for heavy)}${vision:+ · vision $(model_url_for vision)}"
  if dir=$(find_install ""); then restart_agent "$dir"; else info "restart the agent to pick it up"; fi
  info "WhatsApp pe: /brains"
}

write_model_unit() {
  local slot="$1" key="$2" port="$3" dir gguf launcher unit svc
  have systemctl || return 0
  dir=$(model_dir "$key"); gguf=$(find_gguf "$dir")
  launcher=""
  have llama-server && launcher="$(command -v llama-server)"
  [ -z "$launcher" ] && have llama && launcher="$(command -v llama)"
  [ -n "$launcher" ] && [ -n "$gguf" ] || { warn "skipping ${slot} service (llama-server or GGUF missing)"; return 0; }
  svc="$MODEL_SERVICE"; [ "$slot" != "main" ] && svc="${MODEL_SERVICE}-${slot}"
  unit="$HOME/.config/systemd/user/${svc}.service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$unit" <<EOF
[Unit]
Description=Observer local model (${slot}: ${key})
After=network.target

[Service]
Type=simple
ExecStart=${launcher} -m "${gguf}" --host ${MODEL_HOST} --port ${port} --jinja -c ${MODEL_CTX} -ngl 99 --alias $(model_name "$key")
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload || true
  systemctl --user enable --now "$svc" >/dev/null 2>&1 \
    && ok "service ${svc} → port ${port}" \
    || warn "could not start ${svc} (run: bash observer.sh models serve ${key} --port ${port})"
}

models_setup() {
  local key="${1:-}" small="" heavy="" vision=""
  [ -n "$key" ] || die "usage: observer.sh models setup <model> [--small k] [--heavy k] [--vision k]"
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --small)  small="${2:-}"; shift 2 ;;
      --heavy)  heavy="${2:-}"; shift 2 ;;
      --vision) vision="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done

  install_model_tools
  models_download "$key"
  write_model_unit main "$key" "$MODEL_PORT"
  if [ -n "$small" ] && [ "$small" != "$key" ]; then
    models_download "$small"; write_model_unit small "$small" "$(model_port_for small)"
  fi
  if [ -n "$heavy" ] && [ "$heavy" != "$key" ]; then
    models_download "$heavy"; write_model_unit heavy "$heavy" "$(model_port_for heavy)"
  fi
  if [ -n "$vision" ] && [ "$vision" != "$key" ] && [ "$vision" != "$small" ]; then
    models_download "$vision"; write_model_unit vision "$vision" "$(model_port_for vision)"
  fi
  models_wire "$key" ${small:+--small "$small"} ${heavy:+--heavy "$heavy"} ${vision:+--vision "$vision"}

  sleep 2
  if curl -fsS "$(model_url_for main)/models" >/dev/null 2>&1; then
    ok "local model answering on $(model_url_for main)"
  else
    info "start it: bash observer.sh models serve ${key}"
    hint "or check: journalctl --user -u ${MODEL_SERVICE} -n 30"
  fi
}

models_status() {
  say "Local models"
  info "hf CLI       : $(hf_cli || echo 'not installed')"
  info "llama-server : $(command -v llama-server || command -v llama || echo 'not installed')"
  info "models folder: $MODELS_DIR $( [ -d "$MODELS_DIR" ] && du -sh "$MODELS_DIR" 2>/dev/null | cut -f1 | sed 's/^/· /' )"
  local ram_gb vram_gb gpu
  read -r ram_gb vram_gb gpu <<< "$(detect_hw)"
  info "hardware     : ${ram_gb} GB RAM · ${gpu}"
  if curl -fsS "http://${MODEL_HOST}:${MODEL_PORT}/v1/models" >/dev/null 2>&1; then
    ok "server on http://${MODEL_HOST}:${MODEL_PORT}/v1"
    curl -fsS "http://${MODEL_HOST}:${MODEL_PORT}/v1/models" | tr ',' '\n' | grep '"id"' | head -3 | sed 's/^/      /'
  else
    bad "nothing on http://${MODEL_HOST}:${MODEL_PORT}/v1"
  fi
  local dir
  if dir=$(find_install ""); then
    grep -E '^(AI_PROVIDER|LOCAL_|ROUTER_PREFER)' "$dir/.env" 2>/dev/null | sed 's/^/      /' || true
  fi
}

models_ollama() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: observer.sh models ollama <model>"
  have ollama || die "Ollama not installed — sudo dnf install ollama && sudo systemctl enable --now ollama"
  local name; name=$(model_name "$key")
  say "Pulling $(name) through Ollama"
  ollama pull "hf.co/${name}" || die "pull failed — check the name: hf.co/${name}"
  ok "then set in .env:  AI_PROVIDER=ollama   OLLAMA_MODEL=hf.co/${name}"
}

cmd_models() {
  local sub="list"
  if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then sub="$1"; shift; fi
  local key=""
  if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then key="$1"; shift; fi
  local rest=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --quant) QUANT="${2:-Q4_K_M}"; shift 2 ;;
      --port)  MODEL_PORT="${2:-8080}"; PORT_SET=1; shift 2 ;;
      --ctx)   MODEL_CTX="${2:-8192}"; shift 2 ;;
      --host)  MODEL_HOST="${2:-127.0.0.1}"; shift 2 ;;
      --dir)   MODELS_DIR="${2:-}"; shift 2 ;;
      *) rest+=("$1"); shift ;;
    esac
  done

  case "$sub" in
    list|ls)            models_list ;;
    recommend|rec)      models_recommend ;;
    detect|hw)          local r v g; read -r r v g <<< "$(detect_hw)"; say "This machine"; info "RAM: $r GB"; info "GPU: $g"; info "model budget: $(model_budget "$r" "$v") GB"; info "folder: $MODELS_DIR" ;;
    commands|cmd|print) models_commands "$key" ;;
    download|dl)        models_download "$key" ;;
    serve|run|start)    models_serve "$key" ;;
    wire|env)           models_wire "$key" "${rest[@]}" ;;
    setup|install-model|all) models_setup "$key" "${rest[@]}" ;;
    install|tools)      install_model_tools ;;
    ollama)             models_ollama "$key" ;;
    status)             models_status ;;
    -h|--help|help)     models_list ;;
    *) die "models: unknown subcommand '$sub' (list|recommend|detect|status|commands|download|serve|wire|setup|ollama)" ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════════════
#  DOCTOR
# ═══════════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════════
#  API KEYS — Groq / OpenRouter / Gemini (all optional, all free-tier)
# ═══════════════════════════════════════════════════════════════════════════════

key_var() {
  case "$1" in
    groq)       echo GROQ_API_KEY ;;
    openrouter) echo OPENROUTER_API_KEY ;;
    gemini)     echo GEMINI_API_KEY ;;
    *) return 1 ;;
  esac
}

key_slug() {
  case "$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')" in
    groq|groq.com|api.groq.com)                 echo groq ;;
    openrouter|or|openrouter.ai|open-router)    echo openrouter ;;
    gemini|google|google-ai|aistudio|ai-studio) echo gemini ;;
    *) return 1 ;;
  esac
}

key_label() {
  case "$1" in
    groq) echo 'fast free tier · 1,000 req/day · also free voice notes' ;;
    openrouter) echo 'wide free model menu · 50 req/day, 1,000 after a $10 top-up' ;;
    gemini) echo 'free tier · vision + long context' ;;
  esac
}

key_url() {
  case "$1" in
    groq) echo 'https://console.groq.com/keys' ;;
    openrouter) echo 'https://openrouter.ai/keys' ;;
    gemini) echo 'https://aistudio.google.com/apikey' ;;
  esac
}

key_mask() {
  local k="${1:-}"
  [ -n "$k" ] || { printf '(not set)'; return 0; }
  [ ${#k} -gt 10 ] || { printf '****'; return 0; }
  printf '%s…%s' "${k:0:4}" "${k: -4}"
}

env_read() {  # env_read FILE KEY
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1
}

key_check() {  # key_check provider key → warns, never blocks saving
  local provider="$1" key="$2" code=""
  local groq_url="${GROQ_CHECK_URL:-https://api.groq.com/openai/v1/models}"
  local or_url="${OPENROUTER_CHECK_URL:-https://openrouter.ai/api/v1/key}"
  local gem_url="${GEMINI_CHECK_URL:-https://generativelanguage.googleapis.com/v1beta/models}"
  case "$provider" in
    groq)       code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
                       -H "Authorization: Bearer ${key}" "$groq_url" 2>/dev/null || true) ;;
    openrouter) code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
                       -H "Authorization: Bearer ${key}" "$or_url" 2>/dev/null || true) ;;
    gemini)     code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
                       "${gem_url}?key=${key}" 2>/dev/null || true) ;;
  esac
  [ -n "$code" ] || code=000
  case "$code" in
    200)     ok "$provider key verified" ;;
    401|403) bad "$provider rejected this key (HTTP $code) — copy it again from $(key_url "$provider")"; return 1 ;;
    000|'')  warn "could not reach $provider to verify (offline?) — key saved anyway" ;;
    *)       warn "$provider answered HTTP $code — key saved; check the console if it still fails" ;;
  esac
  return 0
}

# Groq retired Llama 3.1 8B / 3.3 70B from the free tier on 16 Aug 2026
# (enterprise-only now). An old .env created before that still pins those IDs,
# and every call would 404 — so migrate the two Groq model keys on update.
migrate_groq_env() {
  local env="$1" var old new
  [ -f "$env" ] || return 0
  for var in GROQ_MODEL GROQ_MODEL_SMALL; do
    old=$(env_read "$env" "$var")
    new='openai/gpt-oss-120b'
    [ "$var" = "GROQ_MODEL_SMALL" ] && new='openai/gpt-oss-20b'
    case "$old" in
      *llama-3.3*|*llama-3.1*)
        env_set "$env" "$var" "$new"
        warn "$var=$old → $new  (Groq ne Llama free tier se 16 Aug 2026 ko hata diya)"
        ;;
    esac
  done
  return 0
}

keys_list() {  # keys_list ENV [only-provider]
  local env="$1" only="${2:-}" provider var val
  say "API keys"
  for provider in groq openrouter gemini; do
    [ -z "$only" ] || [ "$only" = "$provider" ] || continue
    var=$(key_var "$provider")
    val=$(env_read "$env" "$var")
    printf '   %-11s : %s\n' "$provider" "$(key_mask "$val")"
    printf '   %-11s   %s\n' "" "$(key_label "$provider")"
  done
  info "file : $env$( [ -f "$env" ] || printf ' (not created yet)' )"
  if [ -z "$(env_read "$env" GROQ_API_KEY)" ]; then
    hint "Groq also transcribes voice notes for free — one key, two features"
  fi
  cat <<EOF

   Add / replace : bash observer.sh keys groq gsk_xxxxxxxx
                   bash observer.sh keys openrouter sk-or-v1-xxxx
                   bash observer.sh keys gemini AIza...
   Test saved    : bash observer.sh keys --test
   Remove        : bash observer.sh keys --remove groq
   Get a key     : Groq        $(key_url groq)
                   OpenRouter  $(key_url openrouter)
                   Gemini      $(key_url gemini)
   Which one?    AI-KEYS.md (limits, models, vision, voice)
EOF
}

keys_test() {  # keys_test ENV
  local env="$1" provider var val found=0
  say "Testing saved keys"
  for provider in groq openrouter gemini; do
    var=$(key_var "$provider"); val=$(env_read "$env" "$var")
    if [ -z "$val" ]; then
      info "$provider: not set"
      continue
    fi
    found=1
    key_check "$provider" "$val" || true
  done
  [ "$found" -eq 1 ] || info "no cloud keys saved — everything can run local instead"
}

cmd_keys() {
  local dir; dir=$(find_install "") || die "no install found — bash observer.sh install"
  local env="$dir/.env"

  # Old Groq Llama IDs would 404 — fix them before showing/testing anything.
  migrate_groq_env "$env"

  case "${1:-}" in
    ""|list|status) keys_list "$env"; return 0 ;;
    --test|test)    keys_test "$env"; return 0 ;;
    --remove|remove|rm)
      local victim; victim=$(key_slug "${2:-}") || die "usage: observer.sh keys --remove groq|openrouter|gemini"
      [ -f "$env" ] || die "no .env yet at $env"
      env_set "$env" "$(key_var "$victim")" ""
      ok "$(key_var "$victim") cleared in $env"
      restart_agent "$dir"
      return 0 ;;
    -*) die "keys: unknown option $1 — try: bash observer.sh keys" ;;
  esac

  local provider; provider=$(key_slug "$1") || die "keys: provider must be groq, openrouter or gemini"
  local key="${2:-}"
  if [ -z "$key" ]; then
    keys_list "$env" "$provider"
    return 0
  fi

  say "Saving $provider key"
  if [ ! -f "$env" ]; then
    if [ -f "$dir/.env.example" ]; then cp "$dir/.env.example" "$env"; else touch "$env"; fi
    info "created $env from .env.example"
  fi
  env_set "$env" "$(key_var "$provider")" "$key"
  ok "$(key_var "$provider") written to $env (masked: $(key_mask "$key"))"
  key_check "$provider" "$key" || true
  restart_agent "$dir"
  info "WhatsApp pe /model bhejo — key dikhegi"
  info "Agar service nahi hai: cd \"$dir\" && ./start.sh"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  SELF-TEST — is everything actually working?
# ═══════════════════════════════════════════════════════════════════════════════

# The routing preview + live ping need the real modules, so they run in Node
# inside the install (same config/.env the agent uses). Output is tab-separated
# so this shell script can label it.
write_verify_js() {  # write_verify_js FILE
  cat > "$1" <<'NODE'
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const live = process.argv[3] === '1';
const silent = { info() {}, warn() {}, error() {} };

const load = (rel) => import(pathToFileURL(`${root}/${rel}`).href);

let config;
try {
  const { loadConfig } = await load('src/config.js');
  config = loadConfig();
} catch (err) {
  const msg = String(err?.message ?? err).split('\n').filter(Boolean).join(' / ');
  console.log(`CONFIG_ERROR\t${msg}`);
  process.exit(3);
}

const { buildCatalog, createModelRouter } = await load('src/router.js');
const router = createModelRouter({ config, log: silent });

const catalog = buildCatalog(config);
const perProvider = catalog.reduce((acc, m) => {
  acc[m.provider] = (acc[m.provider] ?? 0) + 1;
  return acc;
}, {});
const brains = Object.entries(perProvider).map(([p, n]) => `${p}×${n}`).join(', ') || 'none';
console.log(`BRAINS\t${brains}`);
console.log(`MODE\t${config.aiProvider}`);
const sees = catalog.filter((m) => m.vision).map((m) => `${m.provider}:${m.model}`);
console.log(`VISION\t${sees.join(', ') || 'none'}`);

const samples = [
  ['tiny', 'hi', {}],
  ['light', 'remind me kal 5 baje', {}],
  ['standard', 'downloads folder me jo pdf hain unhe ek naye folder me daal do', {}],
  ['heavy', 'write a python script that reads a csv and plots a chart, step by step', {}],
  ['vision', 'photo dekho aur batao kya hai', { needsVision: true }],
];

for (const [tier, text, extra] of samples) {
  const plan = router.plan({ text, ...extra });
  const first = plan.candidates[0];
  console.log(`ROUTE\t${tier}\t${first ? `${first.label}` : 'none configured'}\t${first ? first.provider : '-'}`);
}

if (live) {
  const started = Date.now();
  const answer = await completeOne(config);
  if (!answer) {
    console.log('LIVE_FAIL\tno brain answered');
    process.exit(4);
  }
  const text = String(answer.text ?? '').replace(/\s+/g, ' ').slice(0, 70);
  console.log(`LIVE\t${answer.provider}\t${answer.model}\t${Date.now() - started}ms\t${text}`);
}

async function completeOne(cfg) {
  const { complete } = await load('src/ai.js');
  try {
    return await complete(cfg, 'Reply with exactly one word: OK', silent);
  } catch {
    return null;
  }
}
NODE
}

cmd_test() {
  local dir live=0 runtests=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --live)         live=1; shift ;;
      --fast|--no-tests) runtests=0; shift ;;
      -h|--help)      info "usage: observer.sh test [--live] [--fast]"; return 0 ;;
      *) die "test: unknown option $1 (try --help)" ;;
    esac
  done
  dir=$(find_install "") || die "no install found — bash observer.sh install"
  local warnings=0

  say "Self-test — $dir"

  # ── 1. code + runtime ────────────────────────────────────────────────────
  local v remote
  v=$(local_version "$dir"); remote=$(remote_version || true)
  ok "version ${v:-?}${remote:+ (remote ${remote})}"
  if have node; then
    local major; major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "${major:-0}" -ge 20 ]; then ok "Node $(node -v)"; else
      bad "Node $(node -v) — 20+ chahiye (sudo dnf module install nodejs:22)"; warnings=$((warnings+1))
    fi
  else
    bad "Node not installed"; warnings=$((warnings+1))
  fi
  if [ -d "$dir/node_modules" ]; then ok "dependencies installed"; else
    warn "node_modules missing"; hint "cd \"$dir\" && npm install"; warnings=$((warnings+1))
  fi

  # ── 2. .env + keys ───────────────────────────────────────────────────────
  if [ -f "$dir/.env" ]; then
    ok ".env present"
    local provider var val keys=0
    for provider in groq openrouter gemini; do
      var=$(key_var "$provider"); val=$(env_read "$dir/.env" "$var")
      if [ -n "$val" ]; then keys=$((keys+1)); info "key: ${provider} $(key_mask "$val")"; fi
    done
    [ "$keys" -eq 0 ] && info "no cloud keys — local + built-in only (that is a valid setup)"
  else
    warn "no .env"; hint "cp \"$dir/.env.example\" \"$dir/.env\"  (or: bash observer.sh install --force)"; warnings=$((warnings+1))
  fi

  # ── 3. brains: local server / Ollama ─────────────────────────────────────
  local localurl
  localurl=$(env_read "$dir/.env" LOCAL_API_URL)
  if [ -n "$localurl" ] && curl -fsS --max-time 3 "${localurl%/}/models" >/dev/null 2>&1; then
    ok "local model server up — $localurl"
  elif [ -n "$localurl" ]; then
    warn "local model server not answering — $localurl"
    hint "bash observer.sh models serve <model>   ·   systemctl --user start ${MODEL_SERVICE}"
    warnings=$((warnings+1))
  else
    info "no LOCAL_API_URL (local model not wired — cloud key or Ollama will be used)"
  fi
  local ollama_up=0
  if curl -fsS --max-time 2 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    ok "Ollama up"; ollama_up=1
  fi

  # ── 4. service ───────────────────────────────────────────────────────────
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    if systemctl --user is-active "$SERVICE" >/dev/null 2>&1; then
      ok "service ${SERVICE} running"
    elif [ -f "$HOME/.config/systemd/user/${SERVICE}.service" ]; then
      warn "service installed but NOT running"; hint "bash observer.sh service restart"; warnings=$((warnings+1))
    else
      info "no systemd service — fine if you start it with ./start.sh"
    fi
  fi

  # ── 5. unit tests ────────────────────────────────────────────────────────
  if [ "$runtests" -eq 1 ]; then
    local out; out=$(mktemp)
    # A dead session bus keeps the tests hermetic: on a real desktop the
    # xdg-desktop-portal would answer (and pop a screenshot dialog) where the
    # suite expects a normal "no portal here" failure.
    if ( cd "$dir" && DBUS_SESSION_BUS_ADDRESS="unix:path=${TMPDIR:-/tmp}/observer-test-no-bus" \
         npm test >"$out" 2>&1 ); then
      ok "unit tests: $(grep -E '^# pass' "$out" | awk '{print $3}') pass"
    else
      local failed passed
      failed=$(grep -c '^not ok' "$out" 2>/dev/null || echo '?')
      passed=$(grep -E '^# pass' "$out" | awk '{print $3}')
      bad "unit tests failed — ${failed} fail, ${passed:-?} pass"
      # Show every failing test with its assertion, not just the tail.
      awk '/^not ok/ {show=1; print "      ✗ " substr($0, index($0," - ")+3); next}
           show && /^  \.\.\.$/ {show=0; print ""; next}
           show {print "      " $0}' "$out" | head -70
      local copy="${XDG_CACHE_HOME:-$HOME/.cache}/observer-agent/last-test.log"
      if mkdir -p "$(dirname "$copy")" 2>/dev/null && cp "$out" "$copy" 2>/dev/null; then
        hint "poora log: $copy"
      fi
      warnings=$((warnings+1))
    fi
    rm -f "$out"
  fi

  # ── 6. routing preview (real router, real .env) ──────────────────────────
  local tmp; tmp=$(mktemp -d); trap "rm -rf '$tmp'" EXIT
  write_verify_js "$tmp/verify.mjs"
  local rc=0
  # exit 3 = bad config (shown below), 4 = routing fine but the live call failed
  # (also shown below) — anything else is the preview itself breaking.
  node "$tmp/verify.mjs" "$dir" "$live" > "$tmp/out" 2>&1 || rc=$?
  if [ "$rc" -eq 3 ]; then
    bad "config problem: $(sed -n 's/^CONFIG_ERROR	//p' "$tmp/out")"
    warnings=$((warnings+1))
  elif [ "$rc" -ne 0 ] && [ "$rc" -ne 4 ]; then
    warn "routing preview could not run (exit $rc)"
    tail -5 "$tmp/out" | sed 's/^/      /'
    warnings=$((warnings+1))
  fi

  if [ -s "$tmp/out" ]; then
    say "Brains + routing"
    if [ "$ollama_up" -eq 0 ] && [ -z "$localurl" ]; then
      info "(Ollama/local model se answer nahi aayega — router aage wale brain pe chala jayega)"
    fi
    local kind a b c d
    while IFS=$'\t' read -r kind a b c d; do
      case "$kind" in
        BRAINS) info "configured: $a" ;;
        MODE)   info "AI_PROVIDER=$a" ;;
        VISION) info "vision: $a" ;;
        ROUTE)  printf '   %-9s → %s\n' "$a" "${b:-none}" ;;
        LIVE)   ok "live answer: $a · $c"; info "reply: \"$d\"" ;;
        LIVE_FAIL) bad "live test: $a"; warnings=$((warnings+1)) ;;
      esac
    done < "$tmp/out"
  fi

  if [ "$live" -eq 0 ]; then
    info "asli jawab bhi test karna hai: bash observer.sh test --live  (ek chhota API call)"
  fi

  # ── 7. verdict ───────────────────────────────────────────────────────────
  if [ "$warnings" -eq 0 ]; then
    ok "sab theek — WhatsApp pe /model, /brains, /doctor bhejo"
  else
    warn "$warnings cheez dekhni hai (upar wale hints follow karo)"
    hint "poora fix-list: bash observer.sh doctor"
  fi
  return 0
}

cmd_doctor() {
  local dir; dir=$(find_install "") || dir="$DEFAULT_DIR"
  local problems=0 warnings=0

  say "Doctor — ${dir}"
  if [ -f "$dir/package.json" ]; then
    ok "install found · version $(local_version "$dir")"
  else
    bad "no install found at $dir"
    hint "install: bash observer.sh install"
    return 1
  fi

  # Node + deps
  if have node; then
    local major; major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -ge 20 ]; then ok "Node $(node -v)"; else bad "Node $(node -v) — need 20+"; hint "sudo dnf module install nodejs:22"; problems=$((problems+1)); fi
  else
    bad "Node.js not installed"; hint "sudo dnf install nodejs npm"; problems=$((problems+1))
  fi
  if [ -d "$dir/node_modules" ]; then ok "dependencies installed"
  else bad "node_modules missing"; hint "cd \"$dir\" && npm install"; problems=$((problems+1)); fi
  if [ -f "$dir/.env" ]; then ok ".env present"
  else warn "no .env"; hint "cp \"$dir/.env.example\" \"$dir/.env\""; warnings=$((warnings+1)); fi

  # Service
  if service_enabled; then
    if service_active; then ok "service ${SERVICE} running"
    else warn "service installed but not running"; hint "systemctl --user restart ${SERVICE}"; warnings=$((warnings+1)); fi
  else
    info "no systemd service (fine if you use ./start.sh)"
    hint "install it: bash observer.sh service install"
  fi

  # WhatsApp login
  if [ -d "$dir/auth_info" ] && [ -n "$(ls -A "$dir/auth_info" 2>/dev/null)" ]; then
    ok "WhatsApp login present (no new QR needed)"
  else
    info "WhatsApp not linked yet — a QR will appear on first start"
  fi

  # AI brains
  local provider=""
  [ -f "$dir/.env" ] && provider=$(grep -E '^AI_PROVIDER=' "$dir/.env" | tail -1 | cut -d= -f2-)
  provider="${provider:-auto}"
  info "AI_PROVIDER=${provider}"
  local local_url=""
  [ -f "$dir/.env" ] && local_url=$(grep -E '^LOCAL_API_URL=' "$dir/.env" | tail -1 | cut -d= -f2-)
  if [ -n "$local_url" ]; then
    if curl -fsS --max-time 3 "${local_url%/}/models" >/dev/null 2>&1; then
      ok "local model server up — $local_url"
    else
      bad "local model server not reachable — $local_url"
      hint "bash observer.sh models serve <model>   ·   systemctl --user start ${MODEL_SERVICE}"
      problems=$((problems+1))
    fi
  elif [ "$provider" = "local" ]; then
    bad "AI_PROVIDER=local but LOCAL_API_URL is empty"
    hint "bash observer.sh models setup best"
    problems=$((problems+1))
  else
    if curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      ok "Ollama up on :11434"
    else
      info "no local model server / Ollama (cloud keys or built-in commands only)"
      hint "100% local: bash observer.sh models recommend"
    fi
  fi

  # Desktop session + input tools
  local session="${XDG_SESSION_TYPE:-unknown}"
  if [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]; then
    ok "desktop session: ${session}"
  else
    warn "no graphical session in this shell — screenshots/typing need one"
    hint "run it from the desktop, or: systemctl --user restart ${SERVICE}"
    warnings=$((warnings+1))
  fi
  if have ydotool || have xdotool || have wtype; then ok "keyboard/mouse tool present"
  else warn "no typing/clicking tool"; hint "bash observer.sh fix"; warnings=$((warnings+1)); fi
  if have tesseract; then ok "OCR (tesseract) present"
  else info "OCR missing — screen reading won't work"; hint "sudo dnf install tesseract"; fi

  # Disk
  local free; free=$(df -h "$HOME" | awk 'NR==2 {print $4}')
  info "disk free in $HOME: ${free}"

  say "Summary"
  if [ "$problems" -eq 0 ] && [ "$warnings" -eq 0 ]; then
    ok "sab theek hai"
  else
    [ "$problems" -gt 0 ] && bad "${problems} problem(s) — fixes printed above"
    [ "$warnings" -gt 0 ] && warn "${warnings} warning(s)"
  fi
  info "WhatsApp pe /doctor bhejo — wahan bhi poora report aata hai"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  SMALL COMMANDS (delegate to the bundled helpers)
# ═══════════════════════════════════════════════════════════════════════════════

cmd_service() {
  local sub="${1:-install}"
  local dir; dir=$(find_install "") || die "no install found — bash observer.sh install"

  # systemd --user needs a real user session (not a plain SSH/container shell)
  case "$sub" in
    restart|status|logs|enable|disable)
      if ! systemctl --user show-environment >/dev/null 2>&1; then
        warn "systemd --user is not reachable from this shell (SSH/container?)"
        info "run it from your desktop session:  systemctl --user $sub $SERVICE"
        info "check the service:                 bash observer.sh doctor"
        exit 1
      fi
      if [ ! -f "$HOME/.config/systemd/user/${SERVICE}.service" ] && [ "$sub" != "logs" ]; then
        warn "no ${SERVICE} unit yet"
        info "install it first:  bash observer.sh service install"
        exit 1
      fi
      ;;
  esac

  case "$sub" in
    install)   ( cd "$dir" && ./scripts/install-systemd.sh ) ;;
    uninstall) ( cd "$dir" && ./scripts/install-systemd.sh --uninstall ) ;;
    restart)   systemctl --user restart "$SERVICE" && ok "restarted" ;;
    status)    systemctl --user status "$SERVICE" --no-pager || true ;;
    logs)      journalctl --user -u "$SERVICE" -f ;;
    enable)    systemctl --user enable --now "$SERVICE" && ok "enabled" ;;
    disable)   systemctl --user disable --now "$SERVICE" && ok "disabled" ;;
    *) die "service: install|uninstall|restart|status|logs|enable|disable" ;;
  esac
}

cmd_start() {
  local dir; dir=$(find_install "") || die "no install found — bash observer.sh install"
  cd "$dir"
  exec ./start.sh
}

cmd_relink() {
  local dir; dir=$(find_install "") || die "no install found"
  exec "$dir/scripts/relink-whatsapp.sh"
}

cmd_remote() {
  local dir; dir=$(find_install "") || die "no install found"
  exec "$dir/scripts/setup-remote.sh"
}

cmd_fix() {
  local dir; dir=$(find_install "") || die "no install found"
  exec "$dir/scripts/fix-desktop.sh"
}

cmd_version() {
  local dir; dir=$(find_install "") || dir="$DEFAULT_DIR"
  say "Version"
  info "branch : ${BRANCH}"
  info "local  : $(local_version "$dir" || echo 'not installed')"
  info "remote : $(remote_version || echo 'could not reach GitHub')"
}

cmd_help() {
  cat <<EOF
${B}Observer Agent — one script, everything${R}

  bash observer.sh <command> [options]

${B}Setup${R}
  install [--dir PATH] [--force] [--service] [--ollama] [--power] [--phone] [--remote]
                              first-time install (curl-only, no git)
  install --model best        install + set up a local Hugging Face model
  install --model auto        install + let it pick a model for this machine
  update [--dir PATH] [--check]
                              update the code (keeps .env, WhatsApp login, data)
  keys                        which API keys are set (masked) + where to get them
  keys groq <gsk_...>         add/replace a free Groq key (also: openrouter, gemini)
  keys --test                 test every saved key
  keys --remove groq          remove a key
  version                     local vs remote version

${B}100% local AI (Hugging Face GGUF, llama.cpp)${R}
  models list                 models + RAM needed
  models recommend            what fits this machine
  models commands <model>     exact hf download + llama-server commands
  models setup <model>        download + serve + wire into .env  (one shot)
  models setup best --small tiny --vision balanced
  models download <model>     only download the GGUF
  models serve <model>        run llama-server
  models wire <model>         only write .env
  models status               what is installed/running
  models ollama <model>       same GGUF through Ollama
      options: --quant Q4_K_M --port 8080 --ctx 8192 --dir ~/models

${B}Run / repair${R}
  start                       run in the foreground
  service install|restart|status|logs|enable|disable|uninstall
  test [--live]               self-test: keys, brains, routing, unit tests
  doctor                      what is broken + the exact fix
  fix                         screenshots / keyboard / mouse (Fedora)
  relink                      fresh WhatsApp QR
  remote                      Tailscale access to the phone app from anywhere

${B}Examples${R}
  bash observer.sh install --service --power --phone
  bash observer.sh keys groq gsk_xxxxxxxx        # free cloud brain (optional)
  bash observer.sh models recommend && bash observer.sh models setup best
  bash observer.sh test --live                    # sab kuch verify
  bash observer.sh update --check

No git anywhere: install/update download a branch tarball with plain curl.
EOF
}

# ═══════════════════════════════════════════════════════════════════════════════

main() {
  local cmd="${1:-help}"; shift || true
  case "$cmd" in
    install|setup)        cmd_install "$@" ;;
    update|upgrade)       cmd_update "$@" ;;
    keys|key|api-key|api-keys) cmd_keys "$@" ;;
    models|model|local)   cmd_models "$@" ;;
    test|selftest|verify) cmd_test "$@" ;;
    doctor|diag|check)    cmd_doctor "$@" ;;
    service|systemd)      cmd_service "$@" ;;
    start|run)            cmd_start "$@" ;;
    relink|qr)            cmd_relink "$@" ;;
    remote|tailscale)     cmd_remote "$@" ;;
    fix|desktop)          cmd_fix "$@" ;;
    version|ver)          cmd_version "$@" ;;
    help|-h|--help|"")    cmd_help ;;
    *) bad "unknown command: $cmd"; echo; cmd_help; exit 2 ;;
  esac
}

main "$@"
