"""Manual arena.ai mode: open the site in the owner's own browser and copy the prompt.

The owner pastes the prompt (Ctrl+V) and presses Send. The observer never drives
arena.ai, never types into the page, and never automates the site.
"""

from __future__ import annotations

import shutil
import subprocess

ARENA_URL = "https://arena.ai/agent"

_CLIPBOARD_TOOLS = (
    ["wl-copy"],                             # Wayland
    ["xclip", "-selection", "clipboard"],    # X11
    ["xsel", "--clipboard", "--input"],      # X11 alternative
)


def copy_to_clipboard(text: str) -> bool:
    """Copy text with the first clipboard tool found. Returns False if none works."""
    for cmd in _CLIPBOARD_TOOLS:
        if shutil.which(cmd[0]) is None:
            continue
        try:
            subprocess.run(cmd, input=text.encode("utf-8"), check=True, timeout=5,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def open_url(url: str) -> bool:
    """Open a link in the owner's default browser. Returns False if that is not possible."""
    if shutil.which("xdg-open") is None:
        return False
    try:
        subprocess.Popen(["xdg-open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return False
    return True


def open_arena_by_hand(prompt: str) -> str:
    """Open arena.ai and put the prompt on the clipboard. Returns the message for the owner."""
    copied = copy_to_clipboard(prompt)
    opened = open_url(ARENA_URL)
    if copied and opened:
        return ("Opened arena.ai in your browser and copied the prompt. "
                "Paste it there (Ctrl+V) and press Send.")
    if opened:
        return ("Opened arena.ai in your browser, but I could not copy the prompt "
                "(no clipboard tool found). Here it is to copy by hand:\n\n" + prompt)
    if copied:
        return ("I copied the prompt, but I could not open a browser on this computer. "
                "Open https://arena.ai/agent yourself, then paste (Ctrl+V) and press Send.")
    return ("I could not open a browser or copy the prompt on this computer. "
            "Open https://arena.ai/agent yourself and type the prompt:\n\n" + prompt)
