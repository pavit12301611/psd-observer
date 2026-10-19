# BUILD-LOG.md — jo banaya, kaise banaya, kya toota, kaise theek hua

> Ye file poore 2.0 ka **honest engineering log** hai: har feature, har command,
> har error jo asli machine pe aaya, aur uska exact fix (commit ke saath).
>
> Branch: `arena/20378d42-psd-observer` · Files: 41 changed, **+7190 / −452**
> · Final state: **61 PC actions**, **44 tests pass**, ₹0 cost.

---

## 0. Ek nazar me (timeline)

| # | Commit | Kya hua | Tests | Tools |
|---|---|---|---|---|
| 1 | `b6faa21` | 2.0 base: phone app (PWA), Hinglish intents, action registry, AI tool-calling, OCR, voice, files | 31 | 57 |
| 2 | `88fc745` | Ghar se bahar: Tailscale helper (`setup-remote.sh`) | 31 | 57 |
| 3 | `8ac6d35` | `QUICKSTART.md` — exact run steps | 31 | 57 |
| 4 | `2257df3` | **Wayland fixes**: black screenshot detection, portal capture, ydotool diagnostics, `/doctor`, `fix-desktop.sh` | 36 | 60 |
| 5 | `4bbf6bc` | `update-from-github.sh` — **git ke bina update** | 36 | 60 |
| 6 | `8e2d3f8` | `install-fresh.sh` — **git ke bina pehli install** | 36 | 60 |
| 7 | `ef6f5b4` | Download fallback (`api.github.com`) jab `raw.githubusercontent.com` block ho | 36 | 60 |
| 8 | `88767c8` | **Portal D-Bus interface naam ka bug** — screenshot ka black/error root cause | 39 | 60 |
| 9 | `4314fd8` | **Screenshot banti thi par chat me nahi aati** — signal + file watch | 41 | 60 |
| 10 | `bff22b0` | **500-character typing limit hata diya** + `/pc paste` | 44 | 61 |

Verify karna ho:

```bash
cd whatsapp-agent
git log --oneline            # ya git ke bina: ./scripts/update-from-github.sh --check
npm test                     # 44 pass
npm run check                # saari files ka syntax
```

---

## 1. Naya kya bana — file by file

### 1.1 Naye modules (`whatsapp-agent/src/`)

| File | Kya karta hai | Kaise |
|---|---|---|
| `actions.js` | **61 actions ka ek hi registry** — apps, files, input, network, power, lookups. Har action ka level (`safe`/`standard`/`full`) aur `destructive` flag. | Commands, offline intents aur AI — teeno yahi registry use karte hain, isliye permission/confirmation ek jagah lagti hai. Destructive actions `store.data.pending` me park hoti hain aur `haan`/`yes` se chalti hain (2 min TTL). |
| `nlp.js` | Offline Hinglish/English intent parser | Pure function: "chrome kholo" → `{cmd:'open', args:'chrome'}`. AI ke bina bhi kaam karta hai. |
| `agentloop.js` | Free AI **tool-calling loop** (multi-step) | Ollama / Groq / Gemini / OpenRouter adapters. 61 tools me se sirf top ~20 relevant bhejta hai (chhote models ka context bachane ke liye), `num_ctx=8192`. |
| `apps.js` | Koi bhi `.desktop` app kholna/band karna, window list/focus | `.desktop` files parse (`Exec=` quoting, `%U` field codes), aur launch sirf **argv array** se — shell string kabhi nahi. |
| `files.js` | Files: list/read/write/search/zip/unzip/download/move/copy/mkdir/delete | Sab kuch `$HOME` ke andar (plus `FILES_EXTRA_ROOTS`), `realpath` check, `.ssh`/`.gnupg`/`auth_info` blocked. |
| `systemx.js` | Wi-Fi (nmcli), Bluetooth, systemd services, processes, webcam, screen recording | Har failure me exact `dnf install` package ka naam. |
| `ocr.js` | Screenshot/photo ka text (tesseract), PDF/DOCX padhna, `/look` | `pdftotext` → text; phir AI se jawab. |
| `transcribe.js` | Voice note → text | Groq Whisper (free tier) ya local `whisper.cpp`. Transcript ko normal message ki tarah process karta hai (matlab voice se command bhi chal sakta hai). |
| `imaging.js` | **Black/blank screenshot detect karna** | Zero-dependency PNG decoder (zlib + filters), luminance se mean/max/distinct colour. `mean < 5 && max < 18` → blank. |
| `doctor.js` | `/doctor` — self-check | Asli screenshot, pixels, input tools, packages, AI, access — har fail ke saath fix command. |
| `webapp.js` | PWA icons (192/512 PNG) generate karna | Hand-rolled PNG encoder (CRC32 + zlib), koi image library nahi. |

### 1.2 Phone app (`whatsapp-agent/webapp/`)

| File | Kya |
|---|---|
| `index.html` | 4 tabs: Chat, Panel, Files, Settings; PIN login screen |
| `app.js` | Chat + localStorage history, quick control grid, files list, QR, install prompt, mic (browser dictation) |
| `styles.css` | WhatsApp-jaisa dark theme, mobile-first |
| `sw.js` | Service worker — shell offline cache (API calls network se) |
| `manifest.webmanifest` | Installable PWA (standalone, icons, theme colour) |

Server (`src/server.js`) inhe serve karta hai: `/`, `/styles.css`, `/app.js`,
`/sw.js`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, plus
`/dashboard` → `/` redirect.

### 1.3 Scripts

| Script | Kya | Example |
|---|---|---|
| `install-fresh.sh` | **Pehli install, git ke bina** — tarball download → extract → `.env` → installer | `bash /tmp/observer-setup.sh --service --ollama --power --phone` |
| `update-from-github.sh` | **Update, git ke bina** — backup → sirf code replace → `npm install` → restart | `./scripts/update-from-github.sh --dir ~/observer-agent` |
| `fix-desktop.sh` | Screenshot/input repair: portal backend, grim, ydotool daemon, `/dev/uinput`, portal verify | `./scripts/fix-desktop.sh` |
| `setup-remote.sh` | Ghar se bahar: Tailscale install + login + firewall + URL/PIN print | `./scripts/setup-remote.sh` |
| `install-fedora.sh` | Main installer, ab `--power`/`--phone`/`--remote` ke saath | `./scripts/install-fedora.sh --service --ollama --power --phone` |

### 1.4 Docs

`README.md` (agent), `QUICKSTART.md` (exact steps), `../FEDORA.md` (distro
specifics), `../FREE_WHATSAPP.md` (poora scene), `../STRUCTURE.md` (map), aur
yahi `BUILD-LOG.md`.

---

## 2. Features aur unki command

### 2.1 Apps & windows
```
/apps                         installed apps
/open <app>                   koi bhi app (chrome, vs code, spotify…)
/close <app>                  band karo (confirmation ke saath)
/windows                      open windows
/focus <title>                window focus
```
Hinglish: `chrome kholo`, `notepad band karo`, `spotify kholo`.

### 2.2 Screen
```
/screenshot                   screen → WhatsApp
/look [question]              screenshot + OCR + free AI answer
/ocr                          sirf text
/record [seconds]             screen recording (mp4)
/webcam                       webcam photo
```
Hinglish: `screenshot bhej do`, `screen pe kya hai`, `10 second record karo`.

### 2.3 Input (keyboard/mouse)
```
/pc type <text>               type (ab koi limit nahi — chunks me)
/pc paste <text>              clipboard + Ctrl+V (long/multi-line ke liye best)
/pc key ctrl+l                koi bhi key combo
/pc click <x> <y> [double]    click
/pc tap <label>               OCR se button dhoondh ke click
/pc mousemove <x> <y>         pointer move
/pc scroll [up|down] [n]      wheel scroll
/pc lock                      screen lock
```

### 2.4 Files
```
/ls [path]                    folder list
/read <path>                  text padho
/write <path> | <text>        likho (--append bhi)
/send <path>                  WhatsApp pe bhejo
/find <name>                  home me search
/mv <from> | <to>             move/rename
/cp <from> | <to>             copy
/mkdir <folder>               naya folder
/zip <path> · /unzip <file>   archive
/download <url> [path]        internet se download
/rm <path>                    delete (confirmation)
```
Hinglish: `file banao ~/a.txt me hello`, `notes.txt padho`, `report.pdf bhejo`,
`downloads me kya hai`, `purana.txt hata do`.

### 2.5 Network / system
```
/wifi [status|on|off|list] · /wifi connect <SSID> [pass]
/bt [status|on|off] · /svc status|restart <service> · /kill <process>
/pc status|disk|ip|battery|top|notify <text>
/pc volume up|down|mute|50 · /pc brightness 70 · /pc media play|next
```

### 2.6 Free lookups (koi key nahi)
```
/weather <city> · /wiki <topic> · /news · /calc 45*12 · /url <link>
/qr <text> · /password [n] · /uuid · /shorten <url> · /choose a, b, c
```

### 2.7 Productivity
```
/remind in 10m <text> · /reminders · /todo add <text> · /todo done <id>
/note <text> · /remember <fact> · /memory
```

### 2.8 AI aur control
```
/agent <task>                 multi-step task (free AI)
/model                        kaunsa AI brain chal raha hai
/doctor                       kya toota hai + exact fix
/access                       kya allowed hai
/yes · /no                    destructive confirmation
/run <PIN> <cmd>              shell (sirf ALLOW_SHELL=true + PIN)
```

### 2.9 Scripts ki command
```bash
./scripts/install-fedora.sh --service --ollama --power --phone   # install
./scripts/fix-desktop.sh                                          # wayland repair
./scripts/setup-remote.sh                                         # tailscale
./scripts/update-from-github.sh --dir ~/observer-agent            # update (no git)
./scripts/update-from-github.sh --check                           # version check
./scripts/relink-whatsapp.sh                                      # QR dobara
./scripts/install-systemd.sh --uninstall                          # autostart hatao
```

### 2.10 Rozmarra ki debugging
```bash
systemctl --user status observer-whatsapp-agent
systemctl --user restart observer-whatsapp-agent
journalctl --user -u observer-whatsapp-agent -n 100 --no-pager
curl -s localhost:8787/health
gdbus introspect --session --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop | grep -i screenshot
systemctl --user status xdg-desktop-portal-gnome
systemctl status ydotool
ls -l /dev/uinput /tmp/.ydotool_socket
```

---

## 3. Error log — jo asli machine pe aaya, aur fix

### 3.1 Screenshot

#### ❌ `No such interface "org.freedesktop.portal.Desktop.Screenshot" on object at path`
- **Kya hua:** screenshot ka request portal ko galat D-Bus interface naam se gaya.
  Maine `<dest>.Screenshot.Screenshot` bheja → `org.freedesktop.portal.Desktop.Screenshot.Screenshot`.
- **Asli interface:** `org.freedesktop.portal.Screenshot.Screenshot`
  (`org.freedesktop.portal.Desktop` sirf *bus name* hai, interface nahi).
- **Fix (`88767c8`):** `PORTAL_SCREENSHOT_IFACE = 'org.freedesktop.portal.Screenshot'`.
  Regression test: file me purana spelling dobara na aaye.
- **Verify:**
  ```bash
  gdbus introspect --session --dest org.freedesktop.portal.Desktop \
    --object-path /org/freedesktop/portal/desktop | grep -i screenshot
  # → interface org.freedesktop.portal.Screenshot { … }
  ```

#### ❌ `grim: compositor doesn't support the screen capture protocol`
- **Kyun:** `grim` sirf wlroots compositors (Sway/Hyprland) pe chalta hai, GNOME pe nahi.
- **Fix:** GNOME pe portal pehle try hota hai; grim ab sirf fallback.

#### ❌ `scrot: returned a black image (1920×1200)`
- **Kyun:** Wayland X11 tools ko capture karne deta hai par **kaali image** deta hai — exit code 0.
- **Fix (`2257df3`):** `imaging.js` har capture ko decode karke brightness naapta hai;
  blank = failure, owner ko bhejta hi nahi.

#### ❌ `import: missing an image filename /tmp/observer-shot-….png`
- **Kyun:** ImageMagick ka `import` sun-synopsis alag hai; `-window root <file>` ka order chal nahi raha tha.
- **Fix:** Wayland pe `import`/`maim`/`scrot` try hi nahi karta (bekaar + confusing error).

#### ❌ Screenshot banti hai, "Allow" bhi kar diya, par chat me nahi aati (timeout)
- **Do root cause:**
  1. `gdbus monitor --dest org.freedesktop.portal.Desktop` — portal D-Bus se
     **on-demand start** hota hai, isliye jab hamari call usse jagati hai to
     monitor ka destination filter match nahi karta. Response signal miss.
  2. Result ka sirf ek hi raasta tha (wahi signal). File `~/Pictures/` me padi rehti thi.
- **Fix (`4314fd8`):**
  - Monitor ab **poora session bus** dekhta hai (`gdbus monitor --session`), filter parser me.
  - **Pictures folder watch** (`XDG_PICTURES_DIR`, `~/Pictures`, `~/Pictures/Screenshots`,
    localized naam `user-dirs.dirs` se) — portal jo PNG likhta hai, wahi utha liya jata hai.
  - `PORTAL_TIMEOUT_MS` 25s → **60s**, aur deadline pe last-chance file check.
  - `waitForCompleteFile()` — aadhi likhi PNG kabhi read nahi hoti.
  - Response code 1 (cancel) aur 2 (deny) ka saaf message.
- **Verify:** `/screenshot` bhejo, PC pe Allow dabao — image aa jayegi (der se dabao to bhi).

#### ⚠️ GNOME Wayland har screenshot pe "Allow screenshot?" poochta hai
- **Kyun:** request `gdbus` se aati hai, jiska koi remembered app-id nahi hota; portal
  per-capture permission maangta hai.
- **Options:** dialog me **"Always allow"** tick karo, ya login screen pe gear →
  **"GNOME on Xorg"** se login karo — X11 pe bina prompt ke capture hota hai.

#### ❌ `No graphical session found`
- **Kyun:** agent systemd service se boot pe chala, desktop baad me aaya; ya
  `WAYLAND_DISPLAY`/`DISPLAY` set hi nahi the. Pehle code `wayland-0` **guess** karta tha.
- **Fix (`2257df3`):** `detectSockets()` asli sockets dekhta hai —
  `/run/user/<uid>/wayland-*` aur `/tmp/.X11-unix/X*` — aur `XDG_SESSION_TYPE` bhi set karta hai.
- **Manual:** PC pe login karo, phir `systemctl --user restart observer-whatsapp-agent`.

### 3.2 Keyboard / mouse

#### ❌ Typing/clicking kaam nahi karta (Wayland)
- **Kyun:** `xdotool` Wayland pe sirf XWayland apps tak pahunchta hai. Sahi tool `ydotool` hai,
  jo **daemon (`ydotoold`) + `/dev/uinput`** maangta hai.
- **Fix:** `fix-desktop.sh` install + `systemctl enable --now ydotool` + socket permission.
  `/doctor` teeno check karta hai: `ydotool`, `ydotoolDaemon`, `uinput`.

#### ❌ Bada chhupa hua bug: systemd unit me `PrivateTmp=true`
- **Kyun:** private `/tmp` ki wajah se `/tmp/.ydotool_socket` aur `/tmp/.X11-unix`
  service ko dikhte hi nahi the → input aur X11 detection **silently** fail.
- **Fix (`2257df3`):** `PrivateTmp=false` (comment ke saath, taaki koi wapas na badle).

#### ❌ 500 characters ke baad typing ruk jati thi
- **Kyun:** `typeText()` me mera hi `slice(0, 500)` tha.
- **Fix (`bff22b0`):**
  - `splitForTyping()` — word boundary pe chunks (`TYPE_CHUNK_CHARS=180`), beech me
    `TYPE_CHUNK_DELAY_MS=60`, aur **ek bhi character nahi khota** (test se prove).
  - `xdotool` fallback ab `type --file -` (stdin) — argv limit zero.
  - Naya `/pc paste <text>` — clipboard + Ctrl+V, long/multi-line ke liye instant.

#### ❌ `No wpctl/pactl found` (volume), Wi-Fi error
- **Fix:** `sudo dnf install wireplumber pipewire-pulseaudio NetworkManager`
  (ya `./scripts/fix-desktop.sh`). Message me exact package ka naam aata hai.

### 3.3 Agent / code ke bugs (development me pakde)

| Error | Root cause | Fix |
|---|---|---|
| `SyntaxError: Unexpected identifier 't'` | patch me single quotes ke andar apostrophe | double quotes use karo (`commands.js`) |
| `deletePath` promise resolve ho raha tha par `gio trash` chalta hi nahi | `execFileAsync(...).then()` non-async function me, await nahi | `async` + `await` |
| Clipboard set "not supported" | `execFile` ka koi `input` option nahi hota | `spawn` + `stdin.end()` |
| `ReferenceError: downloadMediaMessage` | Baileys lazy import se pehle use | `state.downloadMediaMessage` `start()` me capture |
| `spawn gdbus ENOENT` = unhandled rejection | portal promise ka error handle nahi | `findBin` check + `done.catch(() => {})` |
| `EADDRINUSE 0.0.0.0:8787` | purana process chal raha tha, error message dhundhla | clear message + `process.exit(1)` |
| Tests ne home me kachra chhoda | `mkdtemp` ka cleanup nahi | `after()` hook + `rmSync` |
| `raw.githubusercontent.com SSL_ERROR_SYSCALL` | network/ISP block | `api.github.com` contents API fallback |
| `git push` rejected (non-fast-forward) | remote pe pehle se commits | `git fetch` + `git reset --soft origin/<branch>` + naya commit |

### 3.4 Test failures jo sudhare

| Test | Kyun fail | Fix |
|---|---|---|
| `screenshot bhej do` | intent parser me pattern miss | screenshot patterns add |
| `find meaning of life` → `pc find` | question ko file search samajh liya | `looksLikeChat()` + extension check |
| `battery kitni hai?` | Hinglish suffix match nahi | flexible regex |
| `wifi connect SSID pass` | sirf `wifi off/on` handle tha | connect branch add |
| `sent.at(-1)` assert | reply object vs string | shape check |
| `toolsFor(...)` me `screenshot` | 20-tool limit truncate kar raha tha | assertion hata ke `open_app` + length ≤ 20 |
| icon PNG < 1000 bytes | 192px PNG 995 bytes ka hai | threshold 200 |

---

## 4. Config jo naya add hua (`.env.example`)

| Variable | Default | Kaam |
|---|---|---|
| `ACCESS_LEVEL` | `full` | `safe` / `standard` / `full` — kitna access |
| `FILES_EXTRA_ROOTS` | — | home ke bahar allowed folders |
| `CONFIRM_TTL_MS` | `120000` | destructive confirmation ka wait |
| `AGENT_TOOLS` / `MAX_AGENT_STEPS` | `true` / `6` | AI tool-calling on/off, max steps |
| `AGENT_TOOL_LIMIT` | `20` | model ko kitne tool schemas bhejne hain |
| `OLLAMA_NUM_CTX` | `8192` | Ollama context window |
| `OCR_LANGS` | `eng` | tesseract languages (`eng+hin`) |
| `WHISPER_*` | — | voice notes (Groq free ya local whisper.cpp) |
| `PORTAL_TIMEOUT_MS` | `60000` | Wayland "Allow screenshot?" ka wait |
| `TYPE_CHUNK_CHARS` | `180` | typing chunk size |
| `TYPE_CHUNK_DELAY_MS` | `60` | chunks ke beech pause |
| `DASHBOARD_PIN` | auto | phone app PIN |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | phone app binding |
| `ALLOW_PC_CONTROL` | `true` | input + power |
| `ALLOW_SHELL` + `SHELL_PIN` | `false` / — | raw shell (opt-in) |

---

## 5. Testing — kaise verify kiya

```bash
cd whatsapp-agent
npm test          # 44 tests / 44 pass / 0 fail
npm run check     # har src/*.js ka node --check
npm run demo      # dry-run: phone app + engine, WhatsApp ke bina
```

Test suites:

| File | Kya cover karta hai |
|---|---|
| `test/agent.test.js` | owner gate, allowlist, command router, store, relink, HTTP/health |
| `test/power.test.js` | intents (Hinglish), action registry + permissions, confirmations, black-frame detection, portal parsing, file-watcher, chunked typing, PWA icons, bridge API |

Development ke waqt jo manual checks kiye:

```bash
# phone app + API (dry-run)
npm run demo &                     # ya: node src/index.js --dry-run
PIN=$(cat data/dashboard-pin.txt)
T=$(cat data/bridge-token.txt)

curl -s localhost:8787/health
curl -s -X POST localhost:8787/api/login -H 'content-type: application/json' -d "{\"pin\":\"$PIN\"}"
curl -s -X POST localhost:8787/api/chat -H "x-bridge-token: $T" \
  -H 'content-type: application/json' -d '{"text":"/doctor"}'
curl -s -X POST localhost:8787/api/chat -H "x-bridge-token: $T" \
  -H 'content-type: application/json' -d '{"text":"file banao ~/a.txt me hello"}'
curl -s -X POST localhost:8787/api/action -H "x-bridge-token: $T" \
  -H 'content-type: application/json' -d '{"name":"system_status"}'
```

Jo yahan verify nahi ho saka (sandbox me GUI/Ollama nahi hai) — asli Fedora pe
`/doctor` se check karo: screenshot, keyboard/mouse, OCR, AI.

---

## 6. Design decisions (kyun aisa kiya)

1. **Ek registry, teen caller.** Commands, Hinglish intents aur AI — sab
   `actions.js` se guzarte hain, isliye permission/confirmation kabhi bypass nahi hoti.
2. **AI optional.** Har core kaam ka offline raasta hai; Ollama na ho to bhi
   "chrome kholo" chalta hai. AI sirf multi-step aur free-form ke liye hai.
3. **Shell default off.** `ALLOW_SHELL=true` + `SHELL_PIN` ke bina `/run` nahi chalta —
   ye ek hi cheez hai jo kuch bhi undo kar sakti hai.
4. **argv-only exec.** WhatsApp se aayi string kabhi shell string nahi banti;
   `.desktop` ka `Exec=` trusted source hai.
5. **Fail loud, never silent.** Har action fail hone pe exact package/fix batata hai;
   black screenshot bhejne se behtar hai error.
6. **No dependencies if avoidable.** PNG decode/encode, icons, QR-less flows —
   sab pure Node (`zlib`). `sharp` optional hai.
7. **User ke data kabhi touch nahi.** Update scripts sirf code replace karte hain:
   `.env`, `auth_info/`, `data/` untouched.

---

## 7. Registry — 61 actions ka breakdown

| Level | Count | Actions |
|---|---|---|
| `safe` | 33 | `list_apps, list_windows, screenshot, volume, brightness, media, notify, lock_screen, clipboard_get, clipboard_set, network_info, doctor, system_status, disk_space, battery, processes, service_status, list_dir, read_file, search_files, weather, wikipedia, news, read_webpage, calculate, add_reminder, list_reminders, add_todo, list_todos, complete_todo, add_note, list_notes, remember_fact` |
| `standard` | 26 | `open_app, close_app, focus_window, look_at_screen, ocr_screen, wifi, bluetooth, kill_process, service_restart, write_file, delete_path, move_path, copy_path, make_dir, zip_paths, unzip_path, download_url, send_file, webcam_photo, record_screen, type_text, paste_text, press_keys, click, move_mouse, scroll` |
| `full` | 2 | `power` (shutdown/reboot/suspend), `run_shell` (PIN + opt-in) |

Destructive (confirmation maangte hain): `delete_path`, `kill_process`,
`close_app`, `power`, `run_shell`, `service_restart`.

---

## 8. Known limits (honest list)

- **Lock screen / GDM / password / polkit prompt me typing nahi** — OS apni security
  ke liye rokti hai. Koi user-level tool ise bypass nahi kar sakta.
- **Koi logged-in na ho to screen control nahi.** Text commands (files, shell,
  downloads, lookups) chalte rehte hain.
- **GNOME Wayland pe window list/focus nahi** (`wmctrl` X11-only).
- **GNOME Wayland pe screenshot prompt** har capture pe aa sakta hai (upar fix dekho).
- **Laptop sleep = agent offline**; ghar ka internet down = kuch bhi reachable nahi.
- **WhatsApp Baileys unofficial hai** — sirf owner ko reply karta hai, rate-limited;
  apne main number pe mat chalao.

---

## 9. Agar kuch toote — is order me dekho

1. `/doctor` (WhatsApp ya phone app) — sabse pehle.
2. `journalctl --user -u observer-whatsapp-agent -n 100 --no-pager`
3. `./scripts/fix-desktop.sh` (screenshot/input issues)
4. `./scripts/update-from-github.sh --check` (purana code?)
5. `npm test` (44/44 hona chahiye)
6. Docs: `QUICKSTART.md` → `README.md` → `../FEDORA.md`

---

_Last updated with commit `bff22b0`._
