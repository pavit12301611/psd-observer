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

## 1. Code laao (branch dhyan se)

Repo ka 2.0 code `arena/20378d42-psd-observer` branch pe hai — **`main` pe nahi**:

```bash
sudo dnf install -y git
git clone -b arena/20378d42-psd-observer https://github.com/pavit12301611/psd-observer.git
cd psd-observer/whatsapp-agent
```

Check: `ls src/ | head` → `actions.js agentloop.js apps.js nlp.js …` dikhna chahiye.

---

## 2. Install (ek hi command)

```bash
./scripts/install-fedora.sh --service --ollama --power --phone
```

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
/access                    → 57 tools, level full, kya allowed hai
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

## 9. Setup verify (2 minute)

```bash
cd ~/psd-observer/whatsapp-agent
npm test                      # 31/31 pass hona chahiye
node --check src/index.js     # syntax
curl -s localhost:8787/health # {"ok":true,...}
```

WhatsApp pe: `/access` → `57 tools`, `/model` → `Ollama · llama3.2` (ya jo bhi).

---

## 10. Kuch kaam na kare? (sabse common 6)

| Problem | Fix |
|---|---|
| QR journal me nahi dikh raha | `journalctl --user -u observer-whatsapp-agent -f` (systemd pe auto-open band hai). Ya QR `data/qr.png` kholo. |
| `Port 8787 is already in use` | Puraana process: `systemctl --user stop observer-whatsapp-agent` ya `pkill -f "src/index.js"`. Ya `.env` me `PORT=8788`. |
| `No graphical session found` | Laptop ki screen pe login hona chahiye (lock screen bhi theek). Boot pe start hua tha to: `systemctl --user restart observer-whatsapp-agent`. |
| `screenshot` kaam nahi karta (Wayland) | `sudo dnf install grim` (GNOME Wayland) — `--power` ye karta hai. |
| `volume` → `No wpctl/pactl` | `sudo dnf install wireplumber pipewire-pulseaudio` |
| WhatsApp ne device unlink kar diya | Auto-relink on hai — journal me naya QR aayega, scan kar lo. Warna `./scripts/relink-whatsapp.sh`. |

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
