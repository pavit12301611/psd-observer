# Oracle mode: WhatsApp + one model in the cloud, PC connector at home

This is a **separate, intentionally limited mode**, not a migration of the
existing agent. On Oracle it runs only WhatsApp and one OpenAI-compatible
model endpoint on loopback. On the Linux desktop it runs a small command relay
using the existing action registry, without running an AI provider. It does not
remove any pre-existing models, credentials, files, services, or other code.
Stop old services yourself before switching; never link the same WhatsApp
session from two running agents.

## What works / what does not

* `/open chrome`, `/apps`, `/windows`, `/screenshot`, `/pc volume 40`,
  `/pc volume up|down|mute`, `/pc brightness 40|up|down`. Some existing
  Hinglish shortcuts like `chrome kholo` and `awaaz kam karo` also work.
  `/help` lists the supported commands. Access levels and desktop permissions
  still apply; apps need at least `ACCESS_LEVEL=standard`.
* Other recognized commands are rejected, not executed on the Oracle VM. No
  shell, destructive actions, AI tool calls, file transfers, reminders, phone
  dashboard, incoming media, voice, or WhatsApp calling in this mode. Chat
  questions go only to the one model, without tools or conversation history.
  A general AI answer is labelled as chat, not an action.
* The PC must be awake, online, and logged into a working graphical session
  for desktop actions; the cloud agent being up does not make the PC available.
  If a request times out, its outcome is **unknown**: check before retrying.
  No automatic retries or offline action queue are used.
* OCI Always Free availability and eligibility vary. VM capacity, service
  restarts, network and WhatsApp connection are not guaranteed 24/7; the small
  CPU model may be slow. Verify your OCI region, current limits, boot volume,
  networking and billing before provisioning. WhatsApp via Baileys is
  unofficial and carries account restriction risk.

## 1. Network and secrets

Install and sign into Tailscale on both machines in the **same private tailnet**.
Configure tailnet ACLs so only your Oracle VM can reach the desktop connector.
Use the PC's Tailscale IPv4 shown by `tailscale ip -4` as `ORACLE_RELAY_HOST`
on **both** machines. On the PC the connector must bind to that local address.
Do not use a public IP, `0.0.0.0`, port-forwarding, or a public reverse proxy.
HTTP is used only inside the encrypted Tailscale tunnel. Protect the tailnet,
server accounts and token: an authorized relay client can control the allowed
PC actions and read screenshots. Restrict the PC firewall to the Oracle
Tailscale IP and TCP 8790; firewall instructions vary by OS. Loopback addresses
are supported only for same-machine testing, not cloud-to-PC connectivity.

Generate a random token once on either trusted machine:

```sh
openssl rand -hex 32
```

Put the exact same token in both machines' private `.env` files; never commit,
log, or share it. Use different `.env` files for the machines, mode 600. The
cloud holds the WhatsApp login and token, so secure the VM and its backups.

## 2. Install on the Oracle VM

Install Node.js supported by `package.json`, npm, and the repository. In
`whatsapp-agent/`, run `npm ci`, then create a private `.env` (do **not** copy
an existing file containing unrelated provider keys):

```dotenv
OWNER_NUMBER=<your WhatsApp number, country code and digits only>
AGENT_NUMBER=<separate agent WhatsApp number, country code and digits only>
GUEST_MODE=off
OPEN_QR=false
ORACLE_RELAY_HOST=<PC Tailscale IPv4>
ORACLE_RELAY_PORT=8790
ORACLE_RELAY_TOKEN=<64 hex characters generated above>
LOCAL_API_URL=http://127.0.0.1:11434/v1
LOCAL_MODEL=llama3.2:1b
```

Replace every `<...>` with real values, without angle brackets. `chmod 600
.env`. Set up an OpenAI-compatible inference server bound to **127.0.0.1** on
the VM. For example, install Ollama using its official instructions for the
VM architecture, run `ollama serve`, then `ollama pull llama3.2:1b`. The example
URL and model above use Ollama's OpenAI-compatible API; another server/model
can be used by changing both fields. Only this one endpoint is called; the
mode ignores all other configured providers and model slots. No model is
installed or provisioned automatically. Do not expose the model server to the
internet. Run:

```sh
npm run oracle:cloud
```

Scan the QR shown in the VM terminal with the **agent** phone's Linked Devices
screen. Keep `auth_info/`, `data/` and logs private. There is no web dashboard
in Oracle mode; the QR is in the terminal and saved under `data/`. The owner
number gate remains in the WhatsApp transport and guest mode is forced off.

## 3. Install on the desktop

Install the repository and Node.js, run `npm ci` in `whatsapp-agent/`, then
create a separate `.env` and `chmod 600 .env`:

```dotenv
ORACLE_RELAY_HOST=<this PC's Tailscale IPv4>
ORACLE_RELAY_PORT=8790
ORACLE_RELAY_TOKEN=<same 64 hex token>
ACCESS_LEVEL=standard
ALLOW_SHELL=false
```

Log into the desktop and start `npm run oracle:pc` from a terminal in that
session. No WhatsApp login or inference server is required on the PC. If it
cannot bind, confirm Tailscale is online and its IP has not changed. Test by
sending `/apps` and `/screenshot` from the owner number. Desktop screenshot
and app control depend on Linux session and installed utilities/permissions.

## 4. Restart after reboot (optional)

First verify both commands manually. On Oracle, create a systemd service with
`User=<your VM user>`, `WorkingDirectory=<absolute path to whatsapp-agent>`,
`ExecStart=<absolute path to node> <absolute path to whatsapp-agent/src/oracle-cloud.js>`,
`Restart=on-failure`, and `WantedBy=multi-user.target`; enable it with
`sudo systemctl enable --now <service>`. Make sure the model server and
Tailscale also start on boot. Logs (`journalctl`) contain linking QR and are
sensitive.

On the PC use a **user** service running `src/oracle-pc.js` with that same
working directory and `Restart=on-failure`, started within the logged-in
**graphical** session. A boot-time background service may not inherit display,
D-Bus or Wayland permissions. Test actual screenshots and app launch after
reboot; use a graphical-session autostart if user-service environment is wrong.
Neither setup prevents PC sleep nor guarantees reconnect on changing IPs. If
Tailscale's IP changes, update both private `.env` files and restart.

## Tests

```sh
node --test test/oracle-relay.test.js
```

The tests use a loopback relay and mocks; they do not verify a real Oracle VM,
Tailscale ACL/firewall, physical desktop session, model, or WhatsApp account.

Example Oracle service file `/etc/systemd/system/observer-oracle.service`
(replace **all** angle-bracket values with absolute paths/user, no brackets;
`command -v node` gives the Node path). `loadConfig` reads `.env` from the
repository's `whatsapp-agent` directory, not the caller's home directory.

```ini
[Unit]
Description=Observer Oracle WhatsApp agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=<vm-user>
WorkingDirectory=<absolute-whatsapp-agent-directory>
ExecStart=<absolute-node-path> <absolute-whatsapp-agent-directory>/src/oracle-cloud.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now observer-oracle.service
journalctl -u observer-oracle.service -f
```

On the PC a user unit can use the same `WorkingDirectory` and `ExecStart`
pattern, but replace `oracle-cloud.js` with `oracle-pc.js`, omit `User=`, use
`WantedBy=default.target`, and put it in
`~/.config/systemd/user/observer-oracle-pc.service`. After logging into the
graphical desktop, run:

```sh
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
systemctl --user daemon-reload
systemctl --user enable --now observer-oracle-pc.service
journalctl --user -u observer-oracle-pc.service -f
```

If the GUI session is absent or cannot be inherited, the connector may be
online but GUI actions will fail. Stop the old WhatsApp agent on both machines
before linking the new one. Existing models can be removed using their own
model-server tools *after* checking what else uses them; this setup never deletes
them or your old config automatically.
