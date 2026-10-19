"""Phone-number handling for the WhatsApp remote: normalisation and masking.

WhatsApp addresses people by digits only (country code + subscriber number, no "+").
Users type numbers in many shapes (``9528923866``, ``+91 95289 23866``, ``0095...``),
so everything is normalised once here and compared as digits.
"""

from __future__ import annotations

import re

_E164_MIN, _E164_MAX = 8, 15


class PhoneError(ValueError):
    """The number cannot be turned into a WhatsApp address."""


def normalize_phone(raw: str, country_code: str = "91") -> str:
    """Return the digits-only WhatsApp user part, e.g. ``919528923866``.

    * ``+919528923866`` / ``919528923866`` -> ``919528923866``
    * ``0091 95289 23866``                -> ``919528923866``
    * ``9528923866`` (10 digits)          -> prefixed with ``country_code``
    """
    text = (raw or "").strip()
    if not text:
        raise PhoneError("phone number is empty")
    cc = re.sub(r"\D", "", country_code or "") or "91"
    digits = re.sub(r"\D", "", text)
    if text.startswith("+"):
        full = digits
    elif text.startswith("00"):
        full = digits[2:]
    elif len(digits) == 10:
        full = cc + digits
    else:
        full = digits
    if not (_E164_MIN <= len(full) <= _E164_MAX) or not full.isdigit():
        raise PhoneError(f"not a valid phone number: {mask_phone(text)}")
    return full


def mask_phone(value: str) -> str:
    """Keep the last four digits only, for logs and status output."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) <= 4:
        return "*" * len(digits)
    return "*" * (len(digits) - 4) + digits[-4:]


def same_number(a: str, b: str, country_code: str = "91") -> bool:
    try:
        return normalize_phone(a, country_code) == normalize_phone(b, country_code)
    except PhoneError:
        return False


__all__ = ["PhoneError", "normalize_phone", "mask_phone", "same_number"]
