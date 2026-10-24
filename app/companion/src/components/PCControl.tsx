import { useCallback, useEffect, useRef, useState } from "react";
import {
  Monitor,
  Play,
  Pause,
  RefreshCw,
  Keyboard,
  ArrowUp,
  ArrowDown,
  CornerDownLeft,
  Delete,
  Maximize2,
  LockKeyhole,
  MousePointer2,
  ShieldCheck,
  ArrowRight,
} from "lucide-react";
import LiveDesktop from "./LiveDesktop";
import type { AppState } from "../types";
import { api, base64Blob } from "../core/api";
import { relativePoint } from "../core/validation";
import { EmptyPanel, IconButton, SectionHeading } from "./ui";
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
  const [streaming, setStreaming] = useState(false),
    [frame, setFrame] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [pin, setPin] = useState(""),
    [inputEnabled, setInputEnabled] = useState(false);
  const touch = useRef<{
    x: number;
    y: number;
    moved: boolean;
    busy: boolean;
  } | null>(null);
  const dragStart = useRef<{ x: number; y: number; relative: boolean } | null>(
    null,
  );
  const suppressClick = useRef(false);
  const image = useRef<HTMLImageElement>(null),
    frameURL = useRef(""),
    etag = useRef(""),
    capturing = useRef(false),
    alive = useRef(true),
    control = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  active.current = connected;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (frameURL.current) URL.revokeObjectURL(frameURL.current);
    };
  }, []);
  const capture = useCallback(async () => {
    if (
      !active.current ||
      document.visibilityState === "hidden" ||
      capturing.current
    )
      return;
    capturing.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await api.wire(`/api/screen?w=${lowData ? 960 : 1440}`, {
        binary: true,
        timeout: 25_000,
        headers: etag.current ? { "if-none-match": etag.current } : {},
      });
      if (!alive.current || !active.current) return;
      if (res.status !== 304 && res.base64) {
        const url = URL.createObjectURL(
          base64Blob(res.base64, res.mime || "image/png"),
        );
        const old = frameURL.current;
        frameURL.current = url;
        setFrame(url);
        if (old) URL.revokeObjectURL(old);
        etag.current = res.headers?.etag || "";
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : "Capture unavailable");
        setStreaming(false);
      }
    } finally {
      capturing.current = false;
      if (alive.current) setLoading(false);
    }
  }, [lowData]);
  useEffect(() => {
    if (!connected) {
      setStreaming(false);
      setInputEnabled(false);
      setPin("");
      setFrame("");
      if (frameURL.current) URL.revokeObjectURL(frameURL.current);
      frameURL.current = "";
      etag.current = "";
    }
  }, [connected]);
  useEffect(() => {
    if (!streaming || !connected) return;
    let timer: ReturnType<typeof setTimeout>,
      cancelled = false;
    const loop = async () => {
      await capture();
      if (!cancelled && alive.current)
        timer = setTimeout(loop, lowData ? 2500 : 1200);
    };
    void loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [streaming, connected, capture, lowData]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        setStreaming(false);
        setInputEnabled(false);
      }
    };
    const background = () => {
      setStreaming(false);
      setInputEnabled(false);
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("observer-background", background);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("observer-background", background);
    };
  }, []);
  async function input(path: string, body: Record<string, unknown>) {
    if (!inputEnabled) {
      notice("Enable manual input first. Every tap can change your PC.");
      return false;
    }
    try {
      await api.post(path, { ...body, pin });
      return true;
    } catch (e) {
      notice(e instanceof Error ? e.message : "Input not completed");
      return false;
    }
  }
  return (
    <div className="page-content">
      <SectionHeading
        eyebrow="YOUR PC, WITH YOU"
        title="A little closer."
        action={
          connected && (
            <span className="small-pill">{state?.host || "PC connected"}</span>
          )
        }
      >
        A considered workspace, wherever you are.
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
        <>
          <div className="remote-panel" ref={control}>
            <div className="remote-toolbar">
              <span>
                <span className={`status-dot ${streaming ? "live" : ""}`} />
                {streaming ? "Screen preview on" : "Screen preview paused"}
              </span>
              <div>
                <IconButton
                  label={
                    streaming ? "Pause screen preview" : "Start screen preview"
                  }
                  onClick={() => setStreaming(!streaming)}
                >
                  {streaming ? <Pause size={17} /> : <Play size={17} />}
                </IconButton>
                <IconButton
                  label="Refresh screenshot"
                  disabled={loading}
                  onClick={() => void capture()}
                >
                  <RefreshCw size={17} className={loading ? "spin" : ""} />
                </IconButton>
                <IconButton
                  label="Expand screen"
                  onClick={() => {
                    if (document.fullscreenElement)
                      void document.exitFullscreen();
                    else
                      void control.current
                        ?.requestFullscreen()
                        .catch(() =>
                          notice("Fullscreen is not available here."),
                        );
                  }}
                >
                  <Maximize2 size={17} />
                </IconButton>
              </div>
            </div>
            <div className={`screen-view ${inputEnabled ? "input-on" : ""}`}>
              {frame ? (
                <img
                  ref={image}
                  src={frame}
                  alt="Latest screenshot from your connected PC"
                  draggable={false}
                  onPointerDown={(e) => {
                    const img = image.current;
                    if (!img || !inputEnabled) return;
                    dragStart.current = relativePoint(
                      e.clientX,
                      e.clientY,
                      img.getBoundingClientRect(),
                      { width: img.naturalWidth, height: img.naturalHeight },
                    );
                  }}
                  onPointerUp={(e) => {
                    const img = image.current,
                      start = dragStart.current;
                    dragStart.current = null;
                    if (!img || !start || !inputEnabled) return;
                    const to = relativePoint(
                      e.clientX,
                      e.clientY,
                      img.getBoundingClientRect(),
                      { width: img.naturalWidth, height: img.naturalHeight },
                    );
                    if (to && Math.hypot(to.x - start.x, to.y - start.y) > 20) {
                      suppressClick.current = true;
                      void input("/api/drag", { from: start, to });
                    }
                  }}
                  onClick={(e) => {
                    const img = image.current;
                    if (!img || !inputEnabled) return;
                    const point = relativePoint(
                      e.clientX,
                      e.clientY,
                      img.getBoundingClientRect(),
                      { width: img.naturalWidth, height: img.naturalHeight },
                    );
                    if (point) void input("/api/tap", point);
                  }}
                />
              ) : (
                <div className="screen-placeholder">
                  <Monitor size={36} strokeWidth={1.2} />
                  <strong>Your screen stays private.</strong>
                  <p>Press play to request a screen preview.</p>
                </div>
              )}
            </div>
            <div className="screen-caption">
              <span>
                {lowData
                  ? "Battery saver · up to 1 frame / 2.5s"
                  : "Balanced · up to 1 frame / 1.2s"}
              </span>
              <span>Stops when backgrounded</span>
            </div>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="control-card">
            <div className="control-card-title">
              <span>
                <MousePointer2 size={18} />
                Manual input
              </span>
              <label className="toggle">
                <input
                  aria-label="Enable manual PC input"
                  disabled={!state?.pcControl || !!state?.active.length}
                  type="checkbox"
                  checked={inputEnabled}
                  onChange={(e) => setInputEnabled(e.target.checked)}
                />
                <span />
              </label>
            </div>
            <p>
              Turn on deliberately. Screen taps and keys act directly on your
              PC.
            </p>
            {state?.controlPinRequired && (
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                aria-label="PC control PIN"
                placeholder="PC control PIN (kept in memory only)"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            )}
            <div className="keyboard-shortcuts">
              {[
                ["Esc", "Escape"],
                ["Tab", "Tab"],
                ["Ctrl + L", "ctrl+l"],
                ["Copy", "ctrl+c"],
                ["Paste", "ctrl+v"],
              ].map(([label, key]) => (
                <button
                  disabled={!inputEnabled}
                  className="key"
                  key={key}
                  onClick={() => void input("/api/key", { key })}
                >
                  {label}
                </button>
              ))}
              <IconButton
                label="Arrow up"
                disabled={!inputEnabled}
                onClick={() => void input("/api/key", { key: "Up" })}
              >
                <ArrowUp size={17} />
              </IconButton>
              <IconButton
                label="Arrow down"
                disabled={!inputEnabled}
                onClick={() => void input("/api/key", { key: "Down" })}
              >
                <ArrowDown size={17} />
              </IconButton>
              <IconButton
                label="Backspace"
                disabled={!inputEnabled}
                onClick={() => void input("/api/key", { key: "BackSpace" })}
              >
                <Delete size={17} />
              </IconButton>
              <IconButton
                label="Enter"
                disabled={!inputEnabled}
                onClick={() => void input("/api/key", { key: "Return" })}
              >
                <CornerDownLeft size={17} />
              </IconButton>
            </div>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim())
                  void input("/api/type", { text }).then((ok) => {
                    if (ok) setText("");
                  });
              }}
            >
              <Keyboard size={18} />
              <input
                aria-label="Type on your PC"
                placeholder="Type something on your PC…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={4000}
                disabled={!inputEnabled}
              />
              <button
                className="button compact"
                disabled={!inputEnabled || !text.trim()}
                type="submit"
              >
                Type
                <ArrowRight size={15} />
              </button>
            </form>
          </div>
          <div className="control-card">
            <div className="control-card-title">
              <span>Touchpad · current PC cursor</span>
              <span className="small-pill">Manual input only</span>
            </div>
            <p>
              Move without guessing a video/window coordinate. Tap for
              left-click; use the explicit right-click and scroll buttons.
              Original PIN/access/task barriers apply.
            </p>
            <div
              className={`touchpad ${inputEnabled ? "input-on" : ""}`}
              role="application"
              aria-label="PC touchpad"
              onPointerDown={(e) => {
                if (!inputEnabled) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                touch.current = {
                  x: e.clientX,
                  y: e.clientY,
                  moved: false,
                  busy: false,
                };
              }}
              onPointerMove={(e) => {
                const t = touch.current;
                if (!t || !inputEnabled || t.busy) return;
                const dx = Math.round((e.clientX - t.x) * 1.4),
                  dy = Math.round((e.clientY - t.y) * 1.4);
                if (Math.abs(dx) + Math.abs(dy) < 3) return;
                t.moved = true;
                t.x = e.clientX;
                t.y = e.clientY;
                t.busy = true;
                void input("/api/pointer", {
                  op: "move",
                  dx: Math.max(-200, Math.min(200, dx)),
                  dy: Math.max(-200, Math.min(200, dy)),
                }).then((ok) => {
                  t.busy = false;
                  if (!ok) setInputEnabled(false);
                });
              }}
              onPointerUp={() => {
                const t = touch.current;
                touch.current = null;
                if (t && !t.moved && inputEnabled)
                  void input("/api/pointer", { op: "click", button: "left" });
              }}
              onPointerCancel={() => (touch.current = null)}
            >
              Enable manual input, then move here
            </div>
            <div className="button-row">
              <button
                className="button"
                disabled={!inputEnabled}
                onClick={() =>
                  void input("/api/pointer", { op: "click", button: "right" })
                }
              >
                Right click
              </button>
              <button
                className="button"
                disabled={!inputEnabled}
                onClick={() =>
                  void input("/api/pointer", {
                    op: "scroll",
                    direction: "up",
                    amount: 3,
                  })
                }
              >
                Scroll up
              </button>
              <button
                className="button"
                disabled={!inputEnabled}
                onClick={() =>
                  void input("/api/pointer", {
                    op: "scroll",
                    direction: "down",
                    amount: 3,
                  })
                }
              >
                Scroll down
              </button>
            </div>
            <p className="small-text muted">
              Dragging a screenshot uses the PC's actual geometry and supported
              input backend; unsupported Wayland dragging reports an error, not
              a fake success.
            </p>
          </div>
          <LiveDesktop notice={notice} />
          <div className="tool-grid">
            <button className="tool-card" onClick={() => draft("/apps")}>
              <Monitor size={20} />
              <strong>Applications</strong>
              <span>Find and open a PC app</span>
            </button>
            <button className="tool-card" onClick={() => draft("/pc lock")}>
              <LockKeyhole size={20} />
              <strong>Lock session</strong>
              <span>Review the command in chat</span>
            </button>
          </div>
          <p className="trust-note">
            <ShieldCheck size={14} />
            Manual controls require PC-side permissions. AI commands retain
            their original confirmation gates.
          </p>
        </>
      )}
    </div>
  );
}
