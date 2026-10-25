import { version as appVersion } from "../package.json";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Command,
  Copy,
  FileText,
  FolderOpen,
  Gauge,
  History as HistoryIcon,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Menu,
  MessageCircle,
  Mic,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Menu as MoreIcon,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import {
  cancelCloud,
  cloudChat,
  cloudStatus,
  type CloudStatus,
} from "./core/cloud";
import {
  clearPendingJobs,
  rememberJob,
  forgetJob,
  pendingJobs,
  submitAndWatch,
  PendingJob,
} from "./core/jobs";
import {
  api,
  ApiError,
  SessionChanged,
  markUpdateHealthy,
  applyPcUpdate,
  checkPcUpdate,
} from "./core/api";
import { cancelSpeech, dictate, speak } from "./core/speech";
import { attachment, displayRequest } from "./core/validation";
import {
  emptyState,
  loadState,
  newConversation,
  saveState,
} from "./core/storage";
import { pickRoute, cloudContext, compactContext, learnFix } from "./core/route";
import { isNative, nativeCall } from "./core/native";
import type {
  Delivery,
  Project,
  AppState,
  Attachment,
  LocalState,
  LocalTask,
  Message,
  Page,
  Preferences,
  Profile,
  Reply,
  Route,
  Status,
} from "./types";
import { IconButton, Mark, Modal } from "./components/ui";
import catalog from "./data/commands.json";
const AuthenticatedMedia = lazy(
  () => import("./components/AuthenticatedMedia"),
);
const Markdown = lazy(() => import("./components/Markdown"));
const Pairing = lazy(() => import("./components/Pairing"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));
const History = lazy(() => import("./components/History"));
const PCControl = lazy(() => import("./components/PCControl"));
const Tasks = lazy(() => import("./components/Tasks"));
const Files = lazy(() => import("./components/Files"));
const More = lazy(() => import("./components/More"));
const AttachmentEditor = lazy(() => import("./components/AttachmentEditor"));
const WorkspaceHub = lazy(() => import("./components/WorkspaceHub"));
const Settings = lazy(() => import("./components/Settings"));
const Voice = lazy(() => import("./components/Voice"));
const ModelMode = lazy(() => import("./components/ModelMode"));
// Phones get four big destinations; everything else lives behind More, which
// lists each destination with its current state instead of a seven-tab modal.
const mobilePages = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "pc", label: "PC control", icon: Monitor },
  { id: "more", label: "More", icon: MoreIcon },
] as const;
const deskPages = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "pc", label: "PC control", icon: Monitor },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "more", label: "More", icon: MoreIcon },
] as const;
const suggestions = [
  {
    icon: Lightbulb,
    title: "Think it through",
    text: "Untangle an idea, big or small",
    prompt: "Help me think through an idea: ",
  },
  {
    icon: FileText,
    title: "Make something",
    text: "Find the words. Start creating.",
    prompt: "Help me write ",
  },
  {
    icon: BookOpen,
    title: "Learn a little more",
    text: "Make the complicated feel simple",
    prompt: "Explain this in a simple way: ",
  },
  {
    icon: Monitor,
    title: "Put your PC to work",
    text: "Your tools, a little closer",
    page: "pc" as Page,
  },
];
export default function App() {
  const [state, setState] = useState<LocalState>(emptyState),
    [loaded, setLoaded] = useState(false),
    [page, setPage] = useState<Page>("chat");
  const [profile, setProfile] = useState<Profile | null>(null),
    [status, setStatus] = useState<Status | null>(null),
    [agentState, setAgentState] = useState<AppState | null>(null);
  const [draft, setDraft] = useState(""),
    [file, setFile] = useState<Attachment | null>(null),
    [busy, setBusy] = useState(false),
    [dictating, setDictating] = useState(false),
    [tasks, setTasks] = useState<LocalTask[]>([]);
  const [pairOpen, setPairOpen] = useState(false),
    [commandsOpen, setCommandsOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [drawer, setDrawer] = useState(false),
    [voiceOpen, setVoiceOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false),
    [attachOpen, setAttachOpen] = useState(false),
    [connectionError, setConnectionError] = useState("");
  const [cloud, setCloud] = useState<CloudStatus>({ configured: false }),
    [modeOpen, setModeOpen] = useState(false);
  const [editImage, setEditImage] = useState(false);
  const [hubOpen, setHubOpen] = useState(false),
    [hubTab, setHubTab] = useState<string>("projects"),
    [pairSeed, setPairSeed] = useState<string>(),
    [sharedReference, setSharedReference] = useState(false);
  const [effectiveDark, setEffectiveDark] = useState(false);
  const [toast, setToast] = useState(""),
    [copied, setCopied] = useState("");
  const [atBottom, setAtBottom] = useState(true),
    [shown, setShown] = useState(30);
  const textarea = useRef<HTMLTextAreaElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    end = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state),
    session = useRef(0),
    requestMode = useRef<"agent" | "cloud">("agent"),
    sending = useRef(false),
    toastTimer = useRef<ReturnType<typeof setTimeout>>();
  stateRef.current = state;
  const active =
    state.conversations.find((c) => c.id === state.activeId) ||
    state.conversations[0];
  const messages = active?.messages || [];
  const notify = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  }, []);
  const closeVoice = useCallback(() => setVoiceOpen(false), []);
  useEffect(() => {
    let mounted = true;
    void Promise.all([loadState(), api.restore().catch(() => null)]).then(
      ([saved, restored]) => {
        if (!mounted) return;
        setState(saved);
        setProfile(restored);
        setLoaded(true);
        // Confirms a PC-delivered interface booted; otherwise it rolls back next start.
        void markUpdateHealthy();
      },
    );
    if (isNative())
      void cloudStatus()
        .then((c) => {
          if (mounted) setCloud(c);
        })
        .catch(() => {});
    return () => {
      mounted = false;
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const generation = session.current;
    const timer = setTimeout(() => {
      if (generation !== session.current) return;
      void saveState(state)
        .then(async () => {
          const refs = await pendingJobs();
          const ids = new Set(
            state.conversations.flatMap((c) =>
              c.messages.map((m) => m.jobId).filter(Boolean),
            ),
          );
          for (const ref of refs) if (ids.has(ref.id)) await forgetJob(ref.id);
        })
        .catch(() =>
          notify(
            "Could not save local history. Free space or disable history in Settings.",
          ),
        );
    }, 450);
    return () => clearTimeout(timer);
  }, [state, loaded, notify]);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme =
        state.preferences.theme === "system"
          ? query.matches
            ? "dark"
            : "light"
          : state.preferences.theme;
      document.documentElement.dataset.theme = theme;
      setEffectiveDark(theme === "dark");
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
      if (isNative())
        void nativeCall("appearance", {
          dark: theme === "dark",
          screenPrivacy: state.preferences.screenPrivacy,
        }).catch(() => {});
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [state.preferences.theme, state.preferences.screenPrivacy]);
  useEffect(() => {
    const resize = () =>
      document.documentElement.style.setProperty(
        "--app-height",
        `${window.visualViewport?.height || window.innerHeight}px`,
      );
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    return () => window.visualViewport?.removeEventListener("resize", resize);
  }, []);
  const clearLocal = useCallback(() => {
    const fresh = emptyState();
    fresh.preferences = { ...stateRef.current.preferences };
    fresh.conversations[0].mode = fresh.preferences.chatMode;
    stateRef.current = fresh;
    setState(fresh);
    setTasks([]);
    void saveState(fresh).catch(() => {});
  }, []);
  const disconnected = useCallback(() => {
    session.current++;
    void clearPendingJobs().catch(() => {});
    setProfile(null);
    setStatus(null);
    setAgentState(null);
    setBusy(false);
    sending.current = false;
    setVoiceOpen(false);
    setFile(null);
    setDraft("");
    cancelSpeech();
    clearLocal();
  }, [clearLocal]);
  useEffect(() => {
    api.onSessionLost = () => {
      disconnected();
      notify("Session expired. Pair your PC again.");
    };
    return () => {
      api.onSessionLost = null;
    };
  }, [disconnected, notify]);
  const refresh = useCallback(async () => {
    if (!api.profile || document.hidden) return;
    const generation = session.current;
    try {
      const result = await api.get<Status>("/api/status");
      if (generation !== session.current) return;
      setStatus(result);
      setConnectionError("");
      try {
        const app = await api.get<AppState>("/api/app/state");
        if (generation === session.current) setAgentState(app);
      } catch (e) {
        if (generation === session.current && !(e instanceof SessionChanged))
          setAgentState(null);
      }
    } catch (e) {
      if (generation === session.current && !(e instanceof SessionChanged))
        setConnectionError(e instanceof Error ? e.message : "PC unavailable");
    }
  }, []);
  useEffect(() => {
    if (!profile) return;
    void refresh();
    const timer = setInterval(
      () => void refresh(),
      page === "tasks" || busy ? 3000 : 30_000,
    );
    const visible = () => {
      if (!document.hidden) void refresh();
      else {
        setVoiceOpen(false);
        cancelSpeech();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [profile, page, busy, refresh]);
  // Follow the conversation only while the owner is at the bottom; scrolling up
  // to read must not be yanked back by an incoming reply.
  useEffect(() => {
    if (atBottom) end.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, busy, page]);
  // ── PC-delivered interface updates (no APK, no uninstall) ────────────────
  // `observer.sh update --app` on the PC packs a signed web bundle; paired
  // phones are offered it here and install it themselves. Applied only while
  // nothing is in flight, and the app reloads once the new bundle is active —
  // a bundle that fails to boot is swapped back natively (WebUpdate).
  useEffect(() => {
    if (!profile || !isNative() || state.preferences.autoAppUpdate === false)
      return;
    let alive = true;
    const autoUpdate = async () => {
      // Never interrupt a request, a dictation or a voice turn.
      if (document.hidden || sending.current || busy || voiceOpen) return;
      try {
        const check = await checkPcUpdate();
        if (!alive || !check?.available) return;
        const applied = await applyPcUpdate();
        if (!alive) return;
        notify(
          `Interface ${applied?.installed || check.version} installed — reloading.`,
        );
        window.setTimeout(() => window.location.reload(), 1500);
      } catch {
        /* Silent on purpose: Settings keeps the manual path and the reason. */
      }
    };
    const boot = window.setTimeout(() => void autoUpdate(), 3000);
    const timer = window.setInterval(() => void autoUpdate(), 30 * 60 * 1000);
    const visible = () => {
      if (!document.hidden) void autoUpdate();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      window.clearTimeout(boot);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [profile, busy, voiceOpen, state.preferences.autoAppUpdate, notify]);
  const toBottom = () => {
    setAtBottom(true);
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };
  // A half-written message is the most expensive thing on this screen, so a
  // draft survives reloads, crashes and losing the network. Stored per thread,
  // on the device only — never sent until you press send.
  useEffect(() => {
    try {
      const key = `observer-draft:${state.activeId}`;
      const text = draft.trim() ? draft : "";
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {
      /* storage full or blocked: the draft simply stays in memory */
    }
  }, [draft, state.activeId]);
  useEffect(() => {
    setShown(30);
  }, [state.activeId]);
  useEffect(() => {
    try {
      setDraft(localStorage.getItem(`observer-draft:${state.activeId}`) || "");
    } catch {
      setDraft("");
    }
    // Thread switch only; typing must not re-read storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeId]);
  useEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    }
  }, [draft, page]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCommandsOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const updatePreferences = useCallback(
    (patch: Partial<Preferences>) =>
      setState((s) => ({ ...s, preferences: { ...s.preferences, ...patch } })),
    [],
  );
  function newChat() {
    const c = newConversation(stateRef.current.preferences.chatMode);
    c.projectId =
      stateRef.current.conversations.find(
        (c) => c.id === stateRef.current.activeId,
      )?.projectId || "personal00";
    setSharedReference(false);
    setState((s) => ({
      ...s,
      conversations: [...s.conversations, c].slice(-20),
      activeId: c.id,
    }));
    setDraft("");
    setFile(null);
    setPage("chat");
    setDrawer(false);
    setHistoryOpen(false);
  }
  function chooseDraft(text: string) {
    setSharedReference(false);
    if (
      text.trim().startsWith("/") &&
      stateRef.current.preferences.chatMode === "cloud"
    ) {
      const c = newConversation("agent");
      setState((s) => ({
        ...s,
        preferences: { ...s.preferences, chatMode: "agent" },
        conversations: [...s.conversations, c].slice(-20),
        activeId: c.id,
      }));
      notify(
        "PC tool selected. Switched to a fresh PC agent thread; nothing has run.",
      );
    }
    setDraft(text);
    setPage("chat");
    setCommandsOpen(false);
    setDrawer(false);
    setTimeout(() => textarea.current?.focus(), 50);
  }
  function markDelivery(conversationId: string, id: string, delivery: Delivery) {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === id ? { ...m, delivery } : m,
              ),
            }
          : c,
      ),
    }));
  }
  function append(
    message: Message,
    conversationId = stateRef.current.activeId,
  ) {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              updated: Date.now(),
              title: c.messages.length
                ? c.title
                : message.text.replace(/^\//, "").slice(0, 54) || "Attachment",
              messages: [...c.messages, message]
                .slice(-100)
                .map((m, i, all) =>
                  all.length - i > 8
                    ? { ...m, images: [], audio: undefined }
                    : m,
                ),
            }
          : c,
      ),
    }));
  }
  const addReply = useCallback((reply: Reply, route: Route = "agent") => {
    const message: Message = {
      ...reply,
      id: crypto.randomUUID(),
      role: "assistant",
      route,
      text:
        reply.text ||
        (reply.stopped
          ? "Task stopped."
          : "The agent returned no text. Inspect the task state before repeating actions."),
      ts: Date.now(),
    };
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === s.activeId
          ? {
              ...c,
              updated: Date.now(),
              messages: [...c.messages, message].slice(-100),
            }
          : c,
      ),
    }));
  }, []);
  async function stop(forcePC = false) {
    if (!forcePC && requestMode.current === "cloud") {
      session.current++;
      sending.current = false;
      setBusy(false);
      await cancelCloud().catch(() => {});
      setTasks((items) =>
        items.map((t) =>
          t.state === "running" ? { ...t, state: "stopped" } : t,
        ),
      );
      addReply({
        text: "Stopped waiting for Direct AI. Your provider may already have processed this request; nothing will be retried.",
      });
      return;
    }
    if (!api.profile) return;
    try {
      const reply = await api.post<Reply>("/api/chat", { text: "/stop" });
      addReply(reply);
      setTasks((items) =>
        items.map((t) =>
          t.state === "running" ? { ...t, state: "stopped" } : t,
        ),
      );
      void refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : "Stop request not delivered.");
    }
  }
  // Local calendar day, so "today" means the owner's today, not UTC's.
  const dayKey = () =>
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const monthKey = () => dayKey().slice(0, 7);

  /** Tokens spent on the owner's own Direct AI key today. */
  const todayTokens = () =>
    stateRef.current.preferences.usage?.[dayKey()] || 0;
  const monthTokens = () => {
    const usage = stateRef.current.preferences.usage || {},
      month = monthKey();
    return Object.entries(usage)
      .filter(([day]) => day.startsWith(month))
      .reduce((sum, [, n]) => sum + n, 0);
  };
  const usageWarning = () => {
    const cap = stateRef.current.preferences.usageCap || 0;
    if (!cap) return "";
    const used = monthTokens();
    if (used >= cap)
      return `Direct AI budget for this month is used up (${used.toLocaleString("en-IN")} / ${cap.toLocaleString("en-IN")} tokens). PC answers still work.`;
    if (used >= cap * 0.8)
      return `Direct AI is at ${Math.round((used / cap) * 100)}% of this month's budget (${used.toLocaleString("en-IN")} / ${cap.toLocaleString("en-IN")} tokens).`;
    return "";
  };
  function chargeUsage(tokens: number) {
    if (!(tokens > 0)) return;
    const key = dayKey(),
      usage = { ...(stateRef.current.preferences.usage || {}) };
    usage[key] = (usage[key] || 0) + tokens;
    // Keep a year of days at most; the phone is not a billing archive.
    const trimmed = Object.fromEntries(
      Object.entries(usage)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-366),
    );
    updatePreferences({ usage: trimmed });
  }

  /**
   * A Direct AI call that retries only for transport failures — a refused
   * question or a bad key is an answer, not a reason to spend twice. Backoff
   * is short because the owner is waiting, and the provider may already have
   * processed the earlier attempt.
   */
  async function cloudWithRetry(messages: Message[], attempts = 3) {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await cloudChat(messages);
      } catch (e) {
        last = e;
        const text = e instanceof Error ? e.message : String(e);
        const transport =
          /network|timeout|timed out|interrupt|unavailable|socket|fetch|connection|refused|502|503|504/i.test(
            text,
          );
        if (!transport || attempt === attempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
      }
    }
    throw last;
  }

  /**
   * "Ask the other engine": the same sentence, the other engine, this chat.
   * The correction is remembered so the classifier routes it right next time.
   */
  async function resendOn(userText: string, route: Route) {
    if (sending.current || !userText.trim()) return;
    if (route === "cloud" && !cloud.configured) {
      setModeOpen(true);
      return;
    }
    if (route === "agent" && !profile) {
      setPairOpen(true);
      return;
    }
    updatePreferences({
      routeFixes: learnFix(
        stateRef.current.preferences.routeFixes || [],
        userText,
        route,
      ),
    });
    await deliver(userText, route, { retried: true });
  }

  /**
   * A catalog command, run from the palette with one tap and answered there.
   * Read-only reports only: the same job path as chat, without the history a
   * normal turn carries, so the answer is exactly what the PC said.
   */
  async function runCommandNow(text: string): Promise<string> {
    if (!profile) throw new Error("Pair your PC first — commands run there.");
    const job = await submitAndWatch({
      id: crypto.randomUUID(),
      kind: "chat",
      text,
      projectId: active?.projectId || "personal00",
      history: [],
    });
    const answer = job.result?.text;
    if (answer) return answer;
    if (job.state === "unknown")
      throw new Error(
        "Your PC accepted it but kept no result. Check Tasks before running it again.",
      );
    throw new Error(
      "No retained result. Inspect Tasks before a new request; nothing was replayed.",
    );
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (sending.current || (!draft.trim() && !file)) return;
    // One chat, two engines: this message picks its own route. Direct AI is
    // the default; the PC takes over the moment the message is about the
    // machine, is a command, or carries a file.
    const route = pickRoute(draft.trim(), {
      hasFile: !!file,
      mode: state.preferences.chatMode,
      cloudReady: cloud.configured,
      paired: !!profile,
      fixes: stateRef.current.preferences.routeFixes || [],
    });
    const direct = route === "cloud";
    if (direct && !cloud.configured) {
      setModeOpen(true);
      return;
    }
    if (!direct && !profile) {
      setPairOpen(true);
      return;
    }
    if (direct && draft.trim().startsWith("/")) {
      notify(
        "Slash commands run on your PC. This chat is pinned to Direct AI — choose Automatic or PC agent to run it.",
      );
      setModeOpen(true);
      return;
    }
    if (direct && file) {
      notify(
        "Files are read on your PC, and Direct AI is text-only. Choose Automatic or PC agent for attachments.",
      );
      return;
    }
    const text = draft.trim(),
      upload = file,
      reference = sharedReference;
    setDraft("");
    setFile(null);
    setSharedReference(false);
    await deliver(text, route, { file: upload, reference });
  }

  /**
   * The one path every message takes, however it was started: typed, retried
   * on the other engine, or re-run from a notification. Keeping it in one
   * place is what makes "ask the other engine" behave exactly like a send.
   */
  async function deliver(
    text: string,
    route: Route,
    {
      file: upload = null,
      reference = false,
      retried = false,
    }: { file?: Attachment | null; reference?: boolean; retried?: boolean } = {},
  ) {
    const direct = route === "cloud",
      cId = stateRef.current.activeId,
      generation = session.current,
      id = crypto.randomUUID();
    requestMode.current = direct ? "cloud" : "agent";
    const display = displayRequest(text);
    sending.current = true;
    setBusy(true);
    append(
      {
        id,
        role: "user",
        route,
        text: upload
          ? `${display.text || "Work through this file."}\n\n📎 ${upload.name}`
          : display.text,
        ts: Date.now(),
        private: display.private,
        delivery: "sending",
        images: upload?.preview ? [upload.preview] : undefined,
      },
      cId,
    );
    setTasks((items) => [
      ...items.slice(-29),
      {
        id,
        text: `${retried ? "Re-asked · " : ""}${display.text || upload?.name || "Attachment"}`,
        started: Date.now(),
        state: "running",
      },
    ]);
    try {
      let reply: Reply;
      if (direct) {
        // Long chats keep the recent turns and a topic line built from the
        // owner's own words; PC answers stay behind the placeholder either way.
        const history = compactContext(
          cloudContext(active?.messages || []),
        );
        reply = await cloudWithRetry([
          ...history,
          { id, role: "user", text, ts: Date.now() },
        ]);
        chargeUsage(reply.usage?.totalTokens || 0);
      }
      else if (
        !reference &&
        /^(?:\/(?:stop|cancel|abort|ruko)\b|\/taskstatus\s*$|\/batch\s+(?:status|results)\s*$)/i.test(
          text,
        )
      )
        reply = await api.post<Reply>("/api/chat", { text });
      else {
        await rememberJob({
          id,
          conversationId: cId,
          serverId: profile?.serverId || "",
          label: display.text || upload?.name || "Attachment",
          private: display.private,
          created: Date.now(),
        });
        const job = await submitAndWatch({
          id,
          kind: upload ? "solve" : reference ? "reference" : "chat",
          text: text || "Work through this attached file.",
          upload: upload
            ? { name: upload.name, mime: upload.mime, base64: upload.base64 }
            : undefined,
          projectId: active?.projectId || "personal00",
          history: (active?.messages || [])
            .filter((m) => !m.private)
            .slice(-10)
            .map((m) => ({ role: m.role, content: m.text.slice(0, 3000) })),
        });
        reply = job.result || {
          ok: false,
          text: "No retained result. Inspect Tasks before a new request.",
        };
      }
      if (generation !== session.current) return;
      markDelivery(cId, id, "sent");
      append(
        {
          ...reply,
          jobId: direct ? undefined : id,
          id: crypto.randomUUID(),
          role: "assistant",
          route,
          text:
            reply.text ||
            "No text returned. Check task state before repeating a PC action.",
          ts: Date.now(),
          private: display.private,
        },
        cId,
      );
      setTasks((items) =>
        items.map((t) =>
          t.id === id
            ? {
                ...t,
                state: t.state === "stopped" ? "stopped" : "replied",
                ended: Date.now(),
                reply: reply.text,
              }
            : t,
        ),
      );
      if (
        stateRef.current.preferences.readAloud &&
        reply.text &&
        !document.hidden
      )
        speak(reply.text, stateRef.current.preferences.language);
      void refresh();
    } catch (e) {
      if (generation !== session.current || e instanceof SessionChanged) return;
      if (
        !direct &&
        e instanceof ApiError &&
        [400, 403, 409, 413, 423].includes(e.status)
      )
        await forgetJob(id);
      markDelivery(cId, id, "failed");
      setTasks((items) =>
        items.map((t) =>
          t.id === id ? { ...t, state: "unknown", ended: Date.now() } : t,
        ),
      );
      append(
        {
          id: crypto.randomUUID(),
          role: "assistant",
          route,
          text: direct
            ? `Direct AI could not return a response. ${e instanceof Error ? e.message : "Connection interrupted."} Your provider may already have processed it; no retry was made. No PC tools ran in Direct AI mode.`
            : e instanceof PendingJob
              ? e.message
              : e instanceof ApiError &&
                  [400, 403, 409, 413, 423].includes(e.status)
                ? `Not accepted: ${e.message}`
                : `Connection interrupted. Request ID ${id} is retained in Tasks for result recovery. Inspect before a new request; no action was replayed.`,
          ts: Date.now(),
        },
        cId,
      );
    } finally {
      if (generation === session.current) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  function selectProject(project: Project) {
    const c = newConversation("agent");
    c.projectId = project.id;
    c.projectName = project.name;
    setState((s) => ({
      ...s,
      preferences: { ...s.preferences, chatMode: "agent" },
      conversations: [...s.conversations, c].slice(-20),
      activeId: c.id,
    }));
    setPage("chat");
    setDraft("");
    setFile(null);
    setSharedReference(false);
    notify(
      `${project.name}: ${project.privateChat ? "private answer context; explicit PC commands remain owner-wide" : "shared owner context"}`,
    );
  }
  async function runWorkflow(id: string, name: string) {
    if (!profile || sending.current) {
      notify("Connect the PC and wait/stop active work first.");
      return;
    }
    const requestId = crypto.randomUUID(),
      cId = stateRef.current.activeId,
      g = session.current;
    requestMode.current = "agent";
    sending.current = true;
    setBusy(true);
    setPage("chat");
    append(
      {
        id: crypto.randomUUID(),
        role: "user",
        text: `Run routine: ${name}`,
        ts: Date.now(),
      },
      cId,
    );
    try {
      await rememberJob({
        id: requestId,
        conversationId: cId,
        serverId: profile.serverId || "",
        label: name,
        created: Date.now(),
      });
      const job = await submitAndWatch({
        id: requestId,
        kind: "workflow",
        text: id,
      });
      if (g !== session.current) return;
      append(
        {
          ...job.result,
          id: crypto.randomUUID(),
          jobId: requestId,
          role: "assistant",
          text:
            job.result?.text ||
            "Inspect the routine result before another run.",
          ts: Date.now(),
        },
        cId,
      );
    } catch (e) {
      if (g === session.current)
        notify(
          e instanceof Error
            ? e.message
            : "Routine outcome needs review. No retry.",
        );
    } finally {
      if (g === session.current) {
        sending.current = false;
        setBusy(false);
        void refresh();
      }
    }
  }
  async function recoverResult(id: string) {
    try {
      const job = await api.job(id);
      if (!job.result) {
        notify(
          "The agent is still running this request. No command was re-sent.",
        );
        return;
      }
      const refs = await pendingJobs(),
        ref = refs.find((r) => r.id === id);
      setState((s) => {
        if (s.conversations.some((c) => c.messages.some((m) => m.jobId === id)))
          return s;
        const target =
          ref && s.conversations.some((c) => c.id === ref.conversationId)
            ? ref.conversationId
            : s.activeId;
        return {
          ...s,
          activeId: target,
          conversations: s.conversations.map((c) =>
            c.id === target
              ? {
                  ...c,
                  updated: Date.now(),
                  messages: [
                    ...c.messages,
                    {
                      ...job.result,
                      id: crypto.randomUUID(),
                      jobId: id,
                      role: "assistant" as const,
                      text:
                        job.result?.text ||
                        "No text retained. Inspect before repeating.",
                      ts: Date.now(),
                      private: ref?.private,
                    },
                  ].slice(-100),
                }
              : c,
          ),
        };
      });
      setPage("chat");
    } catch (e) {
      notify(
        e instanceof Error
          ? e.message
          : "Recovery unavailable. No action was replayed.",
      );
    }
  }
  async function onAttachment(file: File) {
    const generation = session.current;
    try {
      const result = await attachment(file);
      if (generation !== session.current) return;
      setFile(result);
      setPage("chat");
      setTimeout(() => textarea.current?.focus(), 50);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not attach that file.");
    }
  }
  async function onDictate() {
    if (dictating) {
      cancelSpeech();
      setDictating(false);
      return;
    }
    const generation = session.current;
    setDictating(true);
    try {
      const text = await dictate(state.preferences.language);
      if (generation === session.current && text)
        setDraft((d) => (d ? `${d} ${text}` : text));
    } catch (e) {
      notify(e instanceof Error ? e.message : "Speech unavailable");
    } finally {
      setDictating(false);
    }
  }
  useEffect(() => {
    const back = () => {
      const dialog = document.querySelector("dialog[open]");
      if (dialog) {
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
        return;
      }
      if (page !== "chat") setPage("chat");
      else if (isNative()) void nativeCall("minimize");
    };
    const background = () => {
      setVoiceOpen(false);
      setDictating(false);
      cancelSpeech();
      document
        .querySelectorAll<HTMLMediaElement>("audio,video")
        .forEach((m) => m.pause());
    };
    window.addEventListener("observer-back", back);
    window.addEventListener("observer-background", background);
    return () => {
      window.removeEventListener("observer-back", back);
      window.removeEventListener("observer-background", background);
    };
  }, [page]);
  useEffect(() => {
    if (!isNative() || !loaded) return;
    let alive = true;
    const incoming = async () => {
      try {
        const r = await nativeCall<{
          text?: string;
          reference?: boolean;
          qr?: string;
          page?: string;
          file?: Attachment;
        }>("consumeShare");
        if (!alive || !r) return;
        if (r.qr) {
          setPairSeed(r.qr);
          setPairOpen(true);
          return;
        }
        if (r.page === "voice") {
          if (api.profile) setVoiceOpen(true);
          else setPairOpen(true);
          return;
        }
        if (r.page && ["chat", "pc", "tasks"].includes(r.page))
          setPage(r.page as Page);
        if (r.text || r.file) {
          const c = newConversation("agent");
          setState((s) => ({
            ...s,
            preferences: { ...s.preferences, chatMode: "agent" },
            conversations: [...s.conversations, c].slice(-20),
            activeId: c.id,
          }));
          setDraft(r.text || "");
          setFile(
            r.file
              ? {
                  ...r.file,
                  preview: r.file.mime.startsWith("image/")
                    ? `data:${r.file.mime};base64,${r.file.base64}`
                    : undefined,
                }
              : null,
          );
          setSharedReference(Boolean(r.reference));
          setPage("chat");
          notify(
            "Shared draft loaded. Review it; nothing was uploaded or executed.",
          );
        }
      } catch {
        /* Locked app or no pending share. */
      }
    };
    const unlocked = async () => {
      try {
        const [saved, p] = await Promise.all([loadState(), api.restore()]);
        if (alive) {
          setState(saved);
          setProfile(p);
          void incoming();
          void refresh();
        }
      } catch {}
    };
    void incoming();
    window.addEventListener("observer-incoming", incoming);
    window.addEventListener("observer-unlocked", unlocked);
    return () => {
      alive = false;
      window.removeEventListener("observer-incoming", incoming);
      window.removeEventListener("observer-unlocked", unlocked);
    };
  }, [loaded, notify, refresh]);
  // Long threads render a window, not every message: 4 GB phone, no jank.
  const visibleMessages = messages.slice(Math.max(0, messages.length - shown));
  // The classifier is pure and instant, so the destination is known before
  // anything is sent — no network call, no model call.
  const hintRoute = draft.trim()
    ? pickRoute(draft.trim(), {
        mode: "auto",
        cloudReady: cloud.configured,
        paired: !!profile,
        fixes: state.preferences.routeFixes || [],
      })
    : null;
  const selectedLabel = [...deskPages, ...mobilePages].find(
    (p) => p.id === page,
  )?.label || "Chat";
  const nav = (mobile = false) => (
    <nav
      aria-label={mobile ? "Mobile navigation" : "Workspace"}
      className={mobile ? "bottom-nav" : "side-nav"}
    >
      {(mobile ? mobilePages : deskPages).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          aria-label={label}
          title={
            id === "tasks" && agentState?.pending.length
              ? `${agentState.pending.length} approval requests waiting`
              : label
          }
          className={page === id ? "active" : ""}
          aria-current={page === id ? "page" : undefined}
          onClick={() => {
            setPage(id);
            setDrawer(false);
          }}
        >
          <Icon size={mobile ? 21 : 19} strokeWidth={1.7} />
          <span>{label}</span>
          {id === "tasks" && !!agentState?.pending.length && (
            <i className="nav-count" aria-hidden="true">
              {agentState.pending.length}
            </i>
          )}
        </button>
      ))}
    </nav>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("chat");
          }}
          aria-label="Observer home"
        >
          <Mark />
          <span>observer</span>
        </a>
        <button className="new-chat" onClick={newChat}>
          <Plus size={18} />
          New conversation<span className="key-hint">↗</span>
        </button>
        <div className="side-section-label">YOUR WORKSPACE</div>
        {nav()}
        <div className="side-divider" />
        <button className="side-utility" onClick={() => setCommandsOpen(true)}>
          <Command size={17} />
          Explore capabilities
          <span className="count-label">{catalog.commands.length}</span>
        </button>
        <button className="side-utility" onClick={() => setHistoryOpen(true)}>
          <HistoryIcon size={17} />
          Conversations
          <Search size={15} className="utility-tail" />
        </button>
        <button className="side-utility" onClick={() => setHubOpen(true)}>
          <FolderOpen size={17} />
          Workspace tools
          <ChevronRight size={15} />
        </button>
        <div className="recent-label">RECENT</div>
        <div className="recent-chats">
          {[...state.conversations]
            .filter((c) => c.messages.length)
            .sort((a, b) => b.updated - a.updated)
            .slice(0, 5)
            .map((c) => (
              <button
                key={c.id}
                title={c.title}
                onClick={() => {
                  setState((s) => ({
                    ...s,
                    activeId: c.id,
                    preferences: { ...s.preferences, chatMode: c.mode },
                  }));
                  setPage("chat");
                }}
              >
                {c.title}
              </button>
            ))}
          {!state.conversations.some((c) => c.messages.length) && (
            <p>
              Good conversations
              <br />
              start somewhere.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className="pc-card"
            onClick={() => (profile ? setPage("pc") : setPairOpen(true))}
          >
            <span className="pc-card-icon">
              <Monitor size={19} />
            </span>
            <span>
              <strong>
                {profile
                  ? agentState?.host || "Your PC"
                  : "Bring your PC along"}
              </strong>
              <small>
                {profile
                  ? connectionError
                    ? "Connection needs attention"
                    : "Connected to your agent"
                  : "One connection. More possibilities."}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
          <div className="sidebar-trust">
            <ShieldCheck size={14} />
            You stay in control.
            <span>v{appVersion.split(".").slice(0, 2).join(".")}</span>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-leading">
            <IconButton
              label="Open navigation"
              className="mobile-menu"
              onClick={() => setDrawer(true)}
            >
              <Menu size={21} />
            </IconButton>
            <div className="workspace-breadcrumb">
              <span>{active?.projectName || "Personal workspace"}</span>
              <ChevronRight size={13} />
              <strong>
                {page === "chat"
                  ? active?.title || "New conversation"
                  : selectedLabel}
              </strong>
            </div>
            <span className="mobile-brand">
              <Mark size={23} />
              observer
            </span>
          </div>
          <div className="topbar-actions">
            <button
              className={`connection-pill ${profile ? "connected" : ""}`}
              onClick={() => (profile ? setPage("pc") : setPairOpen(true))}
            >
              <span className="status-dot" />
              <span>
                {profile
                  ? connectionError
                    ? "Reconnect PC"
                    : "PC connected"
                  : "Connect PC"}
              </span>
            </button>
            <IconButton
              label="Search or run a command"
              className="palette-button"
              onClick={() => setCommandsOpen(true)}
            >
              <Command size={18} />
            </IconButton>
            <IconButton
              label={
                effectiveDark ? "Switch to light theme" : "Switch to dark theme"
              }
              onClick={() =>
                updatePreferences({ theme: effectiveDark ? "light" : "dark" })
              }
            >
              {effectiveDark ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
            <div className="top-menu">
              <IconButton
                label="More options"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <MoreHorizontal size={21} />
              </IconButton>
              {menuOpen && (
                <div className="dropdown">
                  <button
                    onClick={() => {
                      newChat();
                      setMenuOpen(false);
                    }}
                  >
                    <Plus size={16} />
                    New conversation
                  </button>
                  <button
                    onClick={() => {
                      setHistoryOpen(true);
                      setMenuOpen(false);
                    }}
                  >
                    <HistoryIcon size={16} />
                    Conversation history
                  </button>
                  <button
                    onClick={() => {
                      setCommandsOpen(true);
                      setMenuOpen(false);
                    }}
                  >
                    <Command size={16} />
                    All capabilities
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        {connectionError && (
          <div className="connection-warning" role="status">
            <Monitor size={15} />
            <span>{connectionError}</span>
            <button onClick={() => void refresh()}>Check again</button>
          </div>
        )}
        <Suspense
          fallback={
            <div className="loading-panel">
              <LoaderCircle size={22} className="spin" />
              <span>One moment…</span>
            </div>
          }
        >
          {page === "chat" ? (
            <section className="chat-page" aria-label="Conversation">
              <div
                className="chat-scroll"
                ref={scroller}
                onScroll={() => {
                  const el = scroller.current;
                  if (!el) return;
                  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                  setAtBottom(gap < 90);
                }}
              >
                {!messages.length ? (
                  <div className="welcome">
                    <div className="welcome-mark">
                      <Mark size={38} />
                    </div>
                    <div className="eyebrow">
                      A LITTLE SPACE. A LOT OF POSSIBILITY.
                    </div>
                    <h1>
                      Think clearly.
                      <br />
                      <span>Make things happen.</span>
                    </h1>
                    <p>
                      A question, a fresh idea, or a little help with your PC.
                      <br className="desktop-break" /> Let’s work through it,
                      together.
                    </p>
                    {state.preferences.chatMode === "auto" && (
                      <p className="auto-note">
                        Ordinary messages are answered by your own model key. The
                        moment you mention your PC or give a command, the paired
                        PC takes over — right here, same chat.
                      </p>
                    )}
                    <div className="suggestion-grid">
                      {suggestions.map((s) => (
                        <button
                          key={s.title}
                          className="suggestion"
                          onClick={() =>
                            s.page ? setPage(s.page) : chooseDraft(s.prompt!)
                          }
                        >
                          <span className="suggestion-icon">
                            <s.icon size={20} strokeWidth={1.65} />
                          </span>
                          <span>
                            <strong>{s.title}</strong>
                            <small>{s.text}</small>
                          </span>
                          <ArrowRight size={16} />
                        </button>
                      ))}
                    </div>
                    <button
                      className="explore-link"
                      onClick={() => setCommandsOpen(true)}
                    >
                      <Command size={14} />
                      Explore all {catalog.commands.length} capabilities
                      <ChevronRight size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="messages">
                    {messages.length > shown && (
                      <button
                        className="earlier-messages"
                        onClick={() => setShown((n) => n + 40)}
                      >
                        <ChevronUp size={14} />
                        Show {messages.length - shown} earlier{" "}
                        {messages.length - shown === 1 ? "message" : "messages"}
                      </button>
                    )}
                    {visibleMessages.map((m, i) => (
                      <article className={`message ${m.role}`} key={m.id}>
                        <div className="message-avatar">
                          {m.role === "assistant" ? <Mark size={19} /> : "You"}
                        </div>
                        <div className="message-content">
                          <div className="message-label">
                            {m.role === "assistant" ? "Observer" : "You"}
                            {m.role === "assistant" && m.route && (
                              <span className={`route-chip ${m.route}`}>
                                {m.route === "cloud" ? "Direct AI" : "PC"}
                              </span>
                            )}
                            <time>
                              {new Date(m.ts).toLocaleTimeString("en-IN", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </time>
                          </div>
                          <Suspense
                            fallback={
                              <div className="plain-message">{m.text}</div>
                            }
                          >
                            <Markdown text={m.text} />
                          </Suspense>
                          {m.images
                            ?.filter((src) =>
                              /^data:image\/(?:png|jpeg|webp);base64,/.test(
                                src,
                              ),
                            )
                            .slice(0, 5)
                            .map((src, i) => (
                              <img
                                className="message-image"
                                src={src}
                                alt={`Agent image ${i + 1}`}
                                key={i}
                                loading="lazy"
                              />
                            ))}
                          {m.audio && /^data:audio\//.test(m.audio) && (
                            <audio controls src={m.audio} preload="none" />
                          )}
                          {m.media?.map((media) => (
                            <AuthenticatedMedia
                              key={media.id}
                              media={media}
                              notice={notify}
                            />
                          ))}
                          {m.documentPath && !m.media?.length && (
                            <button
                              className="attachment-download"
                              onClick={() =>
                                void api
                                  .download(
                                    "/api/download?path=" +
                                      encodeURIComponent(m.documentPath!),
                                    m.documentName || "download",
                                  )
                                  .catch((e) => notify(e.message))
                              }
                            >
                              <FileText size={17} />
                              {m.documentName || "Download file"}
                              <ArrowDownToLine size={17} />
                            </button>
                          )}
                          {m.role === "user" && m.delivery && (
                            <p
                              className={`delivery ${m.delivery}`}
                              title={
                                m.delivery === "failed"
                                  ? "The PC never confirmed this. Check Tasks before sending it again."
                                  : undefined
                              }
                            >
                              {m.delivery === "sending"
                                ? "Sending…"
                                : m.delivery === "sent"
                                  ? "Delivered to your PC"
                                  : "Not delivered — check Tasks"}
                            </p>
                          )}
                          {m.role === "assistant" && (
                            <div className="message-tools">
                              {/* Wrong engine? Ask the other one, in this chat. */}
                              {m.route && !busy && (
                                <button
                                  className="text-button small-text"
                                  onClick={() =>
                                    void resendOn(
                                      visibleMessages[i - 1]?.role === "user"
                                        ? visibleMessages[i - 1].text
                                        : "",
                                      m.route === "cloud" ? "agent" : "cloud",
                                    )
                                  }
                                >
                                  <ArrowLeftRight size={15} />
                                  {m.route === "cloud"
                                    ? "PC se poocho"
                                    : "Direct AI se poocho"}
                                </button>
                              )}
                              <IconButton
                                label="Copy reply"
                                onClick={() =>
                                  void navigator.clipboard
                                    .writeText(m.text)
                                    .then(() => {
                                      setCopied(m.id);
                                      setTimeout(() => setCopied(""), 2000);
                                    })
                                    .catch(() =>
                                      notify(
                                        "Clipboard unavailable. Select and copy the text.",
                                      ),
                                    )
                                }
                              >
                                {copied === m.id ? (
                                  <Check size={15} />
                                ) : (
                                  <Copy size={15} />
                                )}
                              </IconButton>
                              <IconButton
                                label="Read reply aloud"
                                onClick={() =>
                                  speak(m.text, state.preferences.language)
                                }
                              >
                                <Volume2 size={15} />
                              </IconButton>
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                    {busy && (
                      <div className="working-message" role="status">
                        <Mark size={20} />
                        <span>
                          Working on it<span className="ellipsis">…</span>
                        </span>
                        <button onClick={() => setPage("tasks")}>
                          View tasks
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                    <div ref={end} />
                  </div>
                )}
              </div>
              {!atBottom && messages.length > 0 && (
                <button className="jump-latest" onClick={toBottom}>
                  <ArrowDown size={15} />
                  Latest
                </button>
              )}
              <div className="composer-area">
                <div className="composer-context">
                  <button
                    className="model-chip"
                    disabled={busy}
                    onClick={() => setModeOpen(true)}
                  >
                    <Sparkles size={14} />
                    {state.preferences.chatMode === "cloud"
                      ? `Direct AI${cloud.provider ? " · " + cloud.provider : ""}`
                      : state.preferences.chatMode === "auto"
                        ? "Automatic"
                        : status?.model
                          ? "Auto · PC agent"
                          : "Your agent"}
                    <ChevronDown size={13} />
                  </button>
                  {hintRoute && (
                    <span className={`route-hint ${hintRoute}`}>
                      {hintRoute === "cloud" ? "→ Direct AI" : "→ your PC"}
                    </span>
                  )}
                  <button
                    className="text-button small-text"
                    onClick={() => {
                      if (state.preferences.chatMode === "cloud")
                        notify(
                          "Direct AI supports dictation and read-aloud. Full voice sessions use PC agent mode.",
                        );
                      else if (!profile) setPairOpen(true);
                      else setVoiceOpen(true);
                    }}
                  >
                    <Waves size={16} />
                    Voice session
                  </button>
                </div>
                <form
                  className={`composer ${busy ? "is-busy" : ""}`}
                  onSubmit={(e) => void send(e)}
                >
                  {file && (
                    <div className="attachment-preview">
                      <FileText size={18} />
                      <span>
                        <strong>{file.name}</strong>
                        <small>
                          {(file.size / 1024).toFixed(0)} KB · ready to send
                        </small>
                      </span>
                      {file.mime.startsWith("image/") && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setEditImage(true)}
                        >
                          Crop & mark
                        </button>
                      )}
                      <IconButton
                        label="Remove attachment"
                        onClick={() => setFile(null)}
                      >
                        <X size={17} />
                      </IconButton>
                    </div>
                  )}
                  {sharedReference && (
                    <div className="info-note">
                      Shared reference · read-only answer. Its contents cannot
                      execute PC commands.
                    </div>
                  )}
                  <textarea
                    ref={textarea}
                    aria-label="Message Observer"
                    placeholder="Ask anything, or make something happen…"
                    rows={1}
                    maxLength={16000}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        window.matchMedia("(pointer: fine)").matches
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-controls">
                    <div>
                      <IconButton
                        label="Add something to this message"
                        onClick={() => setAttachOpen(true)}
                      >
                        <Plus size={21} />
                      </IconButton>
                      <IconButton
                        label="Explore commands"
                        onClick={() => setCommandsOpen(true)}
                      >
                        <Command size={18} />
                      </IconButton>
                      <span className="composer-divider" />
                      <span className="composer-hint">
                        Your ideas start here
                      </span>
                    </div>
                    <div>
                      <IconButton
                        label={
                          dictating ? "Cancel dictation" : "Dictate a message"
                        }
                        className={dictating ? "dictating" : ""}
                        onClick={() => void onDictate()}
                      >
                        {dictating ? (
                          <LoaderCircle size={18} className="spin" />
                        ) : (
                          <Mic size={19} />
                        )}
                      </IconButton>
                      {busy ? (
                        <button
                          type="button"
                          className="send-button"
                          aria-label="Stop current task"
                          onClick={() => void stop()}
                        >
                          <Square size={16} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          type="submit"
                          className="send-button"
                          aria-label="Send message"
                          disabled={(!draft.trim() && !file) || !loaded}
                        >
                          <ArrowUp size={21} />
                        </button>
                      )}
                    </div>
                  </div>
                </form>
                <div className="composer-footer">
                  <ShieldCheck size={12} />
                  <span>
                    You’re in control. Review important answers and actions.
                  </span>
                </div>
                {/* Direct AI spends the owner's own key, so the phone says so. */}
                {(todayTokens() > 0 || usageWarning()) && (
                  <p
                    className={`usage-note${usageWarning() ? " warn" : ""}`}
                    role="status"
                  >
                    <Gauge size={12} />
                    <span>
                      {usageWarning() ||
                        `Direct AI today: ${todayTokens().toLocaleString("en-IN")} tokens on your key.`}
                    </span>
                  </p>
                )}
              </div>
            </section>
          ) : page === "pc" ? (
            <PCControl
              connected={!!profile}
              state={agentState}
              lowData={state.preferences.lowData}
              onConnect={() => setPairOpen(true)}
              draft={chooseDraft}
              notice={notify}
            />
          ) : page === "tasks" ? (
            <Tasks
              connected={!!profile}
              state={agentState}
              tasks={tasks}
              recover={(id) => void recoverResult(id)}
              refresh={() => void refresh()}
              draft={chooseDraft}
              stop={() => void stop(true)}
              onConnect={() => setPairOpen(true)}
              notice={notify}
              addReply={addReply}
            />
          ) : page === "more" ? (
            <More
              connected={!!profile}
              state={agentState}
              host={profile?.baseUrl?.replace(/^https?:\/\//, "") || ""}
              version={status?.version || ""}
              deviceCount={null}
              alertCount={0}
              dark={effectiveDark}
              onConnect={() => setPairOpen(true)}
              onToggleTheme={() =>
                updatePreferences({ theme: effectiveDark ? "light" : "dark" })
              }
              onOpenPage={(next) => setPage(next)}
              onOpenHub={(target) => {
                setHubTab(target);
                setHubOpen(true);
              }}
            />
          ) : page === "files" ? (
            <Files
              connected={!!profile}
              onConnect={() => setPairOpen(true)}
              attach={() => fileInput.current?.click()}
              draft={chooseDraft}
              notice={notify}
            />
          ) : (
            <Settings
              onTools={() => setHubOpen(true)}
              preferences={state.preferences}
              update={updatePreferences}
              profile={profile}
              status={status}
              state={agentState}
              onConnect={() => setPairOpen(true)}
              onDisconnect={() => {
                disconnected();
                void api
                  .disconnect()
                  .catch(() =>
                    notify(
                      "Could not clear native connection. Close the app and retry.",
                    ),
                  );
              }}
              clearHistory={clearLocal}
              draft={chooseDraft}
              commands={() => setCommandsOpen(true)}
            />
          )}
        </Suspense>
        {nav(true)}
      </main>
      <input
        type="file"
        ref={fileInput}
        className="visually-hidden"
        aria-label="Choose attachment"
        accept="image/png,image/jpeg,image/webp,.pdf,.docx,.txt"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onAttachment(f);
          e.target.value = "";
        }}
      />
      <Suspense fallback={null}>
        {editImage && file?.mime.startsWith("image/") && (
          <AttachmentEditor
            file={file}
            onClose={() => setEditImage(false)}
            onSave={(a) => {
              setFile(a);
              setEditImage(false);
            }}
          />
        )}
        {attachOpen && (
          <Modal
            title="Add to this message"
            subtitle="Files stay on your PC until you pick one."
            onClose={() => setAttachOpen(false)}
          >
            <button
              className="more-row"
              onClick={() => {
                setAttachOpen(false);
                fileInput.current?.click();
              }}
            >
              <span className="setting-icon">
                <FileText size={19} />
              </span>
              <span className="more-copy">
                <strong>Photo or document</strong>
                <small>Picked from this phone, then sent with the message.</small>
              </span>
            </button>
            <button
              className="more-row"
              onClick={() => {
                setAttachOpen(false);
                setPage("files");
              }}
            >
              <span className="setting-icon">
                <FolderOpen size={19} />
              </span>
              <span className="more-copy">
                <strong>Files from your PC</strong>
                <small>Browse what the PC saved for you, then attach one.</small>
              </span>
            </button>
          </Modal>
        )}
        {hubOpen && (
          <WorkspaceHub
            initialTab={hubTab}
            connected={!!profile}
            state={agentState}
            onClose={() => setHubOpen(false)}
            selectProject={selectProject}
            runWorkflow={(id, name) => void runWorkflow(id, name)}
            recover={(id) => void recoverResult(id)}
            notice={notify}
          />
        )}
        {modeOpen && (
          <ModelMode
            mode={state.preferences.chatMode}
            cloud={cloud}
            onMode={(mode) => {
              if (stateRef.current.preferences.chatMode !== mode) {
                const c = newConversation(mode);
                setState((s) => ({
                  ...s,
                  preferences: { ...s.preferences, chatMode: mode },
                  conversations: [...s.conversations, c].slice(-20),
                  activeId: c.id,
                }));
                setDraft("");
                setFile(null);
                setPage("chat");
              }
            }}
            onCloud={setCloud}
            onClose={() => setModeOpen(false)}
            inspect={() => {
              setModeOpen(false);
              chooseDraft("/brains");
            }}
          />
        )}
        {pairOpen && (
          <Pairing
            seed={pairSeed}
            onClose={() => {
              setPairOpen(false);
              setPairSeed(undefined);
            }}
            onConnected={() => {
              session.current++;
              setProfile(api.profile);
              setPairOpen(false);
              setConnectionError("");
              void refresh();
              notify(
                "Connected. Your existing agent and safety gates are ready.",
              );
            }}
          />
        )}
        {commandsOpen && (
          <CommandPalette
            onClose={() => setCommandsOpen(false)}
            onChoose={chooseDraft}
            onRun={runCommandNow}
            paired={!!profile}
          />
        )}
        {historyOpen && (
          <History
            conversations={state.conversations}
            onClose={() => setHistoryOpen(false)}
            onSelect={(id) => {
              setState((s) => ({
                ...s,
                activeId: id,
                preferences: {
                  ...s.preferences,
                  chatMode:
                    s.conversations.find((c) => c.id === id)?.mode || "agent",
                },
              }));
              setHistoryOpen(false);
              setPage("chat");
            }}
            onDelete={(id) =>
              setState((s) => {
                const cs = s.conversations.filter((c) => c.id !== id);
                if (!cs.length) cs.push(newConversation());
                return {
                  ...s,
                  conversations: cs,
                  activeId: s.activeId === id ? cs[0].id : s.activeId,
                };
              })
            }
            onNew={newChat}
          />
        )}
        {voiceOpen && (
          <Voice
            conversationId={state.activeId}
            language={state.preferences.language}
            onClose={closeVoice}
            onReply={addReply}
          />
        )}
      </Suspense>
      {drawer && (
        <Modal
          title="Your workspace"
          onClose={() => setDrawer(false)}
          className="mobile-drawer"
        >
          <button className="button primary full" onClick={newChat}>
            <Plus size={18} />
            New conversation
          </button>
          {nav()}
          <button
            className="button full"
            onClick={() => {
              setDrawer(false);
              setHistoryOpen(true);
            }}
          >
            <HistoryIcon size={17} />
            Conversation history
          </button>
          <button
            className="button full"
            onClick={() => {
              setDrawer(false);
              setCommandsOpen(true);
            }}
          >
            <CircleHelp size={17} />
            Explore capabilities
          </button>
          <button
            className="button full"
            onClick={() => {
              setDrawer(false);
              setHubOpen(true);
            }}
          >
            <FolderOpen size={17} />
            Workspace tools
          </button>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <IconButton label="Dismiss notification" onClick={() => setToast("")}>
            <X size={17} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
