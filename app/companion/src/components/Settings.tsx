import { version as appVersion } from "../../package.json";
import { useEffect, useState } from "react";
import {
  Moon,
  Sun,
  Laptop,
  ShieldCheck,
  Database,
  Volume2,
  Languages,
  Battery,
  Monitor,
  Download,
  ArrowUpRight,
  Link2,
  LogOut,
  Cpu,
  CircleHelp,
  EyeOff,
  Fingerprint,
  Gauge,
  LoaderCircle,
  Zap,
  Check,
  ExternalLink,
} from "lucide-react";
import type {
  Preferences,
  Profile,
  Status,
  AppState,
  Release,
  PcUpdateCheck,
} from "../types";
import {
  checkUpdates,
  openRelease,
  checkPcUpdate,
  applyPcUpdate,
  pcUpdateStatus,
  rollbackPcUpdate,
} from "../core/api";
import { isNative, nativeCall, openExternal } from "../core/native";
import { Modal, SectionHeading, SettingRow } from "./ui";
/** The only commands the tile and widget can run. Read-only reports. */
const QUICK_ACTIONS = [
  "/status",
  "/usage",
  "/todo",
  "/apps",
  "/pending",
  "/audit",
  "/routine",
];
export default function Settings({
  onTools,
  preferences: p,
  update,
  profile,
  status,
  state,
  onConnect,
  onDisconnect,
  clearHistory,
  draft,
  commands,
}: {
  onTools: () => void;
  preferences: Preferences;
  update: (patch: Partial<Preferences>) => void;
  profile: Profile | null;
  status: Status | null;
  state: AppState | null;
  onConnect: () => void;
  onDisconnect: () => void;
  clearHistory: () => void;
  draft: (s: string) => void;
  commands: () => void;
}) {
  // Direct AI spends the owner's own key, so the count is theirs to see.
  const usage = p.usage || {},
    dayKey = () =>
      new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    todayTokens = usage[dayKey()] || 0,
    thisMonth = dayKey().slice(0, 7),
    monthTokens = Object.entries(usage)
      .filter(([day]) => day.startsWith(thisMonth))
      .reduce((sum, [, n]) => sum + n, 0),
    answerDays = Object.keys(usage).length,
    cap = p.usageCap || 0,
    budgetWarning =
      cap && monthTokens >= cap
        ? `This month’s Direct AI budget is used up (${monthTokens.toLocaleString("en-IN")} / ${cap.toLocaleString("en-IN")} tokens). PC answers still work.`
        : cap && monthTokens >= cap * 0.8
          ? `Direct AI is at ${Math.round((monthTokens / cap) * 100)}% of this month’s budget (${monthTokens.toLocaleString("en-IN")} / ${cap.toLocaleString("en-IN")} tokens).`
          : "";
  // The lock is a device credential gate, not a preference: the phone owns the
  // truth, so the row reads it from Android instead of a saved boolean.
  const [lockOn, setLockOn] = useState(false),
    [lockBusy, setLockBusy] = useState(false),
    [lockNote, setLockNote] = useState("");
  useEffect(() => {
    if (!isNative()) return;
    let alive = true;
    void nativeCall<{ enabled: boolean }>("getLockState")
      .then((r) => {
        if (alive) setLockOn(Boolean(r?.enabled));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  async function setLock(next: boolean) {
    setLockBusy(true);
    setLockNote("");
    try {
      await nativeCall("setAppLock", { enabled: next });
      setLockOn(next);
      setLockNote(
        next
          ? "App lock is on. Observer will ask for your fingerprint or PIN each time it opens."
          : "App lock is off.",
      );
    } catch (e) {
      setLockNote(
        e instanceof Error
          ? e.message
          : "Could not change the app lock. Android asks for confirmation when you turn it on.",
      );
    } finally {
      setLockBusy(false);
    }
  }
  // The tile/widget quick action: one read-only command, chosen here.
  const [quickAction, setQuickAction] = useState("/status"),
    [quickNote, setQuickNote] = useState("");
  useEffect(() => {
    if (!isNative()) return;
    let alive = true;
    void nativeCall<{ command: string }>("getQuickAction")
      .then((r) => {
        if (alive && r?.command) setQuickAction(r.command);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const [confirm, setConfirm] = useState<"disconnect" | "history" | null>(null),
    [checking, setChecking] = useState(false),
    [release, setRelease] = useState<Release | null>(null),
    [updateMessage, setUpdateMessage] = useState("");
  const [pc, setPc] = useState<PcUpdateCheck | null>(null),
    [pcBusy, setPcBusy] = useState(false),
    [pcMessage, setPcMessage] = useState(""),
    [pcReady, setPcReady] = useState(false);
  useEffect(() => {
    if (!isNative()) return;
    let alive = true;
    void pcUpdateStatus()
      .then((status) => {
        if (alive && status) setPc(status);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const checkPc = async () => {
    setPcBusy(true);
    setPcReady(false);
    setPcMessage("");
    try {
      const result = await checkPcUpdate();
      if (!result) return;
      setPc(result);
      setPcMessage(
        result.available
          ? `Interface ${result.version} is ready. It is signed by your PC and needs no reinstall.`
          : result.reason || "Your PC has no newer signed interface.",
      );
    } catch (e) {
      setPcMessage(
        e instanceof Error ? e.message : "PC update check unavailable",
      );
    } finally {
      setPcBusy(false);
    }
  };
  const installPc = async () => {
    setPcBusy(true);
    try {
      const applied = await applyPcUpdate();
      setPc(applied);
      setPcReady(true);
      setPcMessage(
        `Interface ${applied?.installed || "update"} installed. Reload Observer to use it. If it cannot start, the previous version returns automatically.`,
      );
    } catch (e) {
      setPcMessage(e instanceof Error ? e.message : "PC update failed");
    } finally {
      setPcBusy(false);
    }
  };
  const undoPc = async () => {
    setPcBusy(true);
    try {
      const restored = await rollbackPcUpdate();
      setPc(restored);
      setPcReady(true);
      setPcMessage(
        "Previous interface restored. Reload Observer to use it.",
      );
    } catch (e) {
      setPcMessage(e instanceof Error ? e.message : "Rollback unavailable");
    } finally {
      setPcBusy(false);
    }
  };
  const [device, setDevice] = useState<{
    model: string;
    version: string;
    debug: boolean;
  } | null>(null);
  useEffect(() => {
    if (isNative())
      void nativeCall<{ model: string; version: string; debug: boolean }>(
        "deviceInfo",
      )
        .then(setDevice)
        .catch(() => {});
  }, []);
  const toggle = (
    key: "saveHistory" | "readAloud" | "lowData" | "screenPrivacy",
    label: string,
  ) => (
    <label className="toggle">
      <input
        type="checkbox"
        aria-label={label}
        checked={p[key]}
        onChange={(e) => update({ [key]: e.target.checked })}
      />
      <span />
    </label>
  );
  return (
    <div className="page-content settings-page">
      <SectionHeading eyebrow="MAKE YOURSELF AT HOME" title="On your terms.">
        A few thoughtful choices. No unnecessary noise.
      </SectionHeading>
      <div className="settings-group">
        <div className="section-label">YOUR CONNECTION</div>
        <div className="connection-card">
          <span className="connection-glyph">
            <Monitor size={24} strokeWidth={1.5} />
          </span>
          <div>
            <strong>
              {profile ? state?.host || "Your PC" : "No PC connected"}
            </strong>
            <span>
              {profile
                ? `${profile.baseUrl}${status?.version ? ` · agent ${status.version}` : ""}`
                : "Connect once. Keep your tools close."}
            </span>
          </div>
          <button
            className="button compact"
            onClick={profile ? () => setConfirm("disconnect") : onConnect}
          >
            {profile ? "Disconnect" : "Connect"}
            <Link2 size={15} />
          </button>
        </div>
      </div>
      <div className="settings-group">
        <div className="section-label">LOOK & FEEL</div>
        <SettingRow
          icon={<Sun size={20} />}
          title="Appearance"
          description="Quiet whites. True blacks. Never a gradient."
        >
          <div className="segmented theme-options">
            {[
              ["light", Sun, "Light"],
              ["dark", Moon, "Dark"],
              ["system", Laptop, "System"],
            ].map(([theme, Icon, label]) => {
              const I = Icon as typeof Sun;
              return (
                <button
                  key={String(theme)}
                  aria-label={`${label} theme`}
                  aria-pressed={p.theme === theme}
                  className={p.theme === theme ? "selected" : ""}
                  onClick={() =>
                    update({ theme: theme as Preferences["theme"] })
                  }
                >
                  <I size={16} />
                  <span>{String(label)}</span>
                </button>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow
          icon={<Languages size={20} />}
          title="Voice language"
          description="Choose your phone’s recognition language."
        >
          <select
            aria-label="Voice language"
            value={p.language}
            onChange={(e) =>
              update({ language: e.target.value as Preferences["language"] })
            }
          >
            <option value="en-IN">English · India</option>
            <option value="hi-IN">हिन्दी · India</option>
          </select>
        </SettingRow>
        <SettingRow
          icon={<Volume2 size={20} />}
          title="Read replies aloud"
          description="Use your phone’s TTS when a reply arrives."
        >
          {toggle("readAloud", "Read replies aloud")}
        </SettingRow>
      </div>
      <div className="settings-group">
        <div className="section-label">LIGHTER ON YOUR PHONE</div>
        <SettingRow
          icon={<Battery size={20} />}
          title="Battery & data saver"
          description="960px PC previews, slower refresh. No background capture."
        >
          {toggle("lowData", "Battery and data saver")}
        </SettingRow>
        <div className="device-note">
          <Check size={15} />
          Designed for Galaxy A53 5G layouts. No bundled large model, heavy
          blur, or always-on animation. Real-device performance still needs
          verification.
        </div>
      </div>
      <div className="settings-group">
        <div className="section-label">PRIVACY & MEMORY</div>
        <SettingRow
          icon={<Database size={20} />}
          title="Keep conversation history"
          description={
            isNative()
              ? "Encrypted on this device using Android Keystore. Media isn’t retained in history."
              : "Stored locally in this browser, not encrypted. Android uses Keystore-backed encryption."
          }
        >
          {toggle("saveHistory", "Keep conversation history")}
        </SettingRow>
        {isNative() && (
          <SettingRow
            icon={<EyeOff size={20} />}
            title="Screen privacy"
            description="Block screenshots and app-switcher previews."
          >
            {toggle("screenPrivacy", "Screen privacy")}
          </SettingRow>
        )}
        {/* The lock itself is native (Keystore + device credential); this only
            asks for the change, and Android asks the owner to confirm. */}
        {isNative() && (
          <>
            <SettingRow
              icon={<Fingerprint size={20} />}
              title="Fingerprint / device lock"
              description="Ask for your fingerprint or PIN before Observer opens."
            >
              <button
                className="setting-toggle"
                disabled={lockBusy}
                aria-pressed={lockOn}
                onClick={() => void setLock(!lockOn)}
              >
                {lockBusy ? "Confirm on your phone…" : lockOn ? "On" : "Off"}
              </button>
            </SettingRow>
            {lockNote && (
              <div className="update-note" role="status">
                <p>{lockNote}</p>
              </div>
            )}
          </>
        )}
        <button
          className="setting-button"
          onClick={() => setConfirm("history")}
        >
          <SettingRow
            icon={<LogOut size={20} />}
            title="Clear local conversations"
            description="Only this device. Does not erase PC or provider history."
          />
        </button>
        <button className="setting-button" onClick={() => draft("/memory")}>
          <SettingRow
            icon={<ShieldCheck size={20} />}
            title="What your agent remembers"
            description="Review the PC agent’s memory in chat."
          />
        </button>
      </div>
      <div className="settings-group">
        <div className="section-label">DIRECT AI</div>
        {/* The key is the owner's, so the count is shown, not hidden. */}
        <div className="usage-panel">
          <div>
            <span className="usage-figure">
              {todayTokens.toLocaleString("en-IN")}
            </span>
            <small>tokens today</small>
          </div>
          <div>
            <span className="usage-figure">
              {monthTokens.toLocaleString("en-IN")}
            </span>
            <small>tokens this month</small>
          </div>
          <div>
            <span className="usage-figure">{answerDays}</span>
            <small>days used</small>
          </div>
        </div>
        <SettingRow
          icon={<Gauge size={20} />}
          title="Monthly budget"
          description="Warn at 80%. PC answers are unaffected either way."
        >
          <input
            type="number"
            min={0}
            step={50000}
            aria-label="Monthly Direct AI budget in tokens"
            className="number-input"
            value={p.usageCap ?? 0}
            onChange={(e) =>
              update({ usageCap: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </SettingRow>
        <small className="hint">
          Counted on this device only — your provider’s own bill is the real
          one. Set 0 to switch the warning off.
        </small>
        {budgetWarning && (
          <div className="update-note" role="status">
            <p>{budgetWarning}</p>
          </div>
        )}
      </div>
      <div className="settings-group">
        <div className="section-label">QUICK ACTION</div>
        <SettingRow
          icon={<Zap size={20} />}
          title="Tile and widget button"
          description="One read-only command, run without opening the app. The answer arrives as a notification."
        >
          <select
            aria-label="Quick action command"
            value={quickAction}
            onChange={(e) => {
              const command = e.target.value;
              setQuickAction(command);
              if (!isNative()) return;
              void nativeCall<{ command: string }>("setQuickAction", { command })
                .then((r) => r && setQuickNote(`Quick action set to ${r.command}.`))
                .catch((e) =>
                  setQuickNote(
                    e instanceof Error
                      ? e.message
                      : "Could not save the quick action.",
                  ),
                );
            }}
          >
            {QUICK_ACTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </SettingRow>
        {quickNote && (
          <div className="update-note" role="status">
            <p>{quickNote}</p>
          </div>
        )}
      </div>
      <div className="settings-group">
        <div className="section-label">WORKSPACE & DEVICE TOOLS</div>
        <button className="setting-button" onClick={onTools}>
          <SettingRow
            icon={<ShieldCheck size={20} />}
            title="Projects, routines, alerts & device security"
            description="Connection Doctor, one-time QR, fingerprint lock, revocation and Wake-on-LAN."
          />
        </button>
      </div>
      <div className="settings-group">
        <div className="section-label">YOUR AGENT</div>
        <button className="setting-button" onClick={() => draft("/brains")}>
          <SettingRow
            icon={<Cpu size={20} />}
            title="Models & routing"
            description={
              status?.model
                ? `Configured PC model: ${status.model}`
                : "Local and cloud models are managed by your PC agent."
            }
          />
        </button>
        <button className="setting-button" onClick={commands}>
          <SettingRow
            icon={<CircleHelp size={20} />}
            title="Explore all capabilities"
            description="Your existing WhatsApp commands, in one searchable place."
          />
        </button>
        {isNative() && profile && (
          <>
            <SettingRow
              icon={<Laptop size={20} />}
              title="PC interface updates"
              description="Signed on your PC and installed in place. The APK is never replaced; native changes still need one install."
            >
              <button
                className="button compact"
                disabled={pcBusy}
                onClick={() => void checkPc()}
              >
                {pcBusy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <ArrowUpRight size={16} />
                )}
                Check
              </button>
            </SettingRow>
            {pcMessage && (
              <div className="update-note" role="status">
                <p>{pcMessage}</p>
                <div className="update-actions">
                  {pc?.available && (
                    <button
                      className="text-button"
                      disabled={pcBusy}
                      onClick={() => void installPc()}
                    >
                      Install {pc.version}
                      <Download size={15} />
                    </button>
                  )}
                  {pcReady && (
                    <button
                      className="text-button"
                      onClick={() => window.location.reload()}
                    >
                      Reload Observer
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                  {pc?.installed && (
                    <button
                      className="text-button"
                      disabled={pcBusy}
                      onClick={() => void undoPc()}
                    >
                      Undo last update
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        <SettingRow
          icon={<Download size={20} />}
          title="App updates"
          description="Official android-v releases only. Installation always needs your approval."
        >
          <button
            className="button compact"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setUpdateMessage("");
              try {
                const result = await checkUpdates(Boolean(p.betaUpdates));
                setRelease(result);
                setUpdateMessage(
                  result
                    ? `${result.tag_name} is available. Read the release notes before installing.`
                    : "No newer published Android APK found.",
                );
              } catch (e) {
                setUpdateMessage(
                  e instanceof Error ? e.message : "Update check unavailable",
                );
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ArrowUpRight size={16} />
            )}
            Check
          </button>
        </SettingRow>
        {updateMessage && (
          <div className="update-note" role="status">
            <p>{updateMessage}</p>
            {release && (
              <button
                className="text-button"
                onClick={() => openRelease(release)}
              >
                View official release
                <ExternalLink size={15} />
              </button>
            )}
          </div>
        )}
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={Boolean(p.betaUpdates)}
          onChange={(e) => update({ betaUpdates: e.target.checked })}
        />
        Include official beta releases in update checks. Installation still
        needs your approval.
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={Boolean(p.autoAppUpdate ?? true)}
          onChange={(e) => update({ autoAppUpdate: e.target.checked })}
        />
        Install interface updates from my PC automatically. Your PC signs a web
        bundle, this phone verifies it, installs it and reloads — no APK, no
        uninstall. A version that fails to start is rolled back on its own.
        <small>
          Runs on app start and every 30 minutes, never while a request,
          dictation or voice turn is in flight. Turn off to install by hand
          above.
        </small>
      </label>
      <footer className="settings-footer">
        <span>observer</span>
        <p>
          Android companion · {device?.version || appVersion}
          {isNative() ? "" : " · browser preview"}
        </p>
        <small>One agent. Your permissions. You stay in control.</small>
        {device?.debug && (
          <p className="preview-notice">
            Preview build · debug-signed. Not a production release; update
            compatibility is not guaranteed.
          </p>
        )}
        <button
          className="text-button"
          onClick={() =>
            openExternal("https://github.com/pavit12301611/psd-observer")
          }
        >
          Source & AGPL-3.0 license
          <ArrowUpRight size={14} />
        </button>
      </footer>
      {confirm && (
        <Modal
          title={
            confirm === "disconnect"
              ? "Leave this connection?"
              : "A fresh page?"
          }
          subtitle={
            confirm === "disconnect"
              ? "Disconnecting removes the saved PC credential, local conversations, and in-memory screen/voice state. It does not stop work already running on the PC."
              : "This clears conversations on this device only. It does not delete data from your PC or any AI provider."
          }
          onClose={() => setConfirm(null)}
        >
          <div className="button-row">
            <button className="button" onClick={() => setConfirm(null)}>
              Keep it
            </button>
            <button
              className="button primary"
              onClick={() => {
                if (confirm === "disconnect") onDisconnect();
                else clearHistory();
                setConfirm(null);
              }}
            >
              {confirm === "disconnect"
                ? "Disconnect & clear"
                : "Clear conversations"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
