# PC-signed interface updates

Observer can update its interface **without uninstalling or reinstalling the
app**, using a signing key that is generated and kept on your own PC. No GitHub
secret, release workflow or repository permission is involved.

What this channel covers:

- The web interface (every screen, layout, wording and behaviour written in
  React/TypeScript).
- It does **not** cover native Android code or the manifest. A change there
  (a new permission, service, widget or Java code) still needs one APK install.

## How the trust chain works

1. The first time a phone pairs, the PC agent creates a private RSA-3072 key at
   `data/mobile/updates/signing/update-signing-key.pem` (owner-only, mode 0600).
   The key never leaves the PC, is never committed and is never shown in chat.
2. The pairing response carries the matching public key. The Android app **pins**
   the first key it receives. If a later pairing offers a different key, pairing
   is refused until you log out deliberately.
3. `npm run app:update:pack -- --version X.Y.Z` builds a deterministic ZIP of the
   built web app, hashes it, and signs a canonical manifest with SHA-256/RSA.
4. The phone asks its paired PC for the manifest, verifies the signature with the
   pinned key, downloads the bundle over the same authenticated device token,
   checks the hash and the declared size, extracts it into a staging folder with
   path/size/count limits, and only then swaps it in. The previous version is
   kept for rollback.
5. If the newly installed interface does not confirm a successful start, the next
   launch swaps the previous version back automatically.

Anti-downgrade is enforced on both sides: the PC only offers the newest valid
release, and the phone refuses anything that is not newer than what it has.

## One-time install on the phone

The app already on your phone was built by CI with a per-runner debug key, so it
cannot be updated in place. Install the **local** APK once. It uses a separate
package (`in.observer.companion.stable`) and installs **next to** Observer
Preview, so nothing is uninstalled or overwritten:

1. Download `observer-1.2.0-local.apk` from the `observer-android-apks` Actions
   artifact of the verified run.
2. Open it on the phone and allow install from that source if asked.
3. Pair it with the PC once (PIN or QR), exactly like Preview.
4. From then on, update only the interface from Settings → **PC interface
   updates**.

The local APK is debug-signed and is a personal install, not a public
production release. Permanent APK-level releases still need the owner-controlled
release key.

## PC side

Requirements: PC agent **3.11.0+**, Node 22+, and the PC agent running with its
normal data directory. No extra package installation is needed.

```bash
# 1. Build the companion web app you want to ship
cd app/companion
npm ci && npm run build

# 2. Verify the channel and see the pinned key id
cd ../../whatsapp-agent
npm run app:update            # status: supported, keyId, versions

# 3. Pack and sign a release from the built dist/
npm run app:update:pack -- --version 1.2.1 --notes "Faster task list"

# 4. Confirm the PC offers it
npm run app:update
curl -H "x-bridge-token: <dashboard token>" http://127.0.0.1:8787/api/app/update/manifest
```

`npm run app:update:key` writes the public key to
`data/mobile/update-public-key.pem` if you ever need to inspect the identity.
Keep the `signing` directory owner-only; the app rejects a key file that is
readable by other users.

The pack step keeps the three most recent versions on disk and refuses symlinks,
absolute paths, `..` segments, more than 4000 files, entries over 16 MB and
bundles over 32 MB (64 MB uncompressed).

## Phone side

Settings → **PC interface updates** shows:

- **Check** — asks the paired PC for the signed manifest.
- **Install X.Y.Z** — verifies, downloads and activates it.
- **Reload Observer** — loads the new interface.
- **Undo last update** — swaps the previous interface back.

A failed start does not need the undo button: the next launch detects the
unconfirmed boot and restores the previous version by itself. If no previous
version exists, it falls back to the interface built into the APK.

## What is not covered

- Native changes, permissions and new capabilities need an APK install.
- The PC must be reachable from the phone (LAN or VPN) to check, download or
  roll back.
- This is app-level trust: a bundle is interface code signed by your PC. Only
  pair PCs you control, and log out before pairing a different one.
