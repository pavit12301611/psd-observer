# 👁️ Observer Agent 2.4 — your PC, in your pocket

A personal agent that runs on **your own Fedora/Linux computer for ₹0** and is
driven from **WhatsApp** *and* from an **installable phone app** — no Observer
app, no Twilio, no Meta Cloud API, no subscription, no per-message cost.

- 🧰 **One script, everything** — [`scripts/observer.sh`](scripts/observer.sh): `install`, `update`, `models`, `doctor`, `service`, `start`, `relink`, `remote`, `fix`. Plain `curl`, no git, nothing else to remember.
- 💬 **Native WhatsApp** (linked device, [Baileys](https://github.com/WhiskeySockets/Baileys)) — agent number `+91 88595 55795`, listens **only** to you (`+91 95289 23866`), everyone else gets complete silence.
- 📱 **Phone app (PWA)** — open `http://<PC-IP>:8787/`, enter the PIN, "Add to Home screen". Chat, quick controls, files, QR linking — full-screen, works offline as a shell.
- 🧠 **Free AI with real tools** — run it **100% local** with a Hugging Face GGUF on llama.cpp (`./scripts/observer.sh models setup best`, no key, offline) or add a **free Groq / OpenRouter / Gemini key** (`./scripts/observer.sh keys groq gsk_...`) for a fast cloud brain + free voice notes + vision. Plain language becomes multi-step actions on the PC, routed by workload.
- ⚡ **Offline intents** — even with **no AI at all**, "chrome kholo", "screenshot bhej do", "wifi off karo", "thesis.pdf dhundo" work instantly.
- 🖥️ **Full PC control** — open *any* installed app, files, screenshots, OCR, typing/clicking, Wi-Fi/Bluetooth, volume/brightness/music, download links, zip, webcam, screen recording, services, processes, power.
- 🎙️ **Voice notes & documents** — voice notes are transcribed (free), photos are OCR'd, PDFs/DOCX are read and summarised — then acted on like text.
- 🔐 **Owner-only + confirmations** — one listener rule, destructive actions need `haan`/`yes`, shell is separately opt-in with a PIN.

> ⚠️ **Honest warning:** Baileys is an *unofficial* WhatsApp Web client. WhatsApp can restrict numbers that automate or spam. This agent only ever talks 1-to-1 with you, replies only, is rate-limited — keep it that way, and never run it on your main number. The phone app is your own PC's web server: LAN-only unless you deliberately expose it.

---

## 0. Fastest path

Step-by-step, copy-paste commands (install → link → first message → phone app →
troubleshooting): **[`QUICKSTART.md`](QUICKSTART.md)**. The short version is below.

Everything that was built, every command, and every error with its fix:
**[`BUILD-LOG.md`](BUILD-LOG.md)**.

## 1. Install (Fedora, ~5 minutes)

**No git needed** — install, update, local models, service and repairs all live
in **one script**: [`scripts/observer.sh`](scripts/observer.sh). Download it once:

```bash
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/5f4643a1-psd-observer/whatsapp-agent/scripts/observer.sh" \
  || curl -fL -o /tmp/observer.sh -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/pavit12301611/psd-observer/contents/whatsapp-agent/scripts/observer.sh?ref=arena/5f4643a1-psd-observer"

bash /tmp/observer.sh install --service --power --phone --model auto
```

It lands in `~/observer-agent` (`--dir <path>` to change), creates `.env` with
the owner/agent numbers filled in, installs the toolkit and sets up a local
model that fits the machine — all from that one file.

| Command | What it does |
|---|---|
| `observer.sh install` | first-time install (curl tarball, no git) |
| `observer.sh update` | update code, keeps `.env` / login / `data/` |
| `observer.sh models …` | Hugging Face GGUF: list, recommend, download, serve, wire |
| `observer.sh doctor` | what is broken + the exact fix |
| `observer.sh service …` | systemd unit install/restart/logs |
| `observer.sh start` / `relink` / `remote` / `fix` | run, new QR, Tailscale, desktop fixes |

The old names (`install-fresh.sh`, `update-from-github.sh`, `local-models.sh`)
still work — they are now thin wrappers that forward to `observer.sh`.

<details><summary>Already extracted the tarball somewhere?</summary>

```bash
cd whatsapp-agent
./scripts/install-fedora.sh --service --ollama --power --phone
journalctl --user -u observer-whatsapp-agent -f    # logs + linking QR + PIN
```

</details>

What the flags do:

| Flag | Effect |
|---|---|
| `--service` | systemd **user** service: starts at boot (linger), survives logout |
| `--ollama` | installs Ollama + pulls `llama3.2` (free offline brain) |
| `--power` | installs the toolkit (tesseract OCR, ffmpeg, wmctrl, zip, pdftotext, bluez, NetworkManager…) and sets `ACCESS_LEVEL=full` |
| `--phone` | `HOST=0.0.0.0` + opens TCP **8787** in firewalld so your phone can reach the app |

Manual: `sudo dnf install nodejs npm && cp .env.example .env && npm install && ./start.sh`.

Then:

1. **Link WhatsApp once** — scan the QR in the terminal/image viewer/journal with the **agent phone** `+91 88595 55795` (WhatsApp → Linked devices → Link a device). Or `USE_PAIRING_CODE=true`.
2. **Message it from your phone** `+91 95289 23866` → `/help`.
3. **Open the phone app** — the console prints `http://<PC-IP>:8787/` and a 6-digit PIN (also `data/dashboard-pin.txt`). Enter the PIN once; it is remembered.

Nothing is exposed to the internet: the app listens on your LAN only.

---

## 2. Just talk to it

No commands needed. It understands English, Hindi and Hinglish, because the
offline intent layer runs before any AI:

| You write | What happens |
|---|---|
| `chrome kholo` | launches Chrome (any installed app) |
| `screenshot bhej do` | PC screenshot arrives as an image |
| `screen pe kya hai?` | screenshot → OCR → AI answer about your screen |
| `awaaz kam karo` / `volume 40` | volume down / set 40 % |
| `wifi off karo` · `wifi connect HomeNet pass` | Wi-Fi control |
| `thesis.pdf dhundo` | searches your home folder |
| `downloads me kya hai` · `ls ~/Desktop` | browses folders (also fixes `downloads` → `~/Downloads`) |
| `~/report.pdf bhejo` or `/send ~/report.pdf` | file arrives on WhatsApp |
| `download https://…` | downloads to `~/Downloads` |
| `10 second screen record karo` | records and sends an MP4 |
| `type karo hello` · `press ctrl+l` | keyboard control |
| `notepad band karo` | closes the app (asks first) |
| `pc band karo` | shutdown (asks first) |
| `remind me in 10m to drink water` | reminder fires on WhatsApp |
| `garam pani peene ka yaad dila do 10 min baad` | *needs a brain* → AI extracts the reminder |
| anything else | free AI chat (Ollama first) |

With Ollama installed it also handles **multi-step** requests:
*"download the syllabus PDF from <link>, rename it, and send it to me"* →
calls `download_url`, `write_file`/`move`, `send_file` in sequence.

---

## 3. Phone app (no Observer, no Play Store)

`http://<PC-IP>:8787/` is a real installable PWA:

- **Chat** — same agent as WhatsApp, with quick chips and browser dictation (🎤).
- **Panel** — one-tap screenshot, volume, mute, play/pause, brightness, lock, Wi-Fi, battery, status, apps, windows, recording, webcam, processes.
- **Screen** — live screen (2.5s frames) + **tap to click**, type box and keys (Enter, Esc, Tab, Ctrl+L…). This is the remote-desktop view; it works over the same Wi-Fi, or from anywhere through Tailscale.
- **Files** — files received on the PC and your `data/shared/` folder, with a **Send** button that delivers to WhatsApp *and* a direct download link in the app; plus "send any path".
- **Settings** — live status, access level, tool count, WhatsApp QR when linking, install button, logout.

Install: Chrome/Android menu → **Add to Home screen**; iOS Safari → Share →
**Add to Home Screen**. It opens full-screen with its own icon and caches its
shell for instant launch.

### Updates khud aa jayein (optional)

```bash
./scripts/observer.sh autoupdate on            # roz ~3:00 baje
./scripts/observer.sh autoupdate on --time 02:30
./scripts/observer.sh autoupdate status|off
```

Update ke baad WhatsApp pe ek message aata hai: version, kya naya, aur kitne
second lage (`🔄 Observer updated · 2.7.0 → 2.8.0 · 1m 12s`).

### Ghar se bahar? (macOS/Windows-style "remote desktop", free)

**WhatsApp commands already work from anywhere** — the laptop dials out to
WhatsApp, so you can message the agent from another city/country with no setup.
Only the *phone app* needs a path home. Two free options:

**1. Tailscale (recommended, private, no port-forwarding)**

```bash
cd whatsapp-agent
./scripts/setup-remote.sh
```

It installs Tailscale, logs the PC in (one approval link), sets `HOST=0.0.0.0`,
allows TCP 8787, and prints `http://<tailscale-ip>:8787/` + the PIN.
Then install the **Tailscale app on your phone**, log in with the **same
account**, and open that URL. Works on mobile data/other Wi-Fi, and nobody else
on the internet can see the port. Do **not** port-forward 8787 on your router.

**2. Cloudflare Tunnel (if you can't install Tailscale)**

```bash
cloudflared tunnel --url http://localhost:8787
# → https://<random>.trycloudflare.com  (ephemeral; put Cloudflare Access in
#   front for email-OTP, or rely on the PIN + rate limiting)
```

⚠️ **The laptop must stay awake and online.** If it suspends when you close the
lid, the agent sleeps too. On Fedora (optional, uses more battery):

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
# undo: sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

And the house internet must be up — if the Wi-Fi/router is down, nothing can
reach the PC. A ₹0 trick for that: run `/sysinfo` occasionally so you notice;
the agent also goes silent, which is itself the signal.

Auth: the PIN only unlocks a session token. Every data route also accepts the
long bridge token (`data/bridge-token.txt`, printed at startup) and refuses
everything else. Login attempts are rate-limited.

---

## 4. Command reference

### Apps, windows, input
```
/apps                     installed apps
/open <app>               open any app (chrome, vs code, spotify…)
/close <app>              close it (confirmation)
/windows                  open windows            /focus <title>
/screenshot               screen → WhatsApp
/look [question]          screenshot + OCR + AI answer (works without Observer)
/ocr                      raw text on screen
/pc locate <label>        find a button on screen (OCR)
/pc tap <label>           find + click it
/use <task>               *hands*: look → click/type/scroll → look again (agentic)
/use --steps 12 <task>    same, bigger step budget (max 20)
/pc type <text>           type into focused window
/pc key ctrl+l            press keys
/pc click 640 400         click coordinates
/webcam                   webcam photo
/record [seconds]         screen recording (default 10 s)
```

### System & network
```
/pc status|disk|ip|battery|top     PC info
/pc volume up|down|mute|50         volume
/pc brightness 70                  brightness
/pc media play|pause|next|prev     music/video
/pc type <text>             type (any length — chunked, was capped at 500)
/pc paste <text>            long/multi-line text via clipboard + Ctrl+V
/pc mousemove <x> <y>       move the pointer
/pc scroll [up|down] [n]   wheel scrolling
/pc click [x y] [double]   click (or find a button by label with /pc tap <label>)
/doctor                    what is broken + the exact fix
/pc clipboard · /pc clipset <text> clipboard
/pc notify <text> · /pc lock       desktop notification / lock
/wifi [status|on|off|list]         Wi-Fi
/wifi connect <SSID> [password]
/bt [on|off|status]                Bluetooth
/kill <process>                    stop a process (confirmation)
/svc status|restart <service>      systemd services
/pc suspend|reboot|shutdown        power (asks /pc confirm or /yes)
```

### Files
```
/ls [path]                list a folder (default ~)
/read <path>              text, PDF or DOCX → chat
/write <path> | <text>    write (add --append)
/send <path>              any file → WhatsApp document
/find <name>              search under home
/mv <from> | <to>         move / rename
/cp <from> | <to>         copy
/mkdir <folder>           create a folder
/zip <path> [| path2]     make an archive
/unzip <file.zip>         extract
/download <url> [path]    download to the PC
/rm <path>                delete → trash (confirmation)
```
Files are restricted to your home folder (plus `FILES_EXTRA_ROOTS`); `.ssh`,
`.gnupg` and the WhatsApp login are blocked on purpose.

### Chat, notes, lookups
```
/agent <task>             does the task on the PC: tools, verified steps, honest report
/agent --plan <task>      show how it would be done (no side effects)
/agent --web <task>       force the browser path (e.g. "chatgpt pe rust vs go pooch")
/agent --use <task>       force screen control (same as /use: click/type/scroll loop)
/agent --fast <task>      force the small/fast model (save power) · --deep = biggest
/brains                   which free model serves what + live health + power budget
/brains why <task>        show the exact routing decision for a task
/do <task>                same as /agent, quieter about routing
/ask <question>           force AI chat        /model   AI status
/remind in 10m <text> · /reminders · /timer
/todo add <text> · /todo · /todo done <id>
/note <text> · /notes · /remember <fact> · /memory
/weather <city> · /wiki · /define · /news · /currency · /unit · /calc
/url <link> · /summarize · /improve · /qr · /password · /shorten
/files · /downloads · /get <name>
/auto <task>              verified UI automation: open chrome | tap Search | type hi | key enter
/arena <prompt>           arena.ai/agent: type the prompt, read the answer, screenshot proof
/observer <task>          optional: hand to an open Observer tab
/access                   what this agent may do
/yes · /no                answer a confirmation
/run <PIN> <command>      shell (only if ALLOW_SHELL=true)

/stop                     chal raha kaam turant roko (stacked bhi)
/resume                   wahin se shuru jahan /stop ne roka
/undo [N|list]            pichhla file kaam wapas (write/move/copy/delete/mkdir/zip)
/usage                    aaj ka AI quota, model-wise + 80% warning
/watch <condition>        "jab ye ho jaye to batao" (screenshot + vision) · list|stop
/teach start <naam>       apne commands record karo → /teach stop → phir /<naam>
/brief                    aaj ka brief · /brief on 9am = roz subah
/tap <x y | 50% 40% | Login>  screen pe seedha click
/remote                   kahin se bhi control — WhatsApp ya phone app
```

Voice notes, photos and documents sent on WhatsApp are transcribed / OCR'd /
read and summarised automatically; a voice note that says "chrome kholo" opens
Chrome.

---

## 5. The free brain (optional but recommended)

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull llama3.2          # ~2 GB, tool-calling capable
ollama pull llava             # optional: describe photos
```

- `/model` shows what is live. `AI_PROVIDER=auto` tries local → Groq →
  OpenRouter → Gemini (keys optional, free tiers).
- **Cloud key in one line:** `./scripts/observer.sh keys groq gsk_...` —
  writes `.env`, verifies the key, restarts the service. Limits, models and
  which provider to pick: **[`AI-KEYS.md`](AI-KEYS.md).**
- Without any brain, all built-in commands and Hinglish intents still work;
  only free-form conversation is limited.
- `OLLAMA_VISION_MODEL=llava` describes photos. Without it, tesseract OCR still
  reads text from images.
- **Voice notes:** easiest is a free Groq key (`GROQ_API_KEY`) which enables
  Whisper transcription; fully offline alternative is whisper.cpp
  (`WHISPER_BIN`, `WHISPER_MODEL`). No key + no whisper → voice notes are saved
  with a clear message.

---

## 6. Access levels & safety model

Set in `.env`:

| `ACCESS_LEVEL` | Allows |
|---|---|
| `safe` | status, screenshot, OCR, lookups, clipboard read… |
| `standard` | apps, files, Wi-Fi/Bluetooth, typing/clicking, downloads, media, recording… |
| `full` *(default)* | standard + shutdown/reboot/suspend |

Destructive actions (`/rm`, `/close`, `/kill`, `/svc restart`, power, shell)
**never** run immediately: they are parked for 2 minutes and need `haan`/`yes`.
`run_shell` additionally requires `ALLOW_SHELL=true` **and** `SHELL_PIN`
(`/run <PIN> <cmd>`). Everything is `execFile`/argv — never a shell string — so
a chat message cannot smuggle shell syntax into an app launch.

Other guarantees:

- **One listener rule**: owner check runs before anything else, including
  WhatsApp's LID addressing; non-owners get no reply and no read receipt.
- Groups, communities, status, broadcasts and self-messages are ignored.
- The WhatsApp login (`auth_info/`) and `.env` are gitignored; `data/` holds
  notes/reminders/chat memory in one JSON file.
- The phone app needs the PIN/token and is LAN-only by default.
- `HOST=127.0.0.1` restricts everything to the PC.
- `FILES_EXTRA_ROOTS` lets you add e.g. `/mnt/data`; nothing outside the
  allowed roots is readable or writable.

---

## 7. Keep it running

```bash
./scripts/install-systemd.sh          # install/enable user service + linger
systemctl --user status  observer-whatsapp-agent
journalctl --user -u     observer-whatsapp-agent -f
```

Or `./start.sh` in tmux, or Podman (`podman-compose up -d`, SELinux `:Z`
volumes included). Restarting never needs a new QR scan unless the phone
unlinked the device — then `AUTO_RELINK=true` archives the dead login
(`auth_info_loggedout_<date>/`, never deleted) and shows a fresh QR.

**Note:** the unit sets `NoNewPrivileges=true`, so `sudo` inside `/run` will
not work. That is deliberate. If you need package installs from WhatsApp,
enable shell **and** remove that line from the unit (your PC, your call).

---

## 7y. Free cloud brains — Groq + OpenRouter (optional)

The agent is complete without any key, but a free key adds speed, vision and
free voice-note transcription. Both providers below cost ₹0:

```bash
./scripts/observer.sh keys groq gsk_xxxxxxxx        # console.groq.com/keys
./scripts/observer.sh keys openrouter sk-or-v1-xxx  # openrouter.ai/keys
./scripts/observer.sh keys --test                   # verify what is saved
```

| | Groq | OpenRouter |
|---|---|---|
| Free quota | **1,000 req/day** per model (30 rpm) | **50/day** (1,000 after a one-time $10) |
| Default models | `openai/gpt-oss-120b` · `openai/gpt-oss-20b` | `google/gemma-4-31b-it:free` |
| Vision | `qwen/qwen3.8-27b` | Gemma 4 31B |
| Voice notes | ✅ free Whisper | ❌ |
| Best role | primary cloud brain | backup / specific models |

> Llama 3.1 8B and 3.3 70B left Groq's free tier on **16 Aug 2026** — the
> agent's defaults are `gpt-oss` now, so old `GROQ_MODEL=llama-3.3-70b`
> values must be replaced.

Full guide: **[`AI-KEYS.md`](AI-KEYS.md)** (get keys, limits, model table,
`.env` lines, vision, troubleshooting).

---

## 7z. 100% local models (Hugging Face GGUF, llama.cpp)

No key, no quota, nothing leaves the PC. One command:

```bash
cd ~/observer-agent
./scripts/observer.sh models recommend      # what fits THIS machine
./scripts/observer.sh models setup best     # download + serve + wire
```

Then WhatsApp `/brains` shows the local model live. Full guide (model picks,
`hf download` commands, quant advice, multi-model ports):
[`LOCAL-MODELS.md`](LOCAL-MODELS.md).

| Machine | Model | Hugging Face |
|---|---|---|
| 24 GB+ | Qwen3.8-27B (vision, agentic) | `unsloth/Qwen3.8-27B-GGUF` |
| 16–24 GB CPU laptop | Gemma 4 26B-A4B (MoE, fast) | `ggml-org/gemma-4-26B-A4B-it-GGUF` |
| 12–16 GB | Gemma 4 12B (vision, 256K ctx) | `ggml-org/gemma-4-12B-it-GGUF` |
| 6–8 GB | Qwen3.5-4B | `unsloth/Qwen3.5-4B-GGUF` |
| 2–4 GB | Qwen3.5-0.8B | `unsloth/Qwen3.5-0.8B-GGUF` |

`.env` after wiring:

```env
AI_PROVIDER=local                              # never falls back to cloud
LOCAL_API_URL=http://127.0.0.1:8080/v1
LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL
```

Optional extra ports give the workload router a tiny model for one-liners, a
big one for heavy jobs, and a vision model for photos (the setup script does
this automatically).

## 7a. Workload routing — the right brain for the job (2.1)

Every message is sized before a model is picked, so nothing burns a 70B model
on "hi" and nothing hands a 10-step job to a 1B model:

| Work size | Example | Brain used |
|---|---|---|
| **tiny** | "hi", "chrome kholo", "volume 40" | small/fast model — local Ollama first, ~instant |
| **light** | "weather batao", "notes padho" | small→mid local, cloud 8B if local is busy |
| **standard** | "download folder saaf karo, phir screenshot bhej" | a competent model: local 14B+ **or** free 70B |
| **heavy** | "write a script that scrapes X then emails a CSV" | best available, capped by the power budget |

- **Local first** (`ROUTER_PREFER=local`): free and private. Cloud free tiers are
  only used when the local model is too small for the job or is down.
- **Failures cool down**: a brain that times out is skipped for 2 min, doubling
  on repeats (max 30 min) — one dead provider never slows WhatsApp again.
- **Power budget**: at most `MAX_HEAVY_PER_HOUR` (12) heavy calls an hour; after
  that, work is downgraded to standard instead of waking a huge model.
- **Multimodal**: photos go to a vision model (local `OLLAMA_VISION_MODEL`
  first, then Gemini), and screenshots are only sent to vision when the task
  actually needs to *read* an image.
- `/brains` shows the live catalog, health, recent decisions and budget.

### What changed in 2.1 (the `/agent` fix)

`/agent` used to open arena.ai, type your text, wait 6 seconds and always reply
"done" + a screenshot — even when the browser never opened. It now:

1. **Understands the task** and runs it with real PC tools (apps, files, screen,
   typing, downloads …), or drives a real browser when the task belongs on a site.
2. **Verifies every step**: the opened page is confirmed by a new window title,
   a changed screen, or a live browser process; typing is refused if the focused
   window is not a browser (or the app just opened); buttons are found with
   OCR/vision (no blind coordinate clicking).
3. **Never lies**: a failed run says `step N pe ruk gaya` with the real reason,
   and attaches a screenshot of the failure — not a fake success.
4. **Proves its work**: `/agent` replies end with `🧠 standard · llama3.2 · 3 steps`.

### What changed in 2.6 — hands (computer use)

`/use` (and the `computer_use` tool the AI brain calls by itself) gives the agent
a real feedback loop instead of one-shot commands:

```
screenshot → OCR (local, free) → vision model picks ONE action →
click / type / scroll / drag → settle → screenshot again → …
```

Design taken from Simular's **Agent-S** (the computer-use research agent):

- **One action per step**, never a burst of blind clicks. The model sees the
  result of its last action before choosing the next one.
- **Text is grounded to exact pixels.** OCR gives every on-screen word an id;
  the model answers `{"action":"click","word":42}` and we click that word's
  box. Coordinates (0-1000) are only used for icons/images.
- **Stuck detection.** The same action three times with no screen change ends
  the run with `same action 3 baar, screen nahi badli — stuck` instead of
  burning the step budget.
- **Budgets everywhere**: 8 steps / 240 s by default (`HANDS_MAX_STEPS`,
  `HANDS_MAX_SECONDS`), screenshots downscaled to 1280 px so free-tier image
  limits are respected.
- **Honest replies**: every line is an action that actually ran, with the real
  tool result; a failed run says so and attaches the screenshot.

Safety: the action allowlist is `click / double_click / right_click / type /
key / scroll / drag / move / wait / open / focus / done / fail` — there is no
shell, and the model is instructed never to type passwords/OTPs or click
destructive buttons. Typing still goes through the same window check as `/auto`
(a non-browser window is never typed into blindly).

Privacy: screenshots go to the vision model. With a local vision model
(`OLLAMA_VISION_MODEL` / `LOCAL_API_URL_VISION`) that is 100% on-PC. Otherwise
the free cloud tier sees the screenshot — set `ALLOW_CLOUD_SCREEN=false` to
forbid that.

Example:

```
/use YouTube kholo aur lofi music chalao
/use Settings me Bluetooth on karo
/agent instagram kholo aur pehli story dekho   ← the brain calls computer_use itself
```

### What changed in 2.5.4 (the `/arena` fix)

`/arena` (and every `/agent` site task) used to fail with `browser khola par
page load nahi hua (20s wait)` even when the page was clearly open. It waited for
a **new window title** — which never appears when the page opens as a tab in an
already-running browser, and never appears at all on Wayland (`wmctrl` is X11-only).

Now the open step has three outcomes: **proved** (window title), **opened but
unverified** (screen changed / browser process is alive — it focuses the browser
and carries on, and says so in the reply), and **failed** (no browser at all, or
the screen was readable, unchanged, and the browser was already open). Chat
sites are typed into directly — their composer is focused on load, so no click
is needed and Enter is pressed exactly once.

## 7b. Updating (no git needed)

```bash
# already installed (raw.githubusercontent block ho to API fallback):
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/5f4643a1-psd-observer/whatsapp-agent/scripts/observer.sh" \
  || curl -fL -o /tmp/observer.sh -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/pavit12301611/psd-observer/contents/whatsapp-agent/scripts/observer.sh?ref=arena/5f4643a1-psd-observer"

bash /tmp/observer.sh update --dir ~/observer-agent   # apna install path
bash /tmp/observer.sh update --check                  # sirf version dekho
```

The script downloads the branch tarball with plain `curl`, backs up the current
code to `~/observer-agent-backup-<date>.tar.gz`, replaces only the code, runs
`npm install`, and restarts the service. It never touches `.env`, `auth_info/`
(your WhatsApp link — no re-scan) or `data/` (PIN, token, notes, reminders,
todos). `./scripts/observer.sh update --check` shows the remote version.
This workflow is **curl-only** — you never need `git clone` or `git pull`.

---

## 8. Bridge API (for Observer users, optional)

Everything the Observer app does in the cloud also works locally:

| Route | Purpose |
|---|---|
| `POST /tools/send-whatsapp` | Observer's `sendWhatsapp()` → your agent number, unlimited |
| `GET /remote/listen` | inbox long-poll for the patched MCP tab |
| `POST /remote/reply` | MCP answers back to WhatsApp |
| `POST /api/chat` | phone app chat |
| `POST /api/action` | run one action by name |
| `GET /api/files` · `GET /api/apps` | files / installed apps |
| `POST /api/send` | send a message to the owner |
| `GET /health` | public liveness (masked numbers only) |

All except `/health`, the app shell and icons need `x-bridge-token`,
`Authorization: Bearer`, or `?t=` (the private dashboard URL). The bridge
refuses to message anyone but `OWNER_NUMBER`.

Observer can also read the same `.env` values if you self-host the Python API
with `WHATSAPP_MODE=native` (see [`../FREE_WHATSAPP.md`](../FREE_WHATSAPP.md)).

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| QR expired | It refreshes every ~20 s; scan the newest one (logs/dashboard). |
| Logged out / unlinked | Auto-recovered: a fresh QR appears. Manual: `./scripts/relink-whatsapp.sh`. |
| Agent doesn't reply | Message from `9528923866`, 1-to-1. Check `/health`; logs show `ignored non-owner` (masked). |
| No AI answers | `ollama serve` running + `ollama pull llama3.2`, then `/model`. Commands work regardless. |
| `No such interface "…portal.Desktop.Screenshot"` | The portal has no GNOME backend: `sudo dnf install xdg-desktop-portal xdg-desktop-portal-gnome && systemctl --user restart xdg-desktop-portal-gnome xdg-desktop-portal`. `./scripts/fix-desktop.sh` does it and verifies with `gdbus introspect`. |
| Screenshot banti hai par chat me nahi aati | Update ke baad fix. Naya code portal ka **file bhi watch karta hai** (`~/Pictures/Screenshot*`), isliye signal miss hone ya "Allow" der se dabane par bhi image aa jati hai. Wait time badhana ho: `PORTAL_TIMEOUT_MS=120000` in `.env`. |
| **Screenshot is black** | Wayland blocks X11 capture tools — they "succeed" and return a black frame. Run `./scripts/fix-desktop.sh`, approve the one-time "Allow screenshot?" prompt on the PC, then `/doctor`. The agent now rejects black captures instead of sending them, and names each tool that failed. |
| Typing / clicking does nothing | Wayland needs ydotool's daemon: `sudo dnf install ydotool && sudo systemctl enable --now ydotool` (unit may be `ydotoold`); `/dev/uinput` must exist. `./scripts/fix-desktop.sh` sets this up, `/doctor` verifies it. |
| OCR says install tesseract | `sudo dnf install tesseract tesseract-langpack-hin`. |
| Voice note not transcribed | Set `GROQ_API_KEY` (free) or `WHISPER_BIN`+`WHISPER_MODEL`. |
| Phone app unreachable | Same Wi-Fi; `HOST=0.0.0.0`; `./scripts/install-fedora.sh --phone` opens firewalld 8787. |
| Forgot the PIN | `cat data/dashboard-pin.txt`, or set `DASHBOARD_PIN=` in `.env` and restart. |
| `/run` says shell is OFF | `ALLOW_SHELL=true` + `SHELL_PIN=<pin>` in `.env`, restart. |
| `wmctrl`/window control missing | `sudo dnf install wmctrl` (X11; GNOME Wayland blocks window listing). |
| Port 8787 busy | `PORT=8790` in `.env` (update bookmarks). |
| `/pc brightness` permission denied | `sudo usermod -aG video $USER`, log out/in. |
| "It can't control my whole computer" | Send **`/doctor`** — it tests screenshot/input/OCR/AI and prints the exact fix. Limits are honest: no typing into lock screens/password prompts, nothing while nobody is logged in, no window list on GNOME Wayland. See [`../FEDORA.md`](../FEDORA.md#black-screenshots--typing--mouse-not-working-wayland). |
| Podman permission denied on `auth_info` | Keep the `:Z` volume flags. |

---

## 10. Tests

```bash
./scripts/observer.sh test --live   # the one to run: env, keys, brains,
                                    # routing preview, unit tests, real call
npm test                            # 90 offline tests: owner gate, intents,
                                    # actions, permissions, confirmations, AI
                                    # tool loop, HTTP API, PWA icons, black-frame
                                    # detection, portal parsing, doctor, local
                                    # llama.cpp, Groq/OpenRouter failover
npm run demo                        # dry-run: phone app, no WhatsApp connection
```

Cost so far: **₹0**. No cloud accounts are required to run any of it.
