# Running this on Fedora Linux

Everything below is written for **Fedora Workstation (40+; any recent Fedora works)** —
`dnf` packages, a `systemd --user` service, `journalctl` logs, Podman instead of
Docker, and Fedora's SELinux/firewalld specifics called out where they matter.

**TL;DR — the WhatsApp agent:**

```bash
git clone https://github.com/pavit12301611/psd-observer.git
cd psd-observer/whatsapp-agent
./scripts/install-fedora.sh --service --ollama   # deps + agent + autostart + free local AI
journalctl --user -u observer-whatsapp-agent -f  # scan the QR with the 8859555795 phone
# …then from your 9528923866 phone, WhatsApp the agent number:  /help
```

---

## 1. WhatsApp agent (the main thing)

### Manual equivalent of the installer

Fedora ships `npm` as a **separate package** from `nodejs` — install both
(Fedora 40 gives Node 20 LTS, 41+ gives Node 22; the agent needs ≥ 20):

```bash
sudo dnf install nodejs npm git curl gcc-c++ make python3
node --version && npm --version

cd whatsapp-agent
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

### Firewall (firewalld): nothing to open

The bridge binds **127.0.0.1:8787**, and WhatsApp traffic is an outbound WebSocket
to WhatsApp's servers — Fedora's default firewalld policy needs **no changes**.
Only if you deliberately set `HOST=0.0.0.0` for LAN access (not recommended) would
you need `sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload`
— and then the bridge token is your only gate, so think twice.

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
podman-compose logs -f    # QR in the logs; dashboard stays at 127.0.0.1:8787
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
| Podman: permission denied on `auth_info` | Missing SELinux label — the compose file's `:Z` flags fix it |
| Moved `auth_info/` from another disk, agent can't read it | `restorecon -Rv whatsapp-agent/` |
| `/pc battery` says no battery | Desktop/VM — no `BAT*` under `/sys/class/power_supply`; expected |
| Ollama answers slowly on CPU | Use a smaller/faster model (`llama3.2:1b`, `qwen2.5:3b`) — `/model` shows what's pulled |
