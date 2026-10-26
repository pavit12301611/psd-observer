import { version as appVersion } from "../../package.json";
import type {
  AuditEntry,
  Profile,
  Release,
  WireResponse,
  Job,
  Project,
  Workflow,
  AgentEvent,
  PcUpdateCheck,
} from "../types";
import { isNative, nativeCall, openExternal } from "./native";
import { supportsMobileV2 } from "./pairing";
import { safeApiPath, validateBase } from "./validation";
export class SessionChanged extends Error {
  constructor() {
    super("Session changed. Late results were discarded.");
  }
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class BridgeClient {
  profile: Profile | null = null;
  private token = "";
  private epoch = 0;
  private requests = new Set<AbortController>();
  onSessionLost: (() => void) | null = null;
  get generation() {
    return this.epoch;
  }
  async restore() {
    const generation = this.epoch;
    if (isNative()) {
      const p = await nativeCall<Profile | null>("restore");
      if (generation !== this.epoch) throw new SessionChanged();
      this.profile = p;
    }
    return this.profile;
  }
  async diagnose(raw: string, allowLan: boolean) {
    const baseUrl = validateBase(raw, allowLan);
    if (isNative())
      return nativeCall<{
        reachable: boolean;
        version?: string;
        service?: string;
      }>("diagnose", { baseUrl, allowLan }, 20_000);
    const response = await fetch("/bridge/health", {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error("PC bridge health check failed");
    return {
      reachable: true,
      version: body.version as string,
      service: body.service as string,
    };
  }
  async pair(
    raw: string,
    pin: string,
    allowLan: boolean,
    qr?: { code: string; serverId: string },
  ) {
    const baseUrl = validateBase(raw, allowLan),
      generation = ++this.epoch;
    if (!pin.trim() && !qr)
      throw new Error("Enter the dashboard PIN or scan a fresh pairing QR.");
    if (isNative()) {
      const p = await nativeCall<Profile>("pair", {
        baseUrl,
        pin,
        allowLan,
        ...qr,
      });
      if (generation !== this.epoch) throw new SessionChanged();
      this.profile = p;
    } else {
      const health = await this.diagnose(raw, allowLan);
      if (generation !== this.epoch) throw new SessionChanged();
      if (
        !health.reachable ||
        health.service !== "observer-whatsapp-agent" ||
        !supportsMobileV2(health.version || "")
      )
        throw new Error(
          "Update PC agent to 3.10.0+ before sending a pairing credential.",
        );
      let clientId = sessionStorage.getItem("observer-browser-device-id");
      if (!clientId) {
        clientId = crypto.randomUUID();
        sessionStorage.setItem("observer-browser-device-id", clientId);
      }
      const response = await fetch("/bridge/api/app/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pin,
          ...qr,
          clientId,
          name: "Browser preview",
          model: "Browser",
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json().catch(() => ({}));
      if (generation !== this.epoch) throw new SessionChanged();
      if (!response.ok || !data.token)
        throw new ApiError(
          response.status,
          data.detail || "PC agent 3.10.0+ is required. Run Connection Doctor.",
        );
      if (data.protocol !== 2 || !data.capabilities?.jobs)
        throw new Error(
          "Update PC agent to 3.10.0+ for recoverable requests and device sessions.",
        );
      this.token = data.token;
      this.profile = {
        baseUrl: "Browser bridge proxy",
        native: false,
        deviceId: data.device.id,
        serverId: data.serverId,
        protocol: 2,
      };
    }
    return this.profile;
  }
  async disconnect() {
    this.epoch++;
    this.requests.forEach((c) => c.abort());
    this.requests.clear();
    this.token = "";
    this.profile = null;
    if (!isNative()) localStorage.removeItem("observer-pending-jobs");
    if (isNative()) await nativeCall("logout");
  }
  /**
   * The Android bridge runs every HTTP call on a 4-thread pool with a 12-slot
   * queue, and *rejects* (not queues forever) once that is full: an input tap
   * then fails with "rejected from ThreadPoolExecutor" and the page looks dead.
   * So the web bundle never has more than a few calls in flight, and it retries
   * a rejected call once instead of surfacing the pool's internals.
   */
  private inflight = 0;
  private waitingSlots: (() => void)[] = [];
  private async takeSlot() {
    // `while`, not `if`: a woken waiter and a fresh caller must not both take
    // the same freed slot.
    while (this.inflight >= 3)
      await new Promise<void>((resolve) => this.waitingSlots.push(resolve));
    this.inflight += 1;
  }
  private freeSlot() {
    this.inflight = Math.max(0, this.inflight - 1);
    const next = this.waitingSlots.shift();
    if (next) next();
  }
  private async nativeRequest(
    path: string,
    options: Record<string, unknown>,
    timeout: number,
  ): Promise<WireResponse> {
    const busy = (e: unknown) =>
      /rejected from|ThreadPoolExecutor|bridge unavailable/i.test(
        e instanceof Error ? e.message : String(e),
      );
    for (let attempt = 0; ; attempt++) {
      await this.takeSlot();
      let failure: unknown = null;
      try {
        return await nativeCall<WireResponse>(
          "request",
          { path, ...options, timeout },
          timeout + 5000,
        );
      } catch (e) {
        failure = e;
      } finally {
        this.freeSlot(); // release before pausing, so other calls keep flowing
      }
      if (attempt >= 1 || !busy(failure)) throw failure;
      // One short pause is enough: the pool drains in milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  async wire(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      binary?: boolean;
      timeout?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<WireResponse> {
    safeApiPath(path);
    if (!this.profile) throw new Error("Connect your PC first.");
    const generation = this.epoch;
    const timeout = options.timeout || 20_000;
    let result: WireResponse;
    if (isNative())
      result = await this.nativeRequest(path, { ...options }, timeout);
    else {
      const controller = new AbortController();
      this.requests.add(controller);
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch("/bridge" + path, {
          method: options.method || "GET",
          headers: {
            "x-bridge-token": this.token,
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...options.headers,
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        result = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          mime: response.headers.get("content-type") || "",
        };
        if (options.binary && response.ok) {
          const blob = await response.blob();
          result.base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } else result.json = await response.json().catch(() => ({}));
      } finally {
        clearTimeout(timer);
        this.requests.delete(controller);
      }
    }
    if (generation !== this.epoch) throw new SessionChanged();
    if (result.status === 401) {
      await this.disconnect();
      this.onSessionLost?.();
      throw new ApiError(401, "Session expired or device revoked. Pair again.");
    }
    if (result.status >= 400)
      throw new ApiError(
        result.status,
        (result.json as { detail?: string })?.detail ||
          `PC returned ${result.status}`,
      );
    return result;
  }
  async get<T>(path: string) {
    return (await this.wire(path)).json as T;
  }
  async post<T>(path: string, body: unknown) {
    return (await this.wire(path, { method: "POST", body })).json as T;
  }
  /** Raw bytes of a bridge file, for the share sheet. Never cached. */
  async bytes(path: string) {
    const r = await this.wire(path, { binary: true, timeout: 60_000 });
    return base64Blob(r.base64 || "", r.mime || "application/octet-stream");
  }
  async download(path: string, name: string) {
    safeApiPath(path);
    if (isNative()) return nativeCall("download", { path, name });
    const r = await this.wire(path, { binary: true });
    const url = URL.createObjectURL(
      base64Blob(r.base64 || "", r.mime || "application/octet-stream"),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  jobs() {
    return this.get<{ jobs: Job[] }>("/api/app/jobs");
  }
  /** The PC's append-only audit trail, newest first. Read-only. */
  audit(limit = 40) {
    return this.get<{ entries: AuditEntry[] }>(
      `/api/app/audit?limit=${Math.min(200, Math.max(1, limit))}`,
    );
  }
  job(id: string) {
    return this.get<Job>("/api/app/jobs/" + encodeURIComponent(id));
  }
  projects() {
    return this.get<{ projects: Project[] }>("/api/app/projects");
  }
  workflows() {
    return this.get<{ workflows: Workflow[] }>("/api/app/workflows");
  }
  events(after = 0) {
    return this.get<{ epoch: string; latest: number; events: AgentEvent[] }>(
      "/api/app/events?after=" + after,
    );
  }
}
export const api = new BridgeClient();
export function base64Blob(base64: string, mime: string): Blob {
  const data = atob(base64),
    bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
export function updateCandidate(
  releases: Release[],
  current = appVersion,
  beta = false,
) {
  const tuple = (v: string) => v.split(".").map(Number);
  const newer = (v: string) => {
    const a = tuple(v),
      b = tuple(current);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  return (
    releases
      .filter(
        (r) =>
          !r.draft &&
          (beta || !r.prerelease) &&
          /^android-v\d+\.\d+\.\d+$/.test(r.tag_name) &&
          newer(r.tag_name.slice(9)) &&
          r.assets?.some((a) => a.name.endsWith(".apk")),
      )
      .sort((a, b) => {
        const x = tuple(a.tag_name.slice(9)),
          y = tuple(b.tag_name.slice(9));
        return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
      })[0] || null
  );
}
export async function checkUpdates(beta = false) {
  const releases = isNative()
    ? await nativeCall<Release[]>("checkUpdates")
    : await fetch(
        "/release-api/repos/pavit12301611/psd-observer/releases?per_page=30",
        { cache: "no-store" },
      ).then((r) => {
        if (!r.ok) throw new Error("Official update check unavailable");
        return r.json();
      });
  if (!Array.isArray(releases)) throw new Error("Invalid release metadata");
  return updateCandidate(releases, appVersion, beta);
}
/**
 * PC-delivered interface updates. The paired PC signs a web bundle with a key
 * this install pinned at pairing time, so no repository secret is needed and
 * nothing has to be uninstalled. Native shell changes still arrive as an APK.
 */
export async function checkPcUpdate() {
  if (!isNative()) return null;
  return nativeCall<PcUpdateCheck>("webUpdateCheck", {}, 30_000);
}
export async function pcUpdateStatus() {
  if (!isNative()) return null;
  return nativeCall<PcUpdateCheck>("webUpdateStatus", {}, 10_000);
}
export async function applyPcUpdate() {
  if (!isNative())
    return Promise.reject(new Error("PC updates need the Android app."));
  return nativeCall<PcUpdateCheck>("webUpdateApply", {}, 300_000);
}
export async function rollbackPcUpdate() {
  if (!isNative())
    return Promise.reject(new Error("PC updates need the Android app."));
  return nativeCall<PcUpdateCheck>("webUpdateRollback", {}, 30_000);
}
/** Confirms this interface rendered; an unconfirmed bundle is rolled back on next start. */
export async function markUpdateHealthy() {
  if (!isNative()) return;
  try {
    await nativeCall("webUpdateHealthy", {}, 15_000);
  } catch {
    /* Older app shells have no update channel; nothing to confirm. */
  }
}
export const openRelease = (release: Release) => {
  if (
    !release.html_url.startsWith(
      "https://github.com/pavit12301611/psd-observer/releases/",
    )
  )
    throw new Error("Unofficial release URL blocked");
  openExternal(release.html_url);
};
