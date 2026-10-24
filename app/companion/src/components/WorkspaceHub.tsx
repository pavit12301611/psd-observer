import { useEffect, useState } from "react";
import {
  Bell,
  FolderOpen,
  ListChecks,
  Laptop,
  ShieldCheck,
  Fingerprint,
  Radio,
  Wifi,
  Plus,
  ArrowRight,
  Download,
  Trash2,
  Play,
  QrCode,
  LoaderCircle,
} from "lucide-react";
import type {
  Project,
  Workflow,
  WorkflowStep,
  PairedDevice,
  AgentEvent,
  AppState,
} from "../types";
import { api } from "../core/api";
import { isNative, nativeCall } from "../core/native";
import { Modal } from "./ui";
const tools = [
  "time",
  "status",
  "apps",
  "open",
  "note",
  "todo",
  "remind",
] as const;
export default function WorkspaceHub({
  connected,
  state,
  onClose,
  selectProject,
  runWorkflow,
  recover,
  notice,
}: {
  connected: boolean;
  state: AppState | null;
  onClose: () => void;
  selectProject: (p: Project) => void;
  runWorkflow: (id: string, name: string) => void;
  recover: (id: string) => void;
  notice: (s: string) => void;
}) {
  const [tab, setTab] = useState("projects"),
    [projects, setProjects] = useState<Project[]>([]),
    [workflows, setWorkflows] = useState<Workflow[]>([]),
    [devices, setDevices] = useState<PairedDevice[]>([]),
    [events, setEvents] = useState<AgentEvent[]>([]),
    [busy, setBusy] = useState(false),
    [info, setInfo] = useState("");
  const [project, setProject] = useState<Partial<Project>>({
      name: "",
      description: "",
      privateChat: true,
      memories: [],
    }),
    [memory, setMemory] = useState("");
  const [workflow, setWorkflow] = useState<Partial<Workflow>>({
      name: "",
      steps: [{ tool: "time" }],
      trigger: { type: "manual" },
    }),
    [preview, setPreview] = useState("");
  const [lock, setLock] = useState(false),
    [qr, setQr] = useState(""),
    [origin, setOrigin] = useState(""),
    [mac, setMac] = useState(""),
    [broadcast, setBroadcast] = useState("255.255.255.255"),
    [fcm, setFcm] = useState({
      appId: "",
      projectId: "",
      senderId: "",
      apiKey: "",
    });
  async function refresh() {
    if (!connected) return;
    try {
      const [p, w, d, e] = await Promise.all([
        api.projects(),
        api.workflows(),
        api.get<{ devices: PairedDevice[] }>("/api/app/devices"),
        api.events(),
      ]);
      setProjects(p.projects);
      setWorkflows(w.workflows);
      setDevices(d.devices);
      setEvents(e.events.reverse());
    } catch (e) {
      notice(e instanceof Error ? e.message : "Workspace data unavailable");
    }
  }
  useEffect(() => {
    void refresh();
    if (isNative())
      void nativeCall<{ enabled: boolean }>("getLockState")
        .then((r) => setLock(r.enabled))
        .catch(() => {});
  }, [connected]);
  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setInfo("");
    try {
      const value = await fn();
      if (value && typeof value === "object" && "text" in value)
        setInfo(String((value as { text: string }).text));
      await refresh();
    } catch (e) {
      notice(e instanceof Error ? e.message : "Operation unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function exportText(name: string, text: string) {
    if (isNative()) await nativeCall("saveText", { name, text });
    else {
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }
  const tabs = [
    ["projects", "Projects", FolderOpen],
    ["automations", "Routines", ListChecks],
    ["devices", "Devices", Laptop],
    ["alerts", "Alerts", Bell],
    ["privacy", "Privacy", Fingerprint],
    ["connect", "Connection", Wifi],
    ["wake", "Wake PC", Radio],
  ] as const;
  return (
    <Modal
      title="A little more possible."
      subtitle="Useful tools, clear boundaries. Nothing runs just because you open a page."
      onClose={onClose}
      wide
    >
      <div className="hub-tabs">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {!connected && !["privacy", "wake"].includes(tab) ? (
        <div className="quiet-card">
          Connect a PC running agent 3.10.0+ to manage this feature. No
          synthetic device/task data is shown.
        </div>
      ) : (
        <>
          {tab === "projects" && (
            <>
              <p className="info-note">
                <ShieldCheck size={16} />
                Private project answers use only that project’s pinned memories
                and recent chat. Explicit slash commands still use owner-wide PC
                permissions; a project is not an OS sandbox.
              </p>
              <div className="hub-list">
                {projects.map((p) => (
                  <div className="hub-row" key={p.id}>
                    <button
                      onClick={() => {
                        selectProject(p);
                        onClose();
                      }}
                    >
                      <strong>{p.name}</strong>
                      <small>
                        {p.privateChat
                          ? "Private chat context"
                          : "Shared owner context"}{" "}
                        · {p.memories.length} memories
                      </small>
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setProject(p);
                        setMemory(p.memories.join("\n"));
                      }}
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
              <label className="field-label">
                Project name
                <input
                  aria-label="Project name"
                  value={project.name || ""}
                  maxLength={80}
                  onChange={(e) =>
                    setProject({ ...project, name: e.target.value })
                  }
                />
              </label>
              <label className="field-label">
                Description
                <input
                  aria-label="Project description"
                  value={project.description || ""}
                  onChange={(e) =>
                    setProject({ ...project, description: e.target.value })
                  }
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={project.privateChat !== false}
                  disabled={project.id === "personal00"}
                  onChange={(e) =>
                    setProject({ ...project, privateChat: e.target.checked })
                  }
                />
                Private answer context (PC actions remain explicit owner
                commands)
              </label>
              <label className="field-label">
                Selected project memories · one per line
                <textarea
                  aria-label="Project memories"
                  className="hub-textarea"
                  rows={4}
                  value={memory}
                  onChange={(e) => setMemory(e.target.value)}
                />
              </label>
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={busy || !project.name?.trim()}
                  onClick={() =>
                    void act(async () => {
                      const p = await api.post<Project>("/api/app/projects", {
                        ...project,
                        memories: memory.split("\n").filter(Boolean),
                      });
                      setProject({ name: "", privateChat: true, memories: [] });
                      setMemory("");
                      return p;
                    })
                  }
                >
                  <Plus size={16} />
                  Save project
                </button>
                <button
                  className="button"
                  disabled={!project.id}
                  onClick={() =>
                    void act(() =>
                      exportText(
                        "observer-project.json",
                        JSON.stringify(
                          { ...project, memories: memory.split("\n") },
                          null,
                          2,
                        ),
                      ),
                    )
                  }
                >
                  <Download size={16} />
                  Export
                </button>
                {project.id && project.id !== "personal00" && (
                  <button
                    className="button"
                    onClick={() =>
                      void act(() =>
                        api.post("/api/app/projects/delete", {
                          id: project.id,
                        }),
                      )
                    }
                  >
                    <Trash2 size={16} />
                    Delete
                  </button>
                )}
              </div>
            </>
          )}
          {tab === "automations" && (
            <>
              <p className="info-note">
                <ListChecks size={16} />
                Build from supported steps. Preview never executes. Shell,
                arbitrary slash commands, nested flows and automatic
                confirmations are forbidden.
              </p>
              {workflows.map((w) => (
                <div className="hub-row" key={w.id}>
                  <button onClick={() => setWorkflow(w)}>
                    <strong>{w.name}</strong>
                    <small>
                      {w.steps.length} steps ·{" "}
                      {w.trigger.type === "daily"
                        ? `Daily ${w.trigger.time} (PC timezone)`
                        : "Manual"}
                    </small>
                  </button>
                  <button
                    className="button compact"
                    disabled={busy}
                    onClick={() => {
                      runWorkflow(w.id, w.name);
                      onClose();
                    }}
                  >
                    <Play size={14} />
                    Run
                  </button>
                </div>
              ))}
              <label className="field-label">
                Routine name
                <input
                  aria-label="Routine name"
                  value={workflow.name || ""}
                  onChange={(e) =>
                    setWorkflow({ ...workflow, name: e.target.value })
                  }
                />
              </label>
              {workflow.steps?.map((s, i) => (
                <div className="flow-step" key={i}>
                  <span>{i + 1}</span>
                  <select
                    aria-label={`Step ${i + 1} tool`}
                    value={s.tool}
                    onChange={(e) =>
                      setWorkflow({
                        ...workflow,
                        steps: workflow.steps!.map((p, n) =>
                          n === i
                            ? { tool: e.target.value as WorkflowStep["tool"] }
                            : p,
                        ),
                      })
                    }
                  >
                    {tools.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    aria-label={`Step ${i + 1} value`}
                    placeholder={
                      ["time", "status", "apps"].includes(s.tool)
                        ? "No arguments"
                        : "Explicit value"
                    }
                    value={s.value || ""}
                    disabled={["time", "status", "apps"].includes(s.tool)}
                    onChange={(e) =>
                      setWorkflow({
                        ...workflow,
                        steps: workflow.steps!.map((p, n) =>
                          n === i ? { ...p, value: e.target.value } : p,
                        ),
                      })
                    }
                  />
                  <button
                    className="text-button"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() =>
                      setWorkflow({
                        ...workflow,
                        steps: workflow.steps!.filter((_, n) => n !== i),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="text-button"
                disabled={(workflow.steps?.length || 0) >= 8}
                onClick={() =>
                  setWorkflow({
                    ...workflow,
                    steps: [...(workflow.steps || []), { tool: "time" }],
                  })
                }
              >
                <Plus size={15} />
                Add step
              </button>
              <div className="button-row">
                <select
                  aria-label="Routine trigger"
                  value={workflow.trigger?.type || "manual"}
                  onChange={(e) =>
                    setWorkflow({
                      ...workflow,
                      trigger: {
                        type: e.target.value as "manual" | "daily",
                        time: "09:00",
                      },
                    })
                  }
                >
                  <option value="manual">Run manually</option>
                  <option value="daily">Daily at…</option>
                </select>
                {workflow.trigger?.type === "daily" && (
                  <input
                    aria-label="Daily routine time"
                    type="time"
                    value={workflow.trigger.time}
                    onChange={(e) =>
                      setWorkflow({
                        ...workflow,
                        trigger: { type: "daily", time: e.target.value },
                      })
                    }
                  />
                )}
              </div>
              <div className="button-row">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const r = await api.post(
                        "/api/app/workflows/preview",
                        workflow,
                      );
                      setPreview(JSON.stringify(r, null, 2));
                      return r;
                    })
                  }
                >
                  Preview only
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.post("/api/app/workflows", workflow))
                  }
                >
                  Save routine
                </button>
              </div>
              {preview && <pre className="hub-preview">{preview}</pre>}
              <p className="small-text muted">
                Scheduled runs skip when busy/awaiting approval;
                missed/restarted tasks are not caught up or replayed
                automatically.
              </p>
            </>
          )}
          {tab === "devices" && (
            <>
              <p className="info-note">
                Revoke a lost phone here or from the PC sharing dashboard.
                Legacy shared-root credentials cannot be individually revoked;
                re-pair old clients and rotate the old bridge token separately
                if compromised.
              </p>
              {devices.map((d) => (
                <div className="hub-row" key={d.id}>
                  <div>
                    <strong>{d.name}</strong>
                    <small>
                      {d.model} ·{" "}
                      {d.revokedAt
                        ? "Revoked"
                        : d.id === api.profile?.deviceId
                          ? "This device"
                          : "Paired"}{" "}
                      ·{" "}
                      {d.pushRegistered
                        ? "Push token registered"
                        : "No cloud push token"}
                    </small>
                  </div>
                  <button
                    className="button compact"
                    disabled={busy || !!d.revokedAt}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Revoke ${d.name}? It will need a new pairing.`,
                        )
                      )
                        void act(() =>
                          api.post("/api/app/devices/revoke", { id: d.id }),
                        );
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </>
          )}
          {tab === "alerts" && (
            <>
              <p className="info-note">
                <Bell size={16} />
                Private mode uses a persistent Android notification +
                server-sent events, not task polling. Samsung/Doze can pause it.
                Optional OS push needs your own cloud project on both PC and
                phone; no private text is sent through it.
              </p>
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={busy || !isNative()}
                  onClick={() => void act(() => nativeCall("startAlerts"))}
                >
                  Enable private alerts
                </button>
                <button
                  className="button"
                  disabled={busy || !isNative()}
                  onClick={() => void act(() => nativeCall("stopAlerts"))}
                >
                  Stop private link
                </button>
              </div>
              <p className="small-text muted">
                PC OS-push credentials:{" "}
                {state?.capabilities?.push?.configured
                  ? "configured"
                  : "not configured; live OS delivery is not active"}
                . Configure APP_FCM_CREDENTIALS privately on the PC. Never
                upload service-account keys to the app or chat.
              </p>
              <details className="hub-details">
                <summary>Optional phone push registration</summary>
                {Object.entries(fcm).map(([key, value]) => (
                  <label className="field-label" key={key}>
                    {key}
                    <input
                      aria-label={`Push ${key}`}
                      value={value}
                      autoComplete="off"
                      onChange={(e) =>
                        setFcm({ ...fcm, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <button
                  className="button"
                  disabled={busy || !isNative()}
                  onClick={() =>
                    void act(() => nativeCall("configurePush", fcm))
                  }
                >
                  Register this phone
                </button>
              </details>
              <div className="section-label">RECENT AGENT EVENTS</div>
              {events.slice(0, 30).map((e) => (
                <div className="hub-row" key={e.epoch + e.id}>
                  <div>
                    <strong>{e.type.replaceAll("_", " ")}</strong>
                    <small>{e.text}</small>
                  </div>
                  {e.jobId && (
                    <button
                      className="text-button"
                      onClick={() => {
                        recover(e.jobId!);
                        onClose();
                      }}
                    >
                      View result
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {tab === "privacy" && (
            <>
              <p className="info-note">
                <Fingerprint size={16} />
                Native biometric/device-credential gate protects foreground app
                access. Background alerts use generic content. This is not a
                rooted-device defense or a guarantee of hardware-backed keys.
              </p>
              <button
                className="button primary"
                disabled={busy || !isNative()}
                onClick={() =>
                  void act(async () => {
                    await nativeCall("setAppLock", { enabled: !lock });
                    setLock(!lock);
                    return {
                      text: !lock ? "App lock enabled." : "App lock disabled.",
                    };
                  })
                }
              >
                {lock ? "Disable" : "Enable"} fingerprint/device lock
              </button>
              <button
                className="text-button"
                disabled={!isNative()}
                onClick={() => void nativeCall("appSettings")}
              >
                Open Android app settings
                <ArrowRight size={15} />
              </button>
              <p className="small-text muted">
                Your phone credential is handled by Android; Observer never
                receives it. Existing PC owner/PIN/confirmation policy is not
                weakened.
              </p>
            </>
          )}
          {tab === "connect" && (
            <>
              <p className="info-note">
                For first-pairing diagnostics, open Connect PC. The following
                reads authenticated PC configuration and changes nothing.
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const d = await api.get("/api/app/diagnostics");
                    setInfo(JSON.stringify(d, null, 2));
                    return d;
                  })
                }
              >
                Inspect PC connection
              </button>
              <div className="button-row">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.post("/api/app/discovery", { enabled: true }),
                    )
                  }
                >
                  Advertise on trusted LAN
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.post("/api/app/discovery", { enabled: false }),
                    )
                  }
                >
                  Stop advertisement
                </button>
              </div>
              <label className="field-label">
                Phone-reachable PC origin
                <input
                  aria-label="QR PC origin"
                  value={origin}
                  placeholder="http://192.168.1.12:8787"
                  onChange={(e) => setOrigin(e.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={busy || !origin.trim()}
                onClick={() =>
                  void act(async () => {
                    const r = await api.post<{ qr: string }>(
                      "/api/app/pair-code",
                      { origin },
                    );
                    setQr(r.qr);
                    return r;
                  })
                }
              >
                <QrCode size={16} />
                Create one-use pairing QR
              </button>
              {qr && (
                <img
                  className="pairing-qr"
                  src={qr}
                  alt="Expiring one-time device pairing QR"
                />
              )}
              <p className="small-text muted">
                No bridge token is in this QR. The code expires in two minutes.
                To pair the first phone, generate the QR from the PC at
                localhost:8787/desktop.
              </p>
            </>
          )}
          {tab === "wake" && (
            <>
              <p className="info-note">
                <Radio size={16} />
                Wake-on-LAN requires compatible PC NIC/BIOS/power settings and
                the same local Wi-Fi broadcast domain. VPN broadcasts and waking
                every powered-off PC are not guaranteed.
              </p>
              <label className="field-label">
                PC network-card MAC
                <input
                  aria-label="PC wake MAC"
                  value={mac}
                  placeholder="AA:BB:CC:DD:EE:FF"
                  onChange={(e) => setMac(e.target.value)}
                />
              </label>
              <label className="field-label">
                Local broadcast
                <input
                  aria-label="Wake broadcast"
                  value={broadcast}
                  onChange={(e) => setBroadcast(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !isNative()}
                onClick={() =>
                  void act(() => nativeCall("wake", { mac, broadcast }))
                }
              >
                Send one wake packet
              </button>
              <p className="small-text muted">
                A sent packet is not proof that the PC woke. Reconnect
                explicitly after boot. Public IP targets are blocked.
              </p>
            </>
          )}
        </>
      )}
      {busy && (
        <p className="info-note" role="status">
          <LoaderCircle size={16} className="spin" />
          Working on the explicit request…
        </p>
      )}
      {info && (
        <pre className="hub-preview" role="status">
          {info}
        </pre>
      )}
    </Modal>
  );
}
