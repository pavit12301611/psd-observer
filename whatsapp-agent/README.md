# 👁️ Observer Agent 2.0 — your PC, in your pocket

A personal agent that runs on **your own Fedora/Linux computer for ₹0** and is
driven from **WhatsApp** *and* from an **installable phone app** — no Observer
app, no Twilio, no Meta Cloud API, no subscription, no per-message cost.

- 💬 **Native WhatsApp** (linked device, [Baileys](https://github.com/WhiskeySockets/Baileys)) — agent number `+91 88595 55795`, listens **only** to you (`+91 95289 23866`), everyone else gets complete silence.
- 📱 **Phone app (PWA)** — open `http://<PC-IP>:8787/`, enter the PIN, "Add to Home screen". Chat, quick controls, files, QR linking — full-screen, works offline as a shell.
- 🧠 **Free AI with real tools** — local Ollama (offline/private) or free-tier Groq/Gemini/OpenRouter. Plain language becomes multi-step actions on the PC.
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

**No git needed** — one script downloads the branch with `curl` and installs it:

```bash
URL="https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/20378d42-psd-observer/whatsapp-agent/scripts/install-fresh.sh"
curl -fL -o /tmp/observer-setup.sh "$URL" || curl -fL -o /tmp/observer-setup.sh \
  -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/pavit12301611/psd-observer/contents/whatsapp-agent/scripts/install-fresh.sh?ref=arena/20378d42-psd-observer"
bash /tmp/observer-setup.sh --service --ollama --power --phone
```

It lands in `~/observer-agent` (`--dir <path>` to change), creates `.env` with
the owner/agent numbers filled in, and runs the Fedora installer below.

<details><summary>Already have the code (git clone / tarball)?</summary>

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
- **Files** — files received on the PC and your `data/shared/` folder, with a **Send** button that delivers to WhatsApp *and* a direct download link in the app; plus "send any path".
- **Settings** — live status, access level, tool count, WhatsApp QR when linking, install button, logout.

Install: Chrome/Android menu → **Add to Home screen**; iOS Safari → Share →
**Add to Home Screen**. It opens full-screen with its own icon and caches its
shell for instant launch.

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
/agent <task>             multi-step task with the free AI
/ask <question>           force AI chat        /model   AI status
/remind in 10m <text> · /reminders · /timer
/todo add <text> · /todo · /todo done <id>
/note <text> · /notes · /remember <fact> · /memory
/weather <city> · /wiki · /define · /news · /currency · /unit · /calc
/url <link> · /summarize · /improve · /qr · /password · /shorten
/files · /downloads · /get <name>
/observer <task>          optional: hand to an open Observer tab
/access                   what this agent may do
/yes · /no                answer a confirmation
/run <PIN> <command>      shell (only if ALLOW_SHELL=true)
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

- `/model` shows what is live. `AI_PROVIDER=auto` tries Ollama → Groq →
  Gemini → OpenRouter (keys optional, free tiers).
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

## 7b. Updating (no git needed)

```bash
# already installed:
curl -fL -o /tmp/agent-update.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/20378d42-psd-observer/whatsapp-agent/scripts/update-from-github.sh"
bash /tmp/agent-update.sh --dir ~/psd-observer/whatsapp-agent

# first install without git:
bash /tmp/agent-update.sh --fresh ~/observer-agent
```

The script downloads the branch tarball with plain `curl`, backs up the current
code to `~/observer-agent-backup-<date>.tar.gz`, replaces only the code, runs
`npm install`, and restarts the service. It never touches `.env`, `auth_info/`
(your WhatsApp link — no re-scan) or `data/` (PIN, token, notes, reminders,
todos). `./scripts/update-from-github.sh --check` shows the remote version.
Git users can still `git pull` on the `arena/20378d42-psd-observer` branch.

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
npm test     # 36 offline tests: owner gate, intents, actions, permissions,
             # confirmations, AI tool loop, HTTP API, PWA icons, black-frame
             # detection, portal parsing, doctor
npm run demo # dry-run: phone app + commands, no WhatsApp connection
```

Cost so far: **₹0**. No cloud accounts are required to run any of it.
