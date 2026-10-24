export const MAX_UPLOAD = 8 * 1024 * 1024;
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(h)) return true;
  const bits = h.split(".").map(Number);
  if (h.split(".").some((part) => part.length > 1 && part[0] === "0"))
    return false;
  if (
    bits.length !== 4 ||
    bits.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(h)
  )
    return false;
  return (
    bits[0] === 10 ||
    (bits[0] === 192 && bits[1] === 168) ||
    (bits[0] === 172 && bits[1] >= 16 && bits[1] <= 31) ||
    (bits[0] === 100 && bits[1] >= 64 && bits[1] <= 127)
  );
}
export function validateBase(raw: string, allowLan: boolean): string {
  const value = raw.trim();
  if (!value) throw new Error("Enter your PC bridge address.");
  const url = new URL(
    value.includes("://")
      ? value
      : `${privateHost(value.split(":")[0]) ? "http" : "https"}://${value}`,
  );
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error(
      "Use only the bridge origin, without credentials, path, query or fragment.",
    );
  if (
    /^(localhost|127(?:\.|$)|0\.0\.0\.0|\[?::1\]?)$/i.test(url.hostname) ||
    url.hostname.startsWith("127.")
  )
    throw new Error("Use the PC network address, not the phone’s localhost.");
  if (url.port === "0") throw new Error("Invalid port.");
  if (url.protocol === "http:" && (!allowLan || !privateHost(url.hostname)))
    throw new Error(
      "Use HTTPS, or explicitly allow a private LAN/VPN address. Public HTTP is blocked.",
    );
  return url.origin;
}
export function safeApiPath(path: string): string {
  if (
    !/^\/api\/[a-z0-9/_-]+(?:\?[^#]*)?$/i.test(path) ||
    /[\\\r\n]/.test(path) ||
    path.includes("..")
  )
    throw new Error("Unsafe API path blocked");
  return path;
}
export function displayRequest(text: string): {
  text: string;
  private: boolean;
} {
  const sensitive =
    /^\/(?:run|shell|mail\s+setup|dsh\s+key|key|keys|pin)\b/i.test(text) ||
    /^\/pc\s+\S+\s+\d{4,12}\b/i.test(text);
  return {
    text: sensitive
      ? `${text.trim().split(/\s+/).slice(0, 1).join(" ")} · private command (not saved)`
      : text,
    private: sensitive,
  };
}
export function relativePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number },
) {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0
  )
    return null;
  const scale = Math.min(rect.width / image.width, rect.height / image.height),
    w = image.width * scale,
    h = image.height * scale;
  const x = clientX - rect.left - (rect.width - w) / 2,
    y = clientY - rect.top - (rect.height - h) / 2;
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  return {
    x: Math.min(999, Math.max(0, Math.round((x / w) * 1000))),
    y: Math.min(999, Math.max(0, Math.round((y / h) * 1000))),
    relative: true,
  };
}
export function attachment(file: File): Promise<{
  name: string;
  mime: string;
  base64: string;
  preview?: string;
  size: number;
}> {
  if (!file.size || file.size > MAX_UPLOAD)
    return Promise.reject(new Error("Choose a non-empty file up to 8 MB."));
  if (
    !/^(image\/(png|jpeg|webp)|application\/pdf|application\/vnd.openxmlformats-officedocument.wordprocessingml.document|text\/plain)$/.test(
      file.type,
    ) &&
    !/\.(pdf|docx|txt|png|jpe?g|webp)$/i.test(file.name)
  )
    return Promise.reject(
      new Error("Supported: JPG, PNG, WebP, PDF, DOCX and TXT."),
    );
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const data = String(reader.result);
      resolve({
        name: file.name,
        mime: file.type || "application/octet-stream",
        base64: data.slice(data.indexOf(",") + 1),
        preview: file.type.startsWith("image/") ? data : undefined,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}
