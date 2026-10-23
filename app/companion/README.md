# Observer Android companion

A lean, installable Android client for the existing owner-controlled agent. This is a separate focused build target, **not a rewrite of the large upstream Tauri application**. It deliberately avoids bundling Auth0, telemetry, OCR/WASM runtimes, a JVM/Rust engine or large on-device models into the phone frontend. The existing `app/mobile` project is preserved.

## Design / target

- Samsung Galaxy A53 5G / India-oriented defaults: English-India and Hindi speech, IST formatting, ARM64-compatible Java/WebView host, responsive 360–432px portrait and landscape layouts. No claim of a physical-device benchmark.
- Solid white/near-black themes; **no linear/radial/conic gradients**, external fonts, blur-heavy backgrounds or decorative animated wallpaper.
- Lazy-loaded feature pages and Markdown. Production JS has a hard 650 kB uncompressed budget; no model/WASM bundles. Screen previews default to 960px / at most one frame per 2.5 seconds, serialize captures, revoke old object URLs and stop on background/navigation. They are screenshots, **not 60fps remote video**.
- Android honors system font scale, resizes around the keyboard and handles system-bar insets. Browser preview is responsive, not proof of Samsung One UI behaviour.

## Implemented surfaces

1. Chat: local conversations/search, Markdown/code/tables with HTML disabled, copy/read-aloud, image/PDF/DOCX/TXT attachments (8 MB), explicit request status and no automatic action retries.
2. Tools: a generated, searchable catalog of **157 public commands** from the actual agent HELP template. Selection drafts a message only. Commands still use the same agent, owner gates, PINs and confirmations; not a second AI implementation.
3. PC: authenticated screenshot preview, normalized tap-to-click, keyboard shortcuts and typing; manual input is explicit opt-in and respects CONTROL_PIN, safe access and active-task barriers. No security/login/Wayland-portal bypass.
4. Tasks: actual registry/batch state, one-shot HMAC-bound approvals that fail on replacement/mutation/expiry/replay, and Stop requests. Network loss is **outcome unknown**, not “action failed, retry”. Already-started actions cannot be retracted.
5. Files: actual PC shared/download lists, solver uploads, and authenticated downloads. Generated document/video buffers have bounded, expiring media IDs; credentials never go in app download URLs.
6. Voice: deliberate dictation, PC-agent push-to-talk voice sessions, native TTS/read-aloud, foreground-only microphone use and EN-IN/HI-IN choice. Recognition depends on an installed speech provider, permission and possibly network. No always-listening wake-word service.
7. Direct AI: **Android-only optional BYOK text chat** with Groq/OpenRouter/OpenAI over verified HTTPS. Provider credentials are encrypted locally and never returned to JS after saving. It has no PC tools and no bundled offline LLM. Charges/quotas and provider data policies apply. Switching between PC/cloud starts a new thread; it never silently uploads PC chat history to a cloud mode.
8. Settings: light/dark/system, history controls, data saver, optional Android screenshot/app-switcher protection, model-mode configuration and official Android-release update checks.

### Context and feature parity boundaries

The PC command endpoint accepts bounded explicit recent conversation context; long-term owner memory, action reference context, permissions and pending actions remain shared with that owner's agent/WhatsApp. A local “new conversation” is not a separate owner/account. Native Direct AI is an entirely separate text-only mode.

WhatsApp-specific operations (actual WhatsApp calls, sending messages to contacts, guest messaging) still need a linked WhatsApp channel. All commands remain accessible through chat, but the app does not reimplement every command as a dedicated graphical page. **Background Android push, continuous video/WebRTC, phone-wide accessibility automation, offline on-device LLMs, production signing/Play Store publication and full native background voice are not implemented.** WhatsApp can remain the background notification fallback. No hidden foreground service, unrestricted phone permissions, or fake push toggle is shipped.

PC tools require a running PC agent and the appropriate OS-side permissions. Windows/macOS PC-control parity, actual microphone/audio/file-provider behaviour and real Galaxy A53 battery/thermal/120Hz measurements require device-specific tests.

## Run the browser preview

```sh
cd app/companion
npm ci --no-audit --no-fund
npm run dev
```

The server binds `0.0.0.0:5173` and accepts the Arena preview host. Browser code uses relative `/bridge/api/...` requests; Vite proxies them to `OBSERVER_BRIDGE_TARGET` (default `http://127.0.0.1:8787` **on the development server**, never the user's browser). Set that environment variable before starting Vite to point at a trusted development bridge. Entering an address in browser preview does not reconfigure the server proxy; the pairing dialog explains this. Android connects directly to the explicitly paired PC origin.

Without a paired PC or configured Direct AI provider, the UI is an honest disconnected shell—no synthetic live status or fabricated answers. E2E fixtures exist only in tests, not production assets.

## Build / validate

```sh
npm run build                 # catalog + TypeScript + production build + no-gradient/size contract
npm test                      # validation, state, privacy, rendering, update selection
npx playwright install --with-deps chromium
npm run test:e2e              # browser fixture integration at five viewports
npm run android:sync          # copy ONLY built local assets into Android
cd android
./gradlew lintDebug testDebugUnitTest assembleDebug
```

Android build: JDK 17, Android SDK platform 35/build-tools 35.0.0, Gradle 8.11.1 / AGP 8.9.1. Minimum Android 8/API 26; Galaxy A53's supported OS versions are within this range. Builds need a current Android System WebView; old WebView versions are not supported. The sandbox may lack these tools: the `Android companion` GitHub Actions workflow builds the APK, runs JVM policy tests/lint, and then a real Android-emulator native bridge/Keystore/HTTP smoke test. An emulator is **not** a physical Samsung test. See actual run results, not only the workflow file.

Browser tests cover pairing/header auth, no token storage, all tabs/themes, exact approval payloads, manual-input PIN, upload bytes, disconnect/privacy, stopped screen polling, gradients and overflow. The PC bridge has independent Node regression tests. Native provider inference is **not** validated with a real paid/free API key; never mistake fixture replies for a live model benchmark.

## Pair your PC

Use PC agent **3.9.2+** from this branch for the structured task/approval API. Start the normal agent (or its existing dry-run transport mode if you deliberately do not want a WhatsApp connection; dry-run transport does **not** make enabled PC tools non-destructive). On the phone, enter the bridge origin and dashboard PIN from its console.

Prefer HTTPS or an encrypted private VPN. Explicit opt-in allows HTTP only for literal private LAN/VPN IP ranges, never public HTTP. Never expose port 8787 to the public internet. TLS validation is never disabled, redirects never receive credentials, remote pages cannot navigate inside the privileged WebView, and the phone never needs root.

Native storage uses AES-GCM with a non-exportable Android Keystore key; app backup/device extraction is disabled. This is at-rest protection, **not a biometric app lock or a hardware-keystore certification**. Browser history is localStorage and not encrypted; browser bridge credentials stay memory-only. Sensitive PIN/key-bearing commands and media are excluded from persisted local history. Disconnect clears the saved PC credential and local chat; it does not erase PC/provider copies or stop already-started work.

## Download, signing and updates

The workflow uploads `observer-android-preview` with a **debug-signed Preview APK**, SHA-256 and notice. It uses a separate `in.observer.companion.preview` application ID, so it does not replace a production app. Debug signing keys can change between build runners; preview-to-preview upgrade compatibility is **not guaranteed**. Do not uninstall a production app to install a preview. Test with disposable data until native verification is complete.

Production package: `in.observer.companion`. Release builds have **no fallback signing key**. An owner-controlled stable keystore must be supplied privately through `OBSERVER_KEYSTORE`, `OBSERVER_STORE_PASSWORD`, `OBSERVER_KEY_ALIAS`, `OBSERVER_KEY_PASSWORD`; never commit or paste these secrets in chat. No production key or Play Store release is created by this change.

Update checks use only this repository's non-draft, non-prerelease `android-vX.Y.Z` releases containing an APK. Version comparison is numeric, not lexicographic. The user opens the official release page and approves Android installation. There is no silent installer, automatic PC restart, hidden model download, remote executable-code hot update or automatic retry/replay of PC tasks. A future Play Store build should use the Play Store update flow. Model/PC-agent updates remain separate, explicit operations.

## Source / license

AGPL-3.0-only, matching the repository. Source: https://github.com/pavit12301611/psd-observer . Full license is bundled as `LICENSE.txt`. No upstream signing identity or upstream app-update endpoint is reused.
