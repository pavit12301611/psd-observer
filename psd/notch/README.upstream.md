# Notch for GNOME

A Cyclop-inspired, expandable **MacBook-style top-edge notch** for **Fedora 44 Workstation / GNOME Wayland**: idle clock, in-notch notifications, MPRIS media controls, live system status and GNOME quick actions.

**Version target:** Fedora 44 ships GNOME **50**. The extension declares Shell 46–50 compatibility, but **GNOME 50 is the primary release target**; older versions need their own live desktop validation.

> Status: working source, tests and packaging recipes. The repository was developed in a non-GNOME Linux sandbox. **A live Fedora 44/GNOME 50 session is still required for the acceptance checklist in [docs/TESTING.md](docs/TESTING.md). Do not interpret static checks as a live desktop certification.** See [docs/VALIDATION.md](docs/VALIDATION.md) for the exact local checks.

## What changed in build 19

- Settings uses a sliders icon instead of the old sun-like glyph.
- The expanded header is budgeted: tabs, settings and close stay inside the notch at narrow widths and large text scaling.
- The left top flare was corrected, removing the stray rectangle outside the notch.
- Closed music wings are back with proportional, centered equalizer bars.
- Plugging in the charger shows a brief green “Charging · NN%” cue in the closed notch (under two seconds).

Build 18 removed Clipboard history and Quick stash / file shelf completely: no tabs, no background helper, no helper D-Bus service, no systemd unit, no CLI, no schema keys and no packaging payload. The installer also cleans up those artifacts from older builds. The remaining UI is built around four pages with a clear typographic hierarchy and layered surfaces.

## Why this is a hybrid application

An ordinary GTK4 window cannot reliably position itself over GNOME’s top panel, remain above fullscreen windows, or reserve work-area space on Wayland. `gtk4-layer-shell` is not a solution on GNOME Mutter, which does not provide the required layer-shell protocol.

Notch therefore uses the same privileged desktop layer as GNOME’s own panel:

```text
┌──────────────────────── GNOME Shell / Mutter (Wayland) ────────────────────────┐
│ GJS + St/Clutter extension                                                    │
│   animated notch • idle clock • MPRIS • notifications • CPU/RAM/network        │
│   UPower battery • Do Not Disturb / Night Light / Dark Mode                    │
└───────────────────────────────────────────────────────────────────────────────┘
                │ session D-Bus (state only)
┌───────────────▼──────────────────┐
│ Python / GTK4 / Libadwaita        │
│ notch-settings                   │
│ native preferences, on demand    │
└──────────────────────────────────┘
```

The notch itself is **not a GTK widget**: it uses GNOME Shell’s native St/Clutter toolkit so it looks and behaves like Shell chrome. Settings use **GTK4/Libadwaita** and run only when opened. There is no always-on Python daemon.

Inspired by [akalikbergenov/cyclop](https://github.com/akalikbergenov/cyclop). No Cyclop Swift code, icons, or other assets are copied. This project is independent and is not affiliated with Cyclop or Apple.

## Features

| Page | Included behavior |
|---|---|
| Home | Large local clock and a quiet date line. Nothing else. |
| Music | MPRIS player discovery/switching, text-first title/artist, previous/play/pause/next and seek. No volume controls or album art. |
| Alerts | Ordinary GNOME banners become compact in-notch peeks with native actions; full Alerts page keeps a real card count, compact expandable bodies and dismiss-all. Critical alerts keep the native banner path. Routing respects GNOME DND/app policy and is reversible. |
| System | 2×2 metric tiles: CPU utilization, RAM used/total, UPower battery percentage/state, default-interface download/upload rates. Quick actions: Do Not Disturb, Night Light, Dark Mode. |

Closed notch: idle time sits where the GNOME clock used to be; music grows small closed-state wings with a rhythmic animated equalizer. Plugging in the charger briefly shows a green charging badge. Click a peek or the Alerts tab for the full notification list. Click the notch, hover over it, or press **Super + `** (the key above Tab on a US keyboard). Press Escape or click outside to collapse it.

## Design notes

- **MacBook notch, not a floating Dynamic Island.** The default placement is flush with the top panel, with small outward top flares and larger bottom corners.
- **Typographic hierarchy.** Primary values/titles are large; labels, timestamps and secondary details are smaller and muted. Decorative headings, source icons in empty states, album art, volume sliders, pagers and helper/status clutter were removed.
- **Depth without noise.** Layered dark cards, subtle borders, inset highlights and consistent radii separate content from the black notch body.
- **Adaptive layout is automatic.** The notch uses the actual monitor rectangle and text scale. Four fixed-width tabs show labels at the default size and collapse to a centered icon rail when narrow. Only Alerts scrolls; Home/Music/System are centered natural-height blocks.
- **Work-area reservation is experimental and opt-in.** It reserves the collapsed edge region, not the expanded panel.
- **MPRIS capabilities vary.** Seek requires a player exposing `CanSeek`, a track length, and a usable position/track ID. Firefox must have MPRIS/media-key integration enabled. A player that does not implement a capability cannot be forced to support it.
- Shell extensions use internal GNOME APIs. Test after every GNOME major upgrade; never bypass version checks by editing metadata blindly.

## Quick start on Fedora 44

### One command — no GitHub page or git clone needed

Run this in your Fedora desktop terminal (as your normal user, **not** with `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/pavit12301611/notch/refs/heads/arena/3b6a968b-notch/scripts/bootstrap.sh | NOTCH_REF=arena/3b6a968b-notch bash -s -- --with-deps
```

This downloads the complete source snapshot over HTTPS, installs Fedora dependencies, and installs Notch for your user. The dependency step prompts for your sudo password in the terminal. Temporary download files are removed afterwards. The command tracks the `arena/3b6a968b-notch` development branch (build 19+). `NOTCH_REF` must be set on the `bash` side of the pipe, not only on `curl`. For a reproducible install, set it to a full commit SHA. After this branch is merged, the same command can use `main` on both sides.

If you prefer to inspect the bootstrap before running it:

```bash
curl -fsSL https://raw.githubusercontent.com/pavit12301611/notch/refs/heads/arena/3b6a968b-notch/scripts/bootstrap.sh -o /tmp/notch-bootstrap.sh
less /tmp/notch-bootstrap.sh
NOTCH_REF=arena/3b6a968b-notch bash /tmp/notch-bootstrap.sh --with-deps
```

### From a local checkout

From a GNOME Wayland session:

```bash
./install.sh --with-deps
```

`--with-deps` asks `sudo` to install Fedora packages. Then **log out and back in**. This is required on Wayland: `Alt`+`F2`, `r` is not a supported Shell restart mechanism there.

```bash
gnome-extensions enable notch@pavit12301611.github.io
notch-settings
notch-doctor
```

### Manual dependency installation

```bash
sudo dnf install \
  python3 python3-gobject gtk4 libadwaita glib2 glib2-devel \
  gobject-introspection gnome-shell gnome-extensions-app \
  upower adwaita-icon-theme hicolor-icon-theme make

./install.sh
```

There is **no package named `mpris` to install**. MPRIS is a D-Bus specification implemented by media players. Notch talks to it through Gio. `gobject-introspection` and the GTK/Adwaita typelibs supply the language bindings; `python3-gobject` supplies PyGObject. There are no runtime PyPI dependencies.

### What the installer changes

Default user installation:

```text
~/.local/share/gnome-shell/extensions/notch@pavit12301611.github.io/
~/.local/share/notch/                         # application code/docs
~/.local/share/glib-2.0/schemas/              # Notch GSettings schema
~/.local/share/applications/                  # Notch Settings desktop entry
~/.local/bin/notch-settings
~/.local/bin/notch-doctor
```

The installer also removes retired build-17-and-older artifacts: `notch-helper`, `notch-shelf`, the Helper D-Bus service, `notch-helper.service`, and the old `helper.py`/`storage.py`/`shelf_cli.py` modules. Existing Notch settings are retained.

### RPM / COPR path

```bash
make rpm
```

The spec installs the extension, schema, settings app, doctor and desktop entry. It does not install a helper daemon, clipboard manager or file shelf. See [packaging/rpm/notch.spec](packaging/rpm/notch.spec).

## Configuration

Open **Notch Settings** from the app grid, or run `notch-settings`. The extension’s own Preferences dialog (GNOME Extensions → Notch → Settings) exposes the same core schema inline.

| Group | Keys |
|---|---|
| Placement | `placement`, `monitor-index`, `horizontal-offset`, `floating-margin`, `reserve-space` |
| Shape | `collapsed-width`, `collapsed-height`, `expanded-width`, `expanded-height`, `corner-radius`, `adaptive-corners`, `match-panel-height`, `notch-scale`, `opacity` |
| Closed behavior | `replace-panel-clock`, `idle-clock`, `closed-media` |
| Notifications | `notifications-in-notch`, `auto-open-notifications`, `peek-duration-ms` |
| Motion | `animations`, `animation-profile`, `open-animation-ms`, `close-animation-ms` |
| Opening/hiding | `open-on-hover`, `hover-delay-ms`, `auto-hide-ms`, `hide-on-fullscreen`, `hide-in-overview` |
| Quick actions | `show-dnd`, `show-night-light`, `show-dark-mode` |
| Shortcut | `toggle-notch` |

## Troubleshooting

```bash
notch-doctor
journalctl -b _COMM=gnome-shell --no-pager -n 300 | grep -E -i 'notch|JS ERROR'
```

- **Extension “does not exist” after install:** log out/in once. GNOME Shell discovers newly installed extensions at session start; enabling alone does not reload code on Wayland.
- **Old helper warnings:** re-run the build-18 installer. `notch-doctor` reports leftover `notch-helper`/`notch-shelf` artifacts.
- **Music controls disabled:** the player does not expose that MPRIS capability, or no player is connected.
- **Freeze/stutter triage:** capture `pidstat -p "$(pgrep -x gnome-shell | head -n1)" 1` and the journal grep above. Do not assume a static test proves the live issue is fixed.

## Repository layout

```text
extension/            GJS/St Shell extension (overlay, controllers, prefs, schema, D-Bus, icons)
app/notch_app/        Python GTK4/Libadwaita settings + doctor
data/                 launcher/desktop templates
scripts/              remote bootstrap + atomic extension publisher
packaging/rpm/        Fedora RPM spec
tests/                Node model/layout tests, Python project/doctor/installer tests, GJS smoke
docs/                 architecture, security, testing, validation, design study
```

## Development

```bash
npm ci
make stage
make check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/TESTING.md](docs/TESTING.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
