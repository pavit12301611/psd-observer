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

## Where is the pointer?

**Something is always findable.** A real cursor drawn at PC scale is 3-4 px on a
phone, so "the frame already has it" is not the same as "the owner can see it".

- **Arrow → Auto** (default): a halo around the PC's own cursor when the frame
  contains it and its position is known (`/api/pc/pointer`, X11); our own arrow
  when it does not; nothing at all when even the position is unknowable — then
  the pad tab offers *Show my arrow anyway*.
- **Arrow → Always**: always our own arrow. **Arrow → Off**: never. The choice is
  kept on the phone, so a desktop this app cannot read still gets a usable
  pointer.

Two rules behind that:

1. **If the frame already has the real cursor, no marker is drawn.** The PC
   reports `pointerInFrame` (and `captureTool`) in `GET /api/pc/state`, derived
   from whichever tool produced the frame. Two arrows in different places is
   worse than none, so on X11 (gnome-shell, gnome-screenshot, scrot, maim) or
   wlroots (grim) the app stays out of the way.
2. **Otherwise the marker is scaled and honest.** Its height follows the image:
   a real cursor is about 20 PC pixels, so the marker is
   `clamp(20 × drawnWidth ÷ screenWidth, 9, 22)` px, not a fixed banner. It only
   moves for input the PC accepted, and on desktops that can report the cursor
   (`/api/pc/pointer`, X11 only) it re-syncs whenever the phone has been idle for
   three seconds — so a dropped move or the PC's own acceleration cannot leave it
   drifting away from the real pointer.

On GNOME Wayland the only screenshot path that works is
`xdg-desktop-portal`, and the portal **never draws the mouse pointer**. That is
the desktop being honest, not a bug in this app, and no flag changes it.

So the app draws its own marker, and everything it needs is already in the
frame:

- `x-screen-width` / `x-screen-height` headers carry the PC's real screen pixels.
- A tap or a drag gives an absolute PC coordinate (the PC told us those pixels).
- Trackpad and nudge moves are PC pixels too, so they shift the marker by
  `dx / screenWidth × 1000` units and clamp at the screen edges.
- The marker hides when the point falls outside the current zoom crop, keeps its
  last position if the PC sends no screen size, and clears on disconnect.

On X11 and wlroots the **real** pointer is also in the picture, because the
capture tools are asked for it explicitly: `grim -c`, `scrot --silent -p`,
`gnome-screenshot --include-pointer`, and GNOME Shell's D-Bus
`Screenshot(include_frame, include_cursor, file)` with `include_cursor=true`.
`maim` draws it by default; ImageMagick's `import` and KDE Spectacle have no such
switch, so there the marker is the only pointer you will see.

## If input suddenly stops

Two failure modes used to look identical — "the page is dead":

1. **The agent is busy.** Every input route answers `423` while a job runs. The
   page offers **Take over**, which sends `/stop` and waits for the job to
   settle.
2. **The phone's bridge is saturated.** The Android shell runs each HTTP call on
   a small thread pool and *rejects* the surplus; the rejection text looks like
   `Task …AndroidBridge… rejected from java.util.concurrent.ThreadPoolExecutor
   [… queued tasks = 12 …]`. The bundle now prevents it: one pointer move in
   flight (the rest of the swipe is coalesced), at most three PC requests at a
   time, one silent retry after 120 ms, and adaptive frame pacing
   (`max(1200, captureTime + 400) ms`). A rejected move never turns input off.

On the PC side, `GET /api/pc/state` also reports `screen: {width, height}` of the
last frame, so the pointer marker keeps working where the native bridge forwards
only the ETag header.

### Reading the symptoms

`More` (the last dock tab) is the status panel, and it answers
"my cursor went where?" without guessing:

| Row | Meaning |
|---|---|
| Cursor in frame | `yes` — the capture tool drew the PC's real pointer |
| Capture tool | which tool produced the frame (`xdg-desktop-portal`, `scrot`, `grim`, …) |
| Screen | real PC pixels of the frame (used for the marker's size and position) |
| Pointer query | `works` — the PC can report the cursor position (X11) |
| My arrow | `shown at x,y`, or where it is hidden and why |
| Last input | the last tap/drag and whether the PC accepted it |
