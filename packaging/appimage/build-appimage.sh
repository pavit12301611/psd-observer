#!/usr/bin/env bash
# Build Observer Core as an AppImage on Fedora (run it on the Fedora machine, from the repo).
#
#   ./packaging/appimage/build-appimage.sh                 build dist/Observer_Core-<version>-x86_64.AppImage
#   ./packaging/appimage/build-appimage.sh --no-package    only stage the AppDir (build/appimage/), no download
#
# The AppImage bundles the Observer Core Python packages (PyQt6, OpenCV, Playwright, ...).
# It uses the system python3 and the Fedora packages listed in the README (tesseract, portaudio,
# chromium, Qt/X11 libraries). It does not bundle Ollama or any browser.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON:-python3}"
MIN_PY="${OBSERVER_CORE_MIN_PY:-3.12}"          # same rule as run.sh
VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$ROOT/observer_core/__init__.py")"
ARCH="x86_64"
BUILD="$ROOT/build/appimage"
APPDIR="$BUILD/Observer_Core.AppDir"
SITE="$APPDIR/usr/lib/observer-core/site-packages"
OUT="$ROOT/dist"
TOOL="$BUILD/appimagetool-$ARCH.AppImage"
TOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage"

die(){ printf '[✗] %s\n' "$*" >&2; exit 1; }
info(){ printf '[·] %s\n' "$*"; }

[[ "$(uname -m)" == "$ARCH" ]] || die "this script builds $ARCH AppImages only (this machine is $(uname -m))."
command -v "$PY" >/dev/null 2>&1 || die "$PY not found. Install it: sudo dnf install python3 python3-pip"
"$PY" -c "import sys; sys.exit(0 if sys.version_info >= tuple(int(x) for x in '$MIN_PY'.split('.')) else 1)" \
    || die "Python $MIN_PY or newer is required (found $("$PY" -c 'import sys; print(sys.version.split()[0])'))."
"$PY" -m pip --version >/dev/null 2>&1 || die "pip is missing. Install it: sudo dnf install python3-pip"
[[ -n "$VERSION" ]] || die "could not read the version from observer_core/__init__.py"

info "Observer Core $VERSION, Python $("$PY" -c 'import sys; print(sys.version.split()[0])'), $ARCH"

# ---- stage the AppDir ----------------------------------------------------------
rm -rf "$APPDIR"
mkdir -p "$SITE" "$APPDIR/usr/share/icons/hicolor/scalable/apps" "$APPDIR/usr/share/metainfo"

info "installing Python packages into the AppDir (this downloads from PyPI)"
"$PY" -m pip install --upgrade --no-warn-script-location --target "$SITE" "$ROOT"
rm -rf "$SITE/bin"
find "$SITE" -name '__pycache__' -type d -prune -exec rm -rf {} +

# ---- trim Qt modules the app does not use (about 150 MB). The app needs QtCore, QtGui,
# QtWidgets and QtSvg only. The smoke test below fails the build if a removal breaks them.
QT="$SITE/PyQt6"
UNUSED_QT=(Quick3D Quick3DRuntimeRender Quick3DPhysics Quick3DAssetImport Quick3DUtils ShaderTools Designer
           Pdf PdfWidgets Multimedia MultimediaWidgets Qml Quick QuickWidgets QuickControls2 QuickTest
           SpatialAudio TextToSpeech WebChannel WebSockets RemoteObjects Nfc Bluetooth SerialPort Sensors
           Positioning Help Labs StateMachine Sql EglFSDeviceIntegration FFmpegStub)
for mod in "${UNUSED_QT[@]}"; do   # prefix match: Quick also removes QuickWidgets, Qml also removes QmlModels
    rm -f "$QT/Qt6/lib/libQt6${mod}"*.so* "$QT/Qt${mod}"*.abi3.so "$QT/Qt${mod}"*.pyi
done
rm -rf "$QT/Qt6/qml" "$QT/Qt6/translations" "$QT/Qt6/qsci" "$QT/Qt6/plugins/multimedia" \
       "$QT/Qt6/plugins/sensorgestures" "$QT/Qt6/plugins/position" "$QT/Qt6/plugins/sqldrivers" \
       "$QT/uic" "$QT/lupdate" 2>/dev/null || true
rm -f "$QT/Qt6/lib/libav"*.so* "$QT/Qt6/lib/libsw"*.so* 2>/dev/null || true

info "checking that the trimmed Qt still loads (offscreen smoke test)"
smoke_rc=0
smoke_out="$(QT_QPA_PLATFORM=offscreen PYTHONNOUSERSITE=1 PYTHONPATH="$SITE" "$PY" -c \
    "from PyQt6.QtWidgets import QApplication; from PyQt6.QtSvg import QSvgRenderer; import pyqtgraph; QApplication([]); print('qt ok')" 2>&1)" || smoke_rc=$?
if ((smoke_rc != 0)); then
    if grep -q 'libQt6' <<<"$smoke_out"; then
        printf '%s\n' "$smoke_out" >&2
        die "the trimmed Qt does not load: a libQt6 library is missing. Remove the module that broke from UNUSED_QT."
    fi
    info "smoke test skipped, a host library is missing on this machine: $(tail -n 1 <<<"$smoke_out")"
    info "install mesa-libGL and libxkbcommon (see the dnf line above) and build again to verify"
fi

install -m755 "$ROOT/packaging/appimage/AppRun" "$APPDIR/AppRun"
install -m644 "$ROOT/packaging/appimage/observer-core.desktop" "$APPDIR/observer-core.desktop"
install -m644 "$ROOT/packaging/appimage/observer-core.svg" "$APPDIR/observer-core.svg"
install -m644 "$ROOT/packaging/appimage/observer-core.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/observer-core.svg"
install -m644 "$ROOT/install/metainfo.xml" "$APPDIR/usr/share/metainfo/observer-core.metainfo.xml"

# ---- check the host for the system pieces the AppImage cannot carry ----------
export PATH="$PATH:/usr/sbin:/sbin"   # ldconfig lives here on Fedora
missing=()
command -v tesseract >/dev/null 2>&1 || missing+=("tesseract tesseract-langpack-eng")
ldconfig -p | grep -q 'libportaudio\.so' || missing+=("portaudio")
ldconfig -p | grep -q 'libxcb-cursor\.so' || missing+=("xcb-util-cursor")
ldconfig -p | grep -q 'libxkbcommon\.so' || missing+=("libxkbcommon")
command -v chromium-browser >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || missing+=("chromium")
if ((${#missing[@]})); then
    info "these Fedora packages are missing (install them for full function):"
    printf '      sudo dnf install %s\n' "${missing[*]}"
fi

info "AppDir staged at $APPDIR"
if [[ "${1:-}" == "--no-package" ]]; then
    exit 0
fi

# ---- package -------------------------------------------------------------------
mkdir -p "$BUILD" "$OUT"
if [[ ! -x "$TOOL" ]]; then
    info "downloading appimagetool from GitHub"
    curl -fL --retry 3 -o "$TOOL" "$TOOL_URL" || die "download failed: $TOOL_URL"
    chmod +x "$TOOL"
fi

RESULT="$OUT/Observer_Core-$VERSION-$ARCH.AppImage"
info "building $RESULT"
# APPIMAGE_EXTRACT_AND_RUN lets appimagetool run without FUSE (Fedora installs fuse-libs by default anyway).
ARCH="$ARCH" APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" "$APPDIR" "$RESULT"
sha256sum "$RESULT" | tee "$RESULT.sha256"
info "done. Run it with: $RESULT"
