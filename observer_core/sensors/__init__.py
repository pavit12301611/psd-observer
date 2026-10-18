"""Sensor layer.

A :class:`Sensor` turns the physical world into a :class:`SensorPayload`. Every
sensor must answer ``available()`` honestly so the GUI can show a status pill
and the runtime can mark a cycle *degraded* instead of crashing.
"""

from __future__ import annotations

from .base import Sensor, SensorStatus  # noqa: F401
from .registry import SensorRegistry  # noqa: F401

__all__ = ["Sensor", "SensorStatus", "SensorRegistry"]
