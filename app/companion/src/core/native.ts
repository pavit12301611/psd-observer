import type { NativeEnvelope } from "../types";
export const isNative = () =>
  typeof window !== "undefined" && Boolean(window.ObserverAndroid?.postMessage);
const waiting = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
if (typeof window !== "undefined")
  window.addEventListener("observer-native-result", ((
    event: CustomEvent<string | NativeEnvelope>,
  ) => {
    try {
      const packet: NativeEnvelope =
        typeof event.detail === "string"
          ? JSON.parse(event.detail)
          : event.detail;
      const callback = waiting.get(packet.id);
      if (!callback) return;
      waiting.delete(packet.id);
      clearTimeout(callback.timer);
      if (packet.ok) callback.resolve(packet.data);
      else callback.reject(new Error(packet.error || "Android request failed"));
    } catch {
      /* Never evaluate native strings as code. */
    }
  }) as EventListener);
export function nativeCall<T = unknown>(
  method: string,
  payload: unknown = {},
  timeout = 240_000,
): Promise<T> {
  if (!isNative())
    return Promise.reject(new Error("This feature needs the Android app."));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(
        new Error("Request timed out. Its PC-side result may be unknown."),
      );
    }, timeout);
    waiting.set(id, { resolve: (v) => resolve(v as T), reject, timer });
    try {
      window.ObserverAndroid!.postMessage(
        JSON.stringify({ id, method, payload }),
      );
    } catch (e) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(e instanceof Error ? e : new Error("Android bridge unavailable"));
    }
  });
}
export function openExternal(url: string) {
  const parsed = new URL(url);
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Unsafe link blocked");
  if (isNative()) void nativeCall("openExternal", { url }).catch(() => {});
  else window.open(url, "_blank", "noopener,noreferrer");
}
