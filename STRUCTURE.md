# Observer — project structure (as unzipped) + what changed for free native WhatsApp

> Studied from `Observer-main.zip` (1,188 files, ~25 MB uncompressed), now extracted into this repo root.

## 1. What Observer is

Observer AI is a **screen-watching micro-agent platform**: small agents loop over sensors
(screen / camera / mic / clipboard OCR…), ask a (preferably local) vision model "did X happen?",
then run JavaScript *tools* — e.g. "when my render finishes, WhatsApp me".

## 2. Structure map

| Path | What it is |
|---|---|
| `app/` | The product. React + Vite + Tailwind webapp (`app/src/`), Tauri desktop shell (`app/desktop/`, Rust), Tauri mobile (`app/mobile/`), native plugins (`app/plugins/` — screen-capture, llm_engine/llama.cpp), Playwright demos/tests (`app/e2e/`, ~12 MB of captured demo sites). Agent loop, MCP chat, sensors and tools live in `app/src/utils/`, `app/src/mcp/`, `app/src/components/`. |
| `api/` | Paid cloud backend (FastAPI, `api.observer-ai.com`). Auth0 auth (`auth.py`, `auth0_manager.py`), Stripe/Apple billing (`payments.py`, `apple_payments.py`), quotas (`quota_manager.py`), marketplace + orgs, Gemini/OpenRouter proxies, Redis (`redis_client.py`), Cloudflare R2 media (`r2_store.py`). |
| `api/messaging.py` | **Old WhatsApp path**: Twilio WhatsApp/SMS/voice. Needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, a rented Twilio number (+1 555-783-4727 bot), 4-word whitelist pairing, Meta's 24 h free-form window, per-tier quotas. Inbound = Twilio webhooks (`/webhooks/whatsapp-incoming`). |
| `api/remote.py` + `app/src/mcp/remote.ts` | Two-way remote control, cloud style: inbound Twilio/Telegram message → Redis mailbox → browser long-polls `/remote/inbox|listen` → MCP (can use screen/tools) → `POST /remote/reply` → Twilio sends the answer. Clever, but needs the whole paid cloud (Auth0 + Redis + Twilio + R2) just to chat with your own PC. |
| `app/src/utils/handlers/utils.ts` | Agent tool implementations. `sendWhatsapp()` → `POST https://api.observer-ai.com/tools/send-whatsapp` with an Auth0 bearer token; 429 = quota, 403 = not whitelisted / 24 h window closed. |
| `cli/` | Rust `observe` CLI easter-egg (`observe sleep 5` → get called when it exits). |
| `docker/` | Deprecated all-in-one Docker + Ollama setup. |
| `websites/` | Landing page, partner dashboard, status page (Vite/React, Cloudflare). |

### The money trail (why WhatsApp wasn't free before)

Twilio number rental + per-conversation WhatsApp fees, Auth0, Stripe-gated tiers
(free tier: **5 WhatsApps/day** in `api/quota_manager.py`), SendGrid, Redis/R2 hosting,
Gemini/OpenRouter credits — all to send a message from a bot number you don't own,
and only inside Meta's 24 h window after the user messaged first.

## 3. What this fork changes — native WhatsApp, ₹0

**New top-level folder: [`whatsapp-agent/`](whatsapp-agent/)** — a small, self-hosted
Node service that links to WhatsApp exactly like WhatsApp Web / a companion device
([Baileys](https://github.com/WhiskeySockets/Baileys), WhatsApp Web protocol over WebSocket,
no browser, no Twilio, no Meta Cloud API, no per-message cost):

```
Owner phone  +91 95289 23866 ──WhatsApp──▶ Agent phone +91 88595 55795
                                              │ linked device (QR / pairing code)
                                              ▼
                                        whatsapp-agent/  (your PC, free)
                                         ├─ owner-only filter (everyone else: silence)
                                         ├─ offline intents (Hinglish/English, zero AI)
                                         ├─ action registry: apps, files, OCR, input,
                                         │   Wi-Fi/BT, recording, power, shell…
                                         ├─ free AI tool-calling: local Ollama first,
                                         │   optional Groq/Gemini/OpenRouter free tiers
                                         ├─ installable phone app (PWA) + dashboard
                                         └─ local HTTP bridge for Observer
                                             (sendWhatsapp + remote-control mailbox,
                                              no Auth0 / Redis / quota)
                                              │
                                        Observer app (optional) — screen/camera/MCP tools
```

* **Listens only to the owner** `919528923866` and runs on the **agent number**
  `918859555795` (both in `whatsapp-agent/.env.example`, overridable in a private `.env`).
  Groups, status, broadcasts, self-messages and every other number are silently ignored.
  New WhatsApp **LID** addressing is handled (`remoteJidAlt`/LID→PN mapping), so the owner
  check still works when WhatsApp hides the phone number behind a LID.
* **Answers and acts**: slash commands + natural-language intents + AI chat with memory,
  reminders that actually fire, media save/describe, and `/observer …` (or
  `FORWARD_TO_OBSERVER=true`) to hand a message to the Observer tab's MCP so it can look
  at your screen/camera and reply — the old `api/remote.py` idea, minus the cloud.
* **Observer app patched (opt-in, cloud path untouched by default)**:
  `app/src/utils/handlers/utils.ts` (`sendWhatsapp`) and `app/src/mcp/remote.ts` use the
  local bridge when `localStorage.nativeWhatsappBridgeUrl` is set (see
  [`FREE_WHATSAPP.md`](FREE_WHATSAPP.md)); otherwise they behave exactly as before.
* **Cloud API patched (opt-in)**: `api/messaging.py` gains `WHATSAPP_MODE=native`, which
  forwards sends to the local bridge and skips Twilio, the 24 h window and quota.
  Default remains `twilio`, so upstream behaviour is unchanged.

### 2.0 modules (what lives where)

| File | Job |
|---|---|
| `whatsapp-agent/src/actions.js` | **One registry of 61 PC actions** with permission levels + destructive confirmations. Used by commands, offline intents and the AI. |
| `whatsapp-agent/src/nlp.js` | Offline intent parser — “chrome kholo”, “wifi off karo”, “thesis.pdf dhundo” work with **no AI installed**. |
| `whatsapp-agent/src/agentloop.js` | Free AI **tool-calling loop** (Ollama / Groq / Gemini / OpenRouter), multi-step. |
| `whatsapp-agent/src/apps.js` | Discovers `.desktop` apps, launches **any** installed app, window control. |
| `whatsapp-agent/src/files.js` | Home-folder file tools: list/read/write/search/zip/download/send, secret paths blocked. |
| `whatsapp-agent/src/systemx.js` | Wi-Fi (nmcli), Bluetooth, systemd services, process kill, webcam, screen recording. |
| `whatsapp-agent/src/ocr.js` | tesseract OCR for screenshots/photos, PDF/DOCX text extraction, `/look` answers. |
| `whatsapp-agent/src/transcribe.js` | Voice notes → text (Groq Whisper free tier or local whisper.cpp). |
| `whatsapp-agent/webapp/` | The installable phone app: `index.html`, `styles.css`, `app.js`, service worker, manifest. `src/webapp.js` generates the PNG icons. |
| `whatsapp-agent/src/imaging.js` | Dependency-free PNG decoder: **detects black/blank Wayland screenshots** instead of sending them. |
| `whatsapp-agent/src/doctor.js` | `/doctor` — tests screenshot, keyboard/mouse, packages, AI and access, with the exact fix for each failure. |
| `whatsapp-agent/scripts/fix-desktop.sh` | Repairs Wayland screenshots (xdg-desktop-portal + grim), input (ydotool daemon, /dev/uinput) and the rest of the toolkit. |
| `whatsapp-agent/src/server.js` | Bridge API + PWA hosting + PIN login + `/api/chat`, `/api/files`, `/api/download`, `/api/action`. |
| `whatsapp-agent/scripts/install-fresh.sh` | **First-time install with no git**: curl the tarball, extract, create `.env`, run the installer (`--dir`, `--no-install`, `--force`). |
| `whatsapp-agent/scripts/update-from-github.sh` | Update/install **without git**: downloads the branch tarball with curl, backs up code, keeps `.env`/`auth_info`/`data`, restarts the service. |
| `whatsapp-agent/scripts/setup-remote.sh` | Free Tailscale setup so the phone app works from **outside** the house (no port-forwarding). WhatsApp commands already work from anywhere. |

See [`whatsapp-agent/QUICKSTART.md`](whatsapp-agent/QUICKSTART.md) for the exact
run steps, [`FREE_WHATSAPP.md`](FREE_WHATSAPP.md) for setup and
[`whatsapp-agent/README.md`](whatsapp-agent/README.md) for the full command list.
