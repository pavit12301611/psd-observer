"""Environment report: `observer-core doctor` and the GUI's Diagnostics tab.

Every probe returns a :class:`Diagnostic` and never raises, so a broken
subsystem shows up as a line in the report instead of killing the command.
"""

from __future__ import annotations

import platform
import shutil
import sys

from . import __version__
from .models import Diagnostic, SensorKind
from .util import detect_session, distro_pretty_name, is_fedora, run_subprocess

SYSTEM_TOOLS: list[tuple[str, str, str]] = [
    # (binary, feature, dnf package)
    ("tesseract", "OCR sensor", "tesseract tesseract-langpack-eng"),
    ("ffmpeg", "clip recording", "ffmpeg"),
    ("notify-send", "desktop notifications", "libnotify"),
    ("pactl", "system audio (PulseAudio/PipeWire)", "pulseaudio-utils"),
    ("pw-record", "system audio fallback", "pipewire-utils"),
    ("parec", "system audio capture", "pulseaudio-utils"),
    ("xdg-open", "open logs folder", "xdg-utils"),
    ("wl-paste", "Wayland clipboard", "wl-clipboard"),
    ("xclip", "X11 clipboard", "xclip"),
    ("spectacle", "KDE screenshot fallback", "spectacle"),
    ("gnome-screenshot", "GNOME screenshot fallback", "gnome-screenshot"),
    ("v4l2-ctl", "camera enumeration", "v4l-utils"),
]


def python_diagnostic() -> Diagnostic:
    ok = sys.version_info >= (3, 11)
    return Diagnostic(area="system", name="python", ok=ok, status="ok" if ok else "error",
                      detail=f"{platform.python_version()} at {sys.executable}",
                      hint="" if ok else "Observer Core needs Python 3.11+ (3.12/3.13 recommended). sudo dnf install python3.13")


def os_diagnostic() -> Diagnostic:
    fed = is_fedora()
    return Diagnostic(area="system", name="os", ok=True, status="ok",
                      detail=f"{distro_pretty_name()} ({'Fedora path' if fed else 'non-Fedora: dnf steps skipped'})")


def session_diagnostic() -> Diagnostic:
    s = detect_session()
    detail = s.describe()
    if s.session_type == "headless":
        return Diagnostic(area="system", name="session", ok=False, status="unavailable", detail=detail,
                          hint="No display. Use `observer-core daemon` for headless operation.")
    if s.session_type == "wayland":
        return Diagnostic(area="system", name="session", ok=True, status="degraded" if not s.portal_available else "ok",
                          detail=detail,
                          hint="" if s.portal_available else "Wayland: grant screen capture via the desktop portal (xdg-desktop-portal + PipeWire).")
    return Diagnostic(area="system", name="session", ok=True, status="ok", detail=detail)


def gpu_diagnostic() -> Diagnostic:
    vulkan = shutil.which("vulkaninfo")
    nvidia = shutil.which("nvidia-smi")
    bits = []
    if nvidia:
        r = run_subprocess(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], timeout=5)
        if r.ok and r.stdout.strip():
            bits.append(f"CUDA GPU: {r.stdout.strip().splitlines()[0]}")
    if vulkan:
        r = run_subprocess(["vulkaninfo", "--summary"], timeout=8)
        if r.ok:
            for line in r.stdout.splitlines():
                if "deviceName" in line:
                    bits.append(line.split("=", 1)[-1].strip())
                    break
    if not bits:
        bits.append("no GPU tooling detected (CPU inference is fine for small models)")
    return Diagnostic(area="system", name="gpu", ok=True, status="ok", detail="; ".join(bits))


def system_tool_diagnostics() -> list[Diagnostic]:
    out = []
    for binary, feature, pkg in SYSTEM_TOOLS:
        path = shutil.which(binary)
        out.append(Diagnostic(
            area="tool", name=binary, ok=bool(path), status="ok" if path else "unavailable",
            detail=f"{path or 'not found'} — used for {feature}",
            hint="" if path else f"sudo dnf install {pkg}",
        ))
    return out


def video_devices() -> list[str]:
    from .sensors.camera import list_video_devices

    return list_video_devices()


def audio_devices() -> list[str]:
    try:
        import sounddevice as sd

        return [f"{i}: {d['name']}" for i, d in enumerate(sd.query_devices())
                if d.get("max_input_channels", 0) > 0]
    except Exception:
        return []


def portal_diagnostic() -> Diagnostic:
    s = detect_session()
    return Diagnostic(area="system", name="xdg-desktop-portal", ok=s.portal_available,
                      status="ok" if s.portal_available else ("degraded" if s.session_type == "wayland" else "ok"),
                      detail="portal reachable on the session bus" if s.portal_available else "portal not reachable (fine on X11)",
                      hint="" if s.portal_available or s.session_type != "wayland" else "sudo dnf install xdg-desktop-portal xdg-desktop-portal-gtk")


def data_dirs_diagnostic() -> Diagnostic:
    from . import paths

    dirs = {"config": paths.config_dir(), "data": paths.data_dir(), "state": paths.state_dir(), "cache": paths.cache_dir()}
    bad = []
    for name, p in dirs.items():
        if not p.exists():
            bad.append(f"{name} missing")
            continue
        if name in ("config", "data") and (p.stat().st_mode & 0o077):
            bad.append(f"{name} is group/world accessible (chmod 700 {p})")
    return Diagnostic(area="system", name="xdg-dirs", ok=not bad, status="ok" if not bad else "degraded",
                      detail="; ".join(f"{k}={v}" for k, v in dirs.items()), hint="; ".join(bad))


def config_diagnostic(cfg) -> Diagnostic:
    from . import paths

    cfg_path = paths.config_file()
    if cfg.load_error:
        return Diagnostic(area="system", name="config.toml", ok=False, status="error",
                          detail=cfg.load_error, hint="Fix or delete the file; defaults are in use.")
    if not cfg_path.exists():
        return Diagnostic(area="system", name="config.toml", ok=True, status="ok",
                          detail=f"{cfg_path} not created yet (defaults in use)",
                          hint="observer-core init-config")
    mode = cfg_path.stat().st_mode & 0o777
    if mode & 0o077:
        return Diagnostic(area="system", name="config.toml", ok=False, status="degraded",
                          detail=f"{cfg_path} has mode {oct(mode)}", hint=f"chmod 600 {cfg_path}")
    return Diagnostic(area="system", name="config.toml", ok=True, status="ok", detail=f"{cfg_path} (mode 600)")


def collect_diagnostics(app=None, *, include_model: bool = True) -> list[Diagnostic]:
    from .config import AppConfig
    from .sensors.registry import SensorRegistry

    cfg = app.config if app is not None else AppConfig.load(apply_env=True)
    out: list[Diagnostic] = [python_diagnostic(), os_diagnostic(), session_diagnostic(),
                             portal_diagnostic(), gpu_diagnostic(), config_diagnostic(cfg), data_dirs_diagnostic()]
    out.extend(system_tool_diagnostics())

    # sensors (probe without starting them)
    reg = app.sensors if app is not None else SensorRegistry(cfg)
    if app is None:
        from .models import SensorSpec as _S
        reg.configure([_S(kind=k) for k in SensorKind])
    out.extend(reg.diagnostics())

    # tools: credentials only, no network
    from .models import ToolSpec
    from .tools.registry import ToolRegistry

    treg = app.tools if app is not None else ToolRegistry(cfg)
    for kind in ToolKind_all():
        try:
            ok, msg = treg.build(ToolSpec(kind=kind)).validate()
        except Exception as exc:  # pragma: no cover
            ok, msg = False, str(exc)
        hint = ""
        if not ok and msg.startswith("missing"):
            hint = "Add the credential in Settings → Notifications, config.toml, or the environment variable."
        out.append(Diagnostic(area="tool", name=kind.value, ok=ok, status="ok" if ok else "unavailable",
                              detail=msg, hint=hint))

    if include_model:
        from .llm.factory import default_model_spec, make_provider
        spec = default_model_spec(cfg)
        try:
            prov = make_provider(spec, cfg)
            ok, detail = prov.health()
            models = prov.list_models() if ok else []
        except Exception as exc:
            ok, detail, models = False, str(exc), []
        out.append(Diagnostic(area="model", name=spec.provider, ok=ok, status="ok" if ok else "unavailable",
                              detail=detail + (f" — models: {', '.join(models[:6])}" if models else ""),
                              hint="" if ok else "Start Ollama (`ollama serve`) or point models.endpoint at your server."))
    return out


def ToolKind_all():
    from .models import ToolKind

    return list(ToolKind)


def render_text(diags: list[Diagnostic]) -> str:
    marks = {"ok": "✓", "degraded": "!", "unavailable": "✗", "error": "✗"}
    lines = [f"Observer Core {__version__} — environment report", ""]
    current = None
    for d in diags:
        if d.area != current:
            current = d.area
            lines.append(f"[{current}]")
        lines.append(f"  {marks.get(d.status, '?')} {d.name:<22} {d.detail}")
        if d.hint and not d.ok or (d.hint and d.status == "degraded"):
            lines.append(f"      → {d.hint}")
    cams = video_devices()
    lines.append("")
    lines.append(f"[devices] cameras: {', '.join(cams) or 'none'}")
    mics = audio_devices()
    lines.append(f"[devices] microphones: {'; '.join(mics) or 'none detected'}")
    lines.append("")
    lines.append(f"Summary: {sum(d.ok for d in diags)}/{len(diags)} checks OK. Degraded items still let the app start.")
    return "\n".join(lines)


__all__ = ["collect_diagnostics", "render_text", "SYSTEM_TOOLS"]
