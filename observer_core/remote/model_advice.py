"""Suggest a local model for browser and WhatsApp jobs, from this machine's RAM and GPU.

Advice only: nothing is downloaded or changed. Browser jobs need a model that follows a strict
one-JSON-object format, so the suggestions favour instruction-tuned models of 3B to 7B parameters.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass

CLOUD_NOTE = ("A cloud model is faster and stronger, but your WhatsApp messages, page text, and command "
              "output go to that provider. Set [models] provider = \"cloud\" and keep the key in an env var.")


@dataclass(frozen=True)
class Hardware:
    ram_gb: float | None
    gpu: str | None
    vram_gb: float | None


@dataclass(frozen=True)
class Advice:
    tag: str
    reason: str
    warning: str = ""


def detect_hardware(meminfo: str = "/proc/meminfo") -> Hardware:
    ram_gb: float | None = None
    try:
        with open(meminfo, encoding="utf-8") as fh:
            match = re.search(r"^MemTotal:\s+(\d+)\s+kB", fh.read(), re.MULTILINE)
        if match:
            ram_gb = round(int(match.group(1)) / 1024 / 1024, 1)
    except OSError:
        pass
    gpu = vram_gb = None
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5, check=False).stdout
            first = out.strip().splitlines()[0] if out.strip() else ""
            if first and "," in first:
                name, mib = first.rsplit(",", 1)
                gpu, vram_gb = name.strip(), round(float(mib.strip()) / 1024, 1)
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            pass
    return Hardware(ram_gb=ram_gb, gpu=gpu, vram_gb=vram_gb)


def recommend(hw: Hardware) -> Advice:
    if hw.vram_gb is not None and hw.vram_gb >= 6:
        return Advice("qwen2.5:7b", f"fits in the {hw.gpu} GPU memory, so jobs run fast")
    if hw.ram_gb is not None and hw.ram_gb >= 16:
        return Advice("qwen2.5:7b", "runs on the CPU; slower than a GPU, but the best quality you can run here")
    if hw.ram_gb is not None and hw.ram_gb >= 8:
        return Advice("qwen2.5:3b", "small enough to run on the CPU at a reasonable speed")
    return Advice("qwen2.5:1.5b", "the fastest option on this machine",
                  warning="A model this small makes more mistakes. Expect more retries, or use a cloud model.")


def advice_lines(hw: Hardware, adv: Advice, current: str) -> list[str]:
    lines = [
        f"RAM: {hw.ram_gb if hw.ram_gb is not None else 'unknown'} GB",
        f"GPU: {hw.gpu} ({hw.vram_gb} GB)" if hw.gpu else "GPU: none found (CPU only)",
        "",
        f"Suggested model: {adv.tag}  ({adv.reason})",
        f"Currently configured: {current}",
        f"  ollama pull {adv.tag}",
        f"  set ollama_model = \"{adv.tag}\" under [models] in config.toml, or OLLAMA_MODEL={adv.tag}",
    ]
    if adv.warning:
        lines += ["", adv.warning]
    lines += ["", CLOUD_NOTE]
    return lines


__all__ = ["Advice", "Hardware", "advice_lines", "detect_hardware", "recommend"]
