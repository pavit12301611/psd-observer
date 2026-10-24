# 1.1 feature pack — verified Preview, external setup gates remain

This branch is not a production rollout. PC agent **3.10.0+** is required. Functional code `423b81f` passed the [native/web/backend workflow](https://github.com/pavit12301611/psd-observer/actions/runs/40088988614); see validation-ci.json for scope. Stable signing and live OS-push still require private owner configuration.

## Primary fix

PC-agent chat/voice/solve/routine requests use a short accepted-job response with a stable request ID. The result is retained in a private PC journal and read through separate requests. A socket abort never automatically resubmits an action. Pending IDs survive phone UI restarts; Tasks can retrieve results. On a PC restart, unfinished work becomes **unknown**, not replayed. The journal is bounded (40 detailed results plus up to 2048 safety receipts, 48-hour pruning); it is not an infinite exactly-once guarantee for external side effects. Completed-after-stop outcomes remain explicit. Direct-provider mode is separate; a provider/network error there does not imply a PC action.

## New surfaces

- Connection Doctor; optional LAN mDNS discovery, one-time 2-minute pairing QR, per-device tokens/revocation. Legacy root-token clients cannot be individually revoked; re-pair/rotate legacy credentials separately.
- Opt-in private SSE foreground alerts; optional FCM OS-push SDK/server integration. Android Doze/OEM limits can pause the private connection. FCM needs an owner-configured project/service account; no cloud delivery is claimed before setup/live testing. Push carries opaque IDs/types, not private text/screenshots.
- Native device-credential/biometric app-access gate. It is not a rooted-device defense or per-use hardware-key attestation. Alerts have generic lockscreen content.
- Owner-chosen browser WebRTC screen share at `/desktop`; no audio/recording or unattended capture bypass. LAN/private VPN by default, no bundled TURN relay. Requested resolution/FPS is not a measured performance guarantee. Touchpad/right-click/scroll and supported screenshot dragging retain manual-input/PIN/task barriers.
- Share-to-Observer loads drafts only. Shared text is hard-routed as read-only reference data, not executable slash commands/approvals. Image crop/markup updates only the draft.
- Projects with selected memory/export; private text answers exclude owner-global prompt memory. Explicit commands/voice still use owner-wide tool context; projects are not OS sandboxes.
- Validated visual workflows with supported read/write steps, preview and explicit run/daily scheduling. No shell, nested workflows or auto-approval. Busy/approval-blocked schedule windows are skipped, never caught up after restart.
- Foreground voice captions, turn-taking and explicit interruption. Continuous listening pauses on background, errors or confirmation requirements. No hidden microphone service.
- Home widget, Quick Settings navigation and local Wi-Fi Wake-on-LAN. Shortcuts open/review the app; no hidden command execution. A sent wake packet does not prove hardware woke.
- Stable-signing/release workflow and owner public certificate. Private recovery kit is ignored by Git. Repository-secret access from Arena returned 403; the owner must configure the private Actions secrets before signing can run. No debug/unsigned APK may be labeled owner-signed. Production/Play Store publication is not automatic.

## Data and safety

Owner/PIN/access gates, serialized PC actions and explicit-only `/shades off` restoration remain. New mobile journals/memories are private PC files, and do not imply secure erasure by existing PANIC/provider/backup operations. Phone history clearing does not erase PC journals. Never expose the raw bridge port publicly; private-IP HTTP is explicit transport-risk opt-in.

Native API integration, Android lint/emulator results, synthetic WebRTC tests and final build links are recorded separately when they actually execute. No physical Samsung A53, real provider-key, real PC desktop input or live cloud-push test is claimed by this source checklist.
