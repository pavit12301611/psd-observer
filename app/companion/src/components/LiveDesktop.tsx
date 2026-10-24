import { useEffect, useRef, useState } from "react";
import { Play, Square, Monitor, LoaderCircle } from "lucide-react";
import { api } from "../core/api";
export default function LiveDesktop({
  notice,
}: {
  notice: (s: string) => void;
}) {
  const [quality, setQuality] = useState("saver"),
    [active, setActive] = useState(false),
    [phase, setPhase] = useState("PC browser sharing is required."),
    [ready, setReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    peer = useRef<RTCPeerConnection | null>(null),
    session = useRef(""),
    generation = useRef(0);
  async function stop() {
    generation.current++;
    peer.current?.close();
    peer.current = null;
    const id = session.current;
    session.current = "";
    if (id) void api.post("/api/app/rtc/" + id, { end: true }).catch(() => {});
    if (video.current) video.current.srcObject = null;
    setActive(false);
    setReady(false);
    setPhase("Live video stopped. No recording.");
  }
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) void stop();
    };
    const background = () => void stop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("observer-background", background);
    return () => {
      void stop();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("observer-background", background);
    };
  }, []);
  async function start() {
    await stop();
    const g = generation.current;
    setActive(true);
    setPhase("Waiting for an explicitly shared PC screen…");
    try {
      const s = await api.post<{ id: string; iceServers: RTCIceServer[] }>(
        "/api/app/rtc/session",
        { quality },
      );
      if (g !== generation.current) {
        void api.post("/api/app/rtc/" + s.id, { end: true });
        return;
      }
      session.current = s.id;
      const pc = new RTCPeerConnection({ iceServers: s.iceServers });
      peer.current = pc;
      let candidateCount = 0,
        remote = false;
      const pending: RTCIceCandidateInit[] = [];
      pc.onicecandidate = (e) => {
        if (e.candidate) pending.push(e.candidate.toJSON());
      };
      pc.ontrack = (e) => {
        if (g !== generation.current) return;
        if (video.current) {
          video.current.srcObject = e.streams[0];
          void video.current
            .play()
            .catch(() => setPhase("Tap the video to start playback."));
        }
        setReady(true);
        setPhase("Live WebRTC video · no audio/recording");
      };
      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        )
          setPhase(
            "Video connection interrupted. Stop/reconnect explicitly; no PC action was replayed.",
          );
      };
      while (g === generation.current) {
        const state = await api.get<{
          offer?: RTCSessionDescriptionInit;
          publisherCandidates: RTCIceCandidateInit[];
        }>("/api/app/rtc/" + s.id);
        if (state.offer && !remote) {
          await pc.setRemoteDescription(state.offer);
          remote = true;
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await api.post("/api/app/rtc/" + s.id, {
            description: { type: "answer", sdp: answer.sdp },
          });
        }
        if (remote)
          for (const c of state.publisherCandidates.slice(candidateCount)) {
            await pc.addIceCandidate(c).catch(() => {});
            candidateCount++;
          }
        if (pending.length)
          await api.post("/api/app/rtc/" + s.id, {
            candidates: pending.splice(0, 20),
          });
        await new Promise((r) => setTimeout(r, 900));
      }
    } catch (e) {
      if (g === generation.current) {
        notice(e instanceof Error ? e.message : "Video unavailable");
        await stop();
      }
    }
  }
  return (
    <div className="control-card">
      <div className="control-card-title">
        <span>
          <Monitor size={18} />
          Live desktop
        </span>
        <span className="small-pill">WebRTC · opt-in</span>
      </div>
      <p>
        On the PC open <code>http://localhost:8787/desktop</code> (or HTTPS),
        unlock and choose a monitor/window. LAN/private VPN by default; no
        Internet TURN relay is bundled. Browser/OS consent cannot be bypassed.
      </p>
      <div className="button-row">
        <select
          aria-label="Live video quality"
          value={quality}
          disabled={active}
          onChange={(e) => setQuality(e.target.value)}
        >
          <option value="saver">Saver · request 540p / 6fps</option>
          <option value="balanced">Balanced · request 720p / 15fps</option>
          <option value="quality">Quality · request 1080p / 24fps</option>
        </select>
        <button
          className="button"
          onClick={() => (active ? void stop() : void start())}
        >
          {active ? <Square size={15} /> : <Play size={15} />}{" "}
          {active ? "Stop video" : "Connect live video"}
        </button>
      </div>
      <p role="status">{phase}</p>
      <video
        className="live-desktop"
        ref={video}
        autoPlay
        muted
        playsInline
        controls
        onClick={() => void video.current?.play()}
      />
      {active && !ready && <LoaderCircle size={18} className="spin" />}
      <p className="small-text muted">
        Requested quality is not a measured FPS guarantee. Use a monitor for
        desktop control; choose/change sources on the PC. Keyboard/touchpad
        remain separately authorized, and video stops when the phone app
        backgrounds.
      </p>
    </div>
  );
}
