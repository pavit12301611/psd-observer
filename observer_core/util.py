"""Small shared utilities: subprocess wrappers, session detection, redaction."""

from __future__ import annotations

import base64
import io
import os
import re
import shlex
import shutil
import socket
import subprocess
from dataclasses import dataclass, field
from typing import Sequence


@dataclass
class CommandResult:
    ok: bool
    argv: list[str] = field(default_factory=list)
    stdout: str = ""
    stderr: str = ""
    stdout_bytes: bytes = b""
    returncode: int = 0
    error: str | None = None
    duration_ms: int = 0

    @property
    def message(self) -> str:
        if self.error:
            return self.error
        return (self.stderr or self.stdout).strip()[:400]


def run_subprocess(
    argv: Sequence[str],
    *,
    timeout: float = 30.0,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    stdin: bytes | None = None,
    capture_binary: bool = False,
    extra_paths: Sequence[str] | None = None,
) -> CommandResult:
    """Run a subprocess defensively: never raises, always returns a CommandResult."""
    import time

    started = time.monotonic()
    argv = list(argv)
    if not argv:
        return CommandResult(ok=False, error="empty command")
    binary = argv[0]
    if not os.path.sep in binary:
        found = shutil.which(binary, path=_path_with(extra_paths))
        if not found:
            return CommandResult(ok=False, argv=argv, error=f"`{binary}` not found in PATH")
        argv[0] = found
    run_env = dict(os.environ)
    if env:
        run_env.update(env)
    try:
        proc = subprocess.run(
            argv,
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            cwd=cwd,
            env=run_env,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return CommandResult(
            ok=False,
            argv=argv,
            error=f"timed out after {timeout:.0f}s",
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except OSError as exc:
        return CommandResult(
            ok=False,
            argv=argv,
            error=f"{type(exc).__name__}: {exc}",
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    stdout_bytes = proc.stdout or b""
    return CommandResult(
        ok=proc.returncode == 0,
        argv=argv,
        stdout=stdout_bytes.decode("utf-8", errors="replace") if not capture_binary else "",
        stderr=(proc.stderr or b"").decode("utf-8", errors="replace"),
        stdout_bytes=stdout_bytes,
        returncode=proc.returncode,
        error=None if proc.returncode == 0 else f"exit {proc.returncode}",
        duration_ms=int((time.monotonic() - started) * 1000),
    )


def _path_with(extra: Sequence[str] | None) -> str | None:
    if not extra:
        return None
    return os.pathsep.join([*extra, os.environ.get("PATH", "")])


# --------------------------------------------------------------------------- #
# session / desktop detection
# --------------------------------------------------------------------------- #
@dataclass
class SessionInfo:
    session_type: str          # "wayland" | "x11" | "headless"
    wayland_display: str = ""
    display: str = ""
    desktop: str = ""
    has_display: bool = False
    portal_available: bool = False
    detail: str = ""

    def describe(self) -> str:
        bits = [f"session={self.session_type}"]
        if self.desktop:
            bits.append(f"desktop={self.desktop}")
        if self.wayland_display:
            bits.append(f"wayland={self.wayland_display}")
        if self.display:
            bits.append(f"xdg_display={self.display}")
        bits.append(f"portal={'yes' if self.portal_available else 'no'}")
        return " ".join(bits)


def detect_session() -> SessionInfo:
    wayland = os.environ.get("WAYLAND_DISPLAY", "")
    display = os.environ.get("DISPLAY", "")
    if wayland:
        kind = "wayland"
    elif display:
        kind = "x11"
    else:
        kind = "headless"
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").strip()
    info = SessionInfo(
        session_type=kind,
        wayland_display=wayland,
        display=display,
        desktop=desktop,
        has_display=bool(wayland or display),
    )
    info.portal_available = portal_available()
    info.detail = info.describe()
    return info


def portal_available() -> bool:
    """Best-effort check for a running xdg-desktop-portal."""
    bus = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
    if not bus:
        return False
    if shutil.which("busctl") is None:
        return bool(shutil.which("xdg-desktop-portal"))
    result = run_subprocess(
        [
            "busctl",
            "--user",
            "call",
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.DBus.Properties",
            "Get",
            "ss",
            "org.freedesktop.portal.ScreenCast",
            "version",
        ],
        timeout=3.0,
    )
    return result.ok


def is_fedora() -> bool:
    try:
        with open("/etc/os-release", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return False
    return bool(re.search(r'^ID(?:_LIKE)?=.*fedora', text, re.MULTILINE))


def distro_pretty_name() -> str:
    try:
        with open("/etc/os-release", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return "Linux"


def free_tcp_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


# --------------------------------------------------------------------------- #
# text helpers
# --------------------------------------------------------------------------- #
def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def looks_like_image(data: bytes) -> bool:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return True
    if data[:2] == b"\xff\xd8":
        return True
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return True
    return False


def synthesize_png(width: int = 640, height: int = 360, text: str = "OBSERVER") -> bytes:
    """Create a synthetic PNG without requiring a display (used by fakes/doctor)."""
    try:
        from PIL import Image, ImageDraw

        image = Image.new("RGB", (width, height), (18, 22, 30))
        draw = ImageDraw.Draw(image)
        # A grid so vision models have something structured to look at.
        for x in range(0, width, 40):
            draw.line([(x, 0), (x, height)], fill=(35, 42, 56))
        for y in range(0, height, 40):
            draw.line([(0, y), (width, y)], fill=(35, 42, 56))
        draw.rectangle([(2, 2), (width - 3, height - 3)], outline=(90, 120, 180), width=2)
        draw.text((16, 16), text, fill=(220, 230, 245))
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # pragma: no cover - Pillow missing
        # Minimal 1x1 transparent PNG.
        return base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )


def jpeg_bytes(data: bytes, max_width: int = 1280, quality: int = 82) -> bytes:
    try:
        from PIL import Image

        buf = io.BytesIO(data)
        image = Image.open(buf)
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        if image.width > max_width:
            ratio = max_width / float(image.width)
            image = image.resize((max_width, max(1, int(image.height * ratio))))
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=quality)
        return out.getvalue()
    except Exception:
        return data


def png_bytes(data: bytes, max_width: int = 1920) -> bytes:
    try:
        from PIL import Image

        image = Image.open(io.BytesIO(data))
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        if image.width > max_width:
            ratio = max_width / float(image.width)
            image = image.resize((max_width, max(1, int(image.height * ratio))))
        out = io.BytesIO()
        image.save(out, format="PNG", optimize=True)
        return out.getvalue()
    except Exception:
        return data


def image_size(data: bytes) -> tuple[int | None, int | None]:
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            return image.width, image.height
    except Exception:
        return None, None


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def shlex_join(argv: Sequence[str]) -> str:
    return shlex.join(list(argv))


def mask_url_credentials(url: str) -> str:
    return re.sub(r"(?<=://)([^/]*):([^@]*)@", r"\1:***@", url or "")


def human_bytes(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(num) < 1024.0:
            return f"{num:3.1f} {unit}"
        num /= 1024.0
    return f"{num:.1f} PB"
