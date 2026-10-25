export type Page = "chat" | "pc" | "tasks" | "files" | "settings" | "more";
export type Theme = "light" | "dark" | "system";
export interface Profile {
  deviceId?: string;
  serverId?: string;
  protocol?: number;
  baseUrl: string;
  name?: string;
  native?: boolean;
}
export interface Attachment {
  name: string;
  mime: string;
  base64: string;
  preview?: string;
  size: number;
}
export interface Media {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind?: "image" | "audio" | "document" | "video";
  url: string;
}
export interface Reply {
  jobId?: string;
  spoken?: string;
  ok?: boolean;
  text?: string;
  images?: string[];
  audio?: string;
  documentName?: string;
  documentPath?: string;
  media?: Media[];
  stopped?: boolean;
  awaitingConfirm?: boolean;
  /** Direct AI only: what the provider says this turn cost. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}
export type Delivery = "sending" | "sent" | "failed";
export interface Message extends Reply {
  jobId?: string;
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  private?: boolean;
  /** Only for the owner's own messages: did the PC actually take it? */
  delivery?: Delivery;
  /** Which engine answered this turn: the paired PC or Direct AI. */
  route?: Route;
}
export type Route = "agent" | "cloud";
export interface Conversation {
  projectId?: string; projectName?: string;
  mode: ChatMode;
  id: string;
  title: string;
  updated: number;
  messages: Message[];
}
/** "auto" routes every message on its own; the others pin the whole app. */
export type ChatMode = "agent" | "cloud" | "auto";
export interface Preferences {
  appLock?: boolean;
  betaUpdates?: boolean;
  /** Install PC-delivered signed interface bundles automatically (no APK). */
  autoAppUpdate?: boolean;
  theme: Theme;
  language: "en-IN" | "hi-IN";
  saveHistory: boolean;
  readAloud: boolean;
  lowData: boolean;
  screenPrivacy: boolean;
  /**
   * "auto" (default): every message is routed on its own — Direct AI answers
   * normally, and the paired PC takes over the moment the message is about the
   * machine or is a command. "agent"/"cloud" pin the whole app.
   */
  chatMode: ChatMode;
  /**
   * The owner's own engine corrections, newest last. In "auto" mode one of
   * these beats the classifier, so a sentence is never mis-routed twice.
   * Device-local only: never sent to the PC or to a provider.
   */
  routeFixes?: RouteFix[];
  /** Tokens spent on the owner's own Direct AI key, per day (YYYY-MM-DD). */
  usage?: Record<string, number>;
  /** Monthly Direct AI token budget; 0 disables the warning. */
  usageCap?: number;
}
/** One owner correction: "this sentence belongs on that engine". */
export interface RouteFix {
  text: string;
  route: Route;
  at: number;
}
export interface LocalState {
  conversations: Conversation[];
  activeId: string;
  preferences: Preferences;
}
export interface Approval {
  id: string;
  kind: string;
  text: string;
  expiresAt?: number;
}
export interface ActiveTask {
  id: number;
  label: string;
  detail: string;
  startedAt: number;
  elapsedMs: number;
}
export interface BatchEntry {
  index: number;
  command: string;
  status: string;
  ms: number;
  text?: string;
  completedAfterStop?: boolean;
}
export interface AppState {
  serverId?: string;
  capabilities?: {
    protocol: number;
    jobs: boolean;
    durableJobs?: boolean;
    deviceSessions?: boolean;
    push?: { configured: boolean };
    rtc?: boolean;
  };
  apiVersion: number;
  version: string;
  host: string;
  platform: string;
  pcControl: boolean;
  controlPinRequired: boolean;
  active: ActiveTask[];
  batch?: { entries: BatchEntry[]; halted?: string };
  pending: Approval[];
}
export interface Status {
  version: string;
  whatsapp: string;
  model: string;
  access?: { level?: string };
  stats?: { messagesIn?: number; messagesOut?: number };
  reminders?: number;
  notes?: number;
  openTodos?: number;
}
export interface LocalTask {
  id: string;
  text: string;
  started: number;
  ended?: number;
  state: "running" | "replied" | "unknown" | "stopped";
  reply?: string;
}
export interface FileEntry {
  name?: string;
  file?: string;
  path: string;
  size?: number;
  ts?: number;
  kind?: string;
}
export interface Files {
  downloads: FileEntry[];
  shared: FileEntry[];
}
export interface NativeEnvelope {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
export interface WireResponse {
  status: number;
  json?: unknown;
  base64?: string;
  mime?: string;
  headers?: Record<string, string>;
}
export interface PcState {
  session?: string;
  graphical?: boolean;
  locked?: boolean | null;
  lockBackend?: string | null;
  display?: string;
  battery?: { percent: number; charging: boolean } | null;
  diskFreeMb?: number | null;
  host?: string;
  pcControl?: boolean;
  controlPinRequired?: boolean;
  accessLevel?: string;
  busy?: boolean;
  activeJobs?: number;
  /** Real pixels of the last captured frame; the phone needs them for its
      pointer marker, because the native bridge only forwards the ETag header. */
  screen?: { width: number; height: number } | null;
  /** Does the last frame already contain the PC's own mouse pointer? */
  pointerInFrame?: boolean | null;
  /** Was the pointer painted into the frame by the PC (guaranteed visible)? */
  pointerBurned?: boolean | null;
  captureTool?: string | null;
  detail?: string;
}
export interface PcUpdateCheck {
  installed: string;
  available: boolean;
  version?: string;
  notes?: string;
  size?: number;
  fileCount?: number;
  minNative?: string;
  sha256?: string;
  reason?: string;
  shell?: string;
  previous?: string;
  pendingBoot?: boolean;
  rolledBackFrom?: string;
  lastError?: string;
}
export interface Release {
  tag_name: string;
  html_url: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}
declare global {
  interface Window {
    ObserverAndroid?: { postMessage: (json: string) => void };
    __OBSERVER_VERSION__?: string;
  }
}

export interface Job {
  id: string;
  kind: "chat" | "voice" | "workflow" | "solve" | "reference";
  projectId?: string;
  deviceId: string;
  label: string;
  state:
    "accepted" | "running" | "replied" | "unknown" | "cancelled" | "rejected";
  createdAt: number;
  finishedAt?: number;
  stopRequested?: boolean;
  result?: Reply;
}
/** One line of the PC's append-only audit trail (data/audit.jsonl). */
export interface AuditEntry {
  at: number;
  who?: string;
  cmd?: string;
  args?: string;
  event?: string;
  ok?: boolean;
}
export interface JobRef {
  id: string;
  conversationId: string;
  serverId: string;
  label: string;
  private?: boolean;
  created: number;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  privateChat: boolean;
  memories: string[];
}
export interface WorkflowStep {
  tool: "time" | "status" | "apps" | "open" | "note" | "todo" | "remind";
  value?: string;
}
export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  trigger: { type: "manual" | "daily"; time?: string };
  /** The PC's calendar day this routine last fired on (YYYY-MM-DD), if ever. */
  lastDay?: string | null;
  createdAt?: number;
}
export interface AgentEvent {
  epoch: string;
  id: number;
  type: string;
  text: string;
  ts: number;
  jobId?: string;
}
export interface PairedDevice {
  id: string;
  name: string;
  model?: string;
  createdAt: number;
  revokedAt?: number;
  pushRegistered?: boolean;
}
