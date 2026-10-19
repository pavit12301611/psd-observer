# 👁️ Observer WhatsApp Agent — free, native WhatsApp

A personal WhatsApp agent that runs on **your own computer for ₹0**:

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
| A PC/laptop that stays on while you want the agent awake (old laptop/Raspberry Pi is perfect) | The agent process lives here | Free (electricity only) |
| Node.js 20+ | Runs the agent | Free — nodejs.org |
| Phone with WhatsApp on `8859555795` | This becomes the agent; you scan the QR with it once | Free |
| Your phone `9528923866` | The only number the agent obeys | Free |
| Optional: Ollama + `llama3.2` model | Free offline AI answers | Free — ollama.com |

## 2. Setup (5 minutes)

```bash
cd whatsapp-agent
cp .env.example .env     # your two numbers are already filled in; edit only if they change
npm install
npm start
```

Windows users can double-click **`start.bat`** instead (it installs deps on first run, then starts).

Then link the agent phone **once**:

1. The terminal shows a QR code (also saved to `data/qr.png` and shown on the local dashboard — the private dashboard URL is printed at startup).
2. On the **`8859555795` phone**: WhatsApp → **Linked devices** → **Link a device** → scan the QR.
   - No camera for the QR? Set `USE_PAIRING_CODE=true` in `.env`, restart, and use **"Link with phone number instead"** with the 8-character code it prints.
3. From **your phone (`9528923866`)**, send the agent number a WhatsApp: `/help`
4. It replies. Anyone else who messages the agent number: silence. ✅

The login is stored in `auth_info/` (like a browser's WhatsApp Web session). Restarting the PC/agent does **not** need a re-scan unless you log the device out from the phone. **Never share or commit `auth_info/`** — it's a full WhatsApp login for that number (it's gitignored).

### Free AI brain (recommended)

Install Ollama from ollama.com, then:

```bash
ollama pull llama3.2        # ~2 GB, runs on most laptops; try qwen2.5:7b if you have RAM
ollama serve                # usually auto-starts; agent talks to 127.0.0.1:11434
```

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
/pc status
/screen                      ← needs Observer open on the PC (see §5)
any normal question…         ← answered by local Ollama, in your language (incl. Hinglish)
```

Send a **photo** → saved on the PC (`data/downloads/`, list with `/downloads`); with the vision model it's also described. Send a photo with caption **/sticker** → sticker back (needs `npm install sharp`, free). Put files in `data/shared/` → `/get filename` sends them to your phone.

Full command list is in `/help` itself.

## 4. Keep it running

The agent only works while this process runs and the PC is online (same as WhatsApp Web on a laptop — except the agent phone does **not** need to stay online; linked devices work independently).

- **Easiest:** leave the terminal open, or use [PM2](https://pm2.keymetrics.io) (free): `npm i -g pm2 && pm2 start src/index.js --name wa-agent && pm2 save`
- **Windows auto-start:** Task Scheduler → run `start.bat` at log-on.
- **Linux/Pi:** `docker compose up -d` (files included) or a systemd service running `node src/index.js`.
- **Free always-on idea:** an old phone with Termux, a Raspberry Pi, or Oracle Cloud's free-tier VM can host it — but local PC is best, because `/screen` and Observer tools need *your* PC anyway.

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
- **Shell is OFF:** `/run` does nothing unless you set `ALLOW_SHELL=true` **and** a `SHELL_PIN`. Even then, remember: whoever holds your unlocked WhatsApp holds your PC. `/pc status|disk|ip` are read-only and always safe.
- **Private by default:** notes/todos/history live in one local JSON file; with Ollama, chat content never leaves your PC. Free-tier cloud brains are opt-in only.
- **Your numbers** are defaults in `.env.example` because you asked for them wired in. If you later want them out of git history, keep them only in your private `.env` (gitignored) and blank the example.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| QR expired before scanning | It refreshes automatically; use the latest one (dashboard auto-refreshes). |
| "Logged out — delete auth_info" | The phone removed the linked device (or WhatsApp reset it). Stop the agent, delete `auth_info/`, restart, scan again. |
| Connected as the wrong number | You scanned with your personal phone. Stop, delete `auth_info/`, restart, scan with the **8859555795** phone. (`STRICT_AGENT_NUMBER=true` makes it refuse outright.) |
| Agent doesn't reply to you | Check `/health` on the dashboard; confirm you messaged from `9528923866`, 1-to-1 (not a group). Logs show `ignored non-owner` with a masked number if the gate rejected it. WhatsApp's LID rollout can take one message exchange for the number mapping to appear — send once more. |
| Replies but "no AI brain" | Install Ollama + pull the model, or check `/model`. Commands keep working meanwhile. |
| Port 8787 busy | Set `PORT=8790` in `.env` (update the Observer bridge URL too). |
