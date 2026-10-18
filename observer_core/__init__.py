"""Observer Core — local-first micro-agents for Linux desktops.

Observer Core reproduces the core loop of `Observer AI <https://github.com/Roy3838/Observer>`_
(Roy3838, AGPL-3.0) as an independent, Fedora-native Python implementation:

    sense (screen / camera / audio / clipboard)
      -> interpret (local or remote LLM)
        -> act (notify / message / remember / record)

Everything captured stays on this machine unless *you* configure a network
endpoint. See ``README.md`` for the privacy & security model.
"""

from __future__ import annotations

__version__ = "0.1.0"
__app_name__ = "Observer Core"
__app_id__ = "observer-core"
__license__ = "AGPL-3.0-or-later"

#: Upstream project this work is derived in concept from.
UPSTREAM_ATTRIBUTION = (
    "Concept after Observer AI by Roy3838 (https://github.com/Roy3838/Observer), AGPL-3.0. "
    "Observer Core is an independent Fedora-native reimplementation."
)

__all__ = [
    "__version__",
    "__app_name__",
    "__app_id__",
    "__license__",
    "UPSTREAM_ATTRIBUTION",
]
