"""Manual arena.ai mode: the observer opens the site and copies the prompt; it never drives the page."""

from observer_core.remote import manual


def test_both_work_reports_paste_instruction(monkeypatch):
    monkeypatch.setattr(manual, "copy_to_clipboard", lambda t: True)
    monkeypatch.setattr(manual, "open_url", lambda u: True)
    msg = manual.open_arena_by_hand("hello")
    assert "copied the prompt" in msg and "Ctrl+V" in msg


def test_no_clipboard_shows_prompt_to_copy_by_hand(monkeypatch):
    monkeypatch.setattr(manual, "copy_to_clipboard", lambda t: False)
    monkeypatch.setattr(manual, "open_url", lambda u: True)
    msg = manual.open_arena_by_hand("hello there")
    assert "could not copy" in msg and "hello there" in msg


def test_no_browser_gives_the_link(monkeypatch):
    monkeypatch.setattr(manual, "copy_to_clipboard", lambda t: True)
    monkeypatch.setattr(manual, "open_url", lambda u: False)
    msg = manual.open_arena_by_hand("hi")
    assert "https://arena.ai/agent" in msg


def test_nothing_works_still_returns_prompt(monkeypatch):
    monkeypatch.setattr(manual, "copy_to_clipboard", lambda t: False)
    monkeypatch.setattr(manual, "open_url", lambda u: False)
    msg = manual.open_arena_by_hand("abc")
    assert "https://arena.ai/agent" in msg and "abc" in msg


def test_open_url_without_xdg_open_returns_false(monkeypatch):
    monkeypatch.setattr(manual.shutil, "which", lambda name: None)
    assert manual.open_url("https://arena.ai/agent") is False
