# Private owner-signing setup (never put values in chat)

A stable owner key was generated with permission. Only its **public certificate fingerprint** is in `signing-identity.json`. GitHub repository-secret management from the Arena integration returned **403**, so no claim is made that signing secrets were uploaded/configured.

## If you downloaded the private recovery kit

1. Privately extract `observer-private-signing-backup.zip` from the earlier private file card. Keep it in a password manager/private offline backup. Anyone with the kit can sign as this application.
2. Open <https://github.com/pavit12301611/psd-observer/settings/secrets/actions> while signed in as the repository owner/admin.
3. Select **New repository secret** four times:

| GitHub secret name | Copy the full local file contents from the kit |
|---|---|
| `OBSERVER_ANDROID_KEYSTORE_B64` | `OBSERVER_ANDROID_KEYSTORE_B64.txt` |
| `OBSERVER_ANDROID_STORE_PASSWORD` | `OBSERVER_ANDROID_STORE_PASSWORD.txt` |
| `OBSERVER_ANDROID_KEY_PASSWORD` | `OBSERVER_ANDROID_KEY_PASSWORD.txt` |
| `OBSERVER_ANDROID_KEY_ALIAS` | `OBSERVER_ANDROID_KEY_ALIAS.txt` |

Copy values, not filenames/paths. Do not add quotes or change the key/alias. Do not paste any value, password, key or recovery ZIP into this conversation, a commit, issue, public artifact or release. If same-named secrets already exist, stop rather than overwriting a potentially deployed signing identity.

4. Confirm only **“secrets done”**. The signed workflow checks for all required values, builds with the private key in a temporary runner file, verifies the APK signer against the public pinned fingerprint and deletes the temporary file. There is no unsigned/debug fallback.
5. Signed release/public beta publication is separately gated by explicit workflow-dispatch inputs, never automatic on a PR. No Play Store publication or main merge is performed by this setup.

## If you did not download the private kit

Stop and say so before proceeding. Private ignored signing files are not retained across workspace restoration; the current restored workspace no longer contains the private key. The earlier private file card/download may retain your copy, but **do not assume a public source/archive can recover it**. No different key will be silently generated or substituted. Before any signed production deployment, an explicitly authorized fresh owner-local key setup can be arranged; after deployment, losing/changing the key can break updates.

Production package is `in.observer.companion`; Preview is a separate `.preview` package. Preview-to-production data/update migration is not guaranteed. Keep a private backup and do not uninstall a production app to install a test build.
