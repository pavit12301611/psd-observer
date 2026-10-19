# 👁️ Observer WhatsApp Agent — free, native WhatsApp (Fedora Linux)

A personal WhatsApp agent that runs on **your own Fedora PC/laptop for ₹0**
(`dnf` install, `systemd --user` autostart, `journalctl` logs — full distro
guide in [`../FEDORA.md`](../FEDORA.md)):

- It links to WhatsApp **like WhatsApp Web / a linked device** ([Baileys](https://github.com/WhiskeySockets/Baileys) — the WhatsApp Web protocol directly over WebSocket). No Twilio, no Meta WhatsApp Cloud API, no rented number, no per-message charges, no 24-hour window.
- **Agent number:** `+91 88595 55795` (the second phone/SIM you link once by QR)
- **Listens only to you:** `+91 95289 23866`. Every other number, group, status and broadcast gets **complete silence** — no reply, no read receipt.
- It **answers and acts**: AI chat with memory, reminders that fire, to-dos, notes, weather/news/wiki/currency lookups, QR/sticker tools, file receive/send, PC status — and, through the Observer app, it can look at your **screen/camera** and run Observer's tools (`/observer …`, `/screen`).
- **Free AI brain:** local [Ollama](https://ollama.com) first (offline, private). Optional free-tier Groq/Gemini/OpenRouter keys if you ever want them. All built-in commands work with **no AI at all**.

> ⚠️ **Honest warning:** Baileys is an *unofficial* WhatsApp Web client. WhatsApp can restrict/ban numbers that automate, spam or bulk-message. This agent is built to be low-risk (it only ever talks 1-to-1 with you, replies to your messages, rate-limited, on a **secondary number** — exactly your setup), but the risk can't be zero. Never run it on your main personal number, never use it to message other people. The official alternative is the Meta WhatsApp Cloud API, which is what costs money and requires a business setup.

---

## 1. What you need

| Thing | Why | Cost |
|---|---|---|
| A Fedora PC/laptop that stays on while you want the agent awake (an old laptop is perfect) | The agent process lives here | Free (electricity only) |
| Node.js 20+ + npm | Runs the agent — Fedora packages: `sudo dnf install nodejs npm` (they're separate packages on Fedora!) | Free |
| Phone with WhatsApp on `8859555795` | This becomes the agent; you scan the QR with it once | Free |
| Your phone `9528923866` | The only number the agent obeys | Free |
| Optional: Ollama + `llama3.2` model | Free offline AI answers | Free — ollama.com |

## 2. Setup on Fedora (5 minutes)

One command does everything (dnf packages, agent install, autostart service, free local AI):

```bash
cd whatsapp-agent
./scripts/install-fedora.sh --service --ollama
journalctl --user -u observer-whatsapp-agent -f    # watch logs + linking QR
```

Or manually / foreground-only:

```bash
sudo dnf install nodejs npm git curl gcc-c++ make python3
cd whatsapp-agent
cp .env.example .env     # your two numbers are already filled in; edit only if they change
npm install
./start.sh               # on GNOME/KDE the first QR also opens in your image viewer
```

Then link the agent phone **once**:

1. The terminal shows a QR code (also saved to `data/qr.png` and shown on the local dashboard — the private dashboard URL is printed at startup).
2. On the **`8859555795` phone**: WhatsApp → **Linked devices** → **Link a device** → scan the QR.
   - No camera for the QR? Set `USE_PAIRING_CODE=true` in `.env`, restart, and use **"Link with phone number instead"** with the 8-character code it prints.
3. From **your phone (`9528923866`)**, send the agent number a WhatsApp: `/help`
4. It replies. Anyone else who messages the agent number: silence. ✅

The login is stored in `auth_info/` (like a browser's WhatsApp Web session). Restarting the PC/agent does **not** need a re-scan unless you log the device out from the phone. **Never share or commit `auth_info/`** — it's a full WhatsApp login for that number (it's gitignored).

**Unlinked it from the phone by mistake?** No panic — and no data loss (notes/reminders live in `data/`, not in the login). The agent detects the logout, archives the dead login as `auth_info_loggedout_<timestamp>/` (kept, never auto-deleted) and automatically shows a **fresh QR** in the logs/dashboard — just scan it again with the `8859555795` phone. That's `AUTO_RELINK=true` (the default); `./scripts/relink-whatsapp.sh` (or `npm run relink`) does the same recovery manually in one command.

### Free AI brain (recommended)

The official installer supports Fedora and sets Ollama up as a service:

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull llama3.2        # ~2 GB, runs on most laptops; try qwen2.5:7b if you have RAM
```

The agent talks to it at `127.0.0.1:11434` (nothing to open in firewalld).

Send the agent `/model` — it tells you exactly what's connected. For photo understanding add `ollama pull llava` and set `OLLAMA_VISION_MODEL=llava` in `.env`.

## 3. Try it — message ideas

```
hi
/help
/weather Nainital
remind me in 10 minutes to drink water
/remind tomorrow 9am call the bank
/todo add buy journal paper
note: gate code is 4321
what is 15% of 2400
/unit 10 km to mi
/currency 100 USD to INR
/wiki Uttarakhand
/summarize https://any-article-link
/qr https://observer-ai.com
/pc status                   ← shows your Fedora version, kernel, battery…
/pc screenshot               ← direct from the PC (grim/GNOME/KDE), no Observer needed
/pc volume up                /pc brightness 70      /pc media pause
/pc open firefox             /pc lock               /pc find thesis.pdf
/screen                      ← Observer if open (AI sees it), else a direct screenshot
any normal question…         ← answered by local Ollama, in your language (incl. Hinglish)
```

Send a **photo** → saved on the PC (`data/downloads/`, list with `/downloads`); with the vision model it's also described. Send a photo with caption **/sticker** → sticker back (needs `npm install sharp`, free). Put files in `data/shared/` → `/get filename` sends them to your phone.

Full command list is in `/help` itself.

## 4. Keep it running (systemd user service — the Fedora way)

The agent only works while this process runs and the PC is online (same as WhatsApp Web on a laptop — except the agent phone does **not** need to stay online; linked devices work independently).

```bash
./scripts/install-systemd.sh      # installs ~/.config/systemd/user/observer-whatsapp-agent.service
systemctl --user status  observer-whatsapp-agent
journalctl --user -u     observer-whatsapp-agent -f
systemctl --user restart observer-whatsapp-agent
```

The installer also enables **linger** (`loginctl enable-linger $USER`) so the agent
starts at boot and keeps running after logout. Being a *user* service matters on
Fedora: it runs with your SELinux context in your home directory, so `auth_info/`
never needs relabelling and no root process holds your WhatsApp session. The
unit template lives in `systemd/` with light hardening (`NoNewPrivileges`,
`PrivateTmp`, `ProtectSystem=full` — deliberately no `ProtectHome`, the agent
writes `auth_info/` + `data/` in its working directory).

Other options: just leave `./start.sh` running in a terminal/tmux session, or
Podman (`sudo dnf install podman-compose && podman-compose up -d` — bind mounts
carry the SELinux `:Z` label for Fedora). Your Fedora PC is the best host either
way, because `/screen` and Observer tools need *your* desktop.

**Firewall:** nothing to open in firewalld — the bridge is `127.0.0.1`-only and
WhatsApp is an outbound connection. Details + SELinux notes in [`../FEDORA.md`](../FEDORA.md).

## 4b. PC control (`/pc …`) — what works where

The agent controls the Fedora desktop directly (fixed `execFile` argv, never a
shell string). **Tier 1 is always on:** screenshot, volume, brightness, media
(MPRIS), open allowlisted app/URL, desktop notification, lock, clipboard
read/write, `find`/`get` files under your home folder, top processes.
**Tier 2** (keyboard/mouse input + suspend/reboot/shutdown) needs
`ALLOW_PC_CONTROL=true` in `.env`, optionally `CONTROL_PIN=…`
(`/pc type 1234 hello`); power always asks `/pc confirm` first.

```bash
./scripts/install-fedora.sh --pc-control   # installs the tools below + flips the tier-2 switch
# …or by hand:
sudo dnf install grim gnome-screenshot scrot kde-spectacle playerctl brightnessctl ydotool xdotool wl-clipboard libnotify tesseract
sudo systemctl enable --now ydotool        # Wayland input daemon (uinput)
```

**🎯 Element finder — click by name, not by pixels.** `/pc tap <PIN> Login`
screenshots the screen, finds the *Login* button/field by its visible label
(tesseract OCR — exact, offline; a local `OLLAMA_VISION_MODEL` like
`qwen2.5-vl` is the fallback for icons/unlabelled controls), clicks its
centre, and sends you the screenshot with a red crosshair on the spot as
proof. `/pc locate Login` does the finding only (no click). Labels that smell
irreversible (Delete, Pay, …) ask `/pc confirm` first. Caveats: it finds
*visible text* best — tiny/low-contrast labels can be misread by OCR, the
vision fallback is approximate, and clicks are screenshot pixels, so with
fractional display scaling (125 %/150 %) they can land offset by that ratio
(100 % scale is exact). Screenshots used for vision-locating stay on the PC
(local Ollama only).

| Feature | Fedora GNOME/Wayland (default) | KDE Plasma | X11 session |
|---|---|---|---|
| `/pc screenshot` | via GNOME Shell D-Bus — may be blocked by current Mutter; then `/screen` via Observer's browser capture is the reliable path | `spectacle` ✅ | ✅ (scrot/gnome-screenshot) |
| `/pc type/key/click` | `ydotool` + daemon ✅ (xdotool reaches XWayland apps only) | `ydotool` ✅ | `xdotool` ✅ |
| volume/brightness/media/clipboard/lock/notify | ✅ | ✅ | ✅ |

If the service auto-starts at boot (linger) **before** you log in, screenshot/
input commands answer "no graphical session" — `systemctl --user restart
observer-whatsapp-agent` after login picks the session up. Brightness
"permission denied" → `sudo usermod -aG video $USER`, log out/in.

Honest scope: this is **control on demand**, not Observer's always-watching
micro-agents. For continuous screen/camera/mic watching with AI reactions,
keep Observer open (§5) — the two combine.

## 5. Connect it to Observer (screen, camera, agent alerts)

Two free bridges replace `api.observer-ai.com` (full steps in [`../FREE_WHATSAPP.md`](../FREE_WHATSAPP.md)):

1. **Observer → WhatsApp alerts:** Observer agents' `sendWhatsapp(...)` can post to `http://127.0.0.1:8787/tools/send-whatsapp` (bridge token printed at startup, also in `data/bridge-token.txt`). Unlimited, no Auth0, no quota, no 24 h window — it sends from your agent number to you.
2. **WhatsApp → Observer acting:** `/observer <task>` (or set `FORWARD_TO_OBSERVER=true`) hands your message to the open Observer tab's MCP via `/remote/listen` + `/remote/reply`, so it can capture the screen, use sensors/tools, and the answer comes back here on WhatsApp. This is the old cloud `api/remote.py` idea, minus Redis/Auth0/Twilio.

In the (patched) Observer webapp, run once in the browser console:

```js
localStorage.setItem('nativeWhatsappBridgeUrl', 'http://127.0.0.1:8787')
localStorage.setItem('nativeWhatsappBridgeToken', '<token printed at agent startup>')
```

Remove those two keys to go back to Observer's cloud behaviour.

## 6. Test without a phone

```bash
npm run demo        # dry-run: dashboard + command engine, no WhatsApp connection
npm test            # unit tests (owner gate, calc, reminders, commands, mailbox)
```

Open the printed dashboard URL → **Try a command** box runs the real engine as the owner. Via API you can also verify the owner-only silence:

```bash
curl -X POST localhost:8787/api/simulate -H "x-bridge-token: <token>" -H 'content-type: application/json' \
  -d '{"text":"/help","from":"919999999999"}'   # → {"ignored":true,"sent":[]}
```

## 7. Safety model

- **One listener rule:** owner check happens before anything else, on every message, including WhatsApp's new LID addressing (`remoteJidAlt` + LID→phone mapping). Non-owners get nothing — not even an error.
- **1-to-1 only:** groups, communities, newsletters, status and broadcasts are ignored even if you're in them.
- **Localhost bridge:** binds `127.0.0.1`, token-protected, and refuses to send to any number but yours.
- **Shell is OFF:** `/run` does nothing unless you set `ALLOW_SHELL=true` **and** a `SHELL_PIN`. Even then, remember: whoever holds your unlocked WhatsApp holds your PC. Tier-1 `/pc` actions are fixed commands (volume/screenshot/open/lock…) — no shell, no injection surface.
- **Input/power control is OFF by default:** `/pc type|key|click|shutdown…` need `ALLOW_PC_CONTROL=true` (+ set `CONTROL_PIN`!). Power asks `/pc confirm` within 60 s. `/pc get` only serves files under `$HOME` and refuses `.ssh/`/`.gnupg/`/`auth_info/`.
- **Private by default:** notes/todos/history live in one local JSON file; with Ollama, chat content never leaves your PC. Free-tier cloud brains are opt-in only.
- **Your numbers** are defaults in `.env.example` because you asked for them wired in. If you later want them out of git history, keep them only in your private `.env` (gitignored) and blank the example.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| QR expired before scanning | It refreshes automatically; use the latest one (dashboard auto-refreshes). |
| "Logged out" / you unlinked the device from the phone | Auto-recovered (`AUTO_RELINK=true`): the dead login is archived as `auth_info_loggedout_<timestamp>/` and a **fresh QR appears in the logs/dashboard** — just scan again with the **8859555795** phone. One-command manual fallback: `./scripts/relink-whatsapp.sh`. Your `data/` (notes/reminders) is never touched. |
| Connected as the wrong number | You scanned with your personal phone. Run `./scripts/relink-whatsapp.sh` and scan with the **8859555795** phone. (`STRICT_AGENT_NUMBER=true` makes it refuse outright.) |
| Agent doesn't reply to you | Check `/health` on the dashboard; confirm you messaged from `9528923866`, 1-to-1 (not a group). Logs show `ignored non-owner` with a masked number if the gate rejected it. WhatsApp's LID rollout can take one message exchange for the number mapping to appear — send once more. |
| Replies but "no AI brain" | Install Ollama + pull the model, or check `/model`. Commands keep working meanwhile. |
| Port 8787 busy | Set `PORT=8790` in `.env` (update the Observer bridge URL too). |
| `npm: command not found` (node exists) | Fedora splits the packages: `sudo dnf install npm`. |
| Node older than 20 | Upgrade Fedora (`dnf system-upgrade`), use the NodeSource RPM repo, or `nvm install 22` — see `../FEDORA.md`. |
| Service only runs while logged in | `loginctl enable-linger $USER` (check: `loginctl show-user $USER -p Linger`). |
| No QR under systemd | It's in the journal: `journalctl --user -u observer-whatsapp-agent -f`; or open the dashboard URL printed there. (Image-viewer pop-up is desktop/foreground only.) |
| Podman: permission denied writing `auth_info` | SELinux label missing — the compose file's `:Z` volume flags handle it; don't drop them. |
| Moved `auth_info/` from another disk and it won't load | `restorecon -Rv whatsapp-agent/` to relabel for SELinux. |
| `/pc battery` says no battery | Desktop/VM without `BAT*` in `/sys/class/power_supply` — expected. |
| `/pc screenshot` fails on GNOME+Wayland | Mutter restricts silent capture. Install fallbacks (`grim gnome-screenshot`), use KDE/X11, or `/screen` with Observer open (browser screen-capture with your one-time permission). |
| `/pc type/key` says ydotool failed | Daemon not running: `sudo systemctl enable --now ydotool` (check name with `systemctl list-unit-files \| grep ydotool`). |
| PC control says "no graphical session" | Service started before login (linger): `systemctl --user restart observer-whatsapp-agent` after logging in to the desktop. |
| `/pc brightness` permission denied | `sudo usermod -aG video $USER`, then log out and back in. |
