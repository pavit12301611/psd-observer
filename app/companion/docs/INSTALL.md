# Observer Android 1.1 — verified Preview

## Download the new feature pack

**[Download `observer-android-preview` ZIP](https://github.com/pavit12301611/psd-observer/actions/runs/40088988614/artifacts/12557804557)**

GitHub sign-in may be needed. Extract it in Samsung **My Files** and install **`observer-1.1.0-preview.apk`**. The ZIP also contains an APK checksum/signing notice. Artifact expires **2026-11-07 11:13 UTC**; after expiry, rebuild from the verified branch, not unofficial mirrors.

[Successful native/web/backend run](https://github.com/pavit12301611/psd-observer/actions/runs/40088988614) · [Evidence](validation-ci.json) · [Private signing setup](SIGNING-SETUP.md)

This is a **debug-signed Preview**, not an owner-signed/Play Store release. Debug keys can change between runners; an installed older Preview may report a signature conflict. Preserve anything you need before changing test installations. Do not uninstall a production app to install this Preview. The owner-signed permanent release is blocked until private Actions secrets are configured; no debug APK will be mislabeled owner-signed.

## Updating from now on (no reinstall)

Starting with 1.2.0, interface updates are signed by your own PC and installed in
place. Install `observer-1.2.0-local.apk` **once**; it uses the separate
`in.observer.companion.stable` package, so it sits next to Preview and nothing is
deleted. After pairing, use Settings → **PC interface updates**.

Details, trust model and PC commands: [PC-UPDATES.md](PC-UPDATES.md).

Older Preview builds cannot be updated in place: their CI debug key is not
recoverable, so a matching signature cannot be produced. The one-time local
install is the replacement path, and it needs no GitHub secret.

## Update the PC first — 3.11.0+ required

GitHub merge/source changes do not update an installed service automatically. This feature pack is currently on `arena/ffde9465-psd-observer`; it has not been merged to main or deployed to your real PC by this work.

Check the actual service directory and Node version on the PC:

```sh
node -v
systemctl --user show observer-whatsapp-agent -p WorkingDirectory --value
```

Use supported Node 20.19+ within Node 20, 22.13+ within Node 22, or 24+. Preserve/private-backup `.env`, WhatsApp login and `data/`. Let active work settle before updating; restarting while a request runs marks its receipt unknown, never automatically replays it.

For an existing install at `$HOME/observer-agent`, review the script then use this candidate explicitly:

```sh
curl -fL --retry 3 \
  https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/ffde9465-psd-observer/whatsapp-agent/scripts/observer.sh \
  -o /tmp/observer-feature-pack.sh &&
REPO=pavit12301611/psd-observer BRANCH=arena/ffde9465-psd-observer \
  bash /tmp/observer-feature-pack.sh update --dir "$HOME/observer-agent"
```

If the service directory differs, use its actual path; do not update a second copy accidentally. Verify `http://127.0.0.1:8787/health` on the PC reports **3.11.0+**. No updater command was run on your real PC by the assistant. The script's fresh-install fallback now tracks main, while explicit/sticky branch tracking still needs review when moving between candidates.

## Pair / use

1. Put phone and PC on a trusted LAN/private VPN. Prefer HTTPS or an encrypted VPN; never forward raw 8787 publicly.
2. In the APK tap **Connect PC**, enter the actual PC origin (not phone localhost), and explicitly allow private-IP HTTP only if appropriate.
3. Enter the dashboard PIN privately, or scan a fresh 2-minute QR generated on the PC at `http://localhost:8787/desktop` (open this URL on the PC, not the phone). A one-time QR contains no permanent bridge credential.
4. Pairing checks health/version/protocol and saves a revocable per-device token using Android Keystore. If using a retained legacy root-token session, re-pair for individual revocation; rotate compromised legacy tokens separately.
5. Start with `/time`, then an ordinary text question. Long AI replies use retained jobs; if the app/network interrupts, **Tasks → View result**, not blindly Send again.
6. Manual input is opt-in. CONTROL_PIN, safe access, active-operation barriers and native OS permissions still apply. Stop cannot retract an already-started physical effect.

## Find the new tools

**Settings → Projects, routines, alerts & device security** (also Workspace tools in the drawer/sidebar):

- Projects and selected memory/export; private text context excludes global owner prompt facts. Explicit commands/voice remain owner-wide, not sandboxed.
- Validated routines: preview, save, explicit Run or daily trigger. No arbitrary shell, nested flow or auto-confirm. Missed/busy schedules are skipped.
- Device list/revocation, one-time QR and optional LAN discovery. No automatic firewall setting changes.
- Private SSE alerts with persistent notification. Android/One UI/Doze may pause this link. Optional OS-push registration needs your own client project and private PC service-account setup; no live delivery is claimed before configuration/testing.
- Android biometric/device-credential access gate. Android handles the credential; Observer never receives your actual phone PIN/fingerprint.
- Wake-on-LAN on local Wi-Fi for supported hardware. Sent packet does not prove wake.

**PC control:** screenshot preview plus opt-in touchpad/right-click/scroll, supported screenshot dragging, and **Live desktop**. On the PC sharing page, explicitly choose a monitor/window through browser/OS consent. No audio/recording; LAN/private VPN by default, no TURN relay. Do not disable firewall or open arbitrary public UDP ports to force video through.

**Chat:** Share-to-Observer imports reviewed drafts. Shared text is treated as read-only reference data, not executable slash commands/approvals. Crop/markup changes only a pending image until Send. Voice offers partial captions, foreground turn-taking and explicit interruption; no hidden always-on microphone. Android widgets/Quick Settings open the app/features and do not silently execute commands.

## Safety / verification boundaries

The verified run includes 42 frontend tests, 61 browser passes plus four intentional layout skips of the once-run synthetic WebRTC protocol case, 590 backend tests per Node 20/22/24, Android build/lint/JVM tests and native abort recovery/share/alert/privacy/device-credential checks. No actual PC desktop input, physical Galaxy A53 battery/thermal/120Hz benchmark, real fingerprint/mic/camera/NSD/WoL integration, real AI-provider key inference or live FCM test was performed.

WhatsApp-specific calls/sends/guest messaging still require a linked WhatsApp channel. Private mobile journals/memories are additional PC data; clearing phone history or existing PANIC does not securely erase PC/provider/backup copies. Shades remains explicit-only `/shades off`. No automatic approval/action replay, global phone automation, bundled offline LLM, Play Store release or production deployment is claimed.
