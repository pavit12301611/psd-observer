# Running this on Fedora Linux

Everything below is written for **Fedora Workstation (40+; any recent Fedora works)** —
`dnf` packages, a `systemd --user` service, `journalctl` logs, Podman instead of
Docker, and Fedora's SELinux/firewalld specifics called out where they matter.

**TL;DR — the WhatsApp agent.** This setup is **curl-only: no `git clone`, no
`git pull`.** (Owner ka workflow git ke bina chalta hai.)

```bash
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/1cff19d3-psd-observer/whatsapp-agent/scripts/observer.sh" \
  || curl -fL -o /tmp/observer.sh -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/pavit12301611/psd-observer/contents/whatsapp-agent/scripts/observer.sh?ref=arena/1cff19d3-psd-observer"

bash /tmp/observer.sh install --service --power --phone --model auto
#   --service  autostart (systemd --user + linger)
#   --power    OCR, recording, Wi-Fi/BT, windows, input, full access level
#   --phone    phone app reachable at http://<PC-IP>:8787/ (firewalld 8787)
#   --model auto   download a local Hugging Face model that fits this PC
#   (--ollama keeps the older Ollama path instead of llama.cpp)
```

It installs to `~/observer-agent` and creates `.env` for you. Updates later are
also curl-only — see [Updating without git](#updating-without-git).

```bash
journalctl --user -u observer-whatsapp-agent -f  # scan the QR with the 8859555795 phone
# …then from your 9528923866 phone, WhatsApp the agent number:  /help
# …and open the printed phone-app URL on your phone, enter the PIN, Add to Home screen
```

---

## 🚀 DeepSeek Harness on Fedora Linux + WhatsApp Full Power (`v2.9.0`)

DeepSeek has **not** released a native `.rpm` / `.AppImage` Desktop package for Linux yet — their official Linux engine is **`@deepseek-ai/dsh`** (`dsh web` + `dsh --profile sdk`). Observer `v2.9.0` runs **official `@deepseek-ai/dsh` right alongside your native WhatsApp agent on Fedora Linux** with zero competing WhatsApp linked devices:

```bash
# 1. Update Observer to v2.9.0 (curl-only, keeps .env + WhatsApp login + data)
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/1cff19d3-psd-observer/whatsapp-agent/scripts/observer.sh"
bash /tmp/observer.sh update

# 2. One-command DeepSeek Harness setup on Fedora (zero sudo required —
#    automatically installs portable Node 22 LTS if needed + @deepseek-ai/dsh +
#    Fedora GNOME "DeepSeek Harness" desktop app icon + auto-starts Web UI!)
bash ~/observer-agent/scripts/observer.sh harness setup

# 3. Optional: add official DeepSeek API key (or sign into DeepSeek Account inside
#    Web UI, OR use your already-configured Groq / OpenRouter / Local GGUF models!)
bash ~/observer-agent/scripts/observer.sh harness key sk-YOUR_DEEPSEEK_KEY
```

### What works out of the box (100% Full Power)
- **On WhatsApp (`+91 95289 23866` → agent chat):**
  - `/dsh <any task>` — runs real DeepSeek Harness with **all native coding & system tools** (`bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `subagent`, `skill`, `cron`, `lsp`, `notebook_edit`) + live step progress + `/stop` cancellation + photo/screenshot/PDF attachments!
  - `/dsh auto on` — turns DeepSeek Harness into your **primary full-time brain** for every WhatsApp message!
  - `/dsh web open` — launches the **official DeepSeek Harness Web UI** window directly on Fedora (`http://127.0.0.1:3080/?token=...`) AND prints your **Phone / Tailscale Web UI URL** (`http://<PC-IP>:3081/?token=...`)!
  - `/dsh cd ~/project` · `/dsh new` · `/dsh sessions` · `/dsh use <id>` · `/dsh model` · `/dsh mode full|safe|readonly`
- **Inside Browser / Desktop `dsh web` too (`mcp-observer`):**
  - Every session shares `~/.dsh` between **WhatsApp** and **Fedora Web UI** AND mounts Observer's live MCP server (`whatsapp_send_message`, `whatsapp_send_file`, `whatsapp_send_screenshot`, `pc_screenshot`, `pc_ui_act`, `pc_system`, `observer_action`, `observer_memory`)!

---

## 1. WhatsApp agent (the main thing)

### Manual equivalent of the installer

Fedora ships `npm` as a **separate package** from `nodejs` — install both
(Fedora 40 gives Node 20 LTS, 41+ gives Node 22; the agent needs ≥ 20):

```bash
sudo dnf install nodejs npm curl gcc-c++ make python3
node --version && npm --version

cd ~/observer-agent        # jahan `observer.sh install` ne rakha (ya apna path)
cp .env.example .env     # owner 919528923866 / agent 918859555795 already set
npm install
./start.sh               # foreground run; QR in terminal + image viewer + dashboard
```

On a desktop the first QR also pops open in your image viewer (`xdg-open`,
GNOME/KDE; disable with `OPEN_QR=false`). Link it from the **8859555795** phone:
WhatsApp → Linked devices → Link a device. Then message it from **9528923866**.

> Old Fedora with Node < 20? `sudo dnf system-upgrade download --releasever=<latest>`,
> or NodeSource's RPM repo (`curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -`
> then `sudo dnf install nodejs` — that build bundles npm), or `nvm install 22`.

### Keep it running: systemd user service (recommended)

```bash
./scripts/install-systemd.sh     # or: npm run service:install
```

This writes `~/.config/systemd/user/observer-whatsapp-agent.service` (template in
`whatsapp-agent/systemd/`), enables + starts it, and enables **linger**
(`loginctl enable-linger $USER`) so it starts at boot and survives logout.
Everyday commands:

```bash
systemctl --user status   observer-whatsapp-agent
journalctl --user -u      observer-whatsapp-agent -f    # logs + linking QR
systemctl --user restart  observer-whatsapp-agent
./scripts/install-systemd.sh --uninstall                # remove (login/data kept)
```

A **user** service is deliberate on Fedora: it runs in your home with your
SELinux context, so `auth_info/` (the WhatsApp login) and `data/` need **no
SELinux relabelling**, and no root process ever holds your WhatsApp session.

### Free AI brain on Fedora (Ollama)

```bash
curl -fsSL https://ollama.com/install.sh | sh   # official installer; creates the ollama service
sudo systemctl enable --now ollama
ollama pull llama3.2                            # ~2 GB; qwen2.5:7b if you have the RAM
ollama pull llava                               # optional: photo understanding
```

Then WhatsApp `/model` should report Ollama running. (`install-fedora.sh --ollama`
does all of this.) NVIDIA/AMD GPU acceleration, if wanted, is Ollama's own Fedora
story — the agent only talks HTTP to `127.0.0.1:11434`.

### Install without git (plain curl — the supported way)

First-time install, nothing but `curl`/`tar` needed (no `git`, no `zip` tool):

```bash
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/1cff19d3-psd-observer/whatsapp-agent/scripts/observer.sh" \
  || curl -fL -o /tmp/observer.sh -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/pavit12301611/psd-observer/contents/whatsapp-agent/scripts/observer.sh?ref=arena/1cff19d3-psd-observer"
bash /tmp/observer.sh install --service --power --phone --model auto
```

Installs to `~/observer-agent` by default (`--dir <path>` to choose). It refuses
to overwrite an existing install unless you pass `--force` (or use the updater
below), and `--no-install` downloads only. Then jump to “Phone app over Wi-Fi”.

### Updating without git (curl only)

No `git pull` needed — the installer/repo works as a plain download:

```bash
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/1cff19d3-psd-observer/whatsapp-agent/scripts/observer.sh"
bash /tmp/observer.sh update --dir ~/psd-observer/whatsapp-agent
bash /tmp/observer.sh update --check          # version compare only
```

It fetches the branch tarball from `codeload.github.com`, backs up the current
code, replaces `src/ webapp/ test/ scripts/ systemd/` + manifests, runs
`npm install`, and restarts `observer-whatsapp-agent`. Your `.env`, `auth_info/`
and `data/` are untouched, so the WhatsApp link survives. First-time install is
`bash observer.sh install --dir <dir>` — same file, no git at all.

### Phone app over Wi-Fi (optional, recommended)

```bash
./scripts/install-fedora.sh --phone
```

This sets `HOST=0.0.0.0` and opens TCP **8787** in firewalld. On the phone,
open `http://<PC-IP>:8787/`, enter the 6-digit PIN printed at startup
(`data/dashboard-pin.txt`), then **Add to Home screen**. It is an installable
PWA — chat, quick controls, files and the linking QR — with **no Observer app
and no Play Store**.

### Phone app from outside the house (free, no port forwarding)

WhatsApp commands work from **anywhere already** — the PC dials out to WhatsApp,
so your phone just needs mobile data. Only the *phone app* needs a route home:

```bash
./scripts/setup-remote.sh          # or: ./scripts/install-fedora.sh --remote
```

This installs [Tailscale](https://tailscale.com) (free personal plan), logs the
PC in, keeps `HOST=0.0.0.0` + TCP 8787 allowed, and prints the exact
`http://<tailscale-ip>:8787/` URL and PIN. Install the Tailscale app on your
phone, sign in with the **same account**, open the URL, "Add to Home screen".
Tailscale is a private encrypted network: the port is not exposed publicly, so
**never** port-forward 8787 on your router (Cloudflare Tunnel + Access is the
alternative if you can't install Tailscale).

Two honest caveats:

- **Laptop must be awake and online.** Closing the lid usually suspends it.
  To keep it serving while plugged in:
  `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`
  (undo with `unmask`, same targets). Battery drain is real.
- **Home internet must be up.** No Wi-Fi/router → the PC is unreachable, from
  Telegram or Tailscale alike. WhatsApp itself also queues messages until the
  link is back.

### Black screenshots / typing & mouse not working (Wayland)

Fedora Workstation defaults to **GNOME on Wayland**, which is not broken — it is
*restrictive on purpose*. Two things follow from that, and both are fixed in one
command:

```bash
./scripts/fix-desktop.sh        # packages + ydotool daemon + agent restart
```

Then send **`/doctor`** on WhatsApp: it takes a real screenshot, inspects the
pixels, checks every input tool and prints the exact fix for whatever is still
missing.

**`UnknownMethod: No such interface "org.freedesktop.portal.Desktop.Screenshot"`**
means the portal is running *without* its desktop backend, so no Screenshot
interface is exported (a running portal alone is not enough):

```bash
sudo dnf install xdg-desktop-portal xdg-desktop-portal-gnome   # KDE: -kde
systemctl --user restart xdg-desktop-portal-gnome xdg-desktop-portal
gdbus introspect --session --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop | grep -i screenshot
```

The last line must list `interface org.freedesktop.portal.Screenshot`. If it does
not, the backend isn't installed for your desktop (GNOME vs KDE) or the session
was started before it was installed — log out/in once.

**Why screenshots are black.** X11-era tools (`gnome-screenshot`, `scrot`,
`maim`, ImageMagick `import`, even GNOME's own Screenshot API) still *run* on
Wayland, exit with code 0 — and hand back a perfectly black frame, because the
compositor refused the capture. The supported path is
**xdg-desktop-portal**, and `grim` (which works on wlroots desktops such as
Sway/Hyprland). The agent now:

1. tries the portal first on Wayland, then `grim`, then the old tools;
2. **decodes every capture and measures its brightness** — a black/empty frame
   is treated as a failure, not sent to you as a "screenshot";
3. keeps trying, and if nothing produces real pixels it tells you why per tool
   instead of showing you a black rectangle.

First portal capture may pop an **"Allow screenshot?"** dialog on the PC screen.
Approve it — or tick *Always allow*. While the dialog is open the agent waits up
to `PORTAL_TIMEOUT_MS` (default 60 s) and, even if the signal is missed or you
click Allow late, it picks the PNG up from `~/Pictures/` — so the screenshot
still arrives.

> **GNOME Wayland asks every time.** The request comes from `gdbus`, which has no
> remembered app id, so the portal may prompt on each capture. If you take
> screenshots often and want them silent, log out and choose **"GNOME on Xorg"**
> from the gear menu at the login screen: X11 allows direct capture with no
> dialog. Everything else in the agent works the same.

**Why typing/clicking does nothing.** On Wayland, `xdotool` only reaches
XWayland apps. The real keyboard/mouse driver is **ydotool**, which needs its
daemon (`ydotoold`) and `/dev/uinput`:

```bash
sudo dnf install ydotool
sudo systemctl enable --now ydotool     # unit may be named ydotoold
ls -l /dev/uinput                        # must exist
```

`/doctor` reports all three: `ydotool`, `ydotoolDaemon`, `uinput`.

**Typing very long text.** `typeText` has no fixed ceiling: it splits at word
boundaries and feeds ydotool chunk by chunk (`TYPE_CHUNK_CHARS`, default 180;
`TYPE_CHUNK_DELAY_MS`, default 60 ms), falling back to `wtype`/`xdotool` —
"xdotool type --file -" reads stdin, so there is no argv limit at all. For
multi-paragraph text, `/pc paste <text>` is better: it sets the clipboard and
presses Ctrl+V, which is instant and preserves newlines/Unicode.

**"It can't operate my whole computer" — the honest limits.** With the above in
place the agent can open/close *any* installed app, type, press any key combo,
move/click/scroll the pointer, read and write files anywhere in your home,
screenshot, OCR, record, control Wi-Fi/BT/volume/brightness/media, manage
services and processes, and shut down/reboot. It still cannot (and should not
be able to) do these:

- **Type into secure prompts** — the lock screen, GDM greeter, password fields,
  polkit/sudo dialogs. That is the OS protecting itself; no user-level tool can
  write there, by design.
- **Control the PC while nobody is logged in.** At the login screen there is no
  user session, so there is nothing to capture or click. The agent keeps
  answering text commands (files, shell, downloads, lookups) — screen things
  resume after login. `systemctl --user restart observer-whatsapp-agent` after
  logging in makes it re-detect the session immediately.
- **List/focus windows on GNOME Wayland** — `wmctrl` is X11-only and GNOME does
  not expose its window list. Opening/closing apps still works; per-window focus
  is best-effort (`/windows` explains this).
- **Reach another user's session or a different TTY.**
- **Get past the OS's own permission prompts** — the first portal screenshot
  needs *your* click on the PC.

Everything else is enabled by `--power` (`ACCESS_LEVEL=full`); destructive
actions still ask `haan`/`nahi` first, and raw shell stays off behind
`ALLOW_SHELL=true` + `SHELL_PIN`.

### Firewall (firewalld): nothing to open for WhatsApp itself

The phone app binds **0.0.0.0:8787** so your phone (same Wi-Fi or tailnet) can
use it — PIN/token protected; `HOST=127.0.0.1` makes it PC-only. WhatsApp traffic
is an outbound WebSocket to WhatsApp's servers, so Fedora's default firewalld
policy needs **no changes for WhatsApp itself** — only TCP 8787 for the app,
which `--phone` / `--remote` opens for you.

### SELinux notes

- **Host install (systemd --user / start.sh):** nothing to do. Files created in
  your home get correct labels automatically. If you *moved* `auth_info/` in from
  another machine/disk and see permission errors, `restorecon -Rv whatsapp-agent/`
  fixes the labels (and `ausearch -m avc -ts recent` / `journalctl` show denials).
- **Podman:** bind mounts need `:Z`. The included `docker-compose.yml` already has
  `./auth_info:/app/auth_info:Z` — without it Podman hits EACCES writing the session.
- **Ports ≥ 1024** (8787) need no `semanage port` changes for user processes.

### Podman alternative (optional)

Fedora's container stack is Podman (no daemon, rootless). The `Containerfile`
builds with both:

```bash
sudo dnf install podman-compose
cp .env.example .env
podman-compose up -d
podman-compose logs -f    # QR + phone-app URL/PIN in the logs (port 8787)
```

Host Ollama is reached as `host.containers.internal:11434` (already set in
`docker-compose.yml`). Prefer the systemd host install if you use Observer's
screen/camera features — those live on the host, not in a container.

### Fedora-flavoured agent extras

- `/pc status` now reports the real distro name from `/etc/os-release`
  (e.g. *"Fedora Linux 42 (Workstation Edition)"*) plus kernel version.
- `/pc battery` reads `/sys/class/power_supply/BAT*` directly — charge %,
  charging state, rough time left. No `upower`/`acpi` packages needed.
- Optional XDG storage: set `DATA_DIR=~/.local/share/observer-whatsapp-agent`
  and `AUTH_DIR=~/.local/state/observer-whatsapp-agent/auth_info` in `.env`
  (defaults stay inside `whatsapp-agent/`, gitignored).

### PC control (`/pc …`) — Fedora desktop control from WhatsApp

Tier 1 works out of the box (screenshot, PipeWire volume via `wpctl`,
brightness, MPRIS media, open app/URL, `notify-send`, `loginctl lock-session`,
clipboard, file find/fetch under `$HOME`, top processes). Tier 2 —
keyboard/mouse (`/pc type|key|click`) and power (`/pc suspend|reboot|shutdown`,
always `/pc confirm`-gated) — needs one flag:

```bash
./scripts/install-fedora.sh --pc-control     # tools + ALLOW_PC_CONTROL=true
```

That dnf-installs `grim gnome-screenshot scrot kde-spectacle playerctl
brightnessctl ydotool xdotool wl-clipboard libnotify tesseract`, enables the
ydotool daemon (uinput; Wayland input), and flips the switch. Then set a PIN
in `.env` (`CONTROL_PIN=1234` → usage `/pc type 1234 hello`) and
`systemctl --user restart observer-whatsapp-agent`.

**Clicking by name:** `/pc tap 1234 Login` finds the on-screen *Login*
button/field by its label (tesseract OCR; optional `OLLAMA_VISION_MODEL`,
e.g. `qwen2.5-vl`, covers icons) and clicks its centre, replying with a
crosshair-marked screenshot as proof. `/pc locate Login` finds without
clicking. Delete/Pay-style labels ask `/pc confirm` first. If taps land
consistently offset by a fixed ratio, that's fractional display scaling —
100 % scale is pixel-exact.

Fedora session caveats (honest ones):

- **GNOME + Wayland screenshots** are the hard case — Mutter restricts silent
  capture; the agent tries the GNOME Shell D-Bus API and several tools. KDE
  (`spectacle`), wlroots (`grim`) and X11 sessions just work. On GNOME+Wayland,
  `/screen` with Observer open (browser capture) is the reliable path.
- **Input on Wayland** = ydotool (daemon must run); `xdotool` only reaches
  XWayland apps. On an X11 session both work.
- **Linger/boot start**: if the user service started before desktop login,
  screenshot/input say "no graphical session" — restart it after login.
- **Brightness** permission: `sudo usermod -aG video $USER`, log out/in.

## 2. Observer app itself on Fedora (optional)

You only need this to build/run the Observer UI for `/observer` and `/screen`
(screen/camera acting) — the WhatsApp agent above is fully useful without it.
The hosted webapp also works: set the two `nativeWhatsappBridge*` localStorage
keys (see `FREE_WHATSAPP.md`) and skip building anything.

### Web app (dev server)

Observer uses `pnpm@10.5.2` (pinned in `app/package.json`); Node's Corepack
ships with Fedora's nodejs:

```bash
sudo dnf install git nodejs npm
corepack enable                 # activates the pinned pnpm
cd app && pnpm install && pnpm dev   # Vite dev server
```

### Desktop app (Tauri) build dependencies

Tauri v2's official Fedora list, plus Rust:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh   # Rust via rustup
# then, from app/: pnpm desktop:dev  /  pnpm desktop:build
```

(Silverblue/Kinoite and other OSTree variants: `rpm-ostree install …` the same
package list, then reboot — or do builds inside a `toolbox`/`distrobox` Fedora
container, which is usually less painful.)

### Cloud API (`api/`) — only if you self-host that too

Not needed for the free path (the agent *is* the backend for WhatsApp). If you
run it anyway, e.g. for `WHATSAPP_MODE=native` forwarding experiments:

```bash
sudo dnf install python3 python3-pip redis ffmpeg-free   # or full ffmpeg via RPM Fusion
cd api && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
sudo systemctl enable --now redis
WHATSAPP_MODE=native WHATSAPP_BRIDGE_URL=http://127.0.0.1:8787 \
WHATSAPP_BRIDGE_TOKEN=<token from agent startup> \
  python api.py --port 8000
```

`ffmpeg-free` is Fedora's patent-free build; WhatsApp video transcoding prefers a
full `ffmpeg` (RPM Fusion free repo) — irrelevant in native mode, where media is
sent as-is through the linked device.

## 3. Fedora troubleshooting

| Symptom | Fix |
|---|---|
| `npm: command not found` but node exists | Fedora splits them: `sudo dnf install npm` |
| Node is 18 or older | Upgrade Fedora / NodeSource RPM / `nvm install 22` (see §1) |
| Service starts only while logged in | `loginctl enable-linger $USER`, verify with `loginctl show-user $USER -p Linger` |
| No QR visible under systemd | It's in the journal: `journalctl --user -u observer-whatsapp-agent -f` (auto-open is disabled headless on purpose), or open the dashboard URL from the logs |
| Unlinked from the phone / "logged out" | Don't delete anything by hand: the agent archives the dead login (`auth_info_loggedout_*`) and a fresh QR auto-appears in `journalctl --user -u observer-whatsapp-agent -f` — scan it with the `8859555795` phone. One-command manual version: `./scripts/relink-whatsapp.sh` (data/ is never touched) |
| Podman: permission denied on `auth_info` | Missing SELinux label — the compose file's `:Z` flags fix it |
| Moved `auth_info/` from another disk, agent can't read it | `restorecon -Rv whatsapp-agent/` |
| `/pc battery` says no battery | Desktop/VM — no `BAT*` under `/sys/class/power_supply`; expected |
| Ollama answers slowly on CPU | Use a smaller/faster model (`llama3.2:1b`, `qwen2.5:3b`) — `/model` shows what's pulled |
| `ollama: server not responding` / "client version is 0.0.0" during install | The binary exists but its server isn't running. `sudo systemctl enable --now ollama`, check `curl http://127.0.0.1:11434` → "Ollama is running", then `ollama pull llama3.2`. No `ollama.service` unit? It was unpacked manually — either reinstall `curl -fsSL https://ollama.com/install.sh \| sh` or just run `ollama serve`. The agent itself doesn't need Ollama: install/start it first (`./scripts/install-systemd.sh`), fix AI later, verify with `/model`. |
| Installer stopped (Ctrl-C) midway | Re-run it — every step is idempotent. If it stopped at the Ollama step, the service step may not have run yet on older copies: run `./scripts/install-systemd.sh` directly. |
