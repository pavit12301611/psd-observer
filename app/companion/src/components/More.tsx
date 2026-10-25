import {
  FolderOpen,
  ListChecks,
  Laptop,
  Bell,
  Fingerprint,
  Wifi,
  Radio,
  Settings as SettingsIcon,
  ArrowRight,
  Monitor,
  Moon,
  Sun,
  Download,
  ShieldCheck,
  ChevronRight,
} from "lucide-react";
import type { AppState } from "../types";
import { SectionHeading } from "./ui";

/**
 * "More" replaces a seven-tab modal with one list.
 *
 * Every row states its current value on the right (`Alerts · on`,
 * `Connection · 192.168.1.12`), so most questions are answered without opening
 * anything. One tap goes straight to the place, which is two taps fewer than the
 * old hub for every destination except the first one.
 */
export type MoreTarget =
  | "files"
  | "settings"
  | "projects"
  | "automations"
  | "devices"
  | "alerts"
  | "privacy"
  | "connect"
  | "wake";

export default function More({
  connected,
  state,
  host,
  version,
  deviceCount,
  alertCount,
  onOpenPage,
  onOpenHub,
  onToggleTheme,
  dark,
  onConnect,
}: {
  connected: boolean;
  state: AppState | null;
  host: string;
  version: string;
  deviceCount: number | null;
  alertCount: number;
  onOpenPage: (page: "files" | "settings") => void;
  onOpenHub: (target: MoreTarget) => void;
  onToggleTheme: () => void;
  dark: boolean;
  onConnect: () => void;
}) {
  const row = (
    key: string,
    icon: React.ReactNode,
    title: string,
    value: string,
    onClick: () => void,
    hint?: string,
  ) => (
    <button className="more-row" key={key} onClick={onClick}>
      <span className="setting-icon">{icon}</span>
      <span className="more-copy">
        <strong>{title}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <span className="more-value">{value}</span>
      <ChevronRight size={16} className="muted" aria-hidden />
    </button>
  );

  return (
    <div className="page-content more-page">
      <SectionHeading
        eyebrow="EVERYTHING ELSE"
        title="More"
        action={
          <span className={`small-pill ${connected ? "" : "warn"}`}>
            {connected ? host || "PC connected" : "Not connected"}
          </span>
        }
      >
        The whole app in one list — each row shows its own state, so most answers
        are one glance away.
      </SectionHeading>

      {!connected && (
        <button className="more-row primary-row" onClick={onConnect}>
          <span className="setting-icon">
            <Monitor size={19} />
          </span>
          <span className="more-copy">
            <strong>Connect a PC</strong>
            <small>Scan a pairing QR or enter the dashboard PIN.</small>
          </span>
          <ArrowRight size={17} />
        </button>
      )}

      <div className="more-group">
        <h2 className="more-group-title">Your things</h2>
        {row(
          "files",
          <FolderOpen size={19} />,
          "Files",
          "Open",
          () => onOpenPage("files"),
          "Anything your PC saved for you.",
        )}
        {row(
          "projects",
          <Laptop size={19} />,
          "Projects",
          "Manage",
          () => onOpenHub("projects"),
          "Private context for a piece of work.",
        )}
        {row(
          "routines",
          <ListChecks size={19} />,
          "Routines",
          "Manage",
          () => onOpenHub("automations"),
          "Reviewed steps your PC runs on request or on a schedule.",
        )}
      </div>

      <div className="more-group">
        <h2 className="more-group-title">Your PC</h2>
        {row(
          "connect",
          <Wifi size={19} />,
          "Connection",
          connected ? host || "Connected" : "Not connected",
          () => onOpenHub("connect"),
          "Pairing QR, LAN discovery, diagnostics.",
        )}
        {row(
          "devices",
          <ShieldCheck size={19} />,
          "Devices",
          deviceCount === null ? "…" : `${deviceCount}`,
          () => onOpenHub("devices"),
          "Revoke anything you no longer use.",
        )}
        {row(
          "alerts",
          <Bell size={19} />,
          "Alerts",
          alertsLabel(state, alertCount),
          () => onOpenHub("alerts"),
          "What the PC may tell you, and where it lands.",
        )}
        {row(
          "wake",
          <Radio size={19} />,
          "Wake PC",
          "Wi-Fi",
          () => onOpenHub("wake"),
          "Only works on the same network, with the right hardware.",
        )}
      </div>

      <div className="more-group">
        <h2 className="more-group-title">App</h2>
        <button className="more-row" onClick={onToggleTheme}>
          <span className="setting-icon">
            {dark ? <Sun size={19} /> : <Moon size={19} />}
          </span>
          <span className="more-copy">
            <strong>Appearance</strong>
            <small>Solid surfaces, no gradients anywhere.</small>
          </span>
          <span className="more-value">{dark ? "Dark" : "Light"}</span>
          <ChevronRight size={16} className="muted" aria-hidden />
        </button>
        {row(
          "privacy",
          <Fingerprint size={19} />,
          "Privacy",
          "Review",
          () => onOpenHub("privacy"),
          "Lock, history, what leaves the phone.",
        )}
        {row(
          "settings",
          <SettingsIcon size={19} />,
          "Settings",
          version ? `v${version}` : "",
          () => onOpenPage("settings"),
          "Language, updates, PC interface updates.",
        )}
        {row(
          "updates",
          <Download size={19} />,
          "Updates",
          "Check",
          () => onOpenPage("settings"),
          "Interface updates arrive from your PC, signed.",
        )}
      </div>

      <p className="more-foot">
        <ShieldCheck size={13} />
        Nothing runs because you opened a page. Every action asks first, and the
        PC keeps its own PIN and access rules.
      </p>
    </div>
  );
}

function alertsLabel(state: AppState | null, count: number) {
  if (!state) return "…";
  if (count > 0) return `${count} waiting`;
  return state.pending.length ? `${state.pending.length} to review` : "On";
}
