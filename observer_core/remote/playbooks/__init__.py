"""Browser-job instructions, shipped with Observer and editable by you.

This folder holds the instruction files the browser job reads:

* ``system.md``   the action format and the rules that always apply
* ``arena.md``   the arena.ai Agent Mode job
* ``research.md`` the web research job
* ``examples.jsonl``  worked examples (one page and one correct action each)

``build_system_prompt`` joins them and adds the examples that best match the owner's request,
as long as the total stays inside a budget. Examples show the format only: the model must use
element ids from the live page, and ``tests/test_playbooks.py`` checks that every example is
valid against the same rules the browser enforces.

These are instructions, not trained weights. Changing a file changes the next job; nothing
needs to be retrained or rebuilt.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from loguru import logger

PLAYBOOK_DIR = Path(__file__).resolve().parent
MODES = ("arena", "research")
DEFAULT_BUDGET = 6000          # characters of instructions per job (about 1,500 tokens)
DEFAULT_EXAMPLES = 3
_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = {"the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "it", "me", "my", "what", "how"}


@dataclass(frozen=True)
class Example:
    mode: str
    goal: str
    tags: tuple[str, ...]
    page: str
    action: dict
    why: str

    def tokens(self) -> set[str]:
        return {t for t in _TOKEN.findall(f"{self.goal} {' '.join(self.tags)}".lower()) if t not in _STOP}

    def render(self) -> str:
        return (f"Goal: {self.goal}\nPage:\n{self.page}\n"
                f"Correct action: {json.dumps(self.action, ensure_ascii=False)}\nWhy: {self.why}")


def _read(name: str) -> str:
    try:
        return (PLAYBOOK_DIR / name).read_text(encoding="utf-8").strip()
    except OSError:
        logger.warning("browser playbook missing: {}", name)
        return ""


@lru_cache(maxsize=1)
def load_examples() -> tuple[Example, ...]:
    out: list[Example] = []
    for line in _read("examples.jsonl").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            out.append(Example(mode=row["mode"], goal=row["goal"], tags=tuple(row.get("tags", [])),
                               page=row["page"], action=row["action"], why=row.get("why", "")))
        except (ValueError, KeyError, TypeError):
            logger.warning("skipping a malformed browser example")
    return tuple(out)


def select_examples(mode: str, goal: str, examples: tuple[Example, ...] | None = None,
                    k: int = DEFAULT_EXAMPLES) -> list[Example]:
    """Pick the examples that share the most words with the goal. Same mode first."""
    pool = [e for e in (examples if examples is not None else load_examples()) if e.mode == mode]
    wanted = {t for t in _TOKEN.findall(goal.lower()) if t not in _STOP}
    ranked = sorted(enumerate(pool), key=lambda pair: (-len(wanted & pair[1].tokens()), pair[0]))
    return [e for _, e in ranked[:k]]


def build_system_prompt(mode: str, goal: str, budget: int = DEFAULT_BUDGET) -> str:
    if mode not in MODES:
        raise ValueError(f"unknown browser job mode: {mode}")
    base = "\n\n".join(part for part in (_read("system.md"), "## Playbook\n" + _read(f"{mode}.md")) if part.strip())
    text = base
    chosen = []
    for example in select_examples(mode, goal):
        candidate = text + "\n\n## Worked example\n" + example.render()
        if len(candidate) > budget:
            break                      # never cut an example in half; keep what fits
        text = candidate
        chosen.append(example)
    return text


__all__ = ["Example", "MODES", "PLAYBOOK_DIR", "build_system_prompt", "load_examples", "select_examples"]
