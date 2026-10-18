"""Pure scheduling policy: jitter and exponential back-off.

Kept free of asyncio so it can be unit-tested with a fake RNG and no sleeping.
"""

from __future__ import annotations

import random
from typing import Callable


def jittered_interval(interval_s: float, jitter_pct: float = 10.0,
                      rng: Callable[[float, float], float] = random.uniform) -> float:
    """Return ``interval_s`` ± ``jitter_pct`` percent (never below 0.5 s)."""
    pct = max(0.0, float(jitter_pct)) / 100.0
    lo = interval_s * (1.0 - pct)
    hi = interval_s * (1.0 + pct)
    return max(0.5, rng(lo, hi))


def backoff_delay(failures: int, base_s: float = 5.0, cap_s: float = 300.0) -> float:
    """Exponential back-off after ``failures`` consecutive failures, capped."""
    if failures <= 0:
        return 0.0
    delay = base_s * (2 ** (failures - 1))
    return min(cap_s, delay)


__all__ = ["jittered_interval", "backoff_delay"]
