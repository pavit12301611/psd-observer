import type { Conversation, LocalState, Message, Preferences } from "../types";
import { isNative, nativeCall } from "./native";
export const defaultPreferences: Preferences = {
  theme: "dark",
  language: "en-IN",
  saveHistory: true,
  readAloud: false,
  lowData: true,
  screenPrivacy: false,
  chatMode: "agent",
  appLock: false,
  betaUpdates: true,
  autoAppUpdate: true,
};
export const newConversation = (
  mode: "agent" | "cloud" = "agent",
): Conversation => ({
  mode,
  id: crypto.randomUUID(),
  title: "New conversation",
  updated: Date.now(),
  messages: [],
});
export function emptyState(): LocalState {
  const c = newConversation();
  return {
    conversations: [c],
    activeId: c.id,
    preferences: { ...defaultPreferences },
  };
}
export function normaliseState(input: unknown): LocalState {
  const fresh = emptyState();
  if (!input || typeof input !== "object") return fresh;
  const p = input as Partial<LocalState>,
    prefs = p.preferences;
  if (prefs && typeof prefs === "object") {
    if (["agent", "cloud"].includes(prefs.chatMode))
      fresh.preferences.chatMode = prefs.chatMode;
    if (["light", "dark", "system"].includes(prefs.theme))
      fresh.preferences.theme = prefs.theme;
    if (["en-IN", "hi-IN"].includes(prefs.language))
      fresh.preferences.language = prefs.language;
    for (const key of [
      "saveHistory",
      "readAloud",
      "lowData",
      "screenPrivacy",
      "appLock",
      "betaUpdates",
      "autoAppUpdate",
    ] as const)
      if (typeof prefs[key] === "boolean") fresh.preferences[key] = prefs[key];
  }
  fresh.conversations[0].mode = fresh.preferences.chatMode;
  if (!Array.isArray(p.conversations)) return fresh;
  const conversations = p.conversations
    .slice(-20)
    .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
    .map((c) => ({
      mode: c.mode === "cloud" ? ("cloud" as const) : ("agent" as const),
      id: c.id.slice(0, 100),
      projectName: typeof c.projectName === "string" ? c.projectName.slice(0,80) : "Personal",
      projectId:
        typeof c.projectId === "string"
          ? c.projectId.slice(0, 100)
          : "personal00",
      title: String(c.title || "Conversation").slice(0, 80),
      updated: Number(c.updated) || Date.now(),
      messages: c.messages
        .slice(-80)
        .filter(
          (m: Message) =>
            m &&
            ["user", "assistant"].includes(m.role) &&
            typeof m.text === "string" &&
            !m.private,
        )
        .map((m: Message) => ({
          id: String(m.id || crypto.randomUUID()),
          jobId:
            typeof m.jobId === "string" ? m.jobId.slice(0, 100) : undefined,
          role: m.role,
          text: m.text.slice(0, 48_000),
          ts: Number(m.ts) || Date.now(),
        })),
    }));
  if (conversations.length) {
    fresh.conversations = conversations;
    fresh.activeId = conversations.some((c) => c.id === p.activeId)
      ? String(p.activeId)
      : conversations[0].id;
    fresh.preferences.chatMode =
      conversations.find((c) => c.id === fresh.activeId)?.mode || "agent";
  }
  return fresh;
}
export function persistentState(state: LocalState): LocalState {
  return normaliseState({
    ...state,
    conversations: state.preferences.saveHistory ? state.conversations : [],
  });
}
export async function loadState(): Promise<LocalState> {
  try {
    const raw = isNative()
      ? await nativeCall<string>("readState")
      : localStorage.getItem("observer-companion-state");
    return normaliseState(raw ? JSON.parse(raw) : null);
  } catch {
    return emptyState();
  }
}
let stateWrites: Promise<unknown> = Promise.resolve();
export async function saveState(state: LocalState) {
  const data = JSON.stringify(persistentState(state));
  const write = stateWrites.then(async () => {
    if (isNative()) await nativeCall("writeState", { value: data });
    else localStorage.setItem("observer-companion-state", data);
  });
  stateWrites = write.catch(() => {});
  await write;
}
export function downloadName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || "download";
}
export function humanBytes(n = 0) {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
}
