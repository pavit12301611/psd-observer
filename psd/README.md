# PSD

Your own agent — on your machine. One brain behind three faces:

* **the notch** — a fifth tab in your GNOME extension, plus the closed pill that says `PSD working…`
* **your phone** — an installable web app with the same streaming answers
* **WhatsApp** — the existing agent, upgraded: it now answers through PSD's tools and skills

Everything runs on `127.0.0.1`. No account, no cloud, no key to paste. It answers
in single-digit milliseconds when it doesn't need a model, and it uses a local
model (or one you already pay for) when it does.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/pavit12301611/psd-observer/main/psd/install.sh | bash
```

Add `--with-deps` to let it `sudo dnf install` the desktop toolkit
(`grim`, `wmctrl`, `libnotify`, `wl-clipboard`, `playerctl`, `ydotool`):

```bash
curl -fsSL https://raw.githubusercontent.com/pavit12301611/psd-observer/main/psd/install.sh \
  | bash -s -- --with-deps
```

The installer checks Node 20.19+, downloads the tree, installs to
`~/.local/share/psd`, puts `psd` and `psd-proxy` in `~/.local/bin`, installs the
notch extension **over** the one you have (backing it up first), enables
`psd-agent.service`, and then proves it works: an intent answer, the SSE stream
the notch consumes, and the OpenAI-compatible surface.

## Use

```bash
psd                              # interactive
psd "what is eating my disk"     # one shot
psd status                       # daemon, brain, surfaces
psd doctor                       # what works here, and the exact fix
psd agents | skills              # what it loads from disk
psd url                          # app links for this PC and your phone
psd-proxy                        # the phone app on :7789
```

In the notch: open it, choose **PSD**. Type, or use a chip. While it is thinking,
the closed pill reads `PSD working…` and springs back when the answer lands.
Preferences → **Agent (PSD)** holds the URL, the token, and a *Test the
connection* button.

On the phone: run `psd-proxy` on the PC, open `http://<pc-ip>:7789`, then *Add to
Home Screen*. The token never leaves the PC. Away from home, `tailscale serve --bg
7789` makes that URL reachable from anywhere on your tailnet.

## WhatsApp

```bash
bash scripts/psd.sh whatsapp
```

It prints the four lines to paste into `whatsapp-agent/.env`:

```ini
LOCAL_API_URL=http://127.0.0.1:7788/v1
LOCAL_MODEL=psd
LOCAL_API_KEY=<your token>
AI_PROVIDER=local
```

The agent keeps its own fast, deterministic commands. Anything else — a real
question, a task that needs your machine — goes to PSD through the standard
OpenAI wire format, so any client that speaks OpenAI works the same way:
`openai`, OpenJarvis, LangChain, `curl`.

## What it can do

36 tools, gated by `PSD_ACCESS=safe|standard|full`:

* **machine** — `system_status`, `disk_space`, `top_processes`, `list_apps`, `list_windows`, `screenshot`, `clipboard`
* **files** — `ls`, `read_file`, `find_files`, `write_file` (confined to `ALLOW_ROOTS`)
* **shell** — only when enabled (`PSD_SHELL=1`), with a confirm token and a TTL
* **media** — `music_play_pause`, `volume`, `media_status`
* **desk** — `notify`, `open_url`, `notch_send`
* **memory** — `remember`, `recall`, `forget`, `remind`, `reminders`
* **agents** — `list_agents`, `use_agent`, `list_skills`, `use_skill` (OpenJarvis-style `AGENT.md` + `SKILL.md` on disk)
* **bridge** — `whatsapp_send`, `whatsapp_status`

Paths: intents first (deterministic, ~10 ms), then a local model, then a cloud
model if you configured one. The path taken is always shown with the answer.

## Speed

Measured on the reference machine, no model loaded:

| request | time |
| --- | --- |
| `disk space` (tool) | 10 ms |
| `remind me in 30m` (memory + content) | 10 ms |
| `system status` (multi-tool) | 130 ms |
| notch stream, first frame | < 20 ms |

The stream sends `start` before the work begins, so the notch is animating while
the answer is still being assembled.

## Security

* A browser request from a foreign origin is refused with `403` — before auth.
  That is what stops a random page from driving your machine.
* Tokens arrive as `authorization: Bearer`, `x-psd-token`, or `?token=` (the last
  only from a non-browser client).
* Loopback clients with no `Origin` (the notch, the CLI, the proxy) are trusted;
  anything off-box always needs the token.
* CORS headers are only echoed for origins you list in `PSD_CORS_ORIGIN`.
* The phone proxy drops the phone's `Origin` and adds the token itself, so the
  phone never holds a secret.

## Configuration

`~/.config/psd/env` (plain `KEY=VALUE`, read by the service):

| key | default | meaning |
| --- | --- | --- |
| `PSD_PORT` | `7788` | listen port |
| `PSD_HOST` | `127.0.0.1` | bind address |
| `PSD_TOKEN` | generated | shared secret |
| `PSD_ACCESS` | `standard` | `safe`, `standard`, `full` |
| `PSD_SHELL` | `0` | allow the shell tool |
| `PSD_CORS_ORIGIN` | *(empty)* | allowlist, comma separated |
| `ALLOW_ROOTS` | home | file-tool roots |
| `PSD_MODEL` | `qwen3:8b` | local model |
| `PSD_OPENAI_URL` / `_KEY` / `_MODEL` | — | use a cloud brain instead |
| `PSD_WHATSAPP_URL` / `_TOKEN` | `127.0.0.1:8787` | the WhatsApp agent |

## Tests

```bash
npm test        # 23 tests: protocol, engine, server, auth, tools, UI (jsdom)
cd notch && npm test   # 27 tests: geometry, layout, the PSD client
bash scripts/test-integration.sh   # live: daemon, SSE, OpenAI, notch, memory
```

`test/ui.test.js` runs the real `web/app.js` in a DOM against a real server: it
sends a message, consumes the stream, and asserts the answer reached the screen.

## Uninstall

```bash
bash scripts/psd.sh uninstall     # keeps your memory and the extension
```
