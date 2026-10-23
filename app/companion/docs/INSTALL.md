# Observer for Android — installable Preview

## Download

**[Download the Preview APK ZIP](https://github.com/pavit12301611/psd-observer/actions/runs/40010609637/artifacts/12526901125)**

GitHub sign-in may be required. The archive contains:

- `observer-1.0.0-preview.apk`
- `SHA256SUMS` (checksum of the APK)
- `README.txt` (preview/signing notice)

The Actions artifact expires **2026-11-06 19:24 UTC**. After expiry, rebuild from this branch with the `Android companion` workflow; do not download replacements from unofficial mirrors.

[Verified build and emulator run](https://github.com/pavit12301611/psd-observer/actions/runs/40010609637) · [Machine-readable evidence](validation-ci.json)

**Important:** this is a debug-signed, separate **Observer Preview** app (`in.observer.companion.preview`), not a production-signed/store release. Preview-to-preview updates may need uninstall because runner-generated debug signing keys can differ. Do not uninstall an existing production app to install this preview. Start with disposable test data.

## On your Galaxy A53 5G

1. Download the ZIP in your browser while signed into GitHub if requested.
2. Open Samsung **My Files**, extract the archive and tap `observer-1.0.0-preview.apk`.
3. Review and approve Android's normal install-source/install prompts. Do not disable Play Protect or other device protections.
4. Open **Observer Preview**. The default is a solid light theme; use the moon button or Settings for true-black/system mode.
5. Choose **PC agent** mode for all owner tools, or configure optional **Direct AI** text chat with your own provider in the model picker. No API key is bundled or required just to explore the interface. Never paste keys or PINs in this conversation.

This build targets A53-sized layouts but has **not been tested on a physical Samsung device**. Android emulator evidence does not establish real One UI keyboard/audio/file-provider behaviour, battery life, thermals or 120Hz smoothness. Keep Android System WebView updated.

## Connect the PC

Use **PC agent 3.9.2+** from branch `arena/9787e6e8-psd-observer`. The app rejects older/incompatible bridges at pairing rather than quietly bypassing missing policy features.

The companion changes have not been merged into `main` or deployed to your PC automatically. Review the branch's agent update script and use the existing update process when you are ready. Updating/restarting the PC agent can interrupt work; let active tasks finish first. Preserve your private `.env`, WhatsApp login and `data/`.

For an existing installation, the branch-specific script is:

<https://github.com/pavit12301611/psd-observer/blob/arena/9787e6e8-psd-observer/whatsapp-agent/scripts/observer.sh>

The updater supports `BRANCH=arena/9787e6e8-psd-observer` for selecting this candidate. See the [agent quick start](../../../whatsapp-agent/QUICKSTART.md) and review commands before running them; no update command was executed on your real PC during this work.

Once the new PC agent is running:

1. Keep the phone and PC on the same Wi-Fi, or use an authenticated private VPN/HTTPS endpoint. **Never expose the raw agent port publicly.**
2. Tap **Connect PC** and enter the bridge origin printed by your PC, for example `http://192.168.1.20:8787`.
3. For HTTP, explicitly tick the trusted private LAN/VPN option. It is not application-layer encryption; prefer HTTPS or an encrypted VPN. Public HTTP, localhost, token URLs and credential-bearing origins are blocked.
4. Enter the **dashboard PIN** from the PC agent console. It is not saved. Android stores the resulting credential using Keystore-backed encryption.
5. PC input is off by default. In **PC control**, request a screen preview, enable manual input deliberately and supply the separate `CONTROL_PIN` if configured.
6. Sensitive agent actions appear in **Tasks** for exact-request approval. They cannot be approved in parallel with an active agent operation. If a connection fails, inspect the PC/task state before repeating anything.

The PC must be awake, reachable, running the agent and have the required OS capture/input permissions. No login, sudo/UAC, secure-screen or Wayland-portal bypass is provided. App pairing is not proof that every native PC tool is installed or permitted.

## What's ready in this Preview

- Monochrome light/true-black UI; no gradients; five navigation sections.
- 157 searchable commands from the actual agent HELP, drafting only until Send.
- Chat, local conversations/search, Markdown, copy/read-aloud, uploads and generated-file downloads.
- Authenticated screenshot preview, opt-in touch/keyboard input, live task state, exact-request approvals and Stop.
- Native encrypted credentials/history, system file picker/save flow, dictation/TTS and deliberate PC voice sessions.
- Optional Android-only direct-provider text chat. Charges/limits apply; not a bundled offline model or a claim of Grok/Claude-level intelligence. Live provider inference was not tested with real keys.
- Official Android-release checks that open release notes for a user-approved installation; no silent updater.

**Still not implemented/verified:** Android background push, continuous video/WebRTC, on-device LLMs, unrestricted phone-wide automation, production signing/Play Store release, and physical Galaxy A53 integration/performance. WhatsApp-specific calls/sends/guest messaging still need a linked WhatsApp channel. Long-term owner memory/action context remains shared with the PC agent; PANIC on the PC does not erase the phone/provider/backup copies—clear local conversations separately when needed.

## Validation

- 37 frontend unit/component tests; 45 browser fixture scenarios across five layouts.
- PC agent: 571/571 tests on Node 20, 22 and 24 in GitHub Actions.
- 18/18 selected mutation checks locally; not whole-program mutation coverage.
- Android compilation, lint, Java policy-test task and emulator smoke: passed.
- Production JS: approximately 414 kB uncompressed, lazy-loaded; no bundled large model/WASM/runtime.
- Physical phone and real PC/provider tests: **not performed**.

The sandbox cannot retrieve the artifact from GitHub's separate binary-storage host; use the official download link above in your browser. The APK was built and uploaded by the successful GitHub job, not fabricated or merely renamed from a web build.
