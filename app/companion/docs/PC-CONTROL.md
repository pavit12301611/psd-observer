# PC control from the phone

One fixed view, sized to a phone: the **screen stays put** and the controls live
in a dock underneath. Nothing you do with the trackpad can scroll the screenshot
away.

```
┌──────────────────────────────┐
│ Live · 2s ago   − 2.0× + ▶ ⟳ │
│ Wayland · 64% · Input on     │  ← chips: lock, display, session, battery, agent
├──────────────────────────────┤
│                              │
│        live PC screen        │  ← stage: pinch/double-tap zoom, drag to pan
│                              │
├──────────────────────────────┤
│ [Input]  [Take over]  [PIN]  │
├──────────────────────────────┤
│ Pad │ Keys │ Type │ Clip │More│
│  (only this dock body scrolls)│
└──────────────────────────────┘
```

## Gestures on the screen

| Gesture | What happens |
|---|---|
| Tap | Left click at that PC pixel, with a ripple so you can see it landed. One fresh frame follows. |
| Long-press (0.5s) | Right click. |
| Two-finger tap | Right click (trackpad habit). |
| Pinch | Zoom 1×–4× around your fingers. |
| Double-tap | Toggle 2.2× / 1× **while input is off**, so browsing never fires a click. |
| Drag | Pan when zoomed. At 1× with input on it becomes a real PC drag (dashed line while you drag), so windows and selections work. |

**Zoom is not a scaled-up thumbnail.** Above 1× the phone requests
`/api/screen?cx&cy&cw&ch`, and the PC returns the real cropped pixels
(`x-screen-crop: region`). That is why text is readable instead of blurry. If
`sharp` is missing on the PC, the full frame is sent and the header says
`x-screen-crop: full` — no fake crispness.

## Dock tabs

- **Pad** — trackpad (relative cursor movement), right click, scroll, and a
  10px nudge pad for pixel work.
- **Keys** — Esc/Tab/Enter/Backspace/Delete/Home/End/PgUp/PgDn/arrows/F5 plus
  held modifiers: tap `Ctrl`, tap `C`. Modifiers stay held until tapped again.
- **Type** — up to 4000 characters, with "Type + Enter" and "Paste long text"
  (clips on the PC and sends Ctrl+V, far faster than per-character typing).
- **Clip** — read the PC clipboard, send this phone's text to it, or copy it
  here. Overwriting the PC clipboard needs the PC PIN.
- **More** — session type, lock state, display state, battery, disk, whether the
  agent is busy, "Wake display", a lock shortcut, a new frame, and the optional
  WebRTC live view.

## New behaviour worth knowing

- **Preview starts when the page opens** and stops when the app is backgrounded.
  Pause is one tap.
- **Take over** appears whenever the agent is busy: one tap sends `/stop`, waits
  for the job to settle, then hands manual input back.
- **Failures back off**: 8s timeout per frame, then 1.2s → 2.4s → 4.8s → 8s
  retries, with a Retry button and an automatic retry when the phone comes back
  online.
- **Freshness is visible**: "just now" / "12s ago" next to the Live/Paused dot.

## Server side

| Route | Purpose | Gates |
|---|---|---|
| `GET /api/screen?w=&cx=&cy=&cw=&ch=` | Frame, optionally cropped | bridge/device token |
| `GET /api/pc/state` | Session, lock, display, battery, disk, agent busy | token |
| `POST /api/pc/display` | Wake the display only | `ALLOW_PC_CONTROL`, PC PIN |
| `GET /api/clipboard` | Read PC clipboard text | `ALLOW_PC_CONTROL` |
| `POST /api/clipboard` | Replace PC clipboard (≤20000 chars) | `ALLOW_PC_CONTROL`, standard/full access, PC PIN |
| `POST /api/tap`, `/api/drag`, `/api/pointer`, `/api/key`, `/api/type` | Input | unchanged policy + PIN + "not busy" |

Everything above is web/PC-side: an updated PC agent plus a signed web bundle
delivers it. No APK reinstall is needed — see [PC-UPDATES.md](PC-UPDATES.md).

## Limits we do not hide

- Waking a display does **not** unlock the PC. Observer never types or stores
  your login password; unlock on the machine itself.
- The phone must reach the PC (LAN or VPN) for every frame and action.
- Lock detection uses GNOME's screensaver or `loginctl`; on other desktops the
  field honestly says `unknown`.
- Zoom crops need `sharp`; input still needs the PC's own permission
  (`ALLOW_PC_CONTROL`, access level, PC PIN, ydotool/xdotool on Wayland/X11).
- True continuous streaming (10–15 fps) is still an APK-level change: it needs a
  native frame path or a Wayland portal session.
