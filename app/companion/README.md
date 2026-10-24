# Observer Android companion — 1.1 feature pack

**[Download / install the verified Preview](docs/INSTALL.md)** · [Feature boundaries](docs/FEATURES-1.1.md) · [CI evidence](docs/validation-ci.json) · [Private signing setup](docs/SIGNING-SETUP.md)

A focused React/Vite + Java/WebView Android client. The upstream Tauri desktop/mobile application is preserved. PC agent **3.10.0+** is required for this release; the protocol is feature-checked before pairing credentials are retained. This branch has not been merged/deployed to the user's PC automatically.

## Primary fix: long AI answers no longer need one surviving HTTP response

Commands were short, while normal text waited for the AI on a long-lived mobile connection. An Android socket abort could lose the response even though work had started. The exact cause of the original physical-device errno is not established; this release removes that transport dependency:

1. The phone saves a stable request ID before submission.
2. The PC persists an acceptance receipt **before dispatch**, then responds quickly.
3. Small GET requests read status/results. An interrupted acceptance response is recovered by ID, not an automatic repeated POST/action.
4. Tasks can retrieve a result after the app backgrounds/reloads. PC restarts mark unfinished requests **unknown**, never replayed.
5. Already-started operations may finish despite Stop; the settled result remains truthful.

Detailed result retention is bounded to 40 recent results, with up to 2048 safety receipts and 48-hour pruning. This is not an infinite exactly-once guarantee for every external side effect. A full/failed journal rejects new actions instead of silently discarding live safety receipts. Recognized PIN/key-bearing request text is not stored as a job payload. New PC journals/attachments are private owner files (0600), not secure-erasure promises.

Direct-provider text chat remains a different mode; a direct-provider error does not imply that any PC action ran. Live provider inference was not tested using real keys.

## Implemented surfaces

- **Quiet mobile UI:** solid white/true-black/system themes, zero-gradient build contract, responsive A53-size portrait/landscape, system font scale, keyboard/system-bar handling, EN-IN/HI-IN choices. Lazy pages/Markdown and a 650 kB total uncompressed JS budget; approximately 458 kB in this build. No bundled large model/WASM/runtime or telemetry SDK.
- **Chat/files:** local history/search, inert-HTML Markdown/code/tables, copy/read-aloud, uploads, authenticated generated-media downloads and recoverable requests. Image crop/black-white markup updates a draft only, downscales output to 2048px and keeps the 8 MB upload budget. Large/unsupported source images can be rejected to protect memory.
- **157 command catalog:** generated from the actual public HELP. Selecting a tool drafts only; owner/PIN/access/confirmation policy remains the single source of execution authority.
- **Connection Doctor / pairing:** health/version diagnostics, explicit private-IP HTTP risk opt-in, optional owner-enabled LAN DNS-SD advertisement/discovery, 2-minute one-use QR and per-device credentials/revocation. No automatic firewall change, public port forward, certificate bypass or root credential inside QR. Legacy root-token clients cannot be individually revoked; re-pair/rotate legacy credentials separately.
- **PC input:** screenshot preview, opt-in input with CONTROL_PIN/safe-access/active-task barriers, relative touchpad, right-click/scroll and screenshot dragging where the PC backend supports it. Unsupported Wayland dragging reports failure rather than pretending success.
- **Actual WebRTC video:** an owner opens `/desktop` on the PC at localhost/HTTPS and explicitly chooses a monitor/window through browser/OS consent. One paired viewer at a time; no audio or recording. Requested 540p/6fps, 720p/15fps or 1080p/24fps is a target, not measured performance. No TURN relay is bundled; LAN/private VPN and network-specific UDP reachability are required. Input is separately authorized and does not guess a window's coordinate offset.
- **Projects:** selected memory, private text-answer context, editing/export. Private project answers exclude owner-global prompt facts; explicit commands and voice still use owner-wide context/permissions. Projects are not OS/filesystem sandboxes or separate owner accounts.
- **Visual routines:** validated supported steps, side-effect-free preview, manual run or explicit daily trigger (PC timezone). No shell/arbitrary command/nested workflow/auto-confirm step. Busy or approval-blocked windows are skipped; no catch-up/replay after restart.
- **Foreground voice:** real partial captions, deliberate turn submission, optional continuous foreground turns, native/system TTS or PC audio and explicit interruption. Automatic listening pauses on background/error/confirmation. This is turn-taking, not guaranteed full-duplex acoustic barge-in. No hidden microphone service or always-listening phone wake word.
- **Android integration:** Share-to-Observer imports reviewed drafts; shared text is hard-routed as read-only reference data, never executable slash commands/approvals. Native file picker/save, widget and Quick Settings navigation. Wake-on-LAN sends one local Wi-Fi packet for supported NIC/BIOS/network configurations; “sent” is not proof of wake.
- **App access:** Android biometric/device-credential gate with native-side method blocking. It is not a rooted-device defense or a certification of hardware-bound key authentication. Credentials/history use Android Keystore-backed AES-GCM; backup/device extraction is disabled. Browser history is not encrypted; browser credentials remain memory-only. Disconnect clears pending local metadata too.
- **Alerts:** explicit private SSE foreground-service link with persistent notification, not repeated task polling. Samsung/Doze can pause it. Optional FCM HTTP-v1/Android integration is implemented but requires privately configured project credentials and live delivery testing. Push carries opaque server/event IDs/types, not private text/screenshots; lockscreen notification content is generic.
- **Updates:** official stable/beta release checks, numeric version comparison, pinned owner-signer verification in the signed-build workflow, user-approved installation. No silent installer, hidden model download, automatic PC restart or production signing fallback.

## Verify / run

```sh
cd app/companion
npm ci --no-audit --no-fund
npm run dev                 # 0.0.0.0:5173, accepts Arena preview hosts
npm run build               # catalog + strict TS + production + size/gradient contract
npm test
npx playwright install --with-deps chromium
npm run test:e2e
npm run android:sync
cd android
./gradlew lintDebug testDebugUnitTest assembleDebug
```

JDK 17+ (CI 21), SDK platform 35/build-tools 35.0.0, Gradle 8.11.1 / AGP 8.9.1. Minimum API 26, current Android System WebView required. Build-tool upgrade/Play Store compliance should be reviewed before a production rollout.

Browser-facing requests use relative `/bridge/api/...`; Vite proxies to `OBSERVER_BRIDGE_TARGET` on the development server (default server-local `http://127.0.0.1:8787`), never the phone/browser's localhost. Pairing a URL does not reconfigure the browser proxy; the dialog explains this. Proxy cookie/platform authorization headers are not forwarded. The APK uses its explicitly paired origin directly. Without pairing/configured Direct AI, the UI is honestly disconnected; test fixtures do not ship in assets.

## Executed validation and limits

See the linked run, not only workflow configuration. Functional code commit `423b81f` has successful Android build/lint/JVM policy tests, native aborted-acceptance recovery, encrypted state/session restore, reviewed share-intent handling, foreground alert service/generic notification privacy and device-credential app gate.

- 42 frontend unit/component tests.
- 61 browser scenarios passed across five layouts; four intentional skips because the real signaling/peer synthetic-video test runs once on desktop. It does not capture a real desktop.
- 590/590 backend tests on each Node 20/22/24 in CI.
- Local full-source backend/legacy-browser coverage: 74.40% lines / 63.88% branches / 75.99% functions. 158 runtime JS modules / 3531 AST definitions inventoried, not manually proved.
- 18/18 **selected** mutations detected with a passing 113-contract control; not whole-program mutation coverage.
- Registry npm audits reported zero findings in frontend/backend graphs; not a security certification of all native/OS dependencies.

**Not verified:** physical Galaxy A53/One UI behavior, fingerprint hardware, real mic/TTS/camera/NSD/WoL/desktop input and capture integration, battery/thermals/120Hz, paid/free live AI-provider inference and live FCM delivery. No bundled offline LLM or unrestricted phone-wide automation. No production/Play Store publication or automatic main merge. WhatsApp-specific calls/sends/guest messaging still require a linked WhatsApp channel; not every command has a graphical page.

## Optional OS push setup

Private SSE alerts work without a cloud project while Android allows the foreground link. For OS push, create/configure an Android push project for the actual package/signing certificate, and enter only its Android client options in Workspace tools → Alerts. On the PC, set `APP_FCM_CREDENTIALS` to a private service-account JSON file and restart when idle. Do not commit/upload that service-account key to the phone, source, issues or chat. A registered token is not proof of delivery. Outside the LAN, generic push can arrive but retrieving private details still needs the PC to be reachable through HTTPS/private VPN.

## Signing / source

Preview: `in.observer.companion.preview`, debug-signed; runner keys can change, so update compatibility is not guaranteed. Owner release: `in.observer.companion`, stable private PKCS12 required. No debug/unsigned fallback is allowed. Arena's repository-secret API returned 403; the owner must follow the private signing guide before an explicitly requested signed release. The signing key itself was never committed or uploaded publicly.

AGPL-3.0-only, matching the repository; full license bundled. Source: https://github.com/pavit12301611/psd-observer . No upstream app-update endpoint/signing identity reused.

## Updating without reinstalling

From 1.2.0, the interface updates from your paired PC. The PC keeps its own
signing key, the app pins the public key at pairing time, and the bundle is
verified, staged and rolled back on failure. No repository secret is needed and
the APK is not replaced. See [docs/PC-UPDATES.md](docs/PC-UPDATES.md).
