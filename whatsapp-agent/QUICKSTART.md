# 🚀 Run karo — exact steps (Fedora laptop)

Copy-paste, ek step at a time. Total time: ~10 minutes (+ model download).
Everything is free; no paid API, no Observer app.

---

## 0. Kya chahiye (pehle check kar lo)

| Cheez | Detail |
|---|---|
| 💻 Laptop | Fedora Linux (Workstation 40+ / any recent). Internet chalu. |
| 📱 **Do** WhatsApp numbers | **Owner** = tumhara normal number `+91 95289 23866`. **Agent** = doosra number `+91 88595 55795` (purana phone + second SIM, ya eSIM) — agent isi pe chalega. |
| 🔑 Laptop password | `sudo` ke liye (dnf packages install karega). |
| ⏱️ Disk | ~3 GB (Node deps + Ollama model) |

> ⚠️ Agent ko **apne main number pe mat chalao**. Baileys unofficial client hai;
> ek alag number rakhna hi safe tarika hai.

---

## 1. Code laao (git ke bina bhi — 2 tarike)

### 🅰️ Pehli baar install — ek script (recommended)

```bash
URL="https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/20378d42-psd-observer/whatsapp-agent/scripts/install-fresh.sh"
curl -fL -o /tmp/observer-setup.sh "$URL" || curl -fL -o /tmp/observer-setup.sh \
  -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/pavit12301611/psd-observer/contents/whatsapp-agent/scripts/install-fresh.sh?ref=arena/20378d42-psd-observer"
bash /tmp/observer-setup.sh --service --ollama --power --phone
```


Ye 4 kaam karta hai: GitHub se tarball **curl** karta hai (git nahi), code
`~/observer-agent` me rakhta hai, `.env` bana deta hai (numbers pehle se bhare
hue), aur `install-fedora.sh` ko wahi flags ke saath chala deta hai.

Dusra folder chahiye: `--dir ~/psd-observer/whatsapp-agent` add karo.
Sirf download karna hai (install baad me): `--no-install`.

### 🅱️ Git se (agar git hai)

```bash
sudo dnf install -y git
git clone -b arena/20378d42-psd-observer https://github.com/pavit12301611/psd-observer.git
cd psd-observer/whatsapp-agent
```

> ⚠️ 2.0 code sirf `arena/20378d42-psd-observer` branch pe hai, `main` pe nahi.
> Check: `ls src/ | head` → `actions.js agentloop.js doctor.js imaging.js …`

### 🅲 Na script, na git — sirf zip/tar manually

```bash
cd /tmp
curl -fL -o agent.tar.gz \
  "https://codeload.github.com/pavit12301611/psd-observer/tar.gz/refs/heads/arena/20378d42-psd-observer"
tar -xzf agent.tar.gz
mv psd-observer-arena-20378d42-psd-observer/whatsapp-agent ~/observer-agent
cd ~/observer-agent
```

(Ya browser se: `https://github.com/pavit12301611/psd-observer/archive/refs/heads/arena/20378d42-psd-observer.zip`)

---

## 1c. Update karna (git ke bina) — baad me, jab code purana ho jaye

Git ki zaroorat nahi. Ye script GitHub se seedha **tarball** download karta hai
(plain `curl`), purana code backup karke naya copy karta hai, `npm install`
chalata hai aur service restart karta hai.

**Jab tumhare paas pehle se install hai** (code update karna hai):

```bash
curl -fL -o /tmp/agent-update.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/20378d42-psd-observer/whatsapp-agent/scripts/update-from-github.sh"
bash /tmp/agent-update.sh --dir ~/psd-observer/whatsapp-agent
```

(Path apna actual install path daalo — jahan `package.json` hai wahan.
Pata nahi? `find ~ -name package.json -path "*whatsapp-agent*" 2>/dev/null`)

**Pehli baar install kar rahe ho (git clone hi nahi kiya):**

```bash
bash /tmp/agent-update.sh --fresh ~/observer-agent
cd ~/observer-agent
./scripts/install-fedora.sh --service --ollama --power --phone
```

Kya safe rehta hai: `.env`, `auth_info/` (WhatsApp login — QR dobara scan nahi
karna padega), `data/` (PIN, token, notes, reminders, todos, downloads),
`node_modules/` reinstall ho jata hai. Purana code ka backup
`~/observer-agent-backup-<date>.tar.gz` me chala jayega.

**Script bhi nahi chahiye? Sirf zip/tar manually:**

```bash
cd /tmp
curl -fL -o agent.tar.gz \
  "https://codeload.github.com/pavit12301611/psd-observer/tar.gz/refs/heads/arena/20378d42-psd-observer"
tar -xzf agent.tar.gz
cd psd-observer-arena-20378d42-psd-observer/whatsapp-agent
# naye code ko purani install ke upar copy karo (secrets ko chhod ke)
cp -a src webapp test scripts systemd package.json package-lock.json \
      README.md QUICKSTART.md .env.example start.sh \
      ~/psd-observer/whatsapp-agent/
cd ~/psd-observer/whatsapp-agent && npm install
systemctl --user restart observer-whatsapp-agent
```

Version check: `./scripts/update-from-github.sh --check` (remote version dikhata hai).
Browser se bhi download kar sakte ho:
`https://github.com/pavit12301611/psd-observer/archive/refs/heads/arena/20378d42-psd-observer.zip`

---

## 2. Install (ek hi command)

```bash
cd ~/observer-agent          # ya jahan tumne install kiya (🅰️ ka default)
./scripts/install-fedora.sh --service --ollama --power --phone
```

> 🅰️ wale script ke saath ye step automatic ho jata hai — dobara chalane ki
> zaroorat nahi. Installer idempotent hai, phir bhi safe hai.

Ye kya karega (idempotent — dobara chala sakte ho):

| Flag | Kaam |
|---|---|
| `--service` | systemd **user** service — boot pe khud start, autostart + restart on crash |
| `--ollama` | free offline AI + `llama3.2` pull (~2 GB, thoda time) |
| `--power` | tesseract OCR, ffmpeg, wmctrl, zip, pdftotext, bluez, NetworkManager + `ACCESS_LEVEL=full` |
| `--phone` | `HOST=0.0.0.0` + firewalld me TCP 8787 open (Wi-Fi se phone app) |

Beech me `sudo` password maang sakta hai. Ollama fail ho jaye to bhi agent chalega
(baad me fix kar lena).

---

## 3. Logs kholo (doosra terminal)

```bash
journalctl --user -u observer-whatsapp-agent -f
```

Yahan dikhega: `Phone app: http://192.168.x.x:8787/ (PIN: ######)`, token, aur
**linking QR**.

---

## 4. WhatsApp link karo (ek hi baar)

1. **Agent phone** (`+91 88595 55795`) uthao — jis phone pe agent number ka WhatsApp hai.
2. WhatsApp → **Linked devices** → **Link a device**.
3. Terminal/journal me jo QR aa raha hai, scan karo (~20 sec me expire hota hai;
   naya QR khud aa jayega). QR ka PNG: `data/qr.png`.

QR scan nahi ho raha? Doosra tarika:

```bash
# .env me USE_PAIRING_CODE=true karo, phir restart
nano .env
systemctl --user restart observer-whatsapp-agent
journalctl --user -u observer-whatsapp-agent -n 40
# 8-char code aayega → agent phone: Link a device → "Link with phone number instead"
```

Log me `[wa] connected` (ya `open`) dikhe = linked. ✅

---

## 5. Pehla message (owner phone se)

Apne number `+91 95289 23866` se agent number ko WhatsApp karo:

```
/help
```

Phir ye try karo:

```
/access                    → 61 tools, level full, kya allowed hai
/pc status                 → laptop ki halat
/screenshot                → laptop ka screenshot
chrome kholo               → (Hinglish bhi chalta hai)
awaaz kam karo
downloads me kya hai
/todo add kal resume bhejna
/model                     → kaunsa free AI brain connected hai
```

Koi doosra number message karega → **koi reply nahi** (owner-only by design).

---

## 6. Phone app (ghar ke Wi-Fi pe)

1. Laptop ka IP lo: `hostname -I | awk '{print $1}'`
2. Phone pe kholo: `http://<WO-IP>:8787/`
3. **PIN** daalo: `cat data/dashboard-pin.txt`
4. Chrome menu → **Add to Home screen** → full-screen app ban jayega.

App me: Chat, Panel (screenshot/volume/lock/…), Files (PC ki files phone pe download), Settings (QR, status, logout).

---

## 7. (Optional) ghar se bahar bhi app chahiye

WhatsApp to already **kahin se bhi** chalega. Sirf app ke liye:

```bash
./scripts/setup-remote.sh
```

Tailscale install + login → URL + PIN print karega → phone pe Tailscale app
(same account) → wahi URL kholo. Router pe kuch forward nahi karna.

---

## 8. Rozmarra ke commands

```bash
systemctl --user status observer-whatsapp-agent    # chal raha hai?
systemctl --user restart observer-whatsapp-agent   # restart
journalctl --user -u observer-whatsapp-agent -n 100 --no-pager   # last 100 lines
./scripts/relink-whatsapp.sh                       # dobara QR (unlink ho gaya ho to)
./scripts/install-systemd.sh --uninstall           # band + autostart hatao (data safe)
./scripts/install-fedora.sh                        # sirf deps update/dobara
```

Foreground (systemd ke bina) chalana ho:

```bash
./start.sh
```

---

## 8b. Screenshot kaala aa raha / PC control kaam nahi kar raha? (Wayland)

Fedora GNOME Wayland pe purane screenshot tools "chalte" hain par **kaali image**
dete hain, aur typing/clicking ke liye alag driver chahiye. Ek command:

```bash
./scripts/fix-desktop.sh
```

Phir WhatsApp pe **`/doctor`** bhejo — asli screenshot leke, brightness naap ke,
har tool check karke exact fix batayega.

- Pehli screenshot pe PC screen pe **"Allow screenshot?"** dialog aayega →
  *Allow* / *Always allow* dabao. Dialog khula rehne tak agent 60 sec tak wait
  karta hai (`PORTAL_TIMEOUT_MS`), aur file `~/Pictures/` se khud utha leta hai.
- GNOME Wayland pe ho to har screenshot pe prompt aa sakta hai (gdbus ka koi
  app id nahi hota). Roz screenshot lene ho to login screen pe gear → **"GNOME
  on Xorg"** se login karo — wahan bina prompt ke capture hota hai.
- Agar error me `No such interface "org.freedesktop.portal.Desktop.Screenshot"`
  aaye to portal ka GNOME backend missing hai:
  `sudo dnf install xdg-desktop-portal xdg-desktop-portal-gnome` phir
  `systemctl --user restart xdg-desktop-portal-gnome xdg-desktop-portal`
  (`fix-desktop.sh` ye khud karta hai aur verify bhi karta hai).
- Typing/clicking ke liye `ydotool` ka daemon chahiye:
  `sudo systemctl enable --now ydotool` + `/dev/uinput` hona chahiye.
- Jo **kabhi nahi** hoga (OS ki security, by design): lock screen / password
  prompt me type karna, jab koi logged-in na ho tab screen control, aur GNOME
  Wayland pe window list.

Ab test: `/screenshot` (asli screen), `/pc type hello`, `/pc key super`,
`/pc click 600 400`, `/pc scroll down 5`.

Lamba text likhna ho (500+ characters, multi-line): `/pc paste <text>` —
clipboard + Ctrl+V, instant aur koi limit nahi. `/pc type` bhi ab koi limit
nahi rakhta (chunks me type karta hai).

---

## 9. Setup verify (2 minute)

```bash
cd ~/psd-observer/whatsapp-agent
npm test                      # 31/31 pass hona chahiye
node --check src/index.js     # syntax
curl -s localhost:8787/health # {"ok":true,...}
```

WhatsApp pe: `/access` → `61 tools`, `/model` → `Ollama · llama3.2` (ya jo bhi).

---

## 10. Kuch kaam na kare? (sabse common 6)

| Problem | Fix |
|---|---|
| QR journal me nahi dikh raha | `journalctl --user -u observer-whatsapp-agent -f` (systemd pe auto-open band hai). Ya QR `data/qr.png` kholo. |
| `Port 8787 is already in use` | Puraana process: `systemctl --user stop observer-whatsapp-agent` ya `pkill -f "src/index.js"`. Ya `.env` me `PORT=8788`. |
| `No graphical session found` | Laptop ki screen pe login hona chahiye (lock screen bhi theek). Boot pe start hua tha to: `systemctl --user restart observer-whatsapp-agent`. |
| **Screenshot kaali aati hai** | Wayland X11 tools ko block karta hai (exit 0 + black frame). `./scripts/fix-desktop.sh`, PC pe "Allow screenshot?" → Allow, phir `/doctor`. |
| Typing/clicking nahi hota | `sudo dnf install ydotool && sudo systemctl enable --now ydotool`; `/dev/uinput` hona chahiye. `./scripts/fix-desktop.sh` sab kar deta hai. |
| `volume` → `No wpctl/pactl` | `sudo dnf install wireplumber pipewire-pulseaudio` |
| WhatsApp ne device unlink kar diya | Auto-relink on hai — journal me naya QR aayega, scan kar lo. Warna `./scripts/relink-whatsapp.sh`. |

Poora engineering log (kya banaya, kaise, saare errors + fixes, saari commands):
[`BUILD-LOG.md`](BUILD-LOG.md).

Aur zyada: [`README.md`](README.md) (agent guide) · [`../FEDORA.md`](../FEDORA.md)
(Fedora specifics) · [`../FREE_WHATSAPP.md`](../FREE_WHATSAPP.md) (poora scene).

---

## 11. Safety — jo default me band hai

- `ALLOW_SHELL=false` — raw shell band. Chahiye to `.env` me:
  `ALLOW_SHELL=true` + `SHELL_PIN=1234`, phir `/run 1234 df -h`.
- Destructive cheezein (delete, kill, shutdown, close app) har level pe
  **`haan`/`nahi`** poochti hain, 2 min timeout.
- App sirf **tumhare Wi-Fi** pe (ya Tailscale pe), PIN ke peeche. Router pe
  8787 forward **mat** karo.
- `.env`, `auth_info/` (WhatsApp login), `data/` — kabhi git me mat daalo
  (already gitignored).
