export type Page = 'chat' | 'pc' | 'tasks' | 'files' | 'settings';
export type Theme = 'light' | 'dark' | 'system';
export interface Profile { baseUrl: string; name?: string; native?: boolean }
export interface Attachment { name: string; mime: string; base64: string; preview?: string; size: number }
export interface Media { id: string; name: string; mime: string; size: number; url: string }
export interface Reply { ok?: boolean; text?: string; images?: string[]; audio?: string; documentName?: string; documentPath?: string; media?: Media[]; stopped?: boolean; awaitingConfirm?: boolean }
export interface Message extends Reply { id: string; role: 'user' | 'assistant'; text: string; ts: number; private?: boolean }
export interface Conversation { mode: 'agent' | 'cloud'; id: string; title: string; updated: number; messages: Message[] }
export interface Preferences { theme: Theme; language: 'en-IN' | 'hi-IN'; saveHistory: boolean; readAloud: boolean; lowData: boolean; screenPrivacy: boolean; chatMode: 'agent' | 'cloud' }
export interface LocalState { conversations: Conversation[]; activeId: string; preferences: Preferences }
export interface Approval { id: string; kind: string; text: string; expiresAt?: number }
export interface ActiveTask { id: number; label: string; detail: string; startedAt: number; elapsedMs: number }
export interface BatchEntry { index: number; command: string; status: string; ms: number; text?: string; completedAfterStop?: boolean }
export interface AppState { apiVersion: number; version: string; host: string; platform: string; pcControl: boolean; controlPinRequired: boolean; active: ActiveTask[]; batch?: { entries: BatchEntry[]; halted?: string }; pending: Approval[] }
export interface Status { version: string; whatsapp: string; model: string; access?: { level?: string }; stats?: { messagesIn?: number; messagesOut?: number }; reminders?: number; notes?: number; openTodos?: number }
export interface LocalTask { id: string; text: string; started: number; ended?: number; state: 'running' | 'replied' | 'unknown' | 'stopped'; reply?: string }
export interface FileEntry { name?: string; file?: string; path: string; size?: number; ts?: number; kind?: string }
export interface Files { downloads: FileEntry[]; shared: FileEntry[] }
export interface NativeEnvelope { id: string; ok: boolean; data?: unknown; error?: string }
export interface WireResponse { status: number; json?: unknown; base64?: string; mime?: string; headers?: Record<string, string> }
export interface Release { tag_name: string; html_url: string; prerelease?: boolean; draft?: boolean; body?: string; assets: { name: string; browser_download_url: string; size: number }[] }
declare global { interface Window { ObserverAndroid?: { postMessage: (json: string) => void }; __OBSERVER_VERSION__?: string } }
