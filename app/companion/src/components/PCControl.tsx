import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Monitor,
  Play,
  Pause,
  RefreshCw,
  Keyboard,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  Maximize2,
  Minimize2,
  LockKeyhole,
  Hand,
  LoaderCircle,
  SunMedium,
  ClipboardCopy,
  ClipboardPaste,
  Plus,
  Minus,
  ShieldCheck,
  Square,
  Gauge,
} from "lucide-react";
import LiveDesktop from "./LiveDesktop";
import type { AppState, PcState } from "../types";
import { api, base64Blob } from "../core/api";
import {
  clampZoom,
  cursorMarkerPosition,
  frameQuery,
  moveCursorBy,
  panCenter,
  pixelToUnit,
  pointToScreen,
  retryDelay,
  visibleRegion,
  zoomAround,
  type Center,
  type Region,
  type Size,
} from "../core/remote";
import { EmptyPanel, IconButton, SectionHeading } from "./ui";

const FULL: Region = { x: 0, y: 0, w: 1000, h: 1000 };
type Tab = "pad" | "keys" | "type" | "clip" | "more";
type Ripple = { x: number; y: number; id: number };
const TABS: { id: Tab; label: string }[] = [
  { id: "pad", label: "Pad" },
  { id: "keys", label: "Keys" },
  { id: "type", label: "Type" },
  { id: "clip", label: "Clip" },
  { id: "more", label: "More" },
];
const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
const KEYS: { label: string; key: string }[] = [
  { label: "Esc", key: "Escape" },
  { label: "Tab", key: "Tab" },
  { label: "Enter", key: "Return" },
  { label: "⌫", key: "BackSpace" },
  { label: "Del", key: "Delete" },
  { label: "Home", key: "Home" },
  { label: "End", key: "End" },
  { label: "PgUp", key: "PageUp" },
  { label: "PgDn", key: "PageDown" },
  { label: "←", key: "Left" },
  { label: "→", key: "Right" },
  { label: "↑", key: "Up" },
  { label: "↓", key: "Down" },
  { label: "F5", key: "F5" },
];

export default function PCControl({
  connected,
  state,
  lowData,
  onConnect,
  draft,
  notice,
}: {
  connected: boolean;
  state: AppState | null;
  lowData: boolean;
  onConnect: () => void;
  draft: (text: string) => void;
  notice: (text: string) => void;
}) {
  const [frame, setFrame] = useState(""),
    [region, setRegion] = useState<Region>(FULL),
    [streaming, setStreaming] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [inputEnabled, setInputEnabled] = useState(false),
    [pin, setPin] = useState(""),
    [zoom, setZoom] = useState(1),
    [center, setCenter] = useState<Center>({ x: 0.5, y: 0.5 }),
    [tab, setTab] = useState<Tab>("pad"),
    [ripple, setRipple] = useState<Ripple | null>(null),
    [text, setText] = useState(""),
    [clip, setClip] = useState(""),
    [clipBusy, setClipBusy] = useState(false),
    [clipNote, setClipNote] = useState(""),
    [mods, setMods] = useState<string[]>([]),
    [pc, setPc] = useState<PcState | null>(null),
    [pcError, setPcError] = useState(""),
    [takingOver, setTakingOver] = useState(false),
    [lastFrameAt, setLastFrameAt] = useState(0),
    // GNOME's portal screenshots never contain the pointer, so the app keeps
    // its own marker: absolute where the PC reported pixels, relative for
    // trackpad/nudge moves (which are PC pixels too).
    [cursor, setCursor] = useState<Center | null>(null),
    [screenPx, setScreenPx] = useState<Size | null>(null),
    [marker, setMarker] = useState<{
      x: number;
      y: number;
      size: number;
    } | null>(null),
    [imgSize, setImgSize] = useState<Size>({ width: 0, height: 0 }),
    [now, setNow] = useState(() => Date.now()),
    [fullscreen, setFullscreen] = useState(false),
    [dragLine, setDragLine] = useState<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    } | null>(null);

  const stage = useRef<HTMLDivElement>(null),
    image = useRef<HTMLImageElement>(null),
    frameURL = useRef(""),
    etag = useRef(""),
    capturing = useRef(false),
    alive = useRef(true),
    failures = useRef(0),
    startedOnce = useRef(false),
    retryTimer = useRef<ReturnType<typeof setTimeout>>(),
    refreshTimer = useRef<ReturnType<typeof setTimeout>>(),
    active = useRef(connected),
    view = useRef({ zoom: 1, center: { x: 0.5, y: 0.5 } }),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    gesture = useRef<{
      startZoom: number;
      startCenter: Center;
      pinchDistance: number;
      pinchAnchor: { x: number; y: number };
      moved: boolean;
      lastX: number;
      lastY: number;
      startedAt: number;
      longPress: ReturnType<typeof setTimeout> | null;
      fired: boolean;
      pinched: boolean;
      origin: { x: number; y: number } | null;
    } | null>(null),
    lastTap = useRef({ at: 0, x: 0, y: 0 }),
    pointerBusy = useRef(false),
    pointerNoticeAt = useRef(0),
    lastMoveAt = useRef(0),
    padCarry = useRef({ x: 0, y: 0 }),
    captureMs = useRef(0),
    screenPxRef = useRef<Size | null>(null),
    pointerPixels = useRef<{ x: number; y: number } | null>(null);

  active.current = connected;
  view.current = { zoom, center };
  screenPxRef.current = screenPx;
  const busyAgent = Boolean(state?.active.length || pc?.busy);

  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      clearTimeout(retryTimer.current);
      clearTimeout(refreshTimer.current);
      if (frameURL.current) URL.revokeObjectURL(frameURL.current);
    };
  }, []);

  const capture = useCallback(async () => {
    if (!active.current || document.visibilityState === "hidden") return;
    if (capturing.current) return;
    capturing.current = true;
    setLoading(true);
    try {
      const wanted = view.current;
      const res = await api.wire(
        `/api/screen${frameQuery({
          zoom: wanted.zoom,
          center: wanted.center,
          width: lowData ? 960 : 1440,
        })}`,
        {
          binary: true,
          timeout: 8000,
          headers: etag.current ? { "if-none-match": etag.current } : {},
        },
      );
      if (!alive.current || !active.current) return;
      const px = {
        width: Number(res.headers?.["x-screen-width"]),
        height: Number(res.headers?.["x-screen-height"]),
      };
      if (px.width > 0 && px.height > 0) setScreenPx(px);
      if (res.status !== 304 && res.base64) {
        const url = URL.createObjectURL(
          base64Blob(res.base64, res.mime || "image/png"),
        );
        const old = frameURL.current;
        frameURL.current = url;
        setFrame(url);
        setRegion(
          wanted.zoom > 1
            ? visibleRegion(wanted.zoom, wanted.center)
            : FULL,
        );
        if (old) URL.revokeObjectURL(old);
        etag.current = res.headers?.etag || "";
      }
      failures.current = 0;
      setError("");
      setLastFrameAt(Date.now());
    } catch (e) {
      if (!alive.current) return;
      failures.current += 1;
      setError(
        e instanceof Error ? e.message : "Could not capture the PC screen",
      );
      // Slow down instead of hammering a PC that is asleep or unreachable.
      if (streaming) {
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(
          () => void capture(),
          retryDelay(failures.current),
        );
      }
    } finally {
      capturing.current = false;
      if (alive.current) setLoading(false);
    }
  }, [lowData, streaming]);

  /** One frame after an action: proof that the tap/keystroke landed. */
  const refreshSoon = useCallback(
    (delay = 260) => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void capture(), delay);
    },
    [capture],
  );

  // Keep the pointer marker glued to the image through zoom, pan and rotation.
  useEffect(() => {
    const place = () => {
      const box = stage.current;
      // A frame that already contains the real pointer needs no second arrow.
      const known = pc?.pointerInFrame;
      if (!box || !cursor || !frame || known === true) return setMarker(null);
      const rect = box.getBoundingClientRect();
      const point = cursorMarkerPosition(cursor, rect, imgSize, region);
      if (!point) return setMarker(null);
      // Size it like a real cursor: ~20 PC pixels tall, scaled to how big this
      // image actually is on the phone. A fixed 23px arrow looked enormous.
      const scale = Math.min(rect.width / imgSize.width, rect.height / imgSize.height),
        perPcPixel = screenPx?.width
          ? (imgSize.width * scale) / screenPx.width
          : scale;
      const size = Math.min(22, Math.max(9, 20 * perPcPixel));
      setMarker({ ...point, size });
    };
    place();
    if (typeof ResizeObserver === "undefined" || !stage.current) return;
    const observer = new ResizeObserver(place);
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [
    cursor,
    frame,
    imgSize,
    region,
    zoom,
    center,
    fullscreen,
    screenPx,
    pc?.pointerInFrame,
  ]);

  useEffect(() => {
    if (!streaming || !connected) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const startedAt = Date.now();
      await capture();
      captureMs.current = Date.now() - startedAt;
      // Wait for the PC's own capture time plus a little air. A portal
      // screenshot can take seconds on Wayland, and asking again before it
      // finished is what buried the phone's request pool.
      const base = lowData ? 2500 : 1200;
      const wait = Math.max(base, Math.min(6000, captureMs.current + 400));
      if (!cancelled && alive.current) timer = setTimeout(loop, wait);
    };
    void loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [streaming, connected, capture, lowData]);

  // Re-fetch the cropped region shortly after a zoom/pan settles.
  useEffect(() => {
    if (!connected || !frame) return;
    const timer = setTimeout(() => void capture(), 220);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, center]);

  // Opening the page is already an explicit request to see the PC, so start one
  // preview instead of making the owner find a play button. Pausing stays one tap.
  useEffect(() => {
    if (!connected || startedOnce.current) return;
    startedOnce.current = true;
    setStreaming(true);
  }, [connected]);

  useEffect(() => {
    if (!connected) {
      setStreaming(false);
      setInputEnabled(false);
      setPin("");
      setFrame("");
      setPc(null);
      setCursor(null);
      setMarker(null);
      setZoom(1);
      setCenter({ x: 0.5, y: 0.5 });
      if (frameURL.current) URL.revokeObjectURL(frameURL.current);
      frameURL.current = "";
      etag.current = "";
    }
  }, [connected]);

  useEffect(() => {
    const hidden = () => {
      if (document.hidden) setStreaming(false);
    };
    const background = () => setStreaming(false);
    const online = () => {
      failures.current = 0;
      void capture();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("observer-background", background);
    window.addEventListener("online", online);
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("observer-background", background);
      window.removeEventListener("online", online);
      document.removeEventListener("fullscreenchange", sync);
    };
  }, [capture]);

  const loadPcState = useCallback(async () => {
    if (!connected) return;
    try {
      const next = await api.get<PcState>("/api/pc/state");
      if (!alive.current) return;
      setPc(next);
      if (next.screen && next.screen.width > 0 && next.screen.height > 0)
        setScreenPx({ width: next.screen.width, height: next.screen.height });
      setPcError("");
    } catch (e) {
      if (!alive.current) return;
      setPcError(e instanceof Error ? e.message : "PC state unavailable");
    }
  }, [connected]);

  // X11 can say where the cursor actually is, so the marker starts in the right
  // place and re-syncs whenever the phone has been idle: any drift (a dropped
  // move, the PC's own acceleration) corrects itself within a few seconds.
  // Wayland cannot answer at all — then the marker starts at the first tap.
  useEffect(() => {
    if (!connected || !inputEnabled) return;
    let cancelled = false;
    const sync = async (force: boolean) => {
      // Never fight an in-flight move: our own deltas are more recent.
      if (!force && Date.now() - lastMoveAt.current < 3000) return;
      try {
        const r = await api.get<{
          known: boolean;
          x?: number;
          y?: number;
          screen?: Size | null;
        }>("/api/pc/pointer");
        if (cancelled || !r.known || r.x == null || r.y == null) return;
        if (r.screen && r.screen.width > 0 && r.screen.height > 0)
          setScreenPx(r.screen);
        const screen = r.screen && r.screen.width > 0 ? r.screen : screenPxRef.current;
        const point = pixelToUnit({ x: r.x, y: r.y }, screen);
        if (point) setCursor(point);
        else pointerPixels.current = { x: r.x, y: r.y }; // wait for a screen size
      } catch {
        /* No pointer query on this desktop — the tap seeds the marker. */
      }
    };
    void sync(true);
    const timer = setInterval(() => void sync(false), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, inputEnabled]);

  useEffect(() => {
    if (!screenPx || !pointerPixels.current) return;
    const point = pixelToUnit(pointerPixels.current, screenPx);
    pointerPixels.current = null;
    if (point) setCursor(point);
  }, [screenPx]);

  // The bridge forwards only ETag headers, so the screen size a marker needs
  // comes from /api/pc/state — ask again as soon as a frame exists.
  useEffect(() => {
    if (!lastFrameAt || screenPx) return;
    void loadPcState();
  }, [lastFrameAt, screenPx, loadPcState]);

  useEffect(() => {
    if (!connected) return;
    void loadPcState();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void loadPcState();
    }, 15_000);
    return () => clearInterval(timer);
  }, [connected, loadPcState]);

  async function send(path: string, body: Record<string, unknown> = {}) {
    if (!inputEnabled) {
      notice("Turn on manual input first. Every tap can change your PC.");
      return false;
    }
    try {
      await api.post(path, { ...body, pin });
      refreshSoon();
      return true;
    } catch (e) {
      notice(e instanceof Error ? e.message : "Input not completed");
      refreshSoon(600);
      return false;
    }
  }

  function mark(x: number, y: number) {
    setRipple({ x, y, id: Date.now() });
    navigator.vibrate?.(8);
  }

  function tapped(point: { x: number; y: number }, at: { x: number; y: number }) {
    mark(at.x, at.y);
    void send("/api/tap", { ...point, relative: true }).then((ok) => {
      // The marker only moves for input the PC accepted.
      if (ok) setCursor({ x: point.x, y: point.y });
    });
  }

  /** Right click exactly where the finger is, not where the PC cursor was. */
  function rightClickAt(clientX: number, clientY: number, at: { x: number; y: number }) {
    const img = image.current;
    if (!img) return;
    const point = pointToScreen(
      clientX,
      clientY,
      img.getBoundingClientRect(),
      { width: img.naturalWidth, height: img.naturalHeight },
      region,
    );
    if (!point) return;
    mark(at.x, at.y);
    void send("/api/tap", { ...point, relative: true, button: "right" }).then(
      (ok) => {
        if (ok) setCursor({ x: point.x, y: point.y });
      },
    );
  }

  /** Right click at the pointer's current PC position (the dock button). */
  function rightClickHere() {
    void send("/api/pointer", { op: "click", button: "right" });
  }

  /** Send the accumulated trackpad movement, one request at a time. */
  function flushPointer() {
    if (pointerBusy.current) return;
    const move = padCarry.current;
    if (!move.x && !move.y) return;
    padCarry.current = { x: 0, y: 0 };
    pointerBusy.current = true;
    void api
      .post("/api/pointer", { op: "move", dx: move.x, dy: move.y, pin })
      .then(() => {
        // Only move the marker for a move the PC accepted: the pointer really
        // moved by exactly these pixels.
        lastMoveAt.current = Date.now();
        setCursor((c) => moveCursorBy(c, move.x, move.y, screenPxRef.current) ?? c);
      })
      .catch((e) => {
        // Keep input on: a busy bridge or a slow swipe is not a policy refusal.
        const now = Date.now();
        if (now - pointerNoticeAt.current > 4000) {
          pointerNoticeAt.current = now;
          notice(
            e instanceof Error ? e.message : "Pointer move was not delivered",
          );
        }
      })
      .finally(() => {
        pointerBusy.current = false;
        if (padCarry.current.x || padCarry.current.y) flushPointer();
      });
  }

  const setZoomKeepingCenter = (next: number) => {
    const result = zoomAround(zoom, center, next, { x: 0.5, y: 0.5 });
    setZoom(result.zoom);
    setCenter(result.center);
  };

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = e.currentTarget.getBoundingClientRect();
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        startZoom: zoom,
        startCenter: center,
        pinchDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        pinchAnchor: {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
        },
        moved: false,
        lastX: 0,
        lastY: 0,
        startedAt: Date.now(),
        longPress: null,
        fired: false,
        pinched: true,
        origin: null,
      };
      return;
    }
    if (gesture.current?.longPress) clearTimeout(gesture.current.longPress);
    const g = {
      startZoom: zoom,
      startCenter: center,
      pinchDistance: 0,
      pinchAnchor: { x: 0, y: 0 },
      moved: false,
      lastX: e.clientX,
      lastY: e.clientY,
      startedAt: Date.now(),
      longPress: null as ReturnType<typeof setTimeout> | null,
      fired: false,
      pinched: false,
      origin: inputEnabled && clampZoom(zoom) <= 1
        ? { x: e.clientX, y: e.clientY }
        : null,
    };
    // Held finger = right-click, the same habit as a laptop trackpad.
    if (inputEnabled)
      g.longPress = setTimeout(() => {
        if (!gesture.current || gesture.current.moved) return;
        gesture.current.fired = true;
        const at = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        rightClickAt(e.clientX, e.clientY, at);
      }, 550);
    gesture.current = g;
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (pointers.current.size >= 2) {
      g.pinched = true;
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      if (Math.abs(distance - g.pinchDistance) > 6) g.moved = true;
      const next = zoomAround(g.startZoom, g.startCenter, (g.startZoom * distance) / g.pinchDistance, {
        x: (g.pinchAnchor.x - rect.left) / rect.width,
        y: (g.pinchAnchor.y - rect.top) / rect.height,
      });
      setZoom(next.zoom);
      setCenter(next.center);
      return;
    }
    if (g.pinched) return; // one finger left over from a pinch must not jump the view
    const dx = e.clientX - g.lastX,
      dy = e.clientY - g.lastY;
    if (!g.moved && Math.hypot(dx, dy) > 4) {
      g.moved = true;
      if (g.longPress) {
        clearTimeout(g.longPress);
        g.longPress = null;
      }
    }
    if (g.moved && clampZoom(zoom) > 1) {
      setCenter(panCenter(zoom, center, dx / rect.width, dy / rect.height));
      g.lastX = e.clientX;
      g.lastY = e.clientY;
    } else if (g.moved && g.origin && inputEnabled) {
      const box = stage.current?.getBoundingClientRect();
      if (box) {
        setDragLine({
          x1: g.origin.x - box.left,
          y1: g.origin.y - box.top,
          x2: e.clientX - box.left,
          y2: e.clientY - box.top,
        });
      }
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (!g) return;
    if (g.longPress) clearTimeout(g.longPress);
    if (pointers.current.size > 0) return; // wait for the last finger
    gesture.current = null;
    if (g.fired) return;
    const elapsed = Date.now() - g.startedAt;
    if (g.pinched) {
      if (!g.moved && elapsed < 400 && inputEnabled) {
        const stageRect = e.currentTarget?.getBoundingClientRect?.() ?? null;
        rightClickAt(e.clientX, e.clientY, {
          x: e.clientX - (stageRect?.left ?? 0),
          y: e.clientY - (stageRect?.top ?? 0),
        });
      }
      return;
    }
    setDragLine(null);
    if (g.moved) {
      const img = image.current;
      if (!img || !g.origin || clampZoom(zoom) > 1) return;
      const rect = img.getBoundingClientRect();
      const from = pointToScreen(g.origin.x, g.origin.y, rect, {
        width: img.naturalWidth,
        height: img.naturalHeight,
      }, region);
      const to = pointToScreen(e.clientX, e.clientY, rect, {
        width: img.naturalWidth,
        height: img.naturalHeight,
      }, region);
      if (from && to) {
        mark(to.x, to.y);
        void send("/api/drag", { from, to }).then((ok) => {
          if (ok) setCursor({ x: to.x, y: to.y });
        });
      }
      return;
    }
    const img = image.current,
      el = stage.current;
    if (!img || !el) return;
    const rect = img.getBoundingClientRect();
    const point = pointToScreen(e.clientX, e.clientY, rect, {
      width: img.naturalWidth,
      height: img.naturalHeight,
    }, region);
    if (!point) return;
    const stageRect = el.getBoundingClientRect();
    // Double-tap zooms while browsing; with input on, taps are clicks.
    const last = lastTap.current;
    if (
      !inputEnabled &&
      elapsed < 300 &&
      Date.now() - last.at < 320 &&
      Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40
    ) {
      lastTap.current = { at: 0, x: 0, y: 0 };
      setZoomKeepingCenter(clampZoom(zoom) > 1.2 ? 1 : 2.2);
      return;
    }
    lastTap.current = { at: Date.now(), x: e.clientX, y: e.clientY };
    if (!inputEnabled) return;
    tapped(point, {
      x: e.clientX - stageRect.left,
      y: e.clientY - stageRect.top,
    });
  }

  async function wakeDisplay() {
    try {
      await api.post("/api/pc/display", { pin });
      notice("Display wake sent. Unlock the PC on the machine itself if it is locked.");
      await loadPcState();
      refreshSoon(400);
    } catch (e) {
      notice(e instanceof Error ? e.message : "Display wake failed");
    }
  }

  async function takeOver() {
    setTakingOver(true);
    try {
      await api.post("/api/chat", { text: "/stop" });
      for (let attempt = 0; attempt < 10; attempt++) {
        const next = await api.get<PcState>("/api/pc/state");
        setPc(next);
        if (!next.busy) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      setInputEnabled(true);
      notice("Agent stopped. Manual input is yours, time-limited by the PC's own policy.");
      refreshSoon(200);
    } catch (e) {
      notice(e instanceof Error ? e.message : "Could not take over");
    } finally {
      setTakingOver(false);
    }
  }

  async function readClipboard() {
    setClipBusy(true);
    setClipNote("");
    try {
      const value = await api.get<{ text?: string; truncated?: boolean }>(
        "/api/clipboard",
      );
      setClip(value.text || "");
      setClipNote(
        value.truncated
          ? "PC clipboard is long; the first part is shown."
          : value.text
            ? "Loaded from your PC."
            : "PC clipboard is empty.",
      );
    } catch (e) {
      setClipNote(e instanceof Error ? e.message : "Clipboard read failed");
    } finally {
      setClipBusy(false);
    }
  }

  async function writeClipboard(viaPaste = false) {
    if (!clip.trim()) return;
    setClipBusy(true);
    setClipNote("");
    try {
      await api.post("/api/clipboard", { text: clip, pin });
      if (viaPaste) {
        await api.post("/api/key", { key: "ctrl+v", pin });
        setClipNote("Sent to the PC clipboard and pasted.");
      } else setClipNote("Copied to the PC clipboard.");
      refreshSoon(400);
    } catch (e) {
      setClipNote(e instanceof Error ? e.message : "Clipboard write failed");
    } finally {
      setClipBusy(false);
    }
  }

  async function copyToPhone() {
    try {
      await navigator.clipboard.writeText(clip);
      setClipNote("Copied to this phone.");
    } catch {
      setClipNote("This browser blocks clipboard access; select the text instead.");
    }
  }

  const statusChips = useMemo(() => {
    const chips: { label: string; tone?: "warn" | "live" }[] = [];
    if (pcError) chips.push({ label: "PC state unavailable", tone: "warn" });
    if (pc?.locked) chips.push({ label: "Locked", tone: "warn" });
    if (pc?.display === "off") chips.push({ label: "Display asleep", tone: "warn" });
    if (pc?.session && pc.session !== "headless")
      chips.push({ label: pc.session === "wayland" ? "Wayland" : "X11" });
    if (pc?.battery) chips.push({ label: `${pc.battery.percent}%${pc.battery.charging ? " ⚡" : ""}` });
    if (busyAgent) chips.push({ label: "Agent busy", tone: "warn" });
    if (inputEnabled) chips.push({ label: "Input on", tone: "live" });
    return chips;
  }, [pc, pcError, busyAgent, inputEnabled]);

  const secondsAgo = lastFrameAt
    ? Math.max(0, Math.round((now - lastFrameAt) / 1000))
    : null;
  // Without a modifier the key keeps its PC name ("Return", "PageUp"); with one
  // it becomes a combo the agent already understands ("ctrl+shift+t").
  const modifierCombo = (key: string) =>
    mods.length ? [...mods, key].join("+").toLowerCase() : key;

  return (
    <div className="page-content pc-page">
      <SectionHeading
        eyebrow="YOUR PC, WITH YOU"
        title="PC control"
        action={
          connected && (
            <span className="small-pill">{state?.host || "PC connected"}</span>
          )
        }
      >
        Screen, trackpad and keyboard in one fixed view — nothing scrolls away
        while you work.
      </SectionHeading>
      {!connected ? (
        <EmptyPanel
          icon={<Monitor size={30} strokeWidth={1.4} />}
          title="Your desk. In your pocket."
          action={
            <button className="button primary" onClick={onConnect}>
              Connect a PC
              <ArrowRight size={17} />
            </button>
          }
        >
          Pair with your running PC agent to view the screen, use the keyboard,
          and put your tools to work. Nothing is captured in the background.
        </EmptyPanel>
      ) : (
        <div className="pc-shell">
          <div className="pc-head">
            <div className="pc-head-left">
              <span className={`status-dot ${streaming ? "live" : ""}`} />
              <span>{streaming ? "Live" : "Paused"}</span>
              {secondsAgo !== null && (
                <span className="pc-muted">
                  {secondsAgo <= 1 ? "just now" : `${secondsAgo}s ago`}
                </span>
              )}
            </div>
            <div className="pc-head-actions">
              <IconButton
                label="Zoom out"
                disabled={zoom <= 1}
                onClick={() => setZoomKeepingCenter(zoom - 0.5)}
              >
                <Minus size={16} />
              </IconButton>
              <button
                className="pc-zoom-label"
                onClick={() => setZoomKeepingCenter(1)}
                aria-label="Reset zoom"
              >
                {zoom.toFixed(1)}×
              </button>
              <IconButton
                label="Zoom in"
                disabled={zoom >= 4}
                onClick={() => setZoomKeepingCenter(zoom + 0.5)}
              >
                <Plus size={16} />
              </IconButton>
              <IconButton
                label={streaming ? "Pause preview" : "Start preview"}
                onClick={() => setStreaming(!streaming)}
              >
                {streaming ? <Pause size={16} /> : <Play size={16} />}
              </IconButton>
              <IconButton
                label="Refresh frame"
                disabled={loading}
                onClick={() => void capture()}
              >
                <RefreshCw size={16} className={loading ? "spin" : ""} />
              </IconButton>
              <IconButton
                label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
                onClick={() => {
                  if (document.fullscreenElement)
                    void document.exitFullscreen();
                  else
                    void stage.current
                      ?.requestFullscreen()
                      .catch(() => notice("Fullscreen is not available here."));
                }}
              >
                {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </IconButton>
            </div>
          </div>

          <div className="pc-strip">
            <div className="pc-chips">
              {statusChips.map((chip) => (
                <span
                  key={chip.label}
                  className={`pc-chip ${chip.tone || ""}`}
                >
                  {chip.label}
                </span>
              ))}
            </div>
            {(pc?.display === "off" || pc?.locked) && (
              <button className="pc-chip action" onClick={() => void wakeDisplay()}>
                <SunMedium size={13} />
                Wake display
              </button>
            )}
          </div>

          <div
            className={`pc-stage ${inputEnabled ? "input-on" : ""}`}
            ref={stage}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              pointers.current.clear();
              gesture.current = null;
              setDragLine(null);
            }}
            onDoubleClick={(e) => {
              if (inputEnabled) return;
              e.preventDefault();
              setZoomKeepingCenter(clampZoom(zoom) > 1.2 ? 1 : 2.2);
            }}
          >
            {frame ? (
              <>
                <img
                  ref={image}
                  src={frame}
                  alt="Live frame from your PC"
                  draggable={false}
                  onLoad={(e) =>
                    setImgSize({
                      width: e.currentTarget.naturalWidth,
                      height: e.currentTarget.naturalHeight,
                    })
                  }
                />
                {ripple && (
                  <span
                    key={ripple.id}
                    className="pc-ripple"
                    style={{ left: ripple.x, top: ripple.y }}
                  />
                )}
                {marker && (
                  <span
                    className="pc-cursor"
                    style={{
                      left: marker.x,
                      top: marker.y,
                      width: marker.size * 0.74,
                      height: marker.size,
                    }}
                    aria-hidden
                  >
                    <svg viewBox="0 0 17 23" width="100%" height="100%">
                      <path d="M1.9 1.6 L1.9 18.2 L6.2 14.1 L8.9 20.6 L12 19.2 L9.3 12.9 L14.9 12.9 Z" />
                    </svg>
                  </span>
                )}
                {dragLine && (
                  <svg className="pc-drag-line" aria-hidden>
                    <line
                      x1={dragLine.x1}
                      y1={dragLine.y1}
                      x2={dragLine.x2}
                      y2={dragLine.y2}
                    />
                  </svg>
                )}
                {zoom > 1 ? (
                  <span className="pc-pan-hint">Drag to pan · pinch to zoom</span>
                ) : (
                  inputEnabled && (
                    <span className="pc-pan-hint">Drag on the screen to drag on the PC</span>
                  )
                )}
              </>
            ) : (
              <div className="screen-placeholder">
                <Monitor size={34} strokeWidth={1.2} />
                <strong>
                  {error ? "Screen unavailable" : "Your screen stays private."}
                </strong>
                <p>
                  {error
                    ? error
                    : "Press play to request a frame. Nothing is captured in the background."}
                </p>
                {error && (
                  <button className="button compact" onClick={() => void capture()}>
                    Retry
                    <RefreshCw size={14} />
                  </button>
                )}
              </div>
            )}
            {loading && frame && (
              <span className="pc-frame-loading" aria-hidden>
                <LoaderCircle size={14} className="spin" />
              </span>
            )}
          </div>

          <div className="pc-control-row">
            <label className="pc-input-toggle">
              <input
                aria-label="Enable manual PC input"
                disabled={!state?.pcControl}
                type="checkbox"
                checked={inputEnabled}
                onChange={(e) => setInputEnabled(e.target.checked)}
              />
              <span>
                <Hand size={15} />
                Input
              </span>
            </label>
            {busyAgent && (
              <button
                className="button compact"
                disabled={takingOver || !state?.pcControl}
                onClick={() => void takeOver()}
              >
                {takingOver ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Square size={13} />
                )}
                Take over
              </button>
            )}
            {state?.controlPinRequired && (
              <input
                className="pc-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                aria-label="PC control PIN"
                placeholder="PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            )}
            {!state?.pcControl && (
              <span className="pc-muted">PC control is off on the PC</span>
            )}
          </div>

          <div className="pc-dock">
            <div className="pc-tabs" role="tablist">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={tab === item.id}
                  className={`pc-tab ${tab === item.id ? "active" : ""}`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="pc-dock-body">
              {tab === "pad" && (
                <>
                  <div
                    className={`pc-pad ${inputEnabled ? "input-on" : ""}`}
                    role="application"
                    aria-label="PC touchpad"
                    onPointerDown={(e) => {
                      if (!inputEnabled) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      (e.currentTarget as HTMLElement).dataset.px = String(e.clientX);
                      (e.currentTarget as HTMLElement).dataset.py = String(e.clientY);
                      (e.currentTarget as HTMLElement).dataset.ox = String(e.clientX);
                      (e.currentTarget as HTMLElement).dataset.oy = String(e.clientY);
                    }}
                    onPointerMove={(e) => {
                      if (!inputEnabled) return;
                      const el = e.currentTarget as HTMLElement;
                      const px = Number(el.dataset.px ?? 0),
                        py = Number(el.dataset.py ?? 0);
                      if (!el.dataset.px) return;
                      const dx = Math.round((e.clientX - px) * 1.4),
                        dy = Math.round((e.clientY - py) * 1.4);
                      if (Math.abs(dx) + Math.abs(dy) < 2) return;
                      el.dataset.px = String(e.clientX);
                      el.dataset.py = String(e.clientY);
                      padCarry.current = {
                        x: Math.max(-200, Math.min(200, padCarry.current.x + dx)),
                        y: Math.max(-200, Math.min(200, padCarry.current.y + dy)),
                      };
                      // Exactly one move in flight, with the rest of the swipe
                      // coalesced into the next one. The old fixed 24ms timer
                      // fired faster than a phone round-trip, so the Android
                      // bridge pool filled up and rejected everything — taps
                      // included. A dropped move must never disable input.
                      flushPointer();
                    }}
                    onPointerUp={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      const moved =
                        Math.hypot(
                          e.clientX - Number(el.dataset.ox ?? e.clientX),
                          e.clientY - Number(el.dataset.oy ?? e.clientY),
                        ) > 6;
                      delete el.dataset.px;
                      delete el.dataset.py;
                      if (!inputEnabled || moved) return;
                      mark(
                        e.clientX - el.getBoundingClientRect().left,
                        e.clientY - el.getBoundingClientRect().top,
                      );
                      void send("/api/pointer", { op: "click", button: "left" });
                    }}
                  >
                    <span>{inputEnabled ? "Move · tap to click · hold for right" : "Turn on Input to use the trackpad"}</span>
                  </div>
                  <div className="pc-row">
                    <button
                      className="button compact"
                      disabled={!inputEnabled}
                      onClick={rightClickHere}
                    >
                      Right click
                    </button>
                    <button
                      className="button compact"
                      disabled={!inputEnabled}
                      onClick={() =>
                        void send("/api/pointer", { op: "scroll", direction: "up", amount: 3 })
                      }
                    >
                      Scroll ↑
                    </button>
                    <button
                      className="button compact"
                      disabled={!inputEnabled}
                      onClick={() =>
                        void send("/api/pointer", { op: "scroll", direction: "down", amount: 3 })
                      }
                    >
                      Scroll ↓
                    </button>
                  </div>
                  <p className="pc-muted">
                    {pc?.pointerInFrame
                      ? "The PC draws its own cursor into this frame, so no extra arrow is needed."
                      : inputEnabled && !cursor
                        ? "Tap the screen once: this desktop cannot report where the pointer is, so the arrow appears after your first tap."
                        : "The arrow marks where your input landed and follows every move."}
                  </p>
                  <div className="pc-row">
                    <span className="pc-muted">Nudge</span>
                    {[
                      { icon: <ArrowUp size={14} />, dx: 0, dy: -10, label: "Up" },
                      { icon: <ArrowDown size={14} />, dx: 0, dy: 10, label: "Down" },
                      { icon: <ArrowLeft size={14} />, dx: -10, dy: 0, label: "Left" },
                      { icon: <ArrowRight size={14} />, dx: 10, dy: 0, label: "Right" },
                    ].map((n) => (
                      <IconButton
                        key={n.label}
                        label={`Nudge ${n.label}`}
                        disabled={!inputEnabled}
                        onClick={() => {
                          setCursor((c) => moveCursorBy(c, n.dx, n.dy, screenPx) ?? c);
                          void send("/api/pointer", { op: "move", dx: n.dx, dy: n.dy });
                        }}
                      >
                        {n.icon}
                      </IconButton>
                    ))}
                  </div>
                </>
              )}

              {tab === "keys" && (
                <>
                  <div className="pc-row">
                    {MODIFIERS.map((name) => (
                      <button
                        key={name}
                        className={`pc-key ${mods.includes(name) ? "held" : ""}`}
                        disabled={!inputEnabled}
                        aria-pressed={mods.includes(name)}
                        onClick={() =>
                          setMods((set) =>
                            set.includes(name)
                              ? set.filter((m) => m !== name)
                              : [...set, name],
                          )
                        }
                      >
                        {name === "super" ? "Super" : name[0].toUpperCase() + name.slice(1)}
                      </button>
                    ))}
                  </div>
                  <div className="pc-keygrid">
                    {KEYS.map((item) => (
                      <button
                        key={item.label}
                        className="pc-key"
                        disabled={!inputEnabled}
                        onClick={() =>
                          void send("/api/key", { key: modifierCombo(item.key) })
                        }
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <p className="pc-muted">
                    Modifiers stay held until you tap them again — Ctrl + C is two
                    taps, not a keyboard.
                  </p>
                </>
              )}

              {tab === "type" && (
                <>
                  <textarea
                    className="pc-text"
                    aria-label="Type on your PC"
                    placeholder="Type on your PC…"
                    value={text}
                    maxLength={4000}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <div className="pc-row">
                    <button
                      className="button compact"
                      disabled={!inputEnabled || !text.trim()}
                      onClick={() =>
                        void send("/api/type", { text }).then((ok) => ok && setText(""))
                      }
                    >
                      Type
                      <Keyboard size={14} />
                    </button>
                    <button
                      className="button compact"
                      disabled={!inputEnabled || !text.trim()}
                      onClick={async () => {
                        const ok = await send("/api/type", { text });
                        if (ok) {
                          await send("/api/key", { key: "Return" });
                          setText("");
                        }
                      }}
                    >
                      Type + Enter
                      <CornerDownLeft size={14} />
                    </button>
                    <button
                      className="button compact"
                      disabled={!inputEnabled || text.length < 40}
                      onClick={async () => {
                        try {
                          await api.post("/api/clipboard", { text, pin });
                          await send("/api/key", { key: "ctrl+v" });
                          setText("");
                          notice("Long text sent through the PC clipboard.");
                        } catch (e) {
                          notice(e instanceof Error ? e.message : "Paste failed");
                        }
                      }}
                    >
                      Paste long text
                    </button>
                  </div>
                  <p className="pc-muted">
                    Typing is capped at 4000 characters. Use the clipboard button
                    for anything longer.
                  </p>
                </>
              )}

              {tab === "clip" && (
                <>
                  <textarea
                    className="pc-text"
                    aria-label="Clipboard text"
                    placeholder="Phone and PC clipboard in one box…"
                    value={clip}
                    maxLength={20_000}
                    onChange={(e) => setClip(e.target.value)}
                  />
                  <div className="pc-row">
                    <button
                      className="button compact"
                      disabled={clipBusy}
                      onClick={() => void readClipboard()}
                    >
                      <ClipboardCopy size={14} />
                      Read PC
                    </button>
                    <button
                      className="button compact"
                      disabled={clipBusy || !clip.trim()}
                      onClick={() => void writeClipboard(false)}
                    >
                      <ClipboardPaste size={14} />
                      Send to PC
                    </button>
                    <button
                      className="button compact"
                      disabled={clipBusy || !clip.trim() || !inputEnabled}
                      onClick={() => void writeClipboard(true)}
                    >
                      Send + paste
                    </button>
                    <button
                      className="button compact"
                      disabled={!clip.trim()}
                      onClick={() => void copyToPhone()}
                    >
                      Copy here
                    </button>
                  </div>
                  {clipNote && <p className="pc-muted">{clipNote}</p>}
                  <p className="pc-muted">
                    Overwriting the PC clipboard needs the PC PIN. Nothing is
                    stored on this phone.
                  </p>
                </>
              )}

              {tab === "more" && (
                <>
                  <div className="pc-status-grid">
                    <div>
                      <span>Session</span>
                      <strong>{pc?.session || (pcError ? "unknown" : "…")}</strong>
                    </div>
                    <div>
                      <span>Locked</span>
                      <strong>
                        {pc?.locked === null || pc?.locked === undefined
                          ? "unknown"
                          : pc.locked
                            ? "yes"
                            : "no"}
                      </strong>
                    </div>
                    <div>
                      <span>Display</span>
                      <strong>{pc?.display || "unknown"}</strong>
                    </div>
                    <div>
                      <span>Battery</span>
                      <strong>
                        {pc?.battery ? `${pc.battery.percent}%` : "n/a"}
                      </strong>
                    </div>
                    <div>
                      <span>Disk free</span>
                      <strong>
                        {pc?.diskFreeMb
                          ? `${(pc.diskFreeMb / 1024).toFixed(1)} GB`
                          : "n/a"}
                      </strong>
                    </div>
                    <div>
                      <span>Agent</span>
                      <strong>{busyAgent ? "busy" : "idle"}</strong>
                    </div>
                  </div>
                  <div className="pc-row">
                    <button className="button compact" onClick={() => void loadPcState()}>
                      <RefreshCw size={14} />
                      Refresh
                    </button>
                    <button className="button compact" onClick={() => void wakeDisplay()}>
                      <SunMedium size={14} />
                      Wake display
                    </button>
                    <button
                      className="button compact"
                      onClick={() => draft("/pc lock")}
                    >
                      <LockKeyhole size={14} />
                      Lock PC
                    </button>
                    <button
                      className="button compact"
                      onClick={() => {
                        setStreaming(!streaming);
                        void capture();
                      }}
                    >
                      <Gauge size={14} />
                      New frame
                    </button>
                  </div>
                  {pcError && <p className="pc-muted">{pcError}</p>}
                  <LiveDesktop notice={notice} />
                  <p className="trust-note">
                    <ShieldCheck size={13} />
                    Manual input needs PC-side permission. The PC PIN is used per
                    request and never stored on this phone.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {error && frame && (
        <p className="form-error pc-error" role="alert">
          {error}
          <button className="text-button" onClick={() => void capture()}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
