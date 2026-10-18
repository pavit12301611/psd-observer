"""Qt-free launcher helpers: decide whether a GUI can start and explain why not."""

from __future__ import annotations

import sys

from .util import detect_session


def launch_gui_or_explain() -> int:
    """Return 0 after launching the GUI, or a non-zero code with an explanation."""
    sess = detect_session()
    if not sess.has_display:
        print("Observer Core: no display found (DISPLAY/WAYLAND_DISPLAY unset).\n"
              "Use `observer-core daemon` (or ./run.sh --daemon) for headless operation.", file=sys.stderr)
        return 2
    from .gui.main_window import run_gui

    return run_gui()


__all__ = ["launch_gui_or_explain"]
