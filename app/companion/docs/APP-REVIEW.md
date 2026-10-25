# Whole-app review — layout, design and feature recommendations

Status: **implemented for Phases A–C** (tokens, navigation, chat polish). Phases
D (tasks & files) and E (features 6–10) are still proposals — see §9. Every item names the file
it touches, why it matters on a Galaxy A53, and how it is accepted, so we can pick
phases instead of doing one giant rewrite.

Baseline measured on `main` @ `db19b5a`:

| Metric | Value |
|---|---|
| Bundle | 482,770 bytes JS, 0 gradients, 650 kB hard budget |
| Screens | Chat · PC control · Tasks · Files · Settings (+ Workspace hub with **7 tabs**) |
| Code | `App.tsx` 1,707 lines, `styles.css` 3,283 lines, 15 components |
| Tests | companion 55 unit, Playwright on 5 viewports, agent 614 |
| Theme | light (`#fff`) + true black (`#000`), 12 media queries, 7 shadows |

---

## 1. What is already right (keep it)

- Solid surfaces, one accent (ink), no gradients — the Claude/Grok feel is there.
- True-black theme for the A53's AMOLED, `color-scheme` set correctly.
- Fixed PC-control stage + scrollable dock: the best-laid-out screen in the app.
- Honest gates: nothing runs on page open, PIN/access levels are visible.
- Lazy-loaded heavy screens, SSE instead of polling on chat, `visibilitychange`
  stops previews.

The rest of this document is about making the other four screens feel as
deliberate as PC control does.

---

## 2. Design system (the biggest win, cheapest change)

Right now values are hand-written per component: 83 `border-radius`, 7 shadow
uses, ad-hoc paddings (9/11/13/21/27px in the same view). That is why two
screens can look "almost the same" and still feel off.

### 2.1 Tokens to add in `:root`

```css
/* space — 8pt grid, 4 as half-step */
--s1: 4px;  --s2: 8px;  --s3: 12px; --s4: 16px;
--s5: 24px; --s6: 32px; --s7: 48px;
/* radius */
--r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-full: 999px;
/* type scale (mobile) */
--t-caption: 11px; --t-label: 12px; --t-body: 14px;
--t-title: 17px; --t-head: 20px; --t-hero: 24px;
/* states, derived — never new colours */
--state-hover: color-mix(in srgb, var(--ink) 6%, transparent);
--state-press: color-mix(in srgb, var(--ink) 10%, transparent);
--focus: 0 0 0 2px var(--bg), 0 0 0 4px var(--ink);
/* motion */
--m-fast: 120ms; --m-base: 180ms; --m-slow: 240ms;
--ease: cubic-bezier(.2, .7, .3, 1);
```

Rules that follow: **one** radius per component class, **no** new colour without a
token, **no** shadow except the two floating layers (bottom sheet, command
palette), and every interactive row gets the same hover/press treatment.

### 2.2 Type

- Keep `SamsungOne` first in the stack — on the A53 it is the fastest to render
  and the most familiar; no webfont (already true, and the offline test enforces
  it).
- Set numbers with `font-variant-numeric: tabular-nums` (timers, sizes, counts).
- Cap the largest heading at 24px on phones: A53 users often run font scaling at
  1.2–1.3×, and a 32px hero clips the topbar.
- `text-wrap: balance` on modal and page titles.

### 2.3 Motion & states

- Replace list spinners with **skeleton rows** (3 shimmer-free bars, ink at 8%):
  a spinner in the middle of an empty screen reads as "broken".
- Every async surface needs the four states written down: loading (skeleton),
  empty (one sentence + one primary action), error (message + Retry + what to
  check), offline (banner, actions disabled with a reason).
- Durations: 120ms press, 180ms sheet, never more than 240ms.
- `prefers-reduced-motion`: drop all transforms, keep opacity.

### 2.4 Contrast and touch

- Body text on `--bg` is fine; `--muted` (#6e6e67 on white) is 5.1:1 — OK, but
  on `--surface` it drops near 4.4:1. Raise `--muted` to `#65655e` in light.
- Every tap target ≥ 44×44 (some dock chips are 32–34px today; pad them).
- Visible `:focus-visible` ring (keyboard/TalkBack users, and it costs nothing).

---

## 3. Navigation & layout

### 3.1 The real problem: five pages, but seven tabs hide inside a modal

`Settings` and `WorkspaceHub` overlap (Connection/Devices/Alerts live in the hub,
theme/updates in Settings). A 7-tab modal on a 393px screen is a memory game, and
"Wake PC" is three taps deep for something used weekly.

**Proposal — 4 destinations + one "More" list:**

```
┌────────────────────────────────┐
│ Chat                    ⚙︎ ⌘    │  topbar: title · command palette
│                                │
│  …conversation…                │
│                                │
│ ┌────────────────────────────┐ │  composer: 1 line → grows to 5
│ │ Ask, or say /command    ➤  │ │
│ └────────────────────────────┘ │
├────────────────────────────────┤
│  Chat    Tasks    PC     More  │  bottom nav: 4 × 56px + safe area
└────────────────────────────────┘
```

- **More** is a plain list of rows (no tabs): Projects · Routines · Devices ·
  Alerts · Connection · Wake PC · Appearance · Updates · Privacy · About.
  Each row shows its current value on the right (`Alerts · on`,
  `Connection · 192.168.1.12`) so most questions are answered without opening.
- Files moves out of the bottom nav into **Chat → attach sheet** and **More →
  Files**; a 4-item bar with bigger targets beats 5 cramped ones on a 360px
  screen (the `compact` viewport in the e2e matrix).
- Command palette: already exists (`CommandPalette.tsx`) — surface it from the
  topbar icon and from a two-finger tap on the nav. It is the fastest path to
  every feature and the cheapest discoverability win.

### 3.2 Chat (the screen people open 20× a day)

```
┌────────────────────────────────┐
│ ● PC · Direct AI · 2 jobs  ⌄   │  sticky context bar (tap = switch)
│                                │
│             ┌────────────────┐ │  user: ink bubble, right, max 84%
│             │ fix this error │ │
│             └────────────────┘ │
│ ⏺ assistant text, full width   │  assistant: no bubble, 15px/1.6
│   ┌ code ──────────────── Copy ┐│  code block with copy + wrap toggle
│   └────────────────────────────┘│
│  ⌄ 2 older messages            │  lazy pagination, not infinite scroll
├────────────────────────────────┤
│ [+ file] [voice]  ▁▂▃ streaming │
│ Ask, or say /command       ➤   │
└────────────────────────────────┘
```

Must-haves: grouped timestamps (long-press a turn), a "jump to latest" pill when
scrolled up, explicit `Queued · sending · sent` per message (the app already has
the journal, it just does not show it), stop button that turns into "stopped —
result unknown until it settles", copy on every code block, and offline banner
that keeps the draft instead of losing it.

### 3.3 Tasks

Active / Done as a two-segment control, approvals pinned above (one card, count
badge, "Review" primary), each job card: title, elapsed, progress, `Open result`
and a stop icon. No modal for details — tap expands in place.

### 3.4 Files

Search + sort (newest / largest) in the header, rows with type icon, name, size,
date; tap = preview sheet with Download/Send-to-PC. Empty state: "Files your PC
makes show up here."

### 3.5 PC control (minor)

Keep the stage + dock exactly as is. Add: remember the last dock tab and height
per phone, a one-time gesture hint overlay (3 dots: tap = click, hold = right,
drag = drag), and a "recent keys" row (Ctrl+S, Ctrl+Z, Esc) above the key grid.

### 3.6 Desktop

Sidebar stays. Content max-width 980 → 900, chat column 760, and keyboard
shortcuts (`⌘K` palette, `⌘⏎` send, `Esc` close). Desktop is secondary but free.

---

## 4. Feature recommendations

Scored by **impact on a phone away from the PC** (the app's whole reason to
exist). "Now" = next PR, "Next" = after that, "Later" = only if it earns its
weight.

| # | Feature | Why | Scope | Phase |
|---|---|---|---|---|
| 1 | **More list replaces 7-tab hub** | 3 taps → 1, less code | `WorkspaceHub`→`More`, new `SettingsRow` | Now |
| 2 | **Command palette everywhere** | cheapest discoverability | reuse `CommandPalette`, add topbar + gesture | Now |
| 3 | **Per-message delivery state** | "did it send?" is the #1 doubt | journal → message chip | Now |
| 4 | **Job-finished notification** (local, foreground) | away from phone, work done silently | `TaskNotice` + existing SSE | Now |
| 5 | **Global search** (chat, tasks, files) | history is unreachable today | one route + one sheet | Next |
| 6 | **Label-based tap** ("Save button") | the "PC control for humans" feature | agent: element finder exists | Next |
| 7 | **Phone → PC file ≤ 5 MB** | send a photo to the desk | `/api/upload` + Files sheet | Next |
| 8 | **Clipboard pull/push from share sheet** | fastest real-world loop | reuse `/api/clipboard` | Next |
| 9 | **Lock / power with hold-to-confirm** | small, safe, satisfying | agent routes + 1s hold | Next |
| 10 | **Voice push-to-talk in composer** | hands-busy, already have STT | reuse `Voice.tsx` | Next |
| 11 | **Density setting** (comfortable/compact) | A53 vs desktop | token switch | Later |
| 12 | **Pinned commands / snippets** | repeat use | local prefs | Later |
| 13 | **Activity timeline** (what the PC did today) | trust + recall | from events API | Later |
| 14 | **Widget / QS tile: task count + one-tap lock** | outside the app | Android side | Later |
| 15 | **Multi-PC switcher** | only if you get a second machine | nav context bar | Later |

Deliberately **not** recommended: chat streaming over WebSocket (battery, and the
journal already solves resumption), infinite scroll (memory on a 4 GB phone),
glass/gradient accents, per-message avatars, onboarding carousels.

---

## 5. Performance & battery budget (A53, 4 GB, 90 Hz)

| Budget | Target | How we check |
|---|---|---|
| JS | ≤ 520 kB | `check-bundle.mjs` (already gates) |
| First paint (4G, cold) | ≤ 1.2 s | Lighthouse mobile, one run per PR |
| Frame cost | ≤ 8 ms during PC preview | DevTools performance, 10 s trace |
| Idle CPU | ~0 % when backgrounded | no timer < 1 s outside visibility |
| Screen frame | ≤ 96 kB JPEG q70 | existing server shrink path |
| Chat poll | none — SSE only | already true, keep it |

Rules: never a timer faster than 1 s unless a screen is visible and actively
streaming; every `setInterval` must be inside an effect that clears it; images
always `loading="lazy"` + explicit width/height; lists virtualise past 100 rows.

---

## 6. Accessibility checklist (one pass, then enforced)

- 44×44 minimum targets; 8px minimum between adjacent targets.
- 4.5:1 body text, 3:1 for 17px+ headings; test both themes.
- TalkBack labels on every icon-only button (most already have `aria-label`).
- Font scale 200 %: no clipping, no horizontal scroll (add to the e2e matrix).
- `prefers-reduced-motion` respected; no autoplay anything.
- Focus ring visible in both themes; sheets trap focus and restore it on close.

---

## 7. Rollout (each phase is one PR, each ends green)

**Phase A — tokens & primitives (small, high leverage).**
Add the token block, migrate `ui.tsx` (Button, IconButton, Row, SectionHeading,
Modal) to it, fix `--muted`, add focus ring. *Accept:* no visual regressions in
the 5-viewport Playwright matrix, `styles.css` net-negative lines.

**Phase B — navigation.**
Bottom nav 4 items, More list replaces the 7-tab hub, Files moves. *Accept:*
every existing hub action reachable in ≤ 2 taps; `app.spec.ts` updated; no route
lost (checklist in the PR body).

**Phase C — chat polish.**
Delivery states, jump-to-latest, code copy, offline draft, pagination. *Accept:*
new e2e for queued→sent and for surviving a reload mid-send.

**Phase D — tasks & files.**
Segments, in-place expand, search/sort, preview sheet. *Accept:* e2e for filter
persistence and preview.

**Phase E — features 6–10** (label tap, upload, clipboard, lock, voice).
*Accept:* one agent test and one e2e per feature, plus honest docs entries for
anything gated by PC policy.

---

## 8. Decisions I need from you

1. **Bottom nav**: 4 items (Chat, Tasks, PC, More) or keep 5 with Files?
2. **More list** or keep the hub tabs and just move Settings inside?
3. Design language: stay **white/black with one ink accent** (my recommendation,
   matches Claude) or allow a single accent colour for primary actions?
4. Which phase first — **A (tokens)** is the cheapest and makes B–E faster.


---

## 9. What shipped on `arena/4128a21c-psd-observer`

**Phase A — tokens.** Token block in `:root` (spacing, radius, type, states,
motion). `--muted` light `#6e6e67` → `#65655e`. `IconButton`, `Button`, `Modal`,
`EmptyPanel`, `SectionHeading`, `SettingRow` now read tokens; `.icon-button` and
`.button` take `--tap` (44px); captions moved up to an 11px floor.

**Phase B — navigation.** Four phone destinations (Chat · Tasks · PC control ·
More) and a desktop sidebar that keeps Files. `More.tsx` is one list where each
row prints its own value; the seven-tab `WorkspaceHub` opens directly on the row
you tapped (`initialTab`). Files moved to More → Files *and* the composer's
attach sheet (photo/document · files from your PC). Command palette got a topbar
button (hidden under 560px, where the composer and drawer already expose it).

**Phase C — chat.** Per-message `sending → sent → failed` from the journal
(`Message.delivery`), a "Latest" pill instead of yanking the view while reading,
copy on every code block, drafts that survive a reload per thread, and a 30-turn
render window with "Show N earlier messages".

Not yet done: Phase D (Tasks segments, Files search/sort/preview) and Phase E
(label tap, phone→PC upload, clipboard, lock/power hold, push-to-talk).
