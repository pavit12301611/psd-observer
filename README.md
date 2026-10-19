# Observer Core

A **local-first, Fedora-native** rebuild of the core loop of
[Observer AI](https://github.com/Roy3838/Observer) (Roy3838, AGPL-3.0).

Define small **agents** that keep an eye on your **screen, camera, microphone,
system audio or clipboard**, ask a **model you run yourself** to interpret what
they see, and **act** when the condition is met: a desktop notification, a
message (Telegram, Discord, WhatsApp, SMS, phone call, email, Pushover), a
persistent memory, a short screen clip, or a webhook.

> Concept after Observer AI by Roy3838 (https://github.com/Roy3838/Observer),
> AGPL-3.0. Observer Core is an independent Python reimplementation; it shares
> no code with the upstream project.

---

## Contents

- [Status: what is verified and what is not](#status-what-is-verified-and-what-is-not)
- [Install and first run (Fedora)](#install-and-first-run-fedora)
- [Model setup](#model-setup)
- [Sensors](#sensors)
- [Wayland: read this first](#wayland-read-this-first)
- [Credentials](#credentials)
- [Agents: wizard, YAML and JSON](#agents-wizard-yaml-and-json)
- [WhatsApp remote](#whatsapp-remote)
  - [Routines and timers](#routines-and-timers)
  - [Browser jobs: arena.ai and web research](#browser-jobs-arenaai-and-web-research)
- [Headless daemon and systemd](#headless-daemon-and-systemd)
- [Command reference](#command-reference)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Project layout](#project-layout)
- [License and attribution](#license-and-attribution)

---

## Status: what is verified and what is not

Observer Core was built and checked in a headless Debian 12 sandbox with Python
3.11, because Fedora and a display were not available there. Be aware of this
split:

| Area | State |
|---|---|
| Config, data model, YAML/JSON agent import/export, secrets masking | Covered by tests |
| Prompt assembly, `$TOKEN` substitution, robust response parsing | Covered by tests |
| Agent runtime, scheduler (jitter, timeouts, back-off, semaphore), memory, frame ring buffer | Covered by tests |
| Providers (Ollama, OpenAI-compatible, cloud gate) | Covered by `httpx.MockTransport` tests, plus a live cycle against a fake Ollama HTTP server |
| Tools: credential validation, dispatch, privacy kill-switch, sandboxed Python | Covered by tests |
| `run.sh`: syntax, flags, exit codes, idempotent second run, venv, pip, config, `--doctor`, `--daemon` | Exercised end to end (dnf step not exercised: no dnf here) |
| Daemon: launches, degrades gracefully with no display/OCR, SIGINT → clean shutdown, exit 0 | Exercised end to end |
| Network behaviour during a monitoring run | Checked from `/proc`: no TCP connections to non-loopback endpoints in a 40 s window |
| **PyQt6 GUI** (window, sensor previews, editor, wizard, tray, settings) | **Written and statically checked (pyflakes, compile), but not run.** The sandbox lacks `libGL`, and apt is unreachable. A Qt smoke test exists and runs where Qt loads. |
| **Wayland screen capture via the portal (ScreenCast + PipeWire)** | **Not implemented in full.** See [Wayland](#wayland-read-this-first). |
| **WhatsApp remote** (commands, YES/NO approval, bounded loop, owner gate, shell limits, account-mismatch refusal) | Covered by fakes in `tests/test_remote.py`. **Not run against WhatsApp:** the sandbox has no route to it. See [WhatsApp remote](#whatsapp-remote). |
| **WhatsApp routines, timers, browser jobs (arena.ai and web research)** | Covered by fakes in `tests/test_remote_features.py` and `tests/test_public_browser.py` (parsing, scheduling, step limits, local-network block, refused clicks and passwords, search and research flow on fake pages, playbook examples validated). **Not run live:** no Chromium or Playwright in the build sandbox, and no WhatsApp or search-engine route. See [Routines and timers](#routines-and-timers) and [Browser jobs](#browser-jobs-arenaai-and-web-research). |
| Local Whisper transcription, llama.cpp in-process, clip recording on Wayland | Optional paths, present but not exercised here |

Run `./run.sh` on a real Fedora 40–42 machine to confirm the GUI. If something
in the GUI misbehaves, `./run.sh --doctor` and the Diagnostics tab tell you what
is missing.

---

## Install and first run (Fedora)

Requirements: Fedora Workstation 40, 41 or 42 (x86_64), Python 3.12 or 3.13,
and `sudo` for the one-time system packages.

```bash
git clone https://github.com/pavit12301611/psd-observer.git
cd psd-observer
./run.sh
```

`./run.sh` does this, in order, and each step is idempotent:

1. Detects OS, session type (X11, Wayland or headless) and Python ≥ 3.12.
2. `sudo dnf install -y --needed` the packages in `requirements-system-fedora.txt`.
   If one package is not available on your release, the script retries one by one,
   warns about optional ones, and stops only for critical ones (exit 2).
3. Checks for Ollama. It is **never installed silently**; the script prints the
   install command.
4. Creates the virtualenv at `<repo>/.venv` (`OBSERVER_CORE_VENV` overrides this).
5. Installs `requirements.txt` and registers the `observer-core` console scripts.
6. Creates the XDG directories and a starter `config.toml` (mode 600). An existing
   file is never overwritten.
7. Preflight: imports PyQt6, checks for a display.
8. Launches the GUI (`exec`, so signals reach the app directly).

A second run takes about a tenth of a second when nothing has changed.

| Flag | Effect |
|---|---|
| `--setup` | Install only; do not launch |
| `--reinstall` | Recreate the venv and reinstall pip deps (only inside a real venv) |
| `--no-system-deps` | Skip dnf (containers, rootless, CI) |
| `--with-ollama` | Also install Ollama (`curl -fsSL https://ollama.com/install.sh \| sh`) and enable `ollama.service` |
| `--skip-pip` | Only system packages |
| `--doctor` | After setup, print the environment report and exit |
| `--daemon` | Run headless instead of the window |
| `--dev` | Run from the source tree (`PYTHONPATH` set) |
| `--version`, `-h` | Print and exit |

Exit codes: `0` ok · `1` failure · `2` missing system dependency that blocks
launch · `3` Python too old.

Environment overrides: `OBSERVER_CORE_VENV`, `DNF` (the dnf binary), and
`OBSERVER_CORE_MIN_PY` (testing only).

**Without sudo** (a container, or a locked-down account), run
`./run.sh --no-system-deps` and install the listed packages yourself. The script
prints the exact `dnf` line.

---

## Model setup

Observer Core talks to any of four backends. Pick one in **Settings → Models**
or per agent in the **Configuration** tab.

### Ollama (recommended)

```bash
./run.sh --with-ollama          # or install from https://ollama.com
ollama pull qwen2.5vl:7b        # a vision model, for screen and camera agents
ollama pull llama3.2            # a text model, for OCR and audio agents
```

Endpoint: `http://127.0.0.1:11434`. Default provider: `ollama`.

### llama.cpp (`llama-server`)

```bash
llama-server -m ~/models/qwen2.5-vl-7b-instruct-q4_k_m.gguf \
             --mmproj ~/models/mmproj-qwen2.5-vl-7b.gguf --port 8080
```

Use provider `openai_compat`, endpoint `http://127.0.0.1:8080/v1`. Drop the
`--mmproj` flag for text-only models.

### vLLM or LM Studio

Start the OpenAI-compatible server (vLLM's `vllm serve <model>`, or LM Studio's
local server). Use provider `openai_compat` with that server's `/v1` endpoint.

### In-process llama.cpp (optional)

`pip install llama-cpp-python`, then provider `llamacpp_local` with
`extra.model_path` pointing at a GGUF file (and `extra.mmproj` for vision).
This is optional and not installed by default.

### Cloud (opt-in, labelled)

Cloud providers are **refused** unless you turn on **Settings → Privacy → Allow
cloud models** (or click the lock in the top bar to unlock it). An agent that
uses one shows a red banner. The API key is read from the environment variable
named in `api_key_env`, never from the agent file.

---

## Sensors

| Sensor | Token | Needs |
|---|---|---|
| Screen | `$SCREEN` | X11: `mss`. Wayland: see below. |
| Screen OCR | `$SCREEN_OCR` | `tesseract` and `tesseract-langpack-eng` |
| Camera | `$CAMERA` | A `/dev/video*` device, and your user in the `video` group |
| Clipboard | `$CLIPBOARD` | `wl-clipboard` (Wayland) or `xclip`/`xsel` (X11) |
| Microphone | `$MICROPHONE` | PortAudio (`portaudio`) and a PipeWire/ALSA input |
| System audio | `$SCREEN_AUDIO` | `pulseaudio-utils` (`parec`) or `pipewire-utils` (`pw-record`) |
| Mic + system | `$ALL_AUDIO` | Both of the above |

The **Sensor Control** panel shows every sensor with a status pill and the exact
reason when it is unavailable. Image sensors show a live preview (throttled to
5 FPS, downscaled to 640 px). Audio sensors show a level meter in dBFS.
**Test capture** takes one sample and reports the result in the console.

Speech transcription is optional. If `faster-whisper` (or a whisper.cpp CLI via
`OBSERVER_WHISPER_CLI`) is present, audio is transcribed locally. Otherwise the
sensor degrades to an energy level and says so.

Agents that cannot capture anything do not call the model. They are marked
**degraded**, the reason is logged, and the loop keeps running.

---

## Wayland: read this first

On GNOME and KDE under Wayland, arbitrary screen capture is gated by the
desktop. Observer Core is honest about this:

- **Detection.** Session type comes from `WAYLAND_DISPLAY`, `DISPLAY` and
  `XDG_SESSION_TYPE`. The chosen screen backend and the reason are logged once.
- **X11 and XWayland.** `mss` is used when it can grab the screen.
- **Portal fallbacks.** If `mss` cannot grab the Wayland screen, the app uses
  KDE `spectacle` or GNOME `gnome-screenshot` when they are installed. Both are
  one-shot screenshot tools and are portal-independent.
- **Permission.** When nothing works, the screen status reads
  **"portal permission required"** and the top bar offers **Grant screen capture**,
  which re-runs the capture path. The app never fails to start because of this.

**Known gap.** The full `xdg-desktop-portal` ScreenCast flow (a PipeWire stream
consumed in-process) is **not implemented**. It needs GStreamer or PipeWire
bindings. Screen agents on pure Wayland therefore depend on the fallbacks above
or on running under XWayland. Clip recording (`record_clip`) is X11-only for the
same reason. Fixing this is the top item on the roadmap.

---

## Credentials

Credentials live in `$XDG_CONFIG_HOME/observer-core/config.toml`
(`~/.config/observer-core/config.toml`), written with mode **0600** inside a
**0700** directory. Generate a commented skeleton with:

```bash
observer-core init-config        # never overwrites an existing file
```

Environment variables **always win** over the file, so you can keep secrets out
of it entirely:

| Channel | Variables | Config keys |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `telegram.bot_token`, `telegram.chat_id` |
| Discord | `DISCORD_WEBHOOK_URL` | `discord.webhook_url` |
| Twilio (WhatsApp, SMS, calls) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | `twilio.*` |
| SMTP email | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` | `smtp.*` |
| SendGrid | `SENDGRID_API_KEY` | `sendgrid.api_key` |
| Pushover | `PUSHOVER_TOKEN`, `PUSHOVER_USER` | `pushover.*` |

Agent files can refer to config values: `chat_id: "${telegram.chat_id}"`.

**Secrets are never logged.** Log lines, event payloads and exports pass through
a redactor, and `observer-core doctor` masks values. The GUI shows credential
fields as password inputs.

To test a channel, use **Settings → Notifications → Send test**, or
`observer-core notify-test telegram`. This needs no model.

---

## Agents: wizard, YAML and JSON

**New agent → "What do you want me to Observe?"** Pick a *When* (fifteen
presets, such as *distracted*, *3D printer fails*, *battery low*, *tickets
available*, *download finished*, *GitHub workflow finishes*, *meeting starts*) and a
*Then* channel (desktop notification, Telegram, Discord, WhatsApp, SMS, phone
call, email, or log). Add your own words to refine the condition. The agent is
created **disabled**, so you can review it first.

Agents are plain YAML or JSON and can be imported and exported from the agent
list. The bundled examples live in `examples/agents/`:

```yaml
id: "github-workflow"
name: "GitHub workflow finished"
enabled: true
loop_interval_s: 30
model:
  provider: ollama
  endpoint: "http://127.0.0.1:11434"
  model: "qwen2.5vl:7b"
  supports_vision: true
sensors:
  - kind: screen
  - kind: screen_ocr
    options: { lang: "eng" }
system_prompt: |
  You are a monitoring agent. If a GitHub Actions workflow has reached a terminal
  state, respond {"triggered": true, "actions": [{"tool":"telegram","args":{"text":"..."}}]}.
  Otherwise respond exactly: {"triggered": false}
tools:
  - kind: telegram
    options: { chat_id: "${telegram.chat_id}" }
  - kind: memory
```

The model is asked for one JSON object with `triggered`, `reason`, `actions`,
`memory` and `confidence`. Responses are parsed defensively. Balanced JSON comes
first, then fenced blocks, then a loose `triggered: true` form, then the
`trigger_phrase`. Unknown tools are ignored and logged. Malformed output never
stops the loop.

**Tokens.** `$SCREEN` and `$CAMERA` attach the image to the message. Text tokens
(`$SCREEN_OCR`, `$CLIPBOARD`, `$MICROPHONE`, `$SCREEN_AUDIO`, `$ALL_AUDIO`) become
fenced text blocks. An unknown `$TOKEN` stays literal and raises a warning. If you
write no tokens at all, the enabled sensors are attached automatically.

**Run cycle now** in the *Preview & Test* tab shows the exact prompt, the raw
reply, the parsed plan and each action's result. Enable **Dry run** to skip the
model and the actions.

**`run_python` is off by default.** Turn it on per agent with `allow_python`. It
runs in a separate process with a 10-second CPU limit, a 256 MB memory limit, a
clean environment, a temporary working directory, and no network namespace where
`unshare` is available. A substring filter also rejects common network and
process imports. **That filter is a best-effort guard, not a security boundary.**
Keep `run_python` off unless you have read the snippets an agent will run.

---

## WhatsApp remote

Message the agent from your phone; it works on this computer and replies on WhatsApp when it is done.

```text
you (9528923866)  ──WhatsApp──▶  agent number (8859555795, linked to this computer)
                                    │  local model proposes ONE shell command
                                    ▼
                         "I want to run:  df -h /   Reply YES or NO"
you ──YES──▶ command runs (as your user, 120 s limit) ──▶ result fed back to the model
                                    ▼
                         "✅ Disk has 40% free."
```

### Set it up (once)

1. `./run.sh` (installs the `neonize` WhatsApp library and Fedora's `file-libs`, which provides libmagic).
2. Save the two numbers. Indian mobiles work with 10 digits; the country code defaults to 91:
   ```bash
   .venv/bin/observer-core whatsapp setup --agent 8859555795 --allow 9528923866
   ```
3. Link the agent number to this computer: `.venv/bin/observer-core whatsapp pair`, then on the phone that has **8859555795**: WhatsApp → Linked devices → Link a device, and scan the QR code shown in the terminal. Pairing fails if the scanned account is not the agent number.
4. Keep the listener running: `.venv/bin/observer-core whatsapp run` (Ctrl-C to stop). It sends "🟢 Observer is online" to 9528923866 when connected.

### Use it

From **9528923866**, send a message to the **8859555795** chat:

| You send | What happens |
|---|---|
| `how much disk space is free?` | the model proposes a command, you get a `YES / NO` prompt |
| `YES` / `NO` | run or cancel the pending command |
| `STOP` | cancel the current task |
| `STATUS` | show how to use it |
| `ROUTINES` | list the routines in `routines.toml` |
| `RUN <name>` / `RUN <name> IN 5 MIN` | run a routine now, or in 5 minutes (one YES approves it) |
| `TIMERS` / `CANCEL <id>` | list scheduled routines, or cancel one |
| `ARENA: <prompt>` | ask arena.ai to do a job in the agent's own browser (only if enabled) |
| `RESEARCH: <question>` | search the web in the agent's browser and reply with an answer and sources (only if enabled) |

Messages from any other number are ignored without a reply. Messages in group chats are ignored. The agent works on one instruction at a time, and gives up after `max_steps` (default 10) model steps.

If the model needs information it asks you a question, and your next message is the answer. If no reply arrives within 10 minutes (`confirm_timeout_s`), the task stops and nothing runs.

### Routines and timers

A **routine** is a short, fixed list of steps you write yourself in `routines.toml` in the config directory (`~/.config/observer-core/routines.toml`). The agent can only run what is written there. `setup` creates an example file if none exists.

```toml
[[routine]]
name = "home"
description = "Desk ready when I get home"
steps = [
  { open_app = "firefox" },
  { open_url = "https://arena.ai/agent" },
  { notify = "Welcome home. Desk is ready." },
]
```

Step types (exactly one per step): `open_app` (an installed program, no arguments), `open_url` (http or https), `run` (one exact shell command, 120 s limit), `notify` (a WhatsApp message to you, up to 300 characters), and `wait` (0 to 300 seconds). Limits: 20 steps per routine, 50 routines.

- `RUN home` asks for a YES and then runs it. `RUN home IN 5 MIN` asks for a YES and then schedules it. One YES covers that run.
- A timer fires only if Observer is running at that time. Timers more than 15 minutes late (computer asleep, Observer stopped) are skipped, and you get a notice. Maximum delay is 12 hours.
- Timers are kept in `timers.json` in the data directory, so they survive a restart of `whatsapp run`.
- Steps stop at the first failure, and the result is sent back to WhatsApp.

Check the file with `observer-core whatsapp routines`. It exits 1 if anything is wrong.

### Browser jobs: arena.ai and web research

Off by default. Set `browser_enabled = true` under `[whatsapp]` in `config.toml`, then run `observer-core whatsapp browser-login` once so you can log in where you need to. The agent drives a Chromium window you can watch.

Two job types, and each starts with one YES after the full prompt or question is shown:

- **Research** (`RESEARCH: <question>`, or the model chooses it when you ask it to look something up). The agent searches the web (DuckDuckGo), opens two to four reliable sources, and replies with a short answer plus the URLs it used.
- **arena.ai** (`ARENA: <prompt>`). The agent submits your prompt in Arena Agent Mode, waits for the answer, and reports it. In this mode, pages the browser opens must be on arena.ai. A page may still load images and scripts from other servers, which arena.ai needs in order to work.

Scope is set by `browser_scope`:

- `public` (default): any public `https` site. Local and private addresses are blocked: `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link-local and cloud metadata addresses (`169.254.x.x`), IPv6 local addresses, and single-name hosts such as `router` or `nas`. Your router, NAS, and local services stay unreachable.
- `arena`: the browser may only open arena.ai pages. Other servers can still supply a page's scripts and images.

In both scopes, local and private addresses are blocked for every request. `browser-login` always uses the public rule, so sign-in redirects to other providers work. You log in yourself.

Rules enforced in code, whatever the model says:

- Passwords, one-time codes, and hidden fields are never typed into. A login page is handed back to you.
- Clicks and typing on controls labelled delete, remove account, deactivate, log out, sign out, billing, purchase, subscribe, upgrade, pay, checkout, buy, or cancel subscription are refused.
- Prompts and questions are at most 800 characters; searches at most 200.
- Each job has at most `browser_max_steps` (default 40) model steps and `browser_timeout_min` (default 30) minutes.
- Downloads go to one folder. A file over 50 MB is deleted after it is saved.
- If the model needs information, it asks you on WhatsApp and waits for your reply.

**Instructions and examples.** The job reads its instructions from `observer_core/remote/playbooks/`. You can edit them, and the next job uses your changes. Nothing needs retraining:

- `system.md`: the action format and the rules that always apply.
- `arena.md`, `research.md`: the steps for each job type.
- `examples.jsonl`: 14 worked examples (a page and the correct next action). The three closest to your request are added to each job, within a fixed size budget. The examples show the format only. A test checks that each one is valid against the same rules the browser enforces.

These are instructions, not trained weights. "Training" in this release means curating these files. It does not change the model's weights.

**Choosing a model.** A browser job needs a model that reliably returns one JSON object per step, and speed matters because every step reads the page again. Run:

```bash
observer-core whatsapp model-advice
```

It reads your RAM and any NVIDIA GPU, suggests an Ollama model, and prints the commands. It changes nothing. As a rough guide: 6 GB or more of GPU memory, or 16 GB or more of RAM, gets `qwen2.5:7b`. 8 to 15 GB of RAM gets `qwen2.5:3b`. Less than that gets `qwen2.5:1.5b`, which makes more mistakes. A cloud model is faster and stronger, but your WhatsApp messages and the text of every page the agent reads go to that provider.

Terms: many websites, including arena.ai, restrict automated access in their terms of use. arena.ai's terms (last updated 2026-02-23) allow personal or internal business use only and prohibit use "in any way not expressly permitted". I did not find explicit language on automated access, but I read only part of those terms. Search engines and many sites also restrict automated queries. Read the terms of the sites you use before you enable this. You are responsible for that choice, and your accounts can be restricted.

**Limits of this design.** The browser only restricts which pages it opens. It does not stop a page from loading resources from other servers. The local-network block checks the address a page requests. It does not stop DNS rebinding, where a public name resolves to a private address. Do not rely on it as a firewall. The agent also sees whatever sites you logged into in its profile, and acts as you on them.

### Commands and status

```text
observer-core whatsapp setup --agent N --allow N [--country 91]   save numbers, enable
observer-core whatsapp status                                    config and install check, no network
observer-core whatsapp pair                                      scan the QR code once
observer-core whatsapp run                                       listen until Ctrl-C
observer-core whatsapp disable                                   stop using it (keeps the pairing)
observer-core whatsapp unpair --yes                              delete the local session keys
observer-core whatsapp routines                                  list routines.toml and any problems
observer-core whatsapp browser-login                              log in to a site once in the agent's browser
observer-core whatsapp model-advice                               suggest a local model for this machine
```

`observer-core doctor` shows a "WhatsApp remote" line. It is never an error when the feature is off.

### Safety, read before you enable it

- **Unofficial protocol.** This uses the WhatsApp Web linked-device protocol through `neonize`. Meta does not permit it in its terms of service, and the account can be restricted or banned. Use a SIM you can afford to lose for the agent number.
- **Anyone who controls 9528923866 can run commands on this computer** once they reply YES. Protect that WhatsApp account (screen lock, two-step verification). Only YES from the allowed number runs anything.
- **Commands run as your user, with your files, network, and display.** They are not sandboxed. `sudo` cannot prompt (stdin is closed), so it fails rather than hanging. Every command is shown to you in full before it runs. Read it before you say YES.
- **Command output goes back to WhatsApp**, truncated. Do not run commands that print secrets if you do not want them in WhatsApp history.
- **The model also reads command output.** A file or web page can contain text that tries to steer it into proposing something harmful. Each proposed command still needs your YES, so read it before approving.
- **Messages travel through WhatsApp's servers**, which is how WhatsApp works. The model that reads them runs locally by default. If you configured a cloud or non-local model endpoint, `setup` warns you, and instructions and command output go to that endpoint.
- **Wrong account protection.** If the linked account is not the agent number, the agent refuses to run and disconnects.
- **Routines run exactly what the file says.** Their `run` steps execute as written in `routines.toml` once you approve them with YES. Anyone who can edit that file can change what a routine does, so keep it private.
- **The browser uses your logins.** Its profile holds session cookies for every site you log into in it. Anything a job does there is done as you. Deleting `arena-browser-profile` signs the agent out everywhere. With `browser_scope = "public"` the agent can open any public site, so keep the profile for sites you are happy to automate.
- **Storage.** The linked-device keys live in `$XDG_DATA_HOME/observer-core/whatsapp/session.sqlite3`, forced to mode 0600. Nothing secret is written to `config.toml`. Logs show phone numbers masked (last four digits only).

### Not yet verified

- Routines, timers, and browser jobs (arena.ai and research) have **not** been run live. There is no Chromium or Playwright in the build sandbox, and no route to the search engine or arena.ai. Page handling is tested against fake pages only. Expect the first real run to need selector tuning, and expect the search engine to show a CAPTCHA at times.
- The model recommendations in `model-advice` are untested on your hardware. Check the answers with a few real jobs before relying on them.
- The live pairing and messaging flow has **not** been run against WhatsApp. The build sandbox has no route to WhatsApp, and `libmagic` was missing there. Behaviour is covered by fakes in `tests/test_remote.py`, and the library's own session creation was checked up to the network call.
- Small local models may not always produce the exact JSON the loop expects. An invalid reply is retried inside the step limit.
- Not included: images and voice notes from WhatsApp, group chats, GUI controls for the remote (use the CLI), recurring schedules (timers are one-shot), file uploads through the browser, fine-tuned model weights (the browser uses instruction files and examples instead), and a systemd unit for `whatsapp run`. A simple user service is `systemctl --user` around `observer-core whatsapp run`.

---

## Headless daemon and systemd

```bash
./run.sh --daemon                       # foreground, Ctrl+C stops cleanly
observer-core install-desktop           # .desktop launcher, systemd user unit, AppStream metainfo
systemctl --user daemon-reload
systemctl --user enable --now observer-core-daemon
journalctl --user -u observer-core-daemon -f
```

The unit starts on login for the graphical session. It has an `ExecCondition`
that **skips the start while the session is locked** (`LockedHint=yes`), and it
restarts on failure with a 10-second back-off. If the session cannot be
identified, the condition passes and the daemon starts normally.

`install-desktop` writes only to your home directory and needs no root.

---

## Command reference

```text
observer-core                      open the GUI (same as: observer-core run)
observer-core daemon               headless agents
observer-core init-config          write a commented config.toml (never overwrites)
observer-core doctor [--json] [--no-model]
                                   full environment report; exits 1 only on hard errors
observer-core notify-test CHANNEL  send a test message through one channel
observer-core install-desktop      install launcher, systemd unit and metainfo
observer-core agent list
observer-core agent import FILE    YAML or JSON
observer-core agent export ID FILE
observer-core agent enable ID [--off]
observer-core agent delete ID [--yes]
observer-core agent run-once ID [--dry-run]
observer-core agent wizard "your words" [--preset KEY] [--action telegram] [--name NAME]
observer-core whatsapp setup|status|pair|run|disable|unpair|routines|browser-login|model-advice   remote control over WhatsApp
```

`python -m observer_core` behaves like `observer-core`.

---

## Privacy and security

### What is captured

Only what the agents you enable ask for:

- **Screen**: a PNG of the screen, taken when an agent that uses `$SCREEN` runs.
- **Camera**: a JPEG frame, taken when an agent that uses `$CAMERA` runs.
- **Audio**: short clips (`audio_clip_s`, 3 s by default), used for an energy level and, if
  transcription is installed, a local transcript. Clips are not written to disk.
- **OCR and clipboard**: text extracted from the above, or the clipboard contents.
  The clipboard passes through your redaction patterns first.

### What leaves the machine

Nothing, by default. Specifically:

- **Model calls** go to the endpoint you configured. Ollama and llama.cpp default
  to `127.0.0.1`, so nothing leaves the machine.
- **Messaging tools** (Telegram, Discord, Twilio, SMTP, SendGrid, Pushover,
  webhooks) send only the text an agent's model chose to send. They run only
  when you enable them for an agent and set their credentials.
- **Cloud models** send prompts and images to a third party. They are refused
  unless you enable them. An agent that uses one shows a red banner.
- Observer Core has **no server, no telemetry, no analytics and no crash upload.**
  `privacy.telemetry` is `false` and has no effect.

Verifying this on your machine: while the daemon runs, `ss -tunp` should show only
loopback connections for the model endpoint and whichever messaging hosts you
configured.

### Controls

| Control | Where | Effect |
|---|---|---|
| Local-only lock | Top bar (lock icon) | Refuses cloud models |
| Block network tools | Settings → Privacy | Kill-switch: every tool that sends data off the machine is refused |
| Persist frames | Settings → Privacy (default off) | When on, frames go to a ring buffer capped by count and size |
| Frame buffer limit | Settings → Privacy | Oldest frames are evicted first |
| Redact patterns | Settings → Privacy | Regexes replaced with `[redacted]` before text reaches a model |
| Per-agent sensors and tools | Agent editor | An agent only sees the sensors and tools it lists |
| `run_python` opt-in | Agent editor → Tools | Off by default, sandboxed when on |

### Wiping data

- **Captured frames**: Settings → Paths & data → *Wipe captured frames*.
- **Memories**: Settings → Paths & data → *Wipe all agent memories*.
- **Everything**: quit the app, then delete `~/.local/share/observer-core`,
  `~/.local/state/observer-core` (logs and events), `~/.cache/observer-core`, and
  `~/.config/observer-core` (credentials). Agent YAML files are in
  `~/.local/share/observer-core/agents/`.

### File permissions

`config.toml` and `observer.db` are created with mode 600. The config and data
directories are 700. `observer-core doctor` reports anything looser.

### SELinux

Observer Core does not need SELinux disabled and does not ask you to change
enforcement. If a GPU-accelerated model path is blocked by a denial:

```bash
getsebool -a | grep -i execmem                 # which execmem-related booleans exist
sudo ausearch -m avc -ts recent | tail         # read the actual denial first
```

If the denial is for an execmem-type operation and the policy offers a boolean,
set it persistently with `sudo setsebool -P <boolean> on|off` as the denial
indicates. Otherwise build a narrow local module with `audit2allow`. Do not run
`setenforce 0`. CPU inference needs none of this.

---

## Troubleshooting

- **Something is missing.** Run `./run.sh --doctor`, or open the **Diagnostics**
  tab. Each line has a fix.
- **The GUI will not open.** Check `echo $DISPLAY $WAYLAND_DISPLAY`. Without
  either, use `./run.sh --daemon`.
- **The model is "not reachable".** Start `ollama serve`, or check the endpoint in
  the top bar and press **Test connection**.
- **An agent is "degraded".** Its sensors produced nothing. The sensor status and
  reason are in Sensor Control, and the console shows the detail.
- **Logs.** `~/.local/state/observer-core/logs/observer.log` (rotating) and
  `~/.local/state/observer-core/events.jsonl` (structured). The console has
  *Open logs folder* and *Export*.

---

## Development

```bash
./run.sh --setup --no-system-deps        # venv and deps
.venv/bin/pytest -q                      # headless, no display, no network
.venv/bin/python -m pyflakes observer_core tests
bash -n run.sh
```

Tests use fakes: `FakeSensor` for synthetic frames and text, `ScriptedModel`
for canned replies, and `httpx.MockTransport` for provider wire formats. The Qt
smoke test sets `QT_QPA_PLATFORM=offscreen` and is skipped where Qt cannot load.

---

## Project layout

```text
run.sh                          single entry point: deps, venv, launch
requirements.txt                Python runtime deps
requirements-system-fedora.txt  dnf packages (parsed by run.sh)
pyproject.toml                  console scripts: observer-core, observer-core-daemon
install/                        .desktop, systemd user unit, AppStream metainfo
examples/agents/                sample agents (YAML)
observer_core/
  config.py  models.py  paths.py  logging_setup.py  util.py  app.py  doctor.py
  presets.py  daemon.py  cli.py  install.py  gui_entry.py
  sensors/   screen, screen_ocr, camera, microphone (+ system audio), clipboard,
             registry (shared captures), preview (Qt bridge, throttled)
  remote/    WhatsApp remote: commander (owner gate, YES/NO, bounded loop), routines and timers, browser jobs (browser; playbooks/ holds their instructions and examples), model_advice, shell
             (one bounded command), whatsapp (neonize linked device), service, cli_whatsapp, phone
  llm/       base (timeouts, retries), ollama, openai_compat, llamacpp_local,
             cloud (opt-in), factory
  tools/     base, channels (Telegram, Discord, Twilio, SMTP, SendGrid, Pushover,
             webhook), local (notify, memory, clip, sandboxed Python), registry
  runtime/   agent (one cycle), prompt, parse, scheduler (jitter, back-off),
             loop (asyncio scheduler), memory_store
  storage/   db (SQLite, WAL, migrations), events, frames (ring buffer)
  gui/       main_window, agent_list, agent_editor, sensor_panel, wizard,
             log_console, diagnostics_view, settings_dialog, tray, bridge, theme
  resources/icons/   inline SVG icons (no CDN, works offline)
tests/                          pytest suite (fakes, no hardware, no network)
```

---

## License and attribution

Observer Core is free software under the **GNU Affero General Public License v3.0**
(see `LICENSE`), the same family of license as the upstream project.

Concept after **Observer AI** by Roy3838:
https://github.com/Roy3838/Observer (AGPL-3.0). This is an independent
reimplementation for Linux and Fedora.
