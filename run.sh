#!/usr/bin/env bash
# Observer Core — the single entry point: install dependencies and launch on Fedora.
#
#   ./run.sh               set up (idempotent) and launch the GUI
#   ./run.sh --help        every flag, exit codes, environment overrides
#
# Exit codes: 0 ok · 1 generic failure · 2 missing system dependency blocks launch
#             3 unsupported Python (< 3.12, or < $OBSERVER_CORE_MIN_PY)
set -euo pipefail

APP_NAME="Observer Core"
APP_ID="observer-core"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${OBSERVER_CORE_VENV:-$ROOT_DIR/.venv}"
REQ_SYS="$ROOT_DIR/requirements-system-fedora.txt"
REQ_PY="$ROOT_DIR/requirements.txt"
STAMP_DIR="$VENV_DIR/.observer-core-stamps"
DNF_BIN="${DNF:-dnf}"
MIN_PY="${OBSERVER_CORE_MIN_PY:-3.12}"          # set to 3.11 only for testing on older hosts
APP_VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$ROOT_DIR/observer_core/__init__.py" 2>/dev/null || echo unknown)"

# Packages whose absence would make the GUI impossible to start (exit 2).
CRITICAL_PKGS="python3-devel gcc make pkgconf-pkg-config mesa-libEGL mesa-libGL libxkbcommon libxkbcommon-x11 libxcb-cursor0"

DO_SETUP=0; DO_REINSTALL=0; NO_SYS_DEPS=0; WITH_OLLAMA=0; SKIP_PIP=0
RUN_DOCTOR=0; RUN_DAEMON=0; RUN_DEV=0
EXIT_GENERIC=1; EXIT_MISSING_DEP=2; EXIT_PYTHON=3

# ---------- output helpers (colour only on a TTY, honours NO_COLOR) ----------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_INFO=$'\033[36m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""; C_DIM=""; C_OFF=""
fi
info(){ printf '%s[·]%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok(){   printf '%s[✓]%s %s\n' "$C_OK"   "$C_OFF" "$*"; }
warn(){ printf '%s[!]%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
err(){  printf '%s[✗]%s %s\n' "$C_ERR"  "$C_OFF" "$*" >&2; }
step(){ printf '\n%s== %s%s\n' "$C_DIM" "$*" "$C_OFF"; }

usage(){
  cat <<EOF
${APP_NAME} ${APP_VERSION} — local-first screen/camera/audio monitoring agents

Usage: ./run.sh [options]

  --setup            install dependencies only; do not launch
  --reinstall        recreate the virtualenv and reinstall all Python deps
  --no-system-deps   skip dnf (containers, rootless, CI)
  --with-ollama      install (curl | sh, explicit opt-in) and enable Ollama
  --skip-pip         only install system packages
  --doctor           run the environment report after setup, then exit
  --daemon           run headless (no GUI) instead of the window
  --dev              run from the source tree (editable install is always used)
  --version          print the version and exit
  -h, --help         show this help

Environment overrides:
  OBSERVER_CORE_VENV      virtualenv location (default: <repo>/.venv)
  DNF                     dnf binary to use (default: dnf)
  OBSERVER_CORE_MIN_PY    minimum Python major.minor (default: 3.12)

Exit codes: 0 ok · 1 failure · 2 missing system dependency · 3 Python too old
EOF
}

# ---------- argument parsing ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup) DO_SETUP=1;;
    --reinstall) DO_REINSTALL=1;;
    --no-system-deps) NO_SYS_DEPS=1;;
    --with-ollama) WITH_OLLAMA=1;;
    --skip-pip) SKIP_PIP=1;;
    --doctor) RUN_DOCTOR=1;;
    --daemon) RUN_DAEMON=1;;
    --dev) RUN_DEV=1;;
    --version) echo "${APP_NAME} ${APP_VERSION}"; exit 0;;
    -h|--help) usage; exit 0;;
    *) err "Unknown option: $1"; usage >&2; exit "$EXIT_GENERIC";;
  esac
  shift
done

# Friendly message on Ctrl+C during setup (the trap is cleared before exec'ing the app).
trap 'printf "\n%s[!]%s interrupted — re-run ./run.sh to continue where you left off\n" "$C_WARN" "$C_OFF" >&2; exit 130' INT

# ---------- 0. banner & environment ----------
OS_NAME="$( ( . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}" ) || echo Linux )"
OS_ID="$( ( . /etc/os-release 2>/dev/null && echo "${ID:-unknown}" ) || echo unknown )"
OS_LIKE="$( ( . /etc/os-release 2>/dev/null && echo "${ID_LIKE:-}" ) || echo '' )"
IS_FEDORA=0
if [[ "$OS_ID" == "fedora" || "$OS_LIKE" == *fedora* ]]; then IS_FEDORA=1; fi

SESSION="headless"
[[ -n "${WAYLAND_DISPLAY:-}" ]] && SESSION="wayland"
[[ -z "${WAYLAND_DISPLAY:-}" && -n "${DISPLAY:-}" ]] && SESSION="x11"

PY_BIN=""
for cand in python3.13 python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys; sys.exit(0 if sys.version_info >= tuple(int(x) for x in '$MIN_PY'.split('.')) else 1)" 2>/dev/null; then
    PY_BIN="$cand"; break
  fi
done

printf '\n%s%s %s%s\n' "$C_INFO" "$APP_NAME" "$APP_VERSION" "$C_OFF"
printf '    os: %s   session: %s   repo: %s\n' "$OS_NAME" "$SESSION" "$ROOT_DIR"
if [[ -n "$PY_BIN" ]]; then
  printf '    python: %s (%s)   venv: %s\n' "$($PY_BIN --version 2>&1)" "$PY_BIN" "$VENV_DIR"
else
  local_py="$(command -v python3 >/dev/null 2>&1 && python3 --version 2>&1 || echo 'none')"
  err "Python >= ${MIN_PY} not found (found: ${local_py})."
  err "Fedora:  sudo dnf install python3.13   — then re-run ./run.sh"
  exit "$EXIT_PYTHON"
fi

# Refuse to operate on anything that is not a plausible venv path.
case "$VENV_DIR" in
  ""|"/"|"$HOME"|"$ROOT_DIR") err "Refusing to use VENV_DIR='$VENV_DIR' (must be a dedicated directory)"; exit "$EXIT_GENERIC";;
esac

# ---------- helpers ----------
stamp_of(){ sha256sum "$@" 2>/dev/null | sha256sum | cut -d' ' -f1; }
stamp_ok(){ [[ -f "$STAMP_DIR/$1" && "$(cat "$STAMP_DIR/$1")" == "$2" ]]; }
stamp_write(){ mkdir -p "$STAMP_DIR"; printf '%s' "$2" > "$STAMP_DIR/$1"; }

read_sys_packages(){
  # One package per line; strip comments and blank lines. (Not `tr -d '#'`, which would
  # turn comment words into package names.)
  sed -e 's/#.*//' -e 's/[[:space:]]\+$//' -e '/^[[:space:]]*$/d' "$REQ_SYS"
}

# ---------- 1. system packages (Fedora / dnf) ----------
step "System packages"
SUDO=""
if [[ "$NO_SYS_DEPS" -eq 1 ]]; then
  info "Skipping system packages (--no-system-deps)."
elif [[ "$IS_FEDORA" -ne 1 ]]; then
  warn "Not Fedora ($OS_NAME): skipping dnf. Install the equivalents of requirements-system-fedora.txt yourself."
  warn "Debian/Ubuntu: tesseract-ocr ffmpeg libnotify-bin portaudio19-dev pulseaudio-utils pipewire-bin xdg-utils libxkbcommon-x11-0 …"
elif ! command -v "$DNF_BIN" >/dev/null 2>&1; then
  warn "dnf not found — skipping system packages."
else
  if [[ $EUID -eq 0 ]]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null || [[ -t 0 ]]; }; then
    SUDO="sudo"
  fi
  if [[ $EUID -ne 0 && -z "$SUDO" ]]; then
    warn "sudo is unavailable (no passwordless sudo and no terminal). System packages were NOT installed."
    warn "Install them manually:  sudo dnf install -y --needed $(read_sys_packages | tr '\n' ' ')"
  else
    PKGS="$(read_sys_packages | tr '\n' ' ')"
    SYS_STAMP="$(stamp_of "$REQ_SYS")"
    if [[ "$DO_REINSTALL" -eq 0 ]] && stamp_ok system "$SYS_STAMP"; then
      ok "System packages already satisfied (cached; use --reinstall to re-check)."
    else
      info "Installing system packages with dnf (only missing ones are fetched)…"
      # shellcheck disable=SC2086
      if $SUDO "$DNF_BIN" install -y --needed $PKGS; then
        stamp_write system "$SYS_STAMP"
        ok "System packages installed."
      else
        warn "Bulk install failed; retrying one package at a time to isolate the problem."
        missing=()
        for p in $PKGS; do
          if ! $SUDO "$DNF_BIN" install -y --needed "$p" >/dev/null 2>&1; then missing+=("$p"); fi
        done
        if [[ ${#missing[@]} -eq 0 ]]; then
          stamp_write system "$SYS_STAMP"
          ok "System packages installed after retry."
        else
          for p in "${missing[@]}"; do
            if [[ " $CRITICAL_PKGS " == *" $p "* ]]; then
              err "Critical package not available: $p"
              err "Fix the dnf repositories, then run: sudo dnf install -y --needed $p"
              exit "$EXIT_MISSING_DEP"
            fi
            warn "Optional package unavailable on this release: $p (features that need it degrade gracefully)"
          done
        fi
      fi
    fi
  fi
fi

# ---------- 2. Ollama (never installed silently) ----------
step "Local model server (Ollama)"
if command -v ollama >/dev/null 2>&1; then
  ok "Ollama found: $(command -v ollama)"
  if [[ "$WITH_OLLAMA" -eq 1 ]]; then
    if command -v systemctl >/dev/null 2>&1 && [[ -n "$SUDO" || $EUID -eq 0 ]]; then
      $SUDO systemctl enable --now ollama.service 2>/dev/null && ok "ollama.service enabled and started." \
        || warn "could not enable ollama.service; start it with: ollama serve"
    fi
  fi
elif [[ "$WITH_OLLAMA" -eq 1 ]]; then
  info "Installing Ollama (explicitly requested with --with-ollama)…"
  if command -v curl >/dev/null 2>&1 && curl -fsSL https://ollama.com/install.sh | sh; then
    ok "Ollama installed."
    if command -v systemctl >/dev/null 2>&1 && [[ -n "$SUDO" || $EUID -eq 0 ]]; then
      $SUDO systemctl enable --now ollama.service 2>/dev/null && ok "ollama.service enabled and started." \
        || warn "could not enable ollama.service; start it with: ollama serve"
    fi
  else
    warn "Ollama install failed. Install it manually from https://ollama.com and re-run."
  fi
else
  warn "Ollama not found. The local-first loop uses it by default. Options:"
  printf '      • install:  %scurl -fsSL https://ollama.com/install.sh | sh%s   (or re-run with --with-ollama)\n' "$C_INFO" "$C_OFF"
  printf '      • or point the app at any OpenAI-compatible server (llama.cpp, vLLM, LM Studio) in Settings.\n'
fi

# ---------- 3. virtualenv ----------
step "Python virtualenv"
if [[ "$DO_REINSTALL" -eq 1 && -d "$VENV_DIR" ]]; then
  # Guard: only delete a directory that really is a virtualenv we created.
  if [[ -f "$VENV_DIR/pyvenv.cfg" ]]; then
    info "Removing old virtualenv at $VENV_DIR (--reinstall)"
    rm -rf -- "$VENV_DIR"
  else
    err "$VENV_DIR exists but is not a virtualenv (no pyvenv.cfg); refusing to delete it."
    exit "$EXIT_GENERIC"
  fi
fi
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  info "Creating virtualenv at $VENV_DIR with $PY_BIN"
  if ! "$PY_BIN" -m venv "$VENV_DIR" 2>/dev/null; then
    rm -rf -- "$VENV_DIR"
    if command -v pipx >/dev/null 2>&1 && pipx run virtualenv --version >/dev/null 2>&1; then
      warn "python -m venv unavailable; falling back to virtualenv via pipx"
      pipx run virtualenv -p "$PY_BIN" "$VENV_DIR" || { err "virtualenv creation failed"; exit "$EXIT_GENERIC"; }
    else
      err "Virtualenv creation failed. On Fedora: sudo dnf install -y python3-devel && re-run."
      err "Alternative: pipx install virtualenv, then re-run ./run.sh"
      exit "$EXIT_GENERIC"
    fi
  fi
fi
VENV_PY="$VENV_DIR/bin/python"
ok "Virtualenv ready: $VENV_DIR"

# ---------- 4. python dependencies ----------
step "Python dependencies"
if [[ "$SKIP_PIP" -eq 0 ]]; then
  PIP_STAMP="$(stamp_of "$REQ_PY" "$ROOT_DIR/pyproject.toml")"
  if [[ "$DO_REINSTALL" -eq 0 ]] && stamp_ok pip "$PIP_STAMP" && [[ -x "$VENV_DIR/bin/observer-core" ]]; then
    ok "Python dependencies up to date (cached)."
  else
    info "Upgrading pip tooling…"
    "$VENV_PY" -m pip install --quiet --upgrade pip setuptools wheel --disable-pip-version-check
    info "Installing requirements.txt (first run can take a few minutes)…"
    if [[ "$DO_REINSTALL" -eq 1 ]]; then
      "$VENV_PY" -m pip install --upgrade -r "$REQ_PY" --disable-pip-version-check
    else
      "$VENV_PY" -m pip install -r "$REQ_PY" --disable-pip-version-check
    fi
    info "Registering the observer-core console scripts (editable install)…"
    if "$VENV_PY" -m pip install --quiet -e "$ROOT_DIR" --disable-pip-version-check; then
      stamp_write pip "$PIP_STAMP"
      ok "Python dependencies installed."
    else
      warn "Editable install failed; 'python -m observer_core' still works from the source tree."
    fi
  fi
else
  info "Skipping pip (--skip-pip)."
fi

# ---------- 5. XDG directories & starter config ----------
step "Directories & configuration"
XDG_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID"
XDG_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$APP_ID"
XDG_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/$APP_ID"
XDG_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/$APP_ID"
mkdir -p "$XDG_CFG" "$XDG_DATA" "$XDG_STATE" "$XDG_CACHE"
chmod 700 "$XDG_CFG" "$XDG_DATA" 2>/dev/null || true
if [[ -f "$XDG_CFG/config.toml" ]]; then
  ok "config.toml present — left untouched ($XDG_CFG/config.toml)"
else
  if "$VENV_PY" -m observer_core init-config >/dev/null 2>&1; then
    ok "wrote starter config.toml (mode 600): $XDG_CFG/config.toml"
  else
    warn "could not write starter config (run: $VENV_PY -m observer_core init-config)"
  fi
fi

# ---------- 6. preflight ----------
step "Preflight"
if "$VENV_PY" -c "import PyQt6.QtCore" 2>/dev/null; then
  ok "PyQt6 imports"
else
  if [[ "$RUN_DOCTOR" -eq 0 && "$RUN_DAEMON" -eq 0 && "$DO_SETUP" -eq 0 ]]; then
    err "PyQt6 cannot be imported. Missing system libraries? Try: sudo dnf install -y mesa-libEGL mesa-libGL libxkbcommon libxkbcommon-x11"
    exit "$EXIT_MISSING_DEP"
  fi
  warn "PyQt6 import failed — the GUI will not start (daemon and doctor still work)."
fi
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  warn "No graphical display detected. Use './run.sh --daemon' for headless operation."
fi

# ---------- 7. summary & launch ----------
step "Summary"
ok "$APP_NAME $APP_VERSION is set up."
printf '    re-run:        %s./run.sh%s   (fast: everything is cached)\n' "$C_INFO" "$C_OFF"
printf '    headless:      %s./run.sh --daemon%s\n' "$C_INFO" "$C_OFF"
printf '    diagnostics:   %s./run.sh --doctor%s\n' "$C_INFO" "$C_OFF"
printf '    config:        %s\n' "$XDG_CFG/config.toml"

if [[ "$DO_SETUP" -eq 1 ]]; then
  exit 0
fi

# Clear our interrupt trap: exec() would otherwise leave the app with a stale handler.
trap - INT

if [[ "$RUN_DOCTOR" -eq 1 ]]; then
  exec "$VENV_PY" -m observer_core doctor
fi
if [[ "$RUN_DAEMON" -eq 1 ]]; then
  if [[ -x "$VENV_DIR/bin/observer-core-daemon" ]]; then
    exec "$VENV_DIR/bin/observer-core-daemon"
  fi
  exec "$VENV_PY" -m observer_core daemon
fi
if [[ "$RUN_DEV" -eq 1 ]]; then
  export PYTHONPATH="$ROOT_DIR${PYTHONPATH:+:$PYTHONPATH}"
fi
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  err "Cannot open a window without a display. Re-run with --daemon for headless mode."
  exit "$EXIT_MISSING_DEP"
fi
exec "$VENV_PY" -m observer_core
