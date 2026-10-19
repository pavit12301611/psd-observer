"""Drive a web browser in a dedicated Chromium profile, for you, while you are away.

Two job modes, both approved with one YES:

* ``arena``: submit a prompt in arena.ai Agent Mode and report the answer.
* ``research``: search the web for a question, open a few sources, and answer with the URLs.

What the model can do: read a compact view of the page (URL, title, visible text, numbered
interactive elements with their link targets) and choose ONE action per step: click, type,
press, wait, read, goto, search, ask, done. What it cannot do is decided in code:

* Pages the browser navigates to must be on the allowed sites: arena.ai only in ``arena``
  mode, any public https site in ``public`` scope. Resources a page loads from other servers
  (scripts, styles, images, sign-in widgets) are allowed, so pages render and log in.
* Nothing may reach localhost, private or link-local addresses, or single-name hosts (your
  router, NAS, and local services stay unreachable). This applies to every request.
  Checked at the network layer (``should_block_request``).
* No typing into password, one-time-code or hidden fields, and no clicks on controls
  whose label says delete, sign out, billing, purchase or similar (``check_action``).
* Downloads are accepted only into one folder, and files over the size cap are removed.
* Once started, a job runs unattended for at most ``browser_max_steps`` steps and
  ``browser_timeout_min`` minutes. Its instructions come from ``playbooks/``.

You log in to any site yourself, in the dedicated profile (``browser-login``). The agent
never sees or types your password. Websites' terms of use are your responsibility; see the
README before enabling this.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, quote_plus, urlparse

from loguru import logger

from ..llm.base import ModelProvider, sanitize_error, with_retries
from ..models import ChatMessage
from ..runtime.parse import iter_balanced_objects
from .playbooks import MODES, build_system_prompt

ARENA_URL = "https://arena.ai/agent"
DEFAULT_ALLOWED_HOSTS = ("arena.ai",)
PUBLIC_WEB = "*"                      # allowed_hosts value meaning "any public https host"
SEARCH_URL = "https://html.duckduckgo.com/html/?q={query}"
MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
MAX_PROMPT_CHARS = 800
MAX_SEARCH_CHARS = 200
MAX_SOURCES = 10
ACTION_KINDS = ("click", "type", "press", "wait", "read", "goto", "search", "ask", "done")
_PRIVATE_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet")
ALLOWED_KEYS = {"Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "Control+Enter", "Shift+Enter"}
_FORBIDDEN_LABEL = re.compile(
    r"\b(delete|remove account|deactivate|log ?out|sign ?out|billing|purchase|subscribe|upgrade|"
    r"pay|checkout|buy|cancel subscription)\b", re.IGNORECASE)
_SECRET_HINT = re.compile(r"(password|passcode|one[- ]?time|otp|2fa|verification code|secret)", re.IGNORECASE)


class BrowserUnavailable(RuntimeError):
    """Chromium or Playwright is missing. The message says how to install it."""


class BrowserJobError(RuntimeError):
    """The job ended without an answer. The message is safe to show the owner."""


# ----------------------------------------------------------------------- #
# pure rules (no browser needed)
# ----------------------------------------------------------------------- #
def is_private_host(host: str) -> bool:
    """True for names and addresses that point at this machine or your local network."""
    h = host.lower().rstrip(".")
    if not h:
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        ip = None
    if ip is not None:                       # check addresses first: IPv6 has no dots
        if ip.version == 6 and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        return not ip.is_global
    if "." not in h or h == "localhost" or h.endswith(_PRIVATE_SUFFIXES):
        return True                          # single-name hosts such as "router" or "nas" are local
    return False


def host_allowed(url: str, allowed: tuple[str, ...] | list[str] = DEFAULT_ALLOWED_HOSTS) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if PUBLIC_WEB in allowed:
        return not is_private_host(host)
    return any(host == h or host.endswith("." + h) for h in (a.lower() for a in allowed))


def scope_hosts(scope: str) -> tuple[str, ...]:
    """``public`` opens every public https site. Anything else keeps the narrow arena.ai rule."""
    return (PUBLIC_WEB,) if scope == "public" else DEFAULT_ALLOWED_HOSTS


_BLOCK_MARKERS = (
    "something unexpected happened", "not cooperating", "unusual traffic", "verify you are human",
    "are you a robot", "access denied", "captcha", "checking your browser", "just a moment",
    "enable javascript and cookies", "request blocked", "forbidden",
)


def is_blocked_page(title: str, text: str) -> bool:
    """True when a page looks like a site's block, challenge, or error page instead of content."""
    haystack = f"{title}\n{text[:1500]}".lower()
    return any(marker in haystack for marker in _BLOCK_MARKERS)


def search_url(query: str) -> str:
    return SEARCH_URL.format(query=quote_plus(query.strip()))


def unwrap_result_url(href: str) -> str:
    """Search engines wrap result links in a redirect; return the real destination."""
    try:
        parsed = urlparse(href)
    except ValueError:
        return href
    host = (parsed.hostname or "").lower()
    if host.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        if target.startswith("https://"):
            return target
    return href


def is_search_page(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("duckduckgo.com")


def should_block_request(url: str, is_navigation: bool,
                         allowed: tuple[str, ...] | list[str] = DEFAULT_ALLOWED_HOSTS) -> bool:
    """Network rule for one request.

    * Local and private addresses are blocked for every request.
    * Top-level navigations (including redirects and frames) must be on the allowed sites.
    * Other resources (scripts, styles, images, fonts, sign-in widgets) may come from any
      public https host, so pages render.
    """
    if url.startswith(("about:", "data:", "blob:")):
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return True
    if parsed.scheme != "https" or not parsed.hostname:
        return True
    if is_private_host(parsed.hostname):
        return True
    if is_navigation:
        return not host_allowed(url, allowed)
    return False


def should_block(url: str, allowed: tuple[str, ...] | list[str] = DEFAULT_ALLOWED_HOSTS) -> bool:
    """Blocks a top-level navigation to ``url`` (the rule for pages, not resources)."""
    return should_block_request(url, True, allowed)


@dataclass(frozen=True)
class Element:
    id: int
    tag: str
    type: str
    label: str
    name: str
    editable: bool
    href: str = ""

    @property
    def is_secret(self) -> bool:
        return self.type == "password" or bool(_SECRET_HINT.search(f"{self.label} {self.name}"))


@dataclass
class PageSnapshot:
    url: str
    title: str
    text: str
    elements: list[Element] = field(default_factory=list)

    def by_id(self) -> dict[int, Element]:
        return {e.id: e for e in self.elements}

    def render(self, text_limit: int = 3000, element_limit: int = 60) -> str:
        lines = [f"URL: {self.url}", f"Title: {self.title}", "Visible text:", self.text[:text_limit], "",
                 "Interactive elements:"]
        for e in self.elements[:element_limit]:
            kind = e.tag + (f"[{e.type}]" if e.type else "")
            secret = " (secret field, do not type here)" if e.is_secret else ""
            target = f" -> {e.href[:160]}" if e.href else ""
            lines.append(f'[{e.id}] {kind} "{e.label}"{secret}{target}')
        if len(self.elements) > element_limit:
            lines.append(f"... {len(self.elements) - element_limit} more elements not shown")
        return "\n".join(lines)


def parse_browser_action(raw: str) -> dict[str, Any] | None:
    for blob in iter_balanced_objects(raw or ""):
        try:
            obj = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict) or obj.get("action") not in ACTION_KINDS:
            continue
        kind = obj["action"]
        if kind in ("click", "type") and not isinstance(obj.get("id"), int):
            continue
        if kind == "type" and not isinstance(obj.get("text"), str):
            continue
        if kind == "press" and obj.get("key") not in ALLOWED_KEYS:
            continue
        if kind == "wait" and not (isinstance(obj.get("seconds"), (int, float)) and 0 < obj["seconds"] <= 60):
            continue
        if kind == "goto" and not isinstance(obj.get("url"), str):
            continue
        if kind == "search" and not (isinstance(obj.get("query"), str) and obj["query"].strip()):
            continue
        text_field = "question" if kind == "ask" else "summary"
        if kind in ("ask", "done") and not str(obj.get(text_field, "")).strip():
            continue
        return obj
    return None


def check_action(action: dict[str, Any], elements: dict[int, Element],
                 allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS) -> str | None:
    """Return a refusal reason, or None when the action may run."""
    kind = action["action"]
    if kind in ("click", "type"):
        el = elements.get(action["id"])
        if el is None:
            return f"there is no element with id {action['id']} on this page; read the page again"
        if _FORBIDDEN_LABEL.search(el.label):
            return f"clicking or typing into '{el.label}' is not allowed"
        if kind == "type":
            if el.is_secret:
                return "typing into password or verification-code fields is not allowed; the owner must do that"
            if not (el.editable or el.tag in ("input", "textarea")):
                return f"element {el.id} is not a text field"
            if len(action["text"]) > 2000:
                return "text is longer than 2000 characters"
    if kind == "goto" and not host_allowed(action["url"], allowed_hosts):
        return f"navigation to {urlparse(action['url']).hostname or 'that address'} is not allowed"
    if kind == "search":
        if len(action["query"]) > MAX_SEARCH_CHARS:
            return f"the search is longer than {MAX_SEARCH_CHARS} characters"
        if not host_allowed(search_url(action["query"]), allowed_hosts):
            return "web search is not available in this job"
    return None


_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._ -]")


def safe_filename(name: str) -> str:
    base = Path(name or "download").name
    cleaned = _UNSAFE_FILENAME.sub("_", base).strip(" .") or "download"
    return cleaned[:120]


# ----------------------------------------------------------------------- #
# browser session
# ----------------------------------------------------------------------- #
class BrowserSession(Protocol):
    downloads: list[str]

    def goto(self, url: str) -> None: ...
    def snapshot(self) -> PageSnapshot: ...
    def click(self, element_id: int) -> None: ...
    def type_text(self, element_id: int, text: str) -> None: ...
    def press(self, key: str) -> None: ...
    def wait(self, seconds: float) -> None: ...
    def close(self) -> None: ...


SNAPSHOT_JS = """() => {
  document.querySelectorAll('[data-obs-id]').forEach(e => e.removeAttribute('data-obs-id'));
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=tab],[contenteditable=true]';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    n += 1;
    el.setAttribute('data-obs-id', String(n));
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText ||
                   el.value || el.getAttribute('title') || el.getAttribute('name') || '')
                  .replace(/\\s+/g, ' ').trim().slice(0, 80);
    const href = el.tagName === 'A' ? (el.href || '').slice(0, 300) : '';
    out.push({id: n, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(),
              label, name: (el.getAttribute('name') || '').toLowerCase(), editable: !!el.isContentEditable,
              href});
    if (n >= 80) break;
  }
  return {url: location.href, title: document.title,
          text: (document.body ? document.body.innerText : '').slice(0, 4000), elements: out};
}"""


class PlaywrightSession:
    """A persistent Chromium profile, network-restricted to the allowed hosts."""

    def __init__(self, *, profile_dir: Path, downloads_dir: Path, executable: str | None = None,
                 headless: bool = False, allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS,
                 timeout_ms: int = 30_000) -> None:
        self.profile_dir = Path(profile_dir)
        self.downloads_dir = Path(downloads_dir)
        self.executable = executable or find_chromium()
        self.headless = headless
        self.allowed_hosts = tuple(allowed_hosts)
        self.timeout_ms = timeout_ms
        self.downloads: list[str] = []
        self._pw: Any = None
        self._ctx: Any = None
        self._page: Any = None
        self._elements: dict[int, Element] = {}

    # ------------------------------------------------------------------ #
    def open(self) -> "PlaywrightSession":
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise BrowserUnavailable("Playwright is not installed (pip install playwright)") from exc
        if not self.executable:
            raise BrowserUnavailable("no Chromium found; install it with: sudo dnf install --needed chromium")
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        for private in (self.profile_dir, self.downloads_dir):
            try:
                os.chmod(private, 0o700)   # the profile holds your arena.ai login cookies
            except OSError:  # pragma: no cover
                pass
        self._pw = sync_playwright().start()
        try:
            self._ctx = self._pw.chromium.launch_persistent_context(
                str(self.profile_dir),
                executable_path=self.executable,
                headless=self.headless,
                accept_downloads=True,
                viewport={"width": 1280, "height": 900},
            )
        except Exception as exc:
            self.close()
            raise BrowserUnavailable(f"Chromium did not start: {sanitize_error(exc)}") from exc
        self._ctx.set_default_timeout(self.timeout_ms)
        self._ctx.route("**/*", self._route)
        self._ctx.on("page", self._attach_page)
        pages = self._ctx.pages
        self._page = pages[0] if pages else self._ctx.new_page()
        self._attach_page(self._page)
        return self

    def _route(self, route: Any, request: Any) -> None:
        if should_block_request(request.url, bool(request.is_navigation_request()), self.allowed_hosts):
            logger.debug("browser: blocked request to {}", urlparse(request.url).hostname or "?")
            route.abort()
        else:
            route.continue_()

    def _attach_page(self, page: Any) -> None:
        page.on("download", self._on_download)

    def _on_download(self, download: Any) -> None:
        target = self.downloads_dir / f"{int(time.time())}-{safe_filename(download.suggested_filename)}"
        try:
            download.save_as(str(target))
            if target.stat().st_size > MAX_DOWNLOAD_BYTES:
                target.unlink(missing_ok=True)
                logger.warning("arena download removed: larger than the size cap")
                return
            self.downloads.append(target.name)
        except Exception as exc:
            logger.warning("arena download failed: {}", sanitize_error(exc))

    # ------------------------------------------------------------------ #
    def goto(self, url: str) -> None:
        if not host_allowed(url, self.allowed_hosts):
            raise BrowserJobError("navigation outside the allowed hosts")
        self._page.goto(url, wait_until="domcontentloaded")

    def snapshot(self) -> PageSnapshot:
        data = self._page.evaluate(SNAPSHOT_JS)
        elements = [Element(id=int(e["id"]), tag=e["tag"], type=e.get("type", ""), label=e.get("label", ""),
                            name=e.get("name", ""), editable=bool(e.get("editable")),
                            href=unwrap_result_url(str(e.get("href") or "")))
                    for e in data.get("elements", [])]
        self._elements = {e.id: e for e in elements}
        return PageSnapshot(url=data.get("url", ""), title=data.get("title", ""),
                            text=data.get("text", ""), elements=elements)

    def _locator(self, element_id: int) -> Any:
        return self._page.locator(f'[data-obs-id="{int(element_id)}"]').first

    def click(self, element_id: int) -> None:
        self._locator(element_id).click()

    def type_text(self, element_id: int, text: str) -> None:
        el = self._elements.get(element_id)
        loc = self._locator(element_id)
        if el is not None and el.tag in ("input", "textarea"):
            loc.fill(text)
        else:
            loc.click()
            self._page.keyboard.insert_text(text)

    def press(self, key: str) -> None:
        self._page.keyboard.press(key)

    def wait(self, seconds: float) -> None:
        time.sleep(max(0.0, min(float(seconds), 60.0)))

    def wait_until_closed(self, poll_s: float = 1.0) -> None:
        """Block while you use the window (login). Returns when every page is closed."""
        while self._ctx is not None:
            try:
                if not self._ctx.pages:
                    return
            except Exception:  # the browser went away
                return
            time.sleep(poll_s)

    def close(self) -> None:
        try:
            if self._ctx is not None:
                self._ctx.close()
        except Exception:  # pragma: no cover - best effort on shutdown
            pass
        try:
            if self._pw is not None:
                self._pw.stop()
        except Exception:  # pragma: no cover
            pass
        self._ctx = self._pw = self._page = None

    def __enter__(self) -> "PlaywrightSession":
        return self.open()

    def __exit__(self, *exc: Any) -> None:
        self.close()


def find_chromium() -> str | None:
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        path = shutil.which(name)
        if path:
            return path
    return None


# ----------------------------------------------------------------------- #
# the job loop
# ----------------------------------------------------------------------- #
@dataclass
class JobResult:
    summary: str
    downloads: list[str]
    sources: list[str] = field(default_factory=list)


def run_browser_job(prompt: str, *, session: BrowserSession, provider: ModelProvider,
                    ask: Callable[[str], str | None], say: Callable[[str], None],
                    mode: str = "arena", max_steps: int = 40, timeout_s: float = 1800.0,
                    clock: Callable[[], float] = time.monotonic,
                    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS) -> JobResult:
    if mode not in MODES:
        raise BrowserJobError(f"unknown job mode: {mode}")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise BrowserJobError(f"the prompt is longer than {MAX_PROMPT_CHARS} characters")
    deadline = clock() + timeout_s
    if mode == "research":
        if not host_allowed(search_url(prompt), allowed_hosts):
            raise BrowserJobError('web research needs whatsapp.browser_scope = "public"')
        session.goto(search_url(prompt))
        goal_text = f"Owner's research question (answer it from web sources, cite the URLs):\n{prompt}"
    else:
        session.goto(ARENA_URL)
        goal_text = f"Owner's prompt for Arena Agent Mode (type it exactly):\n{prompt}"
    system = ChatMessage(role="system", content=build_system_prompt(mode, prompt))
    goal = ChatMessage(role="user", content=goal_text)
    history: list[ChatMessage] = []
    sources: list[str] = []
    for step in range(1, max_steps + 1):
        if clock() > deadline:
            raise BrowserJobError("the time limit for this job was reached")
        snap = session.snapshot()
        if mode == "research" and snap.url.startswith("https://") and not is_search_page(snap.url):
            if snap.url not in sources and len(sources) < MAX_SOURCES:
                sources.append(snap.url)
        observation = ChatMessage(role="user", content=f"Step {step}. Current page:\n{snap.render()}")
        history = (history + [observation])[-6:]
        messages = [system, goal, *history]
        raw = with_retries(lambda: provider.chat(messages))
        history.append(ChatMessage(role="assistant", content=raw))
        action = parse_browser_action(raw)
        if action is None:
            history.append(ChatMessage(role="user", content="Not a valid action. Reply with one JSON object."))
            continue
        kind = action["action"]
        if kind == "done":
            return JobResult(summary=str(action["summary"]).strip(), downloads=list(session.downloads),
                             sources=sources)
        if kind == "ask":
            answer = ask(str(action["question"]).strip())
            if answer is None:
                raise BrowserJobError("stopped by the owner")
            history.append(ChatMessage(role="user", content=f"Owner answered: {answer}"))
            continue
        if kind == "read":
            continue
        if kind == "wait":
            session.wait(float(action["seconds"]))
            continue
        refusal = check_action(action, snap.by_id(), allowed_hosts)
        if refusal:
            history.append(ChatMessage(role="user", content=f"Refused: {refusal}."))
            continue
        if kind == "click":
            session.click(action["id"])
        elif kind == "type":
            session.type_text(action["id"], action["text"])
            say(f"⌨️ typed on the page: {action['text'][:200]}")
        elif kind == "press":
            session.press(action["key"])
        elif kind == "goto":
            session.goto(action["url"])
            say(f"🌐 opened {urlparse(action['url']).hostname}")
        elif kind == "search":
            session.goto(search_url(action["query"]))
            say(f"🔎 searched: {action['query'][:120]}")
    raise BrowserJobError(f"the job did not finish within {max_steps} steps")


__all__ = ["ARENA_URL", "PUBLIC_WEB", "BrowserSession", "BrowserUnavailable", "BrowserJobError", "PageSnapshot",
           "Element", "PlaywrightSession", "run_browser_job", "parse_browser_action", "check_action",
           "host_allowed", "is_private_host", "is_blocked_page", "scope_hosts", "search_url", "unwrap_result_url", "should_block",
           "should_block_request",
           "safe_filename", "find_chromium", "JobResult", "MAX_PROMPT_CHARS", "MODES"]
