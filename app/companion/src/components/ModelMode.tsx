import { useState } from "react";
import {
  ArrowRight,
  Check,
  Cloud,
  Cpu,
  KeyRound,
  LoaderCircle,
  Monitor,
  ShieldCheck,
  Wand2,
} from "lucide-react";
import { configureCloud, clearCloud, type CloudStatus } from "../core/cloud";
import { isNative } from "../core/native";
import type { ChatMode } from "../types";
import { Modal } from "./ui";
export default function ModelMode({
  mode,
  cloud,
  onMode,
  onCloud,
  onClose,
  inspect,
}: {
  mode: ChatMode;
  cloud: CloudStatus;
  onMode: (mode: ChatMode) => void;
  onCloud: (c: CloudStatus) => void;
  onClose: () => void;
  inspect: () => void;
}) {
  const [provider, setProvider] = useState(cloud.provider || "groq"),
    [model, setModel] = useState(cloud.model || ""),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="The right kind of help."
      subtitle="Picking a mode by hand starts a new conversation; on Automatic every message chooses its own engine inside the same chat. PC chat history is never automatically sent to Direct AI. PC control needs your paired agent."
      onClose={onClose}
    >
      <div className="mode-choices">
        <button
          className={`mode-choice ${mode === "auto" ? "selected" : ""}`}
          onClick={() => {
            onMode("auto");
            onClose();
          }}
        >
          <Wand2 size={21} />
          <span>
            <strong>Automatic</strong>
            <small>
              Direct AI answers by default, so the phone works on its own. The
              moment a message mentions your PC or is a command, the PC agent
              takes over — same chat, nothing to switch.
            </small>
          </span>
          {mode === "auto" && <Check size={17} />}
        </button>
        <button
          className={`mode-choice ${mode === "agent" ? "selected" : ""}`}
          onClick={() => {
            onMode("agent");
            onClose();
          }}
        >
          <Monitor size={21} />
          <span>
            <strong>PC agent</strong>
            <small>
              All existing tools, files, local/cloud routing and approval gates.
            </small>
          </span>
          {mode === "agent" && <Check size={17} />}
        </button>
        <button
          disabled={!cloud.configured}
          className={`mode-choice ${mode === "cloud" ? "selected" : ""}`}
          onClick={() => {
            onMode("cloud");
            onClose();
          }}
        >
          <Cloud size={21} />
          <span>
            <strong>Direct AI</strong>
            <small>
              {cloud.configured
                ? `${cloud.provider} · ${cloud.model}`
                : "Works without the PC. Configure below in Android."}
            </small>
          </span>
          {mode === "cloud" && <Check size={17} />}
        </button>
      </div>
      <button className="text-button" onClick={inspect}>
        <Cpu size={15} />
        Inspect the PC agent’s model routing
        <ArrowRight size={14} />
      </button>
      <div className="cloud-config">
        <div className="section-label">OPTIONAL · YOUR OWN PROVIDER KEY</div>
        {!isNative() ? (
          <p className="info-note">
            Direct AI is Android-only: provider keys are encrypted in the device
            Keystore, never browser storage or the app bundle. The browser
            preview can use the PC bridge.
          </p>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const c = await configureCloud(
                  provider,
                  model.trim(),
                  key.trim(),
                );
                setKey("");
                onCloud(c);
                // Automatic is the default: the key now answers ordinary
                // messages, and PC talk still goes to the PC.
                onMode("auto");
                onClose();
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not save provider.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field-label" htmlFor="cloud-provider">
              Provider
            </label>
            <select
              id="cloud-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="groq">Groq</option>
              <option value="openrouter">OpenRouter</option>
              <option value="openai">OpenAI</option>
            </select>
            <label className="field-label" htmlFor="cloud-model">
              Model ID
            </label>
            <input
              id="cloud-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Exact model ID supported by your provider"
              autoComplete="off"
              maxLength={160}
              required
            />
            <label className="field-label" htmlFor="cloud-key">
              API key
            </label>
            <input
              id="cloud-key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Kept in Android Keystore-backed storage"
              maxLength={4096}
              required
            />
            <p className="info-note">
              <KeyRound size={16} />
              Your provider’s charges, limits and privacy policy apply. Direct
              mode is text chat, not PC tool access or a bundled offline model.
            </p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <ShieldCheck size={16} />
              )}
              Save securely & use Direct AI
            </button>
          </form>
        )}
        {cloud.configured && (
          <button
            className="text-button"
            onClick={async () => {
              await clearCloud();
              onCloud({ configured: false });
              onMode("agent");
            }}
          >
            Remove saved provider key
          </button>
        )}
      </div>
    </Modal>
  );
}
