# What to add next — connections & beyond

> Audit of this fork at `3.13.0` (commit `8b9f750`), based on reading the code, not the
> README. Every "missing" below was checked with `grep` — if it says *no SMTP*, that
> means `grep -rn smtp whatsapp-agent/src` really returns nothing.
>
> TL;DR: the agent can **watch and control your PC** better than anything else here, and
> it can **shout at you on WhatsApp** — but it cannot **act inside your accounts**, and
> if WhatsApp unlinks, it goes **completely silent**. Fix those two first.

---

## 1. What is actually connected today

### Outbound — "tell me when X happens"

| Channel | Observer app (`app/src/utils/handlers/utils.ts`) | `whatsapp-agent/` | Notes |
|---|---|---|---|
| WhatsApp | ✅ `sendWhatsapp` | ✅ native Baileys | fork's main path, ₹0 |
| SMS / voice | ✅ `sendSms` (Twilio) | ❌ | paid cloud only |
| Email | ✅ `sendEmail` (SendGrid) | ⚠️ **read-only** (`mail.js` + `imap.js`) | no way to *send* mail locally |
| Telegram | ✅ `sendTelegram` | ❌ | |
| Discord | ✅ `sendDiscord` (webhook) | ❌ | app-only |
| Pushover / Gotify | ✅ `sendPushover` / `sendGotify` | ❌ | app-only |
| Slack / ntfy / generic webhook | ❌ | ❌ | **nothing** |

So the app has **7 channels**; the always-on local agent has **1**.

### Inbound — "read my world"

* Gmail/Outlook/Yahoo unread digest over raw IMAP (`imap.js`, app-password, zero deps) — read-only.
* Google Calendar pull via the secret ICS URL (`gcal.js`) + local `calendar.json`; write = export an `.ics` you import by hand.
* Web research: `reach.js` (web/search, YouTube, GitHub read, Reddit, Twitter, HN, RSS) + `tools.js` (weather, wiki, news, FX rates, shortener).
* Local personal data: notes, to-dos, reminders, journal, expenses, study packs — all JSON under `data/`, nothing leaves the PC.

### Write / act inside *your* apps

Home Assistant (or any) webhook via `smarthome.js`… and that is the whole list.
No Notion, no Slack, no Sheets/Docs/Drive, no Linear/Jira, no Gmail send, no GitHub writes.

### Extensibility

`mcp-server.js` (535 lines) means the agent **is** an MCP server — other AI tools can call
it. There is **no MCP client** and no `@modelcontextprotocol/sdk` dependency, so the agent
cannot consume anyone else's MCP server. Every new integration therefore means a new
bespoke JS module (`gcal.js`, `mail.js`, `smarthome.js`, …). That is the structural cost
you're paying today.

---

## 2. Ranked recommendations

Effort = my honest estimate for *this* repo's standards (module + `/command` + tests in
`test/` + docs, CI green on Node 20/22/24).

### P0 — small, removes a real hole

**① Local SMTP send → the last cloud dependency in messaging is gone.**
The fork proudly kills Twilio for WhatsApp, but "email me this" still goes
`app → api.observer-ai.com → SendGrid → Auth0 token`. `imap.js` already proves the pattern
(raw TLS, zero deps, app password). A sibling `smtp.js` (~150 lines: `EHLO`, `AUTH LOGIN`,
`MAIL FROM`, `RCPT TO`, `DATA`) plus `/email to <addr> <text|file>` reuses the **same app
password** the user already typed for `/mail setup`, so setup cost is zero.
*Effort ½–1 day. Files: `src/smtp.js`, `src/mail.js`, `src/commands.js`, `test/smtp.test.js`.*

**② Notification fan-out + dead-man's switch.**
Today: agent phone unlinks / Baileys hiccups → *silence*. Reminders, watch alerts and
`/doctor` results all vanish into a socket nobody is reading. Add one `src/notify.js` with
pluggable sinks (`NOTIFY_FALLBACK_URL` for Discord/Slack/ntfy/generic webhook, SMTP as a
second), send critical alerts to WhatsApp **and** the fallback, and fire a "WhatsApp
disconnected for N minutes" alert through the fallback. ntfy is the sweet spot: free,
self-hostable, phone push without FCM — and it also solves the Android-companion push item
that `app/companion/README.md` still lists as outstanding.
*Effort ~1 day. Files: `src/notify.js`, `src/whatsapp.js` (connection state hook), `.env.example`, tests.*

### P1 — the actual "new connections" people will use

**③ MCP client hub — one mechanism instead of N modules.**
`/mcp add notion`, `/mcp list`, `/mcp doctor`. Implement stdio + streamable-HTTP transports,
`data/mcp.json` (0600) for server config/secrets, tool namespacing (`notion.search`), output
caps, and — the part that matters — reuse the existing `actions.js` permission levels plus
`guard.js` confirmations so a third-party tool can never silently `power off`.
One PR then buys Notion, Slack, Linear, GitHub (writes), Supabase/Postgres, Google
Drive/Sheets and Figma, because first-party MCP servers already exist for all of them.
*Effort 3–5 days. Files: `src/mcphub.js`, `commands.js`, dynamic entries in `actions.js`, `guard.js`, `doctor.js`, `test/mcp-hub.test.js`, docs.*

**④ Cloud-event watchers — the product's own tagline, delivered.**
"When my render/deploy/CI finishes, message me." You already have `cron.js`, `watch.js` and
`reach.js`'s GitHub REST read. Add two tiny pollers: Vercel deployment state (`VERCEL_TOKEN`)
and GitHub Actions `in_progress → completed` (`gh` auth). Half a day each, and it is the
single best demo of "When X then Y" that this fork can show off.
*Effort ~½ day. Files: `src/watch.js` or new `src/deploywatch.js`, `actions.js`, tests.*

**⑤ A log sink for `data/*.json` — makes the logging half of the product shareable.**
"When my dog finishes eating, log it" is core Observer, but all logs are local JSON only.
Add one `datastore` module with pluggable sinks: Google Sheets via an Apps Script webhook
URL (no OAuth), Supabase REST (`sb_publishable...` key), or local SQLite for offline.
Then `/expenses`, `/journal`, `/screentime`, `/study` can auto-append and you get charts for
free in Sheets/Supabase.
*Effort ~2 days. Files: `src/datastore.js`, `expenses.js`, `journal.js`, `screentime.js`, tests.*

### P2 — nice, do after the above

**⑥ `observer.sh mcp link`** — write the Claude Desktop / Cursor config for `mcp-server.js`
in one command. The server already exists; this is a 60-line script plus docs, and it is the
cheapest way to look impressive to the developer audience.

**⑦ Telegram inbound parity** — `router.js` is transport-agnostic, but inbound is
WhatsApp-only. A Telegram bot (`getUpdates`, no linking, no Baileys) as a second transport
would remove the fork's biggest fragility: a single un-official WhatsApp session for
everything. ~2 days.

**⑧ Companion app push via ntfy** — replaces "FCM or nothing" for background notifications;
reuses ②'s sink. ~1–2 days.

---

## 3. "Something else" — repo hygiene, zero features but real value

| Item | Why it matters |
|---|---|
| **3 binaries are in Git**: `Agent-Reach-main.zip` (660 K), `Agent-S-main.zip` (3.3 M), `whatsapp-agent/release-bundle.tar.gz` (1.3 M) | ~5.3 MB of dead weight in every clone. `reach.js` is already *adapted* from Agent-Reach, so the zip is provenance, not source. Move them to a GitHub Release/`docs/vendor/` + `.gitignore`. Keep the bundle only if `verify:bundle` still needs it — it does, so leave that one and drop the two zips. |
| **Stray file `whatsapp-agent/-c`** | A 69-byte PNG, tracked in Git, clearly a typo'd `screenshot -c` shell accident. `git rm` it. |
| **README ↔ code drift is untested** | 43 test files, mutation testing, coverage gates — but nothing checks that the slash commands in `README.md` still dispatch in `commands.js` — and that README holds **183 distinct `/…` tokens** (commands mixed with file paths like `/tmp`, which is exactly why drift goes unnoticed). A `test/docs.test.js` that extracts `/command` tokens from the docs and asserts each one dispatches is ~40 lines and fits the existing CI culture perfectly. |
| **No `ROADMAP.md` / `CHANGELOG.md`** | `version 3.13.0` + `release-notes.json` exist, but a newcomer can't see what's planned vs shipped. A 30-line roadmap (this file, trimmed) plus release-notes → CHANGELOG generator closes it. |
| **Security is actually fine, don't "fix" it** | PIN login is rate-limited with a 5-minute lockout (`server.js:225-368`), comparisons are `safeEqual`, secrets live in gitignored `data/`. Worth documenting in `FREE_WHATSAPP.md` so reviewers stop asking. |

---

## 4. If I had to pick three PRs

1. **`smtp.js` + `/email`** — half a day, finishes the ₹0 story, no new concepts.
2. **`notify.js` + fallback/dead-man's switch** — one day, turns "silent failure" into
   "you always hear about it".
3. **`mcphub.js`** — the big one, but it is the *only* item on this list that makes every
   future integration cheap.

Everything else (Vercel watcher, Sheets sink, `mcp link`, Telegram) is a good follow-up week.

---

### If you meant connections for *our* work on this repo, not the product

GitHub is already wired (`git` + `gh` work here), so PRs, issues, checks and releases need
no extra connector. Slack / Notion / Linear / Figma connectors would only help to *post*
status updates — nothing in the code path needs them. I'd skip them until there's a team
using them.
