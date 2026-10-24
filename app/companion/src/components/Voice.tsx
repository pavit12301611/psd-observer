import { useEffect, useRef, useState } from "react";
import {
  Mic,
  LoaderCircle,
  PhoneOff,
  ShieldCheck,
  Volume2,
  Square,
} from "lucide-react";
import { api, base64Blob } from "../core/api";
import { submitAndWatch, rememberJob } from "../core/jobs";
import { cancelSpeech, dictate, speakAndWait } from "../core/speech";
import type { Reply } from "../types";
import { Modal, Mark } from "./ui";
export default function Voice({
  language,
  conversationId,
  onClose,
  onReply,
}: {
  language: string;
  conversationId: string;
  onClose: () => void;
  onReply: (r: Reply) => void;
}) {
  const [phase, setPhase] = useState("Ready when you are."),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [last, setLast] = useState(""),
    [partial, setPartial] = useState(""),
    [continuous, setContinuous] = useState(false);
  const session = useRef(""),
    alive = useRef(true),
    audio = useRef<HTMLAudioElement | null>(null),
    generation = useRef(0),
    auto = useRef(false),
    working = useRef(false),
    job = useRef("");
  useEffect(() => {
    alive.current = true;
    const hidden = () => {
      if (document.hidden) onClose();
    };
    const captions = (e: Event) =>
      setPartial(String((e as CustomEvent).detail || ""));
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("observer-speech-partial", captions);
    return () => {
      alive.current = false;
      generation.current++;
      auto.current = false;
      cancelSpeech();
      audio.current?.pause();
      if (session.current)
        void api
          .post("/api/call/stop", { sessionId: session.current })
          .catch(() => {});
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("observer-speech-partial", captions);
    };
  }, [onClose]);
  async function playback(reply: Reply) {
    const media = reply.media?.find((m) => m.kind === "audio");
    if (media) {
      let url = "";
      try {
        const r = await api.wire(media.url, { binary: true });
        url = URL.createObjectURL(base64Blob(r.base64 || "", media.mime));
        audio.current = new Audio(url);
        await new Promise<void>((resolve, reject) => {
          const a = audio.current!;
          a.onended = () => resolve();
          a.onpause = () => resolve();
          a.onerror = () => reject(new Error("Audio unavailable"));
          void a.play().catch(reject);
        });
        return;
      } catch {
        /* Native TTS fallback. */
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    }
    await speakAndWait(reply.spoken || reply.text || "", language);
  }
  async function turn() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    const g = generation.current;
    try {
      if (!session.current) {
        setPhase("Starting voice…");
        const start = await api.post<{ sessionId: string }>("/api/call/start", {
          silent: true,
        });
        session.current = start.sessionId;
      }
      if (!alive.current || g !== generation.current) return;
      setPhase("Listening");
      setPartial("");
      const text = await dictate(language);
      if (!alive.current || g !== generation.current || !text.trim()) return;
      setLast(text);
      setPartial("");
      setPhase("Your PC agent is working…");
      job.current = crypto.randomUUID();
      await rememberJob({
        id: job.current,
        conversationId,
        serverId: api.profile?.serverId || "",
        label: "Voice request",
        created: Date.now(),
      });
      const result = await submitAndWatch({
        id: job.current,
        kind: "voice",
        text,
        sessionId: session.current,
      });
      if (!alive.current || g !== generation.current) return;
      const reply = result.result || {
        text: "No retained voice result. Inspect Tasks.",
      };
      onReply({ ...reply, jobId: result.id });
      setLast(reply.text || "");
      if (reply.awaitingConfirm) {
        auto.current = false;
        setContinuous(false);
        setPhase(
          "Approval needed. Automatic listening is paused. Review Tasks.",
        );
        return;
      }
      setPhase("Speaking · tap Interrupt to take your turn");
      await playback(reply);
      if (alive.current && g === generation.current)
        setPhase("Ready when you are.");
    } catch (e) {
      if (alive.current && g === generation.current) {
        setError(e instanceof Error ? e.message : "Voice unavailable");
        auto.current = false;
        setContinuous(false);
        setPhase("Paused. Review the request before repeating.");
      }
    } finally {
      working.current = false;
      if (alive.current) {
        setBusy(false);
        if (auto.current && g === generation.current && !document.hidden)
          setTimeout(() => void turn(), 300);
      }
    }
  }
  function interrupt() {
    generation.current++;
    auto.current = false;
    setContinuous(false);
    cancelSpeech();
    audio.current?.pause();
    if (session.current)
      void api
        .post("/api/call/interrupt", { sessionId: session.current })
        .catch(() => {});
    setPhase(
      "Playback/listening interrupted. PC work is not automatically repeated.",
    );
  }
  return (
    <Modal
      title="Say it your way."
      subtitle="Foreground voice uses the shared PC-agent context. No always-on microphone or automatic approvals."
      onClose={onClose}
    >
      <div className="voice-space">
        <div className={`voice-mark ${busy ? "working" : ""}`}>
          <Mark size={54} />
        </div>
        <h3 role="status">{phase}</h3>
        <p aria-live="polite">
          {partial || last || "English, Hindi, or a little of both."}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="voice-mic"
          disabled={busy}
          onClick={() => void turn()}
          aria-label="Push to talk"
        >
          {busy ? (
            <LoaderCircle className="spin" size={28} />
          ) : (
            <Mic size={28} />
          )}
        </button>
        <small>{busy ? "One real turn at a time" : "Tap to talk"}</small>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={continuous}
          onChange={(e) => {
            setContinuous(e.target.checked);
            auto.current = e.target.checked;
            if (e.target.checked && !busy) void turn();
          }}
        />
        Continuous foreground turns. Stops on background, error or an approval
        request.
      </label>
      <div className="button-row">
        <button className="button" onClick={interrupt}>
          <Volume2 size={16} />
          Interrupt
        </button>
        <button
          className="button"
          disabled={!job.current}
          onClick={() =>
            void api
              .post("/api/app/jobs/stop", { id: job.current })
              .catch((e) => setError(e.message))
          }
        >
          <Square size={14} />
          Stop PC request
        </button>
        <button className="button" onClick={onClose}>
          <PhoneOff size={16} />
          End session
        </button>
      </div>
      <p className="trust-note">
        <ShieldCheck size={14} />
        Partial captions are not commands. Only a completed turn is submitted;
        pending confirmations halt continuous listening. Speech provider/network
        and real hardware behavior need verification.
      </p>
    </Modal>
  );
}
