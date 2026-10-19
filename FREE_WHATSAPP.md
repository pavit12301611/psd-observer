# Free native WhatsApp for Observer — what changed and how to use it

**Goal:** WhatsApp must work from *native WhatsApp* — you link your second phone
as a companion device, the agent listens **only** to your number, answers you and
acts on your messages — and everything is **free** (no Twilio, no Meta Cloud API
bills, no Observer subscription, no per-message charges).

- 👤 Owner (the only number obeyed): **+91 95289 23866** (`OWNER_NUMBER`)
- 🤖 Agent (the linked WhatsApp): **+91 88595 55795** (`AGENT_NUMBER`)
- 💸 Running cost: **₹0** — your PC's electricity only

Project layout reference: [`STRUCTURE.md`](STRUCTURE.md). Agent deep-dive:
[`whatsapp-agent/README.md`](whatsapp-agent/README.md).

---

## 1. Before → after

| | Before (upstream) | Now (`whatsapp-agent/`) |
|---|---|---|
| Transport | Twilio's WhatsApp (Observer's US bot +1 555-783-4727) | **Your own agent number**, WhatsApp Web linked-device protocol ([Baileys](https://github.com/WhiskeySockets/Baileys)) |
| Linking | Send a 4-word whitelist code to their bot | **Scan a QR once** with the `8859555795` phone (Linked devices), like WhatsApp Web |
| Who can trigger it | Anyone's code paired to their account | **Only +91 95289 23866** — everyone else gets silence, groups included |
| Can it *receive* and act? | Only via cloud mailbox: Twilio webhook → Redis → browser poll → Twilio reply | **Natively two-way on your PC**: message → commands / free local AI / Observer MCP → reply |
| Send limits | Free tier **5 WhatsApps/day**, Meta **24 h window** after your last message | **No quota, no window** (it's a normal chat between your two numbers) |
| Accounts/keys needed | Twilio SID/token + rented number, Auth0, Stripe tiers, SendGrid, Redis, R2 | **None.** Node + your two phones. Ollama optional for AI chat |
| Monthly cost | Twilio fees + hosting + API credits | **₹0** |
| Where data lives | Observer cloud (Redis/R2), Twilio, model APIs | **Your PC** (`whatsapp-agent/data/`), local Ollama by default |

Nothing upstream was deleted: the cloud path still works exactly as before unless
you opt into the native bridge (§3–§4). Twilio is still there for SMS/calls if
anyone wants them.

## 2. Run the agent (the only step that's strictly required)

This fork targets **Fedora Linux** — full guide in [`FEDORA.md`](FEDORA.md). One-shot:

```bash
cd whatsapp-agent
./scripts/install-fedora.sh --service --ollama   # dnf deps + agent + systemd autostart + free local AI
journalctl --user -u observer-whatsapp-agent -f  # logs + linking QR
```

Manual/foreground equivalent:

```bash
sudo dnf install nodejs npm git curl gcc-c++ make python3   # Fedora splits npm from nodejs
cd whatsapp-agent
cp .env.example .env        # both numbers are already set; .env stays private (gitignored)
npm install
./start.sh
```

1. A QR appears in the terminal, in your image viewer on GNOME/KDE, and at the private dashboard URL it prints (under systemd: in the journal).
2. On the **8859555795 phone**: WhatsApp → **Linked devices → Link a device** → scan it.
   (Or `USE_PAIRING_CODE=true` in `.env` and use "Link with phone number instead".)
3. From **your 9528923866 phone**, WhatsApp the agent number: `/help` — it replies instantly.
4. Optional free AI: install [Ollama](https://ollama.com), `ollama pull llama3.2`. Now plain
   messages ("plan my study timetable", Hinglish included) get real AI answers, offline.

Keep it running with the **systemd user service** (`systemctl --user`, linger
enabled so it starts at boot — installed by `scripts/install-systemd.sh`), or
Podman (`podman-compose up -d`, SELinux `:Z` bind labels included). No firewalld
changes are needed (localhost bridge + outbound WhatsApp). Restarting does **not**
need a new QR scan; the session persists in `whatsapp-agent/auth_info/` (gitignored —
treat it like a password, it *is* the agent number's WhatsApp login).

## 3. Observer alerts over your native WhatsApp (optional)

So Observer micro-agents ("when render finishes, WhatsApp me") use your agent instead
of the paid cloud, set once in the Observer webapp's browser console:

```js
localStorage.setItem('nativeWhatsappBridgeUrl', 'http://127.0.0.1:8787')
localStorage.setItem('nativeWhatsappBridgeToken', '<token the agent prints at startup>')
```

`app/src/utils/handlers/utils.ts → sendWhatsapp()` now checks these keys first:
bridge present ⇒ local send (images/videos included), no Auth0 sign-in, no
`429 quota`, no `403 whitelist/24h window`. Absent ⇒ original cloud behaviour.
Existing agent code needs no changes — `sendWhatsapp(response, code)` just works,
and the bridge refuses to message anyone but you regardless of the argument.

## 4. Let WhatsApp drive Observer (screen/camera/tools)

With the same two localStorage keys set and the patched
`app/src/mcp/remote.ts` + `useRemoteControl.ts`:

- `/observer <task>` on WhatsApp (or every plain message, with
  `FORWARD_TO_OBSERVER=true` in the agent's `.env`) is handed to the open Observer
  tab's MCP through a local mailbox (`GET /remote/listen`, `POST /remote/reply`) —
  the free re-implementation of `api/remote.py` in `whatsapp-agent/src/mailbox.js`.
- Observer can capture the screen/camera, run its tools, and the answer (screenshots
  included) arrives back on WhatsApp. `/screen` is the one-word version.
- No account needed for this channel: the bridge token is the credential, and the
  code becomes a placeholder (`native-whatsapp`) since the bridge has one owner.

Self-hosting the Python API instead? Set `WHATSAPP_MODE=native` (+
`WHATSAPP_BRIDGE_URL`, `WHATSAPP_BRIDGE_TOKEN`) and `api/messaging.py` forwards
WhatsApp sends to the bridge, skipping pairing, the 24 h check and quota. Default
`WHATSAPP_MODE=twilio` is untouched.

## 5. Increased functionality (all free)

Beyond "send me an alert", the agent is now a two-way personal assistant:

- **Acts on your messages:** reminders that fire at the right time (`remind me in 10
  minutes to…`), to-dos, notes, `/remember` long-term facts used in AI answers,
  chat memory, `/observer` + `/screen` PC acting, read-only `/pc status|disk|ip`.
- **Free lookups, no keys:** weather (Open-Meteo), Wikipedia, dictionary, India
  headlines (Google News RSS), currency (ECB/Frankfurter), units, safe calculator,
  web-page fetch + AI summary, URL shortener.
- **Media both ways:** photos/files you send are saved on the PC (`/downloads`);
  optional local vision model describes photos; photo + `/sticker` → sticker;
  Observer screenshots come back as images; `/get <file>` pulls files from a shared
  folder to your phone; `/qr`, `/poll`, reactions + typing/read states.
- **AI your way:** local Ollama (offline/private) → optional Groq/Gemini/OpenRouter
  *free tiers* → offline tools. `/model` reports what's live. Answers follow your
  language, Hinglish included.
- **Useful extras:** strong password generator, `/improve` rewriting, choices/dice,
  local dashboard with status + QR + command tester, dry-run simulation mode,
  Fedora dnf installer + systemd user service + Podman, `/pc battery` from Linux
  sysfs and real distro name in `/pc status`, unit tests (`npm test` in `whatsapp-agent/`).

What intentionally did **not** change: email/SMS/calls still use their cloud
providers upstream (only WhatsApp was made native+free, as asked). For other free
channels Observer already has Discord webhooks and Telegram's own free bot API.

## 6. Honest risks & safety (read once)

- **Unofficial client:** Baileys speaks the WhatsApp Web protocol; it is not endorsed
  by WhatsApp/Meta. Accounts that spam or bulk-message get banned. This agent's
  design is the low-risk end (one 1-to-1 chat with your own second number, replies
  only, rate-limited) — keep it that way: never add other recipients, never run it
  on your *main* number.
- **Owner-only is enforced in code, for every message**, including WhatsApp's new
  LID addressing (phone-number hiding): `whatsapp-agent/src/allowlist.js` +
  LID→number resolution in `whatsapp.js`, covered by tests. Non-owners receive no
  reply and no read receipt.
- **Your numbers are in `.env.example` as defaults because you asked for them wired
  in.** They're therefore in this repo's history. To keep them private in future,
  blank the example and rely on your gitignored `.env`.
- **Shell access is OFF** (`ALLOW_SHELL=false`, PIN-gated if ever enabled). The HTTP
  bridge binds `127.0.0.1` and needs its token for everything except `/health`.
- The agent must be running for WhatsApp to be answered — it's a linked device on
  your PC, not a cloud bot. The agent *phone* can be off; linked devices work alone.
